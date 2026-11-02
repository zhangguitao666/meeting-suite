/**
 * 会议纪要插件 · 音频工具（纯函数）
 *
 * 本地 SenseVoice provider 只接受 **16kHz、单声道、16bit PCM（audioFormat=1）**
 * 的 WAV，而浏览器的 MediaRecorder 出的 WebM/Ogg、用户导入的 mp3/m4a，以及
 * 宿主 afconvert 转出来的文件都不一定完全符合这个形状。所以把「校验 / 切片 /
 * 拼接」集中在这个模块里：不依赖 fs，也不依赖 Cordis，浏览器 bundle 与宿主
 * 可以共用同一套判断。
 *
 * 切片的意义：单次推理过长会拖慢首字延迟，也更容易触发 provider 的
 * maxAudioBytes 上限（SenseVoice 默认 4MB ≈ 131 秒），因此超过 100 秒的音频
 * 先按帧边界切开，分别识别后再拼接文本。
 *
 * @module dsh-plugin-meeting-minutes/audio
 */

/** 本地语音识别要求的采样率。 */
export const TARGET_SAMPLE_RATE = 16000

/** 标准 canonical WAV 头长度：RIFF(12) + fmt(24) + data 头(8)。 */
export const WAV_HEADER_BYTES = 44

/** WAV 的 audioFormat 字段：1 表示整数 PCM。 */
const PCM_FORMAT = 1

/** WAVE_FORMAT_EXTENSIBLE：afconvert 等工具输出的扩展头，SubFormat 里才是真正的编码。 */
const EXTENSIBLE_FORMAT = 0xfffe

/** 四个 chunk 标识，按小端读成 uint32。 */
const RIFF = 0x46464952 // 'RIFF'
const WAVE = 0x45564157 // 'WAVE'
const FMT = 0x20746d66 // 'fmt '
const DATA = 0x61746164 // 'data'

/** 宿主 CPU 是否为小端；WAV 的 PCM 负载固定小端。 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/**
 * 把调用方给的各种字节容器归一成 Uint8Array。
 * @param value - Uint8Array / Buffer / ArrayBuffer。
 * @param label - 报错时使用的名字。
 * @returns 非空的 Uint8Array 视图（不复制）。
 */
function toBytes(value, label) {
  if (value === null || value === undefined) throw new Error(`${label}不能为空`)
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0) throw new Error(`${label}不能是空数组`)
    return value
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength === 0) throw new Error(`${label}不能是空数组`)
    return new Uint8Array(value)
  }
  throw new Error(`${label}必须是 Uint8Array（或 Buffer / ArrayBuffer）`)
}

/** 在 DataView 里写一段 ASCII，用于四个 chunk 标识。 */
function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

/**
 * 解析并校验一个 canonical 或带附加 chunk 的 WAV。
 *
 * 允许 `data` 之前出现 LIST / fact 等 chunk（ffmpeg、QuickTime 常见），
 * chunk 按 RIFF 规范做偶数对齐。所有不合格输入都抛中文 Error。
 *
 * @param value - 音频字节。
 * @param label - 报错时使用的名字。
 * @param options - `allowExtensible`：是否接受 WAVE_FORMAT_EXTENSIBLE（SubFormat
 *   必须是 PCM）。只有 {@link toCanonicalWav} 会打开它；对外的 validateWav
 *   仍然只认标准 PCM 头。
 * @returns 解析结果，额外带上 `view`（原字节视图）与 `format`（头字段）。
 */
function parseWav(value, label = '音频数据', { allowExtensible = false } = {}) {
  const view = toBytes(value, label)
  const length = view.byteLength
  if (length < 12) throw new Error('不是有效的 WAV：文件长度不足 12 字节')
  const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength)
  if (dataView.getUint32(0, true) !== RIFF) throw new Error('不是有效的 WAV：缺少 RIFF 标识')
  if (dataView.getUint32(8, true) !== WAVE) throw new Error('不是有效的 WAV：缺少 WAVE 标识')

  let format = null
  let dataOffset = -1
  let dataBytes = -1
  let offset = 12
  while (offset + 8 <= length) {
    const id = dataView.getUint32(offset, true)
    const size = dataView.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === FMT) {
      if (size < 16) throw new Error('不是有效的 WAV：fmt 块长度不足 16 字节')
      if (body + size > length) throw new Error('不是有效的 WAV：fmt 块被截断')
      const audioFormat = dataView.getUint16(body, true)
      let pcmFormat = audioFormat
      if (audioFormat === EXTENSIBLE_FORMAT) {
        if (size < 40) throw new Error('不是有效的 WAV：扩展 fmt 块长度不足 40 字节')
        const cbSize = dataView.getUint16(body + 16, true)
        if (cbSize < 22) throw new Error('不是有效的 WAV：扩展 fmt 块缺少 SubFormat GUID')
        // SubFormat GUID 的前两个字节就是真正的 wFormatTag。
        pcmFormat = dataView.getUint16(body + 24, true)
      }
      format = {
        audioFormat,
        pcmFormat,
        extensible: audioFormat === EXTENSIBLE_FORMAT,
        channels: dataView.getUint16(body + 2, true),
        sampleRate: dataView.getUint32(body + 4, true),
        byteRate: dataView.getUint32(body + 8, true),
        blockAlign: dataView.getUint16(body + 12, true),
        bitsPerSample: dataView.getUint16(body + 14, true),
      }
    } else if (id === DATA) {
      if (body + size > length) {
        throw new Error(
          `不是有效的 WAV：data 块被截断（头部声明 ${size} 字节，实际只剩 ${length - body} 字节）`,
        )
      }
      dataOffset = body
      dataBytes = size
      break
    }
    // RIFF 的每个 chunk 都按偶数对齐，奇数长度要跳过一个 padding 字节。
    offset = body + size + (size % 2)
  }

  if (format === null) throw new Error('不是有效的 WAV：缺少 fmt 块')
  if (dataOffset < 0) throw new Error('不是有效的 WAV：缺少 data 块')

  if (format.pcmFormat !== PCM_FORMAT) {
    throw new Error(
      `不支持的 WAV 编码（audioFormat=${format.audioFormat}）：仅支持 16bit 整数 PCM`,
    )
  }
  if (format.extensible && !allowExtensible) {
    throw new Error(
      '不支持的 WAV 编码（audioFormat=65534，WAVE_FORMAT_EXTENSIBLE）：仅支持标准 PCM WAV，请先转换',
    )
  }
  if (format.channels !== 1) {
    throw new Error(`WAV 必须是单声道（当前 ${format.channels} 声道）`)
  }
  if (format.sampleRate !== TARGET_SAMPLE_RATE) {
    throw new Error(`WAV 采样率必须是 ${TARGET_SAMPLE_RATE} Hz（当前 ${format.sampleRate} Hz）`)
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(`WAV 位深必须是 16 bit（当前 ${format.bitsPerSample} bit）`)
  }
  const expectedBlockAlign = (format.channels * format.bitsPerSample) / 8
  if (format.blockAlign !== expectedBlockAlign) {
    throw new Error(
      `WAV 头不一致：blockAlign=${format.blockAlign}，应为 ${expectedBlockAlign}`,
    )
  }
  if (dataBytes % format.blockAlign !== 0) {
    throw new Error(
      `WAV 的 data 长度（${dataBytes} 字节）不是 blockAlign（${format.blockAlign} 字节）的整数倍`,
    )
  }

  const samples = dataBytes / format.blockAlign
  return {
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    samples,
    dataOffset,
    dataBytes,
    seconds: samples / format.sampleRate,
    view,
    format,
  }
}

/** 把解析结果裁剪成对外的公开形状。 */
function publicInfo(info) {
  return {
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
    samples: info.samples,
    dataOffset: info.dataOffset,
    dataBytes: info.dataBytes,
    seconds: info.seconds,
  }
}

/**
 * 用给定负载与格式拼一个 canonical 44 字节头的 WAV。
 * 只处理整数 PCM（audioFormat=1），切片与编码共用。
 *
 * @param payload - 原始 PCM 负载字节。
 * @param format - `{ sampleRate, channels, bitsPerSample }`。
 * @returns 新的 Uint8Array。
 */
function buildWav(payload, format) {
  const blockAlign = (format.channels * format.bitsPerSample) / 8
  const byteRate = format.sampleRate * blockAlign
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + payload.byteLength)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + payload.byteLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, PCM_FORMAT, true)
  view.setUint16(22, format.channels, true)
  view.setUint32(24, format.sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, format.bitsPerSample, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, payload.byteLength, true)
  new Uint8Array(buffer, WAV_HEADER_BYTES).set(payload)
  return new Uint8Array(buffer)
}

/** 把 Int16Array 转成小端 PCM16 字节（宿主是大端时逐个写）。 */
function pcm16ToBytes(samples) {
  const bytes = new Uint8Array(samples.length * 2)
  if (LITTLE_ENDIAN) {
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
    return bytes
  }
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index], true)
  }
  return bytes
}

/**
 * 校验一段 WAV 是否是本地语音识别能直接吃的形状。
 *
 * 要求：RIFF/WAVE、`fmt ` 的 audioFormat=1、16000 Hz、单声道、16 bit，
 * 且 `data` 长度与 blockAlign 对齐（未被截断）。`data` 之前允许有 LIST/fact
 * 等附加 chunk。
 *
 * @param bytes - 音频字节（Uint8Array / Buffer / ArrayBuffer）。
 * @returns `{ sampleRate, channels, bitsPerSample, samples, dataOffset, dataBytes, seconds }`
 *   —— `samples` 是帧数（每声道采样点），`seconds = samples / sampleRate`。
 * @throws 不合格时抛中文 Error。
 */
export function validateWav(bytes) {
  return publicInfo(parseWav(bytes))
}

/**
 * 轻量读取 WAV 信息；与 {@link validateWav} 一样会拒绝不合格输入。
 * @param bytes - 音频字节。
 * @returns 与 {@link validateWav} 相同的信息。
 */
export function wavInfo(bytes) {
  return publicInfo(parseWav(bytes))
}

/**
 * 把 WAV 重建成标准的 44 字节头，并把 WAVE_FORMAT_EXTENSIBLE（SubFormat=PCM）
 * 降级成普通 PCM。
 *
 * macOS 的 `afconvert -f WAVE -d LEI16@16000 -c 1` 输出的是 extensible 头，
 * 而 SenseVoice 的 wave 校验只认标准 PCM；所以转码之后必须过一遍这个函数。
 * 对本来就是标准 PCM 的输入，输出与原字节逐字节一致。
 *
 * @param bytes - 音频字节。
 * @returns 新的 canonical WAV（Uint8Array）。
 */
export function toCanonicalWav(bytes) {
  const info = parseWav(bytes, '音频数据', { allowExtensible: true })
  const payload = info.view.subarray(info.dataOffset, info.dataOffset + info.dataBytes)
  return buildWav(payload, {
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitsPerSample: info.bitsPerSample,
  })
}

/**
 * 按帧边界把 WAV 切成若干片，每片仍是带 canonical 44 字节头的合法 WAV。
 *
 * 所有样本不丢不重：切片按整帧（blockAlign）对齐，最后一片可能更短；
 * 每片时长不超过 `maxSeconds`。格式字段从原头复制。
 *
 * @param bytes - 已经合格的 16k 单声道 PCM16 WAV。
 * @param maxSeconds - 每片最长秒数，默认 100；<=0 或非数字抛错。
 * @returns 切片数组；0 帧音频返回空数组。
 */
export function splitWav(bytes, maxSeconds = 100) {
  if (typeof maxSeconds !== 'number' || !Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error('maxSeconds 必须是大于 0 的数字')
  }
  const info = parseWav(bytes)
  if (info.samples === 0) return []
  const framesPerSlice = Math.max(1, Math.floor(maxSeconds * info.sampleRate))
  const bytesPerFrame = info.format.blockAlign
  const slices = []
  for (let startFrame = 0; startFrame < info.samples; startFrame += framesPerSlice) {
    const frameCount = Math.min(framesPerSlice, info.samples - startFrame)
    const start = info.dataOffset + startFrame * bytesPerFrame
    const payload = info.view.subarray(start, start + frameCount * bytesPerFrame)
    slices.push(buildWav(payload, info.format))
  }
  return slices
}

/**
 * 把若干段 canonical WAV 按顺序拼成一段完整 WAV。
 *
 * 用于实时录音：面板按 VAD 切片（停顿阈值触发）滚动上传、只做识别；停录时把整场切片拼回
 * 一份音频，再落一次副本、算整场 sha256 与时长。所有切片必须是相同格式的
 * 16bit PCM（本机链路固定 16k 单声道）。
 *
 * @param parts - WAV 字节数组（顺序即调用方给的顺序）。
 * @returns 一个新的 canonical WAV（Uint8Array）。
 * @throws 空数组或格式不一致时抛中文 Error。
 */
export function concatWavPcm16(parts) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('没有可拼接的音频片段')
  const payloads = []
  let format = null
  for (const part of parts) {
    const info = parseWav(part)
    if (format === null) {
      format = {
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitsPerSample: info.bitsPerSample,
      }
    } else if (info.sampleRate !== format.sampleRate
      || info.channels !== format.channels
      || info.bitsPerSample !== format.bitsPerSample) {
      throw new Error('音频片段格式不一致，无法拼接')
    }
    payloads.push(info.view.subarray(info.dataOffset, info.dataOffset + info.dataBytes))
  }
  const total = payloads.reduce((sum, payload) => sum + payload.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const payload of payloads) {
    merged.set(payload, offset)
    offset += payload.length
  }
  return buildWav(merged, format)
}

/**
 * 生成一个标准的 16bit PCM WAV（44 字节头）。
 *
 * @param samples - 采样点（Int16Array）。
 * @param sampleRate - 采样率，默认 16000。
 * @returns Uint8Array。
 */
export function encodeWavPcm16(samples, sampleRate = TARGET_SAMPLE_RATE) {
  if (samples === null || samples === undefined) throw new Error('采样数据不能为空')
  if (!(samples instanceof Int16Array)) throw new Error('采样数据必须是 Int16Array')
  if (samples.length === 0) throw new Error('采样数据不能是空数组')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('采样率必须是大于 0 的整数')
  }
  return buildWav(pcm16ToBytes(samples), { sampleRate, channels: 1, bitsPerSample: 16 })
}

/**
 * 把 16bit PCM WAV 的采样点解码成 `[-1, 1]` 的 Float32Array。
 *
 * 说话人声纹模型（sherpa-onnx / CAM++）吃的是浮点采样；WAV 的 PCM 负载固定
 * 小端 Int16LE，这里按 {@link wavInfo} 给出的 `data` 偏移读取，避免把附加
 * chunk（LIST / fact 等）当成音频。解码后不做重采样：调用方拿到的就是
 * 16kHz 单声道的采样序列。
 *
 * @param bytes - 16kHz 单声道 16bit PCM WAV（Uint8Array / Buffer / ArrayBuffer）。
 * @returns Float32Array，长度等于帧数（每声道采样点数）。
 * @throws 不是合格的 16k 单声道 PCM16 WAV 时抛中文 Error。
 */
export function pcm16ToFloat32(bytes) {
  const info = parseWav(bytes)
  const view = new DataView(info.view.buffer, info.view.byteOffset + info.dataOffset, info.dataBytes)
  const frames = Math.floor(info.dataBytes / 2)
  const samples = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768
  }
  return samples
}

/**
 * 拼接多段识别文本。
 *
 * - 丢掉空串/纯空白片段（切片边界常常产出空结果）；
 * - 相邻且完全相同的片段只保留一个（ASR 切片边界可能重复一句）；
 * - 用换行连接。
 *
 * @param parts - 文本片段数组。
 * @returns 拼接后的文本。
 */
export function concatText(parts) {
  if (!Array.isArray(parts)) throw new Error('文本片段必须是字符串数组')
  const cleaned = []
  for (const part of parts) {
    if (typeof part !== 'string') throw new Error('文本片段必须是字符串数组')
    const text = part.trim()
    if (text === '') continue
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === text) continue
    cleaned.push(text)
  }
  if (cleaned.length === 0) throw new Error('没有可拼接的文本片段')
  return cleaned.join('\n')
}

/**
 * 读取 WAV 的时长（秒），不合格输入抛中文 Error。
 * @param bytes - 音频字节。
 * @returns 时长秒数。
 */
export function secondsOf(bytes) {
  return parseWav(bytes).seconds
}

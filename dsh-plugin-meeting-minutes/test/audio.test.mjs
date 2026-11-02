/**
 * 会议纪要插件 · 音频工具与语音识别门面的纯逻辑测试。
 *
 * 运行（真实 Node 24；runtime/bin/node 是依赖环境变量的 wrapper，不能直接用）：
 *   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
 *     --test test/audio.test.mjs
 *
 * @module dsh-plugin-meeting-minutes/test/audio
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  TARGET_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  concatText,
  encodeWavPcm16,
  pcm16ToFloat32,
  secondsOf,
  splitWav,
  toCanonicalWav,
  validateWav,
  wavInfo,
} from '../lib/audio.js'
import { createAsr } from '../lib/asr.js'

/** afconvert 的输出会走「转换 → 重建标准头」这条真实链路。 */
const AFCONVERT = '/usr/bin/afconvert'
const execFileAsync = promisify(execFile)

/** 任何一条中文错误信息里都至少有一个汉字。 */
const CHINESE = /[\u4e00-\u9fa5]/

/** 断言 fn 抛出带中文信息的 Error，可选匹配关键片段。 */
function chineseError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Error, '应当抛出 Error')
    assert.match(error.message, CHINESE)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  })
}

/**
 * 手工拼一个 canonical 44 字节头的 WAV，用来构造各种「不合格」头。
 * `dataBytes` 可以故意给一个与 blockAlign 不对齐的长度。
 */
function craftWav({
  sampleRate = TARGET_SAMPLE_RATE,
  channels = 1,
  bitsPerSample = 16,
  frames = 16000,
  dataBytes,
} = {}) {
  const blockAlign = (channels * bitsPerSample) / 8
  const payloadBytes = dataBytes ?? frames * blockAlign
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + payloadBytes)
  const view = new DataView(buffer)
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + payloadBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, payloadBytes, true)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < payloadBytes; index += 1) {
    bytes[WAV_HEADER_BYTES + index] = (index * 13 + 7) & 0xff
  }
  return bytes
}

/**
 * 拼一个 data 之前带 LIST 块的 WAV（QuickTime/ffmpeg 常见布局）。
 * 布局：RIFF(12) + fmt(24) + LIST(8+4) + data(8) + 负载。
 */
function craftWavWithList(frames = 4000) {
  const dataBytes = frames * 2
  const dataOffset = 12 + 24 + 12 + 8
  const buffer = new ArrayBuffer(dataOffset + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 48 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'LIST')
  view.setUint32(40, 4, true)
  ascii(44, 'INFO')
  ascii(48, 'data')
  view.setUint32(52, dataBytes, true)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < dataBytes; index += 1) {
    bytes[dataOffset + index] = (index * 29 + 3) & 0xff
  }
  return bytes
}

/**
 * 拼一个 WAVE_FORMAT_EXTENSIBLE 的 WAV：afconvert 对 16kHz 单声道 16bit 输出
 * 的就是这种 40 字节 fmt 块，SubFormat GUID 里才标明真正的 PCM。
 */
function craftExtensibleWav(frames = 4000, { subFormat = 1 } = {}) {
  const dataBytes = frames * 2
  const fmtSize = 40
  const fmtOffset = 12
  const dataChunkOffset = fmtOffset + 8 + fmtSize
  const dataOffset = dataChunkOffset + 8
  const buffer = new ArrayBuffer(dataOffset + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, dataOffset + dataBytes - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, 0xfffe, true) // WAVE_FORMAT_EXTENSIBLE
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true) // blockAlign
  view.setUint16(34, 16, true) // bitsPerSample
  view.setUint16(36, 22, true) // cbSize
  view.setUint16(38, 16, true) // wValidBitsPerSample
  view.setUint32(40, 4, true) // dwChannelMask: SPEAKER_FRONT_CENTER
  // SubFormat GUID = KSDATAFORMAT_SUBTYPE_PCM（前两个字节即 wFormatTag）
  view.setUint16(44, subFormat, true)
  view.setUint16(46, 0, true)
  view.setUint16(48, 0x0010, true)
  view.setUint8(50, 0x80)
  view.setUint8(51, 0x00)
  view.setUint8(52, 0x00)
  view.setUint8(53, 0xaa)
  view.setUint8(54, 0x00)
  view.setUint8(55, 0x38)
  view.setUint8(56, 0x9b)
  view.setUint8(57, 0x71)
  ascii(dataChunkOffset, 'data')
  view.setUint32(dataChunkOffset + 4, dataBytes, true)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < dataBytes; index += 1) {
    bytes[dataOffset + index] = (index * 17 + 5) & 0xff
  }
  return bytes
}

/** 造一个可用的假 ctx：只认 speechToText。 */
function fakeContext(service) {
  return {
    get: (name) => (name === 'speechToText' ? service : undefined),
  }
}

/** 造一个始终 ready 的假 speechToText 服务。 */
function readyService(overrides = {}) {
  const calls = []
  const service = {
    snapshot: () => ({
      providers: [
        {
          id: 'sensevoice-local',
          name: 'SenseVoice（本地）',
          location: 'host-local',
          languages: ['zh', 'auto'],
          preparation: { phase: 'ready' },
        },
      ],
      selection: { providerId: 'sensevoice-local', language: 'zh' },
    }),
    prepare: () => {
      throw new Error('模型已就绪时不应该调用 prepare')
    },
    resolve: ({ audio, language, providerId }) => {
      calls.push({ audio, language, providerId })
      return { audio, language, providerId }
    },
    async transcribe(spec) {
      return {
        text: '大家好',
        audioSeconds: validateWav(spec.audio).seconds,
        inferenceSeconds: 0.25,
      }
    },
    ...overrides,
  }
  return { service, calls }
}

test('encodeWavPcm16 生成的头能被 validateWav 解析', () => {
  const samples = new Int16Array(8000) // 0.5 秒
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = ((index % 200) - 100) * 100
  }
  const bytes = encodeWavPcm16(samples)
  assert.equal(bytes.byteLength, WAV_HEADER_BYTES + samples.length * 2)
  assert.deepEqual(validateWav(bytes), {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    samples: 8000,
    dataOffset: WAV_HEADER_BYTES,
    dataBytes: 16000,
    seconds: 0.5,
  })
  assert.deepEqual(wavInfo(bytes), validateWav(bytes))
  assert.equal(secondsOf(bytes), 0.5)
  // 头部之后就是小端 PCM16 负载。
  const payload = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < 10; index += 1) {
    assert.equal(payload.getInt16(WAV_HEADER_BYTES + index * 2, true), samples[index])
  }
})

test('validateWav 拒绝 44100Hz', () => {
  chineseError(() => validateWav(craftWav({ sampleRate: 44100 })), /16000/)
})

test('validateWav 拒绝立体声', () => {
  chineseError(() => validateWav(craftWav({ channels: 2 })), /单声道/)
})

test('validateWav 拒绝 8bit', () => {
  chineseError(() => validateWav(craftWav({ bitsPerSample: 8 })), /16/)
})

test('validateWav 拒绝被截断的 data 块', () => {
  const bytes = craftWav({ frames: 16000 })
  const truncated = bytes.subarray(0, bytes.byteLength - 100)
  chineseError(() => validateWav(truncated), /截断/)
})

test('validateWav 拒绝与 blockAlign 不对齐的 data 长度', () => {
  chineseError(() => validateWav(craftWav({ dataBytes: 16001 })), /blockAlign/)
})

test('validateWav 接受 data 之前的 LIST chunk', () => {
  const bytes = craftWavWithList(4000)
  const info = validateWav(bytes)
  assert.equal(info.sampleRate, 16000)
  assert.equal(info.channels, 1)
  assert.equal(info.bitsPerSample, 16)
  assert.equal(info.samples, 4000)
  assert.equal(info.seconds, 0.25)
  assert.equal(info.dataOffset, 56) // 12 + 24 + 12 + 8
})

test('validateWav 拒绝 WAVE_FORMAT_EXTENSIBLE，toCanonicalWav 能把它降级成标准 PCM', () => {
  const extensible = craftExtensibleWav(4000)
  chineseError(() => validateWav(extensible), /EXTENSIBLE|65534/)

  const canonical = toCanonicalWav(extensible)
  const info = validateWav(canonical)
  assert.equal(info.sampleRate, 16000)
  assert.equal(info.channels, 1)
  assert.equal(info.bitsPerSample, 16)
  assert.equal(info.samples, 4000)
  assert.equal(info.seconds, 0.25)
  assert.equal(info.dataOffset, WAV_HEADER_BYTES)
  // data 负载原样搬过去：extensible 的 data 在 68 字节处，标准头在 44 字节处。
  const payload = Buffer.from(canonical.subarray(WAV_HEADER_BYTES))
  assert.ok(payload.equals(Buffer.from(extensible.subarray(68))))

  // 已经是标准 PCM 时，重建结果与原字节完全一致（幂等）。
  const standard = encodeWavPcm16(new Int16Array(100))
  assert.ok(Buffer.from(toCanonicalWav(standard)).equals(Buffer.from(standard)))

  // SubFormat 不是 PCM（例如 IEEE float=3）时仍然拒绝。
  chineseError(() => toCanonicalWav(craftExtensibleWav(4000, { subFormat: 3 })), /不支持的 WAV 编码/)
})

test('splitWav 按帧边界切片：4 片、每片 ≤1 秒、样本不丢不重', () => {
  const frames = 51200 // 3.2 秒
  const samples = new Int16Array(frames)
  for (let index = 0; index < frames; index += 1) {
    samples[index] = ((index * 37) % 2000) - 1000
  }
  const original = encodeWavPcm16(samples)
  const info = validateWav(original)
  assert.equal(info.seconds, 3.2)

  // 默认 100 秒：整段一片。
  assert.equal(splitWav(original).length, 1)

  const slices = splitWav(original, 1)
  assert.equal(slices.length, 4)
  assert.deepEqual(slices.map((slice) => validateWav(slice).samples), [16000, 16000, 16000, 3200])

  const payloads = []
  let totalSamples = 0
  for (const slice of slices) {
    const sliceInfo = validateWav(slice)
    assert.equal(sliceInfo.dataOffset, WAV_HEADER_BYTES)
    assert.equal(slice.byteLength, WAV_HEADER_BYTES + sliceInfo.dataBytes)
    assert.ok(sliceInfo.seconds <= 1 + 1e-9)
    totalSamples += sliceInfo.samples
    payloads.push(
      Buffer.from(slice.subarray(sliceInfo.dataOffset, sliceInfo.dataOffset + sliceInfo.dataBytes)),
    )
  }
  assert.equal(totalSamples, frames)

  // 各片负载首尾相接必须逐字节等于原始负载：既不丢样本，也不重叠。
  const joined = Buffer.concat(payloads)
  const originalPayload = Buffer.from(
    original.subarray(info.dataOffset, info.dataOffset + info.dataBytes),
  )
  assert.equal(joined.length, info.dataBytes)
  assert.ok(joined.equals(originalPayload))

  chineseError(() => splitWav(original, 0), /maxSeconds/)
  chineseError(() => splitWav(original, -1), /maxSeconds/)
})

test('concatText 过滤空片段、去掉相邻重复并用换行连接', () => {
  assert.equal(
    concatText(['', '  第一段 ', '第一段', '第二段', '  ', '第二段', '第三段']),
    '第一段\n第二段\n第三段',
  )
  // 非相邻的重复句保留（确实是说了两遍）。
  assert.equal(concatText(['甲', '乙', '甲']), '甲\n乙\n甲')
  assert.equal(concatText(['第一句。']), '第一句。')
})

test('concatText 对空输入抛中文错误', () => {
  chineseError(() => concatText(null))
  chineseError(() => concatText(undefined))
  chineseError(() => concatText([]))
  chineseError(() => concatText(['', '   ']))
  chineseError(() => concatText([1]))
})

test('所有音频函数对空输入抛中文错误', () => {
  chineseError(() => validateWav(null))
  chineseError(() => validateWav(undefined))
  chineseError(() => validateWav(new Uint8Array(0)))
  chineseError(() => wavInfo(null))
  chineseError(() => splitWav(null))
  chineseError(() => encodeWavPcm16(null))
  chineseError(() => encodeWavPcm16(new Int16Array(0)))
  chineseError(() => secondsOf(null))
})

test('createAsr: 服务缺失时 status 返回契约里的不可用形状', () => {
  const asr = createAsr({ ctx: fakeContext(undefined) })
  assert.deepEqual(asr.status(), {
    available: false,
    error: '本机语音识别服务未启用',
    providers: [],
    selection: { providerId: null, language: 'zh' },
    maxAudioBytes: 0,
    maxDurationSeconds: 0,
  })
  chineseError(() => asr.prepare(), /语音识别服务未启用/)
})

test('createAsr: status 把 snapshot 归一化成 speech 形状', () => {
  const snapshot = {
    providers: [
      {
        id: 'sensevoice-local',
        name: 'SenseVoice（本地）',
        location: 'host-local',
        languages: ['zh', 'auto'],
        preparation: {
          phase: 'downloading',
          step: 'download',
          steps: 2,
          resource: 'model.bin',
          completedBytes: 1024,
          totalBytes: 4096,
          message: null,
        },
      },
    ],
    selection: { providerId: 'sensevoice-local', language: 'zh' },
  }
  const asr = createAsr({ ctx: fakeContext({ snapshot: () => snapshot }) })
  const speech = asr.status()
  assert.equal(speech.available, true)
  assert.equal(speech.error, null)
  assert.deepEqual(speech.providers, [
    {
      id: 'sensevoice-local',
      name: 'SenseVoice（本地）',
      location: 'host-local',
      languages: ['zh', 'auto'],
      phase: 'downloading',
      progress: { resource: 'model.bin', completedBytes: 1024, totalBytes: 4096 },
      message: null,
    },
  ])
  assert.deepEqual(speech.selection, { providerId: 'sensevoice-local', language: 'zh' })
  assert.equal(speech.maxAudioBytes, 4 * 1024 * 1024)
  assert.equal(speech.maxDurationSeconds, 300)

  const custom = createAsr({
    ctx: fakeContext({ snapshot: () => snapshot }),
    config: { maxAudioBytes: 1024, maxDurationSeconds: 60 },
  })
  assert.equal(custom.status().maxAudioBytes, 1024)
  assert.equal(custom.status().maxDurationSeconds, 60)
})

test('createAsr: 已就绪 provider 直接分片识别并累加时长', async () => {
  const { service, calls } = readyService()
  const asr = createAsr({ ctx: fakeContext(service), config: { segmentSeconds: 1 } })
  const result = await asr.transcribeWav(craftWav({ frames: 32000 }), { language: 'zh' })

  // 两片各 1 秒；同一句 "大家好" 在切分边界重复，concatText 去掉一次。
  assert.equal(result.text, '大家好')
  assert.equal(result.audioSeconds, 2)
  assert.equal(result.inferenceSeconds, 0.5)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((call) => call.providerId), ['sensevoice-local', 'sensevoice-local'])
  assert.deepEqual(calls.map((call) => validateWav(call.audio).samples), [16000, 16000])
})

test('createAsr: transcribeFile 把非 16kHz 音频经 afconvert 转成 canonical WAV 后识别', {
  skip: !existsSync(AFCONVERT),
}, async () => {
  // 2 秒 44.1kHz WAV：不能直接喂给 SenseVoice，必须先转码。
  const stamp = `${process.pid}-${Date.now()}`
  const file = join(tmpdir(), `dsh-audio-test-${stamp}.wav`)
  const m4a = join(tmpdir(), `dsh-audio-test-${stamp}.m4a`)
  const samples = new Int16Array(44100 * 2)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(6000 * Math.sin(index / 20))
  }
  await writeFile(file, encodeWavPcm16(samples, 44100))
  // AAC 输入必须覆盖：afconvert 从 m4a 转 WAV 时写的是 WAVE_FORMAT_EXTENSIBLE，
  // 代码必须先规范成标准 PCM 头再交给 provider。
  await execFileAsync(AFCONVERT, ['-f', 'm4af', '-d', 'aac', file, m4a])
  try {
    const { service, calls } = readyService()
    const asr = createAsr({ ctx: fakeContext(service) })
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith('dsh-asr-')).length

    const result = await asr.transcribeFile(file, { language: 'zh' })
    assert.equal(result.text, '大家好')
    assert.ok(
      Math.abs(result.audioSeconds - 2) < 0.1,
      `转换后时长应约为 2 秒，实际 ${result.audioSeconds}`,
    )
    assert.equal(calls.length, 1)
    const fromWav = validateWav(calls[0].audio)
    assert.equal(fromWav.sampleRate, 16000)
    assert.equal(fromWav.channels, 1)
    assert.equal(fromWav.bitsPerSample, 16)

    // m4a（AAC）同样能转：这是 WAVE_FORMAT_EXTENSIBLE 的真实触发路径。
    const fromM4a = await asr.transcribeFile(m4a, { language: 'zh' })
    assert.equal(fromM4a.text, '大家好')
    assert.ok(Math.abs(fromM4a.audioSeconds - 2) < 0.1)
    assert.equal(calls.length, 2)
    const sentM4a = validateWav(calls[1].audio)
    assert.equal(sentM4a.sampleRate, 16000)
    assert.equal(sentM4a.channels, 1)
    assert.equal(sentM4a.bitsPerSample, 16)

    // 临时 WAV 必须在 finally 里删掉。
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith('dsh-asr-')).length
    assert.equal(after, before)
  } finally {
    await unlink(file).catch(() => undefined)
    await unlink(m4a).catch(() => undefined)
  }
})

test('createAsr: 模型 preparing 失败时抛含 message 的中文错误', async () => {
  const service = {
    snapshot: () => ({
      providers: [
        {
          id: 'sensevoice-local',
          name: 'SenseVoice（本地）',
          location: 'host-local',
          languages: ['zh'],
          preparation: { phase: 'failed', message: '磁盘空间不足' },
        },
      ],
      selection: { providerId: 'sensevoice-local', language: 'zh' },
    }),
  }
  const asr = createAsr({ ctx: fakeContext(service) })
  await assert.rejects(
    asr.transcribeWav(craftWav({ frames: 1600 })),
    /语音识别模型准备失败：磁盘空间不足/,
  )
})

test('createAsr: 不合格音频与服务缺失都有中文错误', async () => {
  const { service } = readyService()
  const asr = createAsr({ ctx: fakeContext(service) })
  await assert.rejects(asr.transcribeWav(new Uint8Array(0)), CHINESE)
  await assert.rejects(asr.transcribeWav(craftWav({ sampleRate: 44100 })), /16000/)

  const noService = createAsr({ ctx: fakeContext(undefined) })
  await assert.rejects(noService.transcribeWav(craftWav({ frames: 1600 })), /语音识别服务未启用/)
})

test('createAsr: transcribeFile 对不存在的文件与空路径抛中文错误', async () => {
  const asr = createAsr({ ctx: fakeContext(undefined) })
  await assert.rejects(asr.transcribeFile('/nonexistent/dsh-asr-test.mp3'), /音频文件不存在/)
  await assert.rejects(asr.transcribeFile(''), /路径不能为空/)
})

test('pcm16ToFloat32: Int16LE 负载解码成 [-1, 1] 浮点采样', () => {
  const wav = encodeWavPcm16(new Int16Array([0, 16384, -32768, 32767, -16384]))
  const samples = pcm16ToFloat32(wav)
  assert.equal(samples instanceof Float32Array, true)
  assert.equal(samples.length, 5)
  assert.equal(samples[0], 0)
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-6)
  assert.equal(samples[2], -1)
  assert.ok(Math.abs(samples[3] - 32767 / 32768) < 1e-6)
  assert.ok(Math.abs(samples[4] - -0.5) < 1e-6)
})

test('pcm16ToFloat32: 按 data 偏移读（LIST 块在前的 WAV），不合格输入抛中文错误', () => {
  const frames = 4
  const wav = craftWavWithList(frames)
  const dataOffset = 12 + 24 + 12 + 8
  const view = new DataView(wav.buffer, wav.byteOffset + dataOffset, frames * 2)
  const samples = pcm16ToFloat32(wav)
  assert.equal(samples.length, frames)
  for (let index = 0; index < frames; index += 1) {
    assert.ok(Math.abs(samples[index] - view.getInt16(index * 2, true) / 32768) < 1e-6)
  }

  assert.throws(() => pcm16ToFloat32(new Uint8Array([1, 2, 3])), CHINESE)
  assert.throws(() => pcm16ToFloat32(craftWav({ sampleRate: 44100 })), /16000/)
})

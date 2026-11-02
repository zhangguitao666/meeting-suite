/**
 * 会议纪要插件 · 语音识别链路
 *
 * 宿主已经装了 `@deepseek-ai/dsh-experimental-speech-to-text`，它在 Cordis 里注册
 * 的服务名是 `speechToText`，本地 provider 是 `sensevoice-local`（SenseVoice）。
 * 这个模块把该服务的原始 snapshot 归一化成 CONTRACT.md 里的 `speech` 形状，
 * 并把「准备模型 → 按 100 秒切片 → 逐片识别 → 拼接文本」这串流程包成一个
 * 对 HTTP 路由与 agent 工具都友好的接口。
 *
 * 服务可能缺失（旧版本 / 未启用），所有入口都给出中文降级错误，而不是让
 * 未定义方法把调用方炸掉。
 *
 * @module dsh-plugin-meeting-minutes/asr
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { concatText, splitWav, toCanonicalWav, validateWav } from './audio.js'
import { probeVoiceStudio, resolveVoiceStudioSettings, transcribeViaVoiceStudio } from './voicestudio.js'

const execFileAsync = promisify(execFile)

/** 宿主语音识别服务在 Cordis 里的注册名。 */
export const SPEECH_SERVICE = 'speechToText'

/** provider 默认上限：4MB ≈ 131 秒 16kHz 单声道 PCM16。 */
export const DEFAULT_MAX_AUDIO_BYTES = 4 * 1024 * 1024

/** 面板展示用的默认单次识别时长上限（秒）。 */
export const DEFAULT_MAX_DURATION_SECONDS = 300

/** 这些 phase 表示模型已经可用。 */
export const READY_PHASES = new Set(['ready', 'standby'])

/** 超过这个秒数的音频先切片再识别。 */
const DEFAULT_SEGMENT_SECONDS = 100

/** 排队准备模型时轮询 snapshot 的间隔。 */
const DEFAULT_POLL_MS = 1500

/** 准备模型的最长等待时间：10 分钟。 */
const DEFAULT_PREPARE_TIMEOUT_MS = 10 * 60 * 1000

/** macOS 自带的音频转换器；它把 mp3/m4a/mp4/aac 等转成 16k 单声道 PCM16。 */
const AFCONVERT = '/usr/bin/afconvert'

/** 提取 Error 的可读文本。 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 构造与 DOM 语义一致的取消错误。 */
function createAbortError(message = '已取消语音识别') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** 已取消则立刻抛错。 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError()
}

/**
 * 等待一段时间；传了 AbortSignal 时可以提前结束。
 * 用 setTimeout + clearTimeout（不依赖 ctx.timer），避免宿主定时器实现差异。
 * @param ms - 毫秒。
 * @param signal - 可选取消信号。
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }
    let timer = null
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(createAbortError())
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 取一个合法的有限数字，否则用默认值。 */
function numberOr(value, fallback, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback
}

/** 归一化一个 provider 的 preparation 信息。 */
function normalizeProvider(provider) {
  const preparation = provider?.preparation ?? {}
  const id = typeof provider?.id === 'string' ? provider.id : String(provider?.id ?? '')
  return {
    id,
    name: typeof provider?.name === 'string' && provider.name !== '' ? provider.name : id || '未命名',
    location: typeof provider?.location === 'string' ? provider.location : null,
    languages: Array.isArray(provider?.languages) ? provider.languages.map(String) : [],
    phase: typeof preparation.phase === 'string' ? preparation.phase : 'unprepared',
    progress: {
      resource: typeof preparation.resource === 'string' ? preparation.resource : null,
      completedBytes: Number.isFinite(preparation.completedBytes) ? preparation.completedBytes : 0,
      totalBytes: Number.isFinite(preparation.totalBytes) ? preparation.totalBytes : 0,
    },
    message: typeof preparation.message === 'string' ? preparation.message : null,
  }
}

/** 归一化 selection。 */
function normalizeSelection(raw) {
  const selection = raw?.selection ?? {}
  return {
    providerId:
      typeof selection.providerId === 'string' && selection.providerId !== ''
        ? selection.providerId
        : null,
    language:
      typeof selection.language === 'string' && selection.language !== ''
        ? selection.language
        : 'zh',
  }
}

/** 把任意字节容器归一成 Uint8Array；不合规的交给 validateWav 报中文错。 */
function asAudioBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return value
}

/** 保留三位小数，避免多片累加出现 99.999999999 这类噪声。 */
function round3(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * 创建语音识别门面。
 *
 * @param options - `{ ctx, config }`；`ctx.get('speechToText')` 返回宿主服务。
 *   config 可覆盖：`maxAudioBytes`、`maxDurationSeconds`、`segmentSeconds`、
 *   `pollMs`、`prepareTimeoutMs`。
 * @returns `{ status, prepare, transcribeWav, transcribeFile }`。
 */
export function createAsr({ ctx, config = {} } = {}) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') {
    throw new Error('createAsr 需要 Cordis 上下文（ctx.get）')
  }

  const maxAudioBytes = numberOr(config?.maxAudioBytes, DEFAULT_MAX_AUDIO_BYTES, 1)
  const maxDurationSeconds = numberOr(config?.maxDurationSeconds, DEFAULT_MAX_DURATION_SECONDS, 1)
  const segmentSeconds = numberOr(config?.segmentSeconds, DEFAULT_SEGMENT_SECONDS, 1)
  const pollMs = numberOr(config?.pollMs, DEFAULT_POLL_MS, 100)
  const prepareTimeoutMs = numberOr(config?.prepareTimeoutMs, DEFAULT_PREPARE_TIMEOUT_MS, 1000)
  // 外部 VoiceStudio 后端（默认 auto）：本机后端活着就用它，能拿到带说话人的
  // segments；没开/转写失败就回退下面的宿主 SenseVoice 链路，见 lib/voicestudio.js。
  const voiceStudio = resolveVoiceStudioSettings(process.env)

  /** 读取宿主服务；缺失或 ctx.get 抛错都当作没有服务。 */
  function service() {
    try {
      return ctx.get(SPEECH_SERVICE) ?? null
    } catch {
      return null
    }
  }

  /** 构造契约里的不可用 speech 形状。 */
  function unavailable(error) {
    return {
      available: false,
      error,
      providers: [],
      selection: { providerId: null, language: 'zh' },
      maxAudioBytes: 0,
      maxDurationSeconds: 0,
    }
  }

  /** 服务缺失时统一抛这个错。 */
  function requireService() {
    const speech = service()
    if (speech === null) throw new Error('本机语音识别服务未启用，无法转写音频')
    return speech
  }

  /**
   * 选中本次要用的 provider：显式指定优先，其次 snapshot.selection，最后第一个。
   * @param current - status() 结果。
   * @param requested - 调用方显式指定的 id。
   */
  function pickProviderId(current, requested) {
    const requestedId = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : null
    if (requestedId !== null) {
      if (!current.providers.some((provider) => provider.id === requestedId)) {
        throw new Error(`未找到语音识别 provider：${requestedId}`)
      }
      return requestedId
    }
    const selected = current.selection.providerId
    if (selected !== null && current.providers.some((provider) => provider.id === selected)) {
      return selected
    }
    if (current.providers.length === 0) throw new Error('没有可用的语音识别 provider')
    return current.providers[0].id
  }

  /**
   * 归一化的语音识别状态，形状见 CONTRACT.md 的 `speech` 字段。
   * @returns `{ available, error, providers, selection, maxAudioBytes, maxDurationSeconds }`
   */
  function status() {
    const speech = service()
    if (speech === null) return unavailable('本机语音识别服务未启用')

    let snapshot
    try {
      if (typeof speech.snapshot !== 'function') {
        throw new Error('服务缺少 snapshot 方法')
      }
      snapshot = speech.snapshot()
    } catch (error) {
      return unavailable(`读取语音识别服务状态失败：${errorMessage(error)}`)
    }

    const providers = (Array.isArray(snapshot?.providers) ? snapshot.providers : []).map(
      normalizeProvider,
    )
    if (providers.length === 0) return unavailable('本机语音识别服务未启用')

    return {
      available: true,
      error: null,
      providers,
      selection: normalizeSelection(snapshot),
      maxAudioBytes,
      maxDurationSeconds,
    }
  }

  /**
   * 触发本地模型准备（下载/加载）。不等待完成——进度由 status() 轮询观察。
   * @param providerId - 可选，指定 provider；缺省用当前选择。
   * @returns 触发后的最新 status()。
   */
  function prepare(providerId) {
    const speech = requireService()
    if (typeof speech.prepare !== 'function') {
      throw new Error('当前版本语音识别服务不支持准备模型（缺少 prepare 方法）')
    }
    const current = status()
    if (current.available !== true) throw new Error(current.error ?? '本机语音识别服务未启用')
    const id = pickProviderId(current, providerId)
    let pending
    try {
      pending = speech.prepare(id)
    } catch (error) {
      throw new Error(`触发语音识别模型准备失败：${errorMessage(error)}`)
    }
    // prepare 可能返回 Promise；不阻塞调用方，但必须接住 rejection 以免变成
    // unhandled rejection（真正的失败会体现在下一次 snapshot.phase 上）。
    if (pending !== null && typeof pending?.then === 'function') {
      pending.catch(() => undefined)
    }
    return status()
  }

  /**
   * 等到指定 provider 可用；必要时先触发 prepare，再每 pollMs 轮询一次。
   * @param speech - 宿主服务。
   * @param requestedId - 调用方显式指定的 provider id。
   * @param signal - 可选 AbortSignal。
   * @returns 最终使用的 provider id。
   */
  async function ensureReady(speech, requestedId, signal) {
    throwIfAborted(signal)
    let current = status()
    if (current.available !== true) {
      throw new Error(current.error ?? '本机语音识别服务未启用')
    }
    const id = pickProviderId(current, requestedId)

    const findProvider = (snapshot) => snapshot.providers.find((provider) => provider.id === id)
    let provider = findProvider(current)
    if (provider === undefined) throw new Error(`未找到语音识别 provider：${id}`)
    if (READY_PHASES.has(provider.phase)) return id
    if (provider.phase === 'failed') {
      throw new Error(`语音识别模型准备失败：${provider.message ?? '未知原因'}`)
    }

    prepare(id)
    const deadline = Date.now() + prepareTimeoutMs
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(
          `语音识别模型准备超时（${Math.round(prepareTimeoutMs / 1000)} 秒内未就绪）`,
        )
      }
      await sleep(pollMs, signal)
      throwIfAborted(signal)
      current = status()
      if (current.available !== true) {
        throw new Error(current.error ?? '本机语音识别服务未启用')
      }
      provider = findProvider(current)
      if (provider === undefined) {
        throw new Error(`语音识别 provider 在准备过程中消失：${id}`)
      }
      if (READY_PHASES.has(provider.phase)) return id
      if (provider.phase === 'failed') {
        throw new Error(`语音识别模型准备失败：${provider.message ?? '未知原因'}`)
      }
    }
  }

  /**
   * 识别一段 WAV（16kHz 单声道 PCM16）。超过 segmentSeconds（默认 100 秒）会
   * 先切片，再逐片 resolve + transcribe，最后用 concatText 拼接。
   *
   * @param bytes - WAV 字节（Uint8Array / Buffer / ArrayBuffer）。
   * @param options - `{ language='zh', providerId?, signal? }`。
   * @returns `{ text, audioSeconds, inferenceSeconds }`。
   */
  async function transcribeWav(bytes, options = {}) {
    const { language, providerId } = options
    // The speech service contract requires an AbortSignal; a caller that does
    // not pass one still gets a live, never-aborted signal instead of crashing
    // inside the provider.
    const signal = options.signal ?? new AbortController().signal
    const finalLanguage = typeof language === 'string' && language !== '' ? language : 'zh'
    const audio = asAudioBytes(bytes)
    const info = validateWav(audio)
    if (info.samples === 0) throw new Error('音频为空：没有可识别的采样数据')

    const speech = requireService()
    const id = await ensureReady(speech, providerId, signal)
    if (typeof speech.resolve !== 'function' || typeof speech.transcribe !== 'function') {
      throw new Error('当前版本语音识别服务不支持转写（缺少 resolve/transcribe 方法）')
    }

    // Rebuild a canonical 44-byte header before the provider sees it: macOS
    // afconvert and some recorders add LIST/FLLR chunks that our own validator
    // tolerates but the native recognizer's wave reader rejects.
    const canonical = toCanonicalWav(audio)
    const slices = info.seconds > segmentSeconds ? splitWav(canonical, segmentSeconds) : [canonical]
    const texts = []
    let audioSeconds = 0
    let inferenceSeconds = 0

    for (let index = 0; index < slices.length; index += 1) {
      throwIfAborted(signal)
      const slice = slices[index]
      let spec
      try {
        spec = await speech.resolve({ audio: slice, language: finalLanguage, providerId: id })
      } catch (error) {
        throw new Error(
          `语音识别准备失败（第 ${index + 1}/${slices.length} 段）：${errorMessage(error)}`,
        )
      }
      if (spec === null || spec === undefined) {
        throw new Error(`语音识别服务没有返回可用的转写规格（第 ${index + 1}/${slices.length} 段）`)
      }
      let result
      try {
        result = await speech.transcribe(spec, signal)
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error(
          `语音识别失败（第 ${index + 1}/${slices.length} 段）：${errorMessage(error)}`,
        )
      }
      if (typeof result?.text === 'string') texts.push(result.text)
      const reported = Number(result?.audioSeconds)
      // provider 没报时长时用切片自身时长兜底，保证会议文档里的秒数不丢。
      audioSeconds += Number.isFinite(reported) && reported >= 0
        ? reported
        : validateWav(slice).seconds
      const inferred = Number(result?.inferenceSeconds)
      if (Number.isFinite(inferred) && inferred >= 0) inferenceSeconds += inferred
    }

    let text = ''
    try {
      // concatText 会丢掉空片段、去掉相邻重复句；全空时它抛错，这里转成更友好的提示。
      text = concatText(texts)
    } catch {
      text = ''
    }
    if (text === '') throw new Error('语音识别没有识别出任何文字')

    return {
      text,
      audioSeconds: round3(audioSeconds),
      inferenceSeconds: round3(inferenceSeconds),
    }
  }

  /** 用 afconvert 把任意音频文件转成 16k 单声道 PCM16 WAV。 */
  async function convertToWav(input, output) {
    try {
      await execFileAsync(
        AFCONVERT,
        ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, output],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      )
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`未找到音频转换工具 ${AFCONVERT}，无法转换该音频文件`)
      }
      if (error?.killed === true) throw new Error('音频转换超时')
      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
      const detail = [errorMessage(error), stderr].filter((part) => part !== '').join(' ')
      throw new Error(`音频转换失败：${detail}（支持 wav/mp3/m4a/mp4/aac）`)
    }
  }

  /**
   * 识别一个本地音频文件。已经是合格的 16k 单声道 PCM16 WAV 就直接用，
   * 否则用 afconvert 转成临时 WAV（os.tmpdir 下唯一文件，finally 删除）。
   *
   * @param path - 音频文件绝对路径（wav/mp3/m4a/mp4/aac 等）。
   * @param options - `{ language='zh', providerId?, signal? }`。
   * @returns `{ text, audioSeconds, inferenceSeconds, backend, segments?, speakers? }`。
   */
  async function transcribeFile(path, options = {}) {
    const { language, providerId, signal } = options
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('音频文件路径不能为空')
    }
    const file = path.trim()

    // 先问 VoiceStudio：它能直接吃 mp3/m4a 原文件，还能给带说话人的 segments。
    // 不可用时按 MEETING_ASR_BACKEND 的语义回退（auto）或抛错（voicestudio）。
    if (voiceStudio.enabled) {
      const viaVoiceStudio = await tryVoiceStudio(file, language, signal)
      if (viaVoiceStudio !== null) return viaVoiceStudio
    }

    let bytes
    try {
      bytes = await readFile(file)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`音频文件不存在：${file}`)
      throw new Error(`读取音频文件失败：${errorMessage(error)}`)
    }

    try {
      // 标准 16k 单声道 PCM16：直接用原字节。
      validateWav(bytes)
    } catch {
      // 先试着只重写头：WAVE_FORMAT_EXTENSIBLE(PCM) 很常见（afconvert 的输出
      // 就是），这种文件只差一个头，不必再转码一次。
      let normalized = null
      try {
        normalized = toCanonicalWav(bytes)
        validateWav(normalized)
      } catch {
        normalized = null
      }
      if (normalized !== null) {
        bytes = normalized
      } else {
        // 采样率/编码不对（mp3、m4a、44.1kHz wav 等），交给 afconvert 转成临时 WAV。
        const output = join(tmpdir(), `dsh-asr-${process.pid}-${randomUUID()}.wav`)
        try {
          await convertToWav(file, output)
          const converted = await readFile(output)
          try {
            // afconvert 写的是 extensible 头，再规范成标准 PCM。
            bytes = toCanonicalWav(converted)
            validateWav(bytes)
          } catch (error) {
            throw new Error(
              `音频转换失败：转换结果不是 16kHz 单声道 PCM16 WAV（${errorMessage(error)}）`,
            )
          }
        } finally {
          // 无论转码成功与否都清理临时文件；文件可能根本没被创建。
          try {
            await unlink(output)
          } catch {
            /* 临时文件不存在时忽略 */
          }
        }
      }
    }

    const local = await transcribeWav(bytes, { language, providerId, signal })
    return { ...local, backend: 'sensevoice-local' }
  }

  /**
   * 用 VoiceStudio 试一次转写。
   *
   * - 后端没响应：`MEETING_ASR_BACKEND=auto` 静默回退（返回 null 交给 SenseVoice），
   *   `voicestudio` 则抛错，让用户看到「没开 / 地址不对」的真实原因。
   * - 转写失败：auto 同样回退并在日志留一行；voicestudio 直接把错误抛给用户。
   *
   * @param file - 音频文件路径（原文件，不做 WAV 转换）。
   * @param language - 语言提示。
   * @param signal - 取消信号。
   */
  async function tryVoiceStudio(file, language, signal) {
    const available = await probeVoiceStudio(voiceStudio)
    if (!available) {
      if (!voiceStudio.fallback) {
        throw new Error(
          `VoiceStudio 不可用（${voiceStudio.baseUrl} 没有响应）。请确认 VoiceStudio.app 正在运行；`
            + '或把 MEETING_ASR_BACKEND 设为 auto/local，改用宿主 SenseVoice。',
        )
      }
      return null
    }
    try {
      const result = await transcribeViaVoiceStudio(file, voiceStudio, { language, signal })
      return { ...result, backend: 'voicestudio' }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      const message = errorMessage(error)
      if (!voiceStudio.fallback) throw new Error(`VoiceStudio 转写失败：${message}`)
      // 回退是设计内的降级，不打断转写；日志里留一行方便排查。
      try {
        ctx.logger?.warn?.(`meeting-minutes: VoiceStudio 转写失败，回退宿主 SenseVoice（${message}）`)
      } catch {
        /* logger 不可用时忽略 */
      }
      return null
    }
  }

  /** 当前转写后端的设置快照（工具输出 / 面板展示用）。 */
  function backendInfo() {
    return {
      mode: voiceStudio.enabled ? (voiceStudio.fallback ? 'auto' : 'voicestudio') : 'local',
      baseUrl: voiceStudio.baseUrl,
      diarize: voiceStudio.diarize,
    }
  }

  return { status, prepare, transcribeWav, transcribeFile, backendInfo }
}

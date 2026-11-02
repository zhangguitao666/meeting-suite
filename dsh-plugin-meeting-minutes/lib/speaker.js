/**
 * 会议纪要插件 · 本地说话人识别（声纹）
 *
 * 宿主的语音识别服务只给回文本 + 时长，没有时间戳也没有说话人。要在纪要里
 * 标出「谁在说」，只能自己在宿主侧补：每段实时录音切片先过一遍说话人声纹
 * 提取（sherpa-onnx 的 CAM++ 中文模型），拿 192 维向量在这个会议自己的
 * 说话人注册表里比 cosine：
 *
 * - 与某个已注册说话人的质心相似度 ≥ 阈值 → 归给他（并用 EMA 更新质心）；
 * - 都不像且容量没用满 → 注册成新的 `speaker-N` / `说话人N`；
 * - 容量用满 → 归到最相近的已注册说话人（不无限膨胀说话人数量）；
 * - 音频太短（< 1.2 秒）/ 依赖缺失 / 模型缺失 / 任何异常 → 返回 null，
 *   转写照常继续，只是这一行不加说话人前缀。
 *
 * 模型本身不随 npm 包分发：打包/安装脚本调用 {@link ensureSpeakerModel} 把
 * 28MB 的 onnx 下到 `$DSH_HOME/meeting-minutes/speaker/`（sha256 校验）；
 * 运行时只认已经就绪的文件，缺失就安静降级，绝不在会议中途去下大文件。
 *
 * @module dsh-plugin-meeting-minutes/speaker
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { pcm16ToFloat32 } from './audio.js'

/** 3D-Speaker CAM++ 中文通用声纹模型（16kHz）。 */
export const SPEAKER_MODEL_FILE = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'

/** 官方发布地址（注意上游把 recognition 拼成了 recongition）。 */
export const SPEAKER_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'

/** 模型字节数（与上游 release 资产一致）。 */
export const SPEAKER_MODEL_BYTES = 28281138

/** 模型 sha256（Lead 下载后实测校验值）。 */
export const SPEAKER_MODEL_SHA256 = 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11'

/** 声纹模型要求的采样率。 */
export const SPEAKER_SAMPLE_RATE = 16000

/**
 * 默认 cosine 阈值。CAM++ 实测：同一人 ≈ 0.64–0.79（偶尔弱同人 0.55–0.60），
 * 不同人 ≈ 0.04–0.50，取 0.58 作为分界（0.62 会把同一个人拆成两个）。
 */
export const SPEAKER_DEFAULT_THRESHOLD = 0.58

/** 每场会议最多记住多少个说话人。 */
export const SPEAKER_MAX_SPEAKERS = 8

/** 短于这个时长的切片不参与识别（避免把噪声注册成新说话人）。 */
export const SPEAKER_MIN_SECONDS = 1.2
/**
 * 低于这个 RMS 的切片当静音处理，直接不加标签：固定切片的录音器会把静音/房间
 * 噪声也送进来，那种向量只会污染注册表（实测会凭空多出说话人）。
 */
export const SPEAKER_MIN_RMS = 0.003

/** 命中后质心的指数移动平均系数。 */
export const SPEAKER_EMA_ALPHA = 0.3

/**
 * 说话人模型目录：`$DSH_HOME/meeting-minutes/speaker`。
 * @param home - harness home（默认 `$DSH_HOME`，再退到 `~/.dsh`）。
 */
export function resolveSpeakerModelDir(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home ?? join(homedir(), '.dsh'), 'meeting-minutes', 'speaker')
}

/** 说话人模型的绝对路径。 */
export function resolveSpeakerModelFile(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(resolveSpeakerModelDir(home), SPEAKER_MODEL_FILE)
}

/** sha256（hex，小写）。 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 读文件并校验大小 + sha256；不存在或不合格时给出原因。 */
async function inspectModelFile(file, expectedBytes, expectedSha256) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, ok: false, reason: '文件不存在' }
    return { exists: false, ok: false, reason: String(error?.message ?? error) }
  }
  if (!info.isFile()) return { exists: true, ok: false, reason: '不是普通文件' }
  if (info.size !== expectedBytes) {
    return { exists: true, ok: false, reason: `大小不符（${info.size} 字节，应为 ${expectedBytes} 字节）` }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { exists: true, ok: false, reason: `读取失败：${String(error?.message ?? error)}` }
  }
  const digest = sha256Hex(bytes)
  if (digest !== expectedSha256) return { exists: true, ok: false, reason: `sha256 校验失败（${digest}）` }
  return { exists: true, ok: true, bytes: info.size }
}

/**
 * 确保说话人模型就绪：已存在且大小/sha256 都对就短路返回；否则下载到 `dir`。
 *
 * 下载走临时文件 + rename，校验不过不会留下半成品。失败一律抛中文 Error，
 * 由调用方（安装脚本 / CLI）决定是否致命。
 *
 * @param options - `dir`（默认 $DSH_HOME 下的 speaker 目录）、`home`、`fetchImpl`
 *   （默认全局 fetch，测试可注入）、`logger`、`expectedBytes` / `expectedSha256`
 *   （仅测试用，覆盖内置常量）。
 * @returns 模型文件的绝对路径。
 */
export async function ensureSpeakerModel(options = {}) {
  const logger = options.logger
  const dir = options.dir ?? resolveSpeakerModelDir(options.home)
  const target = join(dir, SPEAKER_MODEL_FILE)
  const expectedBytes = Number.isFinite(Number(options.expectedBytes))
    ? Number(options.expectedBytes)
    : SPEAKER_MODEL_BYTES
  const expectedSha256 = typeof options.expectedSha256 === 'string' && options.expectedSha256 !== ''
    ? options.expectedSha256.toLowerCase()
    : SPEAKER_MODEL_SHA256

  const existing = await inspectModelFile(target, expectedBytes, expectedSha256)
  if (existing.ok) {
    logger?.info?.(`说话人模型已就绪：${target}`)
    return target
  }
  if (existing.exists) logger?.warn?.(`说话人模型校验未通过（${existing.reason}），重新下载：${target}`)

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch，无法下载说话人模型')

  let response
  try {
    response = await fetchImpl(SPEAKER_MODEL_URL)
  } catch (error) {
    throw new Error(`下载说话人模型失败（网络错误）：${String(error?.message ?? error)}`)
  }
  if (response === null || response === undefined || response.ok === false) {
    throw new Error(`下载说话人模型失败：HTTP ${response?.status ?? '未知'}`)
  }

  let bytes
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`读取说话人模型响应失败：${String(error?.message ?? error)}`)
  }
  if (bytes.length !== expectedBytes) {
    throw new Error(`说话人模型大小不符：期望 ${expectedBytes} 字节，实际 ${bytes.length} 字节`)
  }
  const digest = sha256Hex(bytes)
  if (digest !== expectedSha256) {
    throw new Error(`说话人模型 sha256 校验失败：期望 ${expectedSha256}，实际 ${digest}`)
  }

  let tmp
  try {
    await mkdir(dir, { recursive: true })
    tmp = `${target}.download-${process.pid}`
    await writeFile(tmp, bytes)
    await rename(tmp, target)
  } catch (error) {
    if (tmp !== undefined) {
      try { await unlink(tmp) } catch { /* the write/rename failure is the real error */ }
    }
    throw new Error(`写入说话人模型失败：${String(error?.message ?? error)}`)
  }
  logger?.info?.(`说话人模型已下载并通过校验：${target}`)
  return target
}

/** 把任意向量容器转成 Float32Array；不合法返回 null（不抛错）。 */
function asVector(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Float32Array) return value.length === 0 ? null : value
  if (value instanceof Float64Array || Array.isArray(value)) {
    if (value.length === 0) return null
    const vector = new Float32Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const number = Number(value[index])
      if (!Number.isFinite(number)) return null
      vector[index] = number
    }
    return vector
  }
  if (typeof value === 'object' && Number.isFinite(Number(value.length)) && Number(value.length) > 0) {
    const vector = new Float32Array(Number(value.length))
    for (let index = 0; index < vector.length; index += 1) {
      const number = Number(value[index])
      if (!Number.isFinite(number)) return null
      vector[index] = number
    }
    return vector
  }
  return null
}

/** 归一化向量；零向量或非法输入返回 null。 */
function normalizeVector(value) {
  const vector = asVector(value)
  if (vector === null) return null
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm)
  if (!(norm > 0) || !Number.isFinite(norm)) return null
  const normalized = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) normalized[index] = vector[index] / norm
  return normalized
}

/**
 * 两个向量的 cosine 相似度。
 *
 * 长度不一致、含非有限值、或任一为零向量时返回 0（识别链路追求「不意外
 * 匹配」，而不是抛错）。
 *
 * @param a - 向量（数组 / Float32Array / Float64Array）。
 * @param b - 向量。
 * @returns `[-1, 1]`；无法比较时为 0。
 */
export function cosineSimilarity(a, b) {
  const left = asVector(a)
  const right = asVector(b)
  if (left === null || right === null || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (!(leftNorm > 0) || !(rightNorm > 0)) return 0
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0
}

/** 保留 4 位小数，让日志与测试断言稳定。 */
function roundScore(score) {
  return Math.round(score * 10000) / 10000
}

/**
 * 一场会议自己的说话人注册表（内存态：向量不落盘，label 由 store 持久化）。
 *
 * @param options - `threshold`（默认 0.58）、`maxSpeakers`（默认 8）、
 *   `emaAlpha`（默认 0.3）。
 * @returns `{ identify, rename, list, size, threshold, maxSpeakers }`。
 *   `identify(vector)` → `{ id, label, isNew, score } | null`。
 */
export function createSpeakerRegistry(options = {}) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : SPEAKER_DEFAULT_THRESHOLD
  const maxSpeakers = Number.isFinite(Number(options.maxSpeakers)) && Number(options.maxSpeakers) >= 1
    ? Math.min(64, Math.trunc(Number(options.maxSpeakers)))
    : SPEAKER_MAX_SPEAKERS
  const emaAlpha = Number.isFinite(Number(options.emaAlpha))
    ? Math.min(1, Math.max(0, Number(options.emaAlpha)))
    : SPEAKER_EMA_ALPHA

  const speakers = []
  let nextIndex = 1

  /** EMA 更新质心并重新归一化，让长会议里同一人的向量慢慢收敛。 */
  function updateCentroid(speaker, vector) {
    if (emaAlpha <= 0 || vector.length !== speaker.centroid.length) return
    const merged = new Float32Array(vector.length)
    let norm = 0
    for (let index = 0; index < vector.length; index += 1) {
      merged[index] = (1 - emaAlpha) * speaker.centroid[index] + emaAlpha * vector[index]
      norm += merged[index] * merged[index]
    }
    norm = Math.sqrt(norm)
    if (!(norm > 0) || !Number.isFinite(norm)) return
    for (let index = 0; index < merged.length; index += 1) merged[index] /= norm
    speaker.centroid = merged
  }

  /**
   * 识别一个声纹向量。
   * @param vector - 声纹提取器给出的向量。
   * @returns 命中/新建结果，或 null（向量非法）。
   */
  function identify(vector) {
    const normalized = normalizeVector(vector)
    if (normalized === null) return null
    let best = null
    for (const speaker of speakers) {
      if (speaker.centroid.length !== normalized.length) continue
      const score = cosineSimilarity(normalized, speaker.centroid)
      if (best === null || score > best.score) best = { speaker, score }
    }
    if (best !== null && best.score >= threshold) {
      updateCentroid(best.speaker, normalized)
      return { id: best.speaker.id, label: best.speaker.label, isNew: false, score: roundScore(best.score) }
    }
    if (speakers.length < maxSpeakers) {
      const index = nextIndex
      nextIndex += 1
      const speaker = { id: `speaker-${index}`, label: `说话人${index}`, centroid: normalized }
      speakers.push(speaker)
      return { id: speaker.id, label: speaker.label, isNew: true, score: roundScore(best === null ? 0 : best.score) }
    }
    // 容量用满：宁可归到最相近的人，也不要无限新增说话人。
    if (best !== null) {
      updateCentroid(best.speaker, normalized)
      return { id: best.speaker.id, label: best.speaker.label, isNew: false, score: roundScore(best.score) }
    }
    return null
  }

  /** 重命名一个说话人；空名字或未知 id 返回 null。 */
  function rename(id, name) {
    const speaker = speakers.find((entry) => entry.id === id)
    if (speaker === undefined) return null
    const label = typeof name === 'string' ? name.trim() : ''
    if (label === '') return null
    speaker.label = label.slice(0, 40)
    return { id: speaker.id, label: speaker.label }
  }

  /** 当前说话人列表 `[{ id, label }]`。 */
  function list() {
    return speakers.map((speaker) => ({ id: speaker.id, label: speaker.label }))
  }

  return {
    identify,
    rename,
    list,
    size: () => speakers.length,
    get threshold() { return threshold },
    get maxSpeakers() { return maxSpeakers },
  }
}

/**
 * Slark 的 runtime 自带一份**已按 Slark Team ID 签名**的 sherpa-onnx-node。
 * 插件自己 `npm install` 下来的那份是上游或 ad-hoc 签名，而 Slark 的 runtime
 * node 开了 hardened runtime + 库校验：在宿主进程里 dlopen 别的 Team ID 的
 * .node 会被直接拒绝（"different Team IDs"），即使文件本身完好。所以宿主里
 * 必须优先复用 runtime 那份，插件本地依赖只留给独立 `dsh web`（非 Slark 的
 * 未签名 node）使用。
 *
 * @param execPath - 默认 `process.execPath`；测试可注入。
 * @returns runtime 里 sherpa-onnx-node 的模块目录，找不到返回 null。
 */
export function resolveRuntimeSherpaModule(execPath = process.execPath) {
  try {
    // <runtime>/node/bin/node → <runtime>/app/node_modules/.pnpm（bin → node → runtime）
    const appRoot = join(dirname(execPath), '..', '..', 'app')
    const pnpmRoot = join(appRoot, 'node_modules', '.pnpm')
    const entries = readdirSync(pnpmRoot)
      .filter((name) => name.startsWith('sherpa-onnx-node@'))
      .sort()
      .reverse()
    for (const entry of entries) {
      const dir = join(pnpmRoot, entry, 'node_modules', 'sherpa-onnx-node')
      if (existsSync(join(dir, 'package.json'))) return dir
    }
    return null
  } catch {
    return null
  }
}

/**
 * 依次尝试几种 sherpa 解析方式：Slark runtime 自带的签名副本 → 插件自己的
 * 依赖 → `MEETING_SPEAKER_SHERPA` 显式绝对路径（调试/自定义安装用）。
 */
function loadSherpaModule() {
  const attempts = []
  const runtimeModule = resolveRuntimeSherpaModule()
  if (runtimeModule !== null) {
    attempts.push(() => createRequire(join(runtimeModule, 'package.json'))(runtimeModule))
  }
  attempts.push(() => createRequire(import.meta.url)('sherpa-onnx-node'))
  if (typeof process.env.MEETING_SPEAKER_SHERPA === 'string' && process.env.MEETING_SPEAKER_SHERPA !== '') {
    attempts.push(() => createRequire(import.meta.url)(process.env.MEETING_SPEAKER_SHERPA))
  }
  let lastError = null
  for (const attempt of attempts) {
    try {
      return attempt()
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`缺少依赖 sherpa-onnx-node：${String(lastError?.message ?? lastError)}`)
}

/** 默认的提取器加载器（sherpa-onnx-node，CommonJS → createRequire）。 */
async function defaultLoadExtractor({ modelPath }) {
  const sherpa = loadSherpaModule()
  return new sherpa.SpeakerEmbeddingExtractor({
    model: modelPath,
    numThreads: 1,
    provider: 'cpu',
    debug: false,
  })
}

/**
 * 从注入的加载器/真实提取器里算一段采样的声纹向量。
 * 只依赖 sherpa 的 `createStream()` → `acceptWaveform({sampleRate, samples})`
 * → `compute(stream)` 三件套。
 */
function extractEmbedding(extractor, samples) {
  const stream = extractor.createStream()
  if (stream === null || stream === undefined) throw new Error('声纹提取器没有返回 stream')
  if (typeof stream.acceptWaveform !== 'function') throw new Error('声纹 stream 不支持 acceptWaveform')
  stream.acceptWaveform({ sampleRate: SPEAKER_SAMPLE_RATE, samples })
  if (typeof extractor.compute !== 'function') throw new Error('声纹提取器不支持 compute')
  const vector = extractor.compute(stream)
  return asVector(vector)
}

/**
 * 解析说话人相关的环境变量覆盖（`MEETING_SPEAKER_DISABLE` /
 * `MEETING_SPEAKER_THRESHOLD` / `MEETING_SPEAKER_MAX`）。
 *
 * @param env - 默认 process.env。
 * @returns `{ disabled, threshold, maxSpeakers, minSeconds }`。
 */
export function resolveSpeakerSettings(env = process.env) {
  const rawThreshold = Number(env?.MEETING_SPEAKER_THRESHOLD)
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold <= 1
    ? rawThreshold
    : SPEAKER_DEFAULT_THRESHOLD
  const rawMax = Number(env?.MEETING_SPEAKER_MAX)
  const maxSpeakers = Number.isFinite(rawMax) && rawMax >= 1
    ? Math.min(32, Math.trunc(rawMax))
    : SPEAKER_MAX_SPEAKERS
  return {
    disabled: env?.MEETING_SPEAKER_DISABLE === '1',
    threshold,
    maxSpeakers,
    minSeconds: SPEAKER_MIN_SECONDS,
  }
}

/**
 * 扫描级说话人标记者：一次会议一段音频切片进，出来一个 `{ id, label }`。
 *
 * 设计要点：
 * - 提取器按需加载（lazy），加载失败只 warn，`identify` 永远返回 null，绝不抛；
 * - 每场会议一个独立注册表（`registries` Map），互不串人；
 * - 模型缺失/损坏时不下载（下载由安装脚本负责），直接降级；
 * - 失败后 15 秒内不重试，避免每个 VAD 切片都去碰一次坏模型。
 *
 * @param options - `home`、`logger`、`loadExtractor`（测试注入）、`threshold`、
 *   `maxSpeakers`、`minSeconds`、`disabled`。
 * @returns `{ identify, rename, list, reset, status, warmup, ready }`。
 */
export function createSpeakerTagger(options = {}) {
  const logger = options.logger
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const disabled = options.disabled === true
  const settings = resolveSpeakerSettings({ ...process.env, ...(options.env ?? {}) })
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : settings.threshold
  const maxSpeakers = Number.isFinite(Number(options.maxSpeakers)) ? Number(options.maxSpeakers) : settings.maxSpeakers
  const minSeconds = Number.isFinite(Number(options.minSeconds)) ? Number(options.minSeconds) : settings.minSeconds
  const minSamples = Math.max(1, Math.round(minSeconds * SPEAKER_SAMPLE_RATE))
  const modelPath = options.modelPath ?? resolveSpeakerModelFile(home)
  const registries = new Map()

  let extractor = null
  let loading = null
  let retryAt = 0
  const state = {
    status: disabled ? 'disabled' : 'idle',
    error: disabled ? '已通过 MEETING_SPEAKER_DISABLE=1 关闭' : null,
  }

  /** 该会议（默认 `'default'`）的注册表。 */
  function registryFor(meetingId) {
    const key = typeof meetingId === 'string' && meetingId !== '' ? meetingId : 'default'
    let registry = registries.get(key)
    if (registry === undefined) {
      registry = createSpeakerRegistry({ threshold, maxSpeakers })
      registries.set(key, registry)
    }
    return registry
  }

  /** 按需加载提取器；失败返回 null（不抛）。 */
  async function ensureExtractor() {
    if (disabled) return null
    if (extractor !== null) return extractor
    if (loading !== null) return loading
    if (Date.now() < retryAt) return null
    loading = (async () => {
      try {
        let loaded
        if (typeof options.loadExtractor === 'function') {
          loaded = await options.loadExtractor({ modelPath })
        } else {
          const inspected = await inspectModelFile(modelPath, SPEAKER_MODEL_BYTES, SPEAKER_MODEL_SHA256)
          if (!inspected.exists) {
            throw new Error(`缺少说话人模型：${modelPath}（请重新安装插件或先运行模型下载脚本）`)
          }
          if (!inspected.ok) throw new Error(`说话人模型不可用（${inspected.reason}）：${modelPath}`)
          loaded = await defaultLoadExtractor({ modelPath })
        }
        if (loaded === null || loaded === undefined || typeof loaded.createStream !== 'function') {
          throw new Error('声纹提取器不可用（没有 createStream）')
        }
        extractor = loaded
        state.status = 'ready'
        state.error = null
        logger?.info?.(`说话人识别已就绪（维度 ${loaded.dim ?? '未知'}，阈值 ${threshold}）`)
        return extractor
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.status = 'failed'
        state.error = message
        retryAt = Date.now() + 15000
        logger?.warn?.(`说话人识别不可用，实时转写暂不加说话人标签：${message}`)
        return null
      } finally {
        loading = null
      }
    })()
    return loading
  }

  /**
   * 识别一段 WAV 切片属于谁。
   * @param wavBytes - 16k 单声道 PCM16 WAV。
   * @param identifyOptions - `meetingId`：会议 id（决定用哪张注册表）。
   * @returns `{ id, label, isNew, score } | null`；**任何情况下都不抛**。
   */
  async function identify(wavBytes, identifyOptions = {}) {
    try {
      if (disabled) return null
      const active = await ensureExtractor()
      if (active === null) return null
      let samples
      try {
        samples = pcm16ToFloat32(wavBytes)
      } catch (error) {
        logger?.warn?.(`说话人识别跳过：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      if (samples.length < minSamples) return null
      let energy = 0
      for (let index = 0; index < samples.length; index += 1) energy += samples[index] * samples[index]
      if (Math.sqrt(energy / samples.length) < SPEAKER_MIN_RMS) return null
      let vector
      try {
        vector = extractEmbedding(active, samples)
      } catch (error) {
        logger?.warn?.(`声纹提取失败，已跳过本次标签：${error instanceof Error ? error.message : String(error)}`)
        return null
      }
      if (vector === null) return null
      const meetingId = typeof identifyOptions?.meetingId === 'string' ? identifyOptions.meetingId : ''
      const result = registryFor(meetingId).identify(vector)
      if (result === null) return null
      return { id: result.id, label: result.label, isNew: result.isNew, score: result.score }
    } catch (error) {
      logger?.warn?.(`说话人识别失败，已跳过本次标签：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** 同步重命名（服务器把用户改的名字也写回注册表，后续切片才用新名字）。 */
  function rename(meetingId, speakerId, name) {
    const key = typeof meetingId === 'string' && meetingId !== '' ? meetingId : 'default'
    const registry = registries.get(key)
    return registry === undefined ? null : registry.rename(speakerId, name)
  }

  /** 该会议已识别出的说话人（内存态，重启后为空）。 */
  function list(meetingId) {
    const key = typeof meetingId === 'string' && meetingId !== '' ? meetingId : 'default'
    const registry = registries.get(key)
    return registry === undefined ? [] : registry.list()
  }

  /** 丢掉一场会议的注册表（会议被删除时清理）。 */
  function reset(meetingId) {
    registries.delete(typeof meetingId === 'string' && meetingId !== '' ? meetingId : 'default')
  }

  /** 当前状态快照（给 /state 或日志用）。 */
  function status() {
    return {
      enabled: !disabled,
      ready: extractor !== null,
      status: state.status,
      error: state.error,
      threshold,
      maxSpeakers,
      minSeconds,
      modelPath,
      meetings: registries.size,
    }
  }

  /** 后台预热提取器（插件启动后调用，失败只 warn）。 */
  async function warmup() {
    const active = await ensureExtractor()
    return active !== null
  }

  return { identify, rename, list, reset, status, warmup, get ready() { return extractor !== null } }
}

/**
 * 会议纪要插件 · VoiceStudio 外部语音识别后端
 *
 * 宿主的 SenseVoice 服务只回「文本 + 时长」，没有时间戳，也没有说话人。本机装了
 * VoiceStudio（Electron App + Python 后端，默认 http://127.0.0.1:3900）之后，可以把
 * 整段录音直接交给它的 `POST /transcribe`，用 `mode=accurate&diarize=1` 一次拿到
 * 带说话人标签的 segments，再拼成「说话人N：」多行文本 —— 格式与插件里实时录音的
 * 说话人前缀（`说话人1：`）保持一致，所以 `meeting_speakers` 的改名单条链路可以直接复用。
 *
 * 设计约束：
 * - **不打断现有链路**：VoiceStudio 不可用（没开、模型没装、超时）时必须能回退到
 *   宿主 SenseVoice；只有显式 `MEETING_ASR_BACKEND=voicestudio` 时才把错误抛给用户。
 * - **配置走环境变量**：与 speaker 那套（MEETING_SPEAKER_*）保持同一风格，避免改插件
 *   config schema（`apply(ctx)` 目前不接 config）。
 * - 长会议可能跑很久，默认超时 30 分钟；探测（/health）超时只有 1.5 秒，避免每次
 *   转写都被一个没开的后端拖住。
 *
 * @module dsh-plugin-meeting-minutes/voicestudio
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/** VoiceStudio 后端默认地址（它自己 App 的默认端口）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3900'

/** 整段转写的默认超时：30 分钟（长会议 + 首次加载模型）。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** /health 探测的默认超时：1.5 秒。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500

/** 支持的 backend 取值。 */
export const BACKENDS = new Set(['auto', 'local', 'voicestudio'])

/** 读一个正整数环境变量，非法时用兜底值。 */
function intOr(value, fallback, minimum = 1) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  return rounded >= minimum ? rounded : fallback
}

/** 读一个布尔环境变量：'0'/'false'/'no'/'off' 为假，其余非空为真。 */
function boolOr(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

/**
 * 从环境变量解析 VoiceStudio 后端设置。
 *
 * | 变量 | 默认 | 说明 |
 * | --- | --- | --- |
 * | `MEETING_ASR_BACKEND` | `auto` | `auto`=可用就用；`local`=只用宿主 SenseVoice；`voicestudio`=强制用（失败报错不回退） |
 * | `MEETING_VOICESTUDIO_URL` | `http://127.0.0.1:3900` | 后端地址 |
 * | `MEETING_VOICESTUDIO_DIARIZE` | `1` | 是否要说话人标签 |
 * | `MEETING_VOICESTUDIO_SPEAKERS` | `0` | 说话人数量提示；0=自动 |
 * | `MEETING_VOICESTUDIO_TIMEOUT_MS` | `1800000` | 转写超时 |
 * | `MEETING_VOICESTUDIO_PROBE_MS` | `1500` | 探测超时 |
 *
 * @param env - 环境变量对象（默认 process.env）。
 */
export function resolveVoiceStudioSettings(env = {}) {
  const rawBackend = typeof env.MEETING_ASR_BACKEND === 'string'
    ? env.MEETING_ASR_BACKEND.trim().toLowerCase()
    : ''
  const backend = BACKENDS.has(rawBackend) ? rawBackend : 'auto'
  const rawUrl = typeof env.MEETING_VOICESTUDIO_URL === 'string'
    ? env.MEETING_VOICESTUDIO_URL.trim()
    : ''
  const baseUrl = (rawUrl === '' ? DEFAULT_BASE_URL : rawUrl).replace(/\/+$/u, '')
  return {
    backend,
    baseUrl,
    diarize: boolOr(env.MEETING_VOICESTUDIO_DIARIZE, true),
    numSpeakers: intOr(env.MEETING_VOICESTUDIO_SPEAKERS, 0, 0),
    timeoutMs: intOr(env.MEETING_VOICESTUDIO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000),
    probeTimeoutMs: intOr(env.MEETING_VOICESTUDIO_PROBE_MS, DEFAULT_PROBE_TIMEOUT_MS, 100),
    /** 后端不可用时的处置：auto 静默回退，voicestudio 报错。 */
    fallback: backend !== 'voicestudio',
    enabled: backend !== 'local',
  }
}

/** 拼 URL（baseUrl 已去掉结尾斜杠）。 */
function joinUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 探测后端是否活着。任何异常（没开、连不上、超时）都当作不可用，不抛错。
 *
 * @param settings - {@link resolveVoiceStudioSettings} 的返回值。
 * @param options - `{ fetchImpl }`，测试可注入。
 * @returns 后端可用时 true。
 */
export async function probeVoiceStudio(settings, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.probeTimeoutMs)
  if (typeof timer?.unref === 'function') timer.unref()
  try {
    const response = await fetchImpl(joinUrl(settings.baseUrl, '/health'), { signal: controller.signal })
    return response?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 读 segment 上的说话人标识；没有就是空串。 */
function segmentSpeaker(segment) {
  const raw = segment?.speaker
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 把相邻文本拼起来：中文直接接，拉丁字母之间补一个空格。 */
function joinText(left, right) {
  if (left === '') return right
  if (right === '') return left
  const needsSpace = /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right)
  return needsSpace ? `${left} ${right}` : `${left}${right}`
}

/**
 * 把后端 segments 归一化成插件自己的一套编号。
 *
 * 后端给的说话人标识形态不稳定（`SPEAKER_00`、`Speaker 1`、`说话人1`、数字都有），
 * 所以不直接用它，而是**按首次出现顺序**重新编号成 `speaker-1` / `说话人1`，
 * 保证 transcript 前缀和 speakers 列表永远一致。
 *
 * 连续同一个人的 segment 合并成一行，减少「说话人1：嗯 / 说话人1：对」这种碎行。
 *
 * @param segments - 后端返回的 `[{ start, end, text, speaker? }]`。
 * @returns `{ text, speakers, segments }`；没有说话人信息时 text 是纯文本。
 */
export function normalizeSegments(segments) {
  const list = Array.isArray(segments) ? segments : []
  const order = []
  const ids = new Map()
  const turns = []

  /** 取（或登记）某个后端说话人标识对应的插件 id / label。 */
  function ensureSpeaker(raw) {
    if (raw === '') return null
    let entry = ids.get(raw)
    if (entry === undefined) {
      const index = order.length + 1
      entry = { id: `speaker-${index}`, label: `说话人${index}` }
      ids.set(raw, entry)
      order.push(entry)
    }
    return entry
  }

  const normalized = []
  for (const segment of list) {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : ''
    const rawSpeaker = segmentSpeaker(segment)
    const speaker = ensureSpeaker(rawSpeaker)
    if (text === '') continue
    normalized.push({
      start: Number.isFinite(Number(segment?.start)) ? Number(segment.start) : null,
      end: Number.isFinite(Number(segment?.end)) ? Number(segment.end) : null,
      text,
      speakerId: speaker === null ? null : speaker.id,
      speakerLabel: speaker === null ? null : speaker.label,
    })
    const last = turns[turns.length - 1]
    if (last !== undefined && last.speakerId === (speaker === null ? null : speaker.id)) {
      last.text = joinText(last.text, text)
    } else {
      turns.push({
        speakerId: speaker === null ? null : speaker.id,
        speakerLabel: speaker === null ? null : speaker.label,
        text,
      })
    }
  }

  const anySpeaker = order.length > 0
  const text = anySpeaker
    // 有说话人：一行一句，`说话人N：文本`（全角冒号，与 store.renameSpeaker 的前缀一致）。
    ? turns.map((turn) => (turn.speakerId === null ? turn.text : `${turn.speakerLabel}：${turn.text}`)).join('\n')
    // 没有说话人：保持纯文本（单行），避免把转写拆成多行。
    : turns.map((turn) => turn.text).join(' ')
  return { text, speakers: order, segments: normalized }
}

/** 从响应里抠出文本：优先 segments，退化成顶层 text。 */
function responsePlainText(payload) {
  if (typeof payload?.text === 'string' && payload.text.trim() !== '') return payload.text.trim()
  const list = Array.isArray(payload?.segments) ? payload.segments : []
  const parts = list
    .map((segment) => (typeof segment?.text === 'string' ? segment.text.trim() : ''))
    .filter((part) => part !== '')
  return parts.join(' ')
}

/** 把后端错误响应体压成一行可读文本。 */
function shortBody(body) {
  const text = String(body ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * 用 VoiceStudio 转写一个本地音频文件。
 *
 * @param path - 音频文件绝对路径（wav/mp3/m4a/mp4 等，后端负责解码）。
 * @param settings - {@link resolveVoiceStudioSettings} 的返回值。
 * @param options - `{ language, signal, fetchImpl }`。
 * @returns `{ text, plainText, audioSeconds, inferenceSeconds, segments, speakers, language, engine, diarizationError }`。
 */
export async function transcribeViaVoiceStudio(path, settings, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch，无法调用 VoiceStudio')

  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`音频文件不存在：${path}`)
    throw new Error(`读取音频文件失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (bytes.length === 0) throw new Error('音频为空：没有可上传的数据')

  const form = new FormData()
  form.append('audio', new Blob([bytes]), basename(path))
  // accurate 模式才有 segment 时间轴，diarize 也只在 accurate 下生效。
  form.append('mode', 'accurate')
  if (settings.diarize) form.append('diarize', '1')
  if (settings.numSpeakers > 0) form.append('num_speakers', String(settings.numSpeakers))
  const language = typeof options.language === 'string' ? options.language.trim() : ''
  if (language !== '' && language.toLowerCase() !== 'auto') form.append('language', language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  if (typeof timer?.unref === 'function') timer.unref()
  const onAbort = () => controller.abort()
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  let response
  try {
    response = await fetchImpl(joinUrl(settings.baseUrl, '/transcribe'), {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('VoiceStudio 转写超时或被取消')
    throw new Error(`连不上 VoiceStudio（${settings.baseUrl}）：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', onAbort)
  }

  if (!response?.ok) {
    const body = typeof response?.text === 'function' ? await response.text().catch(() => '') : ''
    throw new Error(`VoiceStudio 转写失败：HTTP ${response?.status ?? '未知'} ${shortBody(body)}`.trim())
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error(`VoiceStudio 返回的不是 JSON：${error instanceof Error ? error.message : String(error)}`)
  }

  const normalized = normalizeSegments(payload?.segments)
  const plainText = responsePlainText(payload)
  const text = normalized.text !== '' ? normalized.text : plainText
  if (text === '') throw new Error('语音识别没有识别出任何文字')

  const durationSeconds = Number(payload?.duration_s)
  const timeSeconds = Number(payload?.transcription_time_s)
  const diarizationError = typeof payload?.diarization_error === 'string' ? payload.diarization_error : ''
  return {
    text,
    plainText,
    audioSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0,
    inferenceSeconds: Number.isFinite(timeSeconds) && timeSeconds >= 0 ? timeSeconds : 0,
    segments: normalized.segments,
    speakers: normalized.speakers,
    language: typeof payload?.language === 'string' ? payload.language : '',
    engine: typeof payload?.engine === 'string' ? payload.engine : 'voicestudio',
    diarizationError,
  }
}

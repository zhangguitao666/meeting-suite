/**
 * Durable meeting store for the meeting-minutes plugin.
 *
 * One JSON document holds every meeting:
 * `$DSH_HOME/storages/meeting-minutes.json`. Writes go through a single promise
 * chain and land via temp-file + rename, so a reader never observes a half
 * written document and a crash cannot leave a torn file.
 *
 * The store deliberately has no dependency on the harness storage service: the
 * plugin is installed as a local package and must load with zero bare imports.
 *
 * @module dsh-plugin-meeting-minutes/store
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_AUTO_INGEST, normalizeAutoIngestConfig, normalizeMeeting } from './model.js'

const EMPTY = { version: 1, updatedAt: null, meetings: [], autoIngest: { ...DEFAULT_AUTO_INGEST } }
const STORE_FILE = 'meeting-minutes.json'

/** The harness home directory. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the store file path, honoring DSH_HOME. */
export function resolveStoreFile(home = dshHome()) {
  return join(home, 'storages', STORE_FILE)
}

/** `speaker-1` 的默认中文标签：`说话人1`。 */
export function defaultSpeakerLabel(id) {
  const match = /^speaker-(\d{1,4})$/u.exec(String(id ?? ''))
  return match === null ? '说话人' : `说话人${Number(match[1])}`
}

/**
 * Normalize the persisted speaker list: `[{ id: 'speaker-1', label: '说话人1' }]`.
 *
 * Speaker identity comes from the local voiceprint registry; the store only
 * keeps the durable id → label mapping so a renamed speaker survives restarts.
 * Malformed entries are dropped instead of failing the whole meeting load.
 *
 * @param value - raw speaker list.
 * @returns canonical speaker list (at most 32 entries, unique ids).
 */
export function normalizeSpeakers(value) {
  if (!Array.isArray(value)) return []
  const speakers = []
  const seen = new Set()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!/^speaker-\d{1,4}$/u.test(id) || seen.has(id)) continue
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    seen.add(id)
    speakers.push({ id, label: (label === '' ? defaultSpeakerLabel(id) : label).slice(0, 40) })
    if (speakers.length >= 32) break
  }
  return speakers
}

/** 在纯文本里把 `旧标签：` 前缀全文替换成 `新标签：`。 */
function replaceSpeakerPrefix(text, oldLabel, newLabel) {
  if (typeof text !== 'string' || text === '' || oldLabel === newLabel) return text
  return text.split(`${oldLabel}：`).join(`${newLabel}：`)
}

/** Read+parse the document; a corrupt file is renamed and treated as empty. */
async function readDocument(file, logger) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    const meetings = Array.isArray(parsed?.meetings)
      ? parsed.meetings.map((entry) => {
        const meeting = normalizeMeeting(entry, { now: new Date(entry?.createdAt ?? Date.now()) })
        // `speakers` lives outside model.js (the panel/package lines own that
        // file), so the store reapplies it when rehydrating from disk.
        meeting.speakers = normalizeSpeakers(entry?.speakers)
        return meeting
      })
      : []
    return {
      version: 1,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
      meetings,
      autoIngest: normalizeAutoIngestConfig(parsed?.autoIngest),
    }
  } catch (error) {
    logger?.warn?.(`meeting-minutes: unreadable store ${file}, starting empty (${String(error?.message ?? error)})`)
    try {
      await rename(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // Best effort: the corrupt file is reported, not fatal.
    }
    return { ...EMPTY, meetings: [] }
  }
}

/** In-memory document + serialized durable writes. */
export class MeetingStore {
  #file
  #logger
  #doc = { ...EMPTY, meetings: [] }
  #ready = null
  #chain = Promise.resolve()

  /**
   * @param options - `file` (store path), `logger` (optional `{info,warn,error}`).
   */
  constructor(options = {}) {
    this.#file = options.file ?? resolveStoreFile()
    this.#logger = options.logger
  }

  /** Store file path (exposed for diagnostics). */
  get file() {
    return this.#file
  }

  /** Load once; concurrent callers share the same promise. */
  async load() {
    if (this.#ready === null) {
      this.#ready = (async () => {
        const current = await readDocument(this.#file, this.#logger)
        this.#doc = current ?? { ...EMPTY, meetings: [] }
        return this.#doc
      })()
    }
    return this.#ready
  }

  /** Current document copy (callers cannot mutate the store). */
  snapshot() {
    return {
      version: 1,
      updatedAt: this.#doc.updatedAt,
      meetings: this.#doc.meetings.map((meeting) => structuredClone(meeting)),
      autoIngest: structuredClone(this.#doc.autoIngest),
    }
  }

  /** Persisted auto-ingest configuration and bookkeeping. */
  get autoIngest() {
    return this.#doc.autoIngest
  }

  /** Replace the auto-ingest configuration (merged onto the stored one). */
  async setAutoIngest(patch) {
    await this.update((doc) => {
      doc.autoIngest = normalizeAutoIngestConfig({ ...doc.autoIngest, ...patch })
    })
    return this.#doc.autoIngest
  }

  /** Record one scan outcome without touching the rest of the config. */
  async noteAutoScan(patch) {
    await this.update((doc) => {
      doc.autoIngest = normalizeAutoIngestConfig({ ...doc.autoIngest, ...patch })
    })
    return this.#doc.autoIngest
  }

  /** Remember one ingested source file so it is never imported twice. */
  async markAutoIngested(key, info, options = {}) {
    await this.update((doc) => {
      const auto = doc.autoIngest
      auto.ingested[key] = {
        meetingId: String(info.meetingId ?? ''),
        title: String(info.title ?? ''),
        at: new Date().toISOString(),
        path: String(info.path ?? ''),
      }
      // A silent duplicate skip remembers the source without inflating the count.
      if (options.count !== false) auto.importedCount = Number(auto.importedCount) + 1
      delete auto.failures[key]
      // Keep the bookkeeping bounded; the newest entries win.
      const keys = Object.keys(auto.ingested)
      if (keys.length > 400) {
        for (const stale of keys.slice(0, keys.length - 400)) delete auto.ingested[stale]
      }
    })
    return this.#doc.autoIngest
  }

  /** Remember a failed auto-ingest attempt and stop retrying after 3 tries. */
  async markAutoFailure(key, message) {
    await this.update((doc) => {
      const previous = doc.autoIngest.failures[key]
      const count = previous === undefined ? 1 : Math.min(20, Number(previous.count) + 1)
      doc.autoIngest.failures[key] = {
        count,
        message: String(message ?? '').slice(0, 400),
        at: new Date().toISOString(),
      }
      doc.autoIngest.lastError = String(message ?? '').slice(0, 500)
    })
    return this.#doc.autoIngest
  }

  /** Current meetings (live array; internal use only). */
  get meetings() {
    return this.#doc.meetings
  }

  /** One meeting by exact id, or null. */
  get(id) {
    return this.#doc.meetings.find((meeting) => meeting.id === id) ?? null
  }

  /** Find by exact id, else by unique title (exact then substring). */
  find(reference) {
    const needle = typeof reference === 'string' ? reference.trim() : ''
    if (needle === '') return null
    const byId = this.get(needle)
    if (byId !== null) return byId
    const lowered = needle.toLowerCase()
    const exact = this.#doc.meetings.filter((meeting) => meeting.title.toLowerCase() === lowered)
    if (exact.length === 1) return exact[0]
    const partial = this.#doc.meetings.filter((meeting) => meeting.title.toLowerCase().includes(lowered))
    return partial.length === 1 ? partial[0] : null
  }

  /** Find the meeting that already holds this audio fingerprint, or null. */
  findByAudioSha256(sha256) {
    const needle = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : ''
    if (needle === '') return null
    return this.#doc.meetings.find((meeting) => meeting.audioSha256 === needle) ?? null
  }

  /** Persist the document through temp-file + rename. */
  async #persist() {
    const payload = JSON.stringify(this.#doc, null, 2)
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp-${process.pid}`
    await writeFile(tmp, payload, 'utf8')
    try {
      await rename(tmp, this.#file)
    } catch (error) {
      try { await unlink(tmp) } catch { /* the rename failure is the real error */ }
      throw error
    }
  }

  /** Serialize one mutation against the document and persist it. */
  async update(mutate, options = {}) {
    await this.load()
    const run = this.#chain.then(async () => {
      const result = mutate(this.#doc)
      if (options.persist !== false) {
        this.#doc.updatedAt = new Date().toISOString()
        await this.#persist()
      }
      return result
    })
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Insert one meeting (canonicalized). */
  async add(raw, options = {}) {
    const now = options.now ?? new Date()
    const meeting = normalizeMeeting({ ...raw, id: raw?.id ?? undefined }, { now })
    meeting.speakers = normalizeSpeakers(raw?.speakers)
    await this.update((doc) => { doc.meetings.push(meeting) })
    return meeting
  }

  /**
   * Patch one meeting.
   * @param id - exact meeting id.
   * @param patch - fields to replace; `summary` replaces wholesale.
   */
  async patch(id, patch, options = {}) {
    const now = options.now ?? new Date()
    let updated = null
    await this.update((doc) => {
      const index = doc.meetings.findIndex((meeting) => meeting.id === id)
      if (index === -1) throw new Error(`未找到会议：${id}`)
      const base = doc.meetings[index]
      const next = normalizeMeeting({ ...patch, id }, { now, base })
      next.speakers = patch?.speakers === undefined
        ? normalizeSpeakers(base.speakers)
        : normalizeSpeakers(patch.speakers)
      doc.meetings[index] = next
      updated = next
    })
    return updated
  }

  /** Replace one meeting's speaker list outright. */
  async setSpeakers(id, speakers, options = {}) {
    const now = options.now ?? new Date()
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === id)
      if (meeting === undefined) throw new Error(`未找到会议：${id}`)
      meeting.speakers = normalizeSpeakers(speakers)
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }

  /**
   * Append one speaker unless the id is already known (atomic, so two live
   * slices identifying different voices cannot overwrite each other's list).
   */
  async addSpeaker(id, speaker, options = {}) {
    const now = options.now ?? new Date()
    const normalized = normalizeSpeakers([speaker])[0]
    if (normalized === undefined) throw new Error('说话人信息不合法：需要形如 { id: "speaker-1", label: "说话人1" }')
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === id)
      if (meeting === undefined) throw new Error(`未找到会议：${id}`)
      if (!meeting.speakers.some((entry) => entry.id === normalized.id)) meeting.speakers.push(normalized)
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }

  /**
   * Rename one speaker: update the registry label and rewrite the `旧标签：`
   * prefix in both `transcript` and `transcriptRaw`. Prefix rewriting is a
   * label change, not a hand edit, so `transcriptEdits` is left untouched.
   */
  async renameSpeaker(id, speakerId, name, options = {}) {
    const now = options.now ?? new Date()
    const label = typeof name === 'string' ? name.trim() : ''
    if (label === '') throw new Error('说话人名称不能为空')
    if (label.length > 40) throw new Error('说话人名称过长（最多 40 个字）')
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === id)
      if (meeting === undefined) {
        const error = new Error(`未找到会议：${id}`)
        error.status = 404
        throw error
      }
      const speaker = meeting.speakers.find((entry) => entry.id === speakerId)
      if (speaker === undefined) {
        const error = new Error(`未找到说话人：${speakerId}`)
        error.status = 404
        throw error
      }
      const previousLabel = speaker.label
      const nextLabel = label
      speaker.label = nextLabel
      meeting.transcript = replaceSpeakerPrefix(meeting.transcript, previousLabel, nextLabel)
      meeting.transcriptRaw = replaceSpeakerPrefix(meeting.transcriptRaw, previousLabel, nextLabel)
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }

  /** Replace one todo inside a meeting's summary (metadata edits only). */
  async patchTodo(meetingId, todoId, patch, options = {}) {
    const now = options.now ?? new Date()
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === meetingId)
      if (meeting === undefined || meeting.summary === null) throw new Error(`会议没有待办摘要：${meetingId}`)
      const todo = meeting.summary.todos.find((entry) => entry.id === todoId)
      if (todo === undefined) throw new Error(`未找到待办：${todoId}`)
      for (const key of ['title', 'owner', 'due', 'priority', 'notes']) {
        if (patch?.[key] !== undefined) todo[key] = String(patch[key]).trim()
      }
      if (!['high', 'normal', 'low'].includes(todo.priority)) todo.priority = 'normal'
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }

  /** Apply a summary produced by the LLM (or explicit repair). */
  async setSummary(meetingId, summary, options = {}) {
    const now = options.now ?? new Date()
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === meetingId)
      if (meeting === undefined) throw new Error(`未找到会议：${meetingId}`)
      meeting.summary = summary
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }

  /** Mark one todo as written to the calendar. */
  async markTodoPushed(meetingId, todoId, calendarTaskId, options = {}) {
    const now = options.now ?? new Date()
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === meetingId)
      if (meeting === undefined || meeting.summary === null) throw new Error(`会议没有待办摘要：${meetingId}`)
      const todo = meeting.summary.todos.find((entry) => entry.id === todoId)
      if (todo === undefined) throw new Error(`未找到待办：${todoId}`)
      todo.calendarTaskId = calendarTaskId
      todo.pushedAt = now.toISOString()
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }

  /** Remove one meeting; returns the removed record or null. */
  async remove(id) {
    let removed = null
    await this.update((doc) => {
      const index = doc.meetings.findIndex((meeting) => meeting.id === id)
      if (index === -1) return
      removed = doc.meetings[index]
      doc.meetings.splice(index, 1)
    })
    return removed
  }

  /** Append transcript text and add its audio duration. */
  async appendTranscript(id, text, audioSeconds, options = {}) {
    const now = options.now ?? new Date()
    const addition = typeof text === 'string' ? text.trim() : ''
    let updated = null
    await this.update((doc) => {
      const meeting = doc.meetings.find((entry) => entry.id === id)
      if (meeting === undefined) throw new Error(`未找到会议：${id}`)
      if (addition !== '') {
        meeting.transcript = meeting.transcript === '' ? addition : `${meeting.transcript}\n${addition}`
        // While nobody has hand-edited this meeting, the raw ASR text mirrors
        // the transcript; the first manual edit freezes it.
        if (Number(meeting.transcriptEdits) === 0) meeting.transcriptRaw = meeting.transcript
      }
      meeting.transcriptSeconds = Math.round((meeting.transcriptSeconds + Math.max(0, Number(audioSeconds) || 0)) * 10) / 10
      meeting.updatedAt = now.toISOString()
      updated = meeting
    })
    return updated
  }
}

/** Sort meetings newest first for the list projection. */
export function sortMeetings(meetings) {
  return [...meetings].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.updatedAt < b.updatedAt ? 1 : -1
  })
}

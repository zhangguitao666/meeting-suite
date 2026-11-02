/**
 * Pure meeting model for the meeting-minutes plugin.
 *
 * Everything here is deterministic and free of filesystem, Cordis, or clock
 * reads other than the explicit `now` argument, so the whole module is
 * unit-testable under plain Node.
 *
 * @module dsh-plugin-meeting-minutes/model
 */

/** Where a meeting's text came from. */
export const SOURCE_TYPES = ['text', 'recording', 'import']
/** Stable priority vocabulary, shared with the task-calendar plugin. */
export const PRIORITIES = ['high', 'normal', 'low']
/** Risk levels used by the summary card. */
export const RISK_LEVELS = ['low', 'medium', 'high']

/** Short collision-resistant id. */
export function newId(prefix = 'mt') {
  const stamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${stamp}${random}`
}

/** Local calendar day key (`YYYY-MM-DD`) for a Date. */
export function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Full local clock label (`YYYY-MM-DD HH:mm`), used in prompts and exports. */
export function formatMoment(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Trim to text, or the fallback when the value is empty. */
export function asText(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text === '' ? fallback : text
}

/** Cap a string without throwing, keeping the head. */
function capText(value, max) {
  const text = asText(value)
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Parse one meeting date. Accepts `YYYY-MM-DD`, `YYYY/MM/DD`,
 * `YYYY年M月D日`, or a Date; falls back to today's local day.
 * @param value - raw input.
 * @param now - reference moment.
 * @returns `YYYY-MM-DD`.
 */
export function parseMeetingDate(value, now = new Date()) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return localDay(value)
  const text = asText(value)
  if (text === '') return localDay(now)
  const normalized = text
    .replace(/[年/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\s+/g, '')
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized)
  if (match === null) return localDay(now)
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return localDay(now)
  const date = new Date(Number(match[1]), month - 1, day)
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return localDay(now)
  return localDay(date)
}

/** Normalize an attendee list from an array or one separated string. */
export function normalizeAttendees(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,，、;；\n]+/) : [])
  const seen = new Set()
  const list = []
  for (const entry of raw) {
    const name = capText(entry, 40)
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    list.push(name)
    if (list.length >= 40) break
  }
  return list
}

/**
 * Is this title just the automatic placeholder the recorder/importer created?
 * Generic titles are safe for the summarizer to replace with an AI-named title;
 * a title the user typed is never overwritten automatically.
 * @param title - current meeting title.
 */
export function isGenericTitle(title) {
  const text = asText(title)
  if (text === '' || text === '未命名会议') return true
  return /^(录音纪要|会议纪要|导入纪要|语音纪要|会议记录)\s*$/u.test(text)
    || /^(录音纪要|会议纪要|导入纪要|语音纪要|会议记录)\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(text)
    || /^(录音纪要|会议纪要|导入纪要|语音纪要|会议记录)\s+\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}/u.test(text)
}

/** Clamp an arbitrary number into `[min, max]`, with a fallback. */
function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Keep only a valid sha256 hex digest (64 lowercase hex chars), else `''`. */
function normalizeSha256(value) {
  const text = asText(value).toLowerCase()
  return /^[a-f0-9]{64}$/.test(text) ? text : ''
}

/** Normalize a tag-like string list. */
function textList(value, max, maxLength = 400) {
  if (!Array.isArray(value)) return []
  const list = []
  for (const entry of value) {
    const text = capText(entry, maxLength)
    if (text !== '') list.push(text)
    if (list.length >= max) break
  }
  return list
}

/** Normalize one todo produced by the model (before it gets an id). */
export function normalizeTodoInput(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const title = capText(input.title, 160)
  if (title === '') return null
  return {
    title,
    owner: capText(input.owner, 60),
    due: capText(input.due, 80),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
    notes: capText(input.notes, 800),
  }
}

/**
 * Normalize one complete todo, keeping the push bookkeeping of a matching
 * earlier todo so regenerating a summary never causes a duplicate calendar
 * entry for the same action item.
 * @param raw - model or stored todo.
 * @param previous - todos of the previous summary.
 */
function normalizeTodo(raw, previous = []) {
  const input = normalizeTodoInput(raw)
  if (input === null) return null
  const key = `${input.title}\u0000${input.owner}`
  const match = previous.find((todo) => `${todo.title}\u0000${todo.owner}` === key)
  return {
    id: asText(raw?.id, match?.id ?? newId('td')),
    title: input.title,
    owner: input.owner,
    due: input.due,
    priority: input.priority,
    notes: input.notes,
    calendarTaskId: match?.calendarTaskId ?? (typeof raw?.calendarTaskId === 'string' && raw.calendarTaskId !== '' ? raw.calendarTaskId : null),
    pushedAt: match?.pushedAt ?? (typeof raw?.pushedAt === 'string' ? raw.pushedAt : null),
  }
}

/**
 * Normalize a summary object from the model or the store.
 * @param raw - raw summary.
 * @param options - `previous` (previous summary for push-state carry-over),
 * `now` (reference moment), `model` (model id string).
 * @returns canonical summary, or null when `raw` is not an object.
 */
export function normalizeSummary(raw, options = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const now = options.now ?? new Date()
  const previous = Array.isArray(options.previous?.todos) ? options.previous.todos : []
  const rawTodos = Array.isArray(raw.todos) ? raw.todos : []
  const todos = []
  for (const entry of rawTodos) {
    const todo = normalizeTodo(entry, previous)
    if (todo !== null) todos.push(todo)
    if (todos.length >= 40) break
  }
  const decisions = []
  for (const entry of Array.isArray(raw.decisions) ? raw.decisions : []) {
    const text = typeof entry === 'string' ? capText(entry, 600) : capText(entry?.text, 600)
    if (text === '') continue
    decisions.push({ text, owner: typeof entry === 'object' ? capText(entry?.owner, 60) : '' })
    if (decisions.length >= 20) break
  }
  const risks = []
  for (const entry of Array.isArray(raw.risks) ? raw.risks : []) {
    const text = typeof entry === 'string' ? capText(entry, 600) : capText(entry?.text, 600)
    if (text === '') continue
    const level = typeof entry === 'object' && RISK_LEVELS.includes(entry?.level) ? entry.level : 'medium'
    risks.push({ text, level })
    if (risks.length >= 20) break
  }
  const sections = []
  for (const entry of Array.isArray(raw.sections) ? raw.sections : []) {
    if (entry === null || typeof entry !== 'object') continue
    const heading = capText(entry.heading, 120)
    const bullets = textList(entry.bullets, 20, 800)
    if (heading === '' && bullets.length === 0) continue
    sections.push({ heading: heading === '' ? '议题' : heading, bullets })
    if (sections.length >= 30) break
  }
  return {
    oneLine: capText(raw.oneLine, 240),
    overview: capText(raw.overview, 2400),
    keyPoints: textList(raw.keyPoints, 16, 600),
    decisions,
    risks,
    sections,
    suggestedTitle: capText(raw.suggestedTitle, 60),
    attendees: normalizeAttendees(raw.attendees),
    todos,
    generatedAt: typeof raw.generatedAt === 'string' && raw.generatedAt !== '' ? raw.generatedAt : now.toISOString(),
    model: asText(options.model, asText(raw.model, '')),
  }
}

/** Auto-ingest configuration defaults, persisted in the meeting document. */
export const DEFAULT_AUTO_INGEST = {
  enabled: true,
  tencent: true,
  dirs: [],
  ingested: {},
  failures: {},
  lastScanAt: null,
  lastError: null,
  importedCount: 0,
}

/** Normalize the persisted auto-ingest configuration and bookkeeping. */
export function normalizeAutoIngestConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const dirs = []
  for (const entry of Array.isArray(input.dirs) ? input.dirs : []) {
    const dir = capText(entry, 400)
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir)
    if (dirs.length >= 20) break
  }
  const ingested = {}
  if (input.ingested !== null && typeof input.ingested === 'object' && !Array.isArray(input.ingested)) {
    for (const [key, value] of Object.entries(input.ingested)) {
      if (typeof key !== 'string' || key === '' || key.length > 500) continue
      if (value === null || typeof value !== 'object') continue
      ingested[key] = {
        meetingId: asText(value.meetingId, ''),
        title: asText(value.title, ''),
        at: asText(value.at, ''),
        path: asText(value.path, ''),
      }
      if (Object.keys(ingested).length >= 500) break
    }
  }
  const failures = {}
  if (input.failures !== null && typeof input.failures === 'object' && !Array.isArray(input.failures)) {
    for (const [key, value] of Object.entries(input.failures)) {
      if (typeof key !== 'string' || key === '' || key.length > 500) continue
      failures[key] = {
        count: Number.isFinite(Number(value?.count)) ? Math.max(1, Math.min(20, Number(value.count))) : 1,
        message: capText(value?.message, 400),
        at: asText(value?.at, ''),
      }
      if (Object.keys(failures).length >= 200) break
    }
  }
  return {
    enabled: input.enabled !== false,
    tencent: input.tencent !== false,
    dirs,
    ingested,
    failures,
    lastScanAt: typeof input.lastScanAt === 'string' && input.lastScanAt !== '' ? input.lastScanAt : null,
    lastError: capText(input.lastError, 500) || null,
    importedCount: Number.isFinite(Number(input.importedCount)) ? Math.max(0, Math.trunc(Number(input.importedCount))) : 0,
  }
}

/**
 * Normalize one meeting from tool arguments, HTTP bodies, or disk.
 * @param raw - partial meeting.
 * @param options - `now` (Date), `base` (existing record to patch onto).
 * @returns canonical meeting, or throws when the title is missing.
 */
export function normalizeMeeting(raw, options = {}) {
  const now = options.now ?? new Date()
  const base = options.base ?? {}
  const input = raw !== null && typeof raw === 'object' ? raw : {}

  const title = capText(input.title, 200) || capText(base.title, 200)
  if (title === '') throw new Error('meeting.title is required (non-empty string)')

  const date = input.date === undefined
    ? asText(base.date, localDay(now))
    : parseMeetingDate(input.date, now)
  const attendees = input.attendees === undefined
    ? normalizeAttendees(base.attendees)
    : normalizeAttendees(input.attendees)
  const sourceType = SOURCE_TYPES.includes(input.sourceType)
    ? input.sourceType
    : (SOURCE_TYPES.includes(base.sourceType) ? base.sourceType : 'text')
  const transcript = input.transcript === undefined
    ? asText(base.transcript)
    : String(input.transcript ?? '')
  const transcriptSeconds = Math.round((
    input.transcriptSeconds === undefined
      ? clampNumber(base.transcriptSeconds, 0, 0, 24 * 3600)
      : clampNumber(input.transcriptSeconds, 0, 0, 24 * 3600)
  ) * 10) / 10
  const notes = input.notes === undefined ? asText(base.notes) : capText(input.notes, 4000)
  // Audio provenance: the retained copy is fingerprinted **before** transcription,
  // so a record still points at its source recording when ASR fails.
  const audioPath = capText(input.audioPath === undefined ? base.audioPath : input.audioPath, 600)
  const audioSha256 = normalizeSha256(input.audioSha256 === undefined ? base.audioSha256 : input.audioSha256)
  const audioBytes = Math.trunc(clampNumber(
    input.audioBytes === undefined ? base.audioBytes : input.audioBytes, 0, 0, 1024 ** 4,
  ))
  const audioSeconds = Math.round(clampNumber(
    input.audioSeconds === undefined ? base.audioSeconds : input.audioSeconds, 0, 0, 24 * 3600,
  ) * 10) / 10
  const audioOriginalName = capText(input.audioOriginalName === undefined ? base.audioOriginalName : input.audioOriginalName, 300)
  const audioPrunedAt = asText(input.audioPrunedAt === undefined ? base.audioPrunedAt : input.audioPrunedAt)
  const audioPinned = input.audioPinned === true || (input.audioPinned === undefined && base.audioPinned === true)
  const audioError = capText(input.audioError === undefined ? base.audioError : input.audioError, 400)
  const exportedAt = asText(input.exportedAt === undefined ? base.exportedAt : input.exportedAt)
  // Transcript revision: `transcriptRaw` keeps the untouched ASR output so a
  // hand-corrected `transcript` never loses the original wording; exports and
  // re-summaries use `transcript`, the audio sha256 is unaffected either way.
  const transcriptRawInput = input.transcriptRaw === undefined ? base.transcriptRaw : input.transcriptRaw
  const transcriptRaw = typeof transcriptRawInput === 'string' && transcriptRawInput !== ''
    ? transcriptRawInput
    : transcript
  const transcriptEditedAt = asText(input.transcriptEditedAt === undefined ? base.transcriptEditedAt : input.transcriptEditedAt)
  const transcriptEdits = Math.trunc(clampNumber(
    input.transcriptEdits === undefined ? base.transcriptEdits : input.transcriptEdits, 0, 0, 100000,
  ))
  const autoImported = input.autoImported === true || (input.autoImported === undefined && base.autoImported === true)
  const summaryInput = input.summary === undefined ? base.summary ?? null : input.summary
  const summary = summaryInput === null
    ? null
    : normalizeSummary(summaryInput, {
      now,
      previous: input.summary === undefined ? undefined : base.summary,
      model: asText(input.model, ''),
    })

  return {
    id: asText(input.id, asText(base.id, newId())),
    title,
    date,
    attendees,
    sourceType,
    transcript,
    transcriptSeconds,
    audioPath,
    audioSha256,
    audioBytes,
    audioSeconds,
    audioOriginalName,
    audioPrunedAt,
    audioPinned,
    audioError,
    exportedAt,
    transcriptRaw,
    transcriptEditedAt,
    transcriptEdits,
    notes,
    autoImported,
    summary,
    createdAt: asText(input.createdAt, asText(base.createdAt, now.toISOString())),
    updatedAt: asText(input.updatedAt, now.toISOString()),
  }
}

/** Compact list projection used by the sidebar/list and `GET /state`. */
export function projectMeeting(meeting) {
  const summary = meeting.summary
  const todos = summary?.todos ?? []
  return {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    attendees: [...meeting.attendees],
    sourceType: meeting.sourceType,
    hasSummary: summary !== null,
    todoCount: todos.length,
    pendingTodoCount: todos.filter((todo) => todo.calendarTaskId === null).length,
    transcriptChars: meeting.transcript.length,
    transcriptSeconds: meeting.transcriptSeconds,
    transcriptEdits: meeting.transcriptEdits,
    hasAudio: meeting.audioPath !== '',
    exportedAt: meeting.exportedAt,
    autoImported: meeting.autoImported === true,
    updatedAt: meeting.updatedAt,
  }
}

/**
 * Extract one JSON object from model output. Accepts fenced code blocks and
 * surrounding prose; returns `null` when no parseable object is present.
 * @param text - raw model output.
 */
export function parseSummaryJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let body = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  if (fence !== null) body = fence[1].trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const slice = body.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Count todos that still need pushing, for tool output. */
export function todoProgress(meeting) {
  const todos = meeting.summary?.todos ?? []
  const pushed = todos.filter((todo) => todo.calendarTaskId !== null).length
  return { total: todos.length, pushed, pending: todos.length - pushed }
}

/** One-line human label for a meeting. */
export function meetingLine(meeting) {
  const parts = [`[${meeting.id}] ${meeting.title}`, meeting.date]
  if (meeting.attendees.length > 0) parts.push(meeting.attendees.join('、'))
  parts.push(meeting.summary === null ? '未总结' : '已总结')
  const progress = todoProgress(meeting)
  if (progress.total > 0) parts.push(`待办 ${progress.pushed}/${progress.total} 已写入日历`)
  return parts.join(' · ')
}

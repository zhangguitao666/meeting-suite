/**
 * Automatic meeting ingest.
 *
 * Two local sources are watched, both read-only and opt-out:
 *
 * 1. **Tencent Meeting local recordings.** The macOS client keeps one SQLite
 *    table (`local_record_data`) describing every locally recorded meeting:
 *    title, meeting code, recording path, and end time. This module locates the
 *    table, and once a recording is complete and still on disk it transcribes
 *    the audio with the same local SenseVoice pipeline and stores the meeting
 *    ("待整理"), so nothing has to be exported by hand.
 * 2. **User-chosen folders.** New audio/video files, plain text/Markdown, and
 *    exported `.docx` minutes dropped into a configured directory are imported
 *    the same way (audio → transcript, text → meeting text).
 *
 * Cloud-side Tencent "智能纪要" has no personal API; without an enterprise
 * credential the reliable local path is the recording (or an exported file).
 * Everything here is persisted through the store, deduplicated by source key,
 * and retried at most three times per source.
 *
 * @module dsh-plugin-meeting-minutes/autoingest
 */

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

import { formatMoment, localDay } from './model.js'
import { pruneAudio, storeAudio } from './audio-store.js'

const execFileAsync = promisify(execFile)

/** macOS sqlite3 CLI (also present on Linux hosts). */
const SQLITE = '/usr/bin/sqlite3'

/** Audio/video extensions the browser pipeline can decode and the host can transcode. */
export const AUDIO_EXTENSIONS = ['.m4a', '.mp4', '.wav', '.mp3', '.aac', '.webm', '.mov', '.aiff', '.flac']

/** Text-ish extensions imported without transcription. */
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown']

/** How many files one scan may import (ASR is CPU-heavy). */
const MAX_FILES_PER_SCAN = 2
/** Ignore files larger than this; transcode/ASR would not be practical. */
const MAX_FILE_BYTES = 1.5 * 1024 * 1024 * 1024
/** Only auto-import sources newer than this. */
const RECENT_DAYS = 14
/** A file must be untouched for this long before it is considered finished. */
const STABLE_MS = 45_000
/** Poll cadence for the background scan. */
const SCAN_INTERVAL_MS = 30_000
/** A failed source is retried at most this many times. */
const MAX_ATTEMPTS = 3

/** Expand a leading `~` to the user's home directory. */
export function expandHome(path) {
  const text = String(path ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/** Is this path something the auto-importer understands? */
export function fileKind(path) {
  const ext = extname(String(path ?? '')).toLowerCase()
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  if (TEXT_EXTENSIONS.includes(ext) || ext === '.docx' || ext === '.json') return 'text'
  return null
}

/** Clean a filename into a plausible meeting title. */
export function titleFromFile(path) {
  const base = basename(String(path ?? '')).replace(/\.[^.]+$/, '').trim()
  return base === '' ? `录音纪要 ${formatMoment()}` : base.slice(0, 80)
}

/** Normalize one `local_record_data` row read from Tencent Meeting. */
export function normalizeTencentRow(row) {
  if (row === null || typeof row !== 'object') return null
  const path = expandHome(String(row.local_file_path ?? ''))
  if (path === '') return null
  const rawEnd = Number(row.record_end_time) || 0
  const rawStart = Number(row.start_record_time) || 0
  // Tencent writes epoch seconds; tolerate a millisecond variant as well.
  const toMs = (value) => (value > 1e12 ? value : value * 1000)
  const endMs = rawEnd > 0 ? toMs(rawEnd) : 0
  const startMs = rawStart > 0 ? toMs(rawStart) : 0
  const completed = Number(row.is_record_complete) === 1 || row.is_record_complete === true
  return {
    key: `tencent:${String(row.record_id ?? '') || path}`,
    path,
    title: String(row.record_title ?? '').trim(),
    meetingCode: String(row.meeting_code ?? '').trim(),
    endAt: endMs,
    startAt: startMs,
    completed,
    size: Number(row.total_size) || 0,
  }
}

/** Extract readable text from a Tencent/office JSON or plain export. */
export function extractTextPayload(raw) {
  const text = String(raw ?? '')
  const trimmed = text.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const found = deepText(parsed)
      if (found !== '') return found
    } catch {
      // Not JSON; fall through to the raw text.
    }
  }
  return text
}

/** Find the first large text field in a JSON export. */
function deepText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim().length > 20 ? value : ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepText(item, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const key of ['transcript', 'transcription', 'minutes', 'content', 'summary', 'text', 'sentences', 'paragraphs']) {
      if (key in value) {
        const found = deepText(value[key], depth + 1)
        if (found !== '') return found
      }
    }
    for (const child of Object.values(value)) {
      const found = deepText(child, depth + 1)
      if (found !== '') return found
    }
  }
  return ''
}

/** Extract `<w:t>` text from a docx's document.xml. */
export function docxXmlToText(xml) {
  return String(xml ?? '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The Tencent Meeting database directory inside the macOS app container. */
export function tencentDatabaseDirs() {
  const base = join(homedir(), 'Library/Containers/com.tencent.meeting/Data/Library')
  return [join(base, 'Global/Database'), join(base, 'Users')]
}

/**
 * Create the auto-ingest engine.
 * @param options - `store`, `asr`, `logger`.
 */
export function createAutoIngest(options) {
  const store = options.store
  const asr = options.asr
  const logger = options.logger

  const runtime = {
    scanning: false,
    pending: 0,
    tencent: { available: false, dbPath: null, records: 0, error: null },
    lastResult: null,
    timer: 0,
    stopped: false,
    dbPath: null,
    lastDbProbeAt: 0,
  }

  /** Read a SQLite database as JSON through the system CLI (read-only). */
  async function sqliteJson(dbPath, sql) {
    const { stdout } = await execFileAsync(SQLITE, ['-json', `file:${dbPath}?mode=ro`, sql], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const text = String(stdout ?? '').trim()
    if (text === '') return []
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  }

  /** Find the database that owns `local_record_data` (cached). */
  async function findTencentDb(force = false) {
    if (!force && runtime.dbPath !== null) return runtime.dbPath
    if (!force && Date.now() - runtime.lastDbProbeAt < 60_000) return runtime.dbPath
    runtime.lastDbProbeAt = Date.now()
    const candidates = []
    for (const dir of tencentDatabaseDirs()) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.db')) candidates.push(join(dir, entry.name))
          else if (entry.isDirectory() && dir.endsWith('Users')) {
            try {
              const inner = join(dir, entry.name, 'Database')
              for (const child of await readdir(inner, { withFileTypes: true })) {
                if (child.isFile() && child.name.endsWith('.db')) candidates.push(join(inner, child.name))
              }
            } catch {
              // A user directory without a Database folder is normal.
            }
          }
        }
      } catch {
        // The app may not be installed for this user.
      }
    }
    for (const db of candidates) {
      try {
        const rows = await sqliteJson(db, "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='local_record_data'")
        const present = Number(rows?.[0]?.n) > 0
        if (present) {
          runtime.dbPath = db
          return db
        }
      } catch {
        // Unreadable/encrypted databases are skipped; another one may match.
      }
    }
    runtime.dbPath = null
    return null
  }

  /** Read the Tencent local-recording catalogue. */
  async function listTencentRecords() {
    const db = await findTencentDb()
    if (db === null) {
      runtime.tencent = { available: false, dbPath: null, records: 0, error: '未找到腾讯会议本地录制数据库' }
      return []
    }
    try {
      const rows = await sqliteJson(db, [
        'SELECT record_id, record_title, local_file_path, meeting_code,',
        'record_end_time, start_record_time, total_size, is_record_complete',
        'FROM local_record_data',
        'WHERE is_record_complete = 1 AND local_file_path IS NOT NULL AND local_file_path <> ""',
        'ORDER BY record_end_time DESC LIMIT 40',
      ].join(' '))
      const records = rows.map(normalizeTencentRow).filter((row) => row !== null && row.completed)
      runtime.tencent = { available: true, dbPath: db, records: records.length, error: null }
      return records
    } catch (error) {
      runtime.tencent = {
        available: true,
        dbPath: db,
        records: 0,
        error: `读取腾讯会议录制列表失败：${error instanceof Error ? error.message : String(error)}`,
      }
      return []
    }
  }

  /** Has this source already been imported (or failed too often)? */
  function alreadyHandled(config, key) {
    if (config.ingested[key] !== undefined) return true
    const failure = config.failures[key]
    return failure !== undefined && Number(failure.count) >= MAX_ATTEMPTS
  }

  /** Create one meeting from transcribed/imported text. */
  async function storeIngested({ key, title, date, transcript, seconds, notes, sourceType, audio = null }) {
    const meeting = await store.add({
      title,
      date,
      attendees: [],
      transcript,
      transcriptSeconds: seconds,
      notes,
      sourceType,
      autoImported: true,
      audioPath: audio === null ? '' : audio.relPath,
      audioSha256: audio === null ? '' : audio.sha256,
      audioBytes: audio === null ? 0 : audio.bytes,
      audioSeconds: seconds,
      audioOriginalName: audio === null ? '' : audio.fileName,
    })
    await store.markAutoIngested(key, { meetingId: meeting.id, title: meeting.title, path: notes })
    logger?.info?.(`meeting-minutes: auto-ingested ${key} as ${meeting.id}`)
    return meeting
  }

  /** Import one audio/video/text source; failures are recorded per source. */
  async function ingestSource({ key, path, title, date, notePrefix }) {
    try {
      const info = await stat(path)
      if (!info.isFile()) return null
      if (info.size > MAX_FILE_BYTES) throw new Error(`文件过大（${Math.round(info.size / 1024 / 1024)}MB），未自动转写`)
      const kind = fileKind(path)
      if (kind === null) return null
      const isFresh = Date.now() - info.mtimeMs < STABLE_MS
      if (isFresh) return null

      if (kind === 'audio') {
        // Retain the copy (and its sha256) before ASR: the same recording is
        // recognised even when it arrives again from another folder.
        const bytes = await readFile(path)
        let audio = null
        try {
          audio = await storeAudio({
            bytes,
            sourceName: path,
            title: title || titleFromFile(path),
            date: date || localDay(new Date(info.mtimeMs)),
          })
        } catch (error) {
          logger?.warn?.(`meeting-minutes: 音频副本保存失败（${path}）：${error instanceof Error ? error.message : String(error)}`)
        }
        if (audio !== null) {
          const existing = store.findByAudioSha256(audio.sha256)
          if (existing !== null) {
            // Same bytes already in the library: skip silently, remember the source.
            await store.markAutoIngested(key, { meetingId: existing.id, title: existing.title, path }, { count: false })
            logger?.info?.(`meeting-minutes: 同一录音已在 ${existing.id}，跳过 ${path}`)
            return null
          }
        }
        const result = await asr.transcribeFile(path, { language: 'zh' })
        if (result.text.trim() === '') throw new Error('音频没有识别出文字')
        const notes = `${notePrefix}\n文件：${path}${audio === null ? '' : `\n音频副本：${audio.relPath}`}`
        return await storeIngested({
          key,
          title: title || titleFromFile(path),
          date: date || localDay(new Date(info.mtimeMs)),
          transcript: result.text,
          seconds: result.audioSeconds,
          notes,
          sourceType: 'recording',
          audio,
        })
      }

      let text = ''
      const ext = extname(path).toLowerCase()
      if (ext === '.docx') {
        const { stdout } = await execFileAsync('/usr/bin/unzip', ['-p', path, 'word/document.xml'], {
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        text = docxXmlToText(stdout)
      } else {
        text = extractTextPayload(await readFile(path, 'utf8'))
      }
      if (text.trim() === '') throw new Error('文件没有可导入的文字')
      return await storeIngested({
        key,
        title: title || titleFromFile(path),
        date: date || localDay(new Date(info.mtimeMs)),
        transcript: text,
        seconds: 0,
        notes: `${notePrefix}\n文件：${path}`,
        sourceType: 'import',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`meeting-minutes: auto-ingest failed for ${path}: ${message}`)
      await store.markAutoFailure(key, message)
      runtime.lastResult = { ok: false, error: message, path }
      return null
    }
  }

  /** Import finished Tencent local recordings. */
  async function scanTencent(config, budget) {
    if (config.tencent === false) return budget
    const records = await listTencentRecords()
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000
    for (const record of records) {
      if (budget <= 0) break
      if (record.endAt > 0 && record.endAt < cutoff) continue
      if (alreadyHandled(config, record.key)) continue
      const date = record.endAt > 0 ? localDay(new Date(record.endAt)) : localDay()
      const notePrefix = [
        '自动导入：腾讯会议本地录制',
        record.meetingCode === '' ? '' : `会议号：${record.meetingCode}`,
        record.endAt > 0 ? `录制结束：${formatMoment(new Date(record.endAt))}` : '',
      ].filter((line) => line !== '').join('\n')
      const meeting = await ingestSource({
        key: record.key,
        path: record.path,
        title: record.title,
        date,
        notePrefix,
      })
      if (meeting !== null) budget -= 1
      // The in-memory config is stale after each store write; refresh it.
      config = store.autoIngest
    }
    return budget
  }

  /** Import new files from the configured folders (two levels deep). */
  async function scanDirs(config, budget) {
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000
    for (const rawDir of config.dirs) {
      if (budget <= 0) break
      const dir = expandHome(rawDir)
      const files = []
      const walk = async (current, depth) => {
        let entries
        try {
          entries = await readdir(current, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            if (depth < 1) await walk(full, depth + 1)
            continue
          }
          if (!entry.isFile()) continue
          if (fileKind(full) === null) continue
          files.push(full)
        }
      }
      await walk(dir, 0)
      for (const path of files) {
        if (budget <= 0) break
        let info
        try {
          info = await stat(path)
        } catch {
          continue
        }
        if (info.mtimeMs < cutoff) continue
        const key = `dir:${path}`
        if (alreadyHandled(config, key)) continue
        const meeting = await ingestSource({
          key,
          path,
          title: '',
          date: '',
          notePrefix: '自动导入：监控目录',
        })
        if (meeting !== null) budget -= 1
        config = store.autoIngest
      }
    }
    return budget
  }

  /** Run one scan now; concurrent calls share a single pass. */
  async function scanNow() {
    if (runtime.scanning || runtime.stopped) return status()
    const config = store.autoIngest
    if (config.enabled === false) return status()
    runtime.scanning = true
    runtime.pending = 0
    try {
      let budget = await scanTencent(config, MAX_FILES_PER_SCAN)
      budget = await scanDirs(store.autoIngest, budget)
      await store.noteAutoScan({ lastScanAt: new Date().toISOString(), lastError: null })
      // Retention rides on the existing poll instead of a second timer.
      try {
        const pruned = await pruneAudio({ store, logger })
        if (pruned.removed.length > 0) {
          logger?.info?.(`meeting-minutes: 清理音频副本 ${pruned.removed.length} 个（释放 ${Math.round(pruned.freedBytes / 1024 / 1024)}MB）`)
        }
      } catch (error) {
        logger?.warn?.(`meeting-minutes: 音频副本清理失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await store.noteAutoScan({ lastScanAt: new Date().toISOString(), lastError: message })
      runtime.lastResult = { ok: false, error: message }
      logger?.warn?.(`meeting-minutes: auto-ingest scan failed: ${message}`)
    } finally {
      runtime.scanning = false
      runtime.pending = 0
    }
    return status()
  }

  /** Public status projection for the panel and `GET /state`. */
  function status() {
    const config = store.autoIngest
    const recent = Object.entries(config.ingested)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 5)
    return {
      enabled: config.enabled,
      tencent: config.tencent,
      dirs: [...config.dirs],
      tencentAvailable: runtime.tencent.available,
      tencentDbPath: runtime.tencent.dbPath,
      tencentRecords: runtime.tencent.records,
      tencentError: runtime.tencent.error,
      scanning: runtime.scanning,
      pending: runtime.pending,
      lastScanAt: config.lastScanAt,
      lastError: config.lastError,
      importedCount: config.importedCount,
      failedCount: Object.keys(config.failures).length,
      recent,
    }
  }

  /** Merge a configuration patch and persist it. */
  async function setConfig(patch) {
    const next = {}
    if (patch?.enabled !== undefined) next.enabled = patch.enabled !== false
    if (patch?.tencent !== undefined) next.tencent = patch.tencent !== false
    if (Array.isArray(patch?.dirs)) next.dirs = patch.dirs.map((dir) => String(dir).trim()).filter((dir) => dir !== '')
    await store.setAutoIngest(next)
    return status()
  }

  /** Start the background poll; returns a disposer. */
  function start() {
    runtime.stopped = false
    const tick = () => {
      void scanNow().catch(() => {})
    }
    runtime.timer = setInterval(tick, SCAN_INTERVAL_MS)
    if (typeof runtime.timer.unref === 'function') runtime.timer.unref()
    const kick = setTimeout(tick, 4_000)
    if (typeof kick.unref === 'function') kick.unref()
    return () => {
      runtime.stopped = true
      if (runtime.timer) clearInterval(runtime.timer)
      runtime.timer = 0
      clearTimeout(kick)
    }
  }

  return { status, setConfig, scanNow, start }
}

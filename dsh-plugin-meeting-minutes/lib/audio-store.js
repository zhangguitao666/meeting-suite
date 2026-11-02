/**
 * Audio provenance store for the meeting-minutes plugin.
 *
 * Every recording that enters the pipeline is copied into
 * `$DSH_HOME/meeting-minutes/audio/` and fingerprinted with sha256 **before** it
 * is transcribed, so a minutes entry can always be traced back to the exact file
 * it came from — even when transcription itself fails.
 *
 * The audio folder shares its parent directory with `exports/` (both derive from
 * `resolveMeetingDataDir` in export.js), so backing up or migrating the plugin
 * data directory never splits the two. Records persist the path **relative to
 * `$DSH_HOME`**, so a moved data directory keeps working.
 *
 * Retention: newest `keepCount` files, at most `maxTotalBytes` in total, nothing
 * older than `maxAgeDays`. Deletion prefers entries that already produced
 * minutes and were exported; recordings without minutes are removed last, and a
 * pinned entry is never removed.
 *
 * @module dsh-plugin-meeting-minutes/audio-store
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { concatWavPcm16, secondsOf } from './audio.js'
import { localDay } from './model.js'
import { resolveDshHome, resolveMeetingDataDir, safeFileName } from './export.js'

/** Extensions stored verbatim; anything else is normalised to `.wav`. */
const KEEP_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.mp4', '.aac', '.caf', '.aiff', '.flac', '.webm', '.mov'])

/**
 * Default retention policy for audio copies.
 * 16 kHz mono PCM16 is 32 KB/s (≈115 MB/hour), so 5 GB ≈ 43 recorded hours.
 */
export const DEFAULT_AUDIO_POLICY = {
  /** Newest N copies always survive. */
  keepCount: 30,
  /** Hard ceiling for the audio folder (5 GB). */
  maxTotalBytes: 5 * 1024 * 1024 * 1024,
  /** Copies older than this many days are removed. */
  maxAgeDays: 60,
  /** Copies with no meeting record (a failed manual attempt) are swept later. */
  orphanMaxAgeDays: 7,
}

/** sha256 of raw bytes, as lowercase hex. */
export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** sha256 of one file on disk, as lowercase hex. */
export async function sha256File(path) {
  return sha256Bytes(await readFile(path))
}

/** Folder holding retained audio copies. */
export function resolveAudioDir(home) {
  return join(resolveMeetingDataDir(home), 'audio')
}

/**
 * Reject anything that is not a plain relative path below the audio folder:
 * absolute paths and `..` segments never resolve.
 */
function normalizeRelativeAudio(relPath) {
  const text = String(relPath ?? '').replaceAll('\\', '/').trim()
  if (text === '' || text.startsWith('/') || text.split('/').includes('..')) return ''
  return text
}

/**
 * Absolute path of one stored copy.
 * @param relPath - record value such as `meeting-minutes/audio/2026-10-27-x.wav`.
 * @param home - override for `$DSH_HOME` (tests).
 * @returns absolute path, or `''` when the record value is unusable.
 */
export function resolveStoredAudio(relPath, home) {
  const clean = normalizeRelativeAudio(relPath)
  return clean === '' ? '' : join(home ?? resolveDshHome(), clean)
}

/** Pick the extension a copy is stored with. */
export function audioExtension(sourceName) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(sourceName ?? '').trim())
  const ext = match === null ? '' : `.${match[1].toLowerCase()}`
  return KEEP_EXTENSIONS.has(ext) ? ext : '.wav'
}

/**
 * Find an already-retained copy whose bytes are identical.
 *
 * Scans the audio folder for any supported extension named `-<sha8><ext>` and
 * re-reads the candidate to confirm the **full** digest: the 8-character suffix
 * alone is not proof, a colliding or hand-written name must not be trusted.
 *
 * @returns the same shape as `storeAudio`, or `null` when no copy matches.
 */
async function findStoredByHash(dir, sha256) {
  const short = sha256.slice(0, 8)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot).toLowerCase()
    if (!KEEP_EXTENSIONS.has(ext) || !name.endsWith(`-${short}${ext}`)) continue
    const absPath = join(dir, name)
    try {
      if (await sha256File(absPath) !== sha256) continue
    } catch {
      continue
    }
    return {
      relPath: `meeting-minutes/audio/${name}`,
      absPath,
      fileName: name,
      sha256,
      format: ext.slice(1),
      existed: true,
    }
  }
  return null
}

/**
 * Persist one recording copy and fingerprint its bytes.
 *
 * @param options - `bytes` (required), `sourceName`, `title`, `date`, `home`.
 * @returns `{ relPath, absPath, fileName, sha256, bytes, format, existed }`
 *          where `relPath` is relative to `$DSH_HOME`.
 */
export async function storeAudio(options = {}) {
  if (options.bytes === undefined || options.bytes === null) throw new Error('storeAudio 需要 bytes')
  const buffer = Buffer.isBuffer(options.bytes) ? options.bytes : Buffer.from(options.bytes)
  const sha256 = sha256Bytes(buffer)
  const date = typeof options.date === 'string' && options.date.trim() !== '' ? options.date.trim() : localDay()
  const title = safeFileName(options.title, '录音')
  const ext = audioExtension(options.sourceName)
  const dir = resolveAudioDir(options.home)
  await mkdir(dir, { recursive: true })
  // The same recording may arrive again under another title (a copied or renamed
  // file): reuse the retained copy instead of writing the bytes a second time.
  const reused = await findStoredByHash(dir, sha256)
  if (reused !== null) return { ...reused, bytes: buffer.length }
  const fileName = `${date}-${title}-${sha256.slice(0, 8)}${ext}`
  const absPath = join(dir, fileName)
  const relPath = `meeting-minutes/audio/${fileName}`
  let existed = false
  try {
    await stat(absPath)
    existed = true
  } catch {
    existed = false
  }
  if (!existed) await writeFile(absPath, buffer)
  return { relPath, absPath, fileName, sha256, bytes: buffer.length, format: ext.slice(1), existed }
}

/**
 * Verify that a stored copy still matches the fingerprint in its record.
 *
 * @param meeting - canonical meeting.
 * @param options - `home` override (tests).
 * @returns `{ ok, expected, actual, path, reason }`.
 */
export async function verifyStoredAudio(meeting, options = {}) {
  const expected = String(meeting?.audioSha256 ?? '').toLowerCase()
  const path = resolveStoredAudio(meeting?.audioPath, options.home)
  if (path === '') return { ok: false, expected, actual: '', path: '', reason: 'no-audio' }
  try {
    const actual = await sha256File(path)
    return { ok: actual === expected, expected, actual, path, reason: actual === expected ? 'match' : 'mismatch' }
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'missing' : String(error?.message ?? error)
    return { ok: false, expected, actual: '', path, reason }
  }
}

/** Removal priority of one copy: lower is removed first. */
function removalTier(entry) {
  if (entry.meetingId === null) return 3
  if (entry.exported) return 0
  if (entry.hasSummary) return 1
  return 2
}

/**
 * Apply the retention policy to the audio folder.
 *
 * Deletion order: exported+summarised → summarised → no minutes → orphan file;
 * inside one tier the oldest copy goes first. Pinned copies are never removed.
 * Every removed copy whose meeting still exists gets `audioPrunedAt` stamped, so
 * the sha256 fingerprint survives even after the bytes are gone.
 *
 * @param options - `store` (optional, for lookups and stamps), `home`, `policy`, `now`, `logger`.
 * @returns `{ removed: [{ fileName, meetingId, reason, bytes }], freedBytes, totalBytes, count }`.
 */
export async function pruneAudio(options = {}) {
  const store = options.store
  const policy = { ...DEFAULT_AUDIO_POLICY, ...(options.policy ?? {}) }
  const now = options.now ?? new Date()
  const dir = resolveAudioDir(options.home)

  let names
  try {
    names = (await readdir(dir)).filter((name) => !name.startsWith('.'))
  } catch {
    return { removed: [], freedBytes: 0, totalBytes: 0, count: 0 }
  }

  const meetings = store === undefined ? [] : store.snapshot().meetings
  const byFileName = new Map()
  for (const meeting of meetings) {
    const rel = normalizeRelativeAudio(meeting.audioPath)
    if (rel === '') continue
    byFileName.set(rel.split('/').pop(), meeting)
  }

  const entries = []
  for (const name of names) {
    let info
    try {
      info = await stat(join(dir, name))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const meeting = byFileName.get(name) ?? null
    entries.push({
      name,
      size: info.size,
      mtimeMs: info.mtimeMs,
      meetingId: meeting === null ? null : meeting.id,
      hasSummary: meeting !== null && meeting.summary !== null,
      exported: meeting !== null && meeting.exportedAt !== '',
      pinned: meeting !== null && meeting.audioPinned === true,
    })
  }

  const remove = new Map()
  const candidates = entries
    .filter((entry) => !entry.pinned)
    .sort((a, b) => (removalTier(a) - removalTier(b)) || (a.mtimeMs - b.mtimeMs))

  const ageCutoff = now.getTime() - policy.maxAgeDays * 86_400_000
  const orphanCutoff = now.getTime() - policy.orphanMaxAgeDays * 86_400_000
  for (const entry of candidates) {
    if (entry.mtimeMs < ageCutoff) remove.set(entry.name, 'expired')
    else if (removalTier(entry) === 3 && entry.mtimeMs < orphanCutoff) remove.set(entry.name, 'orphan')
  }

  const remaining = candidates.filter((entry) => !remove.has(entry.name))
  let totalBytes = remaining.reduce((sum, entry) => sum + entry.size, 0)
  let count = remaining.length
  for (const entry of remaining) {
    if (count <= policy.keepCount && totalBytes <= policy.maxTotalBytes) break
    const reason = count > policy.keepCount ? 'count' : 'size'
    remove.set(entry.name, reason)
    totalBytes -= entry.size
    count -= 1
  }

  const removed = []
  for (const [name, reason] of remove) {
    const entry = entries.find((candidate) => candidate.name === name)
    try {
      await unlink(join(dir, name))
    } catch {
      continue
    }
    removed.push({ fileName: name, meetingId: entry?.meetingId ?? null, reason, bytes: entry?.size ?? 0 })
    if (entry !== null && entry !== undefined && entry.meetingId !== null && store !== undefined) {
      try {
        await store.patch(entry.meetingId, { audioPrunedAt: now.toISOString() })
      } catch (error) {
        options.logger?.warn?.(`meeting-minutes: 无法标记音频副本清理（${entry.meetingId}）：${String(error?.message ?? error)}`)
      }
    }
  }

  return {
    removed,
    freedBytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
    totalBytes,
    count,
  }
}

/** Sanitised per-session folder name for the live-recording slices. */
function partsDirName(meetingId) {
  const clean = String(meetingId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  if (clean === '') throw new Error('会议 id 不能为空')
  return clean
}

/**
 * Temporary folder for one live recording's slices
 * (`meeting-minutes/audio/.sessions/<meetingId>/`).
 * The leading dot keeps it out of the retained-copy listing and `pruneAudio`.
 */
export function resolveAudioPartsDir(meetingId, home) {
  return join(resolveAudioDir(home), '.sessions', partsDirName(meetingId))
}

/**
 * Persist one live ASR slice.
 *
 * Live recording streams ~5 s slices to `/transcribe` only for recognition; the
 * slice itself is **not** a retained copy. Keeping the raw slices lets
 * {@link finalizeAudioParts} rebuild one full-meeting WAV at stop time, so the
 * record holds a single `audioPath` + whole-meeting sha256 instead of hundreds
 * of orphan fragments.
 *
 * @param options - `meetingId` (required), `index`, `bytes` (required), `home`.
 * @returns `{ partPath, bytes }`.
 */
export async function storeAudioPart(options = {}) {
  if (options.bytes === undefined || options.bytes === null) throw new Error('storeAudioPart 需要 bytes')
  const buffer = Buffer.isBuffer(options.bytes) ? options.bytes : Buffer.from(options.bytes)
  const dir = resolveAudioPartsDir(options.meetingId, options.home)
  await mkdir(dir, { recursive: true })
  const index = Math.max(0, Math.trunc(Number(options.index) || 0))
  const fileName = `${String(index).padStart(6, '0')}.wav`
  const partPath = join(dir, fileName)
  await writeFile(partPath, buffer)
  return { partPath, bytes: buffer.length }
}

/**
 * Merge every slice of one live recording into a single retained copy.
 *
 * @param options - `meetingId` (required), `title`, `date`, `home`.
 * @returns `{ relPath, absPath, fileName, sha256, bytes, format, existed, seconds, parts }`
 *          where `seconds` is the whole-meeting duration.
 * @throws when the meeting has no pending slices.
 */
export async function finalizeAudioParts(options = {}) {
  const dir = resolveAudioPartsDir(options.meetingId, options.home)
  let names
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.wav')).sort()
  } catch {
    throw new Error('这场会议没有待合并的录音片段')
  }
  if (names.length === 0) throw new Error('这场会议没有待合并的录音片段')
  const parts = []
  for (const name of names) parts.push(await readFile(join(dir, name)))
  const merged = concatWavPcm16(parts)
  const audio = await storeAudio({
    bytes: merged,
    sourceName: '',
    title: options.title,
    date: options.date,
    home: options.home,
  })
  const seconds = Math.round(secondsOf(merged) * 10) / 10
  await clearAudioParts({ meetingId: options.meetingId, home: options.home })
  return { ...audio, seconds, parts: names.length }
}

/** Drop the temporary slices (cancel, meeting delete, or after finalize). */
export async function clearAudioParts(options = {}) {
  await rm(resolveAudioPartsDir(options.meetingId, options.home), { recursive: true, force: true })
}

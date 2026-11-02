/**
 * Local HTTP surface for the meeting-minutes plugin's browser half.
 *
 * The panel is a hand-written client bundle: it cannot use the generated Typert
 * Remote channel (that assembly is fixed at build time), so the host half claims
 * one prefix route on `ctx.webServer` and the bundle talks to it with plain
 * `fetch`. Everything is loopback-only, same-origin, and JSON in/JSON out — the
 * transcription route is the single binary exception (canonical 16kHz WAV).
 *
 * @module dsh-plugin-meeting-minutes/server
 */

import { readFile } from 'node:fs/promises'

import { formatMoment, isGenericTitle, localDay, projectMeeting, todoProgress } from './model.js'
import { defaultSpeakerLabel, sortMeetings } from './store.js'
import { exportMeeting } from './export.js'
import { resolveStoredAudio, clearAudioParts, finalizeAudioParts, storeAudio, storeAudioPart } from './audio-store.js'
import {
  clearLiveSession,
  clearStopRequest,
  listLiveSessions,
  listStopRequests,
  requestStop,
  touchLiveSession,
} from './live-sessions.js'

/** Registered prefix; the client builds its URLs from the same constant. */
export const ROUTE_PREFIX = '/dsh-meeting'

/** Fields an HTTP write may set (the store normalizes every one of them). */
const WRITABLE_FIELDS = [
  'title', 'date', 'attendees', 'transcript', 'notes', 'sourceType', 'transcriptSeconds',
  'audioPath', 'audioSha256', 'audioBytes', 'audioSeconds', 'audioOriginalName',
  'audioPrunedAt', 'audioPinned', 'audioError', 'exportedAt',
  'transcriptRaw', 'transcriptEditedAt', 'transcriptEdits',
]

/** Audio provenance fields that may be written when a meeting is created. */
const AUDIO_FIELDS = [
  'audioPath', 'audioSha256', 'audioBytes', 'audioSeconds', 'audioOriginalName', 'audioPinned',
]

/** JSON response helper. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a JSON request body (bounded). */
async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object')
    return parsed
  } catch (error) {
    throw new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`)
  }
}

/** Read a raw binary body (bounded). */
async function readRawBody(req, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`音频片段过大（超过 ${Math.round(limit / 1024 / 1024)}MB），请缩短切片长度。`)
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** Only the loopback interface may reach these routes. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Build the `/state` payload the panel renders. */
export async function buildState(deps) {
  const { store, asr, summarizer, calendar, autoIngest, speakerTagger } = deps
  await store.load()
  const [speech, calendarStatus] = await Promise.all([
    Promise.resolve().then(() => asr.status()),
    calendar.status(),
  ])
  const meetings = sortMeetings(store.snapshot().meetings).map((meeting) => projectMeeting(meeting))
  const auto = autoIngest?.status?.() ?? null
  const totals = meetings.reduce((acc, meeting) => {
    acc.meetings += 1
    acc.todos += meeting.todoCount
    acc.pendingTodos += meeting.pendingTodoCount
    acc.summarized += meeting.hasSummary ? 1 : 0
    return acc
  }, { meetings: 0, todos: 0, pendingTodos: 0, summarized: 0 })
  return {
    ok: true,
    now: new Date().toISOString(),
    today: localDay(),
    clock: formatMoment(),
    autoIngest: auto,
    speakers: typeof speakerTagger?.status === 'function' ? speakerTagger.status() : null,
    activeRecording: listLiveSessions(),
    stopRequested: listStopRequests(),
    config: {
      llm: summarizer.describeRoute(),
      asr: {
        mode: speech.available ? 'local' : 'unavailable',
        providerId: speech.selection?.providerId ?? null,
        language: speech.selection?.language ?? 'zh',
      },
    },
    speech,
    calendar: calendarStatus,
    totals,
    meetings,
    storeFile: store.file,
  }
}

/** Resolve one meeting id from route segments, or throw a 404-shaped error. */
function requireMeeting(store, id) {
  const meeting = store.get(id)
  if (meeting === null) {
    const error = new Error(`未找到会议：${id}`)
    error.status = 404
    throw error
  }
  return meeting
}


/**
 * Tag one live slice with the speaker it most likely belongs to.
 *
 * The label is prefixed as `说话人2：文本` (full-width colon, no space). A label
 * the user already renamed wins over the registry's default, and a newly seen
 * speaker is durably added to `meeting.speakers` so the panel can list it.
 * Any failure here degrades to plain text — transcription must never fail
 * because voiceprint identification did.
 *
 * @returns `{ text, speaker }`, `speaker` is null when no tag was applied.
 */
async function tagLiveText(deps, meetingId, bytes, text) {
  const { store, speakerTagger, logger } = deps
  if (typeof text !== 'string' || text.trim() === '') return { text, speaker: null }
  if (speakerTagger === undefined || speakerTagger === null || typeof speakerTagger.identify !== 'function') {
    return { text, speaker: null }
  }
  let tagged = null
  try {
    tagged = await speakerTagger.identify(bytes, { meetingId })
  } catch (error) {
    logger?.warn?.(`meeting-minutes: 说话人识别失败（${meetingId}）：${String(error?.message ?? error)}`)
    return { text, speaker: null }
  }
  if (tagged === null || tagged === undefined || typeof tagged.id !== 'string' || tagged.id === '') {
    return { text, speaker: null }
  }
  let label = typeof tagged.label === 'string' && tagged.label.trim() !== ''
    ? tagged.label.trim().slice(0, 40)
    : defaultSpeakerLabel(tagged.id)
  const known = store.get(meetingId)?.speakers?.find((entry) => entry.id === tagged.id) ?? null
  if (known !== null) {
    // Renaming a speaker mid-meeting must also relabel the following slices.
    label = known.label
  } else {
    try {
      await store.addSpeaker(meetingId, { id: tagged.id, label })
    } catch (error) {
      logger?.warn?.(`meeting-minutes: 记录说话人失败（${meetingId}/${tagged.id}）：${String(error?.message ?? error)}`)
    }
  }
  return { text: `${label}：${text}`, speaker: { id: tagged.id, label } }
}

/**
 * Register the plugin's routes.
 * @param ctx - Cordis context carrying `webServer`.
 * @param deps - `store`, `asr`, `summarizer`, `calendar`, `autoIngest`, `logger`.
 * @returns a disposer removing the route.
 */
export function registerRoutes(ctx, deps) {
  const { store, asr, summarizer, calendar, autoIngest, logger } = deps

  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const rest = path.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment))
      const method = req.method ?? 'GET'
      await store.load()

      if (segments.length === 1 && segments[0] === 'health') {
        sendJson(res, 200, { ok: true, plugin: 'dsh-plugin-meeting-minutes', file: store.file })
        return
      }

      if (segments.length === 1 && segments[0] === 'state' && method === 'GET') {
        sendJson(res, 200, await buildState(deps))
        return
      }

      if (segments.length === 2 && segments[0] === 'speech' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, speech: asr.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'speech' && segments[1] === 'prepare' && method === 'POST') {
        const body = await readJsonBody(req)
        asr.prepare(body.providerId)
        sendJson(res, 200, { ok: true, speech: asr.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'status' && method === 'GET') {
        sendJson(res, 200, { ok: true, autoIngest: autoIngest === undefined ? null : autoIngest.status() })
        return
      }

      if (segments.length === 2 && segments[0] === 'auto-ingest' && segments[1] === 'scan' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动入库不可用')
        void autoIngest.scanNow().catch((error) => logger?.warn?.(error))
        sendJson(res, 200, { ok: true, autoIngest: autoIngest.status() })
        return
      }

      if (segments.length === 1 && segments[0] === 'auto-ingest' && method === 'POST') {
        if (autoIngest === undefined) throw new Error('自动入库不可用')
        const body = await readJsonBody(req)
        const autoIngestStatus = await autoIngest.setConfig({
          ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          ...(body.tencent === undefined ? {} : { tencent: body.tencent }),
          ...(Array.isArray(body.dirs) ? { dirs: body.dirs } : {}),
        })
        sendJson(res, 200, { ok: true, autoIngest: autoIngestStatus })
        return
      }

      if (segments.length === 1 && segments[0] === 'meetings' && method === 'POST') {
        const body = await readJsonBody(req)
        const meeting = await store.add({
          title: body.title,
          date: body.date,
          attendees: body.attendees,
          sourceType: body.sourceType,
          transcript: body.transcript,
          notes: body.notes,
          ...Object.fromEntries(AUDIO_FIELDS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])),
        })
        sendJson(res, 200, { ok: true, meeting })
        return
      }

      if (segments[0] !== 'meetings' || segments.length < 2) {
        sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
        return
      }

      const id = segments[1]


      if (segments.length === 3 && segments[2] === 'speakers' && method === 'GET') {
        const meeting = requireMeeting(store, id)
        sendJson(res, 200, { ok: true, speakers: meeting.speakers })
        return
      }

      if (segments.length === 5 && segments[2] === 'speakers' && segments[4] === 'rename' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const speakerId = segments[3]
        if (!meeting.speakers.some((entry) => entry.id === speakerId)) {
          const error = new Error(`未找到说话人：${speakerId}`)
          error.status = 404
          throw error
        }
        const body = await readJsonBody(req)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') throw new Error('name 不能为空')
        const updated = await store.renameSpeaker(id, speakerId, name)
        // Keep the in-memory registry label in sync so later slices use it too.
        try {
          if (typeof (deps.speakerTagger)?.rename === 'function') deps.speakerTagger.rename(id, speakerId, name)
        } catch (error) {
          logger?.warn?.(`meeting-minutes: 同步说话人改名失败（${id}/${speakerId}）：${String(error?.message ?? error)}`)
        }
        sendJson(res, 200, { ok: true, meeting: updated })
        return
      }

      if (segments.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, meeting: requireMeeting(store, id) })
          return
        }
        if (method === 'PATCH' || method === 'POST') {
          const current = requireMeeting(store, id)
          const body = await readJsonBody(req)
          const patch = {}
          for (const key of WRITABLE_FIELDS) {
            if (body[key] !== undefined) patch[key] = body[key]
          }
          if (body.appendTranscript === true) {
            patch.transcript = current.transcript === '' ? String(body.transcript ?? '') : `${current.transcript}\n${String(body.transcript ?? '')}`
          } else if (body.transcript !== undefined && String(body.transcript) !== current.transcript) {
            // A manual transcript edit: keep the untouched ASR text and record
            // that the meeting was hand-corrected (exports note it).
            patch.transcriptEdits = Number(current.transcriptEdits) + 1
            patch.transcriptEditedAt = new Date().toISOString()
            if (current.transcriptRaw === '') patch.transcriptRaw = current.transcript
          }
          if (Object.keys(patch).length === 0) throw new Error('没有提供任何要修改的字段')
          const updated = await store.patch(id, patch)
          sendJson(res, 200, { ok: true, meeting: updated })
          return
        }
        if (method === 'DELETE') {
          const removed = await store.remove(id)
          // A discarded live recording leaves temporary slices behind; drop them.
          await clearAudioParts({ meetingId: id })
          clearLiveSession(id)
          clearStopRequest(id)
          try { deps.speakerTagger?.reset?.(id) } catch { /* registry cleanup is best effort */ }
          sendJson(res, removed === null ? 404 : 200, removed === null ? { ok: false, error: '未找到会议' } : { ok: true })
          return
        }
      }

      if (segments.length === 3 && segments[2] === 'summarize' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        logger?.info?.(`meeting-minutes: summarizing ${id} (${meeting.transcript.length} chars)`)
        const summary = await summarizer.summarize(meeting)
        const patch = {}
        if (meeting.attendees.length === 0 && summary.attendees.length > 0) {
          patch.attendees = summary.attendees
        }
        // An automatic placeholder title ("录音纪要 10-21 17:30", "会议纪要 2026-10-21")
        // is exactly what the user did not have time to name. The summary model now
        // proposes a real title; adopt it unless the user explicitly opted out or
        // already typed a title of their own.
        let renamedTo = null
        if (body.autoTitle !== false
          && summary.suggestedTitle !== ''
          && summary.suggestedTitle !== meeting.title
          && isGenericTitle(meeting.title)) {
          patch.title = summary.suggestedTitle
          renamedTo = summary.suggestedTitle
        }
        if (Object.keys(patch).length > 0) await store.patch(id, patch)
        const updated = await store.setSummary(id, summary)
        sendJson(res, 200, { ok: true, meeting: updated, renamedTo })
        return
      }

      if (segments.length === 3 && segments[2] === 'transcribe' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const language = url.searchParams.get('language') ?? undefined
        const providerId = url.searchParams.get('provider') ?? undefined
        // `?fromStored=1` re-transcribes the retained copy, so a failed ASR run
        // does not need the audio to be uploaded again.
        const fromStored = url.searchParams.get('fromStored') === '1'
        // Live recording streams ~5 s slices; only those are speaker-tagged.
        const live = url.searchParams.get('live') === '1'
        let bytes
        if (fromStored) {
          const stored = resolveStoredAudio(meeting.audioPath)
          if (stored === '') throw new Error('这场会议没有已保留的音频副本，无法从副本重转')
          try {
            bytes = new Uint8Array(await readFile(stored))
          } catch (error) {
            if (error?.code === 'ENOENT') throw new Error(`音频副本已被清理或不存在：${stored}`)
            throw error
          }
        } else {
          bytes = await readRawBody(req)
          if (bytes.length === 0) throw new Error('音频为空：没有收到可识别的数据。')
        }
        let audio = null
        if (!fromStored) {
          // Live recording streams ~5 s slices only for recognition: keep the
          // slice in the temporary session folder, never as a retained copy.
          // The whole meeting is merged once by `/audio/finalize` on stop.
          try {
            if (live) {
              await storeAudioPart({
                meetingId: id,
                index: url.searchParams.get('index'),
                bytes,
              })
              touchLiveSession({ meetingId: id, title: meeting.title, date: meeting.date })
            } else {
              audio = await storeAudio({
                bytes,
                sourceName: url.searchParams.get('name') ?? '',
                date: meeting.date,
                title: meeting.title,
              })
              await store.patch(id, {
                audioPath: audio.relPath,
                audioSha256: audio.sha256,
                audioBytes: audio.bytes,
                audioOriginalName: audio.fileName,
                audioError: '',
              })
            }
          } catch (error) {
            logger?.warn?.(`meeting-minutes: 音频副本保存失败（${id}）：${String(error?.message ?? error)}`)
          }
        }
        const fingerprint = audio === null ? meeting.audioSha256 : audio.sha256
        const holder = fingerprint === '' ? null : store.findByAudioSha256(fingerprint)
        const duplicate = holder === null || holder.id === id ? null : { id: holder.id, title: holder.title }
        try {
          const result = await asr.transcribeWav(bytes, { language, providerId })
          // Voiceprint tagging only makes sense on live slices: imported audio
          // and `fromStored` re-runs are whole files without turn boundaries.
          const tagged = live && !fromStored
            ? await tagLiveText(deps, id, bytes, result.text)
            : { text: result.text, speaker: null }
          const updated = await store.appendTranscript(id, tagged.text, result.audioSeconds)
          await store.patch(id, { audioSeconds: result.audioSeconds, audioError: '' })
          sendJson(res, 200, {
            ok: true,
            text: tagged.text,
            speaker: tagged.speaker,
            audioSeconds: result.audioSeconds,
            inferenceSeconds: result.inferenceSeconds,
            transcript: updated?.transcript ?? '',
            transcriptSeconds: updated?.transcriptSeconds ?? 0,
            audio: audio === null
              ? (meeting.audioPath === '' ? null : { path: meeting.audioPath, sha256: meeting.audioSha256 })
              : { path: audio.relPath, sha256: audio.sha256, bytes: audio.bytes },
            duplicate,
          })
          return
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await store.patch(id, { audioError: message })
          sendJson(res, 400, {
            ok: false,
            error: audio === null ? message : `${message}（音频副本已保留：${audio.relPath}）`,
            audioPath: audio === null ? meeting.audioPath : audio.relPath,
            audioError: message,
          })
          return
        }
      }

      if (segments.length === 4 && segments[2] === 'audio' && segments[3] === 'stop' && method === 'POST') {
        requireMeeting(store, id)
        requestStop(id)
        sendJson(res, 200, { ok: true, meetingId: id, stopRequested: true })
        return
      }

      if (segments.length === 4 && segments[2] === 'audio' && segments[3] === 'finalize' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        let merged
        try {
          merged = await finalizeAudioParts({ meetingId: id, title: meeting.title, date: meeting.date })
          clearLiveSession(id)
          clearStopRequest(id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 400, { ok: false, error: message })
          return
        }
        const holder = store.findByAudioSha256(merged.sha256)
        const duplicate = holder === null || holder.id === id ? null : { id: holder.id, title: holder.title }
        const updated = await store.patch(id, {
          audioPath: merged.relPath,
          audioSha256: merged.sha256,
          audioBytes: merged.bytes,
          audioSeconds: merged.seconds,
          audioOriginalName: merged.fileName,
          audioError: '',
        })
        sendJson(res, 200, {
          ok: true,
          meeting: updated,
          audio: {
            path: merged.relPath,
            sha256: merged.sha256,
            bytes: merged.bytes,
            seconds: merged.seconds,
            parts: merged.parts,
          },
          duplicate,
        })
        return
      }

      if (segments.length === 4 && segments[2] === 'todos' && method === 'PATCH') {
        const body = await readJsonBody(req)
        const updated = await store.patchTodo(id, segments[3], body)
        sendJson(res, 200, { ok: true, meeting: updated })
        return
      }

      if (segments.length === 4 && segments[2] === 'todos' && segments[3] === 'push' && method === 'POST') {
        const meeting = requireMeeting(store, id)
        const body = await readJsonBody(req)
        const todoIds = Array.isArray(body.todoIds) ? body.todoIds.map(String) : undefined
        let result = { created: [] }
        let failure = null
        try {
          result = await calendar.pushTodos(meeting, todoIds)
        } catch (error) {
          failure = error
          result = { created: Array.isArray(error?.created) ? error.created : [] }
        }
        for (const entry of result.created) {
          await store.markTodoPushed(id, entry.todoId, entry.calendarTaskId)
        }
        const updated = requireMeeting(store, id)
        const calendarStatus = await calendar.status(true)
        if (failure !== null) {
          sendJson(res, 400, {
            ok: false,
            error: failure.message,
            created: result.created,
            failed: failure.failed ?? [],
            meeting: updated,
            calendar: calendarStatus,
            progress: todoProgress(updated),
          })
          return
        }
        sendJson(res, 200, {
          ok: true,
          created: result.created,
          meeting: updated,
          calendar: calendarStatus,
          progress: todoProgress(updated),
        })
        return
      }

      if (segments.length === 3 && segments[2] === 'export' && method === 'GET') {
        const meeting = requireMeeting(store, id)
        const format = url.searchParams.get('format') === 'md' ? 'md' : 'html'
        const exported = await exportMeeting(meeting, format)
        // Retention prefers deleting copies that already produced an exported
        // report, so the export timestamp is part of the record.
        await store.patch(id, { exportedAt: new Date().toISOString() })
        sendJson(res, 200, { ok: true, ...exported })
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = typeof error?.status === 'number' ? error.status : 400
      sendJson(res, status, { ok: false, error: message })
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}

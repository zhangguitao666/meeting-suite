/**
 * Registry of live recordings currently in flight.
 *
 * A live recording can be started by the panel (browser `getUserMedia`) **or**
 * by an agent through `scripts/live-record.mjs`, which only talks to the JSON
 * API. The page must be able to show "正在录音" even when the browser did not
 * start the capture, so every live slice touches this registry and `/state`
 * exposes it; `finalize` (or deleting the meeting) clears it.
 *
 * @module dsh-plugin-meeting-minutes/live-sessions
 */

/** @type {Map<string, {meetingId: string, title: string, date: string, startedAt: string, updatedAt: string, slices: number}>} */
const sessions = new Map()

/** Record one live slice for a meeting, creating the entry on the first slice. */
export function touchLiveSession({ meetingId, title = '', date = '' }) {
  const id = String(meetingId ?? '').trim()
  if (id === '') return null
  const now = new Date().toISOString()
  const previous = sessions.get(id)
  const nextTitle = String(title ?? '').trim()
  const nextDate = String(date ?? '').trim()
  const entry = {
    meetingId: id,
    title: nextTitle !== '' ? nextTitle : String(previous?.title ?? ''),
    date: nextDate !== '' ? nextDate : String(previous?.date ?? ''),
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    slices: (previous?.slices ?? 0) + 1,
  }
  sessions.set(id, entry)
  return { ...entry }
}

/** Drop one meeting's entry (recording finalized, cancelled, or meeting deleted). */
export function clearLiveSession(meetingId) {
  const id = String(meetingId ?? '').trim()
  if (id === '') return false
  return sessions.delete(id)
}

/** Every recording currently in flight, newest activity first. */
export function listLiveSessions() {
  return [...sessions.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

/** Meetings an operator asked to stop (the recorder polls this). */
const stopRequests = new Set()

/** Ask the recorder of one meeting to stop; the CLI polls `/state`. */
export function requestStop(meetingId) {
  const id = String(meetingId ?? '').trim()
  if (id === '') return false
  stopRequests.add(id)
  return true
}

/** Has a stop been requested for this meeting? */
export function isStopRequested(meetingId) {
  return stopRequests.has(String(meetingId ?? '').trim())
}

/** Forget a stop request (after finalize, cancel or delete). */
export function clearStopRequest(meetingId) {
  return stopRequests.delete(String(meetingId ?? '').trim())
}

/** Every pending stop request, for `/state`. */
export function listStopRequests() {
  return [...stopRequests]
}

/** Test hook: forget everything. */
export function resetLiveSessions() {
  sessions.clear()
  stopRequests.clear()
}

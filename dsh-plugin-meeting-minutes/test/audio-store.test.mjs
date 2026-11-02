/**
 * Unit tests for audio provenance: copy naming, sha256 fingerprinting, the
 * shared data directory, and the retention policy.
 *
 * Run with the bundled Node:
 *   node --test test/audio-store.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { MeetingStore } from '../lib/store.js'
import { normalizeSummary } from '../lib/model.js'
import { resolveExportDir, resolveMeetingDataDir } from '../lib/export.js'
import {
  DEFAULT_AUDIO_POLICY,
  pruneAudio,
  resolveAudioDir,
  resolveStoredAudio,
  sha256Bytes,
  sha256File,
  storeAudio,
  verifyStoredAudio,
} from '../lib/audio-store.js'
import { assertRealAudioUnchanged } from './support/real-audio-guard.mjs'

/** Run one test body against a throwaway `$DSH_HOME` equivalent. */
async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'meeting-audio-test-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Create one meeting, retain its audio copy and return both. */
async function makeMeeting(store, home, options = {}) {
  const meeting = await store.add({
    title: options.title ?? '录音会',
    date: options.date ?? '2026-10-27',
    sourceType: 'recording',
    transcript: options.transcript ?? '转写文本',
    transcriptSeconds: 12.5,
  })
  const audio = await storeAudio({
    bytes: Buffer.from(options.bytes ?? `audio-${meeting.id}`),
    sourceName: '/tmp/会议.m4a',
    title: meeting.title,
    date: meeting.date,
    home,
  })
  await store.patch(meeting.id, {
    audioPath: audio.relPath,
    audioSha256: audio.sha256,
    audioBytes: audio.bytes,
    audioOriginalName: audio.fileName,
  })
  if (options.summary === true) await store.setSummary(meeting.id, normalizeSummary({ oneLine: '测试纪要' }, { now: new Date() }))
  if (options.exported === true) await store.patch(meeting.id, { exportedAt: '2026-10-21T02:00:00.000Z' })
  if (options.pinned === true) await store.patch(meeting.id, { audioPinned: true })
  return { meeting: store.get(meeting.id), audio }
}

test('音频目录与 exports 同父，且都派生自 meeting-minutes/', async () => {
  await withHome(async (home) => {
    assert.equal(resolveAudioDir(home), join(resolveMeetingDataDir(home), 'audio'))
    assert.equal(dirname(resolveAudioDir(home)), dirname(resolveExportDir(home)))
    assert.equal(dirname(resolveAudioDir(home)), resolveMeetingDataDir(home))
  })
})

test('storeAudio 写盘并记录源文件字节的 sha256', async () => {
  await withHome(async (home) => {
    const bytes = Buffer.from('fake-audio-bytes')
    const audio = await storeAudio({ bytes, sourceName: '/tmp/这是一次测试.m4a', date: '2026-10-27', title: '这是一次测试', home })
    assert.equal(audio.sha256, sha256Bytes(bytes))
    assert.equal(audio.relPath, `meeting-minutes/audio/2026-10-27-这是一次测试-${audio.sha256.slice(0, 8)}.m4a`)
    assert.equal(audio.format, 'm4a')
    assert.equal(await sha256File(audio.absPath), audio.sha256)
    assert.equal(resolveStoredAudio(audio.relPath, home), audio.absPath)

    // Re-storing identical bytes reuses the same file instead of a second copy.
    const again = await storeAudio({ bytes, sourceName: '/tmp/这是一次测试.m4a', date: '2026-10-27', title: '这是一次测试', home })
    assert.equal(again.existed, true)
    assert.equal(again.relPath, audio.relPath)

    // A blob (no filename) is stored as WAV.
    const blob = await storeAudio({ bytes: Buffer.from('blob'), sourceName: '', date: '2026-10-27', title: '面板录音', home })
    assert.equal(blob.format, 'wav')
  })
})

test('resolveStoredAudio 拒绝绝对路径与 .. 穿越', async () => {
  await withHome(async (home) => {
    assert.equal(resolveStoredAudio('../escape.wav', home), '')
    assert.equal(resolveStoredAudio('/etc/passwd', home), '')
    assert.equal(resolveStoredAudio('  ', home), '')
    assert.equal(
      resolveStoredAudio('meeting-minutes/audio/a.wav', home),
      join(home, 'meeting-minutes/audio/a.wav'),
    )
  })
})

test('verifyStoredAudio 用 hash 对上同一条纪要，副本丢失时报 missing', async () => {
  await withHome(async (home) => {
    const store = new MeetingStore({ file: join(home, 'storages', 'meeting-minutes.json') })
    await store.load()
    const { meeting, audio } = await makeMeeting(store, home, { bytes: 'verify-me' })

    const verified = await verifyStoredAudio(meeting, { home })
    assert.equal(verified.ok, true)
    assert.equal(verified.actual, audio.sha256)
    assert.equal(verified.reason, 'match')

    const legacy = await store.add({ title: '纯文本', date: '2026-10-27', transcript: 'x' })
    const noAudio = await verifyStoredAudio(legacy, { home })
    assert.equal(noAudio.ok, false)
    assert.equal(noAudio.reason, 'no-audio')

    await rm(audio.absPath, { force: true })
    const missing = await verifyStoredAudio(store.get(meeting.id), { home })
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'missing')
  })
})

test('保留策略：先删已导出+已出纪要，再删已出纪要，无纪要最后删；pinned 不删', async () => {
  await withHome(async (home) => {
    const store = new MeetingStore({ file: join(home, 'storages', 'meeting-minutes.json') })
    await store.load()
    const exported = await makeMeeting(store, home, { title: '已导出会', summary: true, exported: true, bytes: 'a' })
    const summarized = await makeMeeting(store, home, { title: '有纪要会', summary: true, bytes: 'b' })
    const plain = await makeMeeting(store, home, { title: '没纪要会', bytes: 'c' })
    const pinned = await makeMeeting(store, home, { title: '钉住的会', pinned: true, bytes: 'd' })

    // keepCount applies to unpinned copies: C survives, pinned D is never a candidate.
    const result = await pruneAudio({ store, home, policy: { keepCount: 1, maxTotalBytes: 10 ** 9, maxAgeDays: 60 } })
    assert.equal(result.removed.length, 2)
    const removedNames = result.removed.map((entry) => entry.fileName).sort()
    assert.deepEqual(removedNames, [exported.audio.fileName, summarized.audio.fileName].sort())
    assert.ok(result.removed.every((entry) => entry.reason === 'count'))

    // Exported copy went first and its record keeps the fingerprint.
    assert.equal(result.removed[0].fileName, exported.audio.fileName)
    assert.notEqual(store.get(exported.meeting.id).audioPrunedAt, '')
    assert.equal(store.get(exported.meeting.id).audioSha256, exported.audio.sha256)

    // No-minutes copies survive; pinned copies are never touched.
    assert.ok((await stat(plain.audio.absPath)).isFile())
    assert.ok((await stat(pinned.audio.absPath)).isFile())
    assert.equal(store.get(pinned.meeting.id).audioPrunedAt, '')
  })
})

test('保留策略：超龄副本被清理，reason=expired', async () => {
  await withHome(async (home) => {
    const store = new MeetingStore({ file: join(home, 'storages', 'meeting-minutes.json') })
    await store.load()
    const fresh = await makeMeeting(store, home, { title: '新录音', bytes: 'fresh' })
    const old = await makeMeeting(store, home, { title: '老录音', bytes: 'old' })
    const hundredDaysAgo = new Date(Date.now() - 100 * 86_400_000)
    await utimes(old.audio.absPath, hundredDaysAgo, hundredDaysAgo)

    const result = await pruneAudio({ store, home, policy: { keepCount: 30, maxTotalBytes: 10 ** 9, maxAgeDays: 60 } })
    assert.equal(result.removed.length, 1)
    assert.equal(result.removed[0].fileName, old.audio.fileName)
    assert.equal(result.removed[0].reason, 'expired')
    assert.ok((await stat(fresh.audio.absPath)).isFile())
    assert.notEqual(store.get(old.meeting.id).audioPrunedAt, '')
  })
})

test('保留策略：总量超限时按优先级删到限额内', async () => {
  await withHome(async (home) => {
    const store = new MeetingStore({ file: join(home, 'storages', 'meeting-minutes.json') })
    await store.load()
    const exported = await makeMeeting(store, home, { title: '导出过', summary: true, exported: true, bytes: 'x'.repeat(64) })
    const plain = await makeMeeting(store, home, { title: '没纪要', bytes: 'y'.repeat(64) })

    const result = await pruneAudio({ store, home, policy: { keepCount: 30, maxTotalBytes: 1, maxAgeDays: 60 } })
    assert.equal(result.removed.length, 2)
    assert.equal(result.removed[0].fileName, exported.audio.fileName)
    assert.equal(result.removed[0].reason, 'size')
    await assert.rejects(stat(plain.audio.absPath), /ENOENT/)
    assert.equal(result.count, 0)
  })
})

test('默认保留策略：30 份 / 5GB / 60 天', () => {
  assert.equal(DEFAULT_AUDIO_POLICY.keepCount, 30)
  assert.equal(DEFAULT_AUDIO_POLICY.maxTotalBytes, 5 * 1024 * 1024 * 1024)
  assert.equal(DEFAULT_AUDIO_POLICY.maxAgeDays, 60)
  assert.equal(DEFAULT_AUDIO_POLICY.orphanMaxAgeDays, 7)
})

test('未关联记录的孤儿副本超期后被清扫', async () => {
  await withHome(async (home) => {
    const store = new MeetingStore({ file: join(home, 'storages', 'meeting-minutes.json') })
    await store.load()
    const orphan = await storeAudio({ bytes: Buffer.from('orphan'), sourceName: '/tmp/x.wav', date: '2026-10-27', title: '失败尝试', home })
    const longAgo = new Date(Date.now() - 30 * 86_400_000)
    await utimes(orphan.absPath, longAgo, longAgo)

    const result = await pruneAudio({ store, home })
    assert.equal(result.removed.length, 1)
    assert.equal(result.removed[0].fileName, orphan.fileName)
    assert.equal(result.removed[0].reason, 'orphan')
    await assert.rejects(readFile(orphan.absPath), /ENOENT/)
  })
})

test('同字节不同标题复用同一份副本，不再写第二份', async () => {
  await withHome(async (home) => {
    const bytes = Buffer.from('one-recording-same-bytes')
    const first = await storeAudio({ bytes, sourceName: '/tmp/原录音.m4a', date: '2026-10-27', title: '原会议', home })
    assert.equal(first.existed, false)

    // A renamed copy of the same recording must not cost a second copy.
    const renamed = await storeAudio({ bytes, sourceName: '/tmp/重命名后的副本.wav', date: '2026-10-27', title: '另一场会', home })
    assert.equal(renamed.existed, true)
    assert.equal(renamed.fileName, first.fileName)
    assert.equal(renamed.relPath, first.relPath)
    assert.equal(await sha256File(renamed.absPath), sha256Bytes(bytes))

    // Even a different date/title resolves to the retained copy.
    const later = await storeAudio({ bytes, sourceName: '', date: '2026-10-28', title: '隔天又传', home })
    assert.equal(later.fileName, first.fileName)

    assert.equal((await readdir(resolveAudioDir(home))).length, 1)
  })
})

test('复用前校验完整 hash：sha8 相同的伪造文件不被信任', async () => {
  await withHome(async (home) => {
    const real = Buffer.from('the-real-recording-bytes')
    const short = sha256Bytes(real).slice(0, 8)
    const dir = resolveAudioDir(home)
    await mkdir(dir, { recursive: true })
    const decoyName = `2026-10-27-伪造-${short}.wav`
    const decoy = join(dir, decoyName)
    await writeFile(decoy, Buffer.from('tampered-not-the-same-bytes'))

    const stored = await storeAudio({ bytes: real, sourceName: '/tmp/real.wav', date: '2026-10-27', title: '真录音', home })
    assert.equal(stored.existed, false)
    assert.notEqual(stored.fileName, decoyName)
    assert.equal(await sha256File(stored.absPath), sha256Bytes(real))
    // The decoy was neither trusted nor overwritten.
    assert.equal(await readFile(decoy, 'utf8'), 'tampered-not-the-same-bytes')
  })
})

test('单测不写入真实音频目录', async () => {
  // Everything above injects `home`; this fails loudly if any test forgets.
  assertRealAudioUnchanged()
})

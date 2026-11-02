/**
 * Unit tests for the auto-ingest source parsing.
 *
 * These cover the pure parts: Tencent row normalization, source classification,
 * title derivation, JSON/DOCX text extraction, and folder/config expansion. The
 * scan loop itself needs the real sqlite3 CLI and is exercised by the manual
 * end-to-end check documented in README.
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AUDIO_EXTENSIONS,
  TEXT_EXTENSIONS,
  docxXmlToText,
  expandHome,
  extractTextPayload,
  fileKind,
  normalizeTencentRow,
  tencentDatabaseDirs,
  titleFromFile,
} from '../lib/autoingest.js'
import { DEFAULT_AUTO_INGEST, normalizeAutoIngestConfig, normalizeMeeting, projectMeeting } from '../lib/model.js'
import { resolveStoredAudio, sha256Bytes } from '../lib/audio-store.js'
import { assertRealAudioUnchanged } from './support/real-audio-guard.mjs'

test('expandHome 只展开开头的 ~', () => {
  assert.equal(expandHome('~'), homedir())
  assert.equal(expandHome('~/Documents/a'), join(homedir(), 'Documents/a'))
  assert.equal(expandHome('/tmp/a'), '/tmp/a')
  assert.equal(expandHome('  /tmp/a  '), '/tmp/a')
  assert.equal(expandHome(undefined), '')
})

test('fileKind 识别音频、文本与未知类型', () => {
  for (const ext of AUDIO_EXTENSIONS) assert.equal(fileKind(`x${ext}`), 'audio')
  for (const ext of TEXT_EXTENSIONS) assert.equal(fileKind(`x${ext}`), 'text')
  assert.equal(fileKind('minutes.docx'), 'text')
  assert.equal(fileKind('minutes.json'), 'text')
  assert.equal(fileKind('image.png'), null)
  assert.equal(fileKind(''), null)
})

test('titleFromFile 去掉扩展名并兜底', () => {
  assert.equal(titleFromFile('/a/Q4 预算评审.m4a'), 'Q4 预算评审')
  assert.match(titleFromFile('/a/.hidden'), /^录音纪要 \d{4}-/)
  assert.match(titleFromFile(''), /^录音纪要 \d{4}-/)
})

test('normalizeTencentRow 支持秒/毫秒时间戳与不完整录制', () => {
  const seconds = normalizeTencentRow({
    record_id: 'rec_1',
    record_title: 'Q4 启动会',
    local_file_path: '~/Documents/TencentMeeting/a.mp4',
    meeting_code: '123456789',
    record_end_time: 1700000000,
    start_record_time: 1699990000,
    total_size: 1024,
    is_record_complete: 1,
  })
  assert.equal(seconds.key, 'tencent:rec_1')
  assert.equal(seconds.path, expandHome('~/Documents/TencentMeeting/a.mp4'))
  assert.equal(seconds.endAt, 1700000000000)
  assert.equal(seconds.startAt, 1699990000000)
  assert.equal(seconds.completed, true)

  const millis = normalizeTencentRow({
    record_id: 'rec_2',
    local_file_path: '/tmp/b.m4a',
    record_end_time: 1700000000000,
    is_record_complete: 1,
  })
  assert.equal(millis.endAt, 1700000000000)

  const incomplete = normalizeTencentRow({
    record_id: 'rec_3',
    local_file_path: '/tmp/c.m4a',
    record_end_time: 1700000000,
    is_record_complete: 0,
  })
  assert.equal(incomplete.completed, false)

  assert.equal(normalizeTencentRow({ local_file_path: '' }), null)
  assert.equal(normalizeTencentRow(null), null)
})

test('extractTextPayload 从腾讯/office JSON 里找正文', () => {
  const nested = JSON.stringify({
    minutes: { paragraphs: [{ sentences: [{ text: '这是一段足够长的会议正文内容，用来验证递归提取。' }] }] },
  })
  assert.match(extractTextPayload(nested), /会议正文内容/)
  assert.equal(extractTextPayload('普通文本内容'), '普通文本内容')
  assert.equal(extractTextPayload(''), '')
  assert.equal(extractTextPayload('{}'), '{}')
})

test('docxXmlToText 提取段落与实体', () => {
  const xml = '<w:body><w:p><w:r><w:t>第一段 &amp; 内容</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body>'
  assert.equal(docxXmlToText(xml), '第一段 & 内容\n第二段')
})

test('normalizeAutoIngestConfig 归一化默认值与目录', () => {
  assert.deepEqual(normalizeAutoIngestConfig(null), {
    ...DEFAULT_AUTO_INGEST,
    ingested: {},
    failures: {},
  })
  const config = normalizeAutoIngestConfig({
    enabled: false,
    tencent: false,
    dirs: [' ~/Documents/TencentMeeting ', '~/Documents/TencentMeeting', '/tmp/minutes', ''],
    ingested: {
      'tencent:rec_1': { meetingId: 'mt_1', title: 'A', at: '2026-10-21T00:00:00.000Z', path: '/a.mp4' },
      bad: null,
    },
    failures: { 'dir:/tmp/x.m4a': { count: 9, message: '转换失败', at: '2026-10-21' } },
    importedCount: 3.9,
    lastScanAt: '2026-10-21T00:00:00.000Z',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.tencent, false)
  assert.deepEqual(config.dirs, ['~/Documents/TencentMeeting', '/tmp/minutes'])
  assert.equal(config.ingested['tencent:rec_1'].meetingId, 'mt_1')
  assert.equal(config.ingested.bad, undefined)
  assert.equal(config.failures['dir:/tmp/x.m4a'].count, 9)
  assert.equal(config.importedCount, 3)
})

test('autoImported 会议标记进入列表投影', () => {
  const meeting = normalizeMeeting({
    title: '自动导入的会',
    date: '2026-10-21',
    transcript: '内容',
    autoImported: true,
  }, { now: new Date(2026, 9, 21) })
  assert.equal(meeting.autoImported, true)
  assert.equal(projectMeeting(meeting).autoImported, true)
  const manual = normalizeMeeting({ title: '手工会', transcript: '内容' }, { now: new Date(2026, 9, 21) })
  assert.equal(manual.autoImported, false)
  assert.equal(projectMeeting(manual).autoImported, false)
})

test('tencentDatabaseDirs 指向腾讯会议容器路径', () => {
  const dirs = tencentDatabaseDirs()
  assert.ok(dirs.length >= 1)
  assert.ok(dirs[0].includes('com.tencent.meeting'))
  assert.ok(dirs[0].endsWith(join('Library', 'Global', 'Database')))
})

test('目录监控：新音频/文本文件自动入库且不重复', async () => {
  const { mkdtemp, writeFile, utimes, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { MeetingStore } = await import('../lib/store.js')
  const { createAutoIngest } = await import('../lib/autoingest.js')

  const dir = await mkdtemp(join(tmpdir(), 'autoingest-test-'))
  // Isolate every retained-audio write: without this the scan writes into the
  // user's real $DSH_HOME/meeting-minutes/audio (the 2026-10-27 pollution bug).
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const store = new MeetingStore({ file: join(dir, 'meetings.json') })
    await store.load()
    const watchDir = join(dir, 'watch')
    await (await import('node:fs/promises')).mkdir(watchDir, { recursive: true })
    const audioPath = join(watchDir, 'Q4 启动会.m4a')
    const textPath = join(watchDir, '腾讯纪要导出.md')
    await writeFile(audioPath, 'fake-audio', 'utf8')
    await writeFile(textPath, '# 会议纪要\n\n本次会议确认了预算方案。', 'utf8')
    const old = new Date(Date.now() - 120_000)
    await utimes(audioPath, old, old)
    await utimes(textPath, old, old)

    const asr = {
      transcribeFile: async (path) => {
        assert.ok(path.endsWith('Q4 启动会.m4a'))
        return { text: '这是自动导入的转写内容。', audioSeconds: 12, inferenceSeconds: 1 }
      },
    }
    const engine = createAutoIngest({ store, asr })
    await engine.setConfig({ enabled: true, tencent: false, dirs: [watchDir] })
    const status = await engine.scanNow()
    assert.equal(status.importedCount, 2)
    const meetings = store.snapshot().meetings
    assert.equal(meetings.length, 2)
    assert.ok(meetings.every((meeting) => meeting.autoImported === true))
    const titles = meetings.map((meeting) => meeting.title).sort()
    assert.deepEqual(titles, ['Q4 启动会', '腾讯纪要导出'])
    const audio = meetings.find((meeting) => meeting.title === 'Q4 启动会')
    assert.equal(audio.transcript, '这是自动导入的转写内容。')
    assert.equal(audio.transcriptSeconds, 12)
    assert.match(audio.notes, /自动导入/)
    // The retained copy lives under the isolated home and matches the record.
    assert.equal(audio.audioSha256, sha256Bytes(Buffer.from('fake-audio', 'utf8')))
    assert.match(audio.audioPath, /^meeting-minutes\/audio\/.+\.m4a$/)
    assert.equal(await readFile(resolveStoredAudio(audio.audioPath), 'utf8'), 'fake-audio')
    const text = meetings.find((meeting) => meeting.title === '腾讯纪要导出')
    assert.match(text.transcript, /预算方案/)
    assert.equal(text.audioPath, '')

    const second = await engine.scanNow()
    assert.equal(second.importedCount, 2)
    assert.equal(store.snapshot().meetings.length, 2)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('单测不写入真实音频目录', () => {
  // The scan above retains audio; this catches any future test that forgets to
  // isolate $DSH_HOME and would pollute the user's real data directory.
  assertRealAudioUnchanged()
})

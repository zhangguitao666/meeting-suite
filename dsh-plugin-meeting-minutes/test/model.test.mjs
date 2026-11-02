/**
 * Unit tests for the pure meeting model, the durable store, and document export.
 * Run with the bundled Node:
 *   node --test test/model.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  formatMoment,
  localDay,
  meetingLine,
  normalizeAttendees,
  normalizeMeeting,
  isGenericTitle,
  normalizeSummary,
  normalizeTodoInput,
  parseMeetingDate,
  parseSummaryJson,
  projectMeeting,
  todoProgress,
  newId,
} from '../lib/model.js'
import { MeetingStore, sortMeetings } from '../lib/store.js'
import { buildHtml, buildMarkdown, escapeHtml, exportMeeting, formatDuration, safeFileName } from '../lib/export.js'

const NOW = new Date(2026, 9, 21, 10, 30, 0)

function sampleSummary() {
  return {
    oneLine: 'Q4 预算方案通过，按 A 方案执行。',
    overview: '会议确认了 Q4 预算规模与三条重点投入方向。',
    keyPoints: ['预算总额 1200 万', '优先保障交付团队'],
    decisions: [{ text: '采用 A 方案', owner: '王五' }],
    risks: [{ text: '供应商报价可能上涨', level: 'high' }],
    sections: [{ heading: '议题一：预算', bullets: ['总额 1200 万', '分两批释放'] }],
    attendees: ['张三', '李四'],
    todos: [
      { title: '输出 Q4 预算初稿', owner: '张三', due: '2026-10-28 18:00', priority: 'high', notes: '含三张明细表' },
      { title: '和供应商确认报价', owner: '李四', due: '下周三', priority: 'normal', notes: '' },
    ],
  }
}

test('日期解析接受常见写法并回退到今天', () => {
  assert.equal(parseMeetingDate('2026-10-21', NOW), '2026-10-21')
  assert.equal(parseMeetingDate('2026/10/21', NOW), '2026-10-21')
  assert.equal(parseMeetingDate('2026年10月21日', NOW), '2026-10-21')
  assert.equal(parseMeetingDate('不是日期', NOW), '2026-10-21')
  assert.equal(parseMeetingDate(new Date(2026, 0, 3), NOW), '2026-01-03')
})

test('参会人归一化去重、支持分隔字符串', () => {
  assert.deepEqual(normalizeAttendees('张三、李四, 张三；王五'), ['张三', '李四', '王五'])
  assert.deepEqual(normalizeAttendees(['A', ' A ', '', 'B']), ['A', 'B'])
  assert.deepEqual(normalizeAttendees(null), [])
})

test('normalizeMeeting 生成规范记录并拒绝空标题', () => {
  const meeting = normalizeMeeting({
    title: '  Q4 启动会 ',
    date: '2026/10/20',
    attendees: '张三、李四',
    transcript: '会议内容……',
    transcriptSeconds: 183.26,
    sourceType: 'recording',
  }, { now: NOW })
  assert.equal(meeting.title, 'Q4 启动会')
  assert.equal(meeting.date, '2026-10-20')
  assert.deepEqual(meeting.attendees, ['张三', '李四'])
  assert.equal(meeting.sourceType, 'recording')
  assert.equal(meeting.transcriptSeconds, 183.3)
  assert.equal(meeting.summary, null)
  assert.equal(meeting.createdAt, NOW.toISOString())
  assert.throws(() => normalizeMeeting({ title: '   ' }, { now: NOW }), /title/)
})

test('normalizeMeeting 的 patch 保留创建时间与摘要', () => {
  const base = normalizeMeeting({
    id: 'mt_base',
    title: '周会',
    date: '2026-10-21',
    createdAt: '2026-10-01T00:00:00.000Z',
    summary: sampleSummary(),
  }, { now: NOW })
  const patched = normalizeMeeting({ title: '周会（改）', transcript: '追加' }, { now: NOW, base })
  assert.equal(patched.id, 'mt_base')
  assert.equal(patched.createdAt, '2026-10-01T00:00:00.000Z')
  assert.equal(patched.summary.todos.length, 2)
  assert.equal(patched.title, '周会（改）')
  assert.equal(patched.transcript, '追加')
})

test('isGenericTitle 只把自动占位标题当作可改名', () => {
  assert.equal(isGenericTitle('录音纪要 2026-10-21 17:30'), true)
  assert.equal(isGenericTitle('会议纪要 2026-10-21'), true)
  assert.equal(isGenericTitle('会议纪要 10-21 17:30'), true)
  assert.equal(isGenericTitle('导入纪要'), true)
  assert.equal(isGenericTitle('未命名会议'), true)
  assert.equal(isGenericTitle(''), true)
  assert.equal(isGenericTitle('Q4 启动会'), false)
  assert.equal(isGenericTitle('智能客服项目进度会议'), false)
  assert.equal(isGenericTitle('录音纪要评审会'), false)
})

test('normalizeSummary 保留 suggestedTitle 并截断', () => {
  const summary = normalizeSummary({ ...sampleSummary(), suggestedTitle: '  Q4预算评审与投放排期  ' }, { now: NOW })
  assert.equal(summary.suggestedTitle, 'Q4预算评审与投放排期')
  const empty = normalizeSummary(sampleSummary(), { now: NOW })
  assert.equal(empty.suggestedTitle, '')
  const long = normalizeSummary({ ...sampleSummary(), suggestedTitle: '标'.repeat(120) }, { now: NOW })
  assert.equal(long.suggestedTitle.length, 60)
})

test('normalizeSummary 规范化字段并丢弃非法待办', () => {
  const summary = normalizeSummary({
    oneLine: ' 结论 ',
    overview: '概述',
    keyPoints: ['a', '', 42],
    decisions: ['直接字符串决策', { text: '结构化决策', owner: '张三' }],
    risks: [{ text: '风险A', level: 'nonsense' }, '风险B'],
    sections: [{ heading: '议题', bullets: ['x', ''] }, { bullets: [] }],
    attendees: '张三、李四',
    todos: [
      { title: '   ', owner: 'x' },
      { title: '写方案', owner: '李四', due: '10-30', priority: 'urgent' },
    ],
  }, { now: NOW, model: 'test/model' })
  assert.equal(summary.oneLine, '结论')
  assert.deepEqual(summary.keyPoints, ['a', '42'])
  assert.deepEqual(summary.decisions, [
    { text: '直接字符串决策', owner: '' },
    { text: '结构化决策', owner: '张三' },
  ])
  assert.deepEqual(summary.risks.map((risk) => risk.level), ['medium', 'medium'])
  assert.equal(summary.sections.length, 1)
  assert.deepEqual(summary.attendees, ['张三', '李四'])
  assert.equal(summary.todos.length, 1)
  assert.equal(summary.todos[0].priority, 'normal')
  assert.equal(summary.todos[0].calendarTaskId, null)
  assert.equal(summary.model, 'test/model')
})

test('重新生成纪要保留已写入日历的待办关联', () => {
  const first = normalizeSummary(sampleSummary(), { now: NOW })
  first.todos[0].calendarTaskId = 'tk_123'
  first.todos[0].pushedAt = NOW.toISOString()
  const second = normalizeSummary(sampleSummary(), { now: NOW, previous: first })
  assert.equal(second.todos[0].id, first.todos[0].id)
  assert.equal(second.todos[0].calendarTaskId, 'tk_123')
  assert.equal(second.todos[1].calendarTaskId, null)
})

test('待办输入拒绝空标题并保留优先级词表', () => {
  assert.equal(normalizeTodoInput({ title: ' ' }), null)
  assert.equal(normalizeTodoInput({ title: '写方案', priority: 'high' }).priority, 'high')
  assert.equal(normalizeTodoInput({ title: '写方案', priority: 'urgent' }).priority, 'normal')
})

test('parseSummaryJson 容忍代码围栏与前后说明', () => {
  assert.deepEqual(parseSummaryJson('```json\n{"oneLine":"x"}\n```'), { oneLine: 'x' })
  assert.deepEqual(parseSummaryJson('说明文字 {"a":1} 结尾'), { a: 1 })
  assert.equal(parseSummaryJson('没有 JSON'), null)
  assert.equal(parseSummaryJson('{坏掉'), null)
  assert.equal(parseSummaryJson(''), null)
})

test('projectMeeting / todoProgress / meetingLine 统计正确', () => {
  const meeting = normalizeMeeting({
    id: 'mt_1',
    title: '预算会',
    date: '2026-10-21',
    attendees: ['张三'],
    transcript: '一二三四',
    summary: sampleSummary(),
  }, { now: NOW })
  meeting.summary.todos[0].calendarTaskId = 'tk_1'
  const projection = projectMeeting(meeting)
  assert.equal(projection.hasSummary, true)
  assert.equal(projection.todoCount, 2)
  assert.equal(projection.pendingTodoCount, 1)
  assert.equal(projection.transcriptChars, 4)
  assert.deepEqual(todoProgress(meeting), { total: 2, pushed: 1, pending: 1 })
  assert.match(meetingLine(meeting), /预算会/)
  assert.match(meetingLine(meeting), /1\/2/)
})

test('sortMeetings 按日期倒序，同日按更新时间倒序', () => {
  const list = [
    { id: 'a', date: '2026-10-20', updatedAt: '2026-10-20T01:00:00.000Z' },
    { id: 'b', date: '2026-10-21', updatedAt: '2026-10-21T01:00:00.000Z' },
    { id: 'c', date: '2026-10-21', updatedAt: '2026-10-21T02:00:00.000Z' },
  ]
  assert.deepEqual(sortMeetings(list).map((meeting) => meeting.id), ['c', 'b', 'a'])
})

test('MeetingStore 增删改查与落盘重载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-store-test-'))
  try {
    const file = join(dir, 'meeting-minutes.json')
    const store = new MeetingStore({ file })
    await store.load()
    assert.deepEqual(store.snapshot().meetings, [])
    const created = await store.add({
      title: '周会',
      date: '2026-10-21',
      transcript: '逐字稿',
    }, { now: NOW })
    assert.match(created.id, /^mt_/)
    const summary = normalizeSummary(sampleSummary(), { now: NOW })
    await store.setSummary(created.id, summary)
    await store.markTodoPushed(created.id, summary.todos[0].id, 'tk_9')
    await store.patchTodo(created.id, summary.todos[1].id, { owner: '王五', priority: 'high' })
    await store.appendTranscript(created.id, '追加一句', 12.34)

    const reloaded = new MeetingStore({ file })
    await reloaded.load()
    const meeting = reloaded.get(created.id)
    assert.equal(meeting.title, '周会')
    assert.equal(meeting.transcript, '逐字稿\n追加一句')
    assert.equal(meeting.transcriptSeconds, 12.3)
    assert.equal(meeting.summary.todos[0].calendarTaskId, 'tk_9')
    assert.equal(meeting.summary.todos[1].owner, '王五')
    assert.equal(meeting.summary.todos[1].priority, 'high')

    const found = reloaded.find('周会')
    assert.equal(found.id, created.id)
    assert.equal(reloaded.find('不存在'), null)

    const removed = await reloaded.remove(created.id)
    assert.equal(removed.id, created.id)
    assert.equal(reloaded.snapshot().meetings.length, 0)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(onDisk.meetings, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MeetingStore 损坏文件被备份并以空库启动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-store-corrupt-'))
  try {
    const file = join(dir, 'meeting-minutes.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{ 这不是 JSON', 'utf8')
    const store = new MeetingStore({ file })
    await store.load()
    assert.deepEqual(store.snapshot().meetings, [])
    const files = await import('node:fs/promises').then((fs) => fs.readdir(dir))
    assert.ok(files.some((name) => name.includes('.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Markdown 导出覆盖各区块', () => {
  const meeting = normalizeMeeting({
    title: 'Q4 启动会',
    date: '2026-10-21',
    attendees: ['张三', '李四'],
    transcript: '原始文本',
    transcriptSeconds: 3725,
    summary: sampleSummary(),
  }, { now: NOW })
  meeting.summary.todos[1].calendarTaskId = 'tk_2'
  const markdown = buildMarkdown(meeting)
  for (const heading of ['# Q4 启动会', '## 一句话结论', '## 关键要点', '## 会议决策', '## 风险 / 待确认', '## 分节纪要', '## 待办事项', '## 原始转写']) {
    assert.ok(markdown.includes(heading), `缺少 ${heading}`)
  }
  assert.ok(markdown.includes('Q4 预算初稿'))
  assert.ok(markdown.includes('已写入日历'))
  assert.ok(markdown.includes('1 小时 2 分'))
})

test('HTML 导出自包含、转义用户文本并带待办状态', () => {
  const meeting = normalizeMeeting({
    title: 'Q4 <script>alert(1)</script>',
    date: '2026-10-21',
    attendees: ['张三'],
    transcript: '文本 <img src=x onerror=alert(1)>',
    summary: sampleSummary(),
  }, { now: NOW })
  const html = buildHtml(meeting)
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<style>'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('原始转写'))
  assert.ok(html.includes('待写入'))
  assert.ok(!html.includes('src="http'))
  assert.equal(escapeHtml('a&b<c>'), 'a&amp;b&lt;c&gt;')
})

test('文件名与时长格式化', () => {
  assert.equal(safeFileName('Q4/Q1:预算 <初稿>'), 'Q4 Q1 预算 初稿')
  assert.equal(safeFileName('   '), '会议纪要')
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(65), '1 分 5 秒')
  assert.equal(formatDuration(3725), '1 小时 2 分')
})

test('exportMeeting 写出 HTML 与 Markdown 文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meeting-export-test-'))
  try {
    const meeting = normalizeMeeting({
      title: '导出测试会',
      date: '2026-10-21',
      transcript: '内容',
      summary: sampleSummary(),
    }, { now: NOW })
    const html = await exportMeeting(meeting, 'html', { dir })
    assert.equal(html.format, 'html')
    assert.match(html.filename, /^2026-10-21-导出测试会\.html$/)
    assert.ok((await readFile(html.path, 'utf8')).includes('导出测试会'))
    const md = await exportMeeting(meeting, 'md', { dir })
    assert.equal(md.format, 'md')
    assert.ok((await readFile(md.path, 'utf8')).includes('## 待办事项'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('工具函数 id 前缀与本地时间格式', () => {
  assert.match(newId('td'), /^td_/)
  assert.match(formatMoment(new Date(2026, 0, 2, 3, 4)), /^2026-01-02 03:04$/)
  assert.equal(localDay(new Date(2026, 0, 2)), '2026-01-02')
})

test('老记录没有音频溯源字段也能读，新字段可往返', () => {
  // A store written by 1.1.0 has none of the audio fields.
  const legacy = normalizeMeeting({ id: 'mt_legacy', title: '老会议', date: '2026-10-20', sourceType: 'recording' }, { now: NOW })
  assert.equal(legacy.audioPath, '')
  assert.equal(legacy.audioSha256, '')
  assert.equal(legacy.audioBytes, 0)
  assert.equal(legacy.audioSeconds, 0)
  assert.equal(legacy.audioOriginalName, '')
  assert.equal(legacy.audioPrunedAt, '')
  assert.equal(legacy.audioPinned, false)
  assert.equal(legacy.audioError, '')
  assert.equal(legacy.exportedAt, '')
  assert.equal(projectMeeting(legacy).hasAudio, false)

  const sha = 'a'.repeat(64)
  const withAudio = normalizeMeeting({
    title: '有录音的会',
    date: '2026-10-21',
    audioPath: 'meeting-minutes/audio/2026-10-21-有录音的会-aaaaaaaa.m4a',
    audioSha256: sha.toUpperCase(),
    audioBytes: 12,
    audioSeconds: 3.56,
    audioOriginalName: '有录音的会.m4a',
    audioPinned: true,
    exportedAt: '2026-10-21T02:00:00.000Z',
  }, { now: NOW })
  assert.equal(withAudio.audioSha256, sha)
  assert.equal(withAudio.audioSeconds, 3.6)
  assert.equal(withAudio.audioPinned, true)
  assert.equal(projectMeeting(withAudio).hasAudio, true)

  // A patch keeps provenance unless it explicitly replaces it.
  const patched = normalizeMeeting({ title: '有录音的会（改）' }, { now: NOW, base: withAudio })
  assert.equal(patched.audioPath, withAudio.audioPath)
  assert.equal(patched.audioSha256, sha)
  assert.equal(patched.audioPinned, true)

  // Malformed digests and negative numbers degrade instead of throwing.
  const broken = normalizeMeeting({ title: '坏 hash', audioSha256: 'not-a-hash', audioBytes: -5, audioSeconds: -1 }, { now: NOW })
  assert.equal(broken.audioSha256, '')
  assert.equal(broken.audioBytes, 0)
  assert.equal(broken.audioSeconds, 0)
})

test('导出里带「录音来源」行，无音频的老记录不出现该行', () => {
  const sha = 'b'.repeat(64)
  const withAudio = normalizeMeeting({
    title: '带录音的会',
    date: '2026-10-21',
    transcript: '内容',
    transcriptSeconds: 61,
    audioPath: 'meeting-minutes/audio/2026-10-21-带录音的会-bbbbbbbb.m4a',
    audioSha256: sha,
    audioOriginalName: '带录音的会.m4a',
    summary: sampleSummary(),
  }, { now: NOW })
  const md = buildMarkdown(withAudio)
  assert.ok(md.includes('- 录音来源：带录音的会.m4a · sha256 bbbbbbbbbbbb'))
  assert.ok(md.includes('- 录音时长：1 分 1 秒'))
  const html = buildHtml(withAudio)
  assert.ok(html.includes('录音来源'))
  assert.ok(html.includes('sha256 bbbbbbbbbbbb'))

  const legacy = normalizeMeeting({ title: '老会议', date: '2026-10-20', transcript: '内容', summary: sampleSummary() }, { now: NOW })
  assert.ok(!buildMarkdown(legacy).includes('录音来源'))
  assert.ok(!buildHtml(legacy).includes('录音来源'))

  const pruned = normalizeMeeting({
    title: '副本已清理',
    date: '2026-10-21',
    audioPath: 'meeting-minutes/audio/x.m4a',
    audioSha256: sha,
    audioPrunedAt: '2026-10-22T00:00:00.000Z',
  }, { now: NOW })
  assert.ok(buildMarkdown(pruned).includes('副本已清理（hash 保留）'))
})

test('转写修订：原文保留、修订次数与时间可往返，导出标注修订', () => {
  const created = normalizeMeeting({ title: '修订会', transcript: '原始识别文本' }, { now: NOW })
  assert.equal(created.transcriptRaw, '原始识别文本')
  assert.equal(created.transcriptEdits, 0)
  assert.equal(created.transcriptEditedAt, '')
  assert.ok(!buildMarkdown(created).includes('经人工修订'))
  assert.ok(!buildHtml(created).includes('经人工修订'))

  const edited = normalizeMeeting({
    transcript: '手工改过的文本',
    transcriptEditedAt: '2026-10-21T02:00:00.000Z',
    transcriptEdits: 1,
  }, { now: NOW, base: created })
  assert.equal(edited.transcript, '手工改过的文本')
  assert.equal(edited.transcriptRaw, '原始识别文本')
  assert.equal(edited.transcriptEdits, 1)
  assert.equal(edited.transcriptEditedAt, '2026-10-21T02:00:00.000Z')
  assert.equal(projectMeeting(edited).transcriptEdits, 1)
  assert.ok(buildMarkdown(edited).includes('- 转写：经人工修订（1 次）'))
  assert.ok(buildHtml(edited).includes('经人工修订（1 次）'))
})

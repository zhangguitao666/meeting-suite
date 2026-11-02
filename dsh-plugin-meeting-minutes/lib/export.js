/**
 * Standalone document export for the meeting-minutes plugin.
 *
 * Two formats share one normalized meeting:
 * - `md`   — a portable Markdown minutes document,
 * - `html` — one self-contained, print-friendly HTML page with inline CSS
 *            (no external assets, no Harness runtime needed).
 *
 * @module dsh-plugin-meeting-minutes/export
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatMoment, todoProgress } from './model.js'

/** Escape text for HTML text nodes and attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Turn a title into a filesystem-safe fragment. */
export function safeFileName(text, fallback = '会议纪要') {
  const cleaned = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')

    .trim()
  return (cleaned === '' ? fallback : cleaned).slice(0, 60)
}

/** File extension per format. */
const EXTENSION = { md: 'md', html: 'html' }

/** One Markdown bullet list, or nothing. */
function bullets(items, empty = '（无）') {
  if (!Array.isArray(items) || items.length === 0) return [`- ${empty}`]
  return items.map((item) => `- ${item}`)
}

/**
 * Build the Markdown minutes document.
 * @param meeting - canonical meeting.
 */
export function buildMarkdown(meeting) {
  const summary = meeting.summary
  const lines = [
    `# ${meeting.title} · 会议纪要`,
    '',
    `- 日期：${meeting.date}`,
    `- 参会人：${meeting.attendees.length > 0 ? meeting.attendees.join('、') : '（未填写）'}`,
    `- 来源：${meeting.sourceType === 'recording' ? '录音转写' : meeting.sourceType === 'import' ? '导入记录' : '文本导入'}`,
    meeting.audioPath === '' ? '' : `- 录音来源：${audioSourceLabel(meeting)}`,
    meeting.transcriptSeconds > 0 ? `- 录音时长：${formatDuration(meeting.transcriptSeconds)}` : '',
    meeting.transcriptEdits > 0 ? `- 转写：经人工修订（${meeting.transcriptEdits} 次）` : '',
    `- 导出时间：${formatMoment(new Date())}`,
    '',
  ].filter((line) => line !== '')
  if (summary === null) {
    lines.push('## 原始文本', '', meeting.transcript.trim() === '' ? '（空）' : meeting.transcript, '')
    return lines.join('\n')
  }
  lines.push(
    '## 一句话结论',
    '',
    summary.oneLine || '（未生成）',
    '',
    '## 整体概述',
    '',
    summary.overview || '（未生成）',
    '',
    '## 关键要点',
    '',
    ...summary.keyPoints.map((item, index) => `${index + 1}. ${item}`),
    '',
  )
  if (summary.decisions.length > 0) {
    lines.push('## 会议决策', '')
    for (const decision of summary.decisions) {
      lines.push(`- ${decision.text}${decision.owner === '' ? '' : `（负责人：${decision.owner}）`}`)
    }
    lines.push('')
  }
  if (summary.risks.length > 0) {
    lines.push('## 风险 / 待确认', '')
    for (const risk of summary.risks) {
      const level = risk.level === 'high' ? '高' : risk.level === 'low' ? '低' : '中'
      lines.push(`- [${level}] ${risk.text}`)
    }
    lines.push('')
  }
  if (summary.sections.length > 0) {
    lines.push('## 分节纪要', '')
    for (const section of summary.sections) {
      lines.push(`### ${section.heading}`, '')
      lines.push(...bullets(section.bullets))
      lines.push('')
    }
  }
  if (summary.todos.length > 0) {
    lines.push('## 待办事项', '', '| 状态 | 交付物 | 负责人 | 截止 | 优先级 | 备注 |', '| :-- | :-- | :-- | :-- | :-- | :-- |')
    for (const todo of summary.todos) {
      lines.push(`| ${todo.calendarTaskId === null ? '待写入日历' : '已写入日历'} | ${todo.title} | ${todo.owner || '—'} | ${todo.due || '—'} | ${priorityLabel(todo.priority)} | ${todo.notes || '—'} |`)
    }
    lines.push('')
  }
  lines.push('## 原始转写', '', '```text', meeting.transcript.trim() === '' ? '（空）' : meeting.transcript, '```', '')
  return lines.join('\n')
}

/** Chinese duration label. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

/** Priority label used in documents. */
function priorityLabel(priority) {
  return priority === 'high' ? '高' : priority === 'low' ? '低' : '中'
}

/** Shared inline stylesheet for the standalone HTML document. */
const DOC_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#eef1f6;color:#1b2330;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;line-height:1.7;font-size:14px}
.doc{max-width:900px;margin:32px auto 56px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 18px 50px rgba(20,30,55,.14)}
.cover{padding:38px 44px 30px;background:linear-gradient(135deg,#12326b 0%,#1f56b8 58%,#2f8bd6 100%);color:#fff}
.cover h1{margin:0 0 14px;font-size:30px;line-height:1.35;letter-spacing:.3px}
.meta{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;color:rgba(255,255,255,.86)}
.meta b{color:#fff;font-weight:600}
.one-line{margin:22px 0 0;padding:14px 18px;border-radius:12px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);font-size:15px;font-weight:600;color:#fff}
.body{padding:30px 44px 40px}
h2{font-size:17px;margin:30px 0 12px;padding-left:11px;border-left:4px solid #1f56b8;line-height:1.3}
h2:first-child{margin-top:0}
.overview{color:#39465c;background:#f5f8fd;border-radius:12px;padding:14px 16px;border:1px solid #e2eaf7}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{border:1px solid #e4e9f2;border-radius:12px;padding:13px 15px;background:#fbfcfe}
.card .idx{display:inline-flex;width:20px;height:20px;border-radius:50%;background:#1f56b8;color:#fff;font-size:12px;align-items:center;justify-content:center;margin-right:7px;font-weight:700}
.card p{margin:0;color:#26324a}
.decision{display:flex;gap:10px;align-items:flex-start;border:1px solid #d9eee2;background:#f4fbf7;border-radius:10px;padding:11px 14px;margin-bottom:9px}
.decision .tick{color:#178a4c;font-weight:800}
.risk{border:1px solid #f3e2c8;background:#fffaf1;border-radius:10px;padding:11px 14px;margin-bottom:9px}
.risk .tag{display:inline-block;font-size:11px;padding:0 7px;border-radius:999px;margin-right:8px;border:1px solid #d8a24b;color:#a26b14}
.risk.high{border-color:#f1c6c6;background:#fff6f6}
.risk.high .tag{border-color:#cf5b5b;color:#b23a3a}
.section{border-left:2px solid #dfe6f3;padding:2px 0 2px 16px;margin:0 0 18px}
.section h3{font-size:14px;margin:0 0 7px;color:#16305f}
.section ul{margin:0;padding-left:18px;color:#34415a}
.section li{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e7ecf4;vertical-align:top}
th{background:#f5f8fd;color:#4a5972;font-weight:600;white-space:nowrap}
td.pushed{color:#178a4c;white-space:nowrap}
td.pending{color:#a26b14;white-space:nowrap}
.pri{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:#eef3fc;color:#2b5296}
.pri.high{background:#fdecec;color:#b23a3a}
.pri.low{background:#eef5ef;color:#38734f}
details{margin-top:8px;border:1px solid #e4e9f2;border-radius:12px;background:#fbfcfe}
summary{cursor:pointer;padding:12px 16px;font-weight:600;color:#33425c}
pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:0 16px 18px;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px;color:#44506a;max-height:520px;overflow:auto}
.foot{padding:16px 44px 26px;color:#8491a6;font-size:12px;border-top:1px solid #eef1f6}
@media print{body{background:#fff}.doc{box-shadow:none;margin:0;border-radius:0}.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}details{display:block}details>summary{list-style:none}pre{max-height:none}}
`

/**
 * Build the standalone HTML minutes document.
 * @param meeting - canonical meeting.
 */
export function buildHtml(meeting) {
  const summary = meeting.summary
  const progress = todoProgress(meeting)
  const coverMeta = [
    ['日期', meeting.date],
    ['参会人', meeting.attendees.length > 0 ? meeting.attendees.join('、') : '未填写'],
    ['来源', meeting.sourceType === 'recording' ? '录音转写' : meeting.sourceType === 'import' ? '导入记录' : '文本导入'],
    meeting.audioPath === '' ? null : ['录音来源', audioSourceLabel(meeting)],
    meeting.transcriptSeconds > 0 ? ['录音时长', formatDuration(meeting.transcriptSeconds)] : null,
    meeting.transcriptEdits > 0 ? ['转写', `经人工修订（${meeting.transcriptEdits} 次）`] : null,
    ['待办', progress.total === 0 ? '无' : `${progress.pushed}/${progress.total} 已写入日历`],
  ].filter((entry) => entry !== null)

  const parts = []
  parts.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
  parts.push(`<title>${escapeHtml(meeting.title)} · 会议纪要</title>`)
  parts.push(`<style>${DOC_CSS}</style></head><body><div class="doc">`)
  parts.push('<div class="cover">')
  parts.push(`<h1>${escapeHtml(meeting.title)}</h1>`)
  parts.push('<div class="meta">')
  for (const [label, value] of coverMeta) {
    parts.push(`<span>${escapeHtml(label)}：<b>${escapeHtml(value)}</b></span>`)
  }
  parts.push('</div>')
  if (summary !== null && summary.oneLine !== '') {
    parts.push(`<div class="one-line">${escapeHtml(summary.oneLine)}</div>`)
  }
  parts.push('</div><div class="body">')

  if (summary === null) {
    parts.push('<h2>原始文本</h2>')
    parts.push(`<pre style="padding:0">${escapeHtml(meeting.transcript)}</pre>`)
  } else {
    if (summary.overview !== '') {
      parts.push('<h2>整体概述</h2>')
      parts.push(`<div class="overview">${escapeHtml(summary.overview)}</div>`)
    }
    if (summary.keyPoints.length > 0) {
      parts.push('<h2>关键要点</h2><div class="grid">')
      summary.keyPoints.forEach((point, index) => {
        parts.push(`<div class="card"><p><span class="idx">${index + 1}</span>${escapeHtml(point)}</p></div>`)
      })
      parts.push('</div>')
    }
    if (summary.decisions.length > 0) {
      parts.push('<h2>会议决策</h2>')
      for (const decision of summary.decisions) {
        const owner = decision.owner === '' ? '' : `<span style="color:#5c6a82;margin-left:6px">负责人：${escapeHtml(decision.owner)}</span>`
        parts.push(`<div class="decision"><span class="tick">✓</span><div>${escapeHtml(decision.text)}${owner}</div></div>`)
      }
    }
    if (summary.risks.length > 0) {
      parts.push('<h2>风险 / 待确认</h2>')
      for (const risk of summary.risks) {
        const level = risk.level === 'high' ? '高' : risk.level === 'low' ? '低' : '中'
        parts.push(`<div class="risk ${escapeHtml(risk.level)}"><span class="tag">${level}</span>${escapeHtml(risk.text)}</div>`)
      }
    }
    if (summary.sections.length > 0) {
      parts.push('<h2>分节纪要</h2>')
      for (const section of summary.sections) {
        parts.push(`<div class="section"><h3>${escapeHtml(section.heading)}</h3><ul>`)
        if (section.bullets.length === 0) parts.push('<li>（无）</li>')
        for (const bullet of section.bullets) parts.push(`<li>${escapeHtml(bullet)}</li>`)
        parts.push('</ul></div>')
      }
    }
    if (summary.todos.length > 0) {
      parts.push('<h2>待办事项</h2><table><thead><tr><th>状态</th><th>交付物</th><th>负责人</th><th>截止</th><th>优先级</th><th>备注</th></tr></thead><tbody>')
      for (const todo of summary.todos) {
        const pushed = todo.calendarTaskId !== null
        parts.push('<tr>')
        parts.push(`<td class="${pushed ? 'pushed' : 'pending'}">${pushed ? '已写入日历' : '待写入'}</td>`)
        parts.push(`<td>${escapeHtml(todo.title)}</td>`)
        parts.push(`<td>${escapeHtml(todo.owner || '—')}</td>`)
        parts.push(`<td>${escapeHtml(todo.due || '—')}</td>`)
        parts.push(`<td><span class="pri ${escapeHtml(todo.priority)}">${priorityLabel(todo.priority)}</span></td>`)
        parts.push(`<td>${escapeHtml(todo.notes || '—')}</td>`)
        parts.push('</tr>')
      }
      parts.push('</tbody></table>')
    }
    parts.push('<h2>原始转写</h2>')
    parts.push(`<details><summary>展开全文（${meeting.transcript.length} 字）</summary><pre>${escapeHtml(meeting.transcript)}</pre></details>`)
  }
  parts.push('</div>')
  parts.push(`<div class="foot">由 DeepSeek Harness 会议纪要插件生成 · ${escapeHtml(formatMoment(new Date()))}${summary === null ? '' : ` · 模型：${escapeHtml(summary.model || '未知')}`}</div>`)
  parts.push('</div></body></html>')
  return parts.join('\n')
}

/** Harness home (`$DSH_HOME`), the base of every local plugin path. */
export function resolveDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Plugin data directory: `$DSH_HOME/meeting-minutes/`.
 * Both `exports/` and `audio/` derive from it, so they never diverge.
 */
export function resolveMeetingDataDir(home = resolveDshHome()) {
  return join(home, 'meeting-minutes')
}

/** Resolve the export directory under the harness home. */
export function resolveExportDir(home = resolveDshHome()) {
  return join(resolveMeetingDataDir(home), 'exports')
}

/**
 * One-line audio provenance label, shared by exports and tool output.
 * Empty when the meeting has no retained recording (text imports, legacy rows).
 */
export function audioSourceLabel(meeting) {
  if (meeting === null || meeting === undefined) return ''
  if (typeof meeting.audioPath !== 'string' || meeting.audioPath === '') return ''
  const name = typeof meeting.audioOriginalName === 'string' && meeting.audioOriginalName !== ''
    ? meeting.audioOriginalName
    : meeting.audioPath
  const parts = [name]
  if (typeof meeting.audioSha256 === 'string' && meeting.audioSha256 !== '') parts.push(`sha256 ${meeting.audioSha256.slice(0, 12)}`)
  if (typeof meeting.audioPrunedAt === 'string' && meeting.audioPrunedAt !== '') parts.push('副本已清理（hash 保留）')
  return parts.join(' · ')
}

/**
 * Render and persist one export.
 * @param meeting - canonical meeting.
 * @param format - `html` or `md`.
 * @param options - `dir` (override export directory).
 * @returns `{ format, filename, content, path }`.
 */
export async function exportMeeting(meeting, format = 'html', options = {}) {
  const kind = format === 'md' ? 'md' : 'html'
  const content = kind === 'md' ? buildMarkdown(meeting) : buildHtml(meeting)
  const filename = `${meeting.date}-${safeFileName(meeting.title)}.${EXTENSION[kind]}`
  const dir = options.dir ?? resolveExportDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, filename)
  await writeFile(path, content, 'utf8')
  return { format: kind, filename, content, path }
}

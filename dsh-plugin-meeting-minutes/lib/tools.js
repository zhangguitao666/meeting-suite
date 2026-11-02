/**
 * Model-facing tools for the meeting-minutes plugin.
 *
 * These are plain ToolDefinition objects registered directly on `ctx.tools`:
 * the plugin ships as a local package with zero bare imports, so it cannot call
 * `defineTool` from `@deepseek-ai/dsh-tools`. Registering raw means the registry
 * does not pre-validate arguments, so every `execute` validates its own input
 * and throws a Chinese, model-readable error.
 *
 * @module dsh-plugin-meeting-minutes/tools
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { isGenericTitle, meetingLine, projectMeeting, todoProgress } from './model.js'
import { sortMeetings } from './store.js'
import { audioSourceLabel, exportMeeting } from './export.js'
import { storeAudio } from './audio-store.js'

/** Every tool declares a text-only canonical value. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

/** Turn a thrown value into the Chinese message the model reads. */
function fail(error) {
  throw new Error(error instanceof Error ? error.message : String(error))
}

/** Assert the model passed a usable string. */
function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

/** Resolve a meeting by id or a unique title keyword. */
function locate(store, args) {
  const reference = args?.id ?? args?.match
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error('需要提供 id 或 match 来定位会议（先用 meeting_list 查看会议列表）')
  }
  const meeting = store.find(reference)
  if (meeting === null) throw new Error(`没有找到唯一匹配的会议：${reference}`)
  return meeting
}

/** Human-readable block for one summarized meeting. */
export function describeMeeting(meeting, options = {}) {
  const lines = [meetingLine(meeting)]
  const audioLabel = audioSourceLabel(meeting)
  if (audioLabel !== '') lines.push(`录音来源：${audioLabel}`)
  if (meeting.audioError !== '') lines.push(`转写失败原因：${meeting.audioError}（可对同一会议重新转写）`)
  if (meeting.transcriptEdits > 0) lines.push(`转写：经人工修订 ${meeting.transcriptEdits} 次（原文已保留，导出会标注）`)
  const summary = meeting.summary
  if (summary === null) {
    lines.push('（还没有生成纪要）')
    return lines.join('\n')
  }
  if (summary.oneLine !== '') lines.push(`结论：${summary.oneLine}`)
  if (summary.overview !== '') lines.push(`概述：${summary.overview}`)
  if (summary.keyPoints.length > 0) {
    lines.push('关键要点：')
    for (const point of summary.keyPoints) lines.push(`- ${point}`)
  }
  if (summary.decisions.length > 0) {
    lines.push('决策：')
    for (const decision of summary.decisions) {
      lines.push(`- ${decision.text}${decision.owner === '' ? '' : `（${decision.owner}）`}`)
    }
  }
  if (summary.risks.length > 0) {
    lines.push('风险/待确认：')
    for (const risk of summary.risks) lines.push(`- ${risk.text}`)
  }
  if (summary.todos.length > 0) {
    lines.push(`待办（${todoProgress(meeting).pushed}/${summary.todos.length} 已写入任务日历）：`)
    for (const todo of summary.todos) {
      const due = todo.due === '' ? '未排期' : todo.due
      const owner = todo.owner === '' ? '未指定' : todo.owner
      const status = todo.calendarTaskId === null ? '待写入' : `已写入(${todo.calendarTaskId})`
      lines.push(`- [${todo.id}] ${todo.title} · ${owner} · ${due} · ${todo.priority} · ${status}`)
    }
  }
  if (options.includeTranscript === true) {
    const transcript = meeting.transcript
    const excerpt = transcript.length > 6000 ? `${transcript.slice(0, 6000)}…（共 ${transcript.length} 字）` : transcript
    lines.push('原始文本：', excerpt === '' ? '（空）' : excerpt)
  } else if (meeting.transcript !== '') {
    lines.push(`原始文本：${meeting.transcript.length} 字（需要全文请传 includeTranscript: true）`)
  }
  return lines.join('\n')
}

/** 统计 transcript 里以某个说话人标签开头的行数。 */
function countSpeakerLines(transcript, label) {
  if (typeof transcript !== 'string' || transcript === '' || label === '') return 0
  const prefix = `${label}：`
  return transcript.split('\n').filter((line) => line.startsWith(prefix)).length
}

/** 说话人列表的中文描述（工具输出）。 */
export function describeSpeakers(meeting) {
  const speakers = Array.isArray(meeting.speakers) ? meeting.speakers : []
  if (speakers.length === 0) {
    return `会议「${meeting.title}」还没有识别出说话人。\n说明：只有实时录音（按停顿切片转写）才会自动加说话人标签；导入的录音/文本没有说话人信息。`
  }
  const lines = [`会议「${meeting.title}」共有 ${speakers.length} 位说话人：`]
  for (const speaker of speakers) {
    const turns = countSpeakerLines(meeting.transcript, speaker.label)
    lines.push(`- [${speaker.id}] ${speaker.label}${turns > 0 ? ` · ${turns} 段` : ''}`)
  }
  lines.push('可以用 meeting_speakers（action=rename, speakerId=..., name=张三）把说话人改成人名，转写里的旧标签会同步替换。')
  return lines.join('\n')
}

/**
 * Register the meeting tools.
 * @param ctx - Cordis context carrying the `tools` service.
 * @param deps - `store`, `asr`, `summarizer`, `calendar`.
 * @returns disposers for every registration.
 */
export function registerTools(ctx, deps) {
  const { store, asr, summarizer, calendar, autoIngest, speakerTagger } = deps
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'meeting_list',
    description: '列出会议纪要库里的会议（按日期倒序），返回标题、日期、参会人、是否已生成纪要、待办写入进度。用 query 按标题/参会人/正文模糊搜索。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '按标题、参会人、转写正文模糊搜索（可选）' },
        limit: { type: 'integer', description: '最多返回几条，默认 20' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      const limit = Number.isFinite(Number(args?.limit)) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
      let meetings = sortMeetings(store.snapshot().meetings)
      if (query !== '') {
        meetings = meetings.filter((meeting) => `${meeting.title} ${meeting.attendees.join(' ')} ${meeting.transcript}`.toLowerCase().includes(query))
      }
      const shown = meetings.slice(0, limit)
      const lines = [`会议纪要库 · 共 ${meetings.length} 场${query === '' ? '' : `（匹配“${query}”）`}`, '']
      if (shown.length === 0) lines.push('（没有会议记录）')
      for (const meeting of shown) {
        const progress = todoProgress(meeting)
        const facts = [
          `[${meeting.id}] ${meeting.title}`,
          meeting.date,
          meeting.attendees.length === 0 ? '参会人未填' : meeting.attendees.join('、'),
          meeting.summary === null ? '未总结' : '已总结',
        ]
        if (progress.total > 0) facts.push(`待办 ${progress.pushed}/${progress.total} 已写入日历`)
        lines.push(`- ${facts.join(' · ')}`)
      }
      return lines.join('\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_get',
    description: '读取一场会议纪要的完整内容：一句话结论、概述、要点、决策、风险、待办（含是否已写入日历）与原始文本。用 id（列表里的 [mt_xxx]）或唯一标题关键词定位。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '会议 id' },
        match: { type: 'string', description: '标题关键词（唯一匹配时使用）' },
        includeTranscript: { type: 'boolean', description: '是否附带原始文本（最多 6000 字），默认 false' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const meeting = locate(store, args)
      return describeMeeting(meeting, { includeTranscript: args?.includeTranscript === true })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_create',
    description: [
      '新建一条会议记录，把用户提供的腾讯会议纪要/聊天记录/转写文本存进会议纪要库。',
      '典型用法：用户贴来一段会议文本，你直接把原文放进 transcript（不要先总结），再调用 meeting_summarize 生成结构化纪要。',
      'date 用 YYYY-MM-DD；attendees 可传数组或“张三、李四”。sourceType 默认 text（腾讯会议纪要文本），导入文件用 import。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '会议标题（必填）' },
        date: { type: 'string', description: '会议日期，如 2026-10-21' },
        attendees: { type: 'array', items: { type: 'string' }, description: '参会人列表' },
        transcript: { type: 'string', description: '会议原文/转写文本' },
        sourceType: { type: 'string', enum: ['text', 'recording', 'import'], description: '来源类型' },
        notes: { type: 'string', description: '补充说明（可选）' },
      },
      required: ['title'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const title = requireText(args?.title, 'title')
      const meeting = await store.add({
        title,
        date: args?.date,
        attendees: args?.attendees,
        transcript: args?.transcript,
        sourceType: args?.sourceType,
        notes: args?.notes,
      })
      return `已创建会议记录：${meetingLine(meeting)}\n下一步：调用 meeting_summarize（id: ${meeting.id}）生成结构化纪要。`
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_transcribe',
    description: [
      '把本机一段录音/视频文件转成文字，并自动新建会议记录。默认走本机 VoiceStudio（accurate + 说话人分离，转写里带「说话人N：」前缀、可再用 meeting_speakers 改名）；VoiceStudio 没开时自动回退宿主的 SenseVoice 离线识别。',
      '支持 wav/mp3/m4a/mp4/aac 等；非 16kHz WAV 会先用 macOS afconvert 转换。',
      '转写前会把音频复制到会议数据目录并记录 sha256，转写失败也保留副本，可对同一会议重试。',
      '典型用法：用户说“把这个会议录音转成纪要”，你先找到文件绝对路径，再调用本工具；随后调用 meeting_summarize。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        audioPath: { type: 'string', description: '录音/视频文件的绝对路径' },
        title: { type: 'string', description: '会议标题（默认用文件名）' },
        date: { type: 'string', description: '会议日期，默认今天' },
        attendees: { type: 'array', items: { type: 'string' }, description: '参会人（可选）' },
        language: { type: 'string', description: '识别语言提示，默认 zh' },
      },
      required: ['audioPath'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const audioPath = requireText(args?.audioPath, 'audioPath')
      let bytes
      try {
        bytes = await readFile(audioPath)
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`音频文件不存在：${audioPath}`)
        throw new Error(`读取音频文件失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const title = typeof args?.title === 'string' && args.title.trim() !== '' ? args.title.trim() : basename(audioPath)
      // Create the record first: a failed ASR run still leaves a traceable entry
      // pointing at the retained audio copy.
      const meeting = await store.add({
        title,
        date: args?.date,
        attendees: args?.attendees,
        transcript: '',
        transcriptSeconds: 0,
        sourceType: 'recording',
        audioOriginalName: basename(audioPath),
      })
      let audio = null
      let copyError = ''
      try {
        audio = await storeAudio({ bytes, sourceName: audioPath, title, date: meeting.date })
        await store.patch(meeting.id, {
          audioPath: audio.relPath,
          audioSha256: audio.sha256,
          audioBytes: audio.bytes,
          audioOriginalName: basename(audioPath),
        })
      } catch (error) {
        copyError = error instanceof Error ? error.message : String(error)
      }
      const duplicate = audio === null ? null : store.findByAudioSha256(audio.sha256)
      const duplicateLine = duplicate === null || duplicate.id === meeting.id
        ? ''
        : `注意：同一录音已在会议 ${duplicate.id}「${duplicate.title}」里，本次仍新建了记录。`
      let result
      try {
        result = await asr.transcribeFile(audioPath, { language: args?.language ?? 'zh' })
        if (result.text.trim() === '') throw new Error('识别结果为空：音频可能没有语音，或语种不受支持。')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await store.patch(meeting.id, { audioError: message })
        const kept = audio === null ? (copyError === '' ? '未保留' : `未保留（${copyError}）`) : audio.relPath
        throw new Error(`${message}\n音频副本：${kept}\n会议记录已建立（${meeting.id}），可对同一会议重试转写。`)
      }
      const updated = await store.appendTranscript(meeting.id, result.text, result.audioSeconds)
      await store.patch(meeting.id, { audioSeconds: result.audioSeconds, audioError: '' })
      // VoiceStudio 的 diarization 结果：把说话人登记进会议，transcript 里的
      // 「说话人N：」前缀就能被 meeting_speakers 改名（和实时录音同一套链路）。
      let speakerNote = ''
      if (Array.isArray(result.speakers) && result.speakers.length > 0) {
        try {
          await store.setSpeakers(meeting.id, result.speakers)
          speakerNote = `说话人：识别出 ${result.speakers.length} 位（可用 meeting_speakers 改名）`
        } catch (error) {
          speakerNote = `说话人登记失败：${error instanceof Error ? error.message : String(error)}`
        }
      }
      const backendNote = result.backend === 'voicestudio'
        ? `转写后端：VoiceStudio（accurate${result.diarizationError === '' ? '' : `，说话人分离失败：${result.diarizationError}`}）`
        : '转写后端：宿主 SenseVoice'
      const preview = result.text.length > 500 ? `${result.text.slice(0, 500)}…` : result.text
      const label = audioSourceLabel(updated ?? meeting)
      return [
        `已转写 ${Math.round(result.audioSeconds)} 秒音频并创建会议：${meetingLine(updated ?? meeting)}`,
        label === '' ? '' : `录音来源：${label}`,
        backendNote,
        speakerNote,
        `识别耗时 ${Math.round(result.inferenceSeconds)} 秒，文本 ${result.text.length} 字。`,
        duplicateLine,
        '识别结果预览：',
        preview,
        `下一步：调用 meeting_summarize（id: ${meeting.id}）生成结构化纪要。`,
      ].filter((line) => line !== '').join('\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_summarize',
    description: [
      '用当前默认模型把一场会议文本总结成结构化纪要：一句话结论、概述、关键要点、决策、风险、分节纪要、参会人、待办（含负责人/截止/优先级）。',
      '调用前请确保会议已有原文（先 meeting_create 或 meeting_transcribe）；已有纪要时再次调用会重新生成，并保留已写入日历的待办关联。',
      '生成后可用 meeting_push_todos 把待办写入任务日历。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '会议 id' },
        match: { type: 'string', description: '标题关键词（唯一匹配时使用）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const meeting = locate(store, args)
      const summary = await summarizer.summarize(meeting)
      const patch = {}
      if (meeting.attendees.length === 0 && summary.attendees.length > 0) {
        patch.attendees = summary.attendees
      }
      let renamedTo = null
      if (summary.suggestedTitle !== ''
        && summary.suggestedTitle !== meeting.title
        && isGenericTitle(meeting.title)) {
        patch.title = summary.suggestedTitle
        renamedTo = summary.suggestedTitle
      }
      if (Object.keys(patch).length > 0) await store.patch(meeting.id, patch)
      const updated = await store.setSummary(meeting.id, summary)
      return `已生成会议纪要：\n${describeMeeting(updated)}${renamedTo === null ? '' : `\n（会议标题已自动命名为「${renamedTo}」，可随时修改）`}`
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_push_todos',
    description: [
      '把会议纪要里确认过的待办写入「任务日历」插件（写入后会出现在日历面板，并按开始/截止时间提醒）。',
      'todoIds 省略时写入所有尚未写入的待办；也可只传用户确认过的几个 id（todos 里的 [td_xxx]）。',
      '写入前请先让用户确认待办内容；重复调用不会重复写入已写入的待办（除非显式指定其 id）。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '会议 id' },
        match: { type: 'string', description: '标题关键词（唯一匹配时使用）' },
        todoIds: { type: 'array', items: { type: 'string' }, description: '要写入的待办 id 列表（可选）' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const meeting = locate(store, args)
      const todoIds = Array.isArray(args?.todoIds) ? args.todoIds.map(String) : undefined
      let result
      try {
        result = await calendar.pushTodos(meeting, todoIds)
      } catch (error) {
        if (Array.isArray(error?.created)) {
          for (const entry of error.created) await store.markTodoPushed(meeting.id, entry.todoId, entry.calendarTaskId)
        }
        fail(error)
      }
      for (const entry of result.created) {
        await store.markTodoPushed(meeting.id, entry.todoId, entry.calendarTaskId)
      }
      const updated = store.get(meeting.id)
      const progress = todoProgress(updated)
      return [
        `已写入任务日历 ${result.created.length} 条（待办进度 ${progress.pushed}/${progress.total}）：`,
        ...result.created.map((entry) => `- ${entry.title} → 日历任务 ${entry.calendarTaskId}`),
        '日历面板会自动刷新；提醒规则沿用任务日历插件的设置。',
      ].join('\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_export',
    description: '把会议纪要导出成独立文档：format=html（带样式、可直接打开/打印/分享）或 md（Markdown）。返回写入的文件路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '会议 id' },
        match: { type: 'string', description: '标题关键词（唯一匹配时使用）' },
        format: { type: 'string', enum: ['html', 'md'], description: '导出格式，默认 html' },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const meeting = locate(store, args)
      const exported = await exportMeeting(meeting, args?.format === 'md' ? 'md' : 'html')
      return `已导出会议纪要（${exported.format}）：${exported.path}\n可用系统浏览器直接打开${exported.format === 'html' ? '，也适合打印成 PDF' : ''}。`
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_auto_ingest',
    description: [
      '管理会议自动入库：腾讯会议结束后，本机录制完成后自动转成文字并存进会议纪要库（标记为待整理）。',
      'action=status 查看状态（是否启用、腾讯本地录制数据库是否可用、扫描时间、已自动导入数量）；',
      'action=enable / disable 开关；action=scan 立即扫描一次；action=set_dirs 设置额外监控目录（audio/video/txt/md/docx 文件会被自动导入）。',
      '说明：腾讯会议云端“智能纪要”没有个人 API，本工具抓的是本机录制文件；若没有本地录制，可把导出的纪要文件放进监控目录，或使用企业版 API。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'enable', 'disable', 'scan', 'set_dirs'], description: '操作' },
        dirs: { type: 'array', items: { type: 'string' }, description: 'action=set_dirs 时的目录列表（绝对路径或 ~ 开头）' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (autoIngest === undefined) throw new Error('自动入库不可用')
      const action = args?.action
      if (action === 'enable') await autoIngest.setConfig({ enabled: true })
      else if (action === 'disable') await autoIngest.setConfig({ enabled: false })
      else if (action === 'set_dirs') {
        if (!Array.isArray(args?.dirs)) throw new Error('action=set_dirs 需要传 dirs 数组')
        await autoIngest.setConfig({ dirs: args.dirs })
      } else if (action === 'scan') {
        void autoIngest.scanNow().catch(() => {})
      } else if (action !== 'status' && action !== undefined) {
        throw new Error(`未知 action：${String(action)}`)
      }
      const status = autoIngest.status()
      const lines = [
        `自动入库：${status.enabled ? '开启' : '关闭'}${status.scanning ? '（扫描中）' : ''}`,
        `- 腾讯会议本地录制：${status.tencentAvailable ? `可用（识别到 ${status.tencentRecords} 条已完成录制）` : `不可用（${status.tencentError ?? '未找到数据库'}）`}`,
        status.tencentDbPath === null ? '' : `- 数据库：${status.tencentDbPath}`,
        `- 监控目录：${status.dirs.length === 0 ? '（未设置）' : status.dirs.join('、')}`,
        `- 上次扫描：${status.lastScanAt ?? '尚未扫描'} · 已自动导入 ${status.importedCount} 场 · 失败 ${status.failedCount} 个来源`,
        status.lastError === null ? '' : `- 最近错误：${status.lastError}`,
        status.recent.length === 0 ? '' : `- 最近自动导入：${status.recent.map((entry) => entry.title || entry.path).join('；')}`,
      ].filter((line) => line !== '')
      return lines.join('\n')
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'meeting_speakers',
    description: [
      '查看或修改一场会议的说话人标签。实时录音转写时会用本地声纹识别自动给每段文本加「说话人N：」前缀。',
      'action=list 列出已识别的说话人与各自的段数；action=rename 把某个 speakerId 改成人名（如 说话人1 → 张三），',
      '并同步替换 transcript 与 transcriptRaw 里的旧前缀。导入的录音/文本没有说话人信息。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '会议 id' },
        match: { type: 'string', description: '标题关键词（唯一匹配时使用）' },
        action: { type: 'string', enum: ['list', 'rename'], description: '操作：list 查看，rename 改名' },
        speakerId: { type: 'string', description: 'action=rename 时的说话人 id（如 speaker-1）' },
        name: { type: 'string', description: 'action=rename 时的新名字（如 张三）' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await store.load()
      const meeting = locate(store, args)
      const action = typeof args?.action === 'string' ? args.action.trim() : 'list'
      if (action === 'list') return describeSpeakers(meeting)
      if (action !== 'rename') throw new Error(`未知 action：${action}（可用 list / rename）`)
      const speakerId = requireText(args?.speakerId, 'speakerId')
      const name = requireText(args?.name, 'name')
      if (!meeting.speakers.some((entry) => entry.id === speakerId)) {
        const error = new Error(`未找到说话人：${speakerId}（先用 action=list 查看）`)
        error.status = 404
        throw error
      }
      const updated = await store.renameSpeaker(meeting.id, speakerId, name)
      try {
        if (typeof speakerTagger?.rename === 'function') speakerTagger.rename(meeting.id, speakerId, name)
      } catch {
        // The in-memory registry is an optimization; the store is the truth.
      }
      return [`已把 ${speakerId} 重命名为「${name}」，转写里的旧标签已同步替换。`, describeSpeakers(updated)].join('\n')
    },
  }))

  return disposers
}

# 会议纪要插件 · 宿主↔浏览器 API 契约 v1

插件包：`dsh-plugin-meeting-minutes`
- 宿主入口 `lib/index.js`（单行 patch `meeting-minutes`）
- 浏览器入口 `lib/client.js`（`window.__ModuleLoader__.load` 手写 bundle）
- 所有接口挂在 `ctx.webServer` 的 `/dsh-meeting` 前缀下，只允许回环地址，JSON 进/JSON 出。
- 出错统一：HTTP 400/404 + `{ ok: false, error: '中文错误信息' }`。

## 数据形状

Meeting（完整）：

```json
{
  "id": "mt_xxx",
  "title": "Q4 启动会",
  "date": "2026-10-21",
  "attendees": ["张三", "李四"],
  "sourceType": "text | recording | import",
  "transcript": "……全文……",
  "transcriptSeconds": 183.2,
  "speakers": [{ "id": "speaker-1", "label": "说话人1" }],
  "notes": "",
  "createdAt": "2026-10-21T09:00:00.000Z",
  "updatedAt": "2026-10-21T09:30:00.000Z",
  "summary": null
}
```

`speakers` 是本地说话人识别（CAM++，全本地推理）得到的说话人列表：`id` 稳定不变，`label` 可改名，
默认 `说话人1`、`说话人2`……；未启用（`MEETING_SPEAKER_DISABLE=1`）或识别失败时为空数组 `[]`。
带说话人标签时 `transcript` 每行格式为 **`说话人N：文本`**，未识别时保持纯文本。

`summary`（LLM 生成，`todos` 由宿主补 id 与推送状态）：

```json
{
  "oneLine": "一句话结论",
  "overview": "200 字以内概述",
  "keyPoints": ["要点1", "要点2"],
  "decisions": [{ "text": "决定做什么", "owner": "张三" }],
  "risks": [{ "text": "风险/待确认", "level": "low | medium | high" }],
  "sections": [{ "heading": "议题一：预算", "bullets": ["……"] }],
  "attendees": ["张三"],
  "todos": [{
    "id": "td_xxx",
    "title": "输出 Q4 预算初稿",
    "owner": "张三",
    "due": "2026-10-28 18:00 | 2026-10-28 | 下周三 | ''",
    "priority": "high | normal | low",
    "notes": "验收标准……",
    "calendarTaskId": null,
    "pushedAt": null
  }],
  "generatedAt": "2026-10-21T09:31:00.000Z",
  "model": "deepseek-chat"
}
```

列表摘要（`GET /state` 的 `meetings[]`）：

```json
{
  "id": "mt_xxx", "title": "…", "date": "2026-10-21", "attendees": ["…"],
  "sourceType": "text", "hasSummary": true, "todoCount": 3, "pendingTodoCount": 2,
  "transcriptChars": 12000, "transcriptSeconds": 183.2, "updatedAt": "…"
}
```

## 接口

| 方法 | 路径 | 请求 | 响应 |
| :-- | :-- | :-- | :-- |
| GET | `/state` | — | `{ ok, now, today, config, speech, calendar, meetings: [摘要] }` |
| GET | `/meetings/:id` | — | `{ ok, meeting }` |
| POST | `/meetings` | `{ title, date?, attendees?, sourceType?, transcript?, notes? }` | `{ ok, meeting }` |
| PATCH | `/meetings/:id` | `{ title?, date?, attendees?, transcript?, appendTranscript?, notes? }` | `{ ok, meeting }` |
| DELETE | `/meetings/:id` | — | `{ ok }` |
| POST | `/meetings/:id/summarize` | `{ force?: boolean }` | `{ ok, meeting }`（生成/重生成纪要，可能较慢） |
| POST | `/meetings/:id/transcribe?language=zh&live=1&index=N` | **原始音频 WAV 字节**（`audio/wav`，16kHz 单声道 PCM16） | `{ ok, text, speaker: { id, label } \| null, audioSeconds, inferenceSeconds, transcript, transcriptSeconds, audio, duplicate }`（`live=1` 是实时录音切片：做本地说话人标注并暂存切片；否则整段转写、不做声纹标注） |
| GET | `/meetings/:id/speakers` | — | `{ ok, speakers: [{ id, label }] }` |
| POST | `/meetings/:id/speakers/:speakerId/rename` | `{ name }` | `{ ok, meeting }`（只改标签、不重新推理；`name` 为空或过长 → 400） |
| GET | `/speech/status` | — | `{ ok, speech }` |
| POST | `/speech/prepare` | `{ providerId? }` | `{ ok, speech }`（触发本地模型下载/加载） |
| PATCH | `/meetings/:id/todos/:todoId` | `{ title?, owner?, due?, priority?, notes? }` | `{ ok, meeting }` |
| POST | `/meetings/:id/todos/push` | `{ todoIds?: string[] }`（缺省=所有未推送的） | `{ ok, created: [{todoId, calendarTaskId, title}], meeting, calendar }` |
| GET | `/meetings/:id/export?format=html\|md` | — | `{ ok, format, filename, content, path }` |

`GET /state` 里的公共字段：

```json
{
  "config": {
    "llm": { "provider": "deepseek-account", "model": "deepseek-chat" },
    "asr": { "mode": "local | http", "providerId": "sensevoice-local", "language": "zh" }
  },
  "speech": {
    "available": true, "error": null,
    "providers": [{
      "id": "sensevoice-local", "name": "SenseVoice（本地）", "location": "host-local",
      "languages": ["zh", "auto"],
      "phase": "ready | unprepared | standby | downloading | checking | loading | failed",
      "progress": { "resource": "…", "completedBytes": 0, "totalBytes": 0 },
      "message": "失败原因"
    }],
    "selection": { "providerId": "sensevoice-local", "language": "zh" },
    "maxDurationSeconds": 300,
    "maxAudioBytes": 4194304
  },
  "calendar": { "available": true, "route": "/dsh-task-calendar", "error": null }
}
```

## Agent 工具

宿主同时把这套数据暴露成模型工具（与 HTTP 路由同源同存储）：

| 工具 | 参数 | 作用 |
| :-- | :-- | :-- |
| `meeting_speakers` | `{ id \| match, action: 'list' \| 'rename', speakerId?, name? }` | `action: 'list'` 列出会议的 `speakers`；`action: 'rename'` 必须同时给 `speakerId` 与 `name`，只改标签、不重新推理。`id` 与 `match`（唯一标题关键词）二选一。 |

## 浏览器端约定

- 录音：`navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder`；停止后用
  `AudioContext.decodeAudioData` 解码，重采样为 **16kHz 单声道 PCM16 WAV**，按 **≤90 秒**切片
  （每片 ≤ 2.88MB），顺序 `POST /meetings/:id/transcribe`，把返回的 `text` 用换行拼起来，
  最后 `PATCH /meetings/:id { transcript }`。每次转写前先 `GET /speech/status`；若
  `phase` 不是 `ready`，调用 `POST /speech/prepare`，每 1–1.5 秒轮询 `/speech/status` 展示
  `downloading/downloadingBytes` 或 `loading`，失败时提示改用文本导入。
- 音频文件导入同理：`<input type=file accept="audio/*,video/*">` 读成 ArrayBuffer →
  `decodeAudioData` → 同样切片转写。若浏览器解码失败，提示换格式（wav/mp3/m4a）。
- 腾讯会议纪要文本导入：粘贴框 + `.txt/.md/.json` 文件读取（`file.text()`），
  `POST /meetings`（`sourceType: "text"`），或对已打开会议 `PATCH transcript`。
- 所有写操作成功后重新 `GET /state` 和 `GET /meetings/:id` 刷新界面。
- 说话人：转写带标签时行首是 `说话人N：`；`GET /meetings/:id/speakers` 拿 `speakers: [{id, label}]`，
  改名调 `POST /meetings/:id/speakers/:speakerId/rename { name }`，成功后重新 `GET /meetings/:id`。
  实时转写的切段由本地 VAD 决定，停顿时长阈值存浏览器端
  `localStorage['dsh.meeting.vad.silenceSeconds']`（支持 `1.5 / 3 / 5`，默认 `1.5`）。
- 界面只用 `--dsw-alias-*` 主题 token；不要引用任何 Harness Client 包（除 React/jsx-runtime）。
- 侧栏图标：`sidebar.panellist`，`id: 'meeting-minutes'`, `label: '会议纪要'`, glyph 为
  `<svg currentColor>`；主面板：`main` key `'meeting-minutes'`。
- 导出用 Blob 下载返回的 `content`；同时展示 `path`。

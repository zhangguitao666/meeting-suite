#!/usr/bin/env node
/**
 * 预先准备本地说话人识别模型（CAM++ 声纹向量，约 28MB）。
 *
 * 模型默认放在 `$DSH_HOME/meeting-minutes/speaker/`，插件在首次做说话人识别时会自动
 * 下载并校验 sha256；本脚本用于打包/部署时提前备好，现场断网也不会卡在首次下载。
 *
 * 用法：
 *   node scripts/prepare-speaker-model.mjs                 # 用当前 $DSH_HOME
 *   node scripts/prepare-speaker-model.mjs --home <dir>    # 指定别的 DSH_HOME
 *
 * 行为：模型已存在且 sha256 校验通过时直接短路（不重新下载）；否则下载并写入
 * `$DSH_HOME/meeting-minutes/speaker/`。stdout 只输出结论（JSON 末行），日志走 stderr。
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  SPEAKER_MODEL_BYTES,
  SPEAKER_MODEL_FILE,
  SPEAKER_MODEL_SHA256,
  ensureSpeakerModel,
  resolveSpeakerModelDir,
} from '../lib/speaker.js'

/** 极简 `--key value` 参数解析（与 scripts/live-record.mjs 保持一致）。 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

/** 字节数 → 「28281138 字节（26.97 MB）」。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} 字节`
  return `${bytes} 字节（${(bytes / (1024 * 1024)).toFixed(2)} MB）`
}

/** 模型是几十 MB 的本地文件，整体读一次算 sha256 即可（毫秒级）。 */
async function sha256Of(path) {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

const args = parseArgs(process.argv.slice(2))
if (args.help === true) {
  console.log('用法：node scripts/prepare-speaker-model.mjs [--home <DSH_HOME>]')
  process.exit(0)
}

const home = typeof args.home === 'string' ? args.home : undefined
const dir = resolveSpeakerModelDir(home)
const modelPath = join(dir, SPEAKER_MODEL_FILE)

/** speaker.js 的 logger 既可能是 console 风格对象，也可能被当函数调用，两种都兜住。 */
const logger = (message) => console.error(String(message))
logger.info = (message) => console.error(String(message))
logger.warn = (message) => console.error(String(message))
logger.error = (message) => console.error(String(message))
logger.debug = () => {}

console.log(`说话人模型目录：${dir}`)

const before = await stat(modelPath).catch(() => null)
if (before !== null) {
  console.log(`发现已有模型：${modelPath}（${formatBytes(before.size)}），校验中…`)
} else {
  console.log('本机还没有说话人模型，开始下载…')
}

try {
  // fetchImpl 省略：用 Node 内置 fetch；下载进度/复用结论由 speaker.js 通过 logger 输出。
  await ensureSpeakerModel({ dir, logger })
} catch (error) {
  console.error(`准备说话人模型失败：${error?.message ?? error}`)
  process.exit(1)
}

const info = await stat(modelPath).catch(() => null)
if (info === null) {
  console.error(`准备说话人模型失败：${modelPath} 不存在`)
  process.exit(1)
}

const bytes = info.size
const actualSha256 = await sha256Of(modelPath)
const problems = []
if (Number.isFinite(SPEAKER_MODEL_BYTES) && bytes !== SPEAKER_MODEL_BYTES) {
  problems.push(`大小不符：期望 ${SPEAKER_MODEL_BYTES} 字节，实际 ${bytes} 字节`)
}
if (typeof SPEAKER_MODEL_SHA256 === 'string' && SPEAKER_MODEL_SHA256 !== '' && actualSha256 !== SPEAKER_MODEL_SHA256) {
  problems.push(`sha256 不符：期望 ${SPEAKER_MODEL_SHA256}，实际 ${actualSha256}`)
}

console.log(`模型路径：${modelPath}`)
console.log(`模型大小：${formatBytes(bytes)}`)

if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

console.log(`sha256：${actualSha256}`)
console.log(`状态：${before !== null ? '已存在且校验通过（未重新下载）' : '已下载并校验通过'}`)
console.log(JSON.stringify({
  ok: true,
  path: modelPath,
  bytes,
  sha256: actualSha256,
  reused: before !== null,
}))

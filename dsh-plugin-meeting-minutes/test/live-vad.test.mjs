/**
 * Tests for the live-recording energy VAD that slices sentences on pauses.
 *
 * The VAD core lives inside `lib/client.js` between the `live-vad-core` region
 * markers so the browser bundle and these tests share one implementation. The
 * test extracts that region with `fs` and runs it in a bare `node:vm` context:
 * if the region ever starts touching `document` / `window` / the plugin store,
 * loading the snippet fails here.
 *
 * Run with the bundled Node:
 *   node --test test/live-vad.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')
const RATE = 16000

/** Extract the tagged pure-function region from client.js and evaluate it. */
function loadVadCore() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const startMarker = '// #region live-vad-core'
  const endMarker = '// #endregion live-vad-core'
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  assert.ok(start >= 0 && end > start, 'client.js 里找不到 live-vad-core 标记区')
  const snippet = source.slice(start, end)
  const sandbox = { exports: {} }
  vm.runInNewContext(snippet, sandbox, { filename: 'live-vad-core.js' })
  const core = sandbox.exports.liveVadCore
  assert.ok(core && typeof core.createLiveVad === 'function', 'VAD region 没有导出 createLiveVad')
  return core
}

/** Sine tone as a stand-in for speech, one sample per 1/RATE s. */
function tone(seconds, amplitude = 0.1, freq = 220) {
  const length = Math.round(seconds * RATE)
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    out[index] = Math.sin((2 * Math.PI * freq * index) / RATE) * amplitude
  }
  return out
}

/** Digital silence (RMS 0). */
function silence(seconds) {
  return new Float32Array(Math.round(seconds * RATE))
}

function concat(...parts) {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Feed audio the way ScriptProcessor does: one bounded block at a time. */
function feedBlockwise(vad, samples, blockSize = 4096) {
  const chunks = []
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    chunks.push(...vad.push(samples.subarray(offset, offset + blockSize)))
  }
  return chunks
}

/** Seconds of near-silence at the end of a slice. */
function trailingSilenceSeconds(samples) {
  let lastVoiced = samples.length - 1
  while (lastVoiced >= 0 && Math.abs(samples[lastVoiced]) < 1e-3) lastVoiced -= 1
  return (samples.length - 1 - lastVoiced) / RATE
}

/** Seconds of near-silence at the start of a slice (the preroll). */
function leadingSilenceSeconds(samples) {
  let firstVoiced = 0
  while (firstVoiced < samples.length && Math.abs(samples[firstVoiced]) < 1e-3) firstVoiced += 1
  return firstVoiced / RATE
}

test('纯静音连续 20 秒不产生任何切片', () => {
  const { createLiveVad } = loadVadCore()
  const vad = createLiveVad({ silenceSeconds: 3 })
  const chunks = feedBlockwise(vad, silence(20))
  assert.equal(chunks.length, 0)
  assert.equal(vad.getState().state, 'silent')
})

test('0.8 秒语音 + 3 秒静音恰好切一次，尾部静音不超过 0.25 秒', () => {
  const { createLiveVad } = loadVadCore()
  const vad = createLiveVad({ silenceSeconds: 3 })
  const chunks = feedBlockwise(vad, concat(tone(0.8), silence(3)))

  assert.equal(chunks.length, 1)
  const chunk = chunks[0]
  assert.equal(chunk.reason, 'silence')
  // 0.8 s speech + at most 0.2 s kept trailing silence.
  assert.ok(
    chunk.durationSeconds >= 0.95 && chunk.durationSeconds <= 1.05,
    `切片长度异常：${chunk.durationSeconds}s`,
  )
  const tail = trailingSilenceSeconds(chunk.samples)
  assert.ok(tail <= 0.25, `尾部静音过长：${tail}s`)
  assert.ok(tail >= 0.15, `尾部静音被裁过头：${tail}s`)
  assert.equal(vad.getState().state, 'silent')
})

test('连续 12 秒语音在 ~10 秒处强制切段，切完仍在说话态', () => {
  const { createLiveVad } = loadVadCore()
  const vad = createLiveVad({ silenceSeconds: 3 })
  const chunks = feedBlockwise(vad, tone(12))

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason, 'maxSentence')
  assert.ok(
    chunks[0].durationSeconds >= 9.9 && chunks[0].durationSeconds <= 10.05,
    `强制切片长度异常：${chunks[0].durationSeconds}s`,
  )
  // Cut in the middle of continuous speech, so the next sentence is ongoing.
  assert.equal(vad.getState().state, 'speaking')
})

test('切片带上前导约 300ms 余音，第一个音节不被裁掉', () => {
  const { createLiveVad } = loadVadCore()
  const vad = createLiveVad({ silenceSeconds: 3 })
  const chunks = feedBlockwise(vad, concat(silence(0.5), tone(0.8), silence(3)))

  assert.equal(chunks.length, 1)
  const chunk = chunks[0]
  assert.ok(
    chunk.durationSeconds >= 1.25 && chunk.durationSeconds <= 1.35,
    `含前导的切片长度异常：${chunk.durationSeconds}s`,
  )
  const preroll = leadingSilenceSeconds(chunk.samples)
  assert.ok(preroll >= 0.25 && preroll <= 0.32, `前导余音不是 ~300ms：${preroll}s`)
})

test('低声噪声（RMS 0.002）不触发切片', () => {
  const { createLiveVad } = loadVadCore()
  const vad = createLiveVad({ silenceSeconds: 3 })
  // RMS of a sine is amplitude / sqrt(2).
  const chunks = feedBlockwise(vad, tone(20, 0.002 * Math.SQRT2, 300))
  assert.equal(chunks.length, 0)
  const state = vad.getState()
  assert.equal(state.state, 'silent')
  assert.ok(state.threshold >= 0.004, `噪声阈值低于绝对下限：${state.threshold}`)
})

test('silenceSeconds=1.5 时停顿 1.5 秒即切段', () => {
  const { createLiveVad } = loadVadCore()
  const fast = createLiveVad({ silenceSeconds: 1.5 })
  const fastChunks = feedBlockwise(fast, concat(tone(0.8), silence(1.5)))
  assert.equal(fastChunks.length, 1)
  assert.ok(fastChunks[0].durationSeconds <= 1.05)

  // Same audio with the default 3 s pause must not slice yet.
  const slow = createLiveVad({ silenceSeconds: 3 })
  assert.equal(feedBlockwise(slow, concat(tone(0.8), silence(1.5))).length, 0)
})

test('停录 drain：残余不足 200ms 丢弃，够长则带尾部静音上限切出', () => {
  const { createLiveVad } = loadVadCore()

  const sliver = createLiveVad({ silenceSeconds: 3 })
  feedBlockwise(sliver, concat(tone(0.5), silence(0.5)))
  // 0.5 s speech + 0.5 s tail is > 200 ms, so stop flushes it.
  const flushed = sliver.flush()
  assert.ok(flushed !== null)
  assert.equal(flushed.reason, 'stop')
  assert.ok(trailingSilenceSeconds(flushed.samples) <= 0.25)
  assert.equal(sliver.getState().state, 'silent')

  const empty = createLiveVad({ silenceSeconds: 3 })
  feedBlockwise(empty, silence(2))
  assert.equal(empty.flush(), null)
})

test('停顿配置只接受 1.5 / 3 / 5，非法值回退默认 1.5，storage key 固定', () => {
  const core = loadVadCore()
  assert.equal(core.normalizeVadSilenceSeconds('1.5'), 1.5)
  assert.equal(core.normalizeVadSilenceSeconds(3), 3)
  assert.equal(core.normalizeVadSilenceSeconds('5'), 5)
  assert.equal(core.normalizeVadSilenceSeconds(7), 1.5)
  assert.equal(core.normalizeVadSilenceSeconds('abc'), 1.5)
  assert.equal(core.normalizeVadSilenceSeconds(null), 1.5)
  assert.equal(core.normalizeVadSilenceSeconds(undefined), 1.5)
  assert.deepEqual([...core.LIVE_VAD_SILENCE_OPTIONS], [1.5, 3, 5])
  assert.equal(core.LIVE_VAD_SILENCE_KEY, 'dsh.meeting.vad.silenceSeconds')
  assert.equal(core.LIVE_VAD_DEFAULT_SILENCE_SECONDS, 1.5)
})

// ── 宿主/脚本共用的同一套算法（lib/live-vad.js）──
// 浏览器半是手写 bundle 不能 import 模块，所以两处各有一份实现；这里用同一串
// 合成音频同时喂两边，确保行为不漂移。
test('lib/live-vad.js 与客户端内联实现切出同样的片段', async () => {
  const { createLiveVad } = await import('../lib/live-vad.js')
  const clientCore = loadVadCore()

  /** 16k 10ms 帧：语音 0.2 / 静音 0.0005，便于两侧完全一致地判定。 */
  const script = []
  const push = (seconds, amplitude) => {
    const frames = Math.round(seconds / 0.01)
    for (let index = 0; index < frames; index += 1) {
      const frame = new Float32Array(160).fill(amplitude)
      script.push(frame)
    }
  }
  push(0.5, 0)     // 房间底噪
  push(0.9, 0.2)   // 第一句
  push(3.2, 0)     // 停顿 3 秒 → 切
  push(0.7, 0.2)   // 第二句
  push(3.2, 0)     // 停顿 → 切

  const run = (create) => {
    const vad = create({ sampleRate: 16000, silenceSeconds: 3 })
    const slices = []
    for (const frame of script) {
      for (const slice of vad.push(frame)) slices.push(slice.samples.length)
    }
    const tail = vad.flush()
    if (tail !== null) slices.push(tail.samples.length)
    return slices
  }

  const clientSlices = run(clientCore.createLiveVad)
  const moduleSlices = run(createLiveVad)
  assert.deepEqual(moduleSlices, clientSlices)
  assert.equal(moduleSlices.length, 2, '两句话各切一片，尾部静音不单独成片')
})

test('未指定停顿阈值时按默认 1.5 秒切段', () => {
  const { createLiveVad, LIVE_VAD_DEFAULT_SILENCE_SECONDS } = loadVadCore()
  assert.equal(LIVE_VAD_DEFAULT_SILENCE_SECONDS, 1.5)
  const vad = createLiveVad({})
  const chunks = feedBlockwise(vad, concat(tone(0.8), silence(1.5)))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason, 'silence')
  assert.equal(vad.getState().silenceTargetSeconds, 1.5)
})

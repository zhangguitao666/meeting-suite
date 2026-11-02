/**
 * 会议纪要插件 · 停顿切片 VAD（宿主 / 脚本共用）
 *
 * 与浏览器半 `lib/client.js` 里的 `live-vad-core` 区是同一套算法：10ms 分析帧的
 * 能量 VAD，静音累计到阈值（默认 1.5 秒，可选 3/5 秒）就切出一句；连续说话到
 * 上限（默认 10 秒）强制切；切片带 300ms 前导余音、尾部静音裁到 200ms，噪声底
 * 慢速自适应。
 *
 * 浏览器半是手写 bundle、不能 import 这个模块，所以那边保留一份同样的实现；
 * 改动算法时两边都要改（`test/live-vad.test.mjs` 会同时跑两边并对齐结果）。
 *
 * @module dsh-plugin-meeting-minutes/live-vad
 */

// Pure energy-VAD core. This region is extracted verbatim by
// `test/live-vad.test.mjs` and executed in a bare VM context, so it must be
// self-contained: no DOM globals, no plugin store, no outer-scope references.
// The browser wrapper feeds 16 kHz mono Float32 blocks in and turns every
// emitted slice into one rolling transcription request.

/** Pause length before a sentence is sliced when nothing else is stored. */
const LIVE_VAD_DEFAULT_SILENCE_SECONDS = 1.5
/** User-selectable pause lengths, in seconds; anything else falls back to the default. */
const LIVE_VAD_SILENCE_OPTIONS = [1.5, 3, 5]
/** Browser storage key for the pause preference (applies to the next take). */
const LIVE_VAD_SILENCE_KEY = 'dsh.meeting.vad.silenceSeconds'
/** A blip shorter than this is never sliced out on its own. */
const LIVE_VAD_MIN_SENTENCE_SECONDS = 0.35
/** Continuous talking is force-sliced at this length. */
const LIVE_VAD_MAX_SENTENCE_SECONDS = 10
/** Audio kept from just before the onset so the first syllable is not clipped. */
const LIVE_VAD_PREROLL_SECONDS = 0.3
/** Trailing silence kept inside a slice; anything newer is dropped. */
const LIVE_VAD_TAIL_SILENCE_SECONDS = 0.2
/** Analysis frame: 10 ms at 16 kHz. */
const LIVE_VAD_FRAME_SECONDS = 0.01
/** Speech must clear max(absolute floor, tracked room tone × factor). */
const LIVE_VAD_NOISE_FLOOR_MIN = 0.004
const LIVE_VAD_NOISE_FLOOR_FACTOR = 2.2
/** Slow one-pole room-tone tracking (~1 s time constant at 10 ms frames). */
const LIVE_VAD_NOISE_ALPHA = 0.01
/** Sample rate used when the caller does not provide one. */
const LIVE_VAD_SAMPLE_RATE = 16000

/** Coerce a stored/select value into one of 1.5 / 3 / 5 (default 1.5). */
function normalizeVadSilenceSeconds(value) {
  const seconds = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  for (const option of LIVE_VAD_SILENCE_OPTIONS) {
    if (seconds === option) return option
  }
  return LIVE_VAD_DEFAULT_SILENCE_SECONDS
}

function vadFrameRms(frame) {
  if (frame.length === 0) return 0
  let energy = 0
  for (let index = 0; index < frame.length; index += 1) energy += frame[index] * frame[index]
  return Math.sqrt(energy / frame.length)
}

function vadConcatFrames(frames) {
  let total = 0
  for (const frame of frames) total += frame.length
  const merged = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    merged.set(frame, offset)
    offset += frame.length
  }
  return merged
}

/**
 * Sentence slicer state machine: silent → speaking → (pause long enough, or
 * sentence too long) → one slice. `push(block)` returns the slices that became
 * ready; `flush()` drains whatever is left when recording stops; `getState()`
 * exposes the counters used by the UI and by the unit tests.
 */
function createLiveVad(options = {}) {
  const requestedRate = Number(options.sampleRate)
  const sampleRate = Number.isFinite(requestedRate) && requestedRate > 0
    ? Math.round(requestedRate)
    : LIVE_VAD_SAMPLE_RATE
  const silenceTarget = normalizeVadSilenceSeconds(options.silenceSeconds)
  const frameSamples = Math.max(1, Math.round(sampleRate * LIVE_VAD_FRAME_SECONDS))
  const frameSeconds = frameSamples / sampleRate
  const prerollFrames = Math.max(1, Math.round(LIVE_VAD_PREROLL_SECONDS / frameSeconds))
  const tailFrames = Math.max(0, Math.round(LIVE_VAD_TAIL_SILENCE_SECONDS / frameSeconds))
  const minSpeechFrames = Math.max(1, Math.round(LIVE_VAD_MIN_SENTENCE_SECONDS / frameSeconds))
  const silenceFrames = Math.max(1, Math.round(silenceTarget / frameSeconds))
  const maxSpeechFrames = Math.max(1, Math.round(LIVE_VAD_MAX_SENTENCE_SECONDS / frameSeconds))
  const minSliceSamples = Math.round(sampleRate * LIVE_VAD_TAIL_SILENCE_SECONDS)

  let state = 'silent'
  /** Frames of the current sentence: preroll + speech + trailing silence. */
  let pending = []
  /** Most recent frames, replayed as the next onset's preroll. */
  let ring = []
  /** Incomplete frame left over between audio callbacks. */
  let remainder = new Float32Array(0)
  /** Speech frames in the current sentence (the "current sentence length"). */
  let speechFrames = 0
  /** Trailing silence frames inside the current sentence. */
  let silenceRun = 0
  let noiseFloor = LIVE_VAD_NOISE_FLOOR_MIN / LIVE_VAD_NOISE_FLOOR_FACTOR

  function threshold() {
    return Math.max(LIVE_VAD_NOISE_FLOOR_MIN, noiseFloor * LIVE_VAD_NOISE_FLOOR_FACTOR)
  }

  function pushRing(frame) {
    ring.push(frame)
    while (ring.length > prerollFrames) ring.shift()
  }

  function resetSentence() {
    pending = []
    speechFrames = 0
    silenceRun = 0
    state = 'silent'
  }

  /** Build the slice for the current sentence, trimming its trailing silence. */
  function buildSlice(reason) {
    if (pending.length === 0) return null
    const drop = Math.max(0, silenceRun - tailFrames)
    const kept = drop === 0 ? pending : pending.slice(0, Math.max(0, pending.length - drop))
    const samples = vadConcatFrames(kept)
    if (samples.length < minSliceSamples) return null
    return {
      samples,
      reason,
      sampleRate,
      durationSeconds: samples.length / sampleRate,
      speechSeconds: speechFrames * frameSeconds,
      silenceSeconds: silenceRun * frameSeconds,
    }
  }

  function handleFrame(frame, out) {
    const rms = vadFrameRms(frame)
    const speech = rms >= threshold()
    if (state === 'silent') {
      if (!speech) {
        // Learn the room tone slowly; speech must never train the floor.
        noiseFloor += (rms - noiseFloor) * LIVE_VAD_NOISE_ALPHA
        pushRing(frame)
        return
      }
      state = 'speaking'
      pending = ring.slice(-prerollFrames)
      pending.push(frame)
      speechFrames = 1
      silenceRun = 0
      pushRing(frame)
      return
    }
    pending.push(frame)
    pushRing(frame)
    if (speech) {
      speechFrames += 1
      silenceRun = 0
    } else {
      silenceRun += 1
      // Pauses inside a sentence also teach the floor, so a noisy room does
      // not keep being sliced as one 10 s sentence forever.
      noiseFloor += (rms - noiseFloor) * LIVE_VAD_NOISE_ALPHA
    }
    if (speechFrames >= maxSpeechFrames) {
      const slice = buildSlice('maxSentence')
      if (slice !== null) out.push(slice)
      // Still talking: start the next sentence right here.
      pending = []
      speechFrames = 0
      silenceRun = 0
      return
    }
    if (silenceRun >= silenceFrames) {
      if (speechFrames >= minSpeechFrames) {
        const slice = buildSlice('silence')
        if (slice !== null) out.push(slice)
      }
      resetSentence()
    }
  }

  return {
    push(samples) {
      const out = []
      if (!samples || samples.length === 0) return out
      const incoming = samples instanceof Float32Array ? samples : Float32Array.from(samples)
      const joined = new Float32Array(remainder.length + incoming.length)
      joined.set(remainder, 0)
      joined.set(incoming, remainder.length)
      let offset = 0
      while (offset + frameSamples <= joined.length) {
        handleFrame(joined.subarray(offset, offset + frameSamples), out)
        offset += frameSamples
      }
      remainder = joined.slice(offset)
      return out
    },
    /** Stop-recording drain: final slice, or null when < 200 ms is left. */
    flush() {
      if (remainder.length > 0) {
        if (state === 'speaking') pending.push(remainder)
        remainder = new Float32Array(0)
      }
      if (state !== 'speaking') {
        resetSentence()
        return null
      }
      const slice = buildSlice('stop')
      resetSentence()
      return slice
    },
    reset() {
      ring = []
      remainder = new Float32Array(0)
      noiseFloor = LIVE_VAD_NOISE_FLOOR_MIN / LIVE_VAD_NOISE_FLOOR_FACTOR
      resetSentence()
    },
    getState() {
      return {
        state,
        speechSeconds: speechFrames * frameSeconds,
        silenceRunSeconds: silenceRun * frameSeconds,
        pendingFrames: pending.length,
        noiseFloor,
        threshold: threshold(),
        silenceTargetSeconds: silenceTarget,
        frameSeconds,
      }
    },
  }
}

const liveVadCore = Object.freeze({
  createLiveVad,
  normalizeVadSilenceSeconds,
  LIVE_VAD_DEFAULT_SILENCE_SECONDS,
  LIVE_VAD_SILENCE_OPTIONS,
  LIVE_VAD_SILENCE_KEY,
  LIVE_VAD_MIN_SENTENCE_SECONDS,
  LIVE_VAD_MAX_SENTENCE_SECONDS,
  LIVE_VAD_PREROLL_SECONDS,
  LIVE_VAD_TAIL_SILENCE_SECONDS,
  LIVE_VAD_NOISE_FLOOR_MIN,
  LIVE_VAD_NOISE_FLOOR_FACTOR,
  LIVE_VAD_SAMPLE_RATE,
})

// The unit test extracts this region and runs it in a bare VM context with a
// fresh `exports` object; inside the plugin factory `exports` is the client
// module object, so the assignment is harmless in production.

export {
  createLiveVad,
  normalizeVadSilenceSeconds,
  LIVE_VAD_DEFAULT_SILENCE_SECONDS,
  LIVE_VAD_SILENCE_OPTIONS,
  LIVE_VAD_SILENCE_KEY,
  LIVE_VAD_MIN_SENTENCE_SECONDS,
  LIVE_VAD_MAX_SENTENCE_SECONDS,
  LIVE_VAD_PREROLL_SECONDS,
  LIVE_VAD_TAIL_SILENCE_SECONDS,
  LIVE_VAD_NOISE_FLOOR_MIN,
  LIVE_VAD_NOISE_FLOOR_FACTOR,
  LIVE_VAD_SAMPLE_RATE,
}

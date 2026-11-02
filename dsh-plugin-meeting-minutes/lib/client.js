/**
 * Browser half of the meeting-minutes plugin (hand-written bundle).
 *
 * Contributes three seats to the shipped web shell:
 * - `sidebar.panellist` — the microphone + minutes glyph (recording red dot),
 * - `main` key `meeting-minutes` — the meeting list and the visual minutes doc,
 * - `shell.overlay` — toasts plus the persistent live-recording bar.
 *
 * Data comes from the host half's loopback JSON API (`/dsh-meeting`). This
 * bundle is deliberately dependency-free apart from React: every control,
 * modal and chart is plain `React.createElement`, and every colour is a
 * `--dsw-alias-*` theme token so the panel follows the light/dark shell.
 *
 * Audio pipeline (browser side):
 *   - live: getUserMedia → AudioContext → ScriptProcessor(4096) → streaming
 *     resampler → energy-VAD sentence slices (≈3 s pause by default) → PCM16 WAV
 *     chunks → rolling POST /transcribe (append).
 *   - file: decodeAudioData → 16 kHz mono → ≤90 s WAV slices → sequential POST.
 *   The live recorder lives at module scope and survives modal/panel unmounts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-meeting-minutes',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-meeting'
    const TARGET_RATE = 16000
    const SLICE_SECONDS = 90
    const SPEECH_POLL_MS = 1200
    const SPEECH_TIMEOUT_MS = 10 * 60 * 1000
    const TOAST_TTL_MS = 7000
    /** How long the "录音已结束" notice stays up after an agent recording stops. */
    const RECORDING_ENDED_TTL_MS = 3000
    const AUDIO_MAX_SECONDS = 60 * 60

    const PRIORITY_LABELS = { high: '高', normal: '中', low: '低' }
    const SOURCE_LABELS = { recording: '录音', text: '文本', import: '导入' }
    const RISK_LABELS = { high: '高风险', medium: '待确认', low: '提示' }
    const PHASE_LABELS = {
      ready: '就绪',
      unprepared: '未加载',
      standby: '待加载',
      downloading: '下载模型',
      downloadingBytes: '下载模型',
      checking: '校验模型',
      loading: '加载模型',
      failed: '失败',
      cancelled: '已取消',
    }
    // #region live-vad-core
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
    if (typeof exports === 'object' && exports !== null) exports.liveVadCore = liveVadCore
    // #endregion live-vad-core

    /** At most two transcription requests in flight; pending chunks merge. */
    const LIVE_MAX_INFLIGHT = 2
    const LIVE_MAX_PENDING = 2
    const LIVE_IDLE_TIMEOUT_MS = 120 * 1000

    // ──────────────────────────────── styles ────────────────────────────────

    const CSS = `
.dsm-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.dsm-hidden{display:none}
.dsm-spacer{flex:1 1 auto}
.dsm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsm-brand{display:flex;align-items:baseline;gap:8px;margin-right:4px}
.dsm-brand-title{font-size:15px;font-weight:650;letter-spacing:.2px}
.dsm-brand-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:4px 10px;font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}
.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsm-btn:disabled{opacity:.45;cursor:not-allowed}
.dsm-btn--primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dsm-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}
.dsm-btn--danger{color:var(--dsw-alias-label-error);border-color:color-mix(in srgb,var(--dsw-alias-label-error) 45%,transparent)}
.dsm-btn--ghost{border-color:transparent}
.dsm-btn--sm{padding:2px 7px;font-size:11px;line-height:16px}
.dsm-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);background:transparent;font-family:inherit;white-space:nowrap}
button.dsm-chip{cursor:pointer}
button.dsm-chip:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
.dsm-chip--ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.dsm-chip--busy{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dsm-chip--warn{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dsm-dot-live{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.dsm-errorbar{display:flex;align-items:center;gap:8px;margin:10px 16px 0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-error);font-size:12px}
.dsm-errorbar-text{flex:1 1 auto;min-width:0;word-break:break-word}
.dsm-body{flex:1 1 auto;display:flex;min-height:0}
.dsm-side{width:302px;flex:0 0 auto;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsm-side-head{padding:12px 12px 8px;display:flex;flex-direction:column;gap:8px}
.dsm-side-title{display:flex;align-items:baseline;gap:6px;font-size:13px;font-weight:600}
.dsm-side-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsm-search{position:relative;display:flex;align-items:center}
.dsm-search .dsm-search-icon{position:absolute;left:8px;color:var(--dsw-alias-label-secondary);pointer-events:none;display:flex}
.dsm-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px;line-height:18px;font-family:inherit}
.dsm-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dsm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dsm-input--search{padding-left:27px}
.dsm-input--cell{padding:2px 6px;font-size:12px;line-height:17px}
.dsm-textarea{resize:vertical;min-height:96px;line-height:19px}
.dsm-filters{display:flex;gap:4px;flex-wrap:wrap}
.dsm-filter{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 7px;font-size:11px;line-height:17px;font-family:inherit;cursor:pointer}
.dsm-filter:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-filter--active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.dsm-list{flex:1 1 auto;overflow:auto;padding:4px 8px 12px;display:flex;flex-direction:column;gap:3px}
.dsm-meeting{display:flex;flex-direction:column;gap:4px;width:100%;box-sizing:border-box;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:9px;padding:8px 9px;font-family:inherit;cursor:pointer}
.dsm-meeting:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-meeting:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsm-meeting--active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.dsm-meeting-top{display:flex;align-items:flex-start;gap:6px}
.dsm-meeting-title{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:550;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-meeting-check{flex:0 0 auto;color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:18px}
.dsm-meeting-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-sep{width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.7}
.dsm-meeting-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsm-badge{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:999px;line-height:16px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-badge--warn{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 70%,transparent)}
.dsm-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-tertiary) 75%,transparent)}
.dsm-badge--brand{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dsm-avatars{display:inline-flex;align-items:center;margin-left:auto}
.dsm-avatar{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;margin-left:-5px;border:1px solid var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary)}
.dsm-empty-list{margin:14px 8px;padding:16px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dsm-detail{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base)}
.dsm-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:200px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsm-spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:dsm-spin .8s linear infinite;display:inline-block;flex:0 0 auto}
.dsm-spin--lg{width:26px;height:26px;border-width:3px}
@keyframes dsm-spin{to{transform:rotate(360deg)}}
.dsm-service-error{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:32px;text-align:center}
.dsm-service-title{font-size:16px;font-weight:600}
.dsm-service-text{font-size:12px;color:var(--dsw-alias-label-secondary);max-width:460px;line-height:20px}
.dsm-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px 28px;min-height:0;overflow:auto}
.dsm-empty-icon{width:64px;height:64px;border-radius:20px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}
.dsm-empty-title{font-size:20px;font-weight:650;letter-spacing:.2px;text-align:center}
.dsm-empty-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);text-align:center;line-height:20px;max-width:520px}
.dsm-entries{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;width:100%;max-width:720px;margin-top:2px}
.dsm-entry{display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px;font-family:inherit;color:inherit;cursor:pointer;transition:border-color .12s ease,background .12s ease}
.dsm-entry:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1))}
.dsm-entry:disabled{opacity:.5;cursor:not-allowed}
.dsm-entry-icon{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dsm-entry-title{font-size:13px;font-weight:600}
.dsm-entry-text{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-empty-note{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}
.dsm-doc{max-width:960px;margin:0 auto;padding:20px 26px 64px;box-sizing:border-box}
.dsm-cover{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:20px 22px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 58%)}
.dsm-cover-top{display:flex;align-items:flex-start;gap:10px}
.dsm-eyebrow{flex:1 1 auto;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);font-weight:600}
.dsm-cover-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.dsm-cover-title{margin:0;font-size:25px;line-height:34px;font-weight:680;letter-spacing:.2px;word-break:break-word}
.dsm-meta-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-meta-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-meta-chip--brand{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.dsm-oneline{position:relative;display:flex;gap:10px;border-radius:11px;border-left:3px solid var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-base));padding:11px 14px}
.dsm-oneline-mark{font-size:26px;line-height:22px;color:var(--dsw-alias-brand-primary);font-weight:700;flex:0 0 auto}
.dsm-oneline-text{font-size:15px;line-height:23px;font-weight:600;word-break:break-word}
.dsm-overview{margin-top:5px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap}
.dsm-doc-section{margin-top:20px}
.dsm-section-band{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.dsm-section-icon{color:var(--dsw-alias-label-secondary);display:flex}
.dsm-section-title{margin:0;font-size:13px;font-weight:650;letter-spacing:.2px}
.dsm-section-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsm-section-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.dsm-points{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}
.dsm-point{display:flex;gap:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:10px 11px}
.dsm-point-num{flex:0 0 auto;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);line-height:19px;min-width:16px}
.dsm-point-text{font-size:12.5px;line-height:19px;word-break:break-word}
.dsm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px}
.dsm-decision{display:flex;gap:8px;align-items:flex-start;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,var(--dsw-alias-border-l1));border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,var(--dsw-alias-bg-layer-1));padding:10px 11px}
.dsm-decision-check{flex:0 0 auto;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsm-decision-body{flex:1 1 auto;min-width:0}
.dsm-decision-text{font-size:12.5px;line-height:19px;word-break:break-word}
.dsm-owner{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-risk{display:flex;gap:8px;align-items:flex-start;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:10px 11px}
.dsm-risk--medium{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 55%,var(--dsw-alias-bg-layer-1))}
.dsm-risk--high{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}
.dsm-risk-sign{flex:0 0 auto;color:var(--dsw-alias-label-secondary);display:flex;margin-top:1px}
.dsm-risk--medium .dsm-risk-sign{color:var(--dsw-alias-state-warn-label)}
.dsm-risk--high .dsm-risk-sign{color:var(--dsw-alias-state-error-primary)}
.dsm-risk-body{flex:1 1 auto;min-width:0}
.dsm-risk-text{font-size:12.5px;line-height:19px;word-break:break-word}
.dsm-risk-level{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dsm-risk--medium .dsm-risk-level{color:var(--dsw-alias-state-warn-label)}
.dsm-risk--high .dsm-risk-level{color:var(--dsw-alias-state-error-primary)}
.dsm-blocks{display:flex;flex-direction:column;gap:9px}
.dsm-block{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px}
.dsm-block-heading{font-size:12.5px;font-weight:600;margin-bottom:6px;word-break:break-word}
.dsm-bullets{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:4px}
.dsm-bullet{position:relative;padding-left:13px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsm-bullet::before{content:'';position:absolute;left:3px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:.75}
.dsm-notes{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px}
.dsm-todo-card{border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsm-table-wrap{overflow-x:auto}
.dsm-table{width:100%;border-collapse:collapse;min-width:720px}
.dsm-table th{text-align:left;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 4%,transparent)}
.dsm-table td{padding:8px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;font-size:12px;line-height:18px}
.dsm-table tbody tr:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 4%,transparent)}
.dsm-table tbody tr:last-child td{border-bottom:0}
.dsm-table .dsm-col-check{width:34px}
.dsm-table .dsm-col-owner{width:88px}
.dsm-table .dsm-col-due{width:116px}
.dsm-table .dsm-col-priority{width:64px}
.dsm-table .dsm-col-status{width:122px}
.dsm-table .dsm-col-actions{width:74px}
.dsm-checkbox{accent-color:var(--dsw-alias-button-primary-fill);width:14px;height:14px;margin:2px 0 0;cursor:pointer}
.dsm-checkbox:disabled{cursor:not-allowed;opacity:.5}
.dsm-todo-title{font-weight:500;word-break:break-word}
.dsm-todo-note{margin-top:3px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap}
.dsm-todo--pushed .dsm-todo-title{color:var(--dsw-alias-label-secondary)}
.dsm-prio{display:inline-flex;padding:0 6px;border-radius:999px;font-size:10.5px;line-height:17px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-prio--high{color:var(--dsw-alias-label-error);border-color:color-mix(in srgb,var(--dsw-alias-label-error) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dsm-prio--low{color:var(--dsw-alias-label-secondary)}
.dsm-status{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-status--ok{color:var(--dsw-alias-state-success-primary)}
.dsm-cal-id{display:inline-block;margin-top:2px;font-size:10px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsm-row-actions{display:flex;gap:4px;flex-wrap:wrap}
.dsm-todo-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 3%,transparent)}
.dsm-todo-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:17px}
.dsm-todo-hint--warn{color:var(--dsw-alias-state-warn-label)}
.dsm-empty-table{padding:16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-speakers{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 0 0}
.dsm-speakers-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-speaker-chip{max-width:180px;overflow:hidden;text-overflow:ellipsis}
.dsm-speaker-edit{display:inline-flex;align-items:center;gap:4px}
.dsm-speaker-input{width:132px;box-sizing:border-box}
.dsm-transcript{border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsm-transcript-head{display:flex;align-items:center;gap:8px;padding:9px 12px;flex-wrap:wrap}
.dsm-transcript-toggle{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:0}
.dsm-transcript-toggle:hover{color:var(--dsw-alias-brand-primary)}
.dsm-chevron--open{transform:rotate(90deg);transition:transform .12s ease}
.dsm-transcript-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsm-transcript-body{margin:0;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}
.dsm-detail-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;min-height:260px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsm-cta{display:flex;align-items:center;gap:12px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));border-radius:13px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1));padding:14px 16px;margin-top:20px;flex-wrap:wrap}
.dsm-cta-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);flex:0 0 auto}
.dsm-cta-body{flex:1 1 220px;min-width:0}
.dsm-cta-title{font-size:13px;font-weight:600;margin-bottom:2px}
.dsm-cta-text{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-summarizing{display:flex;align-items:center;gap:10px;margin-top:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1));border-radius:13px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1));padding:12px 14px;font-size:12px;flex-wrap:wrap}
.dsm-summarizing-text{flex:1 1 200px;line-height:18px}
.dsm-summarizing-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-modal-root{position:fixed;inset:0;z-index:130;display:flex;align-items:center;justify-content:center;padding:24px}
.dsm-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(1px)}
.dsm-modal{position:relative;display:flex;flex-direction:column;width:min(560px,94vw);max-height:86vh;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 52px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);overflow:hidden}
.dsm-modal--wide{width:min(660px,94vw)}
.dsm-modal-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 10px}
.dsm-modal-heading{flex:1 1 auto;min-width:0}
.dsm-modal-title{font-size:15px;font-weight:650}
.dsm-modal-sub{margin-top:3px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-modal-lock{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding-top:3px}
.dsm-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;padding:0}
.dsm-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-modal-body{padding:4px 18px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.dsm-modal-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:11px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 3%,transparent)}
.dsm-field{display:flex;flex-direction:column;gap:4px}
.dsm-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-row{display:flex;gap:8px}
.dsm-row>.dsm-field{flex:1 1 0;min-width:0}
.dsm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px;margin-bottom:2px}
.dsm-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:3px 9px;font-size:12px;font-family:inherit;cursor:pointer}
.dsm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-tab--active{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.dsm-hint{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-hint--warn{color:var(--dsw-alias-state-warn-label)}
.dsm-inline-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-label-error);border-radius:8px;padding:7px 9px;font-size:11.5px;line-height:18px;word-break:break-word}
.dsm-radio-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.dsm-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsm-radio input{accent-color:var(--dsw-alias-button-primary-fill)}
.dsm-file-pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:10px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 3%,transparent)}
.dsm-file-name{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsm-progress-card{display:flex;flex-direction:column;gap:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-base));padding:10px 12px}
.dsm-progress-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}
.dsm-progress-title{flex:1 1 auto;min-width:0}
.dsm-progress-pct{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);font-weight:600}
.dsm-progress{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 20%,transparent);overflow:hidden}
.dsm-progress-bar{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.dsm-progress-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsm-record-stage{display:flex;flex-direction:column;align-items:center;gap:12px;padding:18px 10px;text-align:center}
.dsm-rec-dot{width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsm-pulse 1.2s ease-in-out infinite}
@keyframes dsm-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
.dsm-rec-timer{font-size:34px;line-height:40px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:.06em}
.dsm-rec-status{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-level{width:min(320px,80%);height:8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 20%,transparent);overflow:hidden}
.dsm-level-bar{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-success-primary));transition:width .12s linear}
.dsm-stage-title{font-size:14px;font-weight:600}
.dsm-stage-text{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:19px;max-width:420px;word-break:break-word}
.dsm-done-icon{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dsm-toast-stack{position:fixed;right:18px;bottom:18px;z-index:200;display:flex;flex-direction:column;gap:8px;max-width:min(380px,90vw);pointer-events:none}
.dsm-toast{pointer-events:auto;display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);padding:9px 12px;animation:dsm-toast-in .16s ease}
@keyframes dsm-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dsm-toast--error{border-color:var(--dsw-alias-state-error-primary)}
.dsm-toast--warn{border-color:var(--dsw-alias-state-warn-primary)}
.dsm-toast--success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,transparent)}
.dsm-toast-title{font-size:12px;font-weight:650}
.dsm-toast-body{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsm-icon-badge{position:relative;display:inline-flex}
.dsm-icon-dot{position:absolute;top:-3px;right:-4px;min-width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:9px;line-height:12px;text-align:center;padding:0 3px;font-weight:600}
.dsm-dialog-text{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0;word-break:break-word}
.dsm-kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 3px;color:var(--dsw-alias-label-secondary)}
.dsm-livebar{position:fixed;cursor:grab;touch-action:none;user-select:none;left:50%;bottom:18px;transform:translateX(-50%);z-index:210;display:flex;align-items:center;gap:10px;max-width:min(780px,94vw);box-sizing:border-box;padding:8px 10px 8px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:0 12px 34px color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
.dsm-livebar[data-dsm-dragging]{cursor:grabbing}
.dsm-livebar--done{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-border-l2))}
.dsm-livebar-check{width:18px;height:18px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent);color:var(--dsw-alias-state-success-primary);font-size:11px;font-weight:700}
.dsm-livebar-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsm-pulse 1.2s ease-in-out infinite;flex:0 0 auto}
.dsm-livebar-main{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsm-livebar-title{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:650;white-space:nowrap}
.dsm-livebar-timer{font-variant-numeric:tabular-nums}
.dsm-livebar-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-livebar-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.dsm-livebar .dsm-btn{color:var(--dsw-alias-toast-label);border-color:color-mix(in srgb,var(--dsw-alias-toast-label) 24%,transparent)}
.dsm-livebar .dsm-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-toast-label) 12%,transparent);color:var(--dsw-alias-toast-label)}
.dsm-livebar .dsm-btn--danger{color:var(--dsw-alias-label-error);border-color:color-mix(in srgb,var(--dsw-alias-label-error) 55%,transparent)}
.dsm-livebar-select{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-toast-label);white-space:nowrap;cursor:pointer}
.dsm-livebar-select select{appearance:none;-webkit-appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-toast-label) 26%,transparent);border-radius:6px;background:transparent;color:inherit;font-family:inherit;font-size:11px;line-height:16px;padding:1px 5px;cursor:pointer}
.dsm-livebar-select select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsm-livebar-select select option{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dsm-live-panel{display:flex;flex-direction:column;gap:10px;padding:4px 0 2px}
.dsm-live-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;word-break:break-word}
.dsm-live-head .dsm-livebar-dot{width:10px;height:10px}
.dsm-live-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsm-live-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-base)}
.dsm-live-stat-label{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsm-live-stat-value{font-size:19px;line-height:25px;font-weight:650;font-variant-numeric:tabular-nums}
.dsm-live-last{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-base));min-height:48px;font-size:12px;line-height:19px;word-break:break-word}
.dsm-live-last-label{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.dsm-live-queue{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsm-live-stopping{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}
.dsm-icon-live-dot{position:absolute;bottom:-2px;right:-3px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-error-primary);border:1.5px solid var(--dsw-alias-bg-base);animation:dsm-pulse 1.2s ease-in-out infinite}
.dsm-auto-toggles{display:flex;flex-direction:column;gap:8px}
.dsm-auto-toggle{display:flex;align-items:flex-start;gap:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 11px;background:var(--dsw-alias-bg-base);cursor:pointer}
.dsm-auto-toggle input{margin:2px 0 0;accent-color:var(--dsw-alias-button-primary-fill);width:14px;height:14px;flex:0 0 auto}
.dsm-auto-toggle-body{flex:1 1 auto;min-width:0}
.dsm-auto-toggle-title{display:block;font-size:12.5px;font-weight:600;line-height:18px}
.dsm-auto-toggle-text{display:block;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:1px;word-break:break-word}
.dsm-auto-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsm-auto-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-base);min-width:0}
.dsm-auto-card--wide{grid-column:1 / -1}
.dsm-auto-k{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:15px}
.dsm-auto-v{font-size:12px;line-height:18px;font-weight:500;word-break:break-word;margin-top:1px}
.dsm-auto-v--ok{color:var(--dsw-alias-state-success-primary)}
.dsm-auto-v--warn{color:var(--dsw-alias-state-warn-label)}
.dsm-auto-v--error{color:var(--dsw-alias-label-error)}
.dsm-auto-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin-top:2px}
.dsm-auto-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-auto-note{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-brand-primary);padding:2px 0 2px 8px}
.dsm-auto-recent{display:flex;flex-direction:column;gap:4px}
.dsm-auto-recent-item{display:flex;align-items:baseline;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-base);font-family:inherit;color:inherit;font-size:11.5px;text-align:left;cursor:pointer;width:100%;box-sizing:border-box}
.dsm-auto-recent-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-auto-recent-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-auto-recent-time{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsm-auto-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 0}
@media (max-width:900px){.dsm-side{width:250px}.dsm-doc{padding:16px 16px 48px}.dsm-entries{grid-template-columns:1fr 1fr}.dsm-cover-title{font-size:21px;line-height:29px}}
@media (max-width:720px){.dsm-body{flex-direction:column}.dsm-side{width:auto;max-height:250px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-entries{grid-template-columns:1fr}.dsm-toolbar{padding:8px 10px}.dsm-errorbar{margin:8px 10px 0}}
`

    const STYLE_TAG_ID = 'dsh-plugin-meeting-minutes/client.css'

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-meeting-minutes'
      style.dataset.pluginCss = STYLE_TAG_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ─────────────────────────────── store ────────────────────────────────

    let snapshot = {
      status: 'loading',
      error: null,
      data: null,
      meetings: [],
      selectedId: null,
      meeting: null,
      meetingLoading: false,
      busy: false,
      exporting: null,
      summarizing: null,
      transcribing: null,
      speech: null,
      speechPhase: null,
      speechProgress: null,
      speechMessage: '',
      speechPreparing: false,
      live: initialLiveState(),
      /** Brief "recording finished" notice shown after an agent recording stops. */
      recordingEnded: null,
      toasts: [],
    }
    const listeners = new Set()
    let toastSeq = 0
    /** Auto-imported meeting ids already announced; null until the first /state. */
    let autoIngestKnownIds = null

    function emit() {
      for (const listener of [...listeners]) listener()
    }

    function commit(patch) {
      snapshot = { ...snapshot, ...patch }
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    function useSnapshot() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribe(() => setValue(snapshot)), [])
      return value
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function notify(level, title, body) {
      const id = ++toastSeq
      commit({ toasts: [...snapshot.toasts, { id, level, title, body }] })
      window.setTimeout(() => {
        commit({ toasts: snapshot.toasts.filter((toast) => toast.id !== id) })
      }, TOAST_TTL_MS)
    }

    function dismissToast(id) {
      commit({ toasts: snapshot.toasts.filter((toast) => toast.id !== id) })
    }

    function reportError(error, title = '操作失败') {
      const message = messageOf(error)
      commit({ error: message })
      notify('error', title, message)
      return message
    }

    function notifySuccess(title, body) {
      notify('success', title, body)
    }

    // ─────────────────────────────── helpers ──────────────────────────────

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function todayKey(date = new Date()) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    function nowMinuteKey(date = new Date()) {
      return `${todayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function formatStamp(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return `${todayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function humanDate(key) {
      if (!key) return '未定日期'
      const text = String(key).slice(0, 10)
      const parts = text.split('-').map(Number)
      if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return text
      const date = new Date(parts[0], parts[1] - 1, parts[2])
      const weekdays = ['日', '一', '二', '三', '四', '五', '六']
      return `${parts[0]}-${pad2(parts[1])}-${pad2(parts[2])} 周${weekdays[date.getDay()]}`
    }

    function formatChars(count) {
      const value = Number(count)
      return `${Number.isFinite(value) && value > 0 ? Math.round(value).toLocaleString('zh-CN') : '0'} 字`
    }

    function formatDuration(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value <= 0) return ''
      const total = Math.round(value)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const rest = total % 60
      if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(rest)}`
      return `${minutes}:${pad2(rest)}`
    }

    function formatTimer(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${Math.round(value)} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    function splitAttendees(text) {
      return String(text ?? '')
        .split(/[,，、;；\s]+/)
        .map((name) => name.trim())
        .filter((name) => name !== '')
    }

    function safeFilename(name, extension) {
      const base = String(name ?? '').trim() || '会议纪要'
      return `${base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 70)}.${extension}`
    }

    function defaultRecordingTitle(date = new Date()) {
      return `录音纪要 ${nowMinuteKey(date)}`
    }

    function defaultMeetingTitle(date = new Date()) {
      return `会议纪要 ${nowMinuteKey(date)}`
    }

    function defaultImportTitle(fileName) {
      const base = String(fileName ?? '').replace(/\.[^.]+$/, '').trim()
      return base !== '' ? base : `会议纪要 ${todayKey()}`
    }

    function isPushed(todo) {
      return Boolean(todo && (todo.calendarTaskId || todo.pushedAt))
    }

    function cleanImportedText(raw) {
      let text = String(raw ?? '').replace(/\r\n/g, '\n')
      if (/<\/?[a-z][\s\S]*>/i.test(text)) {
        text = text
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
      }
      return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    /**
     * Pull plain text out of a Tencent-Meeting-style JSON export. The walker
     * looks for the fields those exports commonly carry (`minutes`, `content`,
     * `summary`, `transcript`, `sentences[].text`, …) and falls back to the
     * original string when nothing usable is found.
     */
    function extractTencentText(raw) {
      const text = String(raw ?? '').trim()
      if (text === '') return ''
      if (!text.startsWith('{') && !text.startsWith('[')) return cleanImportedText(text)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return cleanImportedText(text)
      }
      const parts = []
      const seen = new Set()
      const push = (value) => {
        const piece = cleanImportedText(value)
        if (piece === '' || seen.has(piece)) return
        seen.add(piece)
        parts.push(piece)
      }
      const stringKeys = ['minutes', 'content', 'summary', 'transcript']
      const walk = (node, depth) => {
        if (node === null || node === undefined || depth > 5) return
        if (typeof node === 'string') return
        if (Array.isArray(node)) {
          for (const item of node) {
            if (typeof item === 'string') push(item)
            else walk(item, depth + 1)
          }
          return
        }
        if (typeof node !== 'object') return
        for (const key of stringKeys) {
          const value = node[key]
          if (typeof value === 'string') push(value)
          else if (value && typeof value === 'object') walk(value, depth + 1)
        }
        if (Array.isArray(node.sentences)) {
          for (const sentence of node.sentences) {
            if (typeof sentence === 'string') push(sentence)
            else if (sentence && typeof sentence === 'object' && typeof sentence.text === 'string') push(sentence.text)
          }
        }
        if (Array.isArray(node.paragraphs)) {
          for (const paragraph of node.paragraphs) {
            if (typeof paragraph === 'string') push(paragraph)
            else if (paragraph && typeof paragraph === 'object' && typeof paragraph.text === 'string') push(paragraph.text)
          }
        }
        for (const [key, value] of Object.entries(node)) {
          if (stringKeys.includes(key) || key === 'sentences' || key === 'paragraphs' || key === 'text') continue
          if (value && typeof value === 'object') walk(value, depth + 1)
        }
      }
      walk(parsed, 0)
      if (parts.length > 0) return parts.join('\n')
      const fallback = []
      const scan = (node, depth) => {
        if (depth > 6) return
        if (typeof node === 'string') {
          const piece = cleanImportedText(node)
          if (piece.length > 20) fallback.push(piece)
          return
        }
        if (Array.isArray(node)) {
          for (const item of node) scan(item, depth + 1)
          return
        }
        if (node && typeof node === 'object') {
          for (const value of Object.values(node)) scan(value, depth + 1)
        }
      }
      scan(parsed, 0)
      return fallback.length > 0 ? fallback.join('\n') : cleanImportedText(text)
    }

    function speechProvider(speech) {
      if (!speech || typeof speech !== 'object') return null
      const providers = Array.isArray(speech.providers) ? speech.providers : []
      const selectedId = speech.selection?.providerId
      return providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null
    }

    function speechUsable(speech) {
      if (!speech || typeof speech !== 'object') return false
      if (speech.available === false) return false
      return Array.isArray(speech.providers) && speech.providers.length > 0
    }

    function speechReady(speech) {
      const provider = speechProvider(speech)
      // The host's `speechToText` service treats `standby` as usable too: the
      // provider is registered and can transcribe without another prepare.
      return provider?.phase === 'ready' || provider?.phase === 'standby'
    }

    function speechPhaseLabel(phase) {
      return PHASE_LABELS[phase] ?? (phase ? String(phase) : '未知')
    }

    function sleep(ms) {
      return new Promise((resolve) => { window.setTimeout(resolve, ms) })
    }

    // ─────────────────────────────── API ──────────────────────────────────

    async function requestJson(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch {
        throw new Error('无法连接会议纪要服务，请重新加载页面')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) {
        if (response.status === 404) throw new Error('会议纪要服务未启动，请重新加载页面')
        throw new Error(`会议纪要接口无响应（HTTP ${response.status}）`)
      }
      if (payload.ok === false) {
        const error = new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `会议纪要接口出错（HTTP ${response.status}）`)
        error.payload = payload
        throw error
      }
      if (!response.ok) {
        const error = new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `会议纪要接口出错（HTTP ${response.status}）`)
        error.payload = payload
        throw error
      }
      // A successful call makes a stale error banner obsolete.
      if (snapshot.error !== null) commit({ error: null })
      return payload
    }

    async function loadMeeting(id, options = {}) {
      if (!id) {
        commit({ meeting: null, meetingLoading: false })
        return null
      }
      if (!options.silent) commit({ meetingLoading: true, selectedId: id })
      try {
        const payload = await requestJson(`/meetings/${encodeURIComponent(id)}`)
        if (snapshot.selectedId === id) commit({ meeting: payload.meeting ?? null, meetingLoading: false })
        return payload.meeting ?? null
      } catch (error) {
        if (snapshot.selectedId === id) commit({ meetingLoading: false })
        if (!options.quiet) reportError(error, '会议加载失败')
        return null
      }
    }

    /**
     * Normalise `meeting.speakers` (host contract: `[{ id, label }]`). Anything
     * else — missing field, old host, empty array — collapses to `[]`.
     */
    function normalizeSpeakerList(value) {
      if (!Array.isArray(value)) return []
      const list = []
      for (const item of value) {
        if (item === null || typeof item !== 'object') continue
        const rawId = item.id
        const id = typeof rawId === 'string' ? rawId : (typeof rawId === 'number' ? String(rawId) : '')
        if (id === '') continue
        const label = typeof item.label === 'string' && item.label.trim() !== ''
          ? item.label.trim()
          : `说话人${list.length + 1}`
        list.push({ id, label })
      }
      return list
    }

    /**
     * Speaker list for a meeting. Returns `null` when the host does not implement
     * the route yet (404 / old build), so callers can stay silent instead of
     * flashing an error for a feature the backend is still adding.
     */
    async function loadMeetingSpeakers(meetingId) {
      if (!meetingId) return null
      try {
        const payload = await requestJson(`/meetings/${encodeURIComponent(meetingId)}/speakers`)
        if (!payload || payload.ok !== true) return null
        return normalizeSpeakerList(payload.speakers)
      } catch {
        return null
      }
    }

    /** Rename one speaker label; resolves with the host payload. */
    async function renameMeetingSpeaker(meetingId, speakerId, name) {
      const payload = await requestJson(
        `/meetings/${encodeURIComponent(meetingId)}/speakers/${encodeURIComponent(speakerId)}/rename`,
        { method: 'POST', body: { name } },
      )
      if (payload?.meeting && payload.meeting.id === snapshot.selectedId) {
        commit({ meeting: payload.meeting })
      }
      return payload
    }

    /**
     * Announce auto-imported meetings that appeared since the previous state
     * load. The first load only seeds the set, so opening the panel never
     * replays old imports as toasts.
     */
    function detectNewAutoImports(meetings) {
      const auto = meetings.filter((item) => item.autoImported === true)
      const currentIds = new Set(auto.map((item) => item.id))
      if (autoIngestKnownIds === null) {
        autoIngestKnownIds = currentIds
        return []
      }
      const fresh = auto.filter((item) => !autoIngestKnownIds.has(item.id))
      autoIngestKnownIds = currentIds
      for (const meeting of fresh) {
        notify('success', `已自动导入：${meeting.title}（待整理）`, '可在左侧列表打开，生成 AI 纪要或写入任务日历')
      }
      return fresh
    }

    async function loadState(options = {}) {
      const withDetail = options.detail !== false
      const data = await requestJson('/state')
      const meetings = Array.isArray(data.meetings) ? data.meetings : []
      const previousId = snapshot.selectedId
      let selectedId = previousId
      if (!meetings.some((item) => item.id === selectedId)) {
        selectedId = meetings.length > 0 ? meetings[0].id : null
      }
      const patch = {
        status: 'ready',
        error: null,
        data,
        meetings,
        speech: data.speech ?? snapshot.speech,
      }
      if (selectedId !== previousId) {
        patch.selectedId = selectedId
        patch.meeting = null
      }
      commit(patch)
      const fresh = detectNewAutoImports(meetings)
      if (!withDetail && snapshot.selectedId !== null
        && fresh.some((item) => item.id === snapshot.selectedId)) {
        await loadMeeting(snapshot.selectedId, { silent: true, quiet: true })
      }
      if (withDetail) await loadMeeting(selectedId, { silent: true, quiet: !options.quietDetail })
      return data
    }

    async function refreshAll() {
      if (snapshot.data === null) commit({ status: 'loading' })
      try {
        await loadState({ detail: true, quietDetail: true })
      } catch (error) {
        const message = messageOf(error)
        commit({ status: snapshot.data === null ? 'error' : 'ready', error: message })
      }
    }

    async function refreshList() {
      try {
        await loadState({ detail: false })
      } catch (error) {
        commit({ error: messageOf(error) })
      }
    }

    async function selectMeeting(id) {
      if (!id) {
        commit({ selectedId: null, meeting: null })
        return
      }
      if (id === snapshot.selectedId && snapshot.meeting !== null) return
      commit({ selectedId: id, meeting: null })
      await loadMeeting(id)
    }

    async function reloadMeetingQuietly(id) {
      if (!id) return
      await loadMeeting(id, { silent: true, quiet: true })
    }

    async function createMeeting(input) {
      const payload = await requestJson('/meetings', { method: 'POST', body: input })
      const meeting = payload.meeting
      commit({ meeting, selectedId: meeting.id })
      await refreshList()
      await reloadMeetingQuietly(meeting.id)
      return meeting
    }

    async function patchMeeting(id, patch) {
      const payload = await requestJson(`/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
      if (payload.meeting) commit({ meeting: payload.meeting, selectedId: id })
      await refreshList()
      await reloadMeetingQuietly(id)
      return payload.meeting
    }

    async function deleteMeetingById(id) {
      await requestJson(`/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (snapshot.selectedId === id) commit({ selectedId: null, meeting: null })
      await loadState({ detail: true })
    }

    async function discardMeetingQuietly(id) {
      try {
        await requestJson(`/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch {
        // Best effort: the meeting may already be gone.
      }
      if (snapshot.selectedId === id) commit({ selectedId: null, meeting: null })
      try {
        await loadState({ detail: true })
      } catch {
        // Ignore: the panel already reports its own connection state.
      }
    }

    async function summarizeMeetingById(id, force) {
      const payload = await requestJson(`/meetings/${encodeURIComponent(id)}/summarize`, {
        method: 'POST',
        body: { force: Boolean(force) },
      })
      if (payload.meeting) commit({ meeting: payload.meeting, selectedId: id })
      await refreshList()
      await reloadMeetingQuietly(id)
      return payload
    }

    async function updateMeetingTodo(meetingId, todoId, patch) {
      const payload = await requestJson(
        `/meetings/${encodeURIComponent(meetingId)}/todos/${encodeURIComponent(todoId)}`,
        { method: 'PATCH', body: patch },
      )
      if (payload.meeting) commit({ meeting: payload.meeting, selectedId: meetingId })
      await refreshList()
      return payload.meeting
    }

    async function pushMeetingTodos(meetingId, todoIds) {
      const body = Array.isArray(todoIds) && todoIds.length > 0 ? { todoIds } : {}
      try {
        const payload = await requestJson(`/meetings/${encodeURIComponent(meetingId)}/todos/push`, {
          method: 'POST',
          body,
        })
        if (payload.meeting) commit({ meeting: payload.meeting, selectedId: meetingId })
        await refreshList()
        await reloadMeetingQuietly(meetingId)
        return payload
      } catch (error) {
        // A partial calendar failure comes back as 400 with the already-created
        // entries and the refreshed meeting; keep the UI truthful about both.
        const partial = error && typeof error === 'object' ? error.payload : null
        if (partial && partial.meeting) {
          commit({ meeting: partial.meeting, selectedId: meetingId })
          try { await refreshList() } catch { /* the error is reported by the caller */ }
          const created = Array.isArray(partial.created) ? partial.created : []
          if (created.length > 0 && error instanceof Error) {
            error.message = `${error.message}（已成功写入 ${created.length} 条）`
          }
        }
        throw error
      }
    }

    async function exportMeetingFile(meeting, format) {
      const payload = await requestJson(
        `/meetings/${encodeURIComponent(meeting.id)}/export?format=${format === 'md' ? 'md' : 'html'}`,
      )
      const filename = typeof payload.filename === 'string' && payload.filename !== ''
        ? payload.filename
        : safeFilename(meeting.title, format === 'md' ? 'md' : 'html')
      const mime = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8'
      downloadTextFile(filename, String(payload.content ?? ''), mime)
      return { ...payload, filename }
    }

    function downloadTextFile(filename, content, mime) {
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      window.setTimeout(() => {
        URL.revokeObjectURL(url)
        anchor.remove()
      }, 2000)
    }

    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }

    // ─────────────────────────── auto ingest ──────────────────────────────

    function applyAutoIngestStatus(status) {
      if (!status || typeof status !== 'object' || snapshot.data === null) return
      commit({ data: { ...snapshot.data, autoIngest: status } })
    }

    function parseAutoIngestDirs(text) {
      const seen = new Set()
      const dirs = []
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const dir = line.trim()
        if (dir === '' || seen.has(dir)) continue
        seen.add(dir)
        dirs.push(dir)
        if (dirs.length >= 20) break
      }
      return dirs
    }

    function autoIngestSummaryLabel(status) {
      if (!status || typeof status !== 'object') return '自动入库'
      if (status.scanning === true) return '自动入库 · 扫描中'
      return status.enabled === false ? '自动入库 · 关' : '自动入库 · 开'
    }

    async function saveAutoIngestSettings(patch) {
      const payload = await requestJson('/auto-ingest', { method: 'POST', body: patch })
      const status = payload.autoIngest ?? null
      applyAutoIngestStatus(status)
      return status
    }

    async function triggerAutoIngestScanNow() {
      const payload = await requestJson('/auto-ingest/scan', { method: 'POST' })
      const status = payload.autoIngest ?? null
      applyAutoIngestStatus(status)
      return status
    }

    /**
     * Trigger a scan and poll `/state` every two seconds until `scanning` turns
     * false (60 s ceiling). Both the scan response and every poll update the
     * shared `/state` projection, so the list and the settings dialog stay live.
     */
    async function scanAutoIngestAndWait() {
      let status = await triggerAutoIngestScanNow()
      if (status === null) throw new Error('自动入库不可用')
      if (status.scanning !== true) return status
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await sleep(2000)
        const data = await loadState({ detail: false })
        status = data.autoIngest ?? status
        if (status?.scanning !== true) {
          await reloadMeetingQuietly(snapshot.selectedId)
          return status
        }
      }
      throw new Error('扫描超时（超过 60 秒），请稍后查看自动入库状态')
    }

    // ─────────────────────────── speech service ───────────────────────────

    function applySpeechStatus(speech) {
      if (!speech || typeof speech !== 'object') return
      const provider = speechProvider(speech)
      const progress = provider?.progress
      const total = Number(progress?.totalBytes) || 0
      const done = Number(progress?.completedBytes) || 0
      commit({
        speech,
        data: snapshot.data === null ? snapshot.data : { ...snapshot.data, speech },
        speechPhase: provider?.phase ?? 'unprepared',
        speechProgress: total > 0
          ? {
            done,
            total,
            ratio: Math.max(0, Math.min(1, done / total)),
            resource: typeof progress?.resource === 'string' ? progress.resource : '',
          }
          : null,
        speechMessage: typeof provider?.message === 'string' ? provider.message : '',
      })
    }

    /**
     * Ensure the local ASR model is loaded. Triggers `POST /speech/prepare`
     * when needed and polls `GET /speech/status` every 1.2 s while exposing
     * download/load progress to the store. Throws a Chinese error on failure.
     */
    async function waitForSpeechReady() {
      let speech = snapshot.speech ?? snapshot.data?.speech ?? null
      // The contract asks for a fresh status read before every transcription;
      // fall back to the cached projection if the status route is unavailable.
      try {
        const status = await requestJson('/speech/status')
        if (status.speech) {
          speech = status.speech
          applySpeechStatus(status.speech)
        }
      } catch {
        // Keep using the cached `/state` projection.
      }
      if (speechReady(speech)) return speech
      if (!speechUsable(speech)) {
        throw new Error('本机语音识别服务不可用，请改用「导入纪要」的文本方式')
      }
      const providerId = speechProvider(speech)?.id
      commit({ speechPreparing: true, speechMessage: '正在启动语音识别服务…' })
      try {
        const body = typeof providerId === 'string' && providerId !== '' ? { providerId } : {}
        try {
          const payload = await requestJson('/speech/prepare', { method: 'POST', body })
          if (payload.speech) applySpeechStatus(payload.speech)
        } catch (error) {
          throw new Error(`语音识别服务启动失败：${messageOf(error)}`)
        }
        const deadline = Date.now() + SPEECH_TIMEOUT_MS
        let current = snapshot.speech
        let polls = 0
        while (Date.now() < deadline) {
          if (speechReady(current)) return current
          const provider = speechProvider(current)
          const phase = provider?.phase
          // The prepare response can still carry the previous failed phase; give
          // the service one polling interval to publish its new state.
          if (polls > 0 && phase === 'failed') {
            throw new Error(provider?.message || '语音识别模型加载失败，请改用文本导入')
          }
          if (polls > 0 && phase === 'cancelled') throw new Error('语音识别模型加载已取消，请重试')
          await sleep(SPEECH_POLL_MS)
          const payload = await requestJson('/speech/status')
          polls += 1
          if (payload.speech) {
            current = payload.speech
            applySpeechStatus(payload.speech)
          }
        }
        throw new Error('语音识别服务启动超时，请稍后重试，或改用文本导入')
      } finally {
        commit({ speechPreparing: false, speechMessage: '' })
      }
    }

    async function prepareSpeechManually() {
      try {
        await waitForSpeechReady()
        notifySuccess('语音识别已就绪', '现在可以录音，或导入音频文件转写')
      } catch (error) {
        reportError(error, '语音识别启动失败')
      }
    }

    // ──────────────────────────── audio pipeline ──────────────────────────

    function stopStream(stream) {
      if (!stream || typeof stream.getTracks !== 'function') return
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore: stopping an already-ended track is harmless.
        }
      }
    }

    function explainMediaError(error) {
      const name = error && typeof error === 'object' ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return '麦克风权限被拒绝，请在浏览器设置中允许访问麦克风后重试'
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return '未找到可用的麦克风设备，请检查设备连接'
      }
      if (name === 'NotReadableError') {
        return '麦克风被其他应用占用，请关闭占用程序后重试'
      }
      return `无法开始录音：${messageOf(error)}`
    }

    function decodeAudioBlob(blob) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioCtor) {
        return Promise.reject(new Error('当前浏览器不支持音频解码，请改用「导入纪要」的文本方式'))
      }
      const context = new AudioCtor()
      return blob.arrayBuffer().then((bytes) => new Promise((resolve, reject) => {
        let settled = false
        const accept = (buffer) => {
          if (settled) return
          settled = true
          resolve(buffer)
        }
        const fail = () => {
          if (settled) return
          settled = true
          reject(new Error('音频解码失败，请换成 WAV / MP3 / M4A 格式后重试'))
        }
        try {
          const maybe = context.decodeAudioData(bytes, accept, fail)
          if (maybe && typeof maybe.then === 'function') maybe.then(accept, fail)
        } catch {
          fail()
        }
      })).finally(() => {
        try {
          const closing = context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      })
    }

    function downmixToMono(buffer) {
      const channels = Math.max(1, buffer.numberOfChannels)
      const length = buffer.length
      const mono = new Float32Array(length)
      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel)
        for (let index = 0; index < length; index += 1) mono[index] += data[index]
      }
      if (channels > 1) {
        for (let index = 0; index < length; index += 1) mono[index] /= channels
      }
      return mono
    }

    function resampleLinear(input, sourceRate, targetRate) {
      if (!Number.isFinite(sourceRate) || sourceRate <= 0) return input
      if (sourceRate === targetRate) return input
      const ratio = targetRate / sourceRate
      const length = Math.max(1, Math.round(input.length * ratio))
      const output = new Float32Array(length)
      for (let index = 0; index < length; index += 1) {
        const position = index / ratio
        const left = Math.floor(position)
        const right = Math.min(left + 1, input.length - 1)
        const fraction = position - left
        output[index] = input[left] * (1 - fraction) + input[right] * fraction
      }
      return output
    }

    async function resampleTo16k(buffer) {
      const duration = Number(buffer.duration) || 0
      if (duration > AUDIO_MAX_SECONDS) {
        throw new Error('音频超过 60 分钟，请分段后再导入')
      }
      if (typeof OfflineAudioContext !== 'undefined') {
        try {
          const mono = downmixToMono(buffer)
          const frames = Math.max(1, Math.ceil(duration * TARGET_RATE))
          const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
          const sourceBuffer = offline.createBuffer(1, mono.length, buffer.sampleRate)
          sourceBuffer.copyToChannel(mono, 0)
          const source = offline.createBufferSource()
          source.buffer = sourceBuffer
          source.connect(offline.destination)
          source.start(0)
          const rendered = await offline.startRendering()
          return rendered.getChannelData(0)
        } catch {
          // Fall back to the manual resampler below.
        }
      }
      return resampleLinear(downmixToMono(buffer), buffer.sampleRate, TARGET_RATE)
    }

    function writeAscii(view, offset, text) {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index))
      }
    }

    function encodePcm16Wav(samples, sampleRate = TARGET_RATE) {
      const frames = samples.length
      const buffer = new ArrayBuffer(44 + frames * 2)
      const view = new DataView(buffer)
      writeAscii(view, 0, 'RIFF')
      view.setUint32(4, 36 + frames * 2, true)
      writeAscii(view, 8, 'WAVE')
      writeAscii(view, 12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(view, 36, 'data')
      view.setUint32(40, frames * 2, true)
      let offset = 44
      for (let index = 0; index < frames; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    /** Decode any browser-supported audio blob into ≤90 s 16 kHz mono WAV slices. */
    async function audioBlobToWavChunks(blob) {
      const decoded = await decodeAudioBlob(blob)
      if (!decoded || decoded.length === 0) throw new Error('音频为空，无法转写')
      if (decoded.duration < 0.3) throw new Error('音频太短，无法识别')
      const samples = await resampleTo16k(decoded)
      const samplesPerSlice = TARGET_RATE * SLICE_SECONDS
      const chunks = []
      for (let start = 0; start < samples.length; start += samplesPerSlice) {
        const end = Math.min(samples.length, start + samplesPerSlice)
        const piece = samples.subarray(start, end)
        if (piece.length < TARGET_RATE * 0.2) continue
        chunks.push(encodePcm16Wav(piece))
      }
      if (chunks.length === 0) throw new Error('没有可转写的音频片段')
      return chunks
    }

    /**
     * Query string for one transcribe POST.
     * Live slices carry `live=1&index=N` so the host keeps them as temporary
     * parts and merges the whole meeting once on stop (`/audio/finalize`).
     */
    function transcribeQuery(options = {}) {
      const query = new URLSearchParams({ language: 'zh' })
      if (options?.live === true) {
        query.set('live', '1')
        query.set('index', String(Math.max(0, Math.trunc(Number(options.index) || 0))))
      }
      return query.toString()
    }

    async function postTranscription(meetingId, wavBlob, options = {}) {
      let response
      try {
        response = await fetch(
          `${API}/meetings/${encodeURIComponent(meetingId)}/transcribe?${transcribeQuery(options)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: wavBlob,
          },
        )
      } catch {
        throw new Error('无法连接会议纪要服务，请重新加载页面')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) {
        if (response.status === 404) throw new Error('会议纪要服务未启动，请重新加载页面')
        throw new Error(`语音识别接口无响应（HTTP ${response.status}）`)
      }
      if (payload.ok === false) {
        throw new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `语音识别失败（HTTP ${response.status}）`)
      }
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `语音识别失败（HTTP ${response.status}）`)
      }
      return payload
    }

    /** Transcribe the slices sequentially and publish per-slice progress. */
    async function transcribeAudioChunks(meetingId, chunks) {
      const total = chunks.length
      const startedAt = Date.now()
      let text = ''
      let audioSeconds = 0
      const publish = (index) => {
        commit({
          transcribing: {
            meetingId,
            index,
            total,
            chars: text.length,
            startedAt,
          },
        })
      }
      publish(0)
      try {
        for (let index = 0; index < total; index += 1) {
          publish(index)
          const payload = await postTranscription(meetingId, chunks[index])
          const piece = String(payload.text ?? '').trim()
          if (piece !== '') text = text === '' ? piece : `${text}\n${piece}`
          audioSeconds += Number(payload.audioSeconds) || 0
          publish(index + 1)
        }
        return { text, audioSeconds, total }
      } finally {
        commit({ transcribing: null })
      }
    }

    // ─────────────────────────── live recorder ────────────────────────────
    //
    // Everything below is module-scoped on purpose: closing RecordModal,
    // switching the main panel, or unmounting React must not stop an active
    // meeting recording. Components only read `snapshot.live`.

    /** Browser plugin context, kept so the floating bar can select our panel. */
    let clientContext = null

    function initialLiveState() {
      return {
        status: 'idle',
        meetingId: null,
        meetingTitle: '',
        startedAt: 0,
        elapsedSeconds: 0,
        level: 0,
        chars: 0,
        lastText: '',
        transcript: '',
        error: null,
        inFlight: 0,
        queued: 0,
        sentChunks: 0,
        result: null,
      }
    }

    function liveIsActive(live = snapshot.live) {
      return live !== null && live !== undefined
        && (live.status === 'preparing' || live.status === 'recording' || live.status === 'stopping')
    }

    /** Pause preference from the browser (defaults to 1.5 s; never throws). */
    function readVadSilenceSeconds() {
      try {
        return normalizeVadSilenceSeconds(window.localStorage.getItem(LIVE_VAD_SILENCE_KEY))
      } catch {
        return LIVE_VAD_DEFAULT_SILENCE_SECONDS
      }
    }

    /** Persist the pause preference; it takes effect on the next recording. */
    function writeVadSilenceSeconds(value) {
      const seconds = normalizeVadSilenceSeconds(value)
      try {
        window.localStorage.setItem(LIVE_VAD_SILENCE_KEY, String(seconds))
      } catch {
        // Private mode / storage disabled: the in-memory selection still works.
      }
      return seconds
    }

    /**
     * Streaming linear resampler. The fractional read position AND the unconsumed
     * source tail survive `push()` calls, so concatenated blocks stay continuous
     * instead of each block being resampled independently.
     */
    class StreamingResampler {
      constructor(sourceRate, targetRate = TARGET_RATE) {
        this.sourceRate = sourceRate
        this.targetRate = targetRate
        this.ratio = sourceRate / targetRate
        this.buffer = new Float32Array(0)
        this.position = 0
      }

      push(input) {
        if (!input || input.length === 0) return new Float32Array(0)
        const combined = new Float32Array(this.buffer.length + input.length)
        combined.set(this.buffer, 0)
        combined.set(input, this.buffer.length)
        this.buffer = combined
        if (this.ratio === 1) {
          const passthrough = this.buffer
          this.buffer = new Float32Array(0)
          this.position = 0
          return passthrough
        }
        const available = this.buffer.length
        const output = new Float32Array(Math.max(0, Math.ceil((available - this.position) / this.ratio)))
        let write = 0
        while (this.position + 1 < available) {
          const index = Math.floor(this.position)
          const fraction = this.position - index
          output[write] = this.buffer[index] * (1 - fraction) + this.buffer[index + 1] * fraction
          write += 1
          this.position += this.ratio
        }
        const result = output.subarray(0, write)
        const consumed = Math.floor(this.position)
        if (consumed > 0) {
          // The read position may run slightly past the buffered tail; only drop
          // samples that actually exist and move the fractional position by the
          // same amount, otherwise the phase would reset at block boundaries.
          const drop = Math.min(consumed, this.buffer.length)
          this.buffer = this.buffer.slice(drop)
          this.position -= drop
        }
        return new Float32Array(result)
      }
    }

    function concatFloat32(parts) {
      let total = 0
      for (const part of parts) total += part.length
      const merged = new Float32Array(total)
      let offset = 0
      for (const part of parts) {
        merged.set(part, offset)
        offset += part.length
      }
      return merged
    }

    const liveEngine = {
      stream: null,
      context: null,
      source: null,
      processor: null,
      sink: null,
      resampler: null,
      /** Per-take energy VAD; created in `startLiveRecording`. */
      vad: null,
      queue: [],
      inFlight: 0,
      pumping: false,
      timer: 0,
      level: 0,
      sentChunks: 0,
      startToken: 0,
      sessionId: 0,
      failureMessage: null,
      waiters: [],
      beforeUnload: null,
    }

    // Background tabs may auto-suspend audio; resume as soon as the user comes
    // back. Flushing itself never depends on this timer.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        const context = liveEngine.context
        if (!document.hidden && context && context.state === 'suspended') {
          try {
            const resumed = context.resume()
            if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {})
          } catch {
            // Best effort.
          }
        }
      })
    }

    function publishLive(patch) {
      commit({ live: { ...snapshot.live, ...patch } })
    }

    function resetLiveState(extra = {}) {
      commit({ live: { ...initialLiveState(), ...extra } })
    }

    function publishLiveQueue() {
      publishLive({
        inFlight: liveEngine.inFlight,
        queued: liveEngine.queue.length,
        sentChunks: liveEngine.sentChunks,
      })
    }

    function updateLiveBeforeUnload() {
      const active = liveIsActive()
      if (active && liveEngine.beforeUnload === null) {
        liveEngine.beforeUnload = (event) => {
          event.preventDefault()
          event.returnValue = '录音正在进行，离开页面会中断录音。'
          return event.returnValue
        }
        window.addEventListener('beforeunload', liveEngine.beforeUnload)
      } else if (!active && liveEngine.beforeUnload !== null) {
        window.removeEventListener('beforeunload', liveEngine.beforeUnload)
        liveEngine.beforeUnload = null
      }
    }

    function startLiveTimer() {
      stopLiveTimer()
      liveEngine.timer = window.setInterval(() => {
        const status = snapshot.live.status
        if (status !== 'recording' && status !== 'stopping') return
        const startedAt = snapshot.live.startedAt
        const elapsed = startedAt > 0 ? Math.floor((Date.now() - startedAt) / 1000) : 0
        publishLive({ elapsedSeconds: elapsed, level: liveEngine.level })
      }, 500)
    }

    function stopLiveTimer() {
      if (liveEngine.timer) {
        window.clearInterval(liveEngine.timer)
        liveEngine.timer = 0
      }
    }

    function resolveLiveIdle() {
      if (liveEngine.pumping) return
      if (liveEngine.inFlight !== 0 || liveEngine.queue.length !== 0) return
      const waiters = liveEngine.waiters.splice(0)
      for (const resolve of waiters) resolve(true)
    }

    function waitForLiveIdle(timeoutMs = LIVE_IDLE_TIMEOUT_MS) {
      if (liveEngine.inFlight === 0 && liveEngine.queue.length === 0) return Promise.resolve(true)
      return new Promise((resolve) => {
        let settled = false
        let timer = 0
        const finish = (value) => {
          if (settled) return
          settled = true
          if (timer) window.clearTimeout(timer)
          const index = liveEngine.waiters.indexOf(finish)
          if (index !== -1) liveEngine.waiters.splice(index, 1)
          resolve(value)
        }
        timer = window.setTimeout(() => finish(false), timeoutMs)
        liveEngine.waiters.push(finish)
      })
    }

    /** Jump back to our main panel from the floating recording bar. */
    function openMeetingPanel() {
      try {
        clientContext?.layout?.selectPanel?.('meeting-minutes')
      } catch {
        // Navigation is best effort; the bar itself stays useful.
      }
    }

    async function openLiveCapture() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices
        || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('当前浏览器不支持实时录音，请改用音频文件导入或文本导入')
      }
      let stream = null
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
      } catch (error) {
        if (error && (error.name === 'OverconstrainedError' || error.name === 'TypeError')) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch (inner) {
            throw new Error(explainMediaError(inner))
          }
        } else {
          throw new Error(explainMediaError(error))
        }
      }
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (typeof AudioCtor !== 'function') {
        stopStream(stream)
        throw new Error('当前浏览器不支持实时录音，请改用音频文件导入')
      }
      let context = null
      try {
        try {
          context = new AudioCtor({ sampleRate: TARGET_RATE })
        } catch {
          context = new AudioCtor()
        }
      } catch (error) {
        stopStream(stream)
        throw new Error(`无法启动实时录音：${messageOf(error)}`)
      }
      if (context.state === 'suspended') {
        try { await context.resume() } catch { /* user gesture usually allows it */ }
      }
      if (typeof context.createScriptProcessor !== 'function') {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error('当前浏览器不支持实时音频处理，请改用音频文件导入')
      }
      let source = null
      let processor = null
      try {
        source = context.createMediaStreamSource(stream)
        processor = context.createScriptProcessor(4096, 1, 1)
      } catch (error) {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error(`无法启动实时音频处理：${messageOf(error)}`)
      }
      const sink = context.createGain()
      sink.gain.value = 0
      const resampler = context.sampleRate === TARGET_RATE
        ? null
        : new StreamingResampler(context.sampleRate, TARGET_RATE)
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)
      if (context.state !== 'running') {
        try { await context.resume() } catch { /* ignore */ }
      }
      if (context.state !== 'running') {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error('浏览器阻止了实时音频采集，请点击页面后重试')
      }
      // Return resources instead of publishing them: a cancelled start must be
      // able to release its own nodes without touching a newer session.
      return { stream, context, source, processor, sink, resampler }
    }

    /** Release one capture set that may not have been adopted by the engine. */
    function releaseCaptureResources(capture) {
      if (!capture) return
      const processor = capture.processor
      if (processor) {
        processor.onaudioprocess = null
        try { processor.disconnect() } catch { /* ignore */ }
      }
      const source = capture.source
      if (source) {
        try { source.disconnect() } catch { /* ignore */ }
      }
      const sink = capture.sink
      if (sink) {
        try { sink.disconnect() } catch { /* ignore */ }
      }
      stopStream(capture.stream)
      const context = capture.context
      if (context) {
        try {
          const closing = context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      }
    }

    /**
     * Audio-thread callback: hand the resampled block to the energy VAD. The VAD
     * owns slicing (natural pauses / 10 s cap), so nothing is flushed by a timer.
     */
    function onLiveAudioProcess(event) {
      if (snapshot.live.status !== 'recording') return
      const input = event.inputBuffer?.getChannelData?.(0)
      if (!input || input.length === 0) return
      const mono = new Float32Array(input.length)
      mono.set(input)
      let energy = 0
      for (let index = 0; index < mono.length; index += 1) energy += mono[index] * mono[index]
      liveEngine.level = Math.min(1, Math.sqrt(energy / mono.length) * 4)
      const resampled = liveEngine.resampler === null ? mono : liveEngine.resampler.push(mono)
      if (resampled.length === 0) return
      const vad = liveEngine.vad
      if (vad === null) return
      for (const slice of vad.push(resampled)) enqueueLiveSamples(slice.samples)
    }

    /**
     * Drain the VAD. Stop-recording calls this with `force`; the VAD itself drops
     * a final sliver shorter than 200 ms (and trims the trailing silence).
     */
    function flushLiveSamples(force = false) {
      if (!force) return
      const vad = liveEngine.vad
      if (vad === null) return
      const slice = vad.flush()
      if (slice !== null) enqueueLiveSamples(slice.samples)
    }

    function enqueueLiveSamples(samples) {
      if (!samples || samples.length === 0) return
      const queue = liveEngine.queue
      // When transcription falls behind, merge new audio into the newest pending
      // slice instead of growing the queue without bound.
      if (queue.length >= LIVE_MAX_PENDING) {
        queue[queue.length - 1] = concatFloat32([queue[queue.length - 1], samples])
      } else {
        queue.push(samples)
      }
      publishLiveQueue()
      void pumpLiveQueue()
    }

    async function pumpLiveQueue() {
      if (liveEngine.pumping) return
      liveEngine.pumping = true
      try {
        while (liveEngine.inFlight < LIVE_MAX_INFLIGHT && liveEngine.queue.length > 0) {
          const samples = liveEngine.queue.shift()
          liveEngine.inFlight += 1
          liveEngine.sentChunks += 1
          publishLiveQueue()
          void sendLiveChunk(samples)
        }
      } finally {
        liveEngine.pumping = false
        resolveLiveIdle()
      }
    }

    function applyLiveChunk(payload) {
      const status = snapshot.live.status
      if (status !== 'preparing' && status !== 'recording' && status !== 'stopping') return
      const text = String(payload?.text ?? '').trim()
      const serverTranscript = typeof payload?.transcript === 'string' ? payload.transcript : ''
      let transcript = serverTranscript
      if (transcript === '') {
        transcript = text === ''
          ? snapshot.live.transcript
          : (snapshot.live.transcript === '' ? text : `${snapshot.live.transcript}\n${text}`)
      }
      const patch = { transcript, chars: transcript.length, error: null }
      if (text !== '') patch.lastText = text.length > 90 ? text.slice(-90) : text
      publishLive(patch)
      if (snapshot.meeting !== null && snapshot.meeting.id === snapshot.live.meetingId) {
        const nextMeeting = { ...snapshot.meeting, transcript }
        const seconds = Number(payload?.transcriptSeconds)
        if (Number.isFinite(seconds) && seconds > 0) nextMeeting.transcriptSeconds = seconds
        commit({ meeting: nextMeeting })
      }
    }

    function handleLiveChunkError(error) {
      if (!liveIsActive()) return
      const message = messageOf(error)
      if (liveEngine.failureMessage === null) liveEngine.failureMessage = message
      publishLive({ error: message })
      reportError(error, '实时转写中断')
      if (snapshot.live.status === 'recording') void stopLiveRecording('error')
    }

    async function sendLiveChunk(samples) {
      const meetingId = snapshot.live.meetingId
      const session = liveEngine.sessionId
      try {
        if (meetingId === null) throw new Error('录制的会议不存在，无法转写')
        const payload = await postTranscription(meetingId, encodePcm16Wav(samples), {
          live: true,
          index: liveEngine.sentChunks,
        })
        if (liveEngine.sessionId === session) applyLiveChunk(payload)
      } catch (error) {
        if (liveEngine.sessionId === session) handleLiveChunkError(error)
      } finally {
        if (liveEngine.sessionId === session) {
          liveEngine.inFlight = Math.max(0, liveEngine.inFlight - 1)
          publishLiveQueue()
          resolveLiveIdle()
          void pumpLiveQueue()
        }
      }
    }

    function stopLiveCapture() {
      const processor = liveEngine.processor
      if (processor) {
        processor.onaudioprocess = null
        try { processor.disconnect() } catch { /* ignore */ }
        liveEngine.processor = null
      }
      const source = liveEngine.source
      if (source) {
        try { source.disconnect() } catch { /* ignore */ }
        liveEngine.source = null
      }
      const sink = liveEngine.sink
      if (sink) {
        try { sink.disconnect() } catch { /* ignore */ }
        liveEngine.sink = null
      }
      stopStream(liveEngine.stream)
      liveEngine.stream = null
      const context = liveEngine.context
      liveEngine.context = null
      if (context) {
        try {
          const closing = context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      }
      liveEngine.resampler = null
    }

    function releaseLiveAudio() {
      stopLiveCapture()
      liveEngine.vad = null
      liveEngine.queue = []
      liveEngine.inFlight = 0
      liveEngine.pumping = false
      liveEngine.level = 0
      liveEngine.resampler = null
      resolveLiveIdle()
    }

    async function startLiveRecording(input) {
      if (liveIsActive()) return false
      const token = liveEngine.startToken + 1
      liveEngine.startToken = token
      liveEngine.sessionId += 1
      liveEngine.failureMessage = null
      stopLiveTimer()
      releaseLiveAudio()
      liveEngine.waiters = []
      liveEngine.sentChunks = 0
      liveEngine.level = 0
      resetLiveState({
        status: 'preparing',
        meetingTitle: String(input?.title ?? defaultRecordingTitle()),
      })
      updateLiveBeforeUnload()
      let meeting = null
      try {
        await waitForSpeechReady()
        if (liveEngine.startToken !== token) return false
        meeting = await createMeeting({
          title: String(input?.title ?? defaultRecordingTitle()).trim() || defaultRecordingTitle(),
          date: input?.date || todayKey(),
          attendees: Array.isArray(input?.attendees) ? input.attendees : splitAttendees(input?.attendees),
          sourceType: 'recording',
        })
        if (liveEngine.startToken !== token) {
          void discardMeetingQuietly(meeting.id)
          return false
        }
        publishLive({ meetingId: meeting.id, meetingTitle: meeting.title })
        const capture = await openLiveCapture()
        if (liveEngine.startToken !== token) {
          releaseCaptureResources(capture)
          void discardMeetingQuietly(meeting.id)
          return false
        }
        liveEngine.stream = capture.stream
        liveEngine.context = capture.context
        liveEngine.source = capture.source
        liveEngine.processor = capture.processor
        liveEngine.sink = capture.sink
        liveEngine.resampler = capture.resampler
        // Read the pause preference now: a change in the bar applies to the next take.
        liveEngine.vad = createLiveVad({
          sampleRate: TARGET_RATE,
          silenceSeconds: readVadSilenceSeconds(),
        })
        capture.processor.onaudioprocess = onLiveAudioProcess
        publishLive({
          status: 'recording',
          startedAt: Date.now(),
          elapsedSeconds: 0,
          level: 0,
          error: null,
        })
        startLiveTimer()
        updateLiveBeforeUnload()
        return true
      } catch (error) {
        releaseLiveAudio()
        const message = messageOf(error)
        publishLive({ status: 'error', error: message })
        updateLiveBeforeUnload()
        reportError(error, '录音启动失败')
        return false
      }
    }

    async function stopLiveRecording(reason = 'user') {
      const status = snapshot.live.status
      if (status === 'preparing') {
        await cancelLiveRecording()
        return
      }
      if (status !== 'recording') return
      publishLive({ status: 'stopping' })
      updateLiveBeforeUnload()
      stopLiveTimer()
      stopLiveCapture()
      // Flush whatever the audio thread already handed us, then wait for every
      // in-flight request before finalising the meeting.
      flushLiveSamples(true)
      publishLiveQueue()
      const idle = await waitForLiveIdle(LIVE_IDLE_TIMEOUT_MS)
      await finalizeLiveRecording(reason, idle)
    }

    async function finalizeLiveRecording(reason, idleOk) {
      const meetingId = snapshot.live.meetingId
      // Merge the live slices into ONE retained copy before reading the meeting
      // back, so the record already carries audioPath + whole-meeting sha256.
      // A partial/errored stop still merges what was recorded.
      if (meetingId !== null && liveEngine.sentChunks > 0) {
        try {
          const merged = await requestJson(`/meetings/${encodeURIComponent(meetingId)}/audio/finalize`, {
            method: 'POST',
            body: {},
          })
          if (merged.meeting) commit({ meeting: merged.meeting })
        } catch (error) {
          reportError(error, '整场录音合并失败')
        }
      }
      let meeting = null
      if (meetingId !== null) {
        try {
          const payload = await requestJson(`/meetings/${encodeURIComponent(meetingId)}`)
          meeting = payload.meeting ?? null
        } catch (error) {
          reportError(error, '读取会议失败')
        }
      }
      if (meeting !== null) {
        if (snapshot.selectedId === meetingId) commit({ meeting })
        const transcript = typeof meeting.transcript === 'string' && meeting.transcript !== ''
          ? meeting.transcript
          : snapshot.live.transcript
        publishLive({ transcript, chars: transcript.length })
      } else if (snapshot.live.transcript !== '' && snapshot.selectedId === meetingId && snapshot.meeting !== null) {
        commit({ meeting: { ...snapshot.meeting, transcript: snapshot.live.transcript } })
      }
      await refreshList()
      const transcript = snapshot.live.transcript
      const chars = transcript.length
      const seconds = Number(meeting?.transcriptSeconds) || 0
      const failure = liveEngine.failureMessage
      releaseLiveAudio()
      stopLiveTimer()
      if (reason === 'error' || failure !== null) {
        publishLive({
          status: 'error',
          chars,
          error: failure || snapshot.live.error || '实时转写中断，已保留已识别内容',
          result: { meetingId, chars, seconds, sentChunks: liveEngine.sentChunks },
        })
        updateLiveBeforeUnload()
        return
      }
      if (!idleOk) {
        publishLive({
          status: 'error',
          chars,
          error: '等待最后几段识别超时，已保留已识别内容',
          result: { meetingId, chars, seconds, sentChunks: liveEngine.sentChunks },
        })
        updateLiveBeforeUnload()
        return
      }
      if (meetingId === null || chars === 0) {
        publishLive({
          status: 'error',
          chars: 0,
          error: '没有识别到文字，请确认麦克风权限与音量后重试，或改用文本导入',
          result: { meetingId, chars: 0, seconds, sentChunks: liveEngine.sentChunks },
        })
        updateLiveBeforeUnload()
        notify('error', '录音结束但未识别到文字', '请检查麦克风，或改用「导入纪要」的文本方式')
        return
      }
      publishLive({
        status: 'done',
        chars,
        transcript,
        result: { meetingId, chars, seconds, sentChunks: liveEngine.sentChunks },
      })
      updateLiveBeforeUnload()
      notifySuccess('实时转写完成', `已识别 ${formatChars(chars)}，可以生成 AI 纪要或写入任务日历`)
    }

    async function cancelLiveRecording() {
      liveEngine.startToken += 1
      liveEngine.sessionId += 1
      stopLiveTimer()
      releaseLiveAudio()
      updateLiveBeforeUnload()
      const meetingId = snapshot.live.meetingId
      resetLiveState()
      updateLiveBeforeUnload()
      if (meetingId !== null) await discardMeetingQuietly(meetingId)
      notify('warn', '已取消录音', meetingId === null ? '录音已停止' : '本次录音的临时会议已删除')
    }

    function clearLiveRecording() {
      if (liveIsActive()) return
      resetLiveState()
      updateLiveBeforeUnload()
    }

    async function deleteLiveMeeting() {
      if (liveIsActive()) {
        await cancelLiveRecording()
        return
      }
      const meetingId = snapshot.live.meetingId
      resetLiveState()
      updateLiveBeforeUnload()
      if (meetingId !== null) {
        await discardMeetingQuietly(meetingId)
        notify('warn', '已删除录音会议', '会议与转写内容已删除')
      }
    }

    // ─────────────────────────────── icons ────────────────────────────────

    const ICON_PATHS = {
      plus: ['M8 3.5v9M3.5 8h9'],
      mic: [
        'M8 2.5a2 2 0 0 1 2 2v3.2a2 2 0 0 1-4 0V4.5a2 2 0 0 1 2-2Z',
        'M4.2 7.4v.6a3.8 3.8 0 0 0 7.6 0v-.6',
        'M8 11.8v1.9',
        'M5.9 13.7h4.2',
      ],
      upload: [
        'M8 10.6V2.9',
        'M5.2 5.7 8 2.9l2.8 2.8',
        'M3 10.7v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5',
      ],
      sparkle: [
        'M7.2 2.2 8.5 5.4l3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2L2.7 6.7l3.2-1.3L7.2 2.2Z',
        'M12.4 10.9l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z',
      ],
      download: ['M8 2.9v7.6', 'M5.2 7.7 8 10.5l2.8-2.8', 'M3 12.8h10'],
      trash: [
        'M2.9 4.6h10.2',
        'M5.7 4.6V3.3h4.6v1.3',
        'M4.4 4.6l.6 8.3h6l.6-8.3',
        'M6.7 6.9v3.9',
        'M9.3 6.9v3.9',
      ],
      search: ['M7.1 2.9a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Z', 'm10.3 10.3 2.6 2.6'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      check: ['M3.2 8.4l3 3 6.6-6.8'],
      edit: ['M3 13h2.6l6.6-6.6-2.6-2.6L3 10.4V13Z', 'M9.4 4.2l2.4 2.4'],
      copy: ['M5.6 5.6V3.2h7.2v7.2h-2.4', 'M3.2 5.6h7.2v7.2H3.2Z'],
      refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13.1 2.9v3.5h-3.5'],
      calendar: [
        'M3.1 3.9h9.8v9H3.1z',
        'M3.1 6.5h9.8',
        'M5.5 2.6v2.4',
        'M10.5 2.6v2.4',
      ],
      clock: ['M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z', 'M8 5.4V8l1.9 1.1'],
      users: [
        'M6 3.1a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z',
        'M2.6 13c0-1.9 1.5-3.3 3.4-3.3s3.4 1.4 3.4 3.3',
        'M10.3 3.5a1.9 1.9 0 1 0 .1 3.8',
        'M11 9.8c1.4.2 2.4 1.5 2.4 3.2',
      ],
      doc: [
        'M4.2 2.6h5.1l2.5 2.5v8.3H4.2z',
        'M9.3 2.6v2.7h2.5',
        'M6 8h4',
        'M6 10.2h4',
      ],
      list: ['M5.6 4.2h7M5.6 8h7M5.6 11.8h7', 'M3 4.2h.8M3 8h.8M3 11.8h.8'],
      alert: ['M8 2.9 13 12.6H3L8 2.9Z', 'M8 6.5v2.9', 'M8 11.1v.2'],
      chevron: ['M6 4l4 4-4 4'],
      stop: ['M5 5h6v6H5z'],
      play: ['M6 4.3l5 3.7-5 3.7z'],
      folder: ['M2.8 4.2h4l1.2 1.5h5.2v6.8H2.8z'],
      info: ['M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z', 'M8 7.4v3.4', 'M8 5.2v.2'],
    }

    function Icon(props) {
      const paths = ICON_PATHS[props.name] ?? []
      return h(
        'svg',
        {
          width: props.size ?? 14,
          height: props.size ?? 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          className: props.className ?? undefined,
        },
        ...paths.map((d, index) => h('path', {
          key: index,
          d,
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth ?? 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })),
      )
    }

    /** Sidebar glyph: microphone + minutes lines, 18 px, inherits currentColor. */
    function MeetingGlyph(props) {
      const size = props?.size ?? 18
      const active = props?.active === true
      const state = useSnapshot()
      const pending = (state.meetings ?? []).reduce(
        (sum, item) => sum + (Number(item.pendingTodoCount) || 0),
        0,
      )
      const recording = liveIsActive(state.live)
      const stroke = active ? 1.6 : 1.3
      const glyph = h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3.1, y: 1.5, width: 4.2, height: 6.6, rx: 2.1, stroke: 'currentColor', strokeWidth: stroke }),
        h('path', { d: 'M1.8 7.1a3.8 3.8 0 0 0 7.6 0', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
        h('path', { d: 'M5.6 10.9v1.5M3.7 13h3.8', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
        h('path', { d: 'M10.7 3.3h3.1M10.7 6h3.1M10.7 8.7h2.1', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
        h('path', { d: 'M10.7 11.4h3.1', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', opacity: 0.55 }),
      )
      if (pending <= 0 && !recording) return glyph
      return h(
        'span',
        { className: 'dsm-icon-badge' },
        glyph,
        pending > 0 ? h('span', { className: 'dsm-icon-dot' }, pending > 99 ? '99+' : String(pending)) : null,
        recording ? h('span', { className: 'dsm-icon-live-dot', title: '正在录音' }) : null,
      )
    }

    // ─────────────────────────── shared controls ──────────────────────────

    function Field(props) {
      return h(
        'label',
        { className: 'dsm-field' },
        h('span', { className: 'dsm-label' }, props.label),
        props.children,
      )
    }

    function TextInput(props) {
      return h('input', {
        className: `dsm-input${props.compact ? ' dsm-input--cell' : ''}`,
        type: props.type ?? 'text',
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        onChange: (event) => { props.onChange(event.target.value) },
        onKeyDown: props.onKeyDown,
      })
    }

    function TextArea(props) {
      return h('textarea', {
        className: `dsm-input dsm-textarea${props.compact ? ' dsm-input--cell' : ''}`,
        rows: props.rows ?? 4,
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        onChange: (event) => { props.onChange(event.target.value) },
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          className: `dsm-input${props.compact ? ' dsm-input--cell' : ''}`,
          value: props.value,
          onChange: (event) => { props.onChange(event.target.value) },
        },
        ...props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function ToolbarButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dsm-btn${props.variant ? ` dsm-btn--${props.variant}` : ''}`,
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title ?? undefined,
        },
        props.icon ? h(Icon, { name: props.icon, size: 13 }) : null,
        h('span', null, props.label),
      )
    }

    function MetaChip(props) {
      return h(
        'span',
        {
          className: `dsm-meta-chip${props.tone ? ` dsm-meta-chip--${props.tone}` : ''}`,
          title: props.title ?? undefined,
        },
        props.icon ? h(Icon, { name: props.icon, size: 11 }) : null,
        h('span', null, props.label),
      )
    }

    function Badge(props) {
      return h('span', { className: `dsm-badge${props.tone ? ` dsm-badge--${props.tone}` : ''}` }, props.label)
    }

    function ProgressBar(props) {
      const ratio = Math.max(0, Math.min(1, Number(props.ratio) || 0))
      return h(
        'div',
        { className: 'dsm-progress' },
        h('div', { className: 'dsm-progress-bar', style: { width: `${Math.round(ratio * 100)}%` } }),
      )
    }

    function Modal(props) {
      const onClose = props.onClose
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && props.dismissible !== false) onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose, props.dismissible])
      return h(
        'div',
        { className: 'dsm-modal-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
        h('div', {
          className: 'dsm-modal-mask',
          onClick: props.dismissible === false ? undefined : onClose,
        }),
        h(
          'div',
          { className: `dsm-modal${props.wide ? ' dsm-modal--wide' : ''}` },
          h(
            'div',
            { className: 'dsm-modal-head' },
            h(
              'div',
              { className: 'dsm-modal-heading' },
              h('div', { className: 'dsm-modal-title' }, props.title),
              props.subtitle ? h('div', { className: 'dsm-modal-sub' }, props.subtitle) : null,
            ),
            props.dismissible === false
              ? h('span', { className: 'dsm-modal-lock' }, '处理中…')
              : h(
                'button',
                { type: 'button', className: 'dsm-iconbtn', onClick: onClose, 'aria-label': '关闭' },
                h(Icon, { name: 'close', size: 14 }),
              ),
          ),
          h('div', { className: 'dsm-modal-body' }, props.children),
          props.footer ? h('div', { className: 'dsm-modal-foot' }, props.footer) : null,
        ),
      )
    }

    function Section(props) {
      return h(
        'section',
        { className: 'dsm-doc-section' },
        h(
          'div',
          { className: 'dsm-section-band' },
          h('span', { className: 'dsm-section-icon' }, h(Icon, { name: props.icon ?? 'list', size: 13 })),
          h('h2', { className: 'dsm-section-title' }, props.title),
          props.count !== undefined ? h('span', { className: 'dsm-section-count' }, `（${props.count}）`) : null,
          props.sub ? h('span', { className: 'dsm-section-sub' }, props.sub) : null,
        ),
        props.children,
      )
    }

    // ────────────────────────────── dialogs ───────────────────────────────

    function NewMeetingModal(props) {
      const [title, setTitle] = useState('')
      const [date, setDate] = useState(todayKey())
      const [attendees, setAttendees] = useState('')
      const [notes, setNotes] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          const meeting = await createMeeting({
            title: title.trim() || defaultMeetingTitle(),
            date: date || todayKey(),
            attendees: splitAttendees(attendees),
            notes: notes.trim(),
          })
          notifySuccess('已创建会议', meeting.title)
          props.onClose()
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '创建会议失败')
        } finally {
          setBusy(false)
        }
      }
      return h(
        Modal,
        {
          title: '新建会议',
          subtitle: '先建好会议，再录音、导入转写或让 AI 生成纪要。',
          onClose: props.onClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '取消'),
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: submit,
              disabled: busy,
            }, busy ? '创建中…' : '创建会议'),
          ],
        },
        h(Field, { label: '会议标题（可留空，稍后自动命名）' }, h(TextInput, {
          value: title,
          onChange: setTitle,
          placeholder: `留空 = ${defaultMeetingTitle()}；也可以之后在会议里改`,
        })),
        h(
          'div',
          { className: 'dsm-row' },
          h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: date, onChange: setDate })),
          h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
            value: attendees,
            onChange: setAttendees,
            placeholder: '张三，李四',
          })),
        ),
        h(Field, { label: '备注（可选）' }, h(TextArea, {
          value: notes,
          onChange: setNotes,
          rows: 3,
          placeholder: '会议背景、目标…',
        })),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    function EditMeetingModal(props) {
      const meeting = props.meeting
      const [form, setForm] = useState(() => ({
        title: meeting?.title ?? '',
        date: meeting?.date ?? todayKey(),
        attendees: (meeting?.attendees ?? []).join('，'),
        notes: meeting?.notes ?? '',
      }))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const update = (key) => (value) => setForm((previous) => ({ ...previous, [key]: value }))
      const submit = async () => {
        if (form.title.trim() === '') {
          setError('会议标题不能为空')
          return
        }
        setBusy(true)
        setError(null)
        try {
          await patchMeeting(meeting.id, {
            title: form.title.trim(),
            date: form.date || todayKey(),
            attendees: splitAttendees(form.attendees),
            notes: form.notes,
          })
          notifySuccess('会议信息已更新', form.title.trim())
          props.onClose()
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '保存会议失败')
        } finally {
          setBusy(false)
        }
      }
      return h(
        Modal,
        {
          title: '编辑会议信息',
          onClose: props.onClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '取消'),
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: submit,
              disabled: busy,
            }, busy ? '保存中…' : '保存'),
          ],
        },
        h(Field, { label: '会议标题' }, h(TextInput, { value: form.title, onChange: update('title') })),
        h(
          'div',
          { className: 'dsm-row' },
          h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: form.date, onChange: update('date') })),
          h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
            value: form.attendees,
            onChange: update('attendees'),
          })),
        ),
        h(Field, { label: '备注' }, h(TextArea, { value: form.notes, onChange: update('notes'), rows: 3 })),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    function AutoIngestModal(props) {
      const status = props.status ?? null
      const available = status !== null && typeof status === 'object'
      const [enabled, setEnabled] = useState(status?.enabled !== false)
      const [tencent, setTencent] = useState(status?.tencent !== false)
      const [dirsText, setDirsText] = useState(() => (Array.isArray(status?.dirs) ? status.dirs.join('\n') : ''))
      const [busy, setBusy] = useState(false)
      const [scanning, setScanning] = useState(status?.scanning === true)
      const [error, setError] = useState(null)
      const mountedRef = useRef(true)
      const hydratedRef = useRef(available)

      useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      useEffect(() => {
        // The dialog can open before the first /state response; hydrate the
        // form once the projection arrives without overwriting later edits.
        if (hydratedRef.current || !available) return
        hydratedRef.current = true
        setEnabled(status.enabled !== false)
        setTencent(status.tencent !== false)
        setDirsText(Array.isArray(status.dirs) ? status.dirs.join('\n') : '')
      }, [available, status])

      useEffect(() => {
        setScanning(status?.scanning === true)
      }, [status?.scanning])

      const formPatch = () => ({
        enabled,
        tencent,
        dirs: parseAutoIngestDirs(dirsText),
      })

      const handleSave = async () => {
        if (!available) return
        setBusy(true)
        setError(null)
        try {
          const next = await saveAutoIngestSettings(formPatch())
          notifySuccess(
            '自动入库设置已保存',
            next?.enabled === false ? '已暂停自动扫描' : '已启用自动扫描',
          )
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '保存自动入库设置失败')
        } finally {
          if (mountedRef.current) setBusy(false)
        }
      }

      const handleScan = async () => {
        if (!available || scanning) return
        setScanning(true)
        setError(null)
        try {
          // Apply the visible form first so "scan" uses the settings on screen.
          await saveAutoIngestSettings(formPatch())
          const next = await scanAutoIngestAndWait()
          if (mountedRef.current) {
            notifySuccess('自动入库扫描完成', `已自动导入 ${Number(next?.importedCount) || 0} 场会议`)
          }
        } catch (caught) {
          if (mountedRef.current) {
            setError(messageOf(caught))
            reportError(caught, '自动入库扫描失败')
          }
        } finally {
          if (mountedRef.current) setScanning(false)
        }
      }

      const recent = available && Array.isArray(status.recent) ? status.recent : []
      const scanningNow = scanning || status?.scanning === true
      const tencentUsable = available && status.tencentAvailable === true
      const lastScan = available ? status.lastScanAt : null

      const statusCards = available
        ? [
          h(
            'div',
            { key: 'state', className: 'dsm-auto-card' },
            h('div', { className: 'dsm-auto-k' }, '运行状态'),
            h('div', { className: `dsm-auto-v${scanningNow ? ' dsm-auto-v--warn' : ''}` },
              scanningNow ? '扫描中…' : (status.enabled === false ? '已停用' : '运行中')),
            Number(status.pending) > 0
              ? h('div', { className: 'dsm-auto-path' }, `待处理 ${Number(status.pending)} 个`)
              : null,
          ),
          h(
            'div',
            { key: 'tencent', className: 'dsm-auto-card' },
            h('div', { className: 'dsm-auto-k' }, '腾讯会议本地录制数据库'),
            h(
              'div',
              { className: `dsm-auto-v ${tencentUsable ? 'dsm-auto-v--ok' : 'dsm-auto-v--warn'}` },
              tencentUsable ? `可用 · 已完成录制 ${Number(status.tencentRecords) || 0} 条` : '不可用',
            ),
            status.tencentError
              ? h('div', { className: 'dsm-auto-path dsm-auto-v--warn' }, String(status.tencentError))
              : null,
            status.tencentDbPath
              ? h('div', { className: 'dsm-auto-path', title: status.tencentDbPath }, String(status.tencentDbPath))
              : null,
          ),
          h(
            'div',
            { key: 'lastScan', className: 'dsm-auto-card' },
            h('div', { className: 'dsm-auto-k' }, '上次扫描时间'),
            h('div', { className: 'dsm-auto-v' }, lastScan ? formatStamp(lastScan) : '尚未扫描'),
          ),
          h(
            'div',
            { key: 'counts', className: 'dsm-auto-card' },
            h('div', { className: 'dsm-auto-k' }, '已自动导入 / 失败来源'),
            h('div', { className: 'dsm-auto-v' }, `${Number(status.importedCount) || 0} 场 · ${Number(status.failedCount) || 0} 个失败来源`),
          ),
          status.lastError
            ? h(
              'div',
              { key: 'lastError', className: 'dsm-auto-card dsm-auto-card--wide' },
              h('div', { className: 'dsm-auto-k' }, '最近错误'),
              h('div', { className: 'dsm-auto-v dsm-auto-v--error' }, String(status.lastError)),
            )
            : null,
        ]
        : [
          h(
            'div',
            { key: 'unavailable', className: 'dsm-auto-card dsm-auto-card--wide' },
            h('div', { className: 'dsm-auto-k' }, '自动入库'),
            h('div', { className: 'dsm-auto-v dsm-auto-v--warn' }, '宿主未提供自动入库服务（autoIngest 为空），当前无法配置。'),
          ),
        ]

      return h(
        Modal,
        {
          title: '自动入库设置',
          subtitle: '自动抓取本机录制文件并生成待整理的会议记录。',
          onClose: props.onClose,
          footer: [
            h('button', { key: 'close', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '关闭'),
            available
              ? h('button', {
                key: 'scan',
                type: 'button',
                className: 'dsm-btn',
                onClick: () => { void handleScan() },
                disabled: scanningNow || busy || !enabled,
                title: !enabled ? '请先启用自动入库' : undefined,
              }, scanningNow ? h('span', { className: 'dsm-spin' }) : h(Icon, { name: 'refresh', size: 13 }), h('span', null, scanningNow ? '扫描中…' : '立即扫描'))
              : null,
            available
              ? h('button', {
                key: 'save',
                type: 'button',
                className: 'dsm-btn dsm-btn--primary',
                onClick: () => { void handleSave() },
                disabled: busy || scanningNow,
              }, busy ? '保存中…' : '保存设置')
              : null,
          ],
        },
        h(
          'div',
          { className: 'dsm-auto-toggles' },
          h(
            'label',
            { className: 'dsm-auto-toggle' },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: !available,
              onChange: (event) => setEnabled(event.target.checked),
            }),
            h(
              'span',
              { className: 'dsm-auto-toggle-body' },
              h('span', { className: 'dsm-auto-toggle-title' }, '自动入库总开关'),
              h('span', { className: 'dsm-auto-toggle-text' }, '开启后定时扫描腾讯会议本地录制与额外监控目录，自动把新文件导入会议列表。'),
            ),
          ),
          h(
            'label',
            { className: 'dsm-auto-toggle' },
            h('input', {
              type: 'checkbox',
              checked: tencent,
              disabled: !available,
              onChange: (event) => setTencent(event.target.checked),
            }),
            h(
              'span',
              { className: 'dsm-auto-toggle-body' },
              h('span', { className: 'dsm-auto-toggle-title' }, '腾讯会议本地录制自动提取'),
              h('span', { className: 'dsm-auto-toggle-text' }, '从本机腾讯会议数据库读取录制记录并转写；不读取云端智能纪要。'),
            ),
          ),
        ),
        h('div', { className: 'dsm-auto-grid' }, ...statusCards),
        h(
          'div',
          { className: 'dsm-auto-card dsm-auto-card--wide' },
          h('div', { className: 'dsm-auto-k' }, '额外监控目录（一行一个路径）'),
          h(TextArea, {
            rows: 4,
            value: dirsText,
            onChange: setDirsText,
            placeholder: '/Users/me/Movies/TencentMeeting\n/Users/me/Documents/会议录音',
          }),
          h('div', { className: 'dsm-auto-path' }, '支持 audio / video / txt / md / docx 文件；新增文件会在下一次扫描时导入。'),
        ),
        scanningNow
          ? h('div', { className: 'dsm-hint' }, '正在扫描：每 2 秒检查一次，最多等待 60 秒。')
          : null,
        h(
          'div',
          { className: 'dsm-auto-note' },
          '自动抓取的是本机录制文件；腾讯云端智能纪要需要先导出到监控目录，或通过企业 API 接入。',
        ),
        recent.length > 0
          ? h(
            'div',
            { className: 'dsm-field' },
            h('span', { className: 'dsm-label' }, `最近自动导入（${recent.length}）`),
            h(
              'div',
              { className: 'dsm-auto-recent' },
              ...recent.map((entry) => h(
                'button',
                {
                  key: entry.key ?? entry.meetingId ?? entry.title,
                  type: 'button',
                  className: 'dsm-auto-recent-item',
                  title: entry.path ?? entry.title,
                  onClick: () => {
                    if (entry.meetingId) props.onSelectMeeting(entry.meetingId)
                    else props.onClose()
                  },
                },
                h('span', { className: 'dsm-auto-recent-title' }, entry.title || entry.meetingId || entry.key || '未命名会议'),
                h('span', { className: 'dsm-auto-recent-time' }, entry.at ? formatStamp(entry.at) : ''),
              )),
            ),
          )
          : null,
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    function ImportTextModal(props) {
      const meeting = props.meeting
      const [tab, setTab] = useState('paste')
      const [text, setText] = useState('')
      const [fileName, setFileName] = useState('')
      const [mode, setMode] = useState('replace')
      const [title, setTitle] = useState(meeting ? meeting.title : `会议纪要 ${todayKey()}`)
      const [date, setDate] = useState(meeting?.date ?? todayKey())
      const [attendees, setAttendees] = useState((meeting?.attendees ?? []).join('，'))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const fileRef = useRef(null)
      // Parsing a large Tencent JSON export on every keystroke would be wasteful;
      // derive the preview once per text change instead.
      const preview = useMemo(() => extractTencentText(text), [text])

      const readFile = async (file) => {
        if (!file) return
        setError(null)
        try {
          const raw = await file.text()
          setText(raw)
          setFileName(file.name)
          setTab('paste')
          if (!meeting) {
            const nextTitle = defaultImportTitle(file.name)
            setTitle((previous) => (previous.trim() === '' ? nextTitle : previous))
          }
        } catch (caught) {
          setError(`读取文件失败：${messageOf(caught)}`)
        }
      }

      const submit = async () => {
        const extracted = preview
        if (extracted === '') {
          setError('请先粘贴或导入会议纪要文本')
          return
        }
        setBusy(true)
        setError(null)
        try {
          if (meeting) {
            const patch = mode === 'append'
              ? { transcript: extracted, appendTranscript: true }
              : { transcript: extracted }
            await patchMeeting(meeting.id, patch)
            notifySuccess(
              mode === 'append' ? '已追加转写文本' : '已替换转写文本',
              `${formatChars(extracted.length)} · ${meeting.title} · 建议重新生成 AI 纪要`,
            )
          } else {
            const created = await createMeeting({
              title: title.trim() || `会议纪要 ${todayKey()}`,
              date: date || todayKey(),
              attendees: splitAttendees(attendees),
              sourceType: 'text',
              transcript: extracted,
            })
            notifySuccess('已导入会议纪要', `${created.title} · ${formatChars(extracted.length)}`)
          }
          props.onClose()
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '导入纪要失败')
        } finally {
          setBusy(false)
        }
      }

      const footer = [
        h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '取消'),
        h('button', {
          key: 'ok',
          type: 'button',
          className: 'dsm-btn dsm-btn--primary',
          onClick: submit,
          disabled: busy,
        }, busy ? '导入中…' : meeting ? (mode === 'append' ? '追加到当前会议' : '替换当前转写') : '创建并导入'),
      ]

      return h(
        Modal,
        {
          title: meeting ? '导入纪要文本' : '导入腾讯会议纪要',
          subtitle: meeting
            ? `目标会议：${meeting.title}。可粘贴腾讯会议导出的文本，或选择 .txt / .md / .json 文件。`
            : '粘贴腾讯会议纪要文本，或选择 .txt / .md / .json 文件；JSON 会自动提取正文。',
          onClose: props.onClose,
          footer,
        },
        h(
          'div',
          { className: 'dsm-tabs' },
          h('button', {
            type: 'button',
            className: `dsm-tab${tab === 'paste' ? ' dsm-tab--active' : ''}`,
            onClick: () => setTab('paste'),
          }, '粘贴文本'),
          h('button', {
            type: 'button',
            className: `dsm-tab${tab === 'file' ? ' dsm-tab--active' : ''}`,
            onClick: () => setTab('file'),
          }, '选择文件'),
        ),
        tab === 'paste'
          ? h(TextArea, {
            value: text,
            onChange: setText,
            rows: 10,
            placeholder: '在此粘贴会议纪要、转写文本或腾讯会议导出的 JSON…',
          })
          : h(
            'div',
            { className: 'dsm-file-pick' },
            h('button', {
              type: 'button',
              className: 'dsm-btn',
              onClick: () => { fileRef.current?.click() },
            }, h(Icon, { name: 'folder', size: 13 }), h('span', null, '选择 .txt / .md / .json 文件')),
            fileName !== '' ? h('span', { className: 'dsm-file-name' }, `已选择：${fileName}`) : null,
            h('input', {
              ref: fileRef,
              type: 'file',
              className: 'dsm-hidden',
              accept: '.txt,.md,.json,text/plain,text/markdown,application/json',
              onChange: (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void readFile(file)
              },
            }),
          ),
        text !== '' ? h('div', { className: 'dsm-hint' }, `将导入 ${formatChars(preview.length)}，JSON 会自动提取正文。`) : null,
        meeting
          ? h(
            'div',
            { className: 'dsm-field' },
            h('span', { className: 'dsm-label' }, '写入方式'),
            h(
              'div',
              { className: 'dsm-radio-row' },
              h('label', { className: 'dsm-radio' }, h('input', {
                type: 'radio',
                name: 'dsm-import-mode',
                checked: mode === 'replace',
                onChange: () => setMode('replace'),
              }), '替换现有转写'),
              h('label', { className: 'dsm-radio' }, h('input', {
                type: 'radio',
                name: 'dsm-import-mode',
                checked: mode === 'append',
                onChange: () => setMode('append'),
              }), '追加到现有转写'),
            ),
          )
          : h(
            'div',
            null,
            h(
              'div',
              { className: 'dsm-row' },
              h(Field, { label: '会议标题' }, h(TextInput, { value: title, onChange: setTitle })),
              h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: date, onChange: setDate })),
            ),
            h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
              value: attendees,
              onChange: setAttendees,
              placeholder: '张三，李四',
            })),
          ),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    function SpeechProgressCard() {
      const state = useSnapshot()
      const speech = state.speech ?? state.data?.speech
      const provider = speechProvider(speech)
      const progress = state.speechProgress
      const percent = progress !== null ? Math.round(progress.ratio * 100) : null
      const label = state.speechMessage !== '' ? state.speechMessage : `语音识别：${speechPhaseLabel(provider?.phase)}`
      return h(
        'div',
        { className: 'dsm-progress-card' },
        h(
          'div',
          { className: 'dsm-progress-head' },
          h('span', { className: 'dsm-spin' }),
          h('span', { className: 'dsm-progress-title' }, label),
          percent !== null ? h('span', { className: 'dsm-progress-pct' }, `${percent}%`) : null,
        ),
        progress !== null ? h(ProgressBar, { ratio: progress.ratio }) : null,
        progress !== null && progress.total > 0
          ? h('div', { className: 'dsm-progress-meta' }, `${formatBytes(progress.done)} / ${formatBytes(progress.total)}${progress.resource ? ` · ${progress.resource}` : ''}`)
          : null,
        h('div', { className: 'dsm-hint' }, '首次使用需要下载并加载本地语音模型，请保持页面打开。'),
      )
    }

    function RecordModal(props) {
      const state = useSnapshot()
      const live = state.live ?? initialLiveState()
      const [tab, setTab] = useState('record')
      const [form, setForm] = useState(() => ({
        title: defaultRecordingTitle(),
        date: todayKey(),
        attendees: '',
      }))
      const [localError, setLocalError] = useState(null)
      const [fileStage, setFileStage] = useState('idle')
      const [fileError, setFileError] = useState(null)
      const [fileResult, setFileResult] = useState(null)
      const [processLabel, setProcessLabel] = useState('')
      const [pickedName, setPickedName] = useState('')
      const fileRef = useRef(null)
      const mountedRef = useRef(true)
      const runSeqRef = useRef(0)
      const createdRef = useRef(null)

      const speech = state.speech ?? state.data?.speech
      const speechAvailable = speechUsable(speech)
      const liveActive = liveIsActive(live)
      const liveStatus = live.status
      const fileBusy = fileStage === 'preparing' || fileStage === 'processing'
      const dismissible = liveActive || fileStage !== 'processing'

      const update = (key) => (value) => setForm((previous) => ({ ...previous, [key]: value }))

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          runSeqRef.current += 1
        }
      }, [])

      async function runFileImport(file) {
        if (!file) return
        const run = runSeqRef.current + 1
        runSeqRef.current = run
        const alive = () => mountedRef.current && runSeqRef.current === run
        setPickedName(file.name)
        setFileError(null)
        setFileStage('preparing')
        try {
          await waitForSpeechReady()
          if (!alive()) return
          const meeting = await createMeeting({
            title: form.title.trim() || defaultImportTitle(file.name),
            date: form.date || todayKey(),
            attendees: splitAttendees(form.attendees),
            sourceType: 'recording',
          })
          if (!alive()) {
            void discardMeetingQuietly(meeting.id)
            return
          }
          createdRef.current = meeting.id
          setFileStage('processing')
          setProcessLabel('正在解码音频…')
          const chunks = await audioBlobToWavChunks(file)
          if (!alive()) return
          setProcessLabel(`音频已切分为 ${chunks.length} 段，开始识别…`)
          const outcome = await transcribeAudioChunks(meeting.id, chunks)
          if (!alive()) return
          const text = outcome.text.trim()
          if (text === '') {
            throw new Error('没有识别到文字，请确认音频中有清晰语音，或改用文本导入')
          }
          setProcessLabel('正在保存转写…')
          await patchMeeting(meeting.id, { transcript: text })
          if (!alive()) return
          setFileResult({
            meetingId: meeting.id,
            chars: text.length,
            seconds: Math.round(outcome.audioSeconds),
            chunks: outcome.total,
          })
          setFileStage('done')
          notifySuccess('音频转写完成', `已识别 ${formatChars(text.length)}，可以生成 AI 纪要`)
        } catch (caught) {
          if (!alive()) return
          setFileStage('error')
          setFileError(messageOf(caught))
          reportError(caught, '音频转写失败')
        }
      }

      function closeModal() {
        runSeqRef.current += 1
        props.onClose()
      }

      function closeAfterFileDone() {
        props.onClose()
      }

      function deleteFileMeeting() {
        const id = createdRef.current
        props.onClose()
        if (id !== null) void discardMeetingQuietly(id)
      }

      function fallbackToTextImport() {
        runSeqRef.current += 1
        props.onClose()
        props.onOpenTextImport()
      }

      function startLive() {
        // Urgent meeting: start first, name later. An empty title becomes the
        // automatic placeholder and the summarizer proposes a real one later.
        setLocalError(null)
        void startLiveRecording({
          title: form.title.trim() === '' ? undefined : form.title.trim(),
          date: form.date || todayKey(),
          attendees: splitAttendees(form.attendees),
        })
      }

      function finishLiveAndClose() {
        clearLiveRecording()
        props.onClose()
      }

      function summarizeLive() {
        const meetingId = live.result?.meetingId ?? live.meetingId
        clearLiveRecording()
        props.onClose()
        if (meetingId) props.onSummarize(meetingId)
      }

      function fallbackLive() {
        clearLiveRecording()
        props.onClose()
        props.onOpenTextImport()
      }

      function keepLiveAndClose() {
        clearLiveRecording()
        props.onClose()
      }

      function deleteLive() {
        void deleteLiveMeeting()
        props.onClose()
      }

      const liveTitle = liveStatus === 'preparing'
        ? '准备实时转写'
        : liveStatus === 'recording'
          ? '实时转写中'
          : liveStatus === 'stopping'
            ? '正在收尾转写'
            : liveStatus === 'done'
              ? '实时转写完成'
              : liveStatus === 'error'
                ? '实时转写中断'
                : '录音转文字'
      const title = liveStatus !== 'idle'
        ? liveTitle
        : fileStage === 'done'
          ? '音频转写完成'
          : fileStage === 'error'
            ? '音频转写失败'
            : '录音转文字'
      const subtitle = liveStatus === 'preparing'
        ? '正在启动语音识别，就绪后自动开始录音。'
        : liveStatus === 'recording'
          ? '停顿约 1.5 秒自动切出一句；说完停一两秒就出字，关闭弹窗后仍在后台录音。'
          : liveStatus === 'stopping'
            ? '正在等待最后几段识别结果，完成后自动保存。'
            : liveStatus === 'done' || liveStatus === 'error'
              ? '录音已结束，转写内容已保存到会议。'
              : fileStage === 'preparing'
                ? '正在准备语音识别，就绪后自动转写文件。'
                : fileStage === 'processing'
                  ? '正在解码并识别音频文件，请保持页面打开。'
                  : '实时转写边录边出字；也可以导入已有的音频文件。'

      let body = null
      if (liveActive) {
        const preparing = liveStatus === 'preparing'
        const stopping = liveStatus === 'stopping'
        body = [
          h(
            'div',
            { key: 'live', className: 'dsm-live-panel' },
            h(
              'div',
              { className: 'dsm-live-head' },
              h('span', { className: 'dsm-livebar-dot' }),
              h('span', null, preparing ? '正在准备语音识别…' : stopping ? '正在收尾转写…' : '正在录音'),
              h('span', { className: 'dsm-hint' }, live.meetingTitle ?? ''),
            ),
            h(
              'div',
              { className: 'dsm-live-grid' },
              h(
                'div',
                { className: 'dsm-live-stat' },
                h('div', { className: 'dsm-live-stat-label' }, '录音时长'),
                h('div', { className: 'dsm-live-stat-value' }, formatTimer(live.elapsedSeconds)),
              ),
              h(
                'div',
                { className: 'dsm-live-stat' },
                h('div', { className: 'dsm-live-stat-label' }, '已转写字数'),
                h('div', { className: 'dsm-live-stat-value' }, formatChars(live.chars)),
              ),
            ),
            h('div', { className: 'dsm-level' }, h('div', {
              className: 'dsm-level-bar',
              style: { width: `${Math.max(4, Math.round((live.level ?? 0) * 100))}%` },
            })),
            h(
              'div',
              { className: 'dsm-live-last' },
              h('div', { className: 'dsm-live-last-label' }, '最近一句'),
              live.lastText !== ''
                ? live.lastText
                : (preparing ? '等待语音模型就绪…' : '等待第一段识别结果…（先说一句，停顿约 1.5 秒即出字）'),
            ),
            preparing ? h(SpeechProgressCard, { key: 'speech' }) : null,
            stopping
              ? h(
                'div',
                { className: 'dsm-live-stopping' },
                h('span', { className: 'dsm-spin' }),
                h('span', null, '正在等待最后几段识别结果…'),
              )
              : null,
            h('div', { className: 'dsm-live-queue' }, `识别队列：在飞 ${live.inFlight} · 待发 ${live.queued} · 已发送 ${live.sentChunks} 段`),
            h('div', { className: 'dsm-hint' }, preparing
              ? '语音模型就绪后自动开始录音；关闭弹窗不会中断。'
              : `停顿 ${readVadSilenceSeconds()} 秒自动切出一句（可在浮条上调整）；可在后台录音，停止后会等待所有在飞识别完成。`),
          ),
        ]
      } else if (liveStatus === 'done') {
        const result = live.result ?? { meetingId: live.meetingId, chars: live.chars, seconds: 0, sentChunks: live.sentChunks }
        body = [
          h(
            'div',
            { key: 'live-done', className: 'dsm-record-stage' },
            h('div', { className: 'dsm-done-icon' }, h(Icon, { name: 'check', size: 24 })),
            h('div', { className: 'dsm-stage-title' }, '实时转写完成并已保存'),
            h('div', { className: 'dsm-stage-text' }, `已识别 ${formatChars(result.chars)}${result.seconds > 0 ? ` · 音频 ${formatDuration(result.seconds)}` : ''} · 共 ${result.sentChunks ?? live.sentChunks} 段。`),
            h('div', { className: 'dsm-hint' }, '接下来可以生成 AI 结构化纪要，或把待办写入任务日历。'),
          ),
        ]
      } else if (liveStatus === 'error') {
        body = [
          h(
            'div',
            { key: 'live-error', className: 'dsm-record-stage' },
            h('div', { className: 'dsm-inline-error' }, live.error ?? '实时转写失败'),
            live.chars > 0
              ? h('div', { className: 'dsm-stage-text' }, `已保留已识别的 ${formatChars(live.chars)}，可在会议里继续编辑或重新生成纪要。`)
              : h('div', { className: 'dsm-stage-text' }, '本次录音没有可用的转写内容，可以改用文本导入。'),
          ),
        ]
      } else if (fileStage === 'preparing') {
        body = [
          h(SpeechProgressCard, { key: 'speech' }),
          h('div', { key: 'hint', className: 'dsm-hint' }, '语音模型就绪后自动转写音频文件。'),
        ]
      } else if (fileStage === 'processing') {
        const active = state.transcribing
        body = [
          h(
            'div',
            { key: 'processing', className: 'dsm-record-stage' },
            h('span', { className: 'dsm-spin dsm-spin--lg' }),
            h('div', { className: 'dsm-stage-title' }, active !== null ? '正在转写音频文件' : (processLabel || '正在处理音频')),
            active !== null
              ? h('div', { className: 'dsm-stage-text' }, `正在识别第 ${Math.min(active.index + 1, active.total)} / ${active.total} 段 · 已识别 ${formatChars(active.chars)}`)
              : h('div', { className: 'dsm-stage-text' }, processLabel),
            active !== null ? h(ProgressBar, { ratio: active.total > 0 ? active.index / active.total : 0 }) : null,
            h('div', { className: 'dsm-hint' }, '文件转写可能需要几分钟，完成后会自动保存到会议。'),
          ),
        ]
      } else if (fileStage === 'done' && fileResult !== null) {
        body = [
          h(
            'div',
            { key: 'file-done', className: 'dsm-record-stage' },
            h('div', { className: 'dsm-done-icon' }, h(Icon, { name: 'check', size: 24 })),
            h('div', { className: 'dsm-stage-title' }, '音频转写完成并已保存'),
            h('div', { className: 'dsm-stage-text' }, `已识别 ${formatChars(fileResult.chars)}${fileResult.seconds > 0 ? ` · 音频 ${formatDuration(fileResult.seconds)}` : ''} · 共 ${fileResult.chunks} 段。`),
            h('div', { className: 'dsm-hint' }, '接下来可以生成 AI 结构化纪要，或把待办写入任务日历。'),
          ),
        ]
      } else if (fileStage === 'error') {
        body = [
          h('div', { key: 'file-error', className: 'dsm-inline-error' }, fileError ?? '音频转写失败'),
          h('div', { key: 'file-hint', className: 'dsm-hint' }, '可以改用「导入纪要」粘贴文本，或删除本次会议后重试。'),
        ]
      } else {
        body = [
          h(
            'div',
            { key: 'tabs', className: 'dsm-tabs' },
            h('button', {
              type: 'button',
              className: `dsm-tab${tab === 'record' ? ' dsm-tab--active' : ''}`,
              onClick: () => { setTab('record'); setLocalError(null) },
            }, h(Icon, { name: 'mic', size: 12 }), h('span', null, '实时录音')),
            h('button', {
              type: 'button',
              className: `dsm-tab${tab === 'file' ? ' dsm-tab--active' : ''}`,
              onClick: () => { setTab('file'); setLocalError(null) },
            }, h(Icon, { name: 'upload', size: 12 }), h('span', null, '导入音频文件')),
          ),
          h(
            'div',
            { key: 'form' },
            h(
              'div',
              { className: 'dsm-row' },
              h(Field, { label: '会议标题（可留空）' }, h(TextInput, {
                value: form.title,
                onChange: update('title'),
                placeholder: `留空 = ${defaultRecordingTitle()}；之后可改，AI 生成纪要时会自动起名`,
              })),
              h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: form.date, onChange: update('date') })),
            ),
            h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
              value: form.attendees,
              onChange: update('attendees'),
              placeholder: '张三，李四',
            })),
          ),
          h('div', { key: 'hint', className: 'dsm-hint' }, tab === 'record'
            ? '停顿约 1.5 秒自动切出一句（浮条上可改成 3 / 5 秒）；标题可留空，会自动命名，之后可改。可在后台录音，关闭弹窗不中断。'
            : '文件转写仍使用浏览器解码 → 16kHz 单声道 PCM16 WAV → 90 秒切片逐段识别；支持 WAV / MP3 / M4A / MP4 / WebM。'),
          speechAvailable
            ? null
            : h('div', {
              key: 'speech-warn',
              className: 'dsm-hint dsm-hint--warn',
            }, speech === null
              ? '正在检查语音识别服务…'
              : '本机语音识别服务不可用，录音按钮不可用；请改用「导入纪要」的文本方式。'),
          tab === 'file'
            ? h(
              'div',
              { key: 'file', className: 'dsm-file-pick' },
              h('button', {
                type: 'button',
                className: 'dsm-btn',
                onClick: () => { fileRef.current?.click() },
                disabled: !speechAvailable || fileBusy,
              }, h(Icon, { name: 'upload', size: 13 }), h('span', null, '选择音频 / 视频文件')),
              pickedName !== '' ? h('span', { className: 'dsm-file-name' }, `已选择：${pickedName}`) : null,
              h('input', {
                ref: fileRef,
                type: 'file',
                className: 'dsm-hidden',
                accept: 'audio/*,video/*,.m4a,.mp4,.wav,.mp3,.webm',
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void runFileImport(file)
                },
              }),
            )
            : null,
          localError !== null
            ? h('div', { key: 'local-error', className: 'dsm-inline-error' }, localError)
            : null,
        ]
      }

      let footer = null
      if (liveActive) {
        if (liveStatus === 'preparing') {
          footer = [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsm-btn dsm-btn--danger',
              onClick: () => { void cancelLiveRecording(); props.onClose() },
            }, '取消并删除会议'),
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台准备（关闭）'),
          ]
        } else if (liveStatus === 'recording') {
          footer = [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsm-btn dsm-btn--danger',
              onClick: () => { void cancelLiveRecording(); props.onClose() },
            }, '取消并删除会议'),
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台录音（关闭）'),
            h('button', {
              key: 'stop',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { void stopLiveRecording('user') },
            }, h(Icon, { name: 'stop', size: 12 }), h('span', null, '停止并转写')),
          ]
        } else {
          footer = [
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台等待（关闭）'),
          ]
        }
      } else if (liveStatus === 'done') {
        footer = [
          h('button', { key: 'close', type: 'button', className: 'dsm-btn', onClick: finishLiveAndClose }, '完成'),
          h('button', {
            key: 'summarize',
            type: 'button',
            className: 'dsm-btn dsm-btn--primary',
            onClick: summarizeLive,
          }, h(Icon, { name: 'sparkle', size: 13 }), h('span', null, 'AI 生成纪要')),
        ]
      } else if (liveStatus === 'error') {
        footer = [
          h('button', { key: 'fallback', type: 'button', className: 'dsm-btn', onClick: fallbackLive }, '改用文本导入'),
          h('button', { key: 'keep', type: 'button', className: 'dsm-btn', onClick: keepLiveAndClose }, '保留并关闭'),
          live.meetingId !== null
            ? h('button', { key: 'delete', type: 'button', className: 'dsm-btn dsm-btn--danger', onClick: deleteLive }, '删除会议')
            : null,
        ]
      } else if (fileStage === 'preparing') {
        footer = [
          h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: closeModal }, '取消'),
        ]
      } else if (fileStage === 'processing') {
        footer = [h('span', { key: 'hint', className: 'dsm-hint' }, '正在处理，请保持页面打开…')]
      } else if (fileStage === 'done' && fileResult !== null) {
        footer = [
          h('button', { key: 'close', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '完成'),
          h('button', {
            key: 'summarize',
            type: 'button',
            className: 'dsm-btn dsm-btn--primary',
            onClick: () => {
              const meetingId = fileResult.meetingId
              props.onClose()
              props.onSummarize(meetingId)
            },
          }, h(Icon, { name: 'sparkle', size: 13 }), h('span', null, 'AI 生成纪要')),
        ]
      } else if (fileStage === 'error') {
        footer = [
          h('button', { key: 'fallback', type: 'button', className: 'dsm-btn', onClick: fallbackToTextImport }, '改用文本导入'),
          h('button', { key: 'delete', type: 'button', className: 'dsm-btn dsm-btn--danger', onClick: deleteFileMeeting }, '删除会议并关闭'),
        ]
      } else {
        footer = [
          h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: closeModal }, '取消'),
          tab === 'record'
            ? h('button', {
              key: 'start',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: startLive,
              disabled: !speechAvailable,
              title: speechAvailable ? undefined : '本机语音识别服务不可用',
            }, h(Icon, { name: 'mic', size: 13 }), h('span', null, '开始实时转写'))
            : h('button', {
              key: 'pick',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { fileRef.current?.click() },
              disabled: !speechAvailable || fileBusy,
              title: speechAvailable ? undefined : '本机语音识别服务不可用',
            }, h(Icon, { name: 'upload', size: 13 }), h('span', null, '选择文件并转写')),
        ]
      }

      return h(
        Modal,
        {
          title,
          subtitle,
          wide: true,
          dismissible,
          onClose: closeModal,
          footer,
        },
        ...body,
      )
    }

    // ─────────────────────────────── list ─────────────────────────────────

    function MeetingList(props) {
      const { meetings, selectedId, search, onSearch, filter, onFilter, onSelect } = props
      const total = Number(props.total) || meetings.length
      const filters = [
        { id: 'all', label: '全部' },
        { id: 'summarized', label: '已总结' },
        { id: 'unsummarized', label: '未总结' },
        { id: 'pending', label: '有未写入待办' },
      ]
      return h(
        'aside',
        { className: 'dsm-side' },
        h(
          'div',
          { className: 'dsm-side-head' },
          h(
            'div',
            { className: 'dsm-side-title' },
            h('span', null, '会议'),
            h('span', { className: 'dsm-side-count' }, meetings.length === total ? `${total} 场` : `${meetings.length} / ${total} 场`),
          ),
          h(
            'div',
            { className: 'dsm-search' },
            h('span', { className: 'dsm-search-icon' }, h(Icon, { name: 'search', size: 13 })),
            h('input', {
              className: 'dsm-input dsm-input--search',
              value: search,
              placeholder: '搜索标题、参会人…',
              onChange: (event) => onSearch(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dsm-filters' },
            ...filters.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: `dsm-filter${filter === item.id ? ' dsm-filter--active' : ''}`,
              onClick: () => onFilter(item.id),
            }, item.label)),
          ),
        ),
        h(
          'div',
          { className: 'dsm-list' },
          meetings.length === 0
            ? h(
              'div',
              { className: 'dsm-empty-list' },
              search.trim() !== '' ? '没有匹配的会议，试试其他关键词。' : '当前筛选条件下没有会议。',
              h('div', { style: { marginTop: 8 } }, h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: () => { onSearch(''); onFilter('all') },
              }, '清除筛选')),
            )
            : null,
          ...meetings.map((item) => {
            const todoCount = Number(item.todoCount) || 0
            const pending = Number(item.pendingTodoCount) || 0
            const attendees = Array.isArray(item.attendees) ? item.attendees : []
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                title: item.title,
                className: `dsm-meeting${item.id === selectedId ? ' dsm-meeting--active' : ''}`,
                onClick: () => onSelect(item.id),
              },
              h(
                'div',
                { className: 'dsm-meeting-top' },
                h('span', { className: 'dsm-meeting-title' }, item.title || '未命名会议'),
                item.hasSummary ? h('span', { className: 'dsm-meeting-check', title: '已生成 AI 纪要' }, '✓') : null,
                attendees.length > 0
                  ? h('span', { className: 'dsm-avatars' }, ...attendees.slice(0, 3).map((name, index) => h(
                    'span',
                    { key: `${name}-${index}`, className: 'dsm-avatar', title: name },
                    String(name).slice(0, 1),
                  )))
                  : null,
              ),
              h(
                'div',
                { className: 'dsm-meeting-meta' },
                h('span', null, humanDate(item.date)),
                h('span', { className: 'dsm-sep' }),
                h('span', null, SOURCE_LABELS[item.sourceType] ?? '文本'),
                todoCount > 0 ? h('span', { className: 'dsm-sep' }) : null,
                todoCount > 0 ? h('span', null, `待办 ${todoCount}`) : null,
              ),
              todoCount > 0 || pending > 0 || item.hasSummary || item.autoImported
                ? h(
                  'div',
                  { className: 'dsm-meeting-badges' },
                  item.autoImported ? h(Badge, { tone: 'brand', label: '自动' }) : null,
                  item.hasSummary ? h(Badge, { tone: 'ok', label: '✓ 已总结' }) : null,
                  todoCount > 0 ? h(Badge, { label: `待办 ${todoCount}` }) : null,
                  pending > 0 ? h(Badge, { tone: 'warn', label: `未写入 ${pending}` }) : null,
                )
                : null,
            )
          }),
        ),
      )
    }

    // ────────────────────────────── document ──────────────────────────────

    function SummarizingCard(props) {
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])
      const seconds = Math.max(0, Math.round((now - (props.startedAt ?? now)) / 1000))
      return h(
        'div',
        { className: 'dsm-summarizing' },
        h('span', { className: 'dsm-spin' }),
        h(
          'div',
          { className: 'dsm-summarizing-text' },
          h('div', null, 'AI 正在梳理会议内容并提取待办…'),
          h('div', { className: 'dsm-summarizing-sub' }, `已等待 ${seconds} 秒，通常需要 30–120 秒，请保持页面打开。`),
        ),
      )
    }

    function CoverSection(props) {
      const meeting = props.meeting
      const summary = meeting.summary
      const attendees = (Array.isArray(meeting.attendees) && meeting.attendees.length > 0
        ? meeting.attendees
        : (summary?.attendees ?? []))
      const chips = [
        h(MetaChip, { key: 'date', icon: 'calendar', label: humanDate(meeting.date) }),
        h(MetaChip, {
          key: 'source',
          icon: meeting.autoImported ? 'folder' : 'doc',
          label: meeting.autoImported ? '来源：自动入库' : `来源：${SOURCE_LABELS[meeting.sourceType] ?? '文本'}`,
          tone: 'brand',
          title: meeting.autoImported ? '由自动入库从本机录制文件导入' : undefined,
        }),
        h(MetaChip, {
          key: 'attendees',
          icon: 'users',
          label: attendees.length > 0 ? `参会人：${attendees.join('、')}` : '参会人未填写',
          title: attendees.join('、'),
        }),
        meeting.transcriptSeconds > 0
          ? h(MetaChip, { key: 'duration', icon: 'clock', label: `时长 ${formatDuration(meeting.transcriptSeconds)}` })
          : null,
        meeting.audioPath
          ? h(MetaChip, {
            key: 'audio',
            icon: 'folder',
            label: `录音副本${meeting.audioPrunedAt ? '（已清理）' : ''}${meeting.audioError ? ' · 转写失败' : ''}`,
            title: meeting.audioPath,
          })
          : null,
        h(MetaChip, { key: 'chars', icon: 'list', label: formatChars(meeting.transcriptChars ?? (meeting.transcript ?? '').length) }),
        summary?.generatedAt
          ? h(MetaChip, { key: 'generated', icon: 'sparkle', label: `生成于 ${formatStamp(summary.generatedAt)}` })
          : null,
        summary?.model
          ? h(MetaChip, { key: 'model', icon: 'info', label: `模型 ${summary.model}` })
          : null,
      ].filter(Boolean)
      const oneline = summary?.oneLine ?? ''
      const overview = summary?.overview ?? ''
      return h(
        'header',
        { className: 'dsm-cover' },
        h(
          'div',
          { className: 'dsm-cover-top' },
          h('div', { className: 'dsm-eyebrow' }, '会议纪要 · 结构化纪要'),
          h(
            'div',
            { className: 'dsm-cover-actions' },
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm',
              onClick: props.onEdit,
            }, h(Icon, { name: 'edit', size: 12 }), h('span', null, '编辑信息')),
            props.onRecord
              ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: props.onRecord,
                disabled: props.recordDisabled,
                title: props.recordDisabled ? '本机语音识别服务不可用' : undefined,
              }, h(Icon, { name: 'mic', size: 12 }), h('span', null, '录音转文字'))
              : null,
            props.onImport
              ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: props.onImport,
              }, h(Icon, { name: 'upload', size: 12 }), h('span', null, '导入文本'))
              : null,
          ),
        ),
        h('h1', { className: 'dsm-cover-title' }, meeting.title || '未命名会议'),
        h('div', { className: 'dsm-meta-chips' }, ...chips),
        oneline !== '' || overview !== ''
          ? h(
            'div',
            { className: 'dsm-oneline' },
            h('span', { className: 'dsm-oneline-mark' }, '“'),
            h(
              'div',
              null,
              oneline !== '' ? h('div', { className: 'dsm-oneline-text' }, oneline) : null,
              overview !== '' ? h('div', { className: 'dsm-overview' }, overview) : null,
            ),
          )
          : null,
      )
    }

    function TodoRow(props) {
      const { todo, selected, onToggle, onPatch, calendarAvailable } = props
      const pushed = isPushed(todo)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(() => ({
        title: todo.title ?? '',
        owner: todo.owner ?? '',
        due: todo.due ?? '',
        priority: todo.priority ?? 'normal',
        notes: todo.notes ?? '',
      }))
      const [saving, setSaving] = useState(false)
      const update = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }))
      const begin = () => {
        setDraft({
          title: todo.title ?? '',
          owner: todo.owner ?? '',
          due: todo.due ?? '',
          priority: todo.priority ?? 'normal',
          notes: todo.notes ?? '',
        })
        setEditing(true)
      }
      const save = async () => {
        if (draft.title.trim() === '') return
        setSaving(true)
        try {
          const ok = await onPatch(todo.id, {
            title: draft.title.trim(),
            owner: draft.owner.trim(),
            due: draft.due.trim(),
            priority: draft.priority,
            notes: draft.notes,
          })
          if (ok) setEditing(false)
        } finally {
          setSaving(false)
        }
      }
      if (editing) {
        return h(
          'tr',
          { className: 'dsm-todo' },
          h('td', { className: 'dsm-col-check' }),
          h(
            'td',
            null,
            h(TextInput, { compact: true, value: draft.title, onChange: update('title') }),
            h('div', { style: { height: 4 } }),
            h(TextInput, { compact: true, value: draft.notes, onChange: update('notes'), placeholder: '备注 / 验收标准' }),
          ),
          h('td', null, h(TextInput, { compact: true, value: draft.owner, onChange: update('owner'), placeholder: '负责人' })),
          h('td', null, h(TextInput, { compact: true, value: draft.due, onChange: update('due'), placeholder: '2026-10-28 18:00' })),
          h('td', null, h(Select, {
            compact: true,
            value: draft.priority,
            onChange: update('priority'),
            options: Object.keys(PRIORITY_LABELS).map((value) => ({ value, label: PRIORITY_LABELS[value] })),
          })),
          h('td', null, pushed ? h('span', { className: 'dsm-status dsm-status--ok' }, '✓ 已写入') : h('span', { className: 'dsm-status' }, '未写入')),
          h(
            'td',
            null,
            h(
              'div',
              { className: 'dsm-row-actions' },
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm dsm-btn--primary',
                onClick: () => { void save() },
                disabled: saving,
              }, saving ? '保存…' : '保存'),
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: () => setEditing(false),
                disabled: saving,
              }, '取消'),
            ),
          ),
        )
      }
      return h(
        'tr',
        { className: pushed ? 'dsm-todo dsm-todo--pushed' : 'dsm-todo' },
        h(
          'td',
          { className: 'dsm-col-check' },
          h('input', {
            className: 'dsm-checkbox',
            type: 'checkbox',
            checked: selected,
            disabled: pushed || !calendarAvailable,
            title: pushed ? '已写入任务日历' : (!calendarAvailable ? '任务日历不可用' : '选择后写入任务日历'),
            onChange: () => onToggle(todo.id),
          }),
        ),
        h(
          'td',
          null,
          h('div', { className: 'dsm-todo-title' }, todo.title || '未命名待办'),
          todo.notes ? h('div', { className: 'dsm-todo-note' }, todo.notes) : null,
        ),
        h('td', null, todo.owner || '—'),
        h('td', null, todo.due || '—'),
        h(
          'td',
          null,
          h('span', { className: `dsm-prio dsm-prio--${todo.priority ?? 'normal'}` }, PRIORITY_LABELS[todo.priority] ?? '中'),
        ),
        h(
          'td',
          null,
          pushed
            ? h(
              'div',
              null,
              h('span', { className: 'dsm-status dsm-status--ok' }, h(Icon, { name: 'check', size: 11 }), h('span', null, '已写入日历')),
              todo.calendarTaskId
                ? h('span', { className: 'dsm-cal-id', title: `日历任务 ID：${todo.calendarTaskId}` }, todo.calendarTaskId)
                : null,
            )
            : h('span', { className: 'dsm-status' }, '未写入'),
        ),
        h(
          'td',
          null,
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm dsm-btn--ghost',
            onClick: begin,
            title: pushed ? '已写入日历的修改不会同步到任务日历' : '编辑待办',
          }, h(Icon, { name: 'edit', size: 11 }), h('span', null, '编辑')),
        ),
      )
    }

    function TodoSection(props) {
      const { meeting, calendarAvailable, calendarError, onPatchTodo, onPushTodos } = props
      const summary = meeting.summary
      const todos = summary?.todos ?? []
      const [selected, setSelected] = useState(() => new Set())
      const [pushing, setPushing] = useState(false)
      const pending = useMemo(() => todos.filter((todo) => !isPushed(todo)), [todos])
      useEffect(() => {
        setSelected(new Set())
      }, [meeting.id])
      const selectedPending = pending.filter((todo) => selected.has(todo.id))
      const targetCount = selectedPending.length > 0 ? selectedPending.length : pending.length
      const allSelected = pending.length > 0 && selected.size === pending.length
      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const toggleAll = () => {
        if (allSelected) setSelected(new Set())
        else setSelected(new Set(pending.map((todo) => todo.id)))
      }
      const push = async () => {
        const ids = selectedPending.length > 0 ? selectedPending.map((todo) => todo.id) : pending.map((todo) => todo.id)
        if (ids.length === 0) return
        setPushing(true)
        try {
          const payload = await onPushTodos(ids)
          if (payload) setSelected(new Set())
        } finally {
          setPushing(false)
        }
      }
      const calendarHint = calendarAvailable
        ? (pending.length > 0
          ? `已勾选 ${selectedPending.length > 0 ? selectedPending.length : 0} 条；不勾选时写入全部未写入待办（${pending.length} 条）`
          : '所有待办都已写入任务日历')
        : `任务日历不可用：${calendarError || '请确认任务日历插件已启动'}`
      return h(
        Section,
        {
          title: '待办事项',
          icon: 'check',
          count: todos.length,
          sub: summary ? `已写入 ${todos.length - pending.length} / ${todos.length}` : undefined,
        },
        h(
          'div',
          { className: 'dsm-todo-card' },
          todos.length === 0
            ? h('div', { className: 'dsm-empty-table' }, 'AI 没有从这场会议中提取到待办事项。')
            : h(
              'div',
              { className: 'dsm-table-wrap' },
              h(
                'table',
                { className: 'dsm-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'dsm-col-check' }, h('input', {
                      className: 'dsm-checkbox',
                      type: 'checkbox',
                      checked: allSelected,
                      disabled: pending.length === 0 || !calendarAvailable,
                      title: '全选未写入的待办',
                      onChange: toggleAll,
                    })),
                    h('th', null, '标题'),
                    h('th', { className: 'dsm-col-owner' }, '负责人'),
                    h('th', { className: 'dsm-col-due' }, '截止'),
                    h('th', { className: 'dsm-col-priority' }, '优先级'),
                    h('th', { className: 'dsm-col-status' }, '状态'),
                    h('th', { className: 'dsm-col-actions' }, '操作'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  ...todos.map((todo) => h(TodoRow, {
                    key: todo.id,
                    todo,
                    selected: selected.has(todo.id),
                    onToggle: toggle,
                    onPatch: onPatchTodo,
                    calendarAvailable,
                  })),
                ),
              ),
            ),
          h(
            'div',
            { className: 'dsm-todo-foot' },
            h(
              'span',
              { className: `dsm-todo-hint${calendarAvailable ? '' : ' dsm-todo-hint--warn'}` },
              calendarHint,
            ),
            h('span', { className: 'dsm-spacer' }),
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { void push() },
              disabled: targetCount === 0 || pushing || !calendarAvailable,
              title: calendarAvailable ? undefined : '任务日历插件不可用',
            }, h(Icon, { name: 'calendar', size: 13 }), h('span', null, pushing ? '写入中…' : `写入任务日历（${targetCount}）`)),
          ),
        ),
      )
    }

    /**
     * Speaker chips shown right above the transcript. The host-side diarisation
     * route is developed in parallel, so an unimplemented/old host degrades to
     * "no chips" instead of an error banner.
     */
    function SpeakerChips(props) {
      const meetingId = typeof props.meetingId === 'string' ? props.meetingId : ''
      const incoming = normalizeSpeakerList(props.speakers)
      const incomingKey = incoming.map((item) => `${item.id}:${item.label}`).join('|')
      const [speakers, setSpeakers] = useState(incoming)
      const [editingId, setEditingId] = useState(null)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      // Guards against re-fetching a route the host does not implement.
      const fetchedFor = useRef('')

      // A different meeting resets the local list, then lazily asks the host.
      useEffect(() => {
        setEditingId(null)
        setDraft('')
        setSpeakers(normalizeSpeakerList(props.speakers))
        if (meetingId === '' || normalizeSpeakerList(props.speakers).length > 0) return undefined
        if (fetchedFor.current === meetingId) return undefined
        fetchedFor.current = meetingId
        let cancelled = false
        void loadMeetingSpeakers(meetingId).then((found) => {
          if (cancelled || found === null || found.length === 0) return
          setSpeakers(found)
        })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [meetingId])

      // Fresh host data (meeting reloaded after a rename) wins over the local copy.
      useEffect(() => {
        if (incoming.length > 0) setSpeakers(incoming)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [incomingKey])

      if (speakers.length === 0) return null

      const startEdit = (speaker) => {
        setEditingId(speaker.id)
        setDraft(speaker.label)
      }
      const cancelEdit = () => {
        setEditingId(null)
        setDraft('')
      }
      const save = async (speaker) => {
        const name = draft.trim()
        if (name === '' || name === speaker.label) {
          cancelEdit()
          return
        }
        setSaving(true)
        try {
          const payload = await renameMeetingSpeaker(meetingId, speaker.id, name)
          const fromHost = normalizeSpeakerList(payload?.meeting?.speakers)
          setSpeakers(fromHost.length > 0
            ? fromHost
            : speakers.map((item) => (item.id === speaker.id ? { ...item, label: name } : item)))
          cancelEdit()
          notifySuccess('已更新说话人', name)
          void reloadMeetingQuietly(meetingId)
        } catch (caught) {
          reportError(caught, '更新说话人失败')
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { className: 'dsm-speakers', role: 'group', 'aria-label': '说话人' },
        h('span', { className: 'dsm-speakers-label' }, '说话人'),
        ...speakers.map((speaker) => (editingId === speaker.id
          ? h(
            'span',
            { key: speaker.id, className: 'dsm-speaker-edit' },
            h('input', {
              className: 'dsm-input dsm-input--cell dsm-speaker-input',
              value: draft,
              autoFocus: true,
              disabled: saving,
              'aria-label': `重命名${speaker.label}`,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void save(speaker)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEdit()
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm dsm-btn--primary',
              onClick: () => { void save(speaker) },
              disabled: saving,
            }, h('span', null, saving ? '保存中…' : '保存')),
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm',
              onClick: cancelEdit,
              disabled: saving,
            }, h('span', null, '取消')),
          )
          : h('button', {
            key: speaker.id,
            type: 'button',
            className: 'dsm-chip dsm-speaker-chip',
            title: '点击重命名说话人',
            onClick: () => startEdit(speaker),
          }, h(Icon, { name: 'edit', size: 10 }), h('span', null, speaker.label)))),
      )
    }

    function TranscriptSection(props) {
      const text = String(props.transcript ?? '')
      const meetingId = typeof props.meetingId === 'string' ? props.meetingId : ''
      const edits = Number(props.edits) || 0
      const [open, setOpen] = useState(false)
      const [copied, setCopied] = useState(false)
      // `draft === null` means read-only; a string means the editor is open.
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const dirty = draft !== null && draft !== text
      // Hand-corrected ASR text must not be lost when the page is closed or the
      // panel switches. Save goes through the existing PATCH route.
      useEffect(() => {
        if (!dirty) return undefined
        const handler = (event) => {
          event.preventDefault()
          event.returnValue = ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
      }, [dirty])
      const copy = async () => {
        try {
          await copyText(text)
          setCopied(true)
          notifySuccess('已复制原始转写', formatChars(text.length))
          window.setTimeout(() => setCopied(false), 2000)
        } catch (caught) {
          reportError(caught, '复制失败')
        }
      }
      const startEdit = () => {
        setDraft(text)
        setOpen(true)
      }
      const cancelEdit = () => {
        if (dirty && !window.confirm('转写有未保存的修改，确定放弃？')) return
        setDraft(null)
      }
      const save = async () => {
        if (draft === null || meetingId === '' || !dirty) return
        setSaving(true)
        try {
          await patchMeeting(meetingId, { transcript: draft })
          setDraft(null)
          notifySuccess('转写已保存', '导出与重新生成纪要都会使用修订后的文本')
        } catch (caught) {
          reportError(caught, '保存转写失败')
        } finally {
          setSaving(false)
        }
      }
      const toggle = () => {
        if (dirty && !window.confirm('转写有未保存的修改，确定收起？')) return
        setOpen((previous) => !previous)
      }
      const sub = `${formatChars(text.length)}${edits > 0 ? ` · 已修订 ${edits} 次` : ''}`
      return h(
        Section,
        { title: '原始转写', icon: 'doc', sub },
        h(
          'div',
          { className: 'dsm-transcript' },
          h(
            'div',
            { className: 'dsm-transcript-head' },
            h('button', {
              type: 'button',
              className: 'dsm-transcript-toggle',
              onClick: toggle,
            }, h(Icon, { name: 'chevron', size: 12, className: open ? 'dsm-chevron--open' : undefined }), h('span', null, open ? '收起转写' : '展开转写'), h('span', { className: 'dsm-transcript-meta' }, sub)),
            h('span', { className: 'dsm-spacer' }),
            draft === null
              ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: startEdit,
                disabled: text === '' || meetingId === '',
                title: '手工修订转写里的错别字；原文保留在记录里',
              }, h(Icon, { name: 'edit', size: 11 }), h('span', null, '编辑转写'))
              : [
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--sm dsm-btn--primary',
                  onClick: () => { void save() },
                  disabled: saving || !dirty,
                }, h('span', null, saving ? '保存中…' : '保存修订')),
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--sm',
                  onClick: cancelEdit,
                  disabled: saving,
                }, h('span', null, '取消')),
              ],
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm',
              onClick: () => { void copy() },
              disabled: text === '',
            }, h(Icon, { name: 'copy', size: 11 }), h('span', null, copied ? '已复制' : '复制全文')),
          ),
          dirty
            ? h('div', { className: 'dsm-transcript-meta', style: { padding: '0 12px 8px' } }, '有未保存的修改：保存后才会用于导出和重新生成纪要')
            : null,
          open
            ? (draft === null
              ? h('pre', { className: 'dsm-transcript-body' }, text === '' ? '（暂无转写文本）' : text)
              : h('textarea', {
                className: 'dsm-input dsm-textarea dsm-transcript-body',
                style: { borderRadius: 0, border: 0, minHeight: 220 },
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                spellCheck: false,
              }))
            : null,
        ),
      )
    }

    function MeetingDocument(props) {
      const meeting = props.meeting
      const summary = meeting.summary
      const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : []
      const summaryStartedAt = props.summarizing?.id === meeting.id ? props.summarizing.startedAt : null
      const keyPoints = Array.isArray(summary?.keyPoints) ? summary.keyPoints : []
      const decisions = Array.isArray(summary?.decisions) ? summary.decisions : []
      const risks = Array.isArray(summary?.risks) ? summary.risks : []
      const sections = Array.isArray(summary?.sections) ? summary.sections : []
      const hasSummary = summary !== null && summary !== undefined
      const hasTranscript = typeof meeting.transcript === 'string' && meeting.transcript.trim() !== ''

      return h(
        'article',
        { className: 'dsm-doc' },
        h(CoverSection, {
          meeting,
          onEdit: props.onEdit,
          onRecord: props.onRecord,
          onImport: props.onImport,
          recordDisabled: props.recordDisabled,
        }),
        summaryStartedAt !== null
          ? h(SummarizingCard, { startedAt: summaryStartedAt })
          : null,
        !hasSummary && summaryStartedAt === null
          ? h(
            'div',
            { className: 'dsm-cta' },
            h('div', { className: 'dsm-cta-icon' }, h(Icon, { name: 'sparkle', size: 18 })),
            h(
              'div',
              { className: 'dsm-cta-body' },
              h('div', { className: 'dsm-cta-title' }, hasTranscript ? '还没有 AI 纪要' : '还没有转写内容'),
              h(
                'div',
                { className: 'dsm-cta-text' },
                hasTranscript
                  ? '转写已就绪。点击生成结构化的关键要点、决策、风险和待办清单（约 30–120 秒）。'
                  : '先录音、导入音频或粘贴会议文本，然后让 AI 生成结构化纪要。',
              ),
            ),
            hasTranscript
              ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--primary',
                onClick: props.onSummarize,
                disabled: props.summarizing !== null,
              }, h(Icon, { name: 'sparkle', size: 13 }), h('span', null, 'AI 生成纪要'))
              : h(
                'div',
                { className: 'dsm-row-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--primary',
                  onClick: props.onRecord,
                  disabled: props.recordDisabled,
                }, h(Icon, { name: 'mic', size: 13 }), h('span', null, '录音转文字')),
                h('button', {
                  type: 'button',
                  className: 'dsm-btn',
                  onClick: props.onImport,
                }, h(Icon, { name: 'upload', size: 13 }), h('span', null, '导入纪要')),
              ),
          )
          : null,
        hasSummary
          ? h(
            'div',
            { className: 'dsm-doc-section' },
            h(
              'div',
              { className: 'dsm-row-actions', style: { justifyContent: 'flex-end' } },
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm dsm-btn--ghost',
                onClick: props.onSummarize,
                disabled: props.summarizing !== null,
                title: '重新生成会覆盖当前 AI 纪要',
              }, h(Icon, { name: 'refresh', size: 11 }), h('span', null, props.summarizing !== null ? '生成中…' : '重新生成纪要')),
            ),
          )
          : null,
        keyPoints.length > 0
          ? h(
            Section,
            { title: '关键要点', icon: 'list', count: keyPoints.length },
            h(
              'div',
              { className: 'dsm-points' },
              ...keyPoints.map((point, index) => h(
                'div',
                { key: `${index}-${point}`, className: 'dsm-point' },
                h('span', { className: 'dsm-point-num' }, String(index + 1).padStart(2, '0')),
                h('span', { className: 'dsm-point-text' }, point),
              )),
            ),
          )
          : null,
        decisions.length > 0
          ? h(
            Section,
            { title: '决策清单', icon: 'check', count: decisions.length },
            h(
              'div',
              { className: 'dsm-cards' },
              ...decisions.map((decision, index) => h(
                'div',
                { key: `${index}-${decision.text}`, className: 'dsm-decision' },
                h('span', { className: 'dsm-decision-check' }, h(Icon, { name: 'check', size: 11, strokeWidth: 1.8 })),
                h(
                  'div',
                  { className: 'dsm-decision-body' },
                  h('div', { className: 'dsm-decision-text' }, decision.text),
                  decision.owner ? h('div', { className: 'dsm-owner' }, `负责人：${decision.owner}`) : null,
                ),
              )),
            ),
          )
          : null,
        risks.length > 0
          ? h(
            Section,
            { title: '风险与待确认', icon: 'alert', count: risks.length },
            h(
              'div',
              { className: 'dsm-blocks' },
              ...risks.map((risk, index) => {
                const level = risk.level === 'high' || risk.level === 'medium' ? risk.level : 'low'
                return h(
                  'div',
                  { key: `${index}-${risk.text}`, className: `dsm-risk dsm-risk--${level}` },
                  h('span', { className: 'dsm-risk-sign' }, h(Icon, { name: 'alert', size: 13 })),
                  h(
                    'div',
                    { className: 'dsm-risk-body' },
                    h('div', { className: 'dsm-risk-text' }, risk.text),
                    h('div', { className: 'dsm-risk-level' }, RISK_LABELS[level] ?? '提示'),
                  ),
                )
              }),
            ),
          )
          : null,
        sections.length > 0
          ? h(
            Section,
            { title: '分节纪要', icon: 'doc', count: sections.length },
            h(
              'div',
              { className: 'dsm-blocks' },
              ...sections.map((section, index) => h(
                'div',
                { key: `${index}-${section.heading}`, className: 'dsm-block' },
                h('div', { className: 'dsm-block-heading' }, section.heading),
                Array.isArray(section.bullets) && section.bullets.length > 0
                  ? h('ul', { className: 'dsm-bullets' }, ...section.bullets.map((bullet, bulletIndex) => h(
                    'li',
                    { key: `${bulletIndex}-${bullet}`, className: 'dsm-bullet' },
                    bullet,
                  )))
                  : null,
              )),
            ),
          )
          : null,
        hasSummary && Array.isArray(summary?.todos)
          ? h(TodoSection, {
            meeting,
            calendarAvailable: props.calendarAvailable,
            calendarError: props.calendarError,
            onPatchTodo: props.onPatchTodo,
            onPushTodos: props.onPushTodos,
          })
          : null,
        typeof meeting.notes === 'string' && meeting.notes.trim() !== ''
          ? h(
            Section,
            { title: '会议备注', icon: 'info' },
            h('div', { className: 'dsm-notes' }, meeting.notes),
          )
          : null,
        hasTranscript
          ? h(SpeakerChips, {
            meetingId: meeting.id,
            speakers: meeting.speakers,
          })
          : null,
        hasTranscript
          ? h(TranscriptSection, {
            transcript: meeting.transcript,
            meetingId: meeting.id,
            edits: meeting.transcriptEdits,
          })
          : null,
        attendees.length === 0
          ? null
          : h('div', { className: 'dsm-hint', style: { marginTop: 16 } }, `参会人：${attendees.join('、')}`),
      )
    }

    // ─────────────────────────────── empty ────────────────────────────────

    function EmptyState(props) {
      const speech = props.speech
      const speechAvailable = speechUsable(speech)
      return h(
        'div',
        { className: 'dsm-empty' },
        h('div', { className: 'dsm-empty-icon' }, h(Icon, { name: 'mic', size: 30, strokeWidth: 1.3 })),
        h('div', { className: 'dsm-empty-title' }, '把会议变成可执行的纪要'),
        h('div', { className: 'dsm-empty-sub' }, '录音或导入转写后，AI 会自动整理关键要点、决策、风险与待办；确认后一键写入任务日历。'),
        h(
          'div',
          { className: 'dsm-entries' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-entry',
              onClick: props.onRecord,
              disabled: !speechAvailable,
              title: speechAvailable ? undefined : '本机语音识别服务不可用，请改用文本导入',
            },
            h('div', { className: 'dsm-entry-icon' }, h(Icon, { name: 'mic', size: 17 })),
            h('div', { className: 'dsm-entry-title' }, '录音转文字'),
            h('div', { className: 'dsm-entry-text' }, speechAvailable
              ? '边说边出字，停顿约 1.5 秒即切（可调 3/5 秒），可后台录音'
              : '语音识别服务未就绪，可先在顶部预加载，或改用文本导入'),
          ),
          h(
            'button',
            { type: 'button', className: 'dsm-entry', onClick: props.onImport },
            h('div', { className: 'dsm-entry-icon' }, h(Icon, { name: 'upload', size: 17 })),
            h('div', { className: 'dsm-entry-title' }, '导入腾讯会议纪要'),
            h('div', { className: 'dsm-entry-text' }, '粘贴文本，或导入 .txt / .md / .json 文件'),
          ),
          h(
            'button',
            { type: 'button', className: 'dsm-entry', onClick: props.onNew },
            h('div', { className: 'dsm-entry-icon' }, h(Icon, { name: 'plus', size: 17 })),
            h('div', { className: 'dsm-entry-title' }, '新建会议'),
            h('div', { className: 'dsm-entry-text' }, '先填写会议信息，稍后再补充转写与纪要'),
          ),
        ),
        h('div', { className: 'dsm-empty-note' }, '会议数据保存在本机；AI 纪要使用当前配置的模型服务。'),
      )
    }

    // ─────────────────────────────── toolbar ──────────────────────────────

    function SpeechChip() {
      const state = useSnapshot()
      const speech = state.speech ?? state.data?.speech
      const provider = speechProvider(speech)
      if (speech === null) {
        return h('span', { className: 'dsm-chip' }, '语音识别：检查中')
      }
      if (!speechUsable(speech)) {
        return h('span', {
          className: 'dsm-chip dsm-chip--warn',
          title: typeof speech?.error === 'string' ? speech.error : '本机未配置语音识别服务',
        }, '语音识别：不可用')
      }
      const phase = provider?.phase ?? 'unprepared'
      if (speechReady(speech)) {
        return h('span', { className: 'dsm-chip dsm-chip--ok' }, h('span', { className: 'dsm-dot-live' }), '语音识别就绪')
      }
      if (state.speechPreparing || phase === 'downloading' || phase === 'checking' || phase === 'loading') {
        const percent = state.speechProgress !== null ? Math.round(state.speechProgress.ratio * 100) : null
        return h('button', {
          type: 'button',
          className: 'dsm-chip dsm-chip--busy',
          onClick: () => { void prepareSpeechManually() },
          disabled: state.speechPreparing,
          title: '正在准备本地语音识别模型',
        }, h('span', { className: 'dsm-spin', style: { width: 9, height: 9, borderWidth: 1.5 } }), `语音识别：${speechPhaseLabel(phase)}${percent !== null ? ` ${percent}%` : ''}`)
      }
      return h('button', {
        type: 'button',
        className: 'dsm-chip',
        onClick: () => { void prepareSpeechManually() },
        title: '点击预加载本地语音识别模型',
      }, `语音识别：${speechPhaseLabel(phase)}`)
    }

    function Toolbar(props) {
      const { state, handlers } = props
      const meeting = state.meeting
      const summarizing = state.summarizing !== null
      const exporting = state.exporting !== null
      const speech = state.speech ?? state.data?.speech
      const speechAvailable = speechUsable(speech)
      const liveActive = liveIsActive(state.live)
      return h(
        'div',
        { className: 'dsm-toolbar' },
        h(
          'div',
          { className: 'dsm-brand' },
          h('span', { className: 'dsm-brand-title' }, '会议纪要'),
          h('span', { className: 'dsm-brand-sub' }, `${state.meetings.length} 场会议`),
        ),
        h(
          'div',
          { className: 'dsm-actions' },
          h(ToolbarButton, {
            icon: 'plus',
            label: '新建会议',
            onClick: handlers.newMeeting,
          }),
          h(ToolbarButton, {
            icon: 'mic',
            label: liveActive ? '录音中…' : '录音转文字',
            onClick: handlers.record,
            disabled: !speechAvailable && !liveActive,
            title: liveActive
              ? '正在后台录音，点击查看实时转写'
              : (speechAvailable ? '实时录音或导入音频文件' : '本机语音识别服务不可用，请改用文本导入'),
          }),
          h(ToolbarButton, {
            icon: 'upload',
            label: '导入纪要',
            onClick: handlers.importText,
          }),
          meeting
            ? h(ToolbarButton, {
              icon: 'sparkle',
              label: summarizing ? '生成中…' : 'AI 生成纪要',
              onClick: handlers.summarize,
              disabled: summarizing || !meeting.transcript,
              title: meeting.transcript
                ? (meeting.summary ? '重新生成会覆盖当前 AI 纪要' : '根据转写生成结构化纪要')
                : '请先录音或导入转写文本',
            })
            : null,
          meeting
            ? h(ToolbarButton, {
              icon: 'download',
              label: '导出 HTML',
              onClick: () => handlers.export('html'),
              disabled: exporting,
            })
            : null,
          meeting
            ? h(ToolbarButton, {
              icon: 'download',
              label: '导出 Markdown',
              onClick: () => handlers.export('md'),
              disabled: exporting,
            })
            : null,
          meeting
            ? h(ToolbarButton, {
              icon: 'trash',
              label: '删除',
              variant: 'danger',
              onClick: handlers.delete,
            })
            : null,
          h(ToolbarButton, {
            icon: 'folder',
            label: autoIngestSummaryLabel(state.data?.autoIngest),
            onClick: handlers.autoIngest,
            title: state.data?.autoIngest?.lastError
              ? `自动入库最近错误：${state.data.autoIngest.lastError}`
              : '自动入库设置、状态与立即扫描',
          }),
        ),
        h('span', { className: 'dsm-spacer' }),
        h(SpeechChip, null),
        h('button', {
          type: 'button',
          className: 'dsm-iconbtn',
          onClick: handlers.refresh,
          title: '刷新',
          'aria-label': '刷新',
        }, h(Icon, { name: 'refresh', size: 14 })),
      )
    }

    // ─────────────────────────────── overlay ──────────────────────────────

    /**
     * Pause-length picker on the live bar. The stored value is read when a
     * recording starts, so changing it mid-take only affects the next take.
     */
    function VadSilenceSelect() {
      const [value, setValue] = useState(readVadSilenceSeconds)
      const change = (event) => {
        const seconds = writeVadSilenceSeconds(event.target.value)
        setValue(seconds)
        notify('info', '停顿切片已更新', `停顿 ${seconds} 秒后转写；下次开始录音生效`)
      }
      return h(
        'label',
        { className: 'dsm-livebar-select', title: '静音停顿多久后把这一句切出来转写（下次开始录音生效）' },
        h('span', null, '停顿'),
        h(
          'select',
          {
            value: String(value),
            onChange: change,
            'aria-label': '停顿多久后转写',
          },
          ...LIVE_VAD_SILENCE_OPTIONS.map((option) => h(
            'option',
            { key: option, value: String(option) },
            `${option} 秒`,
          )),
        ),
        h('span', null, '后转写'),
      )
    }

    /** Persistent floating bar: the recording survives panel/modal unmounts. */
    function LiveRecordingBar() {
      const state = useSnapshot()
      const live = state.live
      if (!live || !liveIsActive(live)) return null
      const preparing = live.status === 'preparing'
      const stopping = live.status === 'stopping'
      const lastText = live.lastText ?? ''
      const tail = lastText.length > 38 ? `…${lastText.slice(-38)}` : lastText
      const meta = preparing
        ? '正在启动语音识别…'
        : stopping
          ? `已转写 ${formatChars(live.chars)} · 正在等待最后几段`
          : `已转写 ${formatChars(live.chars)}${tail !== '' ? ` · ${tail}` : ' · 等待第一段识别…'}`
      return h(
        'div',
        { className: 'dsm-livebar', role: 'status', 'aria-live': 'polite' },
        preparing || stopping
          ? h('span', { className: 'dsm-spin', style: { width: 10, height: 10, borderWidth: 2 } })
          : h('span', { className: 'dsm-livebar-dot' }),
        h(
          'div',
          { className: 'dsm-livebar-main' },
          h(
            'div',
            { className: 'dsm-livebar-title' },
            h('span', null, preparing ? '正在准备实时转写' : stopping ? '正在收尾转写' : '录音中'),
            !preparing && !stopping ? h('span', { className: 'dsm-livebar-timer' }, formatTimer(live.elapsedSeconds)) : null,
            live.meetingTitle !== ''
              ? h('span', { className: 'dsm-hint', style: { fontWeight: 400 } }, live.meetingTitle)
              : null,
          ),
          h('div', { className: 'dsm-livebar-meta' }, meta),
        ),
        h(
          'div',
          { className: 'dsm-livebar-actions' },
          !preparing && !stopping ? h(VadSilenceSelect, { key: 'vad' }) : null,
          !preparing && !stopping
            ? h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm dsm-btn--danger',
              onClick: () => { void stopLiveRecording('user') },
            }, h(Icon, { name: 'stop', size: 11 }), h('span', null, '停止'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm',
            onClick: openMeetingPanel,
          }, h(Icon, { name: 'doc', size: 11 }), h('span', null, '打开纪要')),
        ),
      )
    }

    /**
     * Bar for a recording started outside this page (agent / CLI through the
     * JSON API). The panel owns its own capture, so this bar only renders when
     * there is no local live session but the host reports an active one.
     */
    function AgentRecordingBar() {
      const state = useSnapshot()
      const local = state.live
      if (local && liveIsActive(local)) return null
      const entries = Array.isArray(state.data?.activeRecording) ? state.data.activeRecording : []
      if (entries.length === 0) return null
      const entry = entries[0]
      const started = Date.parse(entry.startedAt)
      const elapsed = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0
      const stopping = Array.isArray(state.data?.stopRequested) && state.data.stopRequested.includes(entry.meetingId)
      // The recorder polls `/state`; this only asks it to finish gracefully.
      const askStop = async () => {
        try {
          await requestJson(`/meetings/${encodeURIComponent(entry.meetingId)}/audio/stop`, { method: 'POST' })
          const requested = Array.isArray(snapshot.data?.stopRequested) ? snapshot.data.stopRequested : []
          commit({ data: { ...(snapshot.data ?? {}), stopRequested: [...new Set([...requested, entry.meetingId])] } })
          notify('info', '正在停止录音', '录音端会把最后几段发完再合并整场，请稍候')
        } catch (error) {
          reportError(error, '停止录音失败')
        }
      }
      return h(
        'div',
        { className: 'dsm-livebar', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsm-livebar-dot' }),
        h(
          'div',
          { className: 'dsm-livebar-main' },
          h(
            'div',
            { className: 'dsm-livebar-title' },
            h('span', null, '正在录音'),
            h('span', { className: 'dsm-livebar-timer' }, formatTimer(elapsed)),
            entry.title !== '' ? h('span', { className: 'dsm-hint', style: { fontWeight: 400 } }, entry.title) : null,
          ),
          h('div', { className: 'dsm-livebar-meta' }, `由 agent 启动 · 已收 ${entry.slices} 段音频`),
        ),
        h(
          'div',
          { className: 'dsm-livebar-actions' },
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm',
            onClick: () => { void askStop() },
            disabled: stopping,
            title: '让录音端停止并合并整场音频',
          }, h('span', null, stopping ? '停止中…' : '停止录音')),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm',
            onClick: openMeetingPanel,
          }, h(Icon, { name: 'doc', size: 11 }), h('span', null, '打开纪要')),
        ),
      )
    }

    // ──────────────────── floating bar drag (remembered) ─────────────────
    // The live/ended bars are fixed at the bottom centre; a user who moves them
    // once expects them to stay there, so the spot is remembered per browser.

    const LIVEBAR_POS_KEY = 'dsh.meeting.livebar.position'

    function readLivebarPosition() {
      try {
        const raw = window.localStorage.getItem(LIVEBAR_POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (!Number.isFinite(parsed?.left) || !Number.isFinite(parsed?.top)) return null
        return { left: parsed.left, top: parsed.top }
      } catch {
        return null
      }
    }

    function saveLivebarPosition(position) {
      try {
        window.localStorage.setItem(LIVEBAR_POS_KEY, JSON.stringify(position))
      } catch {
        // private mode / storage disabled: dragging still works, just not remembered
      }
    }

    function clearLivebarPosition() {
      try {
        window.localStorage.removeItem(LIVEBAR_POS_KEY)
      } catch {
        // ignore
      }
    }

    /** Place one bar at `position`, clamped into the viewport. */
    function applyLivebarPosition(bar, position) {
      if (!bar || !position) return
      const width = bar.offsetWidth || 320
      const height = bar.offsetHeight || 56
      const left = Math.min(Math.max(8, position.left), Math.max(8, window.innerWidth - width - 8))
      const top = Math.min(Math.max(8, position.top), Math.max(8, window.innerHeight - height - 8))
      bar.style.left = `${Math.round(left)}px`
      bar.style.top = `${Math.round(top)}px`
      bar.style.bottom = 'auto'
      bar.style.transform = 'none'
    }

    /** Put every mounted live bar on the remembered position. */
    function placeLivebars() {
      const position = readLivebarPosition()
      if (position === null) return
      for (const bar of document.querySelectorAll('.dsm-livebar')) applyLivebarPosition(bar, position)
    }

    /** Reset a bar to the default bottom-centre spot (double click). */
    function resetLivebar(bar) {
      clearLivebarPosition()
      if (!bar) return
      bar.style.left = ''
      bar.style.top = ''
      bar.style.bottom = ''
      bar.style.transform = ''
    }

    /** Pointer-drag any `.dsm-livebar`; ignores drags that start on a control. */
    function installLivebarDrag() {
      let drag = null
      const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        const target = event.target instanceof Element ? event.target : null
        const bar = target === null ? null : target.closest('.dsm-livebar')
        if (!bar) return
        if (target.closest('button, a, input, textarea, select')) return
        const rect = bar.getBoundingClientRect()
        drag = { bar, pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
        bar.dataset.dsmDragging = '1'
        try {
          bar.setPointerCapture(event.pointerId)
        } catch {
          // pointer capture is best effort (older browsers)
        }
      }
      const onPointerMove = (event) => {
        if (drag === null || event.pointerId !== drag.pointerId) return
        applyLivebarPosition(drag.bar, { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY })
        event.preventDefault()
      }
      const finish = () => {
        if (drag === null) return
        const bar = drag.bar
        delete bar.dataset.dsmDragging
        saveLivebarPosition({ left: parseFloat(bar.style.left) || 0, top: parseFloat(bar.style.top) || 0 })
        drag = null
      }
      const onDoubleClick = (event) => {
        const target = event.target instanceof Element ? event.target : null
        const bar = target === null ? null : target.closest('.dsm-livebar')
        if (bar) resetLivebar(bar)
      }
      document.addEventListener('pointerdown', onPointerDown)
      document.addEventListener('pointermove', onPointerMove, { passive: false })
      document.addEventListener('pointerup', finish)
      document.addEventListener('pointercancel', finish)
      document.addEventListener('dblclick', onDoubleClick)
      // Bars mount and unmount with the recording state; adopt new ones.
      const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => placeLivebars()) : null
      if (observer !== null) observer.observe(document.body, { childList: true, subtree: true })
      placeLivebars()
      return () => {
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', finish)
        document.removeEventListener('pointercancel', finish)
        document.removeEventListener('dblclick', onDoubleClick)
        if (observer !== null) observer.disconnect()
      }
    }

    /**
     * Short confirmation shown when an agent-started recording disappears from
     * `/state.activeRecording`: without it the floating bar just vanishes and the
     * stop looks like a crash. Auto-hides after RECORDING_ENDED_TTL_MS.
     */
    function RecordingEndedBar() {
      const state = useSnapshot()
      const ended = state.recordingEnded
      if (!ended) return null
      const seconds = Number(ended.seconds) || 0
      return h(
        'div',
        { className: 'dsm-livebar dsm-livebar--done', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsm-livebar-check' }, '✓'),
        h(
          'div',
          { className: 'dsm-livebar-main' },
          h(
            'div',
            { className: 'dsm-livebar-title' },
            h('span', null, '录音已结束'),
            h('span', { className: 'dsm-livebar-timer' }, formatTimer(seconds)),
            ended.title !== '' ? h('span', { className: 'dsm-hint', style: { fontWeight: 400 } }, ended.title) : null,
          ),
          h('div', { className: 'dsm-livebar-meta' }, `已保存 ${seconds} 秒整场音频，可打开纪要查看`),
        ),
        h(
          'div',
          { className: 'dsm-livebar-actions' },
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm',
            onClick: () => {
              commit({ recordingEnded: null })
              void selectMeeting(ended.meetingId)
              openMeetingPanel()
            },
          }, h(Icon, { name: 'doc', size: 11 }), h('span', null, '打开纪要')),
        ),
      )
    }

    function ToastOverlay() {
      const state = useSnapshot()
      useEffect(() => {
        ensureStyle()
      }, [])
      // The floating bars can be dragged anywhere and remember that spot.
      useEffect(() => installLivebarDrag(), [])
      // Poll just enough of `/state` to surface an agent-started recording on the
      // page even when the panel was never opened. Commit only on change.
      // When the entry disappears the recording just finished: show a short
      // "已结束" notice instead of letting the bar vanish silently.
      useEffect(() => {
        let cancelled = false
        let previous = null
        let clearTimer = 0
        const announceEnded = (entry) => {
          const started = Date.parse(entry.startedAt)
          const updated = Date.parse(entry.updatedAt)
          const seconds = Number.isFinite(started) && Number.isFinite(updated)
            ? Math.max(0, Math.round((updated - started) / 1000))
            : 0
          commit({
            recordingEnded: {
              meetingId: entry.meetingId,
              title: entry.title ?? '',
              seconds,
              at: Date.now(),
            },
          })
          // The wall-clock estimate above is only a fallback; the finalized
          // record carries the real audio duration, so prefer it when it lands.
          void requestJson(`/meetings/${encodeURIComponent(entry.meetingId)}`).then((payload) => {
            const saved = Number(payload?.meeting?.audioSeconds) || 0
            const current = snapshot.recordingEnded
            if (saved > 0 && current !== null && current.meetingId === entry.meetingId) {
              commit({ recordingEnded: { ...current, seconds: saved } })
            }
          }).catch(() => { /* keep the estimate */ })
          if (clearTimer !== 0) window.clearTimeout(clearTimer)
          clearTimer = window.setTimeout(() => {
            clearTimer = 0
            commit({ recordingEnded: null })
          }, RECORDING_ENDED_TTL_MS)
          // The finalized meeting (with its audio copy) is now in the library.
          void refreshList()
        }
        const tick = async () => {
          try {
            const data = await requestJson('/state')
            if (cancelled) return
            const next = Array.isArray(data.activeRecording) ? data.activeRecording : []
            const current = Array.isArray(snapshot.data?.activeRecording) ? snapshot.data.activeRecording : []
            if (JSON.stringify(next) !== JSON.stringify(current)) {
              commit({ data: { ...(snapshot.data ?? {}), activeRecording: next } })
            }
            if (next.length > 0) {
              previous = next[0]
            } else if (previous !== null) {
              announceEnded(previous)
              previous = null
            }
          } catch {
            // transient host hiccups are not worth surfacing
          }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, 3000)
        return () => {
          cancelled = true
          clearInterval(timer)
          if (clearTimer !== 0) window.clearTimeout(clearTimer)
        }
      }, [])
      return h(
        React.Fragment,
        null,
        h(LiveRecordingBar, null),
        h(AgentRecordingBar, null),
        h(RecordingEndedBar, null),
        state.toasts.length === 0
          ? null
          : h(
            'div',
            { className: 'dsm-toast-stack' },
            ...state.toasts.map((toast) => h(
              'div',
              { key: toast.id, className: `dsm-toast dsm-toast--${toast.level ?? 'info'}` },
              h(
                'div',
                { className: 'dsm-toast-title' },
                toast.level === 'error' ? '⚠ ' : toast.level === 'success' ? '✓ ' : '',
                toast.title,
              ),
              toast.body ? h('div', { className: 'dsm-toast-body' }, toast.body) : null,
            )),
          ),
      )
    }

    // ─────────────────────────────── panel ────────────────────────────────

    function MeetingPanel() {
      const state = useSnapshot()
      const [search, setSearch] = useState('')
      const [filter, setFilter] = useState('all')
      const [dialog, setDialog] = useState(null)
      const [deleteOpen, setDeleteOpen] = useState(false)

      useEffect(() => {
        ensureStyle()
        const onVisible = () => {
          if (document.visibilityState === 'visible') void refreshAll()
        }
        window.addEventListener('focus', onVisible)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.removeEventListener('focus', onVisible)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const meetings = state.meetings ?? []
      const selected = state.meeting
      const speech = state.speech ?? state.data?.speech
      const speechAvailable = speechUsable(speech)
      const calendar = state.data?.calendar ?? null
      const calendarAvailable = calendar === null ? true : calendar.available !== false
      const calendarError = calendar !== null && calendar.available === false
        ? (typeof calendar.error === 'string' ? calendar.error : '任务日历插件未启动')
        : ''

      const filtered = useMemo(() => {
        const keyword = search.trim().toLowerCase()
        const kept = meetings.filter((item) => {
          if (filter === 'summarized' && !item.hasSummary) return false
          if (filter === 'unsummarized' && item.hasSummary) return false
          if (filter === 'pending' && !(Number(item.pendingTodoCount) > 0)) return false
          if (keyword === '') return true
          const haystack = `${item.title ?? ''} ${(item.attendees ?? []).join(' ')} ${item.date ?? ''}`.toLowerCase()
          return haystack.includes(keyword)
        })
        kept.sort((left, right) => {
          const byDate = String(right.date ?? '').localeCompare(String(left.date ?? ''))
          if (byDate !== 0) return byDate
          return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        })
        return kept
      }, [meetings, search, filter])

      const openSummarize = async (meetingId, force) => {
        const id = meetingId ?? selected?.id
        if (!id) return
        commit({ summarizing: { id, startedAt: Date.now() } })
        try {
          const payload = await summarizeMeetingById(id, force)
          const meeting = payload?.meeting
          const oneLine = meeting?.summary?.oneLine ?? '关键要点、决策、风险与待办已更新'
          notifySuccess(
            force ? '已重新生成纪要' : '已生成 AI 纪要',
            payload?.renamedTo
              ? `${oneLine}（会议已自动命名为「${payload.renamedTo}」）`
              : oneLine,
          )
        } catch (caught) {
          reportError(caught, '生成纪要失败')
        } finally {
          commit({ summarizing: null })
        }
      }

      const openExport = async (format) => {
        if (!selected) return
        commit({ exporting: format })
        try {
          const payload = await exportMeetingFile(selected, format)
          notifySuccess(
            format === 'html' ? 'HTML 导出完成' : 'Markdown 导出完成',
            payload.path ? `已保存到 ${payload.path}` : payload.filename,
          )
        } catch (caught) {
          reportError(caught, '导出失败')
        } finally {
          commit({ exporting: null })
        }
      }

      const patchTodo = async (todoId, patch) => {
        if (!selected) return false
        try {
          await updateMeetingTodo(selected.id, todoId, patch)
          notifySuccess('待办已更新', patch.title ?? '')
          return true
        } catch (caught) {
          reportError(caught, '保存待办失败')
          return false
        }
      }

      const pushTodos = async (todoIds) => {
        if (!selected) return null
        try {
          const payload = await pushMeetingTodos(selected.id, todoIds)
          const created = Array.isArray(payload.created) ? payload.created : []
          notifySuccess(
            `已写入任务日历 ${created.length} 条`,
            created.slice(0, 3).map((item) => `${item.title} → ${item.calendarTaskId}`).join('；') || '待办已同步',
          )
          return payload
        } catch (caught) {
          reportError(caught, '写入任务日历失败')
          return null
        }
      }

      const confirmDelete = async () => {
        if (!selected) return
        setDeleteOpen(false)
        try {
          const title = selected.title
          await deleteMeetingById(selected.id)
          notifySuccess('已删除会议', title)
        } catch (caught) {
          reportError(caught, '删除会议失败')
        }
      }

      const handlers = {
        newMeeting: () => setDialog('new'),
        record: () => {
          const live = snapshot.live ?? initialLiveState()
          if (liveIsActive(live)) {
            setDialog('record')
            return
          }
          if (live.status === 'done' || live.status === 'error') clearLiveRecording()
          if (!speechAvailable) {
            notify('warn', '语音识别不可用', '本机语音识别服务未就绪，请改用「导入纪要」的文本方式')
            return
          }
          setDialog('record')
        },
        importText: () => setDialog('import'),
        summarize: () => { void openSummarize(selected?.id, Boolean(selected?.summary)) },
        export: (format) => { void openExport(format) },
        delete: () => setDeleteOpen(true),
        autoIngest: () => setDialog('auto'),
        refresh: () => { void refreshAll() },
      }

      const closeDialog = () => setDialog(null)

      let content = null
      if (state.status === 'loading' && state.data === null) {
        content = h(
          'div',
          { className: 'dsm-loading' },
          h('span', { className: 'dsm-spin dsm-spin--lg' }),
          h('span', null, '正在加载会议纪要…'),
        )
      } else if (state.status === 'error' && state.data === null) {
        content = h(
          'div',
          { className: 'dsm-service-error' },
          h('div', { className: 'dsm-service-title' }, '会议纪要服务未启动'),
          h('div', { className: 'dsm-service-text' }, state.error ?? '会议纪要服务未启动，请重新加载页面'),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--primary',
            onClick: () => { window.location.reload() },
          }, '重新加载页面'),
        )
      } else if (meetings.length === 0) {
        content = h(EmptyState, {
          speech,
          onRecord: handlers.record,
          onImport: handlers.importText,
          onNew: handlers.newMeeting,
        })
      } else {
        const detail = selected === null
          ? h('div', { className: 'dsm-detail-empty' }, h(Icon, { name: 'doc', size: 22 }), h('span', null, '从左侧选择一场会议'))
          : state.meetingLoading && state.meeting === null
            ? h(
              'div',
              { className: 'dsm-loading' },
              h('span', { className: 'dsm-spin' }),
              h('span', null, '正在加载会议…'),
            )
            : h(MeetingDocument, {
              meeting: selected,
              summarizing: state.summarizing,
              calendarAvailable,
              calendarError,
              onEdit: () => setDialog('edit'),
              onRecord: handlers.record,
              onImport: handlers.importText,
              onSummarize: handlers.summarize,
              onPatchTodo: patchTodo,
              onPushTodos: pushTodos,
              recordDisabled: !speechAvailable,
            })
        content = h(
          'div',
          { className: 'dsm-body' },
          h(MeetingList, {
            meetings: filtered,
            total: meetings.length,
            selectedId: state.selectedId,
            search,
            onSearch: setSearch,
            filter,
            onFilter: setFilter,
            onSelect: (id) => { void selectMeeting(id) },
          }),
          h('div', { className: 'dsm-detail' }, detail),
        )
      }

      return h(
        'div',
        { className: 'dsm-root' },
        h(Toolbar, { state, handlers }),
        state.error !== null && !(state.status === 'error' && state.data === null)
          ? h(
            'div',
            { className: 'dsm-errorbar' },
            h(Icon, { name: 'alert', size: 13 }),
            h('span', { className: 'dsm-errorbar-text' }, state.error),
            h('button', {
              type: 'button',
              className: 'dsm-iconbtn',
              onClick: () => commit({ error: null }),
              'aria-label': '关闭错误提示',
            }, h(Icon, { name: 'close', size: 12 })),
          )
          : null,
        content,
        dialog === 'new'
          ? h(NewMeetingModal, { onClose: closeDialog })
          : null,
        dialog === 'edit' && selected !== null
          ? h(EditMeetingModal, { meeting: selected, onClose: closeDialog })
          : null,
        dialog === 'import'
          ? h(ImportTextModal, { meeting: selected, onClose: closeDialog })
          : null,
        dialog === 'auto'
          ? h(AutoIngestModal, {
            status: state.data?.autoIngest ?? null,
            onClose: closeDialog,
            onSelectMeeting: (meetingId) => {
              closeDialog()
              void selectMeeting(meetingId)
            },
          })
          : null,
        dialog === 'record'
          ? h(RecordModal, {
            onClose: closeDialog,
            onSummarize: (meetingId) => {
              closeDialog()
              void openSummarize(meetingId, false)
            },
            onOpenTextImport: () => { setDialog('import') },
          })
          : null,
        deleteOpen && selected !== null
          ? h(
            Modal,
            {
              title: '删除会议',
              subtitle: selected.title,
              onClose: () => setDeleteOpen(false),
              footer: [
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'dsm-btn',
                  onClick: () => setDeleteOpen(false),
                }, '取消'),
                h('button', {
                  key: 'delete',
                  type: 'button',
                  className: 'dsm-btn dsm-btn--danger',
                  onClick: () => { void confirmDelete() },
                }, '确认删除'),
              ],
            },
            h('p', { className: 'dsm-dialog-text' }, '确定删除这场会议吗？转写文本和 AI 纪要会一并删除；已经写入任务日历的待办不会被删除。'),
          )
          : null,
      )
    }

    // ──────────────────────────── plugin body ─────────────────────────────

    const inject = ['slots', 'layout']

    function apply(ctx) {
      clientContext = ctx
      ensureStyle()
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'meeting-minutes',
        order: 45,
        label: '会议纪要',
      }, MeetingGlyph))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'meeting-minutes',
      }, MeetingPanel))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'meeting-minutes-toasts',
        order: 30,
        label: '会议纪要通知',
      }, ToastOverlay))
      // Poll for auto-ingested meetings and fresh status; the interval is owned
      // by the plugin effect so unloading the bundle clears it.
      ctx.effect(() => {
        const timer = window.setInterval(() => { void refreshAll() }, 27_000)
        return () => { window.clearInterval(timer) }
      }, 'meeting-minutes: auto-ingest poll')
      void refreshAll()
    }

    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})

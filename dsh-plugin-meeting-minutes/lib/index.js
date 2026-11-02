/**
 * Host half of the meeting-minutes plugin.
 *
 * Responsibilities:
 * - own the durable meeting document (`$DSH_HOME/storages/meeting-minutes.json`),
 * - transcribe recordings through the Harness speech-to-text service (local
 *   SenseVoice by default),
 * - summarize transcripts through the current default LLM route,
 * - push confirmed action items into the task-calendar plugin's loopback API,
 * - expose model-facing tools so the agent can do the same work from chat,
 * - and serve the panel's local JSON API on `ctx.webServer`.
 *
 * The browser half (`./client`) renders the minutes panel. It is discovered by
 * the client module system from this package's `dsh.client` declaration — no
 * second loader entry is needed.
 *
 * @module dsh-plugin-meeting-minutes
 */

import { ROUTE_PREFIX, buildState, registerRoutes } from './server.js'
import { MeetingStore } from './store.js'
import { registerTools } from './tools.js'
import { createAsr } from './asr.js'
import { createSummarizer } from './summarize.js'
import { createCalendar } from './calendar.js'
import { createAutoIngest } from './autoingest.js'
import { registerMeetingSkill } from './skill.js'
import { createSpeakerTagger, ensureSpeakerModel, resolveSpeakerSettings } from './speaker.js'

/** Loader-facing plugin name. */
export const name = 'meeting-minutes'

/** Services this plugin needs before it can start. */
export const inject = ['tools', 'webServer']

/**
 * Plugin body.
 * @param ctx - host Cordis context.
 */
export function apply(ctx) {
  const store = new MeetingStore({ logger: ctx.logger })
  const asr = createAsr({ ctx, config: {} })
  const summarizer = createSummarizer({ ctx, logger: ctx.logger })
  const calendar = createCalendar({ ctx, logger: ctx.logger })
  const autoIngest = createAutoIngest({ store, asr, logger: ctx.logger })
  // Local voiceprint tagging: on by default, `MEETING_SPEAKER_DISABLE=1` turns
  // it off, `MEETING_SPEAKER_THRESHOLD` overrides the cosine threshold. The
  // model is installed by the packaging script; when it is missing the tagger
  // stays dormant and live transcripts simply keep their plain text.
  const speakerSettings = resolveSpeakerSettings(process.env)
  const speakerTagger = createSpeakerTagger({
    home: process.env.DSH_HOME,
    logger: ctx.logger,
    disabled: speakerSettings.disabled,
    threshold: speakerSettings.threshold,
    maxSpeakers: speakerSettings.maxSpeakers,
    minSeconds: speakerSettings.minSeconds,
  })
  const deps = { store, asr, summarizer, calendar, autoIngest, speakerTagger, logger: ctx.logger }

  ctx.effect(() => registerRoutes(ctx, deps), 'meeting-minutes: http routes')
  ctx.effect(() => autoIngest.start(), 'meeting-minutes: auto ingest poll')
  ctx.effect(() => {
    const disposers = registerTools(ctx, deps)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'meeting-minutes: agent tools')
  ctx.effect(() => registerMeetingSkill(ctx), 'meeting-minutes: companion skill')
  // Prepare + warm the extractor in the background so the first live slice is
  // not the one paying the model download/load cost. Missing model gets fetched
  // once (安装脚本已经预下载时这里只是 sha256 短路); failure is degraded, never fatal.
  void (async () => {
    try {
      if (!speakerSettings.disabled) {
        await ensureSpeakerModel({ home: process.env.DSH_HOME, logger: ctx.logger })
      }
    } catch (error) {
      ctx.logger?.warn?.(`meeting-minutes: 说话人模型未就绪（${String(error?.message ?? error)}），实时转写暂不加说话人标签`)
    }
    try {
      await speakerTagger.warmup()
    } catch {
      // warmup never rejects, but a background task must never be an unhandled one.
    }
  })()

  store.load().then(
    (document) => {
      ctx.logger?.info?.(
        `meeting-minutes: ready — ${document.meetings.length} meeting(s) at ${store.file} (api ${ROUTE_PREFIX}, speakers ${speakerSettings.disabled ? 'off' : 'on'})`,
      )
    },
    (error) => {
      ctx.logger?.error?.(error)
    },
  )
}

export { buildState, ROUTE_PREFIX }

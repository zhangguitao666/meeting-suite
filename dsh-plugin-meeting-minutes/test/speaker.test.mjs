/**
 * 会议纪要插件 · 本地说话人识别（声纹）与说话人标签测试。
 *
 * 这里**绝不加载真实的 sherpa-onnx native 模块**：提取器一律用注入的
 * `loadExtractor` 假实现，模型文件用临时目录 + 假 fetch 验证下载/校验逻辑。
 * 真实模型只做离线烟雾测试（见交付说明），不进单测。
 *
 * @module dsh-plugin-meeting-minutes/test/speaker
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { encodeWavPcm16 } from '../lib/audio.js'
import {
  MeetingStore,
  normalizeSpeakers,
} from '../lib/store.js'
import {
  SPEAKER_DEFAULT_THRESHOLD,
  SPEAKER_MAX_SPEAKERS,
  SPEAKER_MIN_SECONDS,
  SPEAKER_MODEL_BYTES,
  SPEAKER_MODEL_FILE,
  SPEAKER_MODEL_SHA256,
  cosineSimilarity,
  createSpeakerRegistry,
  createSpeakerTagger,
  ensureSpeakerModel,
  resolveSpeakerModelDir,
  resolveSpeakerSettings,
} from '../lib/speaker.js'
import { registerTools } from '../lib/tools.js'

const CHINESE = /[\u4e00-\u9fa5]/

/** 临时目录，测完删。 */
async function makeTempDir(label) {
  return mkdtemp(join(tmpdir(), `meeting-${label}-`))
}

/** 一段 16k 单声道 PCM16 WAV，所有采样都填同一个值（假提取器据此区分说话人）。 */
function wavWithSample(value, seconds = 2) {
  const frames = Math.max(1, Math.round(16000 * seconds))
  return encodeWavPcm16(new Int16Array(frames).fill(value))
}

/**
 * 假提取器：按第一个采样的取值返回一个固定 2 维向量，模拟「不同人不同向量」。
 * 实现与 sherpa 一致的 createStream → acceptWaveform → compute 接口。
 */
function fakeExtractor(vectorFor = defaultVectorFor) {
  return {
    dim: 2,
    createStream() {
      const stream = {}
      stream.acceptWaveform = ({ sampleRate, samples }) => {
        stream.sampleRate = sampleRate
        stream.samples = samples
      }
      return stream
    },
    compute(stream) {
      return vectorFor(stream.samples)
    },
  }
}

/** 第一个采样 → 向量：1000 ≈ A，-1000 ≈ B，500 ≈ A 的弱同人，300 ≈ 不同人。 */
function defaultVectorFor(samples) {
  const value = Math.round(samples[0] * 32768)
  if (value === 1000) return [1, 0]
  if (value === -1000) return [0, 1]
  if (value === 500) return [0.6, 0.8]
  if (value === 300) return [0.5, Math.sqrt(0.75)]
  return [1, 0]
}

/** 记录型假 tagger（服务器注入用）。 */
function fakeTagger(handler) {
  const calls = { identify: [], rename: [], reset: [] }
  return {
    calls,
    async identify(bytes, options) {
      calls.identify.push({ bytes: bytes.length, meetingId: options?.meetingId })
      return handler(bytes, options, calls)
    },
    rename(meetingId, speakerId, name) {
      calls.rename.push({ meetingId, speakerId, name })
      return { id: speakerId, label: name }
    },
    reset(meetingId) {
      calls.reset.push(meetingId)
    },
  }
}

/** 一个记录 warn 的 logger。 */
function memoryLogger() {
  const warns = []
  const infos = []
  return {
    warns,
    infos,
    info(message) { infos.push(String(message)) },
    warn(message) { warns.push(String(message)) },
    error(message) { warns.push(String(message)) },
  }
}

test('cosineSimilarity: 相同/正交/相反/零向量/长度不一致', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1)
  assert.equal(cosineSimilarity([1, 0], [0, 0]), 0)
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0)
  assert.equal(cosineSimilarity(null, [1, 0]), 0)
  assert.equal(cosineSimilarity([Number.NaN, 1], [1, 0]), 0)
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])), 1)
})

test('createSpeakerRegistry: 默认阈值 0.58、命中用旧 id、低于阈值注册新说话人', () => {
  const registry = createSpeakerRegistry()
  assert.equal(SPEAKER_DEFAULT_THRESHOLD, 0.58)
  assert.equal(registry.size(), 0)

  const first = registry.identify([1, 0])
  assert.deepEqual({ id: first.id, label: first.label, isNew: first.isNew }, { id: 'speaker-1', label: '说话人1', isNew: true })
  assert.equal(registry.size(), 1)

  // 0.6 > 0.58 → 同一人
  const matched = registry.identify([0.6, 0.8])
  assert.equal(matched.id, 'speaker-1')
  assert.equal(matched.isNew, false)
  assert.ok(Math.abs(matched.score - 0.6) < 1e-4)

  // 明显不同（正交）→ 新说话人
  const second = registry.identify([0, 1])
  assert.equal(second.id, 'speaker-2')
  assert.equal(second.isNew, true)
  assert.equal(registry.size(), 2)

  // 0.5 < 0.58：在全新的注册表里不会命中（EMA 会把老注册表的质心拉过去，故单独验）
  const below = createSpeakerRegistry()
  below.identify([1, 0])
  assert.equal(below.identify([0.5, Math.sqrt(0.75)]).isNew, true)
  assert.equal(below.size(), 2)

  // 非法向量返回 null，不注册
  assert.equal(registry.identify(null), null)
  assert.equal(registry.identify([]), null)
  assert.equal(registry.identify([1, Number.NaN]), null)
  assert.equal(registry.size(), 2)

  assert.deepEqual(registry.list(), [
    { id: 'speaker-1', label: '说话人1' },
    { id: 'speaker-2', label: '说话人2' },
  ])
})

test('createSpeakerRegistry: 自定义阈值与容量上限时归到最相近的人', () => {
  const strict = createSpeakerRegistry({ threshold: 0.9, maxSpeakers: 2 })
  strict.identify([1, 0])
  strict.identify([0, 1])
  // 与两条都低于 0.9，但容量用满 → 归到更相近的 speaker-2，不新增
  const crowded = strict.identify([0.5, Math.sqrt(0.75)])
  assert.equal(crowded.id, 'speaker-2')
  assert.equal(crowded.isNew, false)
  assert.equal(strict.size(), 2)
  assert.equal(SPEAKER_MAX_SPEAKERS, 8)

  // 阈值的边界是 >=
  const boundary = createSpeakerRegistry({ threshold: 0.6 })
  boundary.identify([1, 0])
  assert.equal(boundary.identify([0.6, 0.8]).isNew, false)
})

test('createSpeakerRegistry: EMA 让缓慢漂移的向量继续归同一人', () => {
  const registry = createSpeakerRegistry({ threshold: 0.5, emaAlpha: 0.3 })
  registry.identify([1, 0])
  // 与 [1,0] 恰好 0.5 → 命中，质心被 EMA 拉向 60°
  assert.equal(registry.identify([0.5, Math.sin(Math.PI / 3)]).id, 'speaker-1')
  // 70° 与原始 [1,0] 只有 0.342（若不更新质心会新建），与漂移后的质心约 0.54 → 仍归 speaker-1
  const drifted = registry.identify([Math.cos((70 * Math.PI) / 180), Math.sin((70 * Math.PI) / 180)])
  assert.equal(drifted.id, 'speaker-1')
  assert.equal(registry.size(), 1)
})

test('createSpeakerRegistry.rename: 改标签保留 id，空名字/未知 id 返回 null', () => {
  const registry = createSpeakerRegistry()
  registry.identify([1, 0])
  assert.deepEqual(registry.rename('speaker-1', ' 张三 '), { id: 'speaker-1', label: '张三' })
  assert.equal(registry.identify([1, 0]).label, '张三')
  assert.equal(registry.rename('speaker-9', '李四'), null)
  assert.equal(registry.rename('speaker-1', '   '), null)
  assert.equal(registry.list()[0].label, '张三')
})

test('resolveSpeakerModelDir: 默认落在 $DSH_HOME/meeting-minutes/speaker', () => {
  assert.equal(resolveSpeakerModelDir('/tmp/dsh-home'), join('/tmp/dsh-home', 'meeting-minutes', 'speaker'))
  assert.match(SPEAKER_MODEL_FILE, /campplus.*16k-common\.onnx$/)
  assert.equal(SPEAKER_MODEL_BYTES, 28281138)
  assert.match(SPEAKER_MODEL_SHA256, /^[a-f0-9]{64}$/)
})

test('ensureSpeakerModel: 已存在且校验通过时短路，不触发下载', async () => {
  const dir = await makeTempDir('speaker-existing')
  try {
    const content = Buffer.from('already-installed-model')
    const sha = createHash('sha256').update(content).digest('hex')
    await writeFile(join(dir, SPEAKER_MODEL_FILE), content)
    let fetched = 0
    const fetchImpl = async () => {
      fetched += 1
      throw new Error('不应该下载')
    }
    const file = await ensureSpeakerModel({ dir, fetchImpl, expectedBytes: content.length, expectedSha256: sha })
    assert.equal(file, join(dir, SPEAKER_MODEL_FILE))
    assert.equal(fetched, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureSpeakerModel: 假 fetch 下载 → 校验 → 落盘 → 再次调用短路', async () => {
  const dir = await makeTempDir('speaker-download')
  try {
    const content = Buffer.from('downloaded-model-bytes')
    const sha = createHash('sha256').update(content).digest('hex')
    let fetched = 0
    const fetchImpl = async (url) => {
      fetched += 1
      assert.match(url, /3dspeaker_speech_campplus_sv_zh-cn_16k-common\.onnx$/)
      return { ok: true, status: 200, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }
    }
    const file = await ensureSpeakerModel({ dir, fetchImpl, expectedBytes: content.length, expectedSha256: sha })
    assert.equal(fetched, 1)
    assert.deepEqual(await readFile(file), content)

    const second = await ensureSpeakerModel({ dir, fetchImpl, expectedBytes: content.length, expectedSha256: sha })
    assert.equal(second, file)
    assert.equal(fetched, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ensureSpeakerModel: sha256 不符 / HTTP 失败都抛中文错误且不留半成品', async () => {
  const dir = await makeTempDir('speaker-bad')
  try {
    const content = Buffer.from('corrupt')
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
    })
    await assert.rejects(
      ensureSpeakerModel({ dir, fetchImpl, expectedBytes: content.length, expectedSha256: 'a'.repeat(64) }),
      (error) => CHINESE.test(error.message) && /sha256/.test(error.message),
    )
    await assert.rejects(stat(join(dir, SPEAKER_MODEL_FILE)), /ENOENT/)

    const httpFail = async () => ({ ok: false, status: 404 })
    await assert.rejects(
      ensureSpeakerModel({ dir, fetchImpl: httpFail, expectedBytes: content.length, expectedSha256: 'a'.repeat(64) }),
      (error) => /HTTP 404/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createSpeakerTagger: 注入假提取器后按声纹分配 speaker-1/speaker-2', async () => {
  const tagger = createSpeakerTagger({
    home: await makeTempDir('speaker-tagger-home'),
    loadExtractor: async () => fakeExtractor(),
    threshold: SPEAKER_DEFAULT_THRESHOLD,
  })
  const meetingA = wavWithSample(1000)
  const meetingB = wavWithSample(-1000)

  const first = await tagger.identify(meetingA, { meetingId: 'mt_1' })
  assert.deepEqual({ id: first.id, label: first.label }, { id: 'speaker-1', label: '说话人1' })
  const again = await tagger.identify(meetingA, { meetingId: 'mt_1' })
  assert.equal(again.id, 'speaker-1')

  const other = await tagger.identify(meetingB, { meetingId: 'mt_1' })
  assert.equal(other.id, 'speaker-2')
  // 不同会议各自一张注册表，互不串人
  const fresh = await tagger.identify(meetingB, { meetingId: 'mt_2' })
  assert.equal(fresh.id, 'speaker-1')
  assert.equal(tagger.list('mt_1').length, 2)
  assert.equal(tagger.list('mt_2').length, 1)

  assert.deepEqual(tagger.rename('mt_1', 'speaker-1', '张三'), { id: 'speaker-1', label: '张三' })
  assert.equal((await tagger.identify(meetingA, { meetingId: 'mt_1' })).label, '张三')
  tagger.reset('mt_1')
  assert.deepEqual(tagger.list('mt_1'), [])

  const status = tagger.status()
  assert.equal(status.enabled, true)
  assert.equal(status.ready, true)
  assert.equal(status.threshold, SPEAKER_DEFAULT_THRESHOLD)
  assert.equal(status.maxSpeakers, SPEAKER_MAX_SPEAKERS)
})

test('createSpeakerTagger: 短于 1.2 秒的切片返回 null 且不注册新说话人', async () => {
  const tagger = createSpeakerTagger({ home: await makeTempDir('speaker-short'), loadExtractor: async () => fakeExtractor() })
  assert.equal(SPEAKER_MIN_SECONDS, 1.2)
  const short = await tagger.identify(wavWithSample(1000, 0.8), { meetingId: 'mt_short' })
  assert.equal(short, null)
  assert.equal(tagger.list('mt_short').length, 0)
  // 超过阈值就正常识别
  const ok = await tagger.identify(wavWithSample(1000, 1.5), { meetingId: 'mt_short' })
  assert.equal(ok.id, 'speaker-1')
})

test('createSpeakerTagger: 依赖缺失/加载抛错/坏音频都只降级返回 null（不抛）', async () => {
  const logger = memoryLogger()
  let loads = 0
  const failing = createSpeakerTagger({
    home: await makeTempDir('speaker-fail'),
    logger,
    loadExtractor: async () => {
      loads += 1
      throw new Error('sherpa 加载失败')
    },
  })
  assert.equal(await failing.identify(wavWithSample(1000), { meetingId: 'mt_fail' }), null)
  assert.equal(loads, 1)
  assert.ok(logger.warns.some((line) => /说话人识别不可用/.test(line)))
  assert.equal(failing.status().status, 'failed')
  assert.equal(failing.ready, false)

  const good = createSpeakerTagger({ home: await makeTempDir('speaker-bad-wav'), loadExtractor: async () => fakeExtractor() })
  assert.equal(await good.identify(new Uint8Array([1, 2, 3])), null)
  assert.equal(await good.identify(null), null)
})

test('createSpeakerTagger: 关闭开关与缺模型时不加载、不抛', async () => {
  let loads = 0
  const disabled = createSpeakerTagger({
    home: await makeTempDir('speaker-disabled'),
    disabled: true,
    loadExtractor: async () => {
      loads += 1
      return fakeExtractor()
    },
  })
  assert.equal(await disabled.identify(wavWithSample(1000)), null)
  assert.equal(loads, 0)
  assert.equal(disabled.status().enabled, false)

  const logger = memoryLogger()
  const home = await makeTempDir('speaker-no-model')
  const noModel = createSpeakerTagger({ home, logger })
  assert.equal(await noModel.identify(wavWithSample(1000), { meetingId: 'mt_nomodel' }), null)
  assert.equal(noModel.status().ready, false)
  assert.ok(logger.warns.some((line) => /缺少说话人模型/.test(line)))
})

test('resolveSpeakerSettings: MEETING_SPEAKER_* 环境变量覆盖阈值/容量/开关', () => {
  assert.deepEqual(resolveSpeakerSettings({}), {
    disabled: false,
    threshold: SPEAKER_DEFAULT_THRESHOLD,
    maxSpeakers: SPEAKER_MAX_SPEAKERS,
    minSeconds: SPEAKER_MIN_SECONDS,
  })
  const custom = resolveSpeakerSettings({
    MEETING_SPEAKER_THRESHOLD: '0.7',
    MEETING_SPEAKER_MAX: '4',
    MEETING_SPEAKER_DISABLE: '1',
  })
  assert.equal(custom.threshold, 0.7)
  assert.equal(custom.maxSpeakers, 4)
  assert.equal(custom.disabled, true)
  // 非法值回落默认
  assert.equal(resolveSpeakerSettings({ MEETING_SPEAKER_THRESHOLD: 'nope' }).threshold, SPEAKER_DEFAULT_THRESHOLD)
  assert.equal(resolveSpeakerSettings({ MEETING_SPEAKER_THRESHOLD: '2' }).threshold, SPEAKER_DEFAULT_THRESHOLD)
})

test('normalizeSpeakers: 丢弃非法项、补默认标签、按 id 去重', () => {
  assert.deepEqual(normalizeSpeakers(undefined), [])
  assert.deepEqual(normalizeSpeakers('nope'), [])
  assert.deepEqual(normalizeSpeakers([
    { id: 'speaker-2', label: '张三' },
    { id: 'speaker-2', label: '重复 id' },
    { id: 'speaker-1' },
    { id: 'bad-id', label: '忽略' },
    null,
  ]), [
    { id: 'speaker-2', label: '张三' },
    { id: 'speaker-1', label: '说话人1' },
  ])
})

test('MeetingStore: speakers 增删改重命名替换 transcript/transcriptRaw 前缀并持久化', async () => {
  const dir = await makeTempDir('speaker-store')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const file = join(dir, 'meeting-minutes.json')
    const store = new MeetingStore({ file })
    const meeting = await store.add({ title: '两人会议', transcript: '说话人1：你好\n说话人2：收到' })
    assert.deepEqual(meeting.speakers, [])
    assert.equal(meeting.transcriptRaw, '说话人1：你好\n说话人2：收到')

    await store.addSpeaker(meeting.id, { id: 'speaker-1', label: '说话人1' })
    await store.addSpeaker(meeting.id, { id: 'speaker-1', label: '重复不追加' })
    await store.addSpeaker(meeting.id, { id: 'speaker-2', label: '说话人2' })
    assert.equal(store.get(meeting.id).speakers.length, 2)
    assert.equal(store.get(meeting.id).speakers[0].label, '说话人1')

    const renamed = await store.renameSpeaker(meeting.id, 'speaker-1', '张三')
    assert.equal(renamed.transcript, '张三：你好\n说话人2：收到')
    assert.equal(renamed.transcriptRaw, '张三：你好\n说话人2：收到')
    assert.equal(renamed.transcriptEdits, 0)
    assert.equal(renamed.speakers[0].label, '张三')

    // 只改标题的 patch 不能把 speakers 弄丢
    const patched = await store.patch(meeting.id, { title: '两人会议（改）' })
    assert.deepEqual(patched.speakers.map((entry) => entry.label), ['张三', '说话人2'])

    // 重新从磁盘加载：speakers 与改过的前缀都要在
    const reloaded = new MeetingStore({ file })
    await reloaded.load()
    const fromDisk = reloaded.get(meeting.id)
    assert.deepEqual(fromDisk.speakers, [{ id: 'speaker-1', label: '张三' }, { id: 'speaker-2', label: '说话人2' }])
    assert.equal(fromDisk.transcript, '张三：你好\n说话人2：收到')

    // setSpeakers 整体替换并规范化
    await reloaded.setSpeakers(meeting.id, [{ id: 'speaker-3', label: '' }, { id: 'oops' }])
    assert.deepEqual(reloaded.get(meeting.id).speakers, [{ id: 'speaker-3', label: '说话人3' }])

    await assert.rejects(reloaded.renameSpeaker(meeting.id, 'speaker-9', '李四'), (error) => /未找到说话人/.test(error.message) && error.status === 404)
    await assert.rejects(reloaded.renameSpeaker(meeting.id, 'speaker-3', '   '), /名称不能为空/)
    await assert.rejects(reloaded.renameSpeaker(meeting.id, 'speaker-3', '长'.repeat(41)), /名称过长/)
    await assert.rejects(reloaded.renameSpeaker('mt_nope', 'speaker-3', '李四'), /未找到会议/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('meeting_speakers 工具: list 段数与 rename 文案', async () => {
  const dir = await makeTempDir('speaker-tool')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const store = new MeetingStore({ file: join(dir, 'meeting-minutes.json') })
    const meeting = await store.add({
      title: '周会',
      transcript: '说话人1：先说\n说话人2：补充\n说话人1：结论',
    })
    await store.addSpeaker(meeting.id, { id: 'speaker-1', label: '说话人1' })
    await store.addSpeaker(meeting.id, { id: 'speaker-2', label: '说话人2' })

    const defs = []
    const ctx = { tools: { register(definition) { defs.push(definition); return () => {} } } }
    const speakerTagger = { calls: [], rename(meetingId, speakerId, name) { this.calls.push({ meetingId, speakerId, name }) } }
    registerTools(ctx, { store, asr: {}, summarizer: {}, calendar: {}, speakerTagger })
    const tool = defs.find((definition) => definition.name === 'meeting_speakers')
    assert.ok(tool !== undefined)

    const listed = await tool.execute({ id: meeting.id, action: 'list' })
    assert.match(listed, /共有 2 位说话人/)
    assert.match(listed, /\[speaker-1\] 说话人1 · 2 段/)
    assert.match(listed, /\[speaker-2\] 说话人2 · 1 段/)

    const renamed = await tool.execute({ id: meeting.id, action: 'rename', speakerId: 'speaker-1', name: '张三' })
    assert.match(renamed, /已把 speaker-1 重命名为「张三」/)
    assert.match(renamed, /\[speaker-1\] 张三 · 2 段/)
    assert.equal(store.get(meeting.id).transcript, '张三：先说\n说话人2：补充\n张三：结论')
    assert.deepEqual(speakerTagger.calls, [{ meetingId: meeting.id, speakerId: 'speaker-1', name: '张三' }])

    await assert.rejects(tool.execute({ id: meeting.id, action: 'rename', speakerId: 'speaker-9', name: '李四' }), /未找到说话人/)
    await assert.rejects(tool.execute({ id: meeting.id, action: 'rename', speakerId: 'speaker-1', name: '  ' }), /name 必须是非空字符串/)
    await assert.rejects(tool.execute({ id: meeting.id, action: 'boom' }), /未知 action/)

    const empty = await store.add({ title: '没有说话人的会' })
    const described = await tool.execute({ id: empty.id, action: 'list' })
    assert.match(described, /还没有识别出说话人/)
    assert.match(described, /实时录音/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

test('Slark runtime 自带的已签名 sherpa 优先于插件本地副本', async () => {
  const { resolveRuntimeSherpaModule } = await import('../lib/speaker.js')
  // 非 Slark 的 node（系统 node、测试 node）旁边没有 runtime，必须安静返回 null。
  assert.equal(resolveRuntimeSherpaModule(process.execPath), null)
  assert.equal(resolveRuntimeSherpaModule('/nonexistent/node/bin/node'), null)

  const root = await mkdtemp(join(tmpdir(), 'meeting-runtime-sherpa-'))
  try {
    const moduleDir = join(root, 'app', 'node_modules', '.pnpm', 'sherpa-onnx-node@9.9.9', 'node_modules', 'sherpa-onnx-node')
    await mkdir(join(moduleDir), { recursive: true })
    await writeFile(join(moduleDir, 'package.json'), '{"name":"sherpa-onnx-node","version":"9.9.9"}\n')
    const execPath = join(root, 'node', 'bin', 'node')
    assert.equal(resolveRuntimeSherpaModule(execPath), moduleDir)
    // 有 .pnpm 目录但没有 sherpa 包时也返回 null，而不是抛错。
    await rm(join(root, 'app', 'node_modules', '.pnpm'), { recursive: true, force: true })
    await mkdir(join(root, 'app', 'node_modules', '.pnpm'), { recursive: true })
    assert.equal(resolveRuntimeSherpaModule(execPath), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('静音切片不进入声纹注册表（固定切片的录音器会送静音进来）', async () => {
  const { createSpeakerTagger } = await import('../lib/speaker.js')
  const home = await mkdtemp(join(tmpdir(), 'meeting-speaker-silence-'))
  try {
    let extracted = 0
    const tagger = createSpeakerTagger({
      home,
      loadExtractor: async () => {
        const fake = {
          dim: 2,
          createStream() {
            const stream = {}
            stream.acceptWaveform = () => {}
            return stream
          },
          compute() {
            extracted += 1
            return new Float32Array([1, 0])
          },
        }
        return fake
      },
    })
    // 2 秒、RMS≈0.0006 的底噪：低于 SPEAKER_MIN_RMS，应该直接跳过。
    const quiet = new Int16Array(32000).fill(20)
    assert.equal(await tagger.identify(encodeWavPcm16(quiet), { meetingId: 'silent' }), null)
    assert.equal(extracted, 0, '静音片段不应调用声纹提取器')
    assert.deepEqual(tagger.list('silent'), [])

    // 同样长度但音量正常：应该提取并注册第一位说话人。
    const loud = new Int16Array(32000)
    for (let index = 0; index < loud.length; index += 1) loud[index] = index % 2 === 0 ? 12000 : -12000
    const tagged = await tagger.identify(encodeWavPcm16(loud), { meetingId: 'silent' })
    assert.ok(tagged !== null, '正常音量的切片应该被标注')
    assert.equal(extracted, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * VoiceStudio 外部 ASR 后端单测（不连真后端，全部 mock fetch）。
 *
 * 覆盖：
 * - 设置解析的默认值与非法值兜底；
 * - 说话人标识按首次出现顺序归一、连续同人合并、无说话人保持纯文本；
 * - 成功路径的表单字段（mode=accurate / diarize=1 / num_speakers）；
 * - HTTP 错误与非 JSON 响应给出可读中文错误；
 * - /health 探测失败一律返回 false（不能把异常抛给调用方）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  normalizeSegments,
  probeVoiceStudio,
  resolveVoiceStudioSettings,
  transcribeViaVoiceStudio,
} from '../lib/voicestudio.js'

/** 造一个临时音频文件，返回绝对路径。 */
async function tempAudio(bytes = new Uint8Array([1, 2, 3, 4])) {
  const dir = await mkdtemp(join(tmpdir(), 'vs-asr-test-'))
  const path = join(dir, 'meeting.wav')
  await writeFile(path, bytes)
  return path
}

test('设置：默认 auto + 本机 3900 + 开说话人', () => {
  const settings = resolveVoiceStudioSettings({})
  assert.equal(settings.backend, 'auto')
  assert.equal(settings.baseUrl, DEFAULT_BASE_URL)
  assert.equal(settings.enabled, true)
  assert.equal(settings.fallback, true)
  assert.equal(settings.diarize, true)
  assert.equal(settings.numSpeakers, 0)
  assert.equal(settings.timeoutMs, DEFAULT_TIMEOUT_MS)
})

test('设置：local 关闭外部后端，voicestudio 不回退，非法 backend 归 auto', () => {
  assert.equal(resolveVoiceStudioSettings({ MEETING_ASR_BACKEND: 'local' }).enabled, false)
  const forced = resolveVoiceStudioSettings({ MEETING_ASR_BACKEND: 'voicestudio' })
  assert.equal(forced.enabled, true)
  assert.equal(forced.fallback, false)
  assert.equal(resolveVoiceStudioSettings({ MEETING_ASR_BACKEND: '乱填' }).backend, 'auto')
})

test('设置：URL 去尾斜杠、超时与人数可调、diarize 可关', () => {
  const settings = resolveVoiceStudioSettings({
    MEETING_VOICESTUDIO_URL: 'http://127.0.0.1:3911/',
    MEETING_VOICESTUDIO_DIARIZE: '0',
    MEETING_VOICESTUDIO_SPEAKERS: '3',
    MEETING_VOICESTUDIO_TIMEOUT_MS: '60000',
  })
  assert.equal(settings.baseUrl, 'http://127.0.0.1:3911')
  assert.equal(settings.diarize, false)
  assert.equal(settings.numSpeakers, 3)
  assert.equal(settings.timeoutMs, 60000)
})

test('归一：按首次出现顺序编号，连续同人合并成一行', () => {
  const result = normalizeSegments([
    { start: 0, end: 1.2, text: '大家好', speaker: 'SPEAKER_00' },
    { start: 1.2, end: 2.0, text: '开始吧', speaker: 'SPEAKER_00' },
    { start: 2.0, end: 3.0, text: '好的', speaker: 'SPEAKER_01' },
    { start: 3.0, end: 4.0, text: '' },
  ])
  assert.equal(result.text, '说话人1：大家好开始吧\n说话人2：好的')
  assert.deepEqual(result.speakers, [
    { id: 'speaker-1', label: '说话人1' },
    { id: 'speaker-2', label: '说话人2' },
  ])
  assert.equal(result.segments.length, 3)
})

test('归一：没有说话人时保持纯文本单行，英文之间补空格', () => {
  const result = normalizeSegments([
    { start: 0, end: 1, text: 'hello' },
    { start: 1, end: 2, text: 'world' },
  ])
  assert.equal(result.text, 'hello world')
  assert.deepEqual(result.speakers, [])
  assert.equal(result.segments[1].speakerId, null)
})

test('探测：连不上 / 非 200 一律 false，不抛错', async () => {
  const settings = resolveVoiceStudioSettings({})
  assert.equal(await probeVoiceStudio(settings, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } }), false)
  assert.equal(await probeVoiceStudio(settings, { fetchImpl: async () => ({ ok: false }) }), false)
  assert.equal(await probeVoiceStudio(settings, { fetchImpl: async () => ({ ok: true }) }), true)
})

test('成功：表单带 accurate/diarize，结果含说话人与耗时', async () => {
  const path = await tempAudio()
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({
      text: '大家好开始吧 好的',
      segments: [
        { start: 0, end: 2, text: '大家好开始吧', speaker: 'SPEAKER_00' },
        { start: 2, end: 3, text: '好的', speaker: 'SPEAKER_01' },
      ],
      language: 'zh',
      duration_s: 12.5,
      transcription_time_s: 3.25,
      engine: 'funasr',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await transcribeViaVoiceStudio(
    path,
    resolveVoiceStudioSettings({ MEETING_VOICESTUDIO_SPEAKERS: '2' }),
    { fetchImpl, language: 'zh' },
  )
  assert.equal(captured.url, `${DEFAULT_BASE_URL}/transcribe`)
  assert.equal(captured.init.method, 'POST')
  const form = captured.init.body
  assert.equal(form.get('mode'), 'accurate')
  assert.equal(form.get('diarize'), '1')
  assert.equal(form.get('num_speakers'), '2')
  assert.equal(form.get('language'), 'zh')
  assert.equal(result.text, '说话人1：大家好开始吧\n说话人2：好的')
  assert.equal(result.audioSeconds, 12.5)
  assert.equal(result.inferenceSeconds, 3.25)
  assert.equal(result.engine, 'funasr')
  assert.equal(result.speakers.length, 2)
})

test('失败：HTTP 500 抛出带状态码的中文错误', async () => {
  const path = await tempAudio()
  await assert.rejects(
    transcribeViaVoiceStudio(path, resolveVoiceStudioSettings({}), {
      fetchImpl: async () => new Response('boom', { status: 500 }),
    }),
    /VoiceStudio 转写失败：HTTP 500/,
  )
})

test('失败：非 JSON 响应给出可读错误', async () => {
  const path = await tempAudio()
  await assert.rejects(
    transcribeViaVoiceStudio(path, resolveVoiceStudioSettings({}), {
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
    }),
    /返回的不是 JSON/,
  )
})

test('失败：文件不存在直接报错，不发起请求', async () => {
  let called = false
  await assert.rejects(
    transcribeViaVoiceStudio('/nope/missing.wav', resolveVoiceStudioSettings({}), {
      fetchImpl: async () => { called = true; return new Response('{}') },
    }),
    /音频文件不存在/,
  )
  assert.equal(called, false)
})

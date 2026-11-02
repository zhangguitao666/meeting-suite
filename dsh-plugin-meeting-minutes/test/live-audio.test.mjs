/**
 * Tests for live-recording audio: slice accumulation, one-shot merge on stop,
 * and the guarantee that streaming slices never become retained copies.
 *
 * Run with the bundled Node:
 *   node --test test/live-audio.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { concatWavPcm16, encodeWavPcm16, secondsOf } from '../lib/audio.js'
import {
  clearAudioParts,
  finalizeAudioParts,
  resolveAudioDir,
  resolveAudioPartsDir,
  sha256Bytes,
  storeAudioPart,
} from '../lib/audio-store.js'
import { assertRealAudioUnchanged } from './support/real-audio-guard.mjs'

/** Run one test body against a throwaway `$DSH_HOME` equivalent. */
async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'meeting-live-test-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** One second of silence at 16 kHz mono PCM16 (a stand-in live slice). */
function sampleSlice(seconds = 1, fill = 100) {
  return encodeWavPcm16(new Int16Array(Math.round(16000 * seconds)).fill(fill))
}

test('concatWavPcm16 与一次性编码结果逐字节一致', () => {
  const first = new Int16Array(16000).fill(11)
  const second = new Int16Array(16000).fill(22)
  const merged = concatWavPcm16([encodeWavPcm16(first), encodeWavPcm16(second)])
  const direct = encodeWavPcm16(new Int16Array([...first, ...second]))
  assert.deepEqual(Buffer.from(merged), Buffer.from(direct))
  assert.equal(secondsOf(merged), 2)
})

test('concatWavPcm16 拒绝空数组与非法片段', () => {
  assert.throws(() => concatWavPcm16([]), /没有可拼接/)
  assert.throws(() => concatWavPcm16([new Uint8Array(32)]), /WAV|RIFF|音频/)
})

test('live 切片只暂存不落副本，停录合并成一份整场 wav', async () => {
  await withHome(async (home) => {
    const meetingId = 'mt_live_test'
    const sliceA = sampleSlice(1, 100)
    const sliceB = sampleSlice(1, 200)
    await storeAudioPart({ meetingId, index: 1, bytes: sliceA, home })
    await storeAudioPart({ meetingId, index: 2, bytes: sliceB, home })

    // Slices live under the dot-directory and are NOT retained copies.
    const partsDir = resolveAudioPartsDir(meetingId, home)
    assert.equal((await readdir(partsDir)).length, 2)
    // The folder itself may exist now, but it holds no retained copy.
    const retainedBefore = (await readdir(resolveAudioDir(home))).filter((name) => !name.startsWith('.'))
    assert.deepEqual(retainedBefore, [])

    const merged = await finalizeAudioParts({ meetingId, title: '自动录音测试', date: '2026-10-27', home })
    assert.equal(merged.parts, 2)
    assert.equal(merged.seconds, 2)
    assert.equal(merged.format, 'wav')
    assert.equal(merged.sha256, sha256Bytes(Buffer.from(concatWavPcm16([sliceA, sliceB]))))

    // Exactly one retained copy remains, and the temporary folder is gone.
    const retained = (await readdir(resolveAudioDir(home))).filter((name) => !name.startsWith('.'))
    assert.deepEqual(retained, [merged.fileName])
    await assert.rejects(stat(partsDir), /ENOENT/)

    // Finalising again has nothing to merge.
    await assert.rejects(finalizeAudioParts({ meetingId, title: 'x', date: '2026-10-27', home }), /没有待合并/)
  })
})

test('取消录音可清掉临时切片', async () => {
  await withHome(async (home) => {
    const meetingId = 'mt_live_cancel'
    await storeAudioPart({ meetingId, index: 1, bytes: sampleSlice(1), home })
    await clearAudioParts({ meetingId, home })
    await assert.rejects(readdir(resolveAudioPartsDir(meetingId, home)), /ENOENT/)
  })
})

test('单测不写入真实音频目录', () => {
  assertRealAudioUnchanged()
})

/**
 * Guard against unit tests polluting the real plugin data directory.
 *
 * A test once called `storeAudio` without isolating `$DSH_HOME`, which dropped a
 * 10-byte `fake-audio` fixture into the user's real
 * `meeting-minutes/audio/` folder. Capturing the real directory at module load
 * and asserting it at the end of the file makes that regression loud instead of
 * silent.
 *
 * Usage: import `assertRealAudioUnchanged` and call it in a final test (or at
 * the end of every test file that can reach the audio store).
 */

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The real data directory, captured before any test mutates `process.env`. */
const realHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const realAudioDir = join(realHome, 'meeting-minutes', 'audio')

/** Sorted listing of the real audio folder (empty when it does not exist). */
function snapshot() {
  try {
    return readdirSync(realAudioDir).sort()
  } catch {
    return []
  }
}

const before = snapshot()

/** Assert this test run added or removed no file in the real audio folder. */
export function assertRealAudioUnchanged() {
  assert.deepEqual(snapshot(), before, `单测写入了真实音频目录：${realAudioDir}`)
}

/** Absolute path of the real audio folder (diagnostics in failure messages). */
export function realAudioPath() {
  return realAudioDir
}

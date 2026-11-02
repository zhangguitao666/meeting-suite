/**
 * Loopback base resolution tests for the calendar bridge.
 *
 * Regression guard: the host service exposes the OS-assigned listening port as
 * `webServer.port` but has no `getOrigin()`; preferring the hard-coded 50505
 * made every todo→calendar write fail with `fetch failed` on a random-port host.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loopbackBase, taskFromTodo } from '../lib/calendar.js'

test('loopbackBase prefers the host listening port', () => {
  assert.equal(loopbackBase({ webServer: { port: 52353 } }), 'http://127.0.0.1:52353')
})

test('loopbackBase ignores a non-numeric or zero port', () => {
  assert.equal(loopbackBase({ webServer: { port: 0, getOrigin: () => 'http://127.0.0.1:61234' } }), 'http://127.0.0.1:61234')
  assert.equal(loopbackBase({ webServer: { port: 'abc' } }), 'http://127.0.0.1:50505')
})

test('loopbackBase falls back to the origin when the port is absent', () => {
  assert.equal(loopbackBase({ webServer: { getOrigin: () => 'http://localhost:4567' } }), 'http://127.0.0.1:4567')
  assert.equal(loopbackBase({ webServer: { getOrigin: () => 'https://127.0.0.1' } }), 'http://127.0.0.1:443')
})

test('loopbackBase survives a missing context and a throwing origin', () => {
  assert.equal(loopbackBase(undefined), 'http://127.0.0.1:50505')
  assert.equal(loopbackBase({ webServer: { getOrigin: () => { throw new Error('boom') } } }), 'http://127.0.0.1:50505')
  assert.equal(loopbackBase({ webServer: { getOrigin: () => 'not a url' } }), 'http://127.0.0.1:50505')
})

test('taskFromTodo keeps owner/due/source and tags meeting minutes', () => {
  const meeting = { id: 'mt_demo', title: '演示会', date: '2026-10-28' }
  const todo = { title: '整理演示文档', priority: 'high', owner: '邱栋梁', due: '2026-10-30', notes: '' }
  const task = taskFromTodo(meeting, todo)
  assert.equal(task.title, '整理演示文档')
  assert.equal(task.priority, 'high')
  assert.equal(task.owner, '邱栋梁')
  assert.equal(task.due, '2026-10-30')
  assert.deepEqual(task.tags, ['会议纪要'])
  assert.deepEqual(task.source, { kind: 'minutes', title: '演示会', date: '2026-10-28', ref: 'mt_demo' })
  assert.equal('due' in taskFromTodo(meeting, { ...todo, due: '' }), false)
})

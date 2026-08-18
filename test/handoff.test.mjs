import assert from 'node:assert/strict'
import test from 'node:test'
import { isStaleRecord, nextGeneration, taskKeyOf, trimHandoff } from '../delegate-handoff.mjs'

test('task keys and generations', () => {
  assert.equal(taskKeyOf('Review PR', 'research'), 'review pr#research')
  assert.equal(taskKeyOf('  ', null, 'session-abc'), 'session-abc')
  assert.equal(taskKeyOf('  '), 'task')
  assert.equal(nextGeneration(undefined), 1)
  assert.equal(nextGeneration(2), 3)
})

test('stale when generation or child id moved on', () => {
  const rec = { sessionId: 'a', generation: 1 }
  assert.equal(isStaleRecord(rec, { sessionId: 'a', generation: 1 }), false)
  assert.equal(isStaleRecord(rec, { sessionId: 'b', generation: 2 }), true)
  assert.equal(isStaleRecord(rec, null), false)
})

test('handoff is byte-capped', () => {
  const long = 'h'.repeat(50)
  const cut = trimHandoff(long, 16)
  assert.equal(cut.truncated, true)
  assert.ok(cut.text.endsWith('[truncated]'))
  assert.ok(Buffer.byteLength(cut.text, 'utf8') <= 16)
  assert.deepEqual(trimHandoff('ok', 16), { text: 'ok', truncated: false })
})

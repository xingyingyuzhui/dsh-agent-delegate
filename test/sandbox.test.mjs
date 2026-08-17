import assert from 'node:assert/strict'
import test from 'node:test'
import { probeEnforcement } from '../delegate-sandbox.mjs'

test('probe reports full / partial / unknown / unavailable', () => {
  assert.deepEqual(probeEnforcement(null, '/tmp'), { kind: 'unknown' })
  assert.deepEqual(
    probeEnforcement({ confine() { return { enforcement: 'full' } } }, '/tmp'),
    { kind: 'ok', enforcement: 'full' },
  )
  assert.deepEqual(
    probeEnforcement({ confine() { return { enforcement: 'partial' } } }, '/tmp'),
    { kind: 'ok', enforcement: 'partial' },
  )
  assert.deepEqual(
    probeEnforcement({ confine() { throw new Error('no backend') } }, '/tmp'),
    { kind: 'unavailable' },
  )
})

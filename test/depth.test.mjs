import assert from 'node:assert/strict'
import test from 'node:test'
import {
  asNonNegInt,
  childDepthOf,
  clampStartMaxDepth,
  depthAllowed,
  depthDenyReason,
  isSubagentTool,
  parentDepthOf,
} from '../delegate-depth.mjs'

test('parent depth reads header floor and cannot go below it', () => {
  assert.equal(parentDepthOf(null), 0)
  assert.equal(parentDepthOf({ session: { header: {} } }), 0)
  assert.equal(parentDepthOf({ session: { header: { delegationDepth: 2 } }, options: {} }), 2)
  assert.equal(parentDepthOf({
    session: { header: { delegationDepth: 2 } },
    options: { subagentDepth: 1 },
  }), 2)
  assert.equal(parentDepthOf({
    session: { header: { delegationDepth: 1 } },
    options: { subagentDepth: 3 },
  }), 3)
})

test('depth cap is parent + 1 against maxDepth, not just 0 vs >0', () => {
  assert.equal(childDepthOf(0), 1)
  assert.equal(childDepthOf(1), 2)
  assert.equal(depthAllowed(0, 0), false)
  assert.equal(depthAllowed(0, 1), true)
  assert.equal(depthAllowed(1, 1), false)
  assert.equal(depthAllowed(1, 2), true)
  assert.equal(depthDenyReason(0, 1), undefined)
  assert.match(depthDenyReason(1, 1), /depth 2 exceeds maxDepth 1/)
})

test('start request maxDepth is clamped to the parent policy', () => {
  assert.equal(clampStartMaxDepth(3, 1), 1)
  assert.equal(clampStartMaxDepth(undefined, 1), 1)
  assert.equal(clampStartMaxDepth('provider-managed', 1), 1)
  assert.equal(clampStartMaxDepth(0, 8), 0)
  assert.equal(asNonNegInt(-2, 4), 4)
})

test('subagent tool names', () => {
  assert.equal(isSubagentTool('subagent'), true)
  assert.equal(isSubagentTool('tool-subagent'), true)
  assert.equal(isSubagentTool('delegate'), true)
  assert.equal(isSubagentTool('read'), false)
})

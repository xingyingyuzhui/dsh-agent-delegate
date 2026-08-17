import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetDenyReason, budgetOf, DEFAULT_MAX_CHILDREN, DEFAULT_MAX_OUTPUT_BYTES } from '../delegate-budget.mjs'

test('budget defaults and explicit caps', () => {
  assert.deepEqual(budgetOf(null), { maxChildren: DEFAULT_MAX_CHILDREN, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES })
  assert.equal(budgetOf({ delegation: { maxChildren: 2, maxOutputBytes: 1024 } }).maxChildren, 2)
  assert.equal(budgetOf({ delegation: { maxChildren: 2, maxOutputBytes: 1024 } }).maxOutputBytes, 1024)
  assert.equal(budgetOf({ delegation: {} }, { maxChildren: 1 }).maxChildren, 1)
})

test('budget deny is liveCount >= maxChildren', () => {
  assert.equal(budgetDenyReason(3, 4), undefined)
  assert.match(budgetDenyReason(4, 4), /4\/4/)
  assert.match(budgetDenyReason(5, 1), /budget exceeded/)
})

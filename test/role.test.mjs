import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPreset } from '../../dsh-session-permissions/perm-schema.mjs'
import { attenuateChildPolicy } from '../delegate-policy.mjs'
import {
  allowedRolesOf,
  childRolesOf,
  parseRequestedRole,
  roleDenyReason,
  rolePolicyOf,
} from '../delegate-role.mjs'

test('developer may send research/reviewer; empty-role presets may not name a role', () => {
  assert.deepEqual(allowedRolesOf(applyPreset('developer')), ['research', 'reviewer'])
  assert.deepEqual(allowedRolesOf(applyPreset('research')), [])
  assert.deepEqual(allowedRolesOf(applyPreset('developer'), []), [])
  assert.equal(roleDenyReason(applyPreset('developer'), 'research'), undefined)
  assert.match(roleDenyReason(applyPreset('developer'), 'release'), /allowlist/)
  assert.match(roleDenyReason(applyPreset('research'), 'developer'), /allowlist/)
  assert.deepEqual(childRolesOf(applyPreset('developer'), 'research'), [])
})

test('role is parsed from args, [role] label, or prompt prefix', () => {
  assert.equal(parseRequestedRole({ role: 'research' }), 'research')
  assert.equal(parseRequestedRole({ description: '[reviewer] check diff' }), 'reviewer')
  assert.equal(parseRequestedRole({ prompt: 'role: public\nlook around' }), 'public')
  assert.equal(parseRequestedRole({ description: 'implement feature' }), null)
})

test('named research child is parent ∩ research and does not write', () => {
  const child = attenuateChildPolicy(applyPreset('developer'), rolePolicyOf('research'))
  assert.equal(child.files.write, 'none')
  assert.equal(child.preset, 'developer')
})

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyPreset } from '../../dsh-session-permissions/perm-schema.mjs'
import { apply, inject, name, _internal } from '../host.js'
import { loadChildSync, saveChildSync } from '../delegate-store.mjs'

test('named exports and inject', () => {
  assert.equal(name, 'dsh-agent-delegate')
  assert.deepEqual(inject, ['tools', 'subagents', 'agents'])
})

function mockCtx(overrides = {}) {
  const starts = []
  const creates = []
  const guards = []
  const events = {}
  const disposers = []
  const ctx = {
    subagents: {
      async start(provider, request) {
        starts.push({ provider, request })
        return { id: 'run-1' }
      },
      async startContinuable(spec) {
        starts.push({ continuable: true, spec })
        return { childId: 'child-1' }
      },
    },
    agents: {
      async create(options) {
        creates.push(options)
        return { id: options.sessionId }
      },
      get() { return null },
    },
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    on(event, fn) {
      events[event] = fn
      return () => {}
    },
    effect(factory) {
      disposers.push(factory())
    },
    get() { return undefined },
    ...overrides,
  }
  return { ctx, starts, creates, guards, events, disposers }
}

function parentAgent(depth = 0, id = 'session-parent-aaaaaa', policyPreset = 'developer') {
  return {
    options: { subagentDepth: depth },
    session: {
      id,
      header: { cwd: process.cwd(), delegationDepth: depth, agentPreset: policyPreset },
      events: [],
    },
  }
}

test('apply wraps start / create, registers guard and events, and restores on dispose', () => {
  const { ctx, guards, events, disposers } = mockCtx()
  const origStart = ctx.subagents.start
  const origCreate = ctx.agents.create
  apply(ctx)
  assert.equal(guards.length, 1)
  assert.ok(events['tools/pre-execute'])
  assert.ok(events['subagent/end'])
  assert.notEqual(ctx.subagents.start, origStart)
  assert.notEqual(ctx.agents.create, origCreate)
  for (const stop of disposers) if (typeof stop === 'function') stop()
  assert.equal(ctx.subagents.start, origStart)
  assert.equal(ctx.agents.create, origCreate)
})

test('start clamps official tool maxDepth 3 down to policy maxDepth 1 and rejects depth 2', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, starts } = mockCtx()
  apply(ctx)
  const parent = parentAgent(0, 'session-parent-aaaaaa')
  saveChildSync(home, { sessionId: parent.session.id, policy: applyPreset('developer') })
  await ctx.subagents.start('spawn', { parent, maxDepth: 3, prompt: [] })
  assert.equal(starts[0].request.maxDepth, 1)

  const child = parentAgent(1, 'session-child-bbbbbb')
  saveChildSync(home, { sessionId: child.session.id, policy: applyPreset('developer') })
  await assert.rejects(
    () => ctx.subagents.start('spawn', { parent: child, maxDepth: 3, prompt: [] }),
    /depth 2 exceeds maxDepth 1/,
  )
})

test('write child create pins a worktree cwd and persists attenuated policy', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-delegate-repo-'))
  execFileSync('git', ['init'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  await writeFile(join(repo, 'README'), 'root\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })

  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const { ctx, creates } = mockCtx({
    agents: {
      get() {
        return {
          session: {
            id: 'session-parent-bbbbbb',
            header: { cwd: repo, agentPreset: 'developer' },
            events: [],
          },
        }
      },
      async create(options) {
        creates.push(options)
        return { id: options.sessionId }
      },
    },
  })
  apply(ctx)
  const childId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  await ctx.agents.create({
    sessionId: childId,
    meta: { origin: 'subagent', parentSession: 'session-parent-bbbbbb', cwd: repo, delegationDepth: 1 },
  })
  assert.equal(creates.length, 1)
  assert.notEqual(creates[0].meta.cwd, repo)
  assert.match(creates[0].meta.cwd, /agent-delegate\/worktrees/)
  const record = loadChildSync(home, childId)
  assert.ok(record)
  assert.equal(record.policy.files.write, 'workspace')
  assert.equal(record.worktree, creates[0].meta.cwd)
})

test('pre-execute denies a grandchild subagent and a partial file read for research', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-host-'))
  _internal.setDshHome(home)
  const sandbox = { confine() { return { enforcement: 'partial' } } }
  const { ctx, events } = mockCtx({ get: () => sandbox })
  apply(ctx)
  const child = {
    options: { subagentDepth: 1 },
    session: {
      id: 'session-child-cccccc',
      header: { cwd: process.cwd(), delegationDepth: 1, agentPreset: 'research' },
      events: [],
    },
  }
  saveChildSync(home, { sessionId: child.session.id, policy: applyPreset('research') })
  const pre = events['tools/pre-execute']
  const depth = pre({ agent: child, name: 'subagent', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(depth.kind, 'deny')
  assert.match(depth.reason, /depth 2/)

  const file = pre({ agent: child, name: 'read', arguments: { path: 'README' } }, () => ({ kind: 'allow' }))
  assert.equal(file.kind, 'deny')
  assert.match(file.reason, /partial/)
})

test('main session create is not given a worktree', async () => {
  const { ctx, creates } = mockCtx()
  apply(ctx)
  await ctx.agents.create({
    sessionId: 'session-main-dddddd',
    meta: { cwd: process.cwd() },
  })
  assert.equal(creates[0].meta.cwd, process.cwd())
})

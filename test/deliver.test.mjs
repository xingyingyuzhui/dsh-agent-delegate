import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyHandoffToParent, loadHandoff, persistChildHandoff, rejectHandoff } from '../delegate-deliver.mjs'
import { collectWorktreePatch, createWriteWorktree, formatHandoffNote, removeWriteWorktree } from '../delegate-worktree.mjs'

async function tempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-delegate-repo-'))
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  await writeFile(join(dir, 'README'), 'root\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
  return dir
}

test('accept applies a clean child patch to the parent', async () => {
  const repo = await tempRepo()
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  const childId = 'child-accept-01'
  const created = createWriteWorktree({ home, sessionId: childId, parentCwd: repo })
  await writeFile(join(created.path, 'child.txt'), 'from-child\n')
  const collected = collectWorktreePatch({
    home,
    sessionId: childId,
    worktree: created.path,
    baseCommit: created.baseCommit,
  })
  persistChildHandoff(home, {
    sessionId: childId,
    parentSession: 'session-parent-aaaaaa',
    parentRoot: created.parentRoot,
    parentHead: created.parentHead,
  }, { ...collected, parentRoot: created.parentRoot })
  removeWriteWorktree({ home, sessionId: childId, parentCwd: repo })
  const result = applyHandoffToParent(home, childId)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'applied')
  assert.equal(await readFile(join(repo, 'child.txt'), 'utf8'), 'from-child\n')
  const again = applyHandoffToParent(home, childId)
  assert.equal(again.status, 'applied')
})

test('accept stays conflicted when the parent changed the same file', async () => {
  const repo = await tempRepo()
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  const childId = 'child-conflict-01'
  const created = createWriteWorktree({ home, sessionId: childId, parentCwd: repo })
  await writeFile(join(created.path, 'README'), 'from-child\n')
  const collected = collectWorktreePatch({
    home,
    sessionId: childId,
    worktree: created.path,
    baseCommit: created.baseCommit,
  })
  persistChildHandoff(home, {
    sessionId: childId,
    parentSession: 'session-parent-bbbbbb',
    parentRoot: created.parentRoot,
    parentHead: created.parentHead,
  }, { ...collected, parentRoot: created.parentRoot })
  removeWriteWorktree({ home, sessionId: childId, parentCwd: repo })
  await writeFile(join(repo, 'README'), 'from-parent-later\n')
  const result = applyHandoffToParent(home, childId)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'conflicted')
  assert.equal(await readFile(join(repo, 'README'), 'utf8'), 'from-parent-later\n')
  assert.equal(loadHandoff(home, childId).status, 'conflicted')
})

test('reject leaves the parent clean and blocks later accept', async () => {
  const repo = await tempRepo()
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  const childId = 'child-reject-01'
  const created = createWriteWorktree({ home, sessionId: childId, parentCwd: repo })
  await writeFile(join(created.path, 'child.txt'), 'nope\n')
  const collected = collectWorktreePatch({
    home,
    sessionId: childId,
    worktree: created.path,
    baseCommit: created.baseCommit,
  })
  persistChildHandoff(home, {
    sessionId: childId,
    parentSession: 'session-parent-cccccc',
    parentRoot: created.parentRoot,
  }, { ...collected, parentRoot: created.parentRoot })
  removeWriteWorktree({ home, sessionId: childId, parentCwd: repo })
  const rejected = rejectHandoff(home, childId)
  assert.equal(rejected.ok, true)
  assert.equal(rejected.status, 'rejected')
  const result = applyHandoffToParent(home, childId)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'rejected')
  await assert.rejects(() => readFile(join(repo, 'child.txt'), 'utf8'))
})

test('handoff note asks the parent to accept, not to git apply', () => {
  const note = formatHandoffNote({
    empty: false,
    path: '/tmp/x.patch',
    files: ['child.txt'],
    bytes: 12,
    childSessionId: 'child-note-01',
  }, 'child-note-01')
  assert.match(note, /delegate_handoff/)
  assert.match(note, /action=accept/)
  assert.match(note, /Do not git apply unless/)
})

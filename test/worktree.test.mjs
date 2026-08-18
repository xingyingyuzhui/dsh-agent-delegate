import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectWorktreePatch, createWriteWorktree, gitRootOf, removeWriteWorktree, worktreePath } from '../delegate-worktree.mjs'

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

test('gitRootOf returns the repo and null outside git', async () => {
  const repo = await tempRepo()
  assert.equal(realpathSync(gitRootOf(repo)), realpathSync(repo))
  const loose = await mkdtemp(join(tmpdir(), 'dsh-delegate-loose-'))
  assert.equal(gitRootOf(loose), null)
})

test('write child gets an isolated worktree; parent tree stays clean', async () => {
  const repo = await tempRepo()
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  const sessionId = 'child-wt-1'
  const created = createWriteWorktree({ home, sessionId, parentCwd: repo })
  const path = created.path
  assert.equal(path, worktreePath(home, sessionId))
  assert.ok(created.parentHead)
  assert.ok(created.baseCommit)
  await writeFile(join(path, 'child.txt'), 'only-child\n')
  await assert.rejects(() => readFile(join(repo, 'child.txt'), 'utf8'))
  assert.equal(await readFile(join(path, 'README'), 'utf8'), 'root\n')
  assert.equal(removeWriteWorktree({ home, sessionId, parentCwd: repo }), true)
})

test('write child sees parent dirty and untracked files', async () => {
  const repo = await tempRepo()
  await writeFile(join(repo, 'README'), 'dirty parent\n')
  await writeFile(join(repo, 'new-parent.txt'), 'untracked\n')
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  const created = createWriteWorktree({ home, sessionId: 'child-wt-dirty', parentCwd: repo })
  assert.equal(await readFile(join(created.path, 'README'), 'utf8'), 'dirty parent\n')
  assert.equal(await readFile(join(created.path, 'new-parent.txt'), 'utf8'), 'untracked\n')
  assert.equal(await readFile(join(repo, 'README'), 'utf8'), 'dirty parent\n')
  assert.equal(removeWriteWorktree({ home, sessionId: 'child-wt-dirty', parentCwd: repo }), true)
})

test('child edits are captured as a patch and not applied to the parent', async () => {
  const repo = await tempRepo()
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  const created = createWriteWorktree({ home, sessionId: 'child-wt-patch', parentCwd: repo })
  await writeFile(join(created.path, 'child.txt'), 'from-child\n')
  const handoff = collectWorktreePatch({
    home,
    sessionId: 'child-wt-patch',
    worktree: created.path,
    baseCommit: created.baseCommit,
  })
  assert.equal(handoff.empty, false)
  assert.ok(handoff.files.includes('child.txt'))
  const patch = await readFile(handoff.path, 'utf8')
  assert.match(patch, /from-child/)
  await assert.rejects(() => readFile(join(repo, 'child.txt'), 'utf8'))
  assert.equal(removeWriteWorktree({ home, sessionId: 'child-wt-patch', parentCwd: repo }), true)
})

test('write child without a git workspace fails loud', async () => {
  const loose = await mkdtemp(join(tmpdir(), 'dsh-delegate-nogit-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  assert.throws(
    () => createWriteWorktree({ home, sessionId: 'child-wt-2', parentCwd: loose }),
    /git workspace/,
  )
})

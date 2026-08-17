import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWriteWorktree, gitRootOf, removeWriteWorktree, worktreePath } from '../delegate-worktree.mjs'

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
  const path = createWriteWorktree({ home, sessionId, parentCwd: repo })
  assert.equal(path, worktreePath(home, sessionId))
  await writeFile(join(path, 'child.txt'), 'only-child\n')
  await assert.rejects(() => readFile(join(repo, 'child.txt'), 'utf8'))
  assert.equal(await readFile(join(path, 'README'), 'utf8'), 'root\n')
  assert.equal(removeWriteWorktree({ home, sessionId, parentCwd: repo }), true)
})

test('write child without a git workspace fails loud', async () => {
  const loose = await mkdtemp(join(tmpdir(), 'dsh-delegate-nogit-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-delegate-home-'))
  assert.throws(
    () => createWriteWorktree({ home, sessionId: 'child-wt-2', parentCwd: loose }),
    /git workspace/,
  )
})

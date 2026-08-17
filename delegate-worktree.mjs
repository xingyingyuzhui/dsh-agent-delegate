import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export function worktreePath(home, sessionId) {
  return join(home, 'agent-delegate', 'worktrees', String(sessionId))
}

function runGit(args, cwd, runner) {
  const run = runner || ((nextArgs, nextCwd) => spawnSync('git', nextArgs, {
    cwd: nextCwd,
    encoding: 'utf8',
    timeout: 30000,
  }))
  return run(args, cwd)
}

export function gitRootOf(cwd, runner) {
  if (!cwd) return null
  const result = runGit(['rev-parse', '--show-toplevel'], cwd, runner)
  if (!result || result.status !== 0) return null
  const root = String(result.stdout || '').trim()
  return root || null
}

export function createWriteWorktree({ home, sessionId, parentCwd, runner }) {
  const root = gitRootOf(parentCwd, runner)
  if (!root) {
    const err = new Error('Denied: write child requires a git workspace to allocate a task worktree.')
    err.code = 'DSH_DELEGATE_NO_GIT'
    throw err
  }
  const path = worktreePath(home, sessionId)
  mkdirSync(dirname(path), { recursive: true })
  const result = runGit(['worktree', 'add', '--detach', path, 'HEAD'], root, runner)
  if (!result || result.status !== 0) {
    const detail = String((result && (result.stderr || result.stdout)) || 'git worktree add failed').trim()
    const err = new Error('Denied: could not create child worktree. ' + detail)
    err.code = 'DSH_DELEGATE_WORKTREE'
    throw err
  }
  return path
}

export function removeWriteWorktree({ home, sessionId, parentCwd, runner }) {
  const path = worktreePath(home, sessionId)
  const root = gitRootOf(parentCwd, runner) || gitRootOf(path, runner)
  if (root) {
    const result = runGit(['worktree', 'remove', '--force', path], root, runner)
    if (result && result.status === 0) return true
  }
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

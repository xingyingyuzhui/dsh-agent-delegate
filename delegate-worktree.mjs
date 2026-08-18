import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export function worktreePath(home, sessionId) {
  return join(home, 'agent-delegate', 'worktrees', String(sessionId))
}

export function handoffPath(home, sessionId) {
  return join(home, 'agent-delegate', 'handoffs', String(sessionId) + '.patch')
}

function runGit(args, cwd, runner, opts) {
  const run = runner || ((nextArgs, nextCwd, nextOpts) => spawnSync('git', nextArgs, {
    cwd: nextCwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    input: nextOpts && nextOpts.input,
  }))
  return run(args, cwd, opts)
}

export function gitRootOf(cwd, runner) {
  if (!cwd) return null
  const result = runGit(['rev-parse', '--show-toplevel'], cwd, runner)
  if (!result || result.status !== 0) return null
  const root = String(result.stdout || '').trim()
  return root || null
}

export function parentHeadOf(root, runner) {
  const result = runGit(['rev-parse', 'HEAD'], root, runner)
  if (!result || result.status !== 0) return ''
  return String(result.stdout || '').trim()
}

export function parseDiffFiles(patch) {
  const names = []
  const text = String(patch || '')
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm
  let match
  while ((match = re.exec(text))) {
    const name = match[2] || match[1]
    if (name && names.indexOf(name) < 0) names.push(name)
  }
  return names
}

function copyUntracked(root, worktree, runner) {
  const listed = runGit(['ls-files', '--others', '--exclude-standard', '-z'], root, runner)
  if (!listed || listed.status !== 0) return 0
  const names = String(listed.stdout || '').split('\0').filter(Boolean)
  let copied = 0
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    try {
      const dest = join(worktree, name)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(join(root, name), dest)
      copied += 1
    } catch { /* skip unreadable */ }
  }
  return copied
}

function seedParentDirty(root, worktree, runner) {
  const parentHead = parentHeadOf(root, runner)
  const diff = runGit(['diff', '--binary', 'HEAD'], root, runner)
  const patch = diff && diff.status === 0 ? String(diff.stdout || '') : ''
  if (patch.trim()) {
    runGit(['apply', '--whitespace=nowarn'], worktree, runner, { input: patch })
  }
  copyUntracked(root, worktree, runner)
  runGit(['add', '-A'], worktree, runner)
  runGit([
    '-c', 'user.email=delegate@local',
    '-c', 'user.name=dsh-delegate',
    '-c', 'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'dsh-delegate: seed parent workspace',
  ], worktree, runner)
  return {
    parentHead,
    baseCommit: parentHeadOf(worktree, runner) || parentHead,
  }
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
  let parentHead = parentHeadOf(root, runner)
  let baseCommit = parentHead
  try {
    const seeded = seedParentDirty(root, path, runner)
    parentHead = seeded.parentHead || parentHead
    baseCommit = seeded.baseCommit || baseCommit
  } catch { /* child can still work from HEAD */ }
  return { path, parentRoot: root, parentHead, baseCommit }
}

export function collectWorktreePatch({ home, sessionId, worktree, baseCommit, runner }) {
  if (!worktree || !sessionId) return null
  const base = baseCommit || 'HEAD'
  runGit(['add', '-A'], worktree, runner)
  const diff = runGit(['diff', '--binary', base], worktree, runner)
  const patch = diff && diff.status === 0 ? String(diff.stdout || '') : ''
  const file = handoffPath(home, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, patch)
  const files = parseDiffFiles(patch)
  return {
    path: file,
    bytes: Buffer.byteLength(patch, 'utf8'),
    files,
    empty: !patch.trim(),
  }
}

export function formatHandoffNote(info) {
  if (!info || info.empty) return ''
  const files = Array.isArray(info.files) ? info.files : []
  const shown = files.slice(0, 20)
  const extra = files.length > shown.length ? '\n- … +' + (files.length - shown.length) + ' more' : ''
  const apply = info.parentRoot
    ? 'git -C ' + info.parentRoot + ' apply ' + info.path
    : 'git apply ' + info.path
  return [
    'Child wrote files in an isolated worktree. They are not in the parent workspace until you apply them.',
    '',
    apply,
    '',
    'Files (' + files.length + ', ' + info.bytes + ' bytes):',
    ...shown.map((name) => '- ' + name),
  ].join('\n') + extra
}

export function deliverChildHandoff({ home, sessionId, worktree, baseCommit, parentRoot, runner }) {
  const collected = collectWorktreePatch({ home, sessionId, worktree, baseCommit, runner })
  if (!collected) return null
  return { ...collected, parentRoot: parentRoot || '' }
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

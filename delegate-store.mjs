import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { normalizePolicy } from '../dsh-session-permissions/perm-schema.mjs'

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function childFile(home, sessionId) {
  return join(home || defaultDshHome(), 'agent-delegate', 'children', String(sessionId) + '.json')
}

export function auditFile(home) {
  return join(home || defaultDshHome(), 'agent-delegate', 'audit.jsonl')
}

function safeId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length >= 6 && !sessionId.includes('/') && !sessionId.includes('\\')
}

export function emptyChild(sessionId, now = new Date().toISOString()) {
  return {
    version: 1,
    sessionId,
    parentSession: null,
    policy: null,
    worktree: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeChild(raw, sessionId) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const now = new Date().toISOString()
  const policyRaw = value.policy && typeof value.policy === 'object' ? value.policy : null
  return {
    version: 1,
    sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : sessionId,
    parentSession: typeof value.parentSession === 'string' ? value.parentSession : null,
    policy: policyRaw ? normalizePolicy(policyRaw) : null,
    worktree: typeof value.worktree === 'string' && value.worktree ? value.worktree : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  }
}

export function loadChildSync(home, sessionId) {
  if (!safeId(sessionId)) return null
  try {
    return normalizeChild(JSON.parse(readFileSync(childFile(home, sessionId), 'utf8')), sessionId)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export function saveChildSync(home, record, now = new Date().toISOString()) {
  if (!record || !safeId(record.sessionId)) throw new Error('invalid child session id')
  const next = {
    ...normalizeChild(record, record.sessionId),
    updatedAt: now,
    createdAt: record.createdAt || now,
  }
  const file = childFile(home, next.sessionId)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file)
  return next
}

export function removeChildSync(home, sessionId) {
  if (!safeId(sessionId)) return
  try {
    unlinkSync(childFile(home, sessionId))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

export function appendAudit(home, row) {
  try {
    const file = auditFile(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...row, at: new Date().toISOString() }) + '\n', { flag: 'a' })
  } catch { /* best-effort */ }
}

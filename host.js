import { resolveLayersSync } from '../dsh-session-permissions/perm-layers.mjs'
import { classifyTool } from '../dsh-session-permissions/perm-schema.mjs'
import { allowExecution } from '../dsh-session-permissions/perm-path.mjs'
import {
  clampStartMaxDepth,
  depthDenyReason,
  isSubagentTool,
  parentDepthOf,
} from './delegate-depth.mjs'
import { attenuateChildPolicy, childNeedsWorktree, denyPartialFileAction } from './delegate-policy.mjs'
import { probeEnforcement } from './delegate-sandbox.mjs'
import {
  appendAudit,
  defaultDshHome,
  loadChildSync,
  removeChildSync,
  saveChildSync,
} from './delegate-store.mjs'
import { createWriteWorktree, removeWriteWorktree } from './delegate-worktree.mjs'

export const name = 'dsh-agent-delegate'
export const inject = ['tools', 'subagents', 'agents']

let dshHome = defaultDshHome()
let cachedProbe

const _internal = {
  setDshHome(dir) {
    dshHome = dir
    cachedProbe = undefined
  },
  getDshHome() { return dshHome },
  resetProbe() { cachedProbe = undefined },
}
export { _internal }

function wrapMethod(obj, key, wrapper) {
  if (!obj || typeof obj[key] !== 'function') return function () {}
  const orig = obj[key]
  obj[key] = function wrapped(...args) {
    return wrapper.call(this, orig, ...args)
  }
  return function () {
    if (obj[key] !== orig) obj[key] = orig
  }
}

function headerOf(agentOrSession) {
  if (!agentOrSession) return {}
  if (agentOrSession.header) return agentOrSession.header
  const session = agentOrSession.session
  return (session && session.header) || {}
}

function layersOf(agentOrSession) {
  const session = agentOrSession && agentOrSession.session ? agentOrSession.session : agentOrSession
  if (!session || !session.id) return null
  const header = session.header || {}
  return resolveLayersSync(dshHome, {
    sessionId: session.id,
    cwd: header.cwd,
    preset: header.agentPreset,
    events: session.events,
  })
}

function policyOf(agentOrSession) {
  const session = agentOrSession && agentOrSession.session ? agentOrSession.session : agentOrSession
  const id = session && session.id
  const record = id ? loadChildSync(dshHome, id) : null
  if (record && record.policy) return record.policy
  const layers = layersOf(agentOrSession)
  return layers && layers.effective
}

function parentLayersOf(ctx, parentSession, cwd) {
  if (parentSession && ctx.agents && typeof ctx.agents.get === 'function') {
    const agent = ctx.agents.get(parentSession)
    if (agent) return layersOf(agent)
  }
  if (parentSession && ctx.sessions && typeof ctx.sessions.get === 'function') {
    const session = ctx.sessions.get(parentSession)
    if (session) return layersOf(session)
  }
  return resolveLayersSync(dshHome, { sessionId: parentSession, cwd })
}

function enforcementOf(ctx, cwd) {
  if (cachedProbe) return cachedProbe
  const sandbox = ctx && typeof ctx.get === 'function' ? ctx.get('sandbox') : ctx && ctx.sandbox
  cachedProbe = probeEnforcement(sandbox, cwd)
  return cachedProbe
}

function clampRequest(request) {
  if (!request || !request.parent) return request
  const policy = policyOf(request.parent)
  const maxDepth = clampStartMaxDepth(request.maxDepth, policy && policy.delegation && policy.delegation.maxDepth)
  const reason = depthDenyReason(parentDepthOf(request.parent), maxDepth)
  if (reason) {
    const err = new Error(reason)
    err.name = 'SubagentDepthError'
    throw err
  }
  return { ...request, maxDepth }
}

function prepareChildCreate(ctx, options) {
  const meta = options && options.meta
  if (!meta || meta.origin !== 'subagent' || !options.sessionId) return options
  const parentLayers = parentLayersOf(ctx, meta.parentSession, meta.cwd)
  const policy = attenuateChildPolicy(parentLayers && parentLayers.effective)
  const record = {
    sessionId: options.sessionId,
    parentSession: meta.parentSession || null,
    policy,
    worktree: null,
  }
  saveChildSync(dshHome, record)
  appendAudit(dshHome, {
    kind: 'create',
    sessionId: options.sessionId,
    parentSession: meta.parentSession,
    write: policy && policy.files && policy.files.write,
    maxDepth: policy && policy.delegation && policy.delegation.maxDepth,
  })
  if (!childNeedsWorktree(policy)) return options
  try {
    const path = createWriteWorktree({
      home: dshHome,
      sessionId: options.sessionId,
      parentCwd: meta.cwd,
    })
    saveChildSync(dshHome, { ...record, worktree: path })
    appendAudit(dshHome, { kind: 'worktree', sessionId: options.sessionId, worktree: path })
    return { ...options, meta: { ...meta, cwd: path } }
  } catch (error) {
    removeChildSync(dshHome, options.sessionId)
    throw error
  }
}

function denyExec(ctx, exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (!session || !session.id) return undefined
  const policy = policyOf(agent)
  if (!policy) return undefined
  const name = exec.name
  if (isSubagentTool(name)) {
    const reason = depthDenyReason(parentDepthOf(agent), policy.delegation && policy.delegation.maxDepth)
    if (reason) return reason
  }
  const cwd = headerOf(session).cwd
  const partial = denyPartialFileAction(policy, enforcementOf(ctx, cwd), name, exec.arguments)
  if (partial) return partial
  const record = loadChildSync(dshHome, session.id)
  if (record && record.policy && !allowExecution(policy, name, exec.arguments, cwd)) {
    return 'Denied by delegated child policy (' + classifyTool(name, exec.arguments) + ').'
  }
  return undefined
}

function cleanupChild(sessionId) {
  const record = loadChildSync(dshHome, sessionId)
  if (!record) return
  if (record.worktree) {
    removeWriteWorktree({
      home: dshHome,
      sessionId,
      parentCwd: record.worktree,
    })
  }
  removeChildSync(dshHome, sessionId)
  appendAudit(dshHome, { kind: 'end', sessionId, worktree: record.worktree })
}

export function apply(ctx) {
  const stopStart = wrapMethod(ctx.subagents, 'start', function (orig, provider, request) {
    return Promise.resolve().then(() => orig.call(this, provider, clampRequest(request)))
  })
  const stopContinuable = wrapMethod(ctx.subagents, 'startContinuable', function (orig, spec) {
    return Promise.resolve().then(() => {
      if (!spec || !spec.request) return orig.call(this, spec)
      return orig.call(this, { ...spec, request: clampRequest(spec.request) })
    })
  })
  const stopCreate = wrapMethod(ctx.agents, 'create', function (orig, options) {
    return Promise.resolve().then(() => orig.call(this, prepareChildCreate(ctx, options)))
  })

  const stopGuard = ctx.tools && typeof ctx.tools.guard === 'function'
    ? ctx.tools.guard((exec) => denyExec(ctx, exec))
    : function () {}

  const stopPre = typeof ctx.on === 'function'
    ? ctx.on('tools/pre-execute', (exec, next) => {
      const reason = denyExec(ctx, exec)
      if (reason) {
        appendAudit(dshHome, { kind: 'deny', tool: exec && exec.name, reason, sessionId: exec && exec.agent && exec.agent.session && exec.agent.session.id })
        return { kind: 'deny', reason }
      }
      return next()
    })
    : function () {}

  const stopEnd = typeof ctx.on === 'function'
    ? ctx.on('subagent/end', (info) => {
      if (info && info.id) cleanupChild(info.id)
    })
    : function () {}

  ctx.effect(() => () => {
    if (typeof stopStart === 'function') stopStart()
    if (typeof stopContinuable === 'function') stopContinuable()
    if (typeof stopCreate === 'function') stopCreate()
    if (typeof stopGuard === 'function') stopGuard()
    if (typeof stopPre === 'function') stopPre()
    if (typeof stopEnd === 'function') stopEnd()
  })
}

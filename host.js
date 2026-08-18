import { randomUUID } from 'node:crypto'
import { resolveLayersSync } from '../dsh-session-permissions/perm-layers.mjs'
import { renderDenyReceipt } from '../dsh-session-permissions/perm-official.mjs'
import { asArgs, classifyTool } from '../dsh-session-permissions/perm-schema.mjs'
import { allowExecution } from '../dsh-session-permissions/perm-path.mjs'
import { currentBag, runWithBag } from './delegate-context.mjs'
import {
  clampStartMaxDepth,
  depthDenyReason,
  isSubagentTool,
  parentDepthOf,
} from './delegate-depth.mjs'
import { budgetDenyReason, budgetOf } from './delegate-budget.mjs'
import {
  isStaleRecord,
  staleDenyReason,
  taskKeyOf,
  trimContentBlocks,
  trimHandoff,
} from './delegate-handoff.mjs'
import { attenuateChildPolicy, childNeedsWorktree, denyPartialFileAction } from './delegate-policy.mjs'
import {
  allowedRolesOf,
  childRolesOf,
  parseRequestedRole,
  roleDenyReason,
  rolePolicyOf,
} from './delegate-role.mjs'
import { probeEnforcement } from './delegate-sandbox.mjs'
import {
  appendAudit,
  bumpTask,
  defaultDshHome,
  latestTask,
  listLiveChildren,
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

function optionalService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const got = ctx.get(key)
      if (got != null) return got
    } catch { /* not injected */ }
  }
  if (ctx && Object.prototype.hasOwnProperty.call(ctx, key)) return ctx[key]
  return undefined
}

function wrapShell(ctx) {
  return wrapMethod(optionalService(ctx, 'shell'), 'resolve', function (orig, request) {
    const bag = currentBag()
    if (bag && bag.jobWorktree) {
      return orig.call(this, { ...request, workdir: bag.jobWorktree })
    }
    return orig.call(this, request)
  })
}

function wrapJobs(ctx) {
  const jobs = optionalService(ctx, 'jobs')
  const stopJobs = wrapMethod(jobs, 'start', function (orig, spec) {
    if (!spec || (spec.kind !== 'bash' && spec.kind !== 'subagent')) return orig.call(this, spec)
    const bag = currentBag()
    const reserved = bag && bag.jobId
    const owner = spec.owner
    const policy = policyOf(owner)
    const budget = budgetOf(policy, recordOf(owner))
    if (!reserved) {
      const reason = budgetDenyReason(liveCount(parentIdOf(owner)), budget.maxChildren)
      if (reason) {
        const err = new Error(reason)
        err.name = 'SubagentBudgetError'
        throw err
      }
    }
    const limit = spec.outputLimitBytes == null
      ? budget.maxOutputBytes
      : Math.min(spec.outputLimitBytes, budget.maxOutputBytes)
    const id = orig.call(this, { ...spec, outputLimitBytes: limit })
    if (reserved) {
      const record = loadChildSync(dshHome, reserved)
      if (record) saveChildSync(dshHome, { ...record, jobId: id })
    }
    return id
  })
  const stopJobDone = jobs && typeof jobs.onJobDone === 'function'
    ? jobs.onJobDone((snapshot) => {
      if (!snapshot || !snapshot.id || snapshot.status === 'running' || snapshot.status === 'stopping') return
      const rows = listLiveChildren(dshHome).filter((row) => row.kind === 'job' && row.jobId === snapshot.id)
      for (const row of rows) cleanupChild(row.sessionId)
    })
    : function () {}
  return function () {
    stopJobs()
    stopJobDone()
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

function recordOf(agentOrSession) {
  const session = agentOrSession && agentOrSession.session ? agentOrSession.session : agentOrSession
  const id = session && session.id
  return id ? loadChildSync(dshHome, id) : null
}

function policyOf(agentOrSession) {
  const record = recordOf(agentOrSession)
  if (record && record.policy) return record.policy
  const layers = layersOf(agentOrSession)
  return layers && layers.effective
}

function storedRolesOf(agentOrSession) {
  const record = recordOf(agentOrSession)
  return record ? record.roles : null
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

function liveCount(parentSession) {
  return listLiveChildren(dshHome, parentSession).length
}

function parentIdOf(agent) {
  const session = agent && agent.session
  return session && session.id
}

function isBackgroundWrite(name, args, policy) {
  if (classifyTool(name, args) !== 'bash') return false
  if (asArgs(args).run_in_background !== true) return false
  return childNeedsWorktree(policy)
}

function labelOf(args, request) {
  const value = asArgs(args)
  return (request && request.label) || value.description || value.command || ''
}

function clampRequest(request) {
  if (!request || !request.parent) return request
  const policy = policyOf(request.parent)
  const bag = currentBag()
  const role = (bag && bag.role) || parseRequestedRole(null, request)
  const roleReason = roleDenyReason(policy, role, storedRolesOf(request.parent))
  if (roleReason) {
    const err = new Error(roleReason)
    err.name = 'SubagentRoleError'
    throw err
  }
  const budget = budgetOf(policy, recordOf(request.parent))
  const budgetReason = budgetDenyReason(liveCount(parentIdOf(request.parent)), budget.maxChildren)
  if (budgetReason) {
    const err = new Error(budgetReason)
    err.name = 'SubagentBudgetError'
    throw err
  }
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
  const bag = currentBag()
  const parentLayers = parentLayersOf(ctx, meta.parentSession, meta.cwd)
  const parentPolicy = parentLayers && parentLayers.effective
  const parentRecord = meta.parentSession ? loadChildSync(dshHome, meta.parentSession) : null
  const role = bag && bag.role ? bag.role : null
  const roleReason = roleDenyReason(parentPolicy, role, parentRecord && parentRecord.roles)
  if (roleReason) {
    const err = new Error(roleReason)
    err.name = 'SubagentRoleError'
    throw err
  }
  const policy = attenuateChildPolicy(parentPolicy, role ? rolePolicyOf(role) : null)
  const roles = childRolesOf(parentPolicy, role, parentRecord && parentRecord.roles)
  const taskKey = (bag && bag.taskKey) || taskKeyOf(bag && bag.label, role)
  const bumped = bumpTask(dshHome, meta.parentSession, taskKey, options.sessionId)
  if (bag) bag.childId = options.sessionId
  const record = {
    sessionId: options.sessionId,
    parentSession: meta.parentSession || null,
    policy,
    worktree: null,
    role,
    roles,
    kind: 'subagent',
    taskKey,
    generation: bumped.generation,
  }
  saveChildSync(dshHome, record)
  appendAudit(dshHome, {
    kind: 'create',
    sessionId: options.sessionId,
    parentSession: meta.parentSession,
    role,
    taskKey,
    generation: bumped.generation,
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
  const args = exec.arguments
  if (isSubagentTool(name)) {
    const role = parseRequestedRole(args, null)
    const roleReason = roleDenyReason(policy, role, storedRolesOf(agent))
    if (roleReason) return roleReason
    const budget = budgetOf(policy, recordOf(agent))
    const budgetReason = budgetDenyReason(liveCount(session.id), budget.maxChildren)
    if (budgetReason) return budgetReason
    const depthReason = depthDenyReason(parentDepthOf(agent), policy.delegation && policy.delegation.maxDepth)
    if (depthReason) return depthReason
  }
  if (isBackgroundWrite(name, args, policy)) {
    const budget = budgetOf(policy, recordOf(agent))
    const budgetReason = budgetDenyReason(liveCount(session.id), budget.maxChildren)
    if (budgetReason) return budgetReason
  }
  const cwd = headerOf(session).cwd
  const partial = denyPartialFileAction(policy, enforcementOf(ctx, cwd), name, args)
  if (partial) return partial
  const record = loadChildSync(dshHome, session.id)
  if (record && record.policy && !allowExecution(policy, name, args, cwd)) {
    return renderDenyReceipt(classifyTool(name, args), 'Denied by delegated child policy.')
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
  appendAudit(dshHome, { kind: 'end', sessionId, worktree: record.worktree, role: record.role, taskKey: record.taskKey })
}

function prepareJobWorktree(exec) {
  const agent = exec && exec.agent
  const policy = policyOf(agent)
  if (!isBackgroundWrite(exec.name, exec.arguments, policy)) return null
  const parentSession = parentIdOf(agent)
  const jobId = 'job-' + randomUUID()
  const role = null
  const taskKey = taskKeyOf(labelOf(exec.arguments), role)
  const bumped = bumpTask(dshHome, parentSession, taskKey, jobId)
  const cwd = headerOf(agent && agent.session).cwd
  const path = createWriteWorktree({
    home: dshHome,
    sessionId: jobId,
    parentCwd: cwd,
  })
  saveChildSync(dshHome, {
    sessionId: jobId,
    parentSession,
    policy,
    worktree: path,
    role,
    roles: allowedRolesOf(policy, storedRolesOf(agent)),
    kind: 'job',
    taskKey,
    generation: bumped.generation,
  })
  appendAudit(dshHome, { kind: 'worktree', sessionId: jobId, parentSession, worktree: path, job: true })
  return { jobId, path }
}

function bagFromExec(exec) {
  if (!exec) return null
  if (isSubagentTool(exec.name)) {
    const role = parseRequestedRole(exec.arguments, null)
    return {
      role,
      label: labelOf(exec.arguments),
      taskKey: taskKeyOf(labelOf(exec.arguments), role),
      parentSession: parentIdOf(exec.agent),
    }
  }
  return null
}

function applyHandoffResult(result, childId, maxBytes) {
  if (!childId) return result
  const record = loadChildSync(dshHome, childId)
  if (!record) return result
  const latest = latestTask(dshHome, record.parentSession, record.taskKey)
  if (isStaleRecord(record, latest)) {
    return { kind: 'block', feedback: [{ type: 'text', text: staleDenyReason() }] }
  }
  if (!result || typeof result !== 'object') return result
  if (result.kind === 'block' || result.kind === 'deny') return result
  const value = result.value
  if (value && typeof value === 'object' && Array.isArray(value.output)) {
    return {
      kind: 'accept',
      value: { ...value, output: trimContentBlocks(value.output, maxBytes) },
    }
  }
  if (typeof result.content === 'string') {
    return { ...result, content: trimHandoff(result.content, maxBytes).text }
  }
  return result
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
  const optionalStops = []
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shell'], (sub) => {
      const stop = wrapShell(sub)
      sub.effect(() => () => stop())
    })
    ctx.inject(['jobs'], (sub) => {
      const stop = wrapJobs(sub)
      sub.effect(() => () => stop())
    })
  } else {
    optionalStops.push(wrapShell(ctx), wrapJobs(ctx))
  }

  const stopReport = wrapMethod(ctx.subagents, 'reportFrom', function (orig, child, content, options) {
    return Promise.resolve().then(() => {
      const session = child && child.session
      const record = session && session.id ? loadChildSync(dshHome, session.id) : null
      if (record) {
        const latest = latestTask(dshHome, record.parentSession, record.taskKey)
        if (isStaleRecord(record, latest)) {
          const err = new Error(staleDenyReason())
          err.name = 'SubagentStaleError'
          throw err
        }
        const budget = budgetOf(record.policy, record)
        return orig.call(this, child, trimContentBlocks(content, budget.maxOutputBytes), options)
      }
      return orig.call(this, child, content, options)
    })
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

  const stopExecute = typeof ctx.on === 'function'
    ? ctx.on('tools/execute', (exec, next) => {
      const bag = bagFromExec(exec) || {}
      let job
      try {
        job = prepareJobWorktree(exec)
      } catch (error) {
        return Promise.reject(error)
      }
      if (job) {
        bag.jobWorktree = job.path
        bag.jobId = job.jobId
      }
      if (!bag.role && !bag.jobWorktree && !isSubagentTool(exec && exec.name)) return next()
      return runWithBag(bag, () => Promise.resolve().then(() => next()).then((result) => {
        if (!isSubagentTool(exec && exec.name)) return result
        const policy = policyOf(exec.agent)
        return applyHandoffResult(result, bag.childId, budgetOf(policy, recordOf(exec.agent)).maxOutputBytes)
      }).catch((error) => {
        if (bag.jobId) {
          const row = loadChildSync(dshHome, bag.jobId)
          if (row && !row.jobId) cleanupChild(bag.jobId)
        }
        throw error
      }))
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
    if (typeof stopReport === 'function') stopReport()
    for (const stop of optionalStops) if (typeof stop === 'function') stop()
    if (typeof stopGuard === 'function') stopGuard()
    if (typeof stopPre === 'function') stopPre()
    if (typeof stopExecute === 'function') stopExecute()
    if (typeof stopEnd === 'function') stopEnd()
  })
}

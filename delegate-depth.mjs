export function asNonNegInt(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(8, Math.floor(n))
}

export function parentDepthOf(agent) {
  if (!agent) return 0
  const header = agent.session && agent.session.header
  const headerDepth = header && header.delegationDepth
  const runtime = agent.options && agent.options.subagentDepth
  const a = asNonNegInt(headerDepth, 0)
  const b = runtime === undefined || runtime === null ? 0 : asNonNegInt(runtime, 0)
  return Math.max(a, b)
}

export function childDepthOf(parentDepth) {
  return asNonNegInt(parentDepth, 0) + 1
}

export function depthAllowed(parentDepth, maxDepth) {
  return childDepthOf(parentDepth) <= asNonNegInt(maxDepth, 0)
}

export function clampStartMaxDepth(requested, policyMaxDepth) {
  const policy = asNonNegInt(policyMaxDepth, 0)
  if (requested === undefined || requested === null || requested === 'provider-managed') return policy
  const n = Number(requested)
  if (!Number.isFinite(n) || n < 0) return policy
  return Math.min(policy, Math.floor(n))
}

export function isSubagentTool(name) {
  const id = String(name || '').toLowerCase()
  return id.includes('subagent') || id.includes('delegate')
}

export function depthDenyReason(parentDepth, maxDepth) {
  const child = childDepthOf(parentDepth)
  const max = asNonNegInt(maxDepth, 0)
  if (child <= max) return undefined
  return 'Denied: delegation depth ' + child + ' exceeds maxDepth ' + max + '.'
}

export const DEFAULT_MAX_CHILDREN = 4
export const DEFAULT_MAX_OUTPUT_BYTES = 65536

function pickCap(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return Math.min(max, Math.floor(n))
}

export function budgetOf(policy, record) {
  const delegation = (policy && policy.delegation) || {}
  const extra = record || {}
  return {
    maxChildren: pickCap(
      extra.maxChildren != null ? extra.maxChildren : delegation.maxChildren,
      DEFAULT_MAX_CHILDREN,
      0,
      32,
    ),
    maxOutputBytes: pickCap(
      extra.maxOutputBytes != null ? extra.maxOutputBytes : delegation.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      256,
      1024 * 1024,
    ),
  }
}

export function budgetDenyReason(liveCount, maxChildren) {
  const live = Number(liveCount) || 0
  const max = Number(maxChildren)
  if (!Number.isFinite(max) || live < max) return undefined
  return 'Denied: delegation budget exceeded (' + live + '/' + max + ' live children).'
}

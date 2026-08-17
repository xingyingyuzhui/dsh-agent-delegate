export function probeEnforcement(sandbox, cwd) {
  if (!sandbox || typeof sandbox.confine !== 'function') return { kind: 'unknown' }
  try {
    const confined = sandbox.confine(['true'], {
      mode: 'read-only',
      workspaceRoot: cwd || process.cwd(),
    })
    const enforcement = confined && confined.enforcement
    if (enforcement === 'full' || enforcement === 'partial') {
      return { kind: 'ok', enforcement }
    }
    return { kind: 'unknown' }
  } catch {
    return { kind: 'unavailable' }
  }
}

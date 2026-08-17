export function taskKeyOf(label, role) {
  const raw = String(label || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const key = raw || 'task'
  return role ? key + '#' + role : key
}

export function nextGeneration(current) {
  const n = Number(current)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) + 1 : 1
}

export function isStaleRecord(record, latest) {
  if (!record || !latest) return false
  if (record.sessionId !== latest.sessionId) return true
  if (Number(record.generation) !== Number(latest.generation)) return true
  return false
}

export function staleDenyReason() {
  return 'Denied: stale subagent result discarded.'
}

export function trimHandoff(text, maxBytes) {
  const limit = Number(maxBytes)
  const value = text == null ? '' : String(text)
  if (!Number.isFinite(limit) || limit <= 0) return { text: value, truncated: false }
  const buf = Buffer.from(value, 'utf8')
  if (buf.length <= limit) return { text: value, truncated: false }
  const cut = buf.subarray(0, limit).toString('utf8')
  return { text: cut + '\n[truncated]', truncated: true }
}

export function trimContentBlocks(blocks, maxBytes) {
  if (!Array.isArray(blocks)) return blocks
  let used = 0
  const out = []
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      out.push(block)
      continue
    }
    const remain = maxBytes - used
    if (remain <= 0) {
      out.push({ type: 'text', text: '[truncated]' })
      break
    }
    const next = trimHandoff(block.text, remain)
    out.push({ ...block, text: next.text })
    used += Buffer.byteLength(next.text, 'utf8')
    if (next.truncated) break
  }
  return out
}

import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage()

export function runWithBag(bag, fn) {
  return storage.run(bag || {}, fn)
}

export function currentBag() {
  return storage.getStore() || null
}

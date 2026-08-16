import { ref } from 'vue'

const STORE_RELEASE_PREFIX = 'capgo.gettingStarted.storeRelease'
const storeReleaseValidatedKeys = ref(new Set<string>())

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  }
  catch {
    // Ignore blocked or full storage so sidebar render and dismiss clicks stay safe.
  }
}

export function storeReleaseValidatedKey(userId: string, appId: string) {
  return `${STORE_RELEASE_PREFIX}.${userId}.${appId}`
}

function storeReleaseSessionKey(userId: string, appId: string) {
  return `${userId}:${appId}`
}

export function isStoreReleaseValidated(userId: string, appId: string) {
  if (!userId || !appId)
    return false
  if (storeReleaseValidatedKeys.value.has(storeReleaseSessionKey(userId, appId)))
    return true
  if (typeof localStorage === 'undefined')
    return false
  return readStorage(storeReleaseValidatedKey(userId, appId)) === '1'
}

export function markStoreReleaseValidated(userId: string, appId: string) {
  if (!userId || !appId)
    return
  if (typeof localStorage !== 'undefined')
    writeStorage(storeReleaseValidatedKey(userId, appId), '1')
  const next = new Set(storeReleaseValidatedKeys.value)
  next.add(storeReleaseSessionKey(userId, appId))
  storeReleaseValidatedKeys.value = next
}

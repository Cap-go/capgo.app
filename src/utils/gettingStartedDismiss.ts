import { ref } from 'vue'

const STORAGE_PREFIX = 'capgo.gettingStarted.dismissed'
const STORE_RELEASE_PREFIX = 'capgo.gettingStarted.storeRelease'
const storeReleaseValidatedKeys = ref(new Set<string>())

export function gettingStartedDismissedKey(userId: string, appId: string) {
  return `${STORAGE_PREFIX}.${userId}.${appId}`
}

export function gettingStartedDismissedLegacyKey(userId: string) {
  return `${STORAGE_PREFIX}.${userId}`
}

export function parseDismissedGettingStartedAppIds(raw: string | null): Set<string> {
  if (!raw)
    return new Set()

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed))
      return new Set()
    return new Set(parsed.filter((appId): appId is string => typeof appId === 'string' && appId.length > 0))
  }
  catch {
    return new Set()
  }
}

export function serializeDismissedGettingStartedAppIds(appIds: Iterable<string>) {
  return JSON.stringify([...new Set(appIds)])
}

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

export function isGettingStartedDismissed(userId: string, appId: string) {
  if (!userId || !appId || typeof localStorage === 'undefined')
    return false
  if (readStorage(gettingStartedDismissedKey(userId, appId)) === '1')
    return true
  return parseDismissedGettingStartedAppIds(readStorage(gettingStartedDismissedLegacyKey(userId))).has(appId)
}

export function dismissGettingStarted(userId: string, appId: string) {
  if (!userId || !appId || typeof localStorage === 'undefined')
    return
  writeStorage(gettingStartedDismissedKey(userId, appId), '1')
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

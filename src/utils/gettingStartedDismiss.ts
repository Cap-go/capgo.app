const STORE_RELEASE_PREFIX = 'capgo.gettingStarted.storeRelease'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

export function storeReleaseValidatedKey(userId: string, appId: string) {
  return `${STORE_RELEASE_PREFIX}.${userId}.${appId}`
}

// Validations saved by the former Getting started checklist still count
// toward legacy (v1/v2) sidebar progress.
export function isStoreReleaseValidated(userId: string, appId: string) {
  if (!userId || !appId)
    return false
  if (typeof localStorage === 'undefined')
    return false
  return readStorage(storeReleaseValidatedKey(userId, appId)) === '1'
}

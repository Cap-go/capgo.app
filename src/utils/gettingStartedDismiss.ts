const STORAGE_PREFIX = 'capgo.gettingStarted.dismissed'

export function gettingStartedDismissedKey(userId: string) {
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

export function readDismissedGettingStartedAppIds(userId: string): Set<string> {
  if (!userId || typeof localStorage === 'undefined')
    return new Set()
  return parseDismissedGettingStartedAppIds(localStorage.getItem(gettingStartedDismissedKey(userId)))
}

export function isGettingStartedDismissed(userId: string, appId: string) {
  return readDismissedGettingStartedAppIds(userId).has(appId)
}

export function dismissGettingStarted(userId: string, appId: string) {
  if (!userId || !appId || typeof localStorage === 'undefined')
    return

  const dismissed = readDismissedGettingStartedAppIds(userId)
  dismissed.add(appId)
  localStorage.setItem(gettingStartedDismissedKey(userId), serializeDismissedGettingStartedAppIds(dismissed))
}

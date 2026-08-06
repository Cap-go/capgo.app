// August uses Central European Summer Time (UTC+2).
export const ONBOARDING_REDIRECT_CUTOFF = Date.parse('2026-08-04T01:00:00+02:00')

// The exploration grant lives in sessionStorage (keyed by user id) so it
// survives a full page reload — module-level state used to be wiped on refresh,
// which re-armed the /app/new redirect trap. sessionStorage clears itself when
// the tab closes, keeping the grant scoped to the browsing session.
const EXPLORATION_STORAGE_PREFIX = 'capgo:onboarding-exploration:'

// When sessionStorage is unavailable (SSR, privacy mode, tests), fall back to a
// module-level store. It won't survive a reload like sessionStorage does, but it
// keeps the grant working within the current runtime rather than failing closed.
const explorationMemoryFallback = new Map<string, string>()

function explorationStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  }
  catch {
    // Reading sessionStorage can throw in restricted contexts (SSR, privacy mode).
    return null
  }
}

function explorationKey(userId: string) {
  return `${EXPLORATION_STORAGE_PREFIX}${userId}`
}

function readExplorationRaw(key: string): string | null {
  const storage = explorationStorage()
  if (storage)
    return storage.getItem(key)
  return explorationMemoryFallback.get(key) ?? null
}

function writeExplorationRaw(key: string, value: string) {
  const storage = explorationStorage()
  if (!storage) {
    explorationMemoryFallback.set(key, value)
    return
  }

  try {
    storage.setItem(key, value)
  }
  catch (error) {
    // Quota or security errors shouldn't strand the user; keep it in memory.
    console.error('Cannot persist onboarding exploration grant', error)
    explorationMemoryFallback.set(key, value)
  }
}

function readExplorationGrant(userId: string | null | undefined) {
  if (!userId)
    return null

  const raw = readExplorationRaw(explorationKey(userId))
  if (raw === null)
    return null

  try {
    const parsed = JSON.parse(raw) as { resumeAppId?: unknown }
    return { resumeAppId: typeof parsed.resumeAppId === 'string' ? parsed.resumeAppId : null }
  }
  catch {
    // A grant with an unreadable payload still means "let this user explore".
    return { resumeAppId: null }
  }
}

export function allowOnboardingDashboardExploration(userId: string | null | undefined, resumeAppId?: string | null) {
  if (!userId)
    return

  writeExplorationRaw(explorationKey(userId), JSON.stringify({ resumeAppId: resumeAppId ?? null }))
}

export function canExploreOnboardingDashboard(userId: string | null | undefined) {
  return readExplorationGrant(userId) !== null
}

export function getOnboardingResumeAppId(userId: string | null | undefined) {
  return readExplorationGrant(userId)?.resumeAppId ?? null
}

export function isNewOnboardingUser(createdAt: string | null | undefined) {
  if (!createdAt)
    return false

  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) && timestamp > ONBOARDING_REDIRECT_CUTOFF
}

export function getOnboardingResumeRedirect(options: {
  appId: string | null | undefined
  appCount: number
  createdAt: string | null | undefined
  organizationCount: number
  path: string
  resumeAppId: string | null | undefined
  userId: string | null | undefined
}) {
  if (canExploreOnboardingDashboard(options.userId))
    return null
  if (!isNewOnboardingUser(options.createdAt))
    return null
  if (options.organizationCount !== 1 || options.appCount !== 1 || !options.appId)
    return null
  if (options.path === '/app/new' && options.resumeAppId === options.appId)
    return null

  return {
    path: '/app/new',
    query: { resume: options.appId },
  }
}

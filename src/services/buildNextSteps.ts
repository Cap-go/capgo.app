import { isBuildSucceeded } from './buildLiveStream'

// Statuses a build can leave on its own: the builds table refreshes while one is listed.
const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running', 'building', 'uploading', 'in_progress'])

export function isBuildActive(status: string | null | undefined) {
  return !!status && ACTIVE_STATUSES.has(status)
}

export type SavedBuildState = 'available' | 'expired' | 'not-saved' | 'none'

// What the saved-build column can say: a download, why there is none, or nothing (no success).
export function savedBuildState(build: { status: string }, output: { expires_at?: string } | undefined, now = Date.now()): SavedBuildState {
  if (!isBuildSucceeded(build.status))
    return 'none'
  if (!output?.expires_at)
    return 'not-saved'
  return Date.parse(output.expires_at) > now ? 'available' : 'expired'
}

export interface DatedBuild { status: string, created_at: string | null }

export function latestSucceededBuild(builds: readonly DatedBuild[]): DatedBuild | undefined {
  return builds
    .filter(build => isBuildSucceeded(build.status))
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))[0]
}

const dismissKey = (appId: string) => `capgo:build-next-steps-dismissed:${appId}`

export function isBuildNextStepsDismissed(appId: string) {
  try {
    return localStorage.getItem(dismissKey(appId)) === '1'
  }
  catch {
    return false
  }
}

export function dismissBuildNextSteps(appId: string) {
  try {
    localStorage.setItem(dismissKey(appId), '1')
  }
  catch {
    // Storage unavailable (private mode): the banner only hides for this visit.
  }
}

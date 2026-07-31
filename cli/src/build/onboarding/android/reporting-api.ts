// src/build/onboarding/android/reporting-api.ts
//
// Play Developer Reporting API wrapper — the subset onboarding needs: list the
// Play Store apps accessible to the signed-in user so we can reconcile them
// against the project's Gradle `applicationId`.
//
// `apps:search` is a *separate* API from androidpublisher (single scope
// `…/auth/playdeveloperreporting`) and works with a user OAuth token. Mirrors
// the iOS `apple-api.ts` listApps helper: the pure parser is unit-tested and
// the fetch is thin and accepts an injectable `fetchImpl` so tests never touch
// the network.

const REPORTING_BASE_URL = 'https://playdeveloperreporting.googleapis.com/v1beta1'

/**
 * A Play Store app record as returned by `apps:search`. Used by the Android
 * app-verification step to check whether an app exists whose `packageName`
 * matches the project's Gradle `applicationId`.
 */
export interface PlayApp {
  packageName: string
  displayName: string
}

/**
 * Parse an `apps:search` response into {@link PlayApp} records. Tolerant of a
 * missing `apps` array and of individual apps missing `displayName` — Google
 * omits fields rather than nulling them, and a malformed page must never throw
 * into the wizard (the whole feature degrades gracefully).
 *
 * Entries missing `packageName` are DROPPED: the package is the join key for
 * reconciliation, and letting an empty one through could spuriously
 * "exact-match" a project whose Gradle parse found no applicationId. The API
 * documents `packageName` as always present, so this only guards malformed
 * pages.
 */
export function parseAppsSearchResponse(json: any): PlayApp[] {
  return (Array.isArray(json?.apps) ? json.apps : []).flatMap((app: any): PlayApp[] => {
    const packageName = typeof app?.packageName === 'string' ? app.packageName : ''
    if (!packageName)
      return []
    return [{ packageName, displayName: app?.displayName || '' }]
  })
}

/**
 * Carries the HTTP status alongside the message so callers can distinguish a
 * 403 (scope not granted / Reporting API disabled → graceful degrade to the
 * plain Gradle picker) from other failures.
 */
export class ReportingApiHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ReportingApiHttpError'
    this.status = status
  }
}

/** Injectable fetch — defaults to the global `fetch`, overridable in tests. */
export type FetchImpl = typeof fetch

export interface ListPlayAppsOptions {
  /**
   * Override the global `fetch`. Tests inject a stub returning a Response-like
   * object; production omits this and uses `globalThis.fetch`.
   */
  fetchImpl?: FetchImpl
}

// `apps:search` returns at most `pageSize` apps per page plus a `nextPageToken`
// when more exist. We follow it up to MAX_LIST_PAGES — a hard cap so a
// malformed/looping token can never spin forever. 1000 × 10 = 10000 apps is
// far more than any real developer account has. Mirrors apple-api.ts'
// MAX_LIST_PAGES.
const MAX_LIST_PAGES = 10
const PAGE_SIZE = 1000

/**
 * List every Play Store app accessible to the signed-in user, following
 * pagination. Authenticates with the supplied user OAuth access token (must
 * carry the `playdeveloperreporting` scope).
 *
 * `GET …/v1beta1/apps:search?pageSize=1000`, following `nextPageToken` up to
 * {@link MAX_LIST_PAGES}. Throws {@link ReportingApiHttpError} on a non-OK
 * response so callers can branch on `.status` (e.g. 403 → degrade).
 */
export async function listPlayApps(
  accessToken: string,
  opts: ListPlayAppsOptions = {},
): Promise<PlayApp[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const apps: PlayApp[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = new URL(`${REPORTING_BASE_URL}/apps:search`)
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    if (pageToken)
      url.searchParams.set('pageToken', pageToken)

    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    })
    const body: any = await res.json().catch(() => null)

    if (!res.ok) {
      const message: string = body?.error?.message || `HTTP ${res.status}`
      throw new ReportingApiHttpError(
        res.status,
        `Play Developer Reporting API error (${res.status}): ${message}`,
      )
    }

    apps.push(...parseAppsSearchResponse(body))

    // Only follow a string pageToken. Guard against a malformed/non-string
    // nextPageToken (untrusted API field) being coerced into the URL; anything
    // else ends pagination rather than looping on a bogus token.
    const next = typeof body?.nextPageToken === 'string' ? body.nextPageToken : undefined
    if (!next)
      break
    pageToken = next
  }
  return apps
}

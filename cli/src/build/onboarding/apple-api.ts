// src/build/onboarding/apple-api.ts
import jwt from 'jsonwebtoken'
import { extractTeamIdFromCert } from './csr.js'
import { appendInternalLog, safeHeaders } from '../../support/internal-log.js'

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1'

// ─── JWT ───────────────────────────────────────────────────────────

/**
 * Generate a JWT for App Store Connect API authentication.
 * Uses ES256 algorithm with the .p8 private key.
 */
export function generateJwt(
  keyId: string,
  issuerId: string,
  p8Content: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      iss: issuerId,
      // Stay below Apple's 20-minute maximum so small local clock skew does
      // not make the token appear too long-lived and trigger a false 401.
      iat: now,
      exp: now + 15 * 60,
      aud: 'appstoreconnect-v1',
    },
    p8Content,
    {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
    },
  )
}

// ─── Helpers ───────────────────────────────────────────────────────

interface AppleApiError {
  status: string
  code: string
  title: string
  detail: string
}

// Carries the HTTP status alongside the message so error-categories.ts can map
// 401 → 'apple_api_unauthorized' and 429 → 'apple_api_rate_limited' instead of
// falling through to 'unknown'.
export class AppleApiHttpError extends Error {
  readonly status: number
  // The Apple error code (e.g. 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED')
  // when present, so callers can distinguish error sub-types within one status.
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AppleApiHttpError'
    this.status = status
    this.code = code
  }
}

async function ascFetch(
  path: string,
  token: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<any> {
  const url = `${ASC_BASE_URL}${path}`
  const res = await fetch(url, {
    ...options,
    // An explicit signal arg wins; otherwise honor any signal on options.
    signal: signal ?? options.signal,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  const body: any = await res.json().catch(() => null)

  if (!res.ok) {
    const errors: AppleApiError[] = body?.errors || []
    const first = errors[0]
    // Capture the raw Apple App Store Connect error in the internal support log
    // (secret-redacted on write) so non-build failures are diagnosable.
    appendInternalLog(`apple-api ${options.method ?? 'GET'} ${path}: HTTP ${res.status} ${res.statusText} ${JSON.stringify(body?.errors ?? body ?? null)} | ${safeHeaders(res.headers)}`)
    if (first) {
      throw new AppleApiHttpError(res.status, `Apple API error (${res.status}): ${first.title} — ${first.detail} (${first.code})`, first.code)
    }
    throw new AppleApiHttpError(res.status, `Apple API error: HTTP ${res.status} ${res.statusText}`)
  }

  // Log successful calls too, so the bundle has the FULL App Store Connect call
  // trace (not just failures) — invaluable for "it failed somewhere" reports.
  appendInternalLog(`apple-api ${options.method ?? 'GET'} ${path}: HTTP ${res.status} | ${safeHeaders(res.headers)}`)
  return body
}

// ─── API Functions ─────────────────────────────────────────────────

// Shared App Store Connect auth-failure copy. Exported so prescan's
// assertAscAccess reuses the exact wording verifyApiKey shows during
// onboarding (no drift between the two probes). These strings reach the
// terminal and --json reports, so they NEVER contain credential material.
export const ASC_AGREEMENTS_MESSAGE
  = 'Apple is blocking App Store Connect API access because your developer account has a required agreement that is unsigned or has expired.\n'
    + '  - Sign in as the Account Holder at https://appstoreconnect.apple.com\n'
    + '  - Open "Business" (Agreements, Tax, and Banking) and accept the pending or updated agreement\n'
    + '  - Then run this step again — your API key is valid, so no key changes are needed'

export const ASC_KEY_REJECTED_MESSAGE
  = 'API key verification failed. Please check:\n'
    + '  - The .p8 file is correct and hasn\'t been modified\n'
    + '  - The Key ID matches the key shown in App Store Connect\n'
    + '  - The Issuer ID is correct (shown at the top of the API keys page)\n'
    + '  - The key has "Admin" or "Developer" access'

export interface AscAuthClassification {
  is401or403: boolean
  isAgreements: boolean
  status?: number
  code?: string
  message: string
}

/**
 * Classify a thrown App Store Connect error into the shared 401/403 + agreements
 * buckets. Returns is401or403=false for anything else (network/5xx/etc) so
 * callers route those to their own network/info handling.
 */
export function classifyAscAuthError(err: any): AscAuthClassification {
  const status = typeof err?.status === 'number' ? err.status : undefined
  const code = typeof err?.code === 'string' ? err.code : undefined
  const is401 = status === 401
  const is403 = status === 403
  const isAgreements = Boolean(is403 && (code === 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED' || code === 'FORBIDDEN_ERROR.PLA_NOT_ACCEPTED' || /\bPLA_NOT_ACCEPTED\b|required agreement|program license agreement/i.test(err?.message ?? '')))
  return {
    is401or403: Boolean(is401 || is403),
    isAgreements,
    status,
    code,
    message: isAgreements ? ASC_AGREEMENTS_MESSAGE : ASC_KEY_REJECTED_MESSAGE,
  }
}

/**
 * Verify the API key works and try to detect the team ID from existing certificates.
 * Throws on 401/403 with a user-friendly message.
 */
export async function verifyApiKey(token: string): Promise<{ valid: true, teamId: string }> {
  try {
    // Verify key works and try to get team ID from existing certs
    const body = await ascFetch('/certificates?limit=1', token)
    let teamId = ''
    if (body.data?.length > 0 && body.data[0].attributes?.certificateContent) {
      teamId = extractTeamIdFromCert(body.data[0].attributes.certificateContent)
    }
    return { valid: true, teamId }
  }
  catch (err: any) {
    // Apple returns 403 when the account holder must sign (or re-sign) a required
    // agreement — FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED (paid-apps/tax) or
    // FORBIDDEN_ERROR.PLA_NOT_ACCEPTED (updated Program License Agreement). The key
    // itself is valid, so point the user at the agreements page instead of sending
    // them to re-check credentials that are fine. classifyAscAuthError owns this
    // detection (shared with assertAscAccess) and preserves status/code so
    // error-categories maps it to 'apple_agreements_missing' (not 'unknown').
    const cls = classifyAscAuthError(err)
    if (cls.isAgreements)
      throw new AppleApiHttpError(403, cls.message, cls.code)
    if (cls.is401or403)
      throw new AppleApiHttpError(cls.status ?? 401, cls.message, cls.code)
    throw err
  }
}

export interface AscDistributionCert {
  id: string
  name: string
  serialNumber: string
  expirationDate: string
  /**
   * Base64-encoded DER of the certificate. Populated when {@link listDistributionCerts}
   * is called with `includeContent: true` — kept optional so existing callers don't pay
   * the larger payload when they don't need it.
   */
  certificateContent?: string
}

// ─── Cert availability classifier ──────────────────────────────────

/**
 * Why a local Keychain cert can't be used to ship builds.
 *
 * Concrete enumeration so the import-pick-identity UI can render a stable
 * Reason column and so we can add specific guidance per reason (e.g.
 * "managed" certs get a "can't sign locally" note, "not-visible" certs get
 * a "Open Developer Portal to verify" note).
 */
export type CertAvailabilityReason
  = | 'expired'
    | 'managed' // DISTRIBUTION_MANAGED — Apple-HSM signed, can't sign locally
    | 'not-visible' // lookup didn't find a SHA1 match (revoked / wrong team / filter limitation)
    | 'check-failed' // network or API error during lookup
    | 'no-private-key' // for .p12 path — cert exists but key was stripped

export interface CertAvailability {
  available: boolean
  reason?: CertAvailabilityReason
  /** Short human-readable reason for display in the picker. */
  reasonText?: string
  /** When available — Apple-side cert resource id for downstream API calls. */
  appleCertId?: string
}

/**
 * Pure classifier: given a local cert + the result of an Apple-side lookup,
 * decide whether it's usable for shipping builds and surface a short
 * reasonText for the picker UI.
 *
 * Exported separately from the lookup function so we can unit-test the
 * decision logic without mocking network calls. Callers compose:
 *
 *   const certId = await findCertIdBySha1(token, identity.sha1)
 *     .catch(err => { lookupError = err; return null })
 *   const availability = classifyCertAvailability({
 *     localExpirationDate: identity.expirationDate,
 *     appleCertId: certId,
 *     lookupError,
 *   })
 *
 * The `expired` and `managed` branches don't need a lookup — they're checked
 * up-front from local metadata. Callers can pass null `appleCertId` without
 * having run the lookup at all when those local-side conditions already
 * disqualify the identity.
 */
export function classifyCertAvailability(args: {
  localExpirationDate?: string
  isManaged?: boolean
  appleCertId: string | null
  lookupError?: unknown
}): CertAvailability {
  // Local-side disqualifiers first — these don't require an API round-trip.
  if (args.localExpirationDate) {
    const exp = Date.parse(args.localExpirationDate)
    if (!Number.isNaN(exp) && exp < Date.now()) {
      return {
        available: false,
        reason: 'expired',
        reasonText: `Expired (${args.localExpirationDate.split('T')[0]})`,
      }
    }
  }
  if (args.isManaged) {
    return {
      available: false,
      reason: 'managed',
      reasonText: 'Apple-managed — can\'t sign locally',
    }
  }
  // Apple-side lookup outcomes.
  if (args.lookupError) {
    return {
      available: false,
      reason: 'check-failed',
      reasonText: `Lookup failed: ${args.lookupError instanceof Error ? args.lookupError.message : String(args.lookupError)}`,
    }
  }
  if (args.appleCertId) {
    return { available: true, appleCertId: args.appleCertId }
  }
  // No match returned. We can't distinguish revoked vs. wrong-team vs. our
  // own lookup having a buggy filter from the response alone, so surface a
  // neutral reasonText that doesn't claim revocation we can't prove.
  return {
    available: false,
    reason: 'not-visible',
    reasonText: 'Not visible to current API key (revoked, different team, or lookup limitation)',
  }
}

/**
 * List all iOS distribution certificates.
 *
 * Set `includeContent: true` when you need to compute the cert's SHA1 for
 * matching against a local Keychain identity ({@link findCertIdBySha1}).
 */
export async function listDistributionCerts(
  token: string,
  options: { includeContent?: boolean, types?: ('DISTRIBUTION' | 'IOS_DISTRIBUTION')[] } = {},
): Promise<AscDistributionCert[]> {
  // Query BOTH cert types — the legacy iOS-specific and the newer cross-
  // platform "Apple Distribution" — because Apple deprecated
  // IOS_DISTRIBUTION around 2021 and new certs created from App Store
  // Connect now default to DISTRIBUTION. A team that has churned through
  // certs over the years almost always has both types in its ledger; an
  // IOS_DISTRIBUTION-only filter silently excludes the newer ones and
  // produces a false negative when matching against a local Keychain
  // identity named "Apple Distribution:" (= DISTRIBUTION type).
  //
  // limit=200 is Apple's documented max for this endpoint and is wildly
  // higher than the per-team cert limits, so pagination is unnecessary
  // even for the most prolific teams.
  //
  // DISTRIBUTION_MANAGED is intentionally NOT in the filter — those certs
  // are signed using Apple-held private keys (Xcode Cloud / managed
  // signing) and cannot be used to sign builds on third-party CI like
  // Capgo. Including them would surface unusable identities in the
  // picker. They'll still appear in the Available/Unavailable table view
  // (Phase 2) marked "Apple-managed — can't sign locally".
  // `types` narrows the filter for callers that care about ONE pool — e.g.
  // createCertificate's limit recovery, where only same-type revocations free
  // a slot. Default stays both types for the import-matching reasons above.
  const typeFilter = (options.types ?? ['DISTRIBUTION', 'IOS_DISTRIBUTION']).join(',')
  const body = await ascFetch(
    `/certificates?filter[certificateType]=${typeFilter}&limit=200`,
    token,
  )
  return (body.data || []).map((c: any): AscDistributionCert => ({
    id: c.id,
    name: c.attributes.name || c.attributes.displayName || 'iOS Distribution',
    serialNumber: c.attributes.serialNumber || '',
    expirationDate: c.attributes.expirationDate,
    ...(options.includeContent && c.attributes.certificateContent
      ? { certificateContent: c.attributes.certificateContent as string }
      : {}),
  }))
}

/**
 * Compute the SHA1 hash of an ASC certificate's base64-DER content. Returns
 * the lowercase 40-char hex string used elsewhere as the canonical identity
 * key — matches the SHA1 reported by `security find-identity` on macOS.
 *
 * SECURITY NOTE on SHA1: this is NOT a security primitive. macOS itself
 * reports code-signing identities as cert-DER SHA1 (via `security
 * find-identity`), and we have to use the same hash to look up an Apple-side
 * cert by its on-Mac counterpart. SHA1 here is a non-secret identifier, not
 * a message digest protecting any data. CodeQL's "weak cryptographic
 * algorithm" rule is suppressed for this reason.
 */
export function computeCertSha1(certificateContentBase64: string): string {
  // Lazy require — keep crypto out of the import-time graph
  // eslint-disable-next-line ts/no-require-imports
  const { Buffer } = require('node:buffer') as typeof import('node:buffer')
  // eslint-disable-next-line ts/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const der = Buffer.from(certificateContentBase64, 'base64')
  // lgtm[js/weak-cryptographic-algorithm] SHA1 is required for compatibility
  // with `security find-identity` output — see comment above.
  return createHash('sha1').update(der).digest('hex').toLowerCase()
}

/**
 * Match a local Keychain identity (by its SHA1) against an Apple-side
 * certificate and return the Apple certificate ID needed for profile
 * creation. Returns null if no Apple-side cert matches the SHA1.
 */
export async function findCertIdBySha1(token: string, sha1: string): Promise<string | null> {
  const match = await findCertBySha1(token, sha1)
  return match ? match.id : null
}

/**
 * Like {@link findCertIdBySha1} but returns the full Apple-side cert
 * record (id + name + expirationDate + serialNumber) when matched. Used
 * by the eager batch validation so the picker / manual-portal-walkthrough
 * step can surface concrete disambiguators (expiration date, last few
 * chars of serial number — both visible in the Apple Developer Portal
 * when the user clicks into a cert) that help the user pick the right
 * row when multiple distribution certs are listed for the same team.
 *
 * Apple's API does NOT expose a "created by" field on certs (the portal
 * UI shows it, but `/v1/certificates` doesn't return that column). The
 * disambiguators we can give are expirationDate + serialNumber.
 */
export async function findCertBySha1(token: string, sha1: string): Promise<AscDistributionCert | null> {
  const target = sha1.toLowerCase()
  const certs = await listDistributionCerts(token, { includeContent: true })
  for (const cert of certs) {
    if (!cert.certificateContent)
      continue
    if (computeCertSha1(cert.certificateContent) === target)
      return cert
  }
  return null
}

/**
 * List all provisioning profiles linked to a specific Apple-side certificate.
 * Used by the import-flow no-match-recovery menu to surface profiles that
 * exist on Apple but haven't been downloaded to the user's Mac.
 */
export interface AscProfileSummary {
  id: string
  name: string
  profileType: string
  profileContent: string
  expirationDate: string
  bundleIdentifier: string
}

export async function listProfilesForCert(
  token: string,
  certificateId: string,
): Promise<AscProfileSummary[]> {
  // There's no direct "profiles for a given cert" endpoint on the ASC
  // API — both naïve attempts return 4xx:
  //   - `/profiles?filter[certificates]=X` → 400, "'certificates' is not
  //     a valid filter type" (filter is whitelisted to id / name /
  //     profileState / profileType only).
  //   - `/certificates/{id}/profiles`     → 404, "The relationship
  //     'profiles' does not exist" (certificates is the to-many
  //     side; profiles → certificates is the navigable direction).
  //
  // The supported approach is to list ALL profiles with
  // `include=certificates,bundleId`, then filter client-side to those
  // whose `relationships.certificates.data[]` array includes our cert id.
  // Limit=200 is Apple's documented max for /profiles.
  //
  // PAGINATION: the 200 cap is on the TEAM's total profile count (apps ×
  // distribution types × extensions × dev machines), NOT on profiles
  // matching our cert. Teams with 200+ active profiles would silently
  // lose matches on page 2+ if we ignored `body.links.next`, causing
  // import-checking-apple-cert to misroute to no-match-recovery and
  // create-new to collide with an existing-but-paginated-away profile.
  // We walk every page and accumulate before applying the client-side
  // cert-id filter.
  const allData: any[] = []
  const allIncluded: any[] = []
  let url: string = '/profiles?include=certificates,bundleId&limit=200'
  while (url) {
    const body = await ascFetch(url, token)
    if (Array.isArray(body.data))
      allData.push(...body.data)
    if (Array.isArray(body.included))
      allIncluded.push(...body.included)
    const next: string | undefined = body.links?.next
    // Apple returns `links.next` as a fully-qualified URL; ascFetch builds
    // `${ASC_BASE_URL}${path}`, so strip the base prefix to avoid a
    // double-prefixed URL on the follow-up request. If a future API
    // version ever returns a path-relative next link, the startsWith
    // guard preserves it as-is.
    url = next ? (next.startsWith(ASC_BASE_URL) ? next.slice(ASC_BASE_URL.length) : next) : ''
  }
  const bundleById = new Map<string, string>()
  for (const item of allIncluded) {
    if (item.type === 'bundleIds' && item.attributes?.identifier)
      bundleById.set(item.id, item.attributes.identifier)
  }
  // Client-side cert-id filter on `relationships.certificates.data[].id`.
  // Apple's included response includes the cert resources too, but we
  // only need the reference array to decide which profiles to keep.
  const profiles = allData.filter((p: any) => {
    const certs: { id: string }[] = p.relationships?.certificates?.data ?? []
    return certs.some(c => c.id === certificateId)
  })
  return profiles.map((p: any): AscProfileSummary => {
    const bundleRelId = p.relationships?.bundleId?.data?.id as string | undefined
    return {
      id: p.id,
      name: p.attributes.name || '',
      profileType: p.attributes.profileType || '',
      profileContent: p.attributes.profileContent || '',
      expirationDate: p.attributes.expirationDate || '',
      bundleIdentifier: bundleRelId ? bundleById.get(bundleRelId) || '' : '',
    }
  })
}

/**
 * Revoke (delete) a certificate by ID.
 */
export async function revokeCertificate(token: string, certId: string): Promise<void> {
  await ascFetch(`/certificates/${certId}`, token, { method: 'DELETE' })
}

/**
 * Error thrown when certificate limit is reached.
 * Contains the existing certificates so the UI can ask the user which to revoke.
 */
export class CertificateLimitError extends Error {
  constructor(
    public readonly certificates: AscDistributionCert[],
  ) {
    super(`Certificate limit reached. Found ${certificates.length} existing Apple Distribution certificate(s).`)
    this.name = 'CertificateLimitError'
  }
}

/**
 * Create an Apple Distribution certificate (type DISTRIBUTION — the modern
 * cross-platform type Xcode 11+ uses; the legacy IOS_DISTRIBUTION type is
 * deprecated and its separate per-team pool tends to be full of old certs)
 * using a CSR.
 * Returns the certificate ID, base64 DER content, expiration date, and team ID.
 *
 * Throws CertificateLimitError if the limit is reached, so the UI can ask
 * the user which certificate to revoke.
 */
export async function createCertificate(
  token: string,
  csrPem: string,
): Promise<{
  certificateId: string
  certificateContent: string
  expirationDate: string
  teamId: string
}> {
  try {
    const body = await ascFetch('/certificates', token, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'certificates',
          attributes: {
            certificateType: 'DISTRIBUTION',
            csrContent: csrPem,
          },
        },
      }),
    })

    const cert = body.data
    // Extract team ID from the certificate's subject OU field
    const teamId = extractTeamIdFromCert(cert.attributes.certificateContent)

    return {
      certificateId: cert.id,
      certificateContent: cert.attributes.certificateContent,
      expirationDate: cert.attributes.expirationDate,
      teamId,
    }
  }
  catch (err: any) {
    if (err.message?.includes('ENTITY_ERROR.ATTRIBUTE.INVALID')
      || err.message?.includes('There is a problem with the request entity')
      || err.message?.includes('maximum number of certificates')) {
      // Fetch the existing certs of the SAME type we tried to create so the
      // UI can let the user choose which to revoke. Scoped to DISTRIBUTION on
      // purpose: revoking a cert from another pool (legacy IOS_DISTRIBUTION)
      // would not free a slot here — offering it would send the user in a
      // circle (and tempt them to revoke a production cert for nothing).
      // The list is diagnostics only — if it ALSO fails it must not REPLACE
      // the original create error (hostile-review, 2026-06-12).
      let existing: AscDistributionCert[]
      try {
        existing = await listDistributionCerts(token, { types: ['DISTRIBUTION'] })
      }
      catch {
        throw err
      }
      if (existing.length > 0) {
        throw new CertificateLimitError(existing)
      }
    }
    throw err
  }
}

/**
 * Find an existing bundle ID or register a new one.
 * Returns the Apple resource ID needed for profile creation.
 */
export async function ensureBundleId(
  token: string,
  identifier: string,
): Promise<{ bundleIdResourceId: string }> {
  // Try to find existing
  const searchBody = await ascFetch(
    `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`,
    token,
  )

  if (searchBody.data?.length > 0) {
    return { bundleIdResourceId: searchBody.data[0].id }
  }

  // Register new. Apple's `attributes.identifier` field accepts the
  // reverse-DNS bundle id verbatim (dots, hyphens), but the human-readable
  // `attributes.name` field rejects anything non-alphanumeric — including
  // the dots that are mandatory in every real bundle id. The error reads:
  //   'Capgo app.capgo.plugin.TutorialBuild1' is not a valid name for an
  //   app id. Please choose a name containing only alphanumeric characters
  //   and spaces. (ENTITY_ERROR.ATTRIBUTE.INVALID)
  // So we sanitize by replacing every non-alphanumeric run with a single
  // space and trimming. "app.capgo.plugin.TutorialBuild1" becomes
  // "app capgo plugin TutorialBuild1" → final name "Capgo app capgo
  // plugin TutorialBuild1", which Apple accepts. The identifier we send
  // stays the original — the name is purely a portal display label.
  const sanitizedName = identifier.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  const createBody = await ascFetch('/bundleIds', token, {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'bundleIds',
        attributes: {
          identifier,
          name: `Capgo ${sanitizedName}`,
          platform: 'IOS',
        },
      },
    }),
  })

  return { bundleIdResourceId: createBody.data.id }
}

/**
 * An App Store Connect app record. Used by the iOS app-verification step to
 * check whether an app exists whose `bundleId` matches the project's Release
 * `PRODUCT_BUNDLE_IDENTIFIER`.
 */
export interface AscApp {
  id: string
  bundleId: string
  name: string
}

/**
 * Parse a `GET /v1/apps` response into {@link AscApp} records. Tolerant of
 * missing `data`, missing `attributes`, and missing individual fields — Apple
 * omits attributes the API key isn't entitled to see rather than nulling them.
 */
export function parseAppsResponse(json: any): AscApp[] {
  return (json?.data || []).map((app: any): AscApp => ({
    id: app?.id || '',
    bundleId: app?.attributes?.bundleId || '',
    name: app?.attributes?.name || '',
  }))
}

/**
 * Parse a `GET /v1/bundleIds` response into the list of registered identifier
 * strings, dropping any falsy entries (missing `attributes`/`identifier`).
 */
export function parseBundleIdsResponse(json: any): string[] {
  return (json?.data || [])
    .map((b: any): string => b?.attributes?.identifier || '')
    .filter((id: string): boolean => Boolean(id))
}

// App Store Connect returns at most `limit` resources per page and a
// `links.next` absolute URL when more exist. We follow it (stripping the base
// URL so it can flow back through ascFetch) up to MAX_LIST_PAGES — a hard cap
// so a malformed/looping `next` link can never spin forever. 200 × 10 = 2000
// records is far more than any real team has.
const MAX_LIST_PAGES = 10

/**
 * Turn an absolute `links.next` URL into an ascFetch-relative path. Apple
 * returns `links.next` fully-qualified, and ascFetch builds `${ASC_BASE_URL}${path}`,
 * so we strip the base prefix to avoid a double-prefixed URL. If a future API
 * version returns a path-relative next link, preserve it as-is rather than
 * silently truncating pagination — mirrors `listProfilesForCert`'s handling.
 */
function nextPath(next: string | undefined): string | null {
  if (!next)
    return null
  return next.startsWith(ASC_BASE_URL) ? next.slice(ASC_BASE_URL.length) : next
}

/**
 * List every App Store Connect app visible to the API key, following
 * pagination. Uses the existing {@link ascFetch} — no separate fetch path.
 */
export async function listApps(token: string): Promise<AscApp[]> {
  const apps: AscApp[] = []
  let path: string | null = '/apps?limit=200'
  for (let page = 0; page < MAX_LIST_PAGES && path; page++) {
    const body: any = await ascFetch(path, token)
    apps.push(...parseAppsResponse(body))
    path = nextPath(body?.links?.next)
  }
  return apps
}

/**
 * List every registered bundle ID identifier visible to the API key, following
 * pagination. Uses the existing {@link ascFetch} — no separate fetch path.
 */
export async function listBundleIds(token: string): Promise<string[]> {
  const ids: string[] = []
  let path: string | null = '/bundleIds?limit=200'
  for (let page = 0; page < MAX_LIST_PAGES && path; page++) {
    const body: any = await ascFetch(path, token)
    ids.push(...parseBundleIdsResponse(body))
    path = nextPath(body?.links?.next)
  }
  return ids
}

/**
 * Get the profile name we use for a given appId.
 */
export function getCapgoProfileName(appId: string): string {
  return `Capgo ${appId} AppStore`
}

/**
 * Find existing provisioning profiles matching our naming convention.
 * Only returns profiles we created (named "Capgo <appId> AppStore").
 */
export async function findCapgoProfiles(
  token: string,
  appId: string,
): Promise<Array<{ id: string, name: string, profileType: string }>> {
  const profileName = getCapgoProfileName(appId)
  const body = await ascFetch(
    `/profiles?filter[name]=${encodeURIComponent(profileName)}&limit=10`,
    token,
  )

  return (body.data || []).map((p: any) => ({
    id: p.id,
    name: p.attributes.name,
    profileType: p.attributes.profileType,
  }))
}

/**
 * Delete a provisioning profile by ID.
 */
export async function deleteProfile(token: string, profileId: string): Promise<void> {
  await ascFetch(`/profiles/${profileId}`, token, { method: 'DELETE' })
}

/**
 * Create an App Store provisioning profile linking a certificate and bundle ID.
 * Returns the base64 mobileprovision content.
 *
 * Throws a DuplicateProfileError if duplicate profiles exist, so the caller
 * can ask the user whether to delete them and retry.
 */
export class DuplicateProfileError extends Error {
  constructor(
    public readonly profiles: Array<{ id: string, name: string, profileType: string }>,
  ) {
    super(`Duplicate profiles found: ${profiles.map(p => p.name).join(', ')}`)
    this.name = 'DuplicateProfileError'
  }
}

export async function createProfile(
  token: string,
  bundleIdResourceId: string,
  certificateId: string,
  appId: string,
): Promise<{
  profileId: string
  profileName: string
  profileContent: string
  expirationDate: string
}> {
  const profileName = getCapgoProfileName(appId)

  try {
    const body = await ascFetch('/profiles', token, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'profiles',
          attributes: {
            name: profileName,
            profileType: 'IOS_APP_STORE',
          },
          relationships: {
            bundleId: {
              data: { type: 'bundleIds', id: bundleIdResourceId },
            },
            certificates: {
              data: [{ type: 'certificates', id: certificateId }],
            },
          },
        },
      }),
    })

    return {
      profileId: body.data.id,
      profileName: body.data.attributes.name,
      profileContent: body.data.attributes.profileContent,
      expirationDate: body.data.attributes.expirationDate,
    }
  }
  catch (err: any) {
    // Detect duplicate profile error
    if (err.message?.includes('Multiple profiles found')
      || err.message?.includes('duplicate')) {
      // The follow-up list is diagnostics for the delete-and-retry prompt — if
      // it ALSO fails it must not REPLACE the original duplicate error
      // (hostile-review, 2026-06-12): rethrow the ORIGINAL.
      let existing: Array<{ id: string, name: string, profileType: string }>
      try {
        existing = await findCapgoProfiles(token, appId)
      }
      catch {
        throw err
      }
      if (existing.length > 0) {
        throw new DuplicateProfileError(existing)
      }
    }
    throw err
  }
}

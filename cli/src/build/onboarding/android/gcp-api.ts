// src/build/onboarding/android/gcp-api.ts
//
// Google Cloud Platform REST API wrappers used by the Android OAuth onboarding
// flow. All calls authenticate with a user's OAuth access token obtained via
// the `cloud-platform` scope.
//
// Covers:
//  - Cloud Resource Manager v1 — list + create projects, poll operations
//  - Service Usage v1            — enable APIs on a project
//  - IAM v1                      — create service accounts + keys
//
// Every network response is validated shape-wise before we trust it. Errors
// include enough context that the TUI can show a useful message.

import { appendInternalLog, safeHeaders } from '../../../support/internal-log.js'

const CRM_ENDPOINT = 'https://cloudresourcemanager.googleapis.com/v1'
const SERVICEUSAGE_ENDPOINT = 'https://serviceusage.googleapis.com/v1'
const IAM_ENDPOINT = 'https://iam.googleapis.com/v1'

const DEFAULT_OPERATION_TIMEOUT_MS = 2 * 60 * 1000 // 2 min — project create can take ~30s
const OPERATION_POLL_INTERVAL_MS = 2000

export const ANDROIDPUBLISHER_API = 'androidpublisher.googleapis.com'
export const DEFAULT_SERVICE_ACCOUNT_ID = 'capgo-native-build'
export const DEFAULT_SERVICE_ACCOUNT_DISPLAY_NAME = 'Capgo Native Build'
export const DEFAULT_SERVICE_ACCOUNT_DESCRIPTION
  = 'Allows Capgo to build and submit the app to the Google Play Store'

export interface GcpProject {
  projectId: string
  projectNumber: string
  name: string
  lifecycleState: 'ACTIVE' | 'DELETE_REQUESTED' | 'DELETE_IN_PROGRESS' | string
}

export interface GcpServiceAccount {
  name: string
  email: string
  projectId: string
  uniqueId: string
  displayName?: string
}

export interface GcpServiceAccountKey {
  /** Full resource name — e.g. `projects/{p}/serviceAccounts/{sa}/keys/{keyId}`. */
  name: string
  /** Base64-encoded JSON key file — decode with `Buffer.from(..., 'base64')`. */
  privateKeyDataBase64: string
}

interface GcpOperation {
  name: string
  done?: boolean
  error?: { code: number, message: string, details?: unknown }
  response?: Record<string, unknown>
}

/**
 * Some Google APIs (Service Usage in particular) return synthetic operations
 * like `operations/noop.DONE_OPERATION` when a request is effectively a no-op
 * (e.g. enabling an already-enabled service). These aren't real operations —
 * calling `operations.get` on them returns 400 INVALID_ARGUMENT. We must
 * short-circuit and treat them as already-done.
 */
function isAlreadyDoneOperation(op: GcpOperation): boolean {
  if (op.done === true)
    return true
  return typeof op.name === 'string' && /\bnoop\.DONE_OPERATION\b/.test(op.name)
}

/**
 * Default per-request timeout for Google API calls. 30s is well above the
 * latency budget for every endpoint we hit here (project create/get, service
 * usage, IAM, operation-kickoff). Long-running operations are polled via
 * `pollOperation`, which carries its own multi-minute budget.
 */
const GCP_FETCH_DEFAULT_TIMEOUT_MS = 30_000

async function gcpFetch<T>(args: {
  method: 'GET' | 'POST'
  url: string
  accessToken: string
  body?: unknown
  /** Override the default 30s per-request timeout. */
  timeoutMs?: number
}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.accessToken}`,
    Accept: 'application/json',
  }
  if (args.body !== undefined)
    headers['Content-Type'] = 'application/json'

  const timeoutMs = args.timeoutMs ?? GCP_FETCH_DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(args.url, {
      method: args.method,
      headers,
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      signal: controller.signal,
    })
  }
  catch (err) {
    // Re-throw with a timeout-specific message so callers can distinguish a
    // stall from any other network error. `AbortController.abort()` surfaces
    // as either `AbortError` (Node 18+) or the `'AbortError'` `name` field.
    const isAbort = (err as { name?: string })?.name === 'AbortError'
    if (isAbort)
      throw new Error(`Google API request to ${args.url} timed out after ${timeoutMs}ms`)
    throw err
  }
  finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  if (!res.ok) {
    let detail: string = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string, status?: string } }
      if (parsed.error?.message)
        detail = `${parsed.error.status ?? ''}${parsed.error.status && parsed.error.message ? ': ' : ''}${parsed.error.message}`
    }
    catch {}
    // Capture the raw Google Cloud API error in the internal support log
    // (secret-redacted on write) so non-build failures are diagnosable.
    appendInternalLog(`gcp-api ${args.method ?? 'GET'} ${args.url}: HTTP ${res.status} ${detail} | ${safeHeaders(res.headers)}`)
    throw new Error(`Google API ${res.status} at ${args.url}: ${detail}`)
  }
  // Log successful calls too — the bundle gets the full GCP call trace.
  appendInternalLog(`gcp-api ${args.method ?? 'GET'} ${args.url}: HTTP ${res.status} | ${safeHeaders(res.headers)}`)
  if (!text.trim())
    return undefined as unknown as T
  try {
    return JSON.parse(text) as T
  }
  catch {
    throw new Error(`Google API returned non-JSON at ${args.url}: ${text.slice(0, 200)}`)
  }
}

/**
 * List GCP projects the user has access to. Only ACTIVE projects are returned
 * (pending-deletion projects are filtered out).
 */
export async function listProjects(accessToken: string): Promise<GcpProject[]> {
  const out: GcpProject[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${CRM_ENDPOINT}/projects`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('filter', 'lifecycleState:ACTIVE')
    if (pageToken)
      url.searchParams.set('pageToken', pageToken)
    const data = await gcpFetch<{
      projects?: Array<Partial<GcpProject>>
      nextPageToken?: string
    }>({ method: 'GET', url: url.toString(), accessToken })
    for (const p of data.projects ?? []) {
      if (p.projectId && p.projectNumber && p.name && p.lifecycleState === 'ACTIVE')
        out.push(p as GcpProject)
    }
    pageToken = data.nextPageToken
  }
  while (pageToken)
  // Stable, friendly ordering for the picker UI.
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * Create a GCP project and wait for the operation to finish.
 *
 * Google enforces:
 *  - projectId: 6–30 chars, lowercase letters / digits / hyphens, start with
 *    a letter, globally unique across all GCP
 *  - name: ≤30 chars
 */
export async function createProject(
  accessToken: string,
  projectId: string,
  displayName: string,
  options: { timeoutMs?: number } = {},
): Promise<GcpProject> {
  const op = await gcpFetch<GcpOperation>({
    method: 'POST',
    url: `${CRM_ENDPOINT}/projects`,
    accessToken,
    body: { projectId, name: displayName },
  })
  if (op.error)
    throw new Error(`Project create failed: ${op.error.message} (code ${op.error.code})`)
  if (!isAlreadyDoneOperation(op)) {
    await pollOperation(accessToken, op.name, {
      endpoint: CRM_ENDPOINT,
      timeoutMs: options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    })
  }
  // Fetch the finalized project to return canonical fields.
  return gcpFetch<GcpProject>({
    method: 'GET',
    url: `${CRM_ENDPOINT}/projects/${encodeURIComponent(projectId)}`,
    accessToken,
  })
}

/**
 * Enable an API on a project (idempotent — no-op if already enabled).
 */
export async function enableService(
  accessToken: string,
  projectId: string,
  serviceName: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const op = await gcpFetch<GcpOperation>({
    method: 'POST',
    url: `${SERVICEUSAGE_ENDPOINT}/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceName)}:enable`,
    accessToken,
    body: {},
  })
  if (op.error)
    throw new Error(`Enable ${serviceName} failed: ${op.error.message} (code ${op.error.code})`)
  // Already-enabled services come back as a synthetic `noop.DONE_OPERATION`
  // that can't be GET'ed — short-circuit when the initial response says done.
  if (isAlreadyDoneOperation(op))
    return
  await pollOperation(accessToken, op.name, {
    endpoint: SERVICEUSAGE_ENDPOINT,
    timeoutMs: options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  })
}

/** List all service accounts in a project. */
export async function listServiceAccounts(
  accessToken: string,
  projectId: string,
): Promise<GcpServiceAccount[]> {
  const out: GcpServiceAccount[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${IAM_ENDPOINT}/projects/${encodeURIComponent(projectId)}/serviceAccounts`)
    url.searchParams.set('pageSize', '100')
    if (pageToken)
      url.searchParams.set('pageToken', pageToken)
    const data = await gcpFetch<{
      accounts?: GcpServiceAccount[]
      nextPageToken?: string
    }>({ method: 'GET', url: url.toString(), accessToken })
    out.push(...(data.accounts ?? []))
    pageToken = data.nextPageToken
  }
  while (pageToken)
  return out
}

/** Create a service account. accountId must match `[a-z]([-a-z0-9]*[a-z0-9])` and be 6–30 chars. */
export async function createServiceAccount(args: {
  accessToken: string
  projectId: string
  accountId: string
  displayName?: string
  description?: string
}): Promise<GcpServiceAccount> {
  return gcpFetch<GcpServiceAccount>({
    method: 'POST',
    url: `${IAM_ENDPOINT}/projects/${encodeURIComponent(args.projectId)}/serviceAccounts`,
    accessToken: args.accessToken,
    body: {
      accountId: args.accountId,
      serviceAccount: {
        displayName: args.displayName,
        description: args.description,
      },
    },
  })
}

/**
 * Find an existing service account by email, or create it.
 * Idempotent convenience used during onboarding so re-runs don't error out on
 * "already exists".
 */
export async function ensureServiceAccount(args: {
  accessToken: string
  projectId: string
  accountId: string
  displayName?: string
  description?: string
}): Promise<{ account: GcpServiceAccount, created: boolean }> {
  const existing = await listServiceAccounts(args.accessToken, args.projectId)
  const expectedEmail = `${args.accountId}@${args.projectId}.iam.gserviceaccount.com`
  const match = existing.find(sa => sa.email === expectedEmail)
  if (match)
    return { account: match, created: false }
  const account = await createServiceAccount(args)
  return { account, created: true }
}

/**
 * Create a new JSON key for a service account. The response contains the only
 * copy of the private key material — store it immediately. Google cannot
 * retrieve the key later.
 */
export async function createServiceAccountKey(args: {
  accessToken: string
  projectId: string
  serviceAccountEmail: string
}): Promise<GcpServiceAccountKey> {
  const res = await gcpFetch<{
    name: string
    privateKeyData: string
    privateKeyType?: string
    keyAlgorithm?: string
  }>({
    method: 'POST',
    url: `${IAM_ENDPOINT}/projects/${encodeURIComponent(args.projectId)}/serviceAccounts/${encodeURIComponent(args.serviceAccountEmail)}/keys`,
    accessToken: args.accessToken,
    body: { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' },
  })
  if (!res.privateKeyData)
    throw new Error('Google did not return privateKeyData on the SA key — refusing to continue without the key file')
  return { name: res.name, privateKeyDataBase64: res.privateKeyData }
}

interface PollOperationOptions {
  endpoint: string
  timeoutMs: number
}

/**
 * Poll a Google long-running Operation until `done: true` or the timeout
 * elapses. Different Google APIs host `operations.get` at different base URLs;
 * callers pass the endpoint used for the originating call.
 */
export async function pollOperation(
  accessToken: string,
  operationName: string,
  options: PollOperationOptions,
): Promise<GcpOperation> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const op = await gcpFetch<GcpOperation>({
      method: 'GET',
      url: `${options.endpoint}/${operationName}`,
      accessToken,
    })
    if (op.done) {
      if (op.error)
        throw new Error(`Operation ${operationName} failed: ${op.error.message} (code ${op.error.code})`)
      return op
    }
    if (Date.now() > deadline)
      throw new Error(`Operation ${operationName} did not finish within ${Math.round(options.timeoutMs / 1000)}s`)
    await new Promise(r => setTimeout(r, OPERATION_POLL_INTERVAL_MS))
  }
}

/**
 * Normalize a user-supplied or generated string into a valid GCP project
 * `displayName`. Google's rules (Cloud Resource Manager v1):
 *
 *  - 4–30 characters
 *  - allowed chars: letters, digits, space, hyphen (`-`), apostrophe (`'`),
 *    exclamation (`!`) — periods (`.`) are **not** allowed (appIds like
 *    `com.example.app` must be normalized before submit)
 *  - must start and end with a letter or digit
 *
 * We strip any disallowed character (including em-dashes — which break the
 * CLI's placeholder string literals if not handled here), collapse runs of
 * whitespace, and trim the ends. Falls back to `"Capgo Build"` when the
 * sanitized result would be shorter than 4 chars.
 */
export function sanitizeGcpProjectDisplayName(input: string): string {
  const fallback = 'Capgo Build'
  const allowed = input.replace(/[^A-Z0-9 \-'!]/gi, ' ').replace(/\s+/g, ' ').trim()
  // Must start and end with a letter or digit.
  const trimmed = allowed.replace(/^[^A-Z0-9]+/i, '').replace(/[^A-Z0-9]+$/i, '')
  let result = trimmed.slice(0, 30).replace(/[^A-Z0-9]+$/i, '')
  if (result.length < 4)
    result = fallback
  return result
}

/**
 * Generate a candidate GCP project ID for Capgo onboarding.
 *
 * Rules:
 *  - 6–30 chars
 *  - lowercase letters, digits, hyphens
 *  - must start with a letter, must not end with a hyphen
 *  - globally unique (caller should retry on 409 with a fresh random suffix)
 *
 * We keep the slug short and append a random tail so collisions are rare.
 */
export function generateProjectId(appId: string): string {
  const PREFIX = 'capgo-'
  const MAX = 30
  const SUFFIX_LEN = 6
  const slugMax = MAX - PREFIX.length - 1 - SUFFIX_LEN // 1 = separator hyphen
  const slug = appId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, slugMax)
    .replace(/-+$/, '')
  // Random lowercase alphanumeric suffix (no need for crypto strength — just
  // avoid collisions with prior onboarding runs for the same user).
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789' // drop ambiguous o/0/1/l
  let suffix = ''
  for (let i = 0; i < SUFFIX_LEN; i++)
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  const base = slug ? `${PREFIX}${slug}-${suffix}` : `${PREFIX}${suffix}`
  // Final safety: ensure it starts with a letter (PREFIX guarantees this).
  return base.slice(0, MAX).replace(/-+$/, '')
}

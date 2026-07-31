// Appflow GraphQL + REST client used by the migration. Mirrors the dashboard
// (same User-Agent + Origin). Records a REDACTED request/response trace into the
// onboarding internal log so the support bundle carries the Appflow API trace.
// Secret values (tokens, passwords, cert/keystore bytes, service-account JSON)
// are NEVER written to the log.
//
// Error posture: this is the CREDENTIAL-ACQUISITION path, so rest()/gql() HARD-FAIL
// loudly. A non-2xx response, a GraphQL `errors` payload, or a JSON parse failure
// THROWS an AppflowApiError (carrying the status + a short, redacted body snippet)
// rather than collapsing into undefined/[]. Callers run inside the driver's
// try/catch, which surfaces a visible error step — so a failed certificates /
// distribution / org / app call becomes a real error, NOT a false "no signing
// exists" / "no upload destination" conclusion.
const API = 'https://api.ionicjs.com'
const DASH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0'
const ORIGIN = 'https://dashboard.ionicframework.com'

export const stripDataUri = (s: string): string => (typeof s === 'string' && s.includes('base64,')) ? s.split('base64,')[1] : s
export const bundleIdFromAppIdentifier = (ai: string): string => String(ai || '').split('.').slice(1).join('.') || String(ai || '')

/** Thrown by rest()/gql() on any non-2xx, GraphQL error payload, or parse failure. */
export class AppflowApiError extends Error {
  readonly status: number | string
  constructor(message: string, status: number | string) {
    super(message)
    this.name = 'AppflowApiError'
    this.status = status
  }
}

// Cap any body snippet woven into an error message so a hostile/large response
// body can neither leak large secrets nor blow up the log/summary. Collapses
// whitespace and never includes the raw token (the token is never in a body).
const snippet = (s: unknown, max = 200): string => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// ── credential mappers ───────────────────────────────────────────────────────
// Each mapper OMITS absent fields rather than writing the literal string
// "undefined"/"null": only keys whose source value is actually present are set,
// so hasCreds() and the downstream Record<string,string> contract stay honest.
interface RawIosProvisioningProfile { application_identifier?: string, name?: string, provisioning_profile_file?: string }
interface RawIosSigning { cert_file?: string, cert_password?: string, provisioning_profiles?: RawIosProvisioningProfile[] }
interface RawIosDistribution { user_name?: string, app_specific_password?: string, apple_app_id?: string | number, team_id?: string }
interface RawAndroidSigning { keystore_file?: string, keystore_password?: string, key_password?: string, key_alias?: string }
interface RawAndroidDistribution { json_key_file?: string }

/** Set `key` on `out` only when `value` is a present, non-empty string after mapping. */
function setIfPresent(out: Record<string, string>, key: string, value: string | number | null | undefined, map: (v: string) => string = v => v): void {
  if (value === undefined || value === null)
    return
  const mapped = map(String(value))
  if (mapped.length > 0)
    out[key] = mapped
}

export function mapIosSigning(raw: RawIosSigning | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  setIfPresent(out, 'BUILD_CERTIFICATE_BASE64', raw?.cert_file, stripDataUri)
  setIfPresent(out, 'P12_PASSWORD', raw?.cert_password)
  const profiles = raw?.provisioning_profiles ?? []
  if (profiles.length > 0) {
    const provMap: Record<string, { profile: string, name: string }> = {}
    for (const p of profiles) {
      if (p.provisioning_profile_file === undefined || p.provisioning_profile_file === null)
        continue
      provMap[bundleIdFromAppIdentifier(p.application_identifier ?? '')] = { profile: stripDataUri(p.provisioning_profile_file), name: p.name ?? '' }
    }
    out.CAPGO_IOS_PROVISIONING_MAP = JSON.stringify(provMap)
  }
  return out
}

export function mapIosDistribution(raw: RawIosDistribution | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  setIfPresent(out, 'FASTLANE_USER', raw?.user_name)
  setIfPresent(out, 'FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD', raw?.app_specific_password)
  setIfPresent(out, 'APPLE_APP_ID', raw?.apple_app_id)
  setIfPresent(out, 'APP_STORE_CONNECT_TEAM_ID', raw?.team_id)
  return out
}

export function mapAndroidSigning(raw: RawAndroidSigning | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  setIfPresent(out, 'ANDROID_KEYSTORE_FILE', raw?.keystore_file, stripDataUri)
  setIfPresent(out, 'KEYSTORE_STORE_PASSWORD', raw?.keystore_password)
  setIfPresent(out, 'KEYSTORE_KEY_PASSWORD', raw?.key_password)
  setIfPresent(out, 'KEYSTORE_KEY_ALIAS', raw?.key_alias)
  return out
}

export function mapAndroidDistribution(raw: RawAndroidDistribution | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  setIfPresent(out, 'PLAY_CONFIG_JSON', raw?.json_key_file, stripDataUri)
  return out
}

export const redactTrace = (method: string, url: string, status: number | string, shapeKeys: string[]): string =>
  `appflow ${method} ${url} -> ${status} {${shapeKeys.join(',')}}`

const Q_BOOTSTRAP = `query BootstrapApp { viewer { organizations { edges { node { id name plan memberTotal slug apps { totalCount } } } } } }`
const Q_ORG_APPS = `query OrganizationApps($slug: String!, $first: Int) { organization(slug: $slug) { apps(first: $first) { edges { node { id name slug nativeType } } totalCount } } }`
const Q_CERTS = `query GetDataForPackageCerts($appId: String!) { app(id: $appId) { id name nativeType certificates { edges { node { id name tag type credentials { ios { filename fingerprint notValidAfter subjectCommonName provisioningProfiles { id applicationIdentifier filename } } android { filename fingerprint keyAlias notValidAfter subjectCommonName } } } } } } }`

// Bound every Appflow REST/GraphQL request: a stalled endpoint must fail through
// the existing AppflowApiError path rather than hang the migration forever. The
// timer is always cleared after the request settles. On timeout the abort surfaces
// as a clear "timed out" message, wrapped by rest()/gql() into AppflowApiError.
const APPFLOW_REQUEST_TIMEOUT_MS = 20_000
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, APPFLOW_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  }
  catch (e) {
    if (timedOut)
      throw new Error(`request timed out after ${APPFLOW_REQUEST_TIMEOUT_MS}ms`)
    throw e
  }
  finally {
    clearTimeout(timer)
  }
}

export interface AppflowOrg { id?: string, name?: string, slug: string }
export interface AppflowApp { id: string, name?: string, slug?: string, nativeType?: string }

export function createAppflowApi(token: string, log: (s: string) => void = () => {}) {
  const headers = {
    'User-Agent': DASH_UA,
    Accept: '*/*',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Origin: ORIGIN,
  }
  // REST GET that HARD-FAILS: non-2xx, transport error, or JSON parse failure
  // throws AppflowApiError. Returns the `data` field of a successful response.
  async function rest(path: string): Promise<any> {
    let res: Response
    try {
      res = await fetchWithTimeout(`${API}${path}`, { headers })
    }
    catch (e) {
      log(redactTrace('GET', path, 'network-error', []))
      throw new AppflowApiError(`Appflow GET ${path} failed: ${snippet(e instanceof Error ? e.message : e)}`, 'network-error')
    }
    const text = await res.text().catch(() => '')
    let j: any = null
    try {
      j = text ? JSON.parse(text) : null
    }
    catch {
      log(redactTrace('GET', path, res.status, ['parse-error']))
      throw new AppflowApiError(`Appflow GET ${path} returned ${res.status} with an unparseable body`, res.status)
    }
    log(redactTrace('GET', path, res.status, j?.data ? Object.keys(j.data) : []))
    if (!res.ok)
      throw new AppflowApiError(`Appflow GET ${path} returned HTTP ${res.status}: ${snippet(j?.error?.message ?? j?.message ?? text)}`, res.status)
    return j?.data
  }
  // GraphQL POST that HARD-FAILS: non-2xx, a GraphQL `errors` payload, transport
  // error, or JSON parse failure throws AppflowApiError. Returns `data`.
  async function gql(operationName: string, query: string, variables?: Record<string, unknown>): Promise<any> {
    let res: Response
    try {
      res = await fetchWithTimeout(`${API}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables, operationName }) })
    }
    catch (e) {
      log(redactTrace('POST', `/graphql ${operationName}`, 'network-error', []))
      throw new AppflowApiError(`Appflow GraphQL ${operationName} failed: ${snippet(e instanceof Error ? e.message : e)}`, 'network-error')
    }
    const text = await res.text().catch(() => '')
    let j: any = null
    try {
      j = text ? JSON.parse(text) : null
    }
    catch {
      log(redactTrace('POST', `/graphql ${operationName}`, res.status, ['parse-error']))
      throw new AppflowApiError(`Appflow GraphQL ${operationName} returned ${res.status} with an unparseable body`, res.status)
    }
    log(redactTrace('POST', `/graphql ${operationName}`, res.status, j?.data ? Object.keys(j.data) : []))
    if (!res.ok)
      throw new AppflowApiError(`Appflow GraphQL ${operationName} returned HTTP ${res.status}: ${snippet(j?.errors?.[0]?.message ?? text)}`, res.status)
    if (Array.isArray(j?.errors) && j.errors.length > 0)
      throw new AppflowApiError(`Appflow GraphQL ${operationName} returned errors: ${snippet(j.errors[0]?.message)}`, res.status)
    return j?.data
  }
  return {
    async listOrgs(): Promise<AppflowOrg[]> {
      const d = await gql('BootstrapApp', Q_BOOTSTRAP)
      return (d?.viewer?.organizations?.edges || []).map((e: any) => e.node)
    },
    async listApps(slug: string): Promise<AppflowApp[]> {
      // Lower-risk than cursor pagination (the query exposes no pageInfo/endCursor):
      // raise the cap well past any realistic org size and LOG when totalCount shows
      // the org has more apps than we fetched, so a truncation is visible in the
      // support log instead of silently dropping apps.
      const LIST_APPS_CAP = 500
      const d = await gql('OrganizationApps', Q_ORG_APPS, { slug, first: LIST_APPS_CAP })
      const edges = d?.organization?.apps?.edges || []
      const totalCount = d?.organization?.apps?.totalCount
      if (typeof totalCount === 'number' && totalCount > edges.length)
        log(`appflow listApps: org ${slug} has ${totalCount} apps but only ${edges.length} were fetched (cap ${LIST_APPS_CAP}) — some apps are not shown`)
      return edges.map((e: any) => e.node)
    },
    async listCertificates(appId: string): Promise<any[]> {
      const d = await gql('GetDataForPackageCerts', Q_CERTS, { appId })
      return (d?.app?.certificates?.edges || []).map((e: any) => e.node)
    },
    async listDistribution(appId: string): Promise<any[]> {
      return (await rest(`/apps/${encodeURIComponent(appId)}/distribution-credentials`)) || []
    },
    async fetchIosSigning(appId: string, tag: string): Promise<Record<string, string>> {
      return mapIosSigning(await rest(`/apps/${encodeURIComponent(appId)}/profiles/${encodeURIComponent(tag)}/credentials/ios`))
    },
    async fetchAndroidSigning(appId: string, tag: string): Promise<Record<string, string>> {
      return mapAndroidSigning(await rest(`/apps/${encodeURIComponent(appId)}/profiles/${encodeURIComponent(tag)}/credentials/android`))
    },
    async fetchIosDistribution(appId: string, id: number | string): Promise<Record<string, string>> {
      return mapIosDistribution(await rest(`/apps/${encodeURIComponent(appId)}/distribution-credentials/${encodeURIComponent(String(id))}?fields=app_specific_password`))
    },
    async fetchAndroidDistribution(appId: string, id: number | string): Promise<Record<string, string>> {
      return mapAndroidDistribution(await rest(`/apps/${encodeURIComponent(appId)}/distribution-credentials/${encodeURIComponent(String(id))}?fields=json_key_file`))
    },
  }
}

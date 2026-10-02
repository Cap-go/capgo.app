import type { Context } from 'hono'
import { SSO_ATTRIBUTE_CLAIM_PREFIX } from '../private/sso/role-mapping.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getEnv } from './utils.ts'
import { consoleSamlConfig, consoleSsoURL, fetchConsoleSamlMetadata, withConsoleSsoDatabase } from './console_sso.ts'

interface ManagementAttributeMapping { keys: Record<string, { name?: string, names?: string[], array?: boolean, default?: unknown }> }

// Shape returned by the Management API (GetProviderResponse).
export interface SSOProviderResponse {
  id: string
  saml?: {
    entity_id: string
    metadata_url?: string
    metadata_xml?: string
    attribute_mapping?: ManagementAttributeMapping
  }
  domains?: Array<{ domain: string }>
  created_at?: string
  updated_at?: string
}

// Fields of a provider that PUT can set back to a previous state.
export interface SSOProviderSnapshot {
  metadata_url?: string
  metadata_xml?: string
  attribute_mapping?: ManagementAttributeMapping
  domains: string[]
}

export interface SSOProviderUpdate {
  // [] removes every domain: sign-in by domain stops, the provider remains.
  domains?: string[]
  metadata_url?: string
  attribute_mapping?: Record<string, string>
}

export type SSOMetadataSource = { metadata_url: string } | { metadata_xml: string }

export class ManagementAPIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message)
    this.name = 'ManagementAPIError'
  }
}

function getProjectRef(c: Context): string | null {
  const supabaseDbUrl = getEnv(c, 'MAIN_SUPABASE_DB_URL')
  if (!supabaseDbUrl)
    return null

  try {
    const dbUrl = new URL(supabaseDbUrl)

    // Direct Supabase connections use db.<project-ref>.supabase.co.
    const hostParts = dbUrl.hostname.split('.')
    if (hostParts[0] === 'db' && hostParts[1])
      return hostParts[1]

    // Pooled connections may encode the project ref in the username, e.g. postgres.<project-ref>.
    const usernameParts = dbUrl.username.split('.')
    if (usernameParts.length > 1 && usernameParts[1])
      return usernameParts[1]
  }
  catch {
    return null
  }

  return null
}

const MANAGEMENT_API_TIMEOUT_MS = 8_000

async function callManagementAPI(
  c: Context,
  method: string,
  path: string,
  body?: any,
): Promise<any> {
  const token = getEnv(c, 'SB_MANAGEMENT_API_TOKEN')
  const projectRef = getProjectRef(c)

  if (!token) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'SB_MANAGEMENT_API_TOKEN not configured',
    })
    throw new ManagementAPIError(500, 'management_api_not_configured', 'Management API token not configured')
  }

  if (!projectRef) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'SUPABASE_DB_URL not configured or invalid',
    })
    throw new ManagementAPIError(500, 'project_ref_not_configured', 'Project reference not configured')
  }

  const url = `https://api.supabase.com/v1/projects/${projectRef}${path}`

  const options: RequestInit = {
    method,
    // Callers can hold a provider row lock across this call: fail fast
    // instead of relying on database timeouts.
    signal: AbortSignal.timeout(MANAGEMENT_API_TIMEOUT_MS),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Calling Supabase Management API',
      method,
      path,
    })

    const response = await fetch(url, options)

    if (!response.ok) {
      let errorData: any = {}
      try {
        errorData = await response.json()
      }
      catch { }
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Management API error',
        status: response.status,
        path,
        method,
        errorCode: errorData?.error_code || 'unknown',
        errorData,
      })
      throw new ManagementAPIError(
        response.status,
        errorData?.error_code || 'management_api_error',
        errorData?.message || `Management API returned ${response.status}`,
        errorData,
      )
    }

    // Handle empty responses (e.g., 204 No Content) - don't attempt to parse JSON
    const contentType = response.headers.get('content-type') || ''
    const hasBody = response.status !== 204
      && response.headers.get('content-length') !== '0'
      && contentType.includes('application/json')

    let data: any = null
    if (hasBody) {
      data = await response.json()
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'Management API call successful',
      method,
      path,
      status: response.status,
      hasBody,
    })
    return data
  }
  catch (error) {
    if (error instanceof ManagementAPIError) {
      throw error
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Management API fetch error',
      path,
      method,
      error: error instanceof Error ? error.message : String(error),
    })
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw new ManagementAPIError(
      timedOut ? 504 : 500,
      timedOut ? 'management_api_timeout' : 'management_api_fetch_error',
      'Failed to call Management API',
      error instanceof Error ? { message: error.message } : {},
    )
  }
}

// Multi-valued SAML attributes must be captured as arrays, otherwise Supabase
// Auth keeps only the first value.
const ARRAY_ATTRIBUTE_KEYS = new Set(['groups'])
const isArrayAttributeKey = (key: string) => ARRAY_ATTRIBUTE_KEYS.has(key) || key.startsWith(SSO_ATTRIBUTE_CLAIM_PREFIX)

function toManagementAttributeMapping(mapping: Record<string, string>): { keys: Record<string, { name: string, array?: boolean }> } {
  const keys: Record<string, { name: string, array?: boolean }> = {}
  for (const [key, name] of Object.entries(mapping)) {
    keys[key] = isArrayAttributeKey(key) ? { name, array: true } : { name }
  }
  return { keys }
}

function usesConsoleSso(c: Context) {
  return c.get('auth')?.claims?.auth_provider === 'better-auth'
}

async function readConsoleSso(c: Context, id: string): Promise<SSOProviderResponse> {
  return withConsoleSsoDatabase(c, async (pool) => {
    const { rows } = await pool.query('SELECT * FROM public.console_auth_sso_provider WHERE "providerId" = $1', [id])
    if (!rows[0])
      throw new ManagementAPIError(404, 'provider_not_found', 'SSO provider not found')
    const row = rows[0]
    const config = JSON.parse(row.samlConfig)
    const mapping = { ...config.mapping?.extraFields, email: config.mapping?.email, name: config.mapping?.name,
      first_name: config.mapping?.firstName, last_name: config.mapping?.lastName }
    return { id, saml: { entity_id: config.issuer, metadata_xml: config.idpMetadata.metadata,
      attribute_mapping: { keys: Object.fromEntries(Object.entries(mapping).filter(([, name]) => typeof name === 'string').map(([key, name]) => [key, { name: name as string }])) } },
    domains: row.domain ? [{ domain: row.domain }] : [] }
  })
}

async function writeConsoleSso(c: Context, id: string, domain: string, metadata: SSOMetadataSource, mapping?: Record<string, string>) {
  const config = consoleSamlConfig(consoleSsoURL(c), id, await fetchConsoleSamlMetadata(metadata), mapping)
  await withConsoleSsoDatabase(c, async (pool) => {
    await pool.query(`UPDATE public.console_auth_sso_provider SET domain = $2, issuer = $3, "samlConfig" = $4 WHERE "providerId" = $1`, [id, domain, config.issuer, JSON.stringify(config)])
  })
  return readConsoleSso(c, id)
}

export async function createSSOProvider(
  c: Context,
  domain: string,
  metadata: SSOMetadataSource,
  attributeMapping?: Record<string, string>,
): Promise<SSOProviderResponse> {
  if (usesConsoleSso(c)) {
    const id = c.req.param('id') ?? crypto.randomUUID()
    const config = consoleSamlConfig(consoleSsoURL(c), id, await fetchConsoleSamlMetadata(metadata), attributeMapping)
    await withConsoleSsoDatabase(c, async (pool) => {
      const provider = await pool.query('SELECT org_id FROM public.sso_providers WHERE id = $1::uuid', [id])
      await pool.query(`INSERT INTO public.console_auth_sso_provider (id, "providerId", "userId", "organizationId", domain, issuer, "samlConfig")
        VALUES ($1, $1, $2, $3, $4, $5, $6)`, [id, c.get('auth').userId, provider.rows[0]?.org_id, domain, config.issuer, JSON.stringify(config)])
    })
    return readConsoleSso(c, id)
  }
  const body = {
    type: 'saml',
    domains: [domain],
    ...metadata,
    ...(attributeMapping && { attribute_mapping: toManagementAttributeMapping(attributeMapping) }),
  }

  const response = await callManagementAPI(c, 'POST', '/config/auth/sso/providers', body)
  return response as SSOProviderResponse
}

export async function getSSOProvider(
  c: Context,
  providerId: string,
): Promise<SSOProviderResponse> {
  if (usesConsoleSso(c))
    return readConsoleSso(c, providerId)
  const response = await callManagementAPI(c, 'GET', `/config/auth/sso/providers/${providerId}`)
  return response as SSOProviderResponse
}

export async function updateSSOProvider(
  c: Context,
  providerId: string,
  updates: Partial<SSOProviderUpdate>,
): Promise<SSOProviderResponse> {
  if (usesConsoleSso(c)) {
    const previous = await readConsoleSso(c, providerId)
    const previousMapping = Object.fromEntries(Object.entries(previous.saml?.attribute_mapping?.keys ?? {}).filter(([, value]) => value.name).map(([key, value]) => [key, value.name!]))
    return writeConsoleSso(c, providerId, updates.domains?.[0] ?? (updates.domains ? '' : previous.domains?.[0]?.domain ?? ''),
      updates.metadata_url ? { metadata_url: updates.metadata_url } : { metadata_xml: previous.saml!.metadata_xml! }, updates.attribute_mapping ?? previousMapping)
  }
  const body: any = {}

  if (updates.domains !== undefined) {
    body.domains = updates.domains
  }
  if (updates.metadata_url) {
    body.metadata_url = updates.metadata_url
  }
  if (updates.attribute_mapping) {
    body.attribute_mapping = toManagementAttributeMapping(updates.attribute_mapping)
  }

  const response = await callManagementAPI(c, 'PUT', `/config/auth/sso/providers/${providerId}`, body)
  return response as SSOProviderResponse
}

export async function snapshotSSOProvider(c: Context, providerId: string): Promise<SSOProviderSnapshot> {
  const provider = await getSSOProvider(c, providerId)
  return {
    // The API accepts one metadata source; the URL wins when both are echoed.
    ...(provider.saml?.metadata_url ? { metadata_url: provider.saml.metadata_url } : provider.saml?.metadata_xml ? { metadata_xml: provider.saml.metadata_xml } : {}),
    ...(provider.saml?.attribute_mapping ? { attribute_mapping: provider.saml.attribute_mapping } : {}),
    // Always explicit: [] must be restored too, to undo a re-activation.
    domains: provider.domains?.map(entry => entry.domain) ?? [],
  }
}

export async function restoreSSOProvider(c: Context, providerId: string, snapshot: SSOProviderSnapshot): Promise<void> {
  if (usesConsoleSso(c)) {
    const mapping = Object.fromEntries(Object.entries(snapshot.attribute_mapping?.keys ?? {}).filter(([, value]) => value.name).map(([key, value]) => [key, value.name!]))
    await writeConsoleSso(c, providerId, snapshot.domains[0] ?? '', snapshot.metadata_url ? { metadata_url: snapshot.metadata_url } : { metadata_xml: snapshot.metadata_xml! }, mapping)
    return
  }
  await callManagementAPI(c, 'PUT', `/config/auth/sso/providers/${providerId}`, snapshot)
}

export async function deleteSSOProvider(
  c: Context,
  providerId: string,
): Promise<void> {
  if (usesConsoleSso(c)) {
    await withConsoleSsoDatabase(c, pool => pool.query('DELETE FROM public.console_auth_sso_provider WHERE "providerId" = $1', [providerId]))
    return
  }
  await callManagementAPI(c, 'DELETE', `/config/auth/sso/providers/${providerId}`)
}

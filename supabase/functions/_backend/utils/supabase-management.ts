import type { Context } from 'hono'
import { cloudlog, cloudlogErr } from './logging.ts'
import { getEnv } from './utils.ts'

export interface SSOProviderResponse {
  id: string
  type: 'saml'
  domains: string[]
  metadata_url?: string
  attribute_mapping?: Record<string, string>
  disabled?: boolean
  created_at: string
  updated_at: string
}

export interface SSOProviderUpdate {
  domains?: string[]
  metadata_url?: string
  attribute_mapping?: Record<string, string>
  disabled?: boolean
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
    throw new ManagementAPIError(
      500,
      'management_api_fetch_error',
      'Failed to call Management API',
      error instanceof Error ? { message: error.message } : {},
    )
  }
}

function toManagementAttributeMapping(mapping: Record<string, string>): { keys: Record<string, { name: string }> } {
  const keys: Record<string, { name: string }> = {}
  for (const [key, name] of Object.entries(mapping)) {
    keys[key] = { name }
  }
  return { keys }
}

export async function createSSOProvider(
  c: Context,
  domain: string,
  metadata: SSOMetadataSource,
  attributeMapping?: Record<string, string>,
): Promise<SSOProviderResponse> {
  // Created disabled: Supabase Auth must not accept logins for this domain until
  // DNS ownership is proven and the org admin activates the provider.
  const body = {
    type: 'saml',
    domains: [domain],
    disabled: true,
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
  const response = await callManagementAPI(c, 'GET', `/config/auth/sso/providers/${providerId}`)
  return response as SSOProviderResponse
}

export async function updateSSOProvider(
  c: Context,
  providerId: string,
  updates: Partial<SSOProviderUpdate>,
): Promise<SSOProviderResponse> {
  const body: any = {}

  if (updates.domains) {
    body.domains = updates.domains
  }
  if (updates.metadata_url) {
    body.metadata_url = updates.metadata_url
  }
  if (updates.attribute_mapping) {
    body.attribute_mapping = toManagementAttributeMapping(updates.attribute_mapping)
  }
  if (updates.disabled !== undefined) {
    body.disabled = updates.disabled
  }

  const response = await callManagementAPI(c, 'PATCH', `/config/auth/sso/providers/${providerId}`, body)
  return response as SSOProviderResponse
}

export async function deleteSSOProvider(
  c: Context,
  providerId: string,
): Promise<void> {
  await callManagementAPI(c, 'DELETE', `/config/auth/sso/providers/${providerId}`)
}

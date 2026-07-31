import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/supabase.types'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process, { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { Pool } from 'pg'

function normalizePostgresUrl(raw: string): string {
  // Avoid Node preferring IPv6 (::1) for localhost in some environments.
  return raw.replace('localhost', '127.0.0.1')
}

function getPostgresUrlFromEnv(): string {
  return normalizePostgresUrl(
    env.SUPABASE_DB_URL
    ?? env.DB_URL
    ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  )
}

export let POSTGRES_URL = getPostgresUrlFromEnv()

export function normalizeLocalhostUrl(raw: string | undefined): string | undefined {
  if (!raw)
    return raw
  try {
    const url = new URL(raw)
    if (url.hostname === 'localhost')
      url.hostname = '127.0.0.1'
    // Keep a stable base URL without trailing slash.
    return url.toString().replace(/\/$/, '')
  }
  catch {
    // Best-effort: keep behavior for non-standard values.
    return raw.replace('localhost', '127.0.0.1')
  }
}

// Determine which backend to use based on environment variable
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

// For Cloudflare Workers, we need to determine the correct URL based on the endpoint
// API endpoints go to CLOUDFLARE_API_URL, plugin endpoints go to CLOUDFLARE_PLUGIN_URL
export const CLOUDFLARE_API_URL = env.CLOUDFLARE_API_URL ?? 'http://127.0.0.1:8787'
export const CLOUDFLARE_PLUGIN_URL = env.CLOUDFLARE_PLUGIN_URL ?? 'http://127.0.0.1:8788'
export const CLOUDFLARE_FILES_URL = env.CLOUDFLARE_FILES_URL ?? 'http://127.0.0.1:8789'

function parseSupabaseStatusJson(mixed: string): Record<string, string> {
  const idx = mixed.indexOf('{')
  if (idx < 0)
    throw new Error('Failed to parse Supabase status output')

  return JSON.parse(mixed.slice(idx)) as Record<string, string>
}

function getLocalSupabaseStatus() {
  return spawnSync('bun', ['scripts/supabase-worktree.ts', 'status', '-o', 'json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  })
}

function hydrateLocalSupabaseEnvFromStatus(): void {
  try {
    if (USE_CLOUDFLARE)
      return

    const currentSupabaseUrl = normalizeLocalhostUrl(env.SUPABASE_URL) ?? ''
    const currentAnonKey = env.SUPABASE_ANON_KEY ?? ''
    const existingServiceKey = env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY ?? ''
    const currentDbUrl = env.SUPABASE_DB_URL ?? env.DB_URL ?? ''
    if (currentSupabaseUrl && currentAnonKey && existingServiceKey && currentDbUrl)
      return

    let status = getLocalSupabaseStatus()

    if ((status.status ?? 1) !== 0) {
      const start = spawnSync('bun', ['run', 'supabase:start'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
      })

      if ((start.status ?? 1) !== 0)
        return

      status = getLocalSupabaseStatus()
    }

    if ((status.status ?? 1) !== 0)
      return

    try {
      const parsed = parseSupabaseStatusJson(status.stdout || '')
      const supabaseUrl = normalizeLocalhostUrl(parsed.API_URL)
      const dbUrl = parsed.DB_URL ? normalizePostgresUrl(parsed.DB_URL) : undefined
      const anonKey = parsed.ANON_KEY || parsed.PUBLISHABLE_KEY
      const serviceKey = parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY

      if (supabaseUrl)
        env.SUPABASE_URL = supabaseUrl
      if (dbUrl) {
        env.SUPABASE_DB_URL = dbUrl
        env.DB_URL = dbUrl
      }
      if (anonKey)
        env.SUPABASE_ANON_KEY = anonKey
      if (serviceKey) {
        env.SUPABASE_SERVICE_ROLE_KEY = serviceKey
        env.SUPABASE_SERVICE_KEY = serviceKey
      }
    }
    catch {
      // Keep the existing environment when status output is unavailable or malformed.
    }
  }
  finally {
    POSTGRES_URL = getPostgresUrlFromEnv()
  }
}

hydrateLocalSupabaseEnvFromStatus()

// Default to Supabase Edge Functions for backward compatibility
export const SUPABASE_BASE_URL = normalizeLocalhostUrl(env.SUPABASE_URL) ?? ''
export const BASE_URL = USE_CLOUDFLARE ? CLOUDFLARE_API_URL : `${SUPABASE_BASE_URL}/functions/v1`
export const PLUGIN_BASE_URL = USE_CLOUDFLARE ? CLOUDFLARE_PLUGIN_URL : `${SUPABASE_BASE_URL}/functions/v1`
export const API_SECRET = 'testsecret'
export const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY ?? ''

/**
 * Get the correct base URL for an endpoint based on whether it's a plugin endpoint or API endpoint
 * Plugin endpoints: /updates, /channel_self, /stats, /ok, /latency
 * All other endpoints go to the API worker
 */
export function getEndpointUrl(path: string): string {
  if (!USE_CLOUDFLARE) {
    // In CI, Node/Undici prefers IPv6 for localhost (::1). Supabase Edge runtime
    // is bound to IPv4 (127.0.0.1) in the workflow, so normalize to IPv4.
    return `${SUPABASE_BASE_URL}/functions/v1${path}`
  }

  // Files endpoints (separate worker in Cloudflare)
  const filesEndpoints = ['/files', '/private/upload_link', '/private/download_link', '/private/files']
  const isFilesEndpoint = filesEndpoints.some(endpoint => path.startsWith(endpoint))
  if (isFilesEndpoint)
    return `${CLOUDFLARE_FILES_URL}${path}`

  // Plugin endpoints
  const pluginEndpoints = ['/updates', '/channel_self', '/stats', '/ok', '/latency', '/plugin/']
  const isPluginEndpoint = pluginEndpoints.some(endpoint => path.startsWith(endpoint))

  return isPluginEndpoint ? `${CLOUDFLARE_PLUGIN_URL}${path}` : `${CLOUDFLARE_API_URL}${path}`
}
export const APIKEY_TEST_ALL = 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea' // all key
export const APIKEY_TEST_UPLOAD = 'c591b04e-cf29-4945-b9a0-776d0672061b' // upload key
export const APIKEY_TEST2_ALL = 'ac4d9a98-ec25-4af8-933c-2aae4aa52b85' // test2 all key (dedicated for statistics)
export const APIKEY_TEST_HASHED = 'test-hashed-apikey-for-auth-test' // hashed key (plain value, stored as SHA-256 hash in DB)
export const APIKEY_TEST_ORG_SUPER_ADMIN = APIKEY_TEST_ALL
export const APIKEY_TEST_APP_UPLOADER = APIKEY_TEST_UPLOAD
export const APIKEY_TEST2_ORG_SUPER_ADMIN = APIKEY_TEST2_ALL
export const USER_ID_APIKEY_MANAGEMENT = 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506'
export const USER_EMAIL_APIKEY_MANAGEMENT = 'apikey-management@capgo.app'
export const ORG_ID_APIKEY_MANAGEMENT = 'f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50'
export const APIKEY_MANAGEMENT_ORG_SUPER_ADMIN = 'c9d0e1f2-a3b4-4c5d-8e6f-7a8b9c0d1e25'
export const APIKEY_MANAGEMENT_APIKEY_MANAGER = 'd1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6'
export const APIKEY_MANAGEMENT_APIKEY_MANAGER_ID = 113
export const ORG_ID = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
export const STRIPE_INFO_CUSTOMER_ID = 'cus_Q38uE91NP8Ufqc' // Customer ID for ORG_ID
export const NON_OWNER_ORG_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
export const USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'
export const USER_ID_2 = '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5'
export const ORG_ID_2 = '34a8c55d-2d0f-4652-a43f-684c7a9403ac' // Test2 org owned by USER_ID_2
export const STRIPE_INFO_CUSTOMER_ID_2 = 'cus_Pa0f3M6UCQ8g5Q' // Customer ID for ORG_ID_2
// Dedicated data for email preference tests (isolated to prevent interference)
export const USER_ID_EMAIL_PREFS = '9f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5061'
export const USER_EMAIL_EMAIL_PREFS = 'emailprefs@capgo.app'
export const USER_ID_APIKEY_EXPIRATION = 'af1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5062'
export const USER_EMAIL_APIKEY_EXPIRATION = 'apikey-expiration@capgo.app'
export const USER_ID_DELETE_USER_STALE = 'b7a1d9f4-7b8f-4e3c-8f2b-1a2b3c4d5e6f'
export const USER_EMAIL_DELETE_USER_STALE = 'delete-user-stale@capgo.app'
export const USER_ID_DELETE_USER_FRESH = 'c8b2e0f5-8c90-4f4d-9f3c-2b3c4d5e6f70'
export const USER_EMAIL_DELETE_USER_FRESH = 'delete-user-fresh@capgo.app'
export const ORG_ID_EMAIL_PREFS = 'aa1b2c3d-4e5f-4a60-9b7c-1d2e3f4a5061'
export const STRIPE_CUSTOMER_ID_EMAIL_PREFS = 'cus_email_prefs_test_123'
// Dedicated data for cron/queue tests (isolated per file)
export const ORG_ID_CRON_APP = 'b1c2d3e4-f5a6-4b70-8c9d-0e1f2a3b4c5d'
export const STRIPE_CUSTOMER_ID_CRON_APP = 'cus_cron_app_test_123'
export const ORG_ID_CRON_INTEGRATION = 'c2d3e4f5-a6b7-4c80-9d0e-1f2a3b4c5d6e'
export const STRIPE_CUSTOMER_ID_CRON_INTEGRATION = 'cus_cron_integration_test_123'
export const ORG_ID_CRON_QUEUE = 'd3e4f5a6-b7c8-4d90-8e1f-2a3b4c5d6e7f'
export const STRIPE_CUSTOMER_ID_CRON_QUEUE = 'cus_cron_queue_test_123'
// Dedicated data for overage tracking tests (isolated)
export const ORG_ID_OVERAGE = 'e4f5a6b7-c8d9-4ea0-9f1a-2b3c4d5e6f70'
export const STRIPE_CUSTOMER_ID_OVERAGE = 'cus_overage_test_123'
export const USER_ID_STATS = '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d' // Dedicated user for statistics tests
export const ORG_ID_STATS = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' // Dedicated org for statistics tests
export const APIKEY_STATS = '8b2c3d4e-5f6a-4c7b-8d9e-0f1a2b3c4d5e' // Dedicated API key for statistics tests
export const APP_NAME_STATS = 'com.stats.app' // Dedicated app for statistics tests
// Dedicated data for hashed-apikey-rls tests (isolated to prevent interference with API key tests)
export const USER_ID_RLS = '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
export const ORG_ID_RLS = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f'
export const APIKEY_RLS_ALL = '9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
export const APP_NAME_RLS = 'com.rls.app'
// Dedicated org for 2FA enforcement toggles in hashed-apikey-rls tests
export const ORG_ID_2FA_TEST = 'd5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f80'
export const STRIPE_CUSTOMER_ID_2FA_TEST = 'cus_2fa_rls_test_123'
export const PLAN_ORG_ID = '0f2f8c2a-6a1d-4a6c-a9a8-b1b2c3d4e5f6'
export const PLAN_STRIPE_CUSTOMER_ID = 'cus_plan_test_123456'
// Dedicated data for build_time_tracking tests (isolated to prevent interference)
// Note: UUIDs must be valid RFC 4122 (version 4 has variant bits 8-b at position 19)
export const BUILD_TIME_ORG_ID = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f'
export const BUILD_TIME_STRIPE_CUSTOMER_ID = 'cus_build_time_test_123'
// Dedicated data for bundle-semver-validation tests (isolated to prevent interference)
export const SEMVER_ORG_ID = 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80'
export const SEMVER_STRIPE_CUSTOMER_ID = 'cus_semver_test_123'
// Dedicated data for private-error-cases tests (isolated to prevent interference)
// This org intentionally has NO customer_id to test error cases
export const PRIVATE_ERROR_ORG_ID = 'e5f6a7b8-c9d0-4e1f-9a2b-3c4d5e6f7a82'
// Dedicated data for cli-hashed-apikey tests (isolated to prevent interference)
export const CLI_HASHED_USER_ID = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81'
export const CLI_HASHED_ORG_ID = 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b92'
export const CLI_HASHED_APIKEY = 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c03'
export const CLI_HASHED_STRIPE_CUSTOMER_ID = 'cus_cli_hashed_test_123'
// Dedicated data for encrypted bundles tests (isolated to prevent interference)
export const USER_ID_ENCRYPTED = 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193'
export const ORG_ID_ENCRYPTED = 'a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9ca4'
export const APIKEY_ENCRYPTED = 'b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d14'
export const APP_NAME_ENCRYPTED = 'com.encrypted.app'
export const STRIPE_CUSTOMER_ID_ENCRYPTED = 'cus_encrypted_test_123'
export const USER_EMAIL = 'test@capgo.app'
export const USER_PASSWORD = 'testtest'
export const USER_PASSWORD_HASH = '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi'
export const TEST_EMAIL = 'test@test.com'
export const USER_ID_NONMEMBER = '11111111-1111-4111-8111-111111111110'
export const USER_EMAIL_NONMEMBER = 'nonmember@capgo.app'
export const USER_PASSWORD_NONMEMBER = 'testtest'
export const PRODUCT_ID = 'prod_LQIregjtNduh4q'
export const USER_ADMIN_EMAIL = 'admin@capgo.app'
export const APP_NAME = 'com.demo'
export const NON_ACCESS_APP_NAME = 'com.demoadmin.app'
export const headers = {
  'Content-Type': 'application/json',
  'Authorization': APIKEY_TEST_ALL,
}

interface ApiKeyBinding {
  role_name: string
  scope_type: 'org' | 'app' | 'channel'
  org_id: string
  app_id?: string | null
  channel_id?: string | number | null
  reason?: string
}

export function orgApiKeyBindings(orgId = ORG_ID, roleName = 'org_admin'): ApiKeyBinding[] {
  return [{
    role_name: roleName,
    scope_type: 'org',
    org_id: orgId,
  }]
}

export async function appApiKeyBindings(appId: string, roleName = 'app_admin'): Promise<ApiKeyBinding[]> {
  const { data, error } = await getSupabaseClient()
    .from('apps')
    .select('id, owner_org')
    .eq('app_id', appId)
    .single()

  if (error || !data?.id || !data.owner_org)
    throw error ?? new Error(`Unable to resolve app ${appId}`)

  return [{
    role_name: roleName,
    scope_type: 'app',
    org_id: data.owner_org,
    app_id: data.id,
  }]
}

export async function createDirectApiKeyWithBindings(options: {
  userId?: string
  key: string
  name: string
  orgId: string
  roleName?: string
  appId?: string
  appRoleName?: string
  expiresAt?: string | null
  hashed?: boolean
}) {
  const supabase = getSupabaseClient()
  let apiKey: {
    id: number
    key: string | null
    rbac_id: string
    user_id: string
    expires_at: string | null
  } | null = null

  if (options.hashed) {
    const [insertedKey] = await executeSQL(
      `INSERT INTO public.apikeys (user_id, key, key_hash, name, expires_at)
       VALUES ($1, NULL, encode(extensions.digest($2, 'sha256'), 'hex'), $3, $4)
       RETURNING id, key, rbac_id, user_id, expires_at`,
      [options.userId ?? USER_ID, options.key, options.name, options.expiresAt ?? null],
    )
    apiKey = insertedKey
      ? {
          id: Number(insertedKey.id),
          key: insertedKey.key,
          rbac_id: insertedKey.rbac_id,
          user_id: insertedKey.user_id,
          expires_at: insertedKey.expires_at,
        }
      : null
  }
  else {
    const { data, error: apiKeyError } = await supabase
      .from('apikeys')
      .insert({
        user_id: options.userId ?? USER_ID,
        key: options.key,
        key_hash: null,
        name: options.name,
        expires_at: options.expiresAt ?? null,
      })
      .select('id, key, rbac_id, user_id, expires_at')
      .single()

    if (apiKeyError)
      throw apiKeyError

    apiKey = data
  }

  if (!apiKey)
    throw new Error('Unable to create API key')

  try {
    const bindingRows: Database['public']['Tables']['role_bindings']['Insert'][] = []
    const { data: orgRole, error: orgRoleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', options.roleName ?? 'org_admin')
      .single()
    if (orgRoleError || !orgRole)
      throw orgRoleError ?? new Error('Unable to resolve org role')

    bindingRows.push({
      principal_type: 'apikey',
      principal_id: apiKey.rbac_id,
      role_id: orgRole.id,
      scope_type: 'org',
      org_id: options.orgId,
      granted_by: apiKey.user_id,
      reason: 'Test API key binding',
      is_direct: true,
    })

    if (options.appId) {
      const { data: app, error: appError } = await supabase
        .from('apps')
        .select('id, owner_org')
        .eq('app_id', options.appId)
        .single()
      if (appError || !app?.id || !app.owner_org)
        throw appError ?? new Error(`Unable to resolve app ${options.appId}`)
      if (app.owner_org !== options.orgId)
        throw new Error(`App ${options.appId} belongs to org ${app.owner_org}, expected ${options.orgId}`)

      const { data: appRole, error: appRoleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', options.appRoleName ?? 'app_admin')
        .single()
      if (appRoleError || !appRole)
        throw appRoleError ?? new Error('Unable to resolve app role')

      bindingRows.push({
        principal_type: 'apikey',
        principal_id: apiKey.rbac_id,
        role_id: appRole.id,
        scope_type: 'app',
        org_id: options.orgId,
        app_id: app.id,
        granted_by: apiKey.user_id,
        reason: 'Test API key app binding',
        is_direct: true,
      })
    }

    const { error: bindingError } = await supabase
      .from('role_bindings')
      .insert(bindingRows)
    if (bindingError)
      throw bindingError

    return apiKey
  }
  catch (error) {
    const { error: cleanupError } = await supabase.from('apikeys').delete().eq('id', apiKey.id)
    if (cleanupError)
      console.warn(`Failed to clean up API key ${apiKey.id} after binding setup error:`, cleanupError)
    throw error
  }
}

let cachedAuthHeaders: Record<string, string> | null = null
let authHeadersPromise: Promise<Record<string, string>> | null = null

async function signInAndBuildAuthHeaders(email: string, password: string): Promise<Record<string, string>> {
  hydrateLocalSupabaseEnvFromStatus()

  const supabaseBaseUrl = normalizeLocalhostUrl(env.SUPABASE_URL) ?? SUPABASE_BASE_URL
  const supabaseAnonKey = env.SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY

  if (!supabaseBaseUrl || !supabaseAnonKey) {
    throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY is missing for auth headers')
  }

  const supabase = createClient<Database>(supabaseBaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
    },
  })

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error || !data.session?.access_token) {
    throw error ?? new Error('Unable to obtain JWT for tests')
  }

  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${data.session.access_token}`,
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (cachedAuthHeaders) {
    return cachedAuthHeaders
  }
  if (authHeadersPromise) {
    return authHeadersPromise
  }

  authHeadersPromise = (async () => {
    try {
      cachedAuthHeaders = await signInAndBuildAuthHeaders(USER_EMAIL, USER_PASSWORD)
      return cachedAuthHeaders
    }
    catch (err) {
      cachedAuthHeaders = null
      authHeadersPromise = null
      throw err
    }
  })()

  return authHeadersPromise
}

export async function getAuthHeadersForCredentials(email: string, password: string): Promise<Record<string, string>> {
  return signInAndBuildAuthHeaders(email, password)
}
export const headersStats = {
  'Content-Type': 'application/json',
  'Authorization': APIKEY_STATS,
}
export const headersInternal = {
  'Content-Type': 'application/json',
  'apisecret': API_SECRET,
}

/**
 * Send one request. A transient failure is test evidence, not a reason to rerun it.
 */
export async function fetchTestRequest(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(url, options)
}

// Cache for prepared apps to avoid repeated seeding
const seededApps = new Map<string, Set<string>>()
const seedPromises = new Map<string, Promise<void>>()

export interface SeedAppOptions {
  orgId?: string
  userId?: string
  adminUserId?: string
  stripeCustomerId?: string
  planProductId?: string
}
export function createIsolatedSeedAppOptions(): Required<Pick<SeedAppOptions, 'orgId' | 'stripeCustomerId'>> {
  const orgId = randomUUID()
  return {
    orgId,
    stripeCustomerId: `cus_test_${orgId.replaceAll('-', '')}`,
  }
}

function getSeedOptionKey(options?: SeedAppOptions): string {
  if (!options)
    return '__default__'
  return JSON.stringify({
    orgId: options.orgId ?? null,
    userId: options.userId ?? null,
    adminUserId: options.adminUserId ?? null,
    stripeCustomerId: options.stripeCustomerId ?? null,
    planProductId: options.planProductId ?? null,
  })
}

// Connection pool to reduce database connection overhead
let supabaseClient: SupabaseClient<Database> | null = null

export interface BaseTestData {
  channel: string
  platform: string
  device_id: string
  app_id: string
  custom_id: string
  version_build: string
  version_code: string
  version_os: string
  version_name: string
  plugin_version: string
  is_emulator: boolean
  is_prod: boolean
  defaultChannel?: string
}

export function makeBaseData(appId: string): BaseTestData {
  return {
    channel: 'production',
    platform: 'android',
    device_id: '00009a6b-eefe-490a-9c60-8e965132ae51',
    app_id: appId,
    custom_id: '',
    version_build: '1.0.0',
    version_code: '1',
    version_os: '13',
    version_name: '1.0.0',
    plugin_version: '7.0.0',
    is_emulator: false,
    is_prod: true,
  }
}

export function getVersionFromAction(action: string): string {
  const sanitizedAction = action.replace(/[^0-9a-z-]/gi, '-')
  return `1.0.0-${sanitizedAction}.1`
}

export async function createAppVersions(
  version: string,
  appId: string,
  values: Partial<Database['public']['Tables']['app_versions']['Insert']> = {},
) {
  const supabase = getSupabaseClient()
  const { error, data } = await supabase.from('app_versions').upsert({
    app_id: appId,
    name: version,
    owner_org: ORG_ID,
    ...values,
  }, {
    onConflict: 'app_id,name',
  }).select('id,name').single()
  if (error)
    console.error(`Error creating app_version for ${version}:`, error)
  if (!data)
    throw new Error(`Error creating app_version for ${version}: no data`)
  return data
}

export function getBaseData(appId: string): Partial<ReturnType<typeof makeBaseData>> {
  return structuredClone(makeBaseData(appId))
}
export type HttpMethod = 'POST' | 'PUT' | 'DELETE'

export async function fetchBundle(appId: string) {
  const params = new URLSearchParams({ app_id: appId })
  const response = await fetch(`${getEndpointUrl('/bundle')}?${params.toString()}`, {
    method: 'GET',
    headers,
  })
  return { response, data: await response.json() }
}

// Optimized app seeding with caching and deduplication
export async function resetAndSeedAppData(appId: string, options?: SeedAppOptions): Promise<void> {
  const optionKey = getSeedOptionKey(options)
  const seededForApp = seededApps.get(appId)
  if (seededForApp?.has(optionKey)) {
    return
  }

  const promiseKey = `${appId}::${optionKey}`
  if (seedPromises.has(promiseKey)) {
    return await seedPromises.get(promiseKey)!
  }

  const seedPromise = (async () => {
    try {
      const supabase = getSupabaseClient()
      const rpcParams: Record<string, unknown> = { p_app_id: appId }
      if (options?.orgId)
        rpcParams.p_org_id = options.orgId
      if (options?.userId)
        rpcParams.p_user_id = options.userId
      if (options?.adminUserId)
        rpcParams.p_admin_user_id = options.adminUserId
      if (options?.stripeCustomerId)
        rpcParams.p_stripe_customer_id = options.stripeCustomerId
      if (options?.planProductId)
        rpcParams.p_plan_product_id = options.planProductId

      const { error } = await supabase.rpc('reset_and_seed_app_data' as any, rpcParams)
      if (error)
        throw error

      const updatedSet = seededApps.get(appId) ?? new Set<string>()
      updatedSet.add(optionKey)
      seededApps.set(appId, updatedSet)
    }
    finally {
      seedPromises.delete(promiseKey)
    }
  })()

  seedPromises.set(promiseKey, seedPromise)
  return await seedPromise
}

export async function resetAppData(appId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('reset_app_data' as any, { p_app_id: appId })
  if (error)
    throw error

  seededApps.delete(appId)
  for (const key of Array.from(seedPromises.keys())) {
    if (key.startsWith(`${appId}::`))
      seedPromises.delete(key)
  }
}

export async function resetAndSeedAppDataStats(appId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('reset_and_seed_app_stats_data' as any, { p_app_id: appId })
  if (error)
    throw error
}

export async function resetAppDataStats(appId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('reset_app_stats_data' as any, { p_app_id: appId })
  if (error)
    throw error
}

export function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabaseClient) {
    hydrateLocalSupabaseEnvFromStatus()

    const supabaseUrl = normalizeLocalhostUrl(env.SUPABASE_URL) ?? SUPABASE_BASE_URL
    // Support both env names. Supabase CLI exposes SERVICE_ROLE_KEY, and our wrapper exports
    // SUPABASE_SERVICE_ROLE_KEY + SUPABASE_SERVICE_KEY for convenience.
    const supabaseServiceKey = env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY ?? ''
    supabaseClient = createClient<Database>(supabaseUrl, supabaseServiceKey, {
      db: {
        schema: 'public',
      },
      auth: {
        persistSession: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 2,
        },
      },
    })
  }
  return supabaseClient
}

// Batch operations to reduce database load
export async function batchResetAndSeedApps(appIds: string[]): Promise<void> {
  // Process in smaller batches to avoid overwhelming the database
  const batchSize = 3
  for (let i = 0; i < appIds.length; i += batchSize) {
    const batch = appIds.slice(i, i + batchSize)
    await Promise.all(batch.map(appId => resetAndSeedAppData(appId)))
  }
}

export async function seedTestData(supabase: SupabaseClient, appId: string) {
  const { error } = await supabase.rpc('seed_test_data', { p_app_id: appId })
  if (error)
    throw error
}

export async function createDemoApp(supabase: SupabaseClient, appId: string) {
  const { error } = await supabase.from('apps').insert({ id: appId })
  if (error)
    throw error
}

export function generateUniqueAppId(testName: string): string {
  return `com.demo.${testName.toLowerCase().replace(/\s/g, '_')}_${Date.now()}`
}

export async function cleanupDemoApp(supabase: SupabaseClient, appId: string) {
  const { error } = await supabase.from('apps').delete().eq('id', appId)
  if (error)
    throw error
}

export function updateAndroidBaseData(appId: string) {
  return {
    platform: 'android',
    device_id: '00009a6b-eefe-490a-9c60-8e965132ae51',
    app_id: appId,
    custom_id: '',
    version_build: '1.0',
    version_code: '1',
    version_os: '13',
    version_name: '1.0.0',
    plugin_version: '5.2.1',
    is_emulator: false,
    is_prod: true,
  }
}

export async function responseOk(response: Response, requestName: string): Promise<void> {
  const cloneResponse = response.clone()
  if (!cloneResponse.ok) {
    throw new Error(`${requestName} response not ok: ${cloneResponse.status} ${cloneResponse.statusText} ${await cloneResponse.text()}`)
  }
}

export async function getUpdate(data: ReturnType<typeof updateAndroidBaseData>): Promise<Response> {
  return await fetch(getEndpointUrl('/updates'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
}

export function getUpdateBaseData(appId: string): ReturnType<typeof updateAndroidBaseData> {
  return JSON.parse(JSON.stringify(updateAndroidBaseData(appId)))
}

export async function postUpdate(data: object) {
  return await fetchTestRequest(
    getEndpointUrl('/updates'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    },
  )
}

export interface DeviceLink {
  channel?: string
  platform?: string
  device_id?: string
  app_id?: string
  custom_id?: string
  version_build?: string
  version_code?: string
  version_os?: string
  version_name?: string
  plugin_version?: string
  is_emulator?: boolean
  is_prod?: boolean
  defaultChannel?: string
}

// Cleanup function for tests
export async function cleanup(): Promise<void> {
  seededApps.clear()
  seedPromises.clear()
  if (supabaseClient) {
    // Close connections if needed
    supabaseClient = null
  }
}

// PostgreSQL direct connection helpers
let pool: Pool | null = null

export async function getPostgresClient(): Promise<Pool> {
  hydrateLocalSupabaseEnvFromStatus()

  if (!pool) {
    pool = new Pool({
      connectionString: POSTGRES_URL,
      max: 1,
      idleTimeoutMillis: 2000,
    })
  }
  return pool
}

export async function executeSQL(query: string, params?: any[]): Promise<any> {
  const client = await getPostgresClient()
  const result = await client.query(query, params || [])
  return result.rows
}

export async function getCronPlanQueueCount(): Promise<number> {
  const result = await executeSQL('SELECT COUNT(*) as count FROM pgmq.q_cron_stat_org')
  return Number.parseInt(result[0]?.count || '0')
}

export async function getCronPlanQueueCountForOrg(orgId: string): Promise<number> {
  const result = await executeSQL(
    `SELECT COUNT(*) as count
     FROM pgmq.q_cron_stat_org
     WHERE message->'payload'->>'orgId' = $1`,
    [orgId],
  )
  return Number.parseInt(result[0]?.count || '0')
}

export async function getLatestCronPlanMessage(): Promise<any> {
  const result = await executeSQL('SELECT message FROM pgmq.q_cron_stat_org ORDER BY msg_id DESC LIMIT 1')
  return result[0]?.message
}

export async function getLatestCronPlanMessageForOrg(orgId: string): Promise<any> {
  const result = await executeSQL(
    `SELECT message
     FROM pgmq.q_cron_stat_org
     WHERE message->'payload'->>'orgId' = $1
     ORDER BY msg_id DESC
     LIMIT 1`,
    [orgId],
  )
  return result[0]?.message
}

export async function cleanupPostgresClient(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

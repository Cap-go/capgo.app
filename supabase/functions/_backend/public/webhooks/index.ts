import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { getBodyOrQuery, honoFactory, quickError, simpleError } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { closeClient, getPgClient, logPgError } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { apikeyHasOrgRight, apikeyHasOrgRightWithPolicy, supabaseApikey } from '../../utils/supabase.ts'
import { deleteWebhook } from './delete.ts'
import { getDeliveries, retryDelivery } from './deliveries.ts'
import { get } from './get.ts'
import { post } from './post.ts'
import { put } from './put.ts'
import { test } from './test.ts'

export const app = honoFactory.createApp()

async function apiKeyHasAppScopedBinding(
  c: Context<MiddlewareKeyVariables>,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<boolean> {
  if (!apikey.rbac_id)
    return false

  const pgClient = getPgClient(c)
  try {
    const result = await pgClient.query<{ has_app_scope: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM public.role_bindings
        WHERE principal_type = public.rbac_principal_apikey()
          AND principal_id = $1::uuid
          AND scope_type <> public.rbac_scope_org()
          AND (expires_at IS NULL OR expires_at > now())
      ) AS has_app_scope
      `,
      [apikey.rbac_id],
    )

    return result.rows[0]?.has_app_scope ?? true
  }
  catch (error) {
    logPgError(c, 'apiKeyHasAppScopedBinding', error)
    return true
  }
  finally {
    await closeClient(c, pgClient)
  }
}

async function assertOrgWebhookScope(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<void> {
  if (await apiKeyHasAppScopedBinding(c, apikey)) {
    throw simpleError('no_permission', 'App-scoped API keys cannot manage organization webhooks', { org_id: orgId })
  }

  if (!(await apikeyHasOrgRight(c, apikey, orgId))) {
    throw simpleError('invalid_org_id', 'You can\'t access this organization', { org_id: orgId })
  }
}

async function assertWebhookOrgPolicy(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<void> {
  const supabase = supabaseApikey(c, c.get('capgkey') as string)
  const orgCheck = await apikeyHasOrgRightWithPolicy(c, apikey, orgId, supabase)
  if (orgCheck.valid) {
    return
  }

  if (orgCheck.error === 'org_requires_expiring_key') {
    throw quickError(401, 'org_requires_expiring_key', 'This organization requires API keys with an expiration date. Please use a different key or update this key with an expiration date.')
  }

  throw simpleError('invalid_org_id', 'You can\'t access this organization', { org_id: orgId })
}

function uniqueApiKeys(
  apikeys: (Database['public']['Tables']['apikeys']['Row'] | null | undefined)[],
) {
  const filteredApiKeys = apikeys.filter((apikey): apikey is Database['public']['Tables']['apikeys']['Row'] => !!apikey)
  return filteredApiKeys.filter((apikey, index) => filteredApiKeys.findIndex(existing => existing.id === apikey.id) === index)
}

function getWebhookApiKeyChain(c: Context<MiddlewareKeyVariables>, apikey: Database['public']['Tables']['apikeys']['Row']) {
  const parentApikey = c.get('parentApikey') as Database['public']['Tables']['apikeys']['Row'] | undefined
  return uniqueApiKeys([parentApikey, apikey])
}

function getWebhookAuthApiKeyChain(c: Context<MiddlewareKeyVariables>, auth: AuthInfo) {
  if (auth.authType !== 'apikey' || !auth.apikey)
    return []

  return getWebhookApiKeyChain(c, auth.apikey)
}

async function assertWebhookApiKeyChain(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  apiKeyChain: Database['public']['Tables']['apikeys']['Row'][],
) {
  for (const apikey of apiKeyChain) {
    await assertOrgWebhookScope(c, orgId, apikey)
  }

  for (const apikey of apiKeyChain) {
    await assertWebhookOrgPolicy(c, orgId, apikey)
  }
}

/**
 * Shared permission check for webhook endpoints (API key auth)
 * Validates admin access to organization
 */
export async function checkWebhookPermission(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
): Promise<void> {
  await assertWebhookApiKeyChain(c, orgId, getWebhookApiKeyChain(c, apikey))

  if (!(await checkPermission(c, 'org.update_settings', { orgId }))) {
    throw simpleError('no_permission', 'You need admin access to manage webhooks', { org_id: orgId })
  }
}

/**
 * Shared permission check for webhook endpoints (JWT or API key auth)
 * Validates admin access to organization using the unified auth info
 */
export async function checkWebhookPermissionV2(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  auth: AuthInfo,
): Promise<void> {
  await assertWebhookApiKeyChain(c, orgId, getWebhookAuthApiKeyChain(c, auth))

  if (!(await checkPermission(c, 'org.update_settings', { orgId }))) {
    throw simpleError('no_permission', 'You need admin access to manage webhooks', { org_id: orgId })
  }
}

// List all webhooks for org
app.get('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return get(c, body, auth)
})

// Create webhook
app.post('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return post(c, body, auth)
})

// Update webhook
app.put('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return put(c, body, auth)
})

// Delete webhook
app.delete('/', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return deleteWebhook(c, body, auth)
})

// Test webhook (supports both JWT and API key auth)
app.post('/test', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return test(c, body, auth)
})

// Get webhook deliveries
app.get('/deliveries', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return getDeliveries(c, body, auth)
})

// Retry a failed delivery (supports both JWT and API key auth)
app.post('/deliveries/retry', middlewareAuth(), async (c) => {
  const body = await getBodyOrQuery<any>(c)
  const auth = c.get('auth') as AuthInfo
  return retryDelivery(c, body, auth)
})

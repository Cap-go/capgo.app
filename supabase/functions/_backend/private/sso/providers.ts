import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { BRES, createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { requireEnterprisePlan } from '../../utils/plan-gating.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSSOProvider, deleteSSOProvider, ManagementAPIError } from '../../utils/supabase-management.ts'
import { supabaseWithAuth } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'

const createBodySchema = z.object({
  org_id: z.uuid(),
  domain: z.string().min(1),
  metadata_url: z.url(),
  attribute_mapping: z.unknown().optional(),
})

const updateBodySchema = z.object({
  metadata_url: z.url().optional(),
  attribute_mapping: z.unknown().optional(),
  enforce_sso: z.boolean().optional(),
  status: z.enum(['verified', 'active', 'disabled']).optional(),
})

const uuidSchema = z.uuid()

function sanitizeProvider(provider: Record<string, unknown>) {
  const { dns_verification_token: _dnsVerificationToken, ...safeProvider } = provider
  return safeProvider
}

function generateDnsVerificationToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  'email',
  'first_name',
  'last_name',
  'display_name',
  'groups',
  'role',
  'phone',
])

const MAX_ATTRIBUTE_VALUE_LENGTH = 256

function parseAttributeMapping(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw simpleError('invalid_body', 'attribute_mapping must be an object')
  }

  const entries = Object.entries(value)
  if (entries.length > ALLOWED_ATTRIBUTE_KEYS.size) {
    throw simpleError('invalid_body', `attribute_mapping cannot have more than ${ALLOWED_ATTRIBUTE_KEYS.size} keys`)
  }

  const result: Record<string, string> = {}
  for (const [key, mappedValue] of entries) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) {
      throw simpleError('invalid_body', `attribute_mapping key '${key}' is not allowed. Allowed keys: ${[...ALLOWED_ATTRIBUTE_KEYS].join(', ')}`)
    }
    if (typeof mappedValue !== 'string') {
      throw simpleError('invalid_body', 'attribute_mapping values must be strings')
    }
    if (mappedValue.length === 0 || mappedValue.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
      throw simpleError('invalid_body', `attribute_mapping value for '${key}' must be between 1 and ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`)
    }
    result[key] = mappedValue
  }

  return result
}

async function requireManageSsoPermission(c: Context<MiddlewareKeyVariables>, orgId: string) {
  const allowed = await checkPermission(c, 'org.update_settings' as any, { orgId })
  if (!allowed) {
    quickError(403, 'not_authorized', 'Not authorized')
  }
}

async function syncAuthUsersSsoOnlyByDomain(c: Context<MiddlewareKeyVariables>, domain: string, isSsoOnly: boolean): Promise<void> {
  let pgClient: ReturnType<typeof getPgClient> | undefined
  try {
    pgClient = getPgClient(c)
    await pgClient.query(
      `
        update auth.users
        set is_sso_user = $1
        where email is not null
          and lower(split_part(email, '@', 2)) = lower($2)
      `,
      [isSsoOnly, domain],
    )
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
}

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth)

app.post('/', async (c) => {
  const auth = c.get('auth')
  if (!auth) {
    quickError(401, 'not_authorized', 'Not authorized')
  }

  const rawBody = await parseBody<{
    org_id?: string
    domain?: string
    metadata_url?: string
    attribute_mapping?: unknown
  }>(c)

  const validation = safeParseSchema(createBodySchema, rawBody)
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }

  const body = validation.data
  const attributeMapping = parseAttributeMapping(body.attribute_mapping)
  const domain = body.domain.trim().toLowerCase()
  if (!domain) {
    throw simpleError('invalid_body', 'domain must not be empty')
  }

  await requireManageSsoPermission(c, body.org_id)
  await requireEnterprisePlan(c, body.org_id)

  let managementProvider: Awaited<ReturnType<typeof createSSOProvider>>
  try {
    managementProvider = await createSSOProvider(c, domain, body.metadata_url, attributeMapping)
  }
  catch (err) {
    if (err instanceof ManagementAPIError) {
      return quickError(err.status >= 400 ? err.status : 500, 'provider_creation_failed', err.message, { management_error_code: err.code })
    }
    throw err
  }

  try {
    const supabase = supabaseWithAuth(c, auth) as any
    const dnsVerificationToken = generateDnsVerificationToken()

    const { data, error } = await supabase
      .from('sso_providers')
      .insert({
        org_id: body.org_id,
        domain,
        provider_id: managementProvider.id,
        status: 'pending_verification',
        dns_verification_token: dnsVerificationToken,
        metadata_url: body.metadata_url,
        attribute_mapping: attributeMapping ?? null,
      })
      .select('*')
      .single()

    if (error || !data) {
      // Rollback: delete the external provider to avoid orphan
      await deleteSSOProvider(c, managementProvider.id).catch((cleanupError) => {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to cleanup external SSO provider after DB insert failure', error: cleanupError })
      })
      return quickError(500, 'provider_create_failed', 'Failed to create SSO provider', { error })
    }

    return c.json(data)
  }
  catch (err) {
    // Rollback on any exception
    await deleteSSOProvider(c, managementProvider.id).catch((cleanupError) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to cleanup external SSO provider after exception', error: cleanupError })
    })
    throw err
  }
})

app.get('/:orgId', async (c) => {
  const auth = c.get('auth')
  if (!auth) {
    quickError(401, 'not_authorized', 'Not authorized')
  }

  const orgId = c.req.param('orgId')
  const orgIdValidation = safeParseSchema(uuidSchema, orgId)
  if (!orgIdValidation.success) {
    throw simpleError('invalid_org_id', 'Invalid org_id')
  }

  await requireManageSsoPermission(c, orgId)

  const supabase = supabaseWithAuth(c, auth) as any
  const { data, error } = await supabase
    .from('sso_providers')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })

  if (error) {
    quickError(500, 'providers_list_failed', 'Failed to list SSO providers', { error })
  }

  return c.json((data ?? []).map((provider: Record<string, unknown>) => sanitizeProvider(provider)))
})

app.patch('/:id', async (c) => {
  const auth = c.get('auth')
  if (!auth) {
    quickError(401, 'not_authorized', 'Not authorized')
  }

  const id = c.req.param('id')
  const idValidation = safeParseSchema(uuidSchema, id)
  if (!idValidation.success) {
    throw simpleError('invalid_provider_id', 'Invalid provider id')
  }

  const rawBody = await parseBody<{
    metadata_url?: string
    attribute_mapping?: unknown
    enforce_sso?: boolean
  }>(c)

  const validation = safeParseSchema(updateBodySchema, rawBody)
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }

  const body = validation.data
  const attributeMapping = parseAttributeMapping(body.attribute_mapping)

  const supabase = supabaseWithAuth(c, auth) as any
  const { data: provider, error: providerError } = await supabase
    .from('sso_providers')
    .select('id, org_id, domain, status, enforce_sso')
    .eq('id', id)
    .single()

  if (providerError || !provider) {
    quickError(404, 'provider_not_found', 'SSO provider not found')
  }

  await requireManageSsoPermission(c, provider.org_id)

  const updates: Record<string, unknown> = {}
  if (body.metadata_url !== undefined) {
    updates.metadata_url = body.metadata_url
  }
  if (body.attribute_mapping !== undefined) {
    updates.attribute_mapping = attributeMapping
  }
  if (body.enforce_sso !== undefined) {
    if (body.enforce_sso === true && provider.status !== 'active') {
      throw simpleError('invalid_enforce_sso', 'Cannot enable SSO enforcement on a provider that is not active')
    }
    updates.enforce_sso = body.enforce_sso
  }
  if (body.status !== undefined) {
    // Validate status transitions
    const currentStatus = provider.status
    const newStatus = body.status

    // Only allow certain transitions
    const validTransitions: Record<string, string[]> = {
      pending_verification: [], // Cannot change status until verified
      verified: ['active'], // Can activate
      active: ['disabled'], // Can disable
      disabled: ['active'], // Can re-enable
    }

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw simpleError('invalid_status_transition', `Cannot transition from ${currentStatus} to ${newStatus}`)
    }

    updates.status = body.status

    // Auto-reset enforce_sso when disabling provider
    if (newStatus === 'disabled') {
      updates.enforce_sso = false
    }
  }

  if (Object.keys(updates).length === 0) {
    throw simpleError('invalid_body', 'No updatable fields provided')
  }

  const { data: updatedProvider, error: updateError } = await supabase
    .from('sso_providers')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()

  if (updateError || !updatedProvider) {
    quickError(500, 'provider_update_failed', 'Failed to update SSO provider', { error: updateError })
  }

  const wasSsoEnforced = provider.status === 'active' && provider.enforce_sso === true
  const isSsoEnforced = updatedProvider.status === 'active' && updatedProvider.enforce_sso === true
  if (wasSsoEnforced !== isSsoEnforced) {
    try {
      await syncAuthUsersSsoOnlyByDomain(c, updatedProvider.domain, isSsoEnforced)
    }
    catch (syncError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to sync auth.users.is_sso_user with provider enforcement', providerId: id, domain: updatedProvider.domain, enforceSso: isSsoEnforced, error: syncError })
      return quickError(500, 'provider_sync_failed', 'Failed to sync SSO enforcement state')
    }
  }

  return c.json(sanitizeProvider(updatedProvider))
})

app.delete('/:id', async (c) => {
  const auth = c.get('auth')
  if (!auth) {
    quickError(401, 'not_authorized', 'Not authorized')
  }

  const id = c.req.param('id')
  const idValidation = safeParseSchema(uuidSchema, id)
  if (!idValidation.success) {
    throw simpleError('invalid_provider_id', 'Invalid provider id')
  }

  const supabase = supabaseWithAuth(c, auth) as any
  const { data: provider, error: providerError } = await supabase
    .from('sso_providers')
    .select('id, org_id, provider_id')
    .eq('id', id)
    .single()

  if (providerError || !provider) {
    quickError(404, 'provider_not_found', 'SSO provider not found')
  }

  await requireManageSsoPermission(c, provider.org_id)

  // First delete the external provider (if exists) to avoid orphaning
  if (provider.provider_id) {
    try {
      await deleteSSOProvider(c, provider.provider_id)
    }
    catch (externalDeleteError) {
      const errorMsg = externalDeleteError instanceof Error ? externalDeleteError.message : String(externalDeleteError)
      return quickError(500, 'provider_delete_failed', 'Failed to delete external SSO provider', { error: errorMsg })
    }
  }

  // Then delete the database row
  const { error: deleteError } = await supabase
    .from('sso_providers')
    .delete()
    .eq('id', id)

  if (deleteError) {
    return quickError(500, 'provider_delete_failed', 'Failed to delete SSO provider', { error: deleteError })
  }

  return c.json(BRES)
})

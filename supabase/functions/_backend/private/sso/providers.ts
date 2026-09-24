import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { SSOProviderSnapshot } from '../../utils/supabase-management.ts'
import { z } from 'zod'
import { BRES, createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getPgClient, withPgTransaction } from '../../utils/pg.ts'
import { requireEnterprisePlan } from '../../utils/plan-gating.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { createSSOProvider, deleteSSOProvider, ManagementAPIError, restoreSSOProvider, snapshotSSOProvider, updateSSOProvider } from '../../utils/supabase-management.ts'
import { supabaseAdmin, supabaseWithAuth } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'
import { PUBLIC_EMAIL_DOMAINS } from './prelink-shared.ts'

// Metadata XML documents are a few KB; cap well above that to reject abuse.
const MAX_METADATA_XML_LENGTH = 512 * 1024
const DOMAIN_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const createBodySchema = z.object({
  org_id: z.uuid(),
  domain: z.string().min(1),
  // Either a URL Supabase Auth downloads, or the raw XML for IdPs whose
  // metadata endpoint is not reachable from Supabase (WAF, private network).
  metadata_url: z.url().optional(),
  metadata_xml: z.string().min(1).max(MAX_METADATA_XML_LENGTH).optional(),
  attribute_mapping: z.unknown().optional(),
}).refine(body => (body.metadata_url === undefined) !== (body.metadata_xml === undefined), {
  message: 'Provide exactly one of metadata_url or metadata_xml',
})

const updateBodySchema = z.object({
  metadata_url: z.url().optional(),
  attribute_mapping: z.unknown().optional(),
  enforce_sso: z.boolean().optional(),
  status: z.enum(['verified', 'active', 'disabled']).optional(),
})

const uuidSchema = z.uuid()

// The DNS token is only needed (and meant to be published in DNS) while the
// domain is pending; keep it so the setup instructions survive a page reload.
function sanitizeProvider(provider: Record<string, unknown>) {
  if (provider.status === 'pending_verification')
    return provider
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

const UPDATABLE_PROVIDER_COLUMNS = ['metadata_url', 'attribute_mapping', 'enforce_sso', 'status'] as const

// Updates the provider row and, when the enforced state flips, the matching
// auth.users.is_sso_user flags in one transaction so they can never diverge.
async function updateProviderAndSyncEnforcement(
  c: Context<MiddlewareKeyVariables>,
  id: string,
  updates: Record<string, unknown>,
  sync: { domain: string, isSsoOnly: boolean } | null,
): Promise<Record<string, unknown> | undefined> {
  const columns = UPDATABLE_PROVIDER_COLUMNS.filter(column => updates[column] !== undefined)
  const values = columns.map(column => column === 'attribute_mapping' ? JSON.stringify(updates[column]) : updates[column])
  const setClause = columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')

  const pgPool = getPgClient(c)
  try {
    return await withPgTransaction(pgPool, async (client) => {
      const result = await client.query(
        `update public.sso_providers set ${setClause} where id = $1 returning *`,
        [id, ...values],
      )
      const updatedProvider = result.rows[0] as Record<string, unknown> | undefined
      if (updatedProvider && sync)
        await setDomainSsoOnly(client, sync.domain, sync.isSsoOnly)
      return updatedProvider
    })
  }
  finally {
    await closeClient(c, pgPool)
  }
}

async function setDomainSsoOnly(client: PoolClient, domain: string, isSsoOnly: boolean) {
  await client.query(
    `
      update auth.users
      set is_sso_user = $1
      where email is not null
        and lower(split_part(email, '@', 2)) = lower($2)
    `,
    [isSsoOnly, domain],
  )
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
    metadata_xml?: string
    attribute_mapping?: unknown
  }>(c)

  const validation = safeParseSchema(createBodySchema, rawBody)
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }

  const body = validation.data
  const attributeMapping = parseAttributeMapping(body.attribute_mapping)
  const domain = body.domain.trim().toLowerCase()
  if (!DOMAIN_REGEX.test(domain)) {
    throw simpleError('invalid_domain', 'domain must be a valid domain name such as example.com')
  }
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    throw simpleError('public_email_domain', 'Public email domains cannot be used for SSO')
  }

  await requireManageSsoPermission(c, body.org_id)
  await requireEnterprisePlan(c, body.org_id)

  let managementProvider: Awaited<ReturnType<typeof createSSOProvider>>
  try {
    const metadata = body.metadata_url ? { metadata_url: body.metadata_url } : { metadata_xml: body.metadata_xml! }
    managementProvider = await createSSOProvider(c, domain, metadata, attributeMapping)
  }
  catch (err) {
    if (err instanceof ManagementAPIError) {
      return quickError(err.status >= 400 ? err.status : 500, 'provider_creation_failed', err.message, { management_error_code: err.code })
    }
    throw err
  }

  try {
    const admin = supabaseAdmin(c)
    const dnsVerificationToken = generateDnsVerificationToken()

    const { data, error } = await admin
      .from('sso_providers')
      .insert({
        org_id: body.org_id,
        domain,
        provider_id: managementProvider.id,
        status: 'pending_verification',
        dns_verification_token: dnsVerificationToken,
        metadata_url: body.metadata_url ?? null,
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
    .select('id, org_id, domain, status, enforce_sso, provider_id')
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

  const becomesActive = updates.status === 'active'
  if (becomesActive || updates.enforce_sso === true) {
    await requireEnterprisePlan(c, provider.org_id)
  }

  // Supabase Auth keeps its own copy of the provider: keep it in sync so a
  // disabled Capgo provider cannot be used to sign in through Supabase Auth.
  const managementUpdates: Parameters<typeof updateSSOProvider>[2] = {}
  if (updates.status !== undefined)
    managementUpdates.disabled = !becomesActive
  if (body.metadata_url !== undefined)
    managementUpdates.metadata_url = body.metadata_url
  if (attributeMapping !== undefined)
    managementUpdates.attribute_mapping = attributeMapping
  // Snapshot taken before the update so Supabase Auth can be put back if the
  // database write below fails.
  let authSnapshot: SSOProviderSnapshot | null = null
  if (provider.provider_id && Object.keys(managementUpdates).length > 0) {
    try {
      authSnapshot = await snapshotSSOProvider(c, provider.provider_id)
      await updateSSOProvider(c, provider.provider_id, managementUpdates)
    }
    catch (err) {
      if (err instanceof ManagementAPIError) {
        return quickError(err.status >= 400 && err.status < 500 ? err.status : 502, 'provider_update_failed', err.message, { management_error_code: err.code })
      }
      throw err
    }
  }

  const wasSsoEnforced = provider.status === 'active' && provider.enforce_sso === true
  const nextStatus = (updates.status as string | undefined) ?? provider.status
  const nextEnforce = (updates.enforce_sso as boolean | undefined) ?? provider.enforce_sso
  const isSsoEnforced = nextStatus === 'active' && nextEnforce === true

  let updatedProvider: Record<string, unknown> | undefined
  let updateError: unknown
  try {
    updatedProvider = await updateProviderAndSyncEnforcement(c, id, updates, wasSsoEnforced !== isSsoEnforced ? { domain: provider.domain, isSsoOnly: isSsoEnforced } : null)
  }
  catch (error) {
    updateError = error
  }
  if (!updatedProvider) {
    if (authSnapshot && provider.provider_id) {
      await restoreSSOProvider(c, provider.provider_id, authSnapshot).catch((restoreError) => {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to restore Supabase Auth SSO provider after database update failure', providerId: id, externalProviderId: provider.provider_id, error: restoreError })
      })
    }
    if (!updateError)
      quickError(404, 'provider_not_found', 'SSO provider not found')
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to update SSO provider', providerId: id, domain: provider.domain, error: updateError })
    return quickError(500, 'provider_update_failed', 'Failed to update SSO provider')
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
    .select('id, org_id, provider_id, domain, status, enforce_sso')
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

  // Then delete the database row. The RLS client is not used here: its DELETE
  // policy requires a different permission than the one checked above, which
  // silently left orphaned rows behind.
  const wasSsoEnforced = provider.status === 'active' && provider.enforce_sso === true
  const pgPool = getPgClient(c)
  try {
    await withPgTransaction(pgPool, async (client) => {
      await client.query('delete from public.sso_providers where id = $1', [id])
      // Give password login back to users that were locked to this provider.
      if (wasSsoEnforced)
        await setDomainSsoOnly(client, provider.domain, false)
    })
  }
  catch (deleteError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to delete SSO provider row', providerId: id, error: deleteError })
    return quickError(500, 'provider_delete_failed', 'Failed to delete SSO provider')
  }
  finally {
    await closeClient(c, pgPool)
  }

  return c.json(BRES)
})

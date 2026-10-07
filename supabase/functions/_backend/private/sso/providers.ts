import type { Context } from 'hono'
import type { PoolClient } from 'pg'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { SsoRoleMapping } from './role-mapping.ts'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { BRES, createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient, withPgTransaction } from '../../utils/pg.ts'
import { requireEnterprisePlan } from '../../utils/plan-gating.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { createSSOProvider, deleteSSOProvider, ManagementAPIError, restoreSSOProvider, snapshotSSOProvider, updateSSOProvider } from '../../utils/supabase-management.ts'
import { supabaseAdmin, supabaseWithAuth } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'
import { getCallerMaxPriorityRank } from '../role_bindings.ts'
import { PUBLIC_EMAIL_DOMAINS } from './prelink-shared.ts'
import { mappedAttributes, parseStoredRoleMapping, roleMappingSchema, ssoAttributeClaimKey } from './role-mapping.ts'

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
  // null removes the mapping (back to org_member for new members).
  role_mapping: roleMappingSchema.nullable().optional(),
})

const uuidSchema = z.uuid()

const createLinkBodySchema = z.object({
  org_id: z.uuid(),
})

const updateLinkBodySchema = z.object({
  // null removes the mapping: the linked org then gets nobody from SSO.
  role_mapping: roleMappingSchema.nullable(),
})

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

// Every app and group a mapping grants must belong to the provider's org.
async function requireMappingTargetsInOrg(c: Context<MiddlewareKeyVariables>, orgId: string, mapping: SsoRoleMapping) {
  const admin = supabaseAdmin(c)
  const groupIds = [...new Set(mapping.rules.map(rule => rule.group_id).filter((id): id is string => id !== null))]
  const appIds = [...new Set(mapping.rules.flatMap(rule => rule.apps.map(app => app.app_id)))]
  const [groups, apps] = await Promise.all([
    groupIds.length ? admin.from('groups').select('id').eq('org_id', orgId).in('id', groupIds) : { data: [], error: null },
    appIds.length ? admin.from('apps').select('id').eq('owner_org', orgId).in('id', appIds) : { data: [], error: null },
  ])
  if (groups.error || apps.error)
    quickError(500, 'role_mapping_lookup_failed', 'Failed to validate role mapping targets')
  if ((groups.data ?? []).length !== groupIds.length || (apps.data ?? []).length !== appIds.length)
    throw simpleError('invalid_role_mapping', 'Role mapping references an app or group that does not belong to this organization')
}

// A role mapping is authoritative for every SSO user of the domain: it can
// grant any role (directly or through a group's bindings) and demote or
// revoke anyone, super admins included. Only callers holding the org's
// highest role may therefore change it, which keeps it within the same
// anti-escalation rule as role_bindings (callers never assign above their
// own rank).
async function requireSuperAdminForRoleMapping(c: Context<MiddlewareKeyVariables>, orgId: string) {
  if (!await isOrgSuperAdmin(c, orgId))
    quickError(403, 'role_mapping_requires_super_admin', 'Only organization super admins can change the SSO role mapping')
}

async function isOrgSuperAdmin(c: Context<MiddlewareKeyVariables>, orgId: string): Promise<boolean> {
  const auth = c.get('auth')!
  // Legacy API keys have no RBAC principal, hence no role in the org.
  if (auth.authType === 'apikey' && !auth.apikey?.rbac_id)
    return false
  const pgPool = getPgClient(c)
  try {
    const drizzle = getDrizzleClient(pgPool)
    const callerRank = auth.authType === 'apikey'
      ? await getCallerMaxPriorityRank(drizzle, 'apikey', auth.apikey!.rbac_id!, orgId)
      : await getCallerMaxPriorityRank(drizzle, 'jwt', auth.userId, orgId)
    const { rows } = await pgPool.query<{ priority_rank: number }>(
      'select priority_rank from public.roles where name = public.rbac_role_org_super_admin() and scope_type = public.rbac_scope_org()',
    )
    const superAdminRank = rows[0]?.priority_rank
    return superAdminRank !== undefined && callerRank >= superAdminRank
  }
  finally {
    await closeClient(c, pgPool)
  }
}

// Apps and groups a mapping no longer references are no longer re-evaluated
// on login, so the access SSO granted on them is revoked when the mapping is
// saved: app bindings created by SSO and group memberships SSO added (added_by
// is the user itself), for users of the provider's domain only.
async function revokeUnmappedSsoAccess(client: PoolClient, orgId: string, domain: string, appIds: string[], groupIds: string[]) {
  if (appIds.length > 0) {
    await client.query(
      `
        delete from public.role_bindings rb
        using auth.users u
        where u.id = rb.principal_id
          and rb.principal_type = public.rbac_principal_user()
          and rb.scope_type = public.rbac_scope_app()
          and rb.org_id = $1
          and rb.app_id = any($2::uuid[])
          and rb.reason = 'SSO role mapping'
          and lower(split_part(u.email, '@', 2)) = lower($3)
      `,
      [orgId, appIds, domain],
    )
  }
  if (groupIds.length > 0) {
    await client.query(
      `
        delete from public.group_members gm
        using auth.users u, public.groups g
        where u.id = gm.user_id
          and g.id = gm.group_id
          and g.org_id = $1
          and gm.group_id = any($2::uuid[])
          and gm.added_by = gm.user_id
          and lower(split_part(u.email, '@', 2)) = lower($3)
      `,
      [orgId, groupIds, domain],
    )
  }
}

// Supabase Auth only captures the SAML attributes listed in the provider's
// attribute mapping: one claim per attribute used by the owner org's role
// mapping or by any linked org's mapping.
function buildAuthAttributeMapping(attributeMapping: Record<string, string>, roleMappings: (SsoRoleMapping | null)[]): Record<string, string> {
  const attributes = roleMappings.flatMap(mapping => mapping ? mappedAttributes(mapping) : [])
  return {
    ...attributeMapping,
    ...Object.fromEntries(attributes.map(attribute => [ssoAttributeClaimKey(attribute), attribute])),
  }
}

async function loadLinkedRoleMappings(client: PoolClient | ReturnType<typeof getPgClient>, providerId: string, excludedOrgId: string | null = null): Promise<(SsoRoleMapping | null)[]> {
  const { rows } = await client.query<{ role_mapping: unknown }>(
    'select role_mapping from public.sso_provider_org_links where sso_provider_id = $1 and role_mapping is not null and org_id is distinct from $2',
    [providerId, excludedOrgId],
  )
  return rows.map(row => parseStoredRoleMapping(row.role_mapping))
}

function mappingTargets(mapping: SsoRoleMapping | null) {
  return {
    appIds: new Set(mapping?.rules.flatMap(rule => rule.apps.map(app => app.app_id)) ?? []),
    groupIds: new Set(mapping?.rules.map(rule => rule.group_id).filter((id): id is string => id !== null) ?? []),
  }
}

async function requireManageSsoPermission(c: Context<MiddlewareKeyVariables>, orgId: string) {
  const allowed = await checkPermission(c, 'org.update_settings' as any, { orgId })
  if (!allowed) {
    quickError(403, 'not_authorized', 'Not authorized')
  }
}

const UPDATABLE_PROVIDER_COLUMNS = ['metadata_url', 'attribute_mapping', 'role_mapping', 'enforce_sso', 'status'] as const
const JSONB_PROVIDER_COLUMNS = new Set(['attribute_mapping', 'role_mapping'])

// What a PATCH changed in Supabase Auth: how to undo it and, when the SAML
// provider was just created, its id to store on the row.
interface AuthChange {
  restore: () => Promise<void>
  providerId?: string
}

// Applies a PATCH as one unit per provider: the row is locked first, then
// Supabase Auth is updated, then the row and (when the enforced state flips)
// auth.users.is_sso_user are written. If the database write fails, Auth is
// restored while the lock is still held, so a concurrent PATCH can never have
// its Auth state overwritten by a stale restore.
async function applyProviderUpdate(
  c: Context<MiddlewareKeyVariables>,
  id: string,
  expectedUpdatedAt: string,
  updates: Record<string, unknown>,
  sync: { domain: string, isSsoOnly: boolean } | null,
  updateAuth: (() => Promise<AuthChange | null>) | null,
  revoke: { orgId: string, domain: string, appIds: string[], groupIds: string[] } | null = null,
): Promise<Record<string, unknown> | undefined> {
  const columns = UPDATABLE_PROVIDER_COLUMNS.filter(column => updates[column] !== undefined)
  const values = columns.map(column => JSONB_PROVIDER_COLUMNS.has(column) && updates[column] !== null ? JSON.stringify(updates[column]) : updates[column])
  const setClause = columns.map((column, index) => `"${column}" = $${index + 2}`).join(', ')

  const pgPool = getPgClient(c)
  let restoreAuth: (() => Promise<void>) | null = null
  let lockedUpdatedAt: string | null = null
  try {
    return await withPgTransaction(pgPool, async (client) => {
      // Up to two Management API calls (snapshot + update, 8s each) run while
      // this transaction sits idle holding the row lock: stay above that worst
      // case so the session is not killed mid-update.
      await client.query('SET LOCAL idle_in_transaction_session_timeout = 30000')
      const locked = await client.query<{ unchanged: boolean, updated_at: string }>(
        'select updated_at = $2::timestamptz as unchanged, updated_at::text as updated_at from public.sso_providers where id = $1 for update',
        [id, expectedUpdatedAt],
      )
      const current = locked.rows[0]
      if (!current)
        return undefined
      // Everything was validated against the row read before the lock: any
      // concurrent write (status, enforcement, metadata...) makes that stale.
      if (!current.unchanged)
        quickError(409, 'provider_changed', 'The SSO provider was modified concurrently, please retry')

      lockedUpdatedAt = current.updated_at
      const authChange = updateAuth ? await updateAuth() : null
      restoreAuth = authChange?.restore ?? null
      if (authChange?.providerId)
        await client.query('update public.sso_providers set provider_id = $2 where id = $1', [id, authChange.providerId])
      const result = await client.query(
        `update public.sso_providers set ${setClause} where id = $1 returning *`,
        [id, ...values],
      )
      const updatedProvider = result.rows[0] as Record<string, unknown> | undefined
      if (updatedProvider && sync)
        await setDomainSsoOnly(client, sync.domain, sync.isSsoOnly)
      if (updatedProvider && revoke)
        await revokeUnmappedSsoAccess(client, revoke.orgId, revoke.domain, revoke.appIds, revoke.groupIds)
      return updatedProvider
    })
  }
  catch (error) {
    if (restoreAuth)
      await restoreAuthIfRolledBack(c, pgPool, id, lockedUpdatedAt, restoreAuth)
    throw error
  }
  finally {
    await closeClient(c, pgPool)
  }
}

// The failure may come from COMMIT itself, so the outcome is checked in a new
// transaction that re-locks the row: updated_at still matching the value seen
// under the first lock proves the update rolled back, and holding the lock
// while restoring keeps a concurrent update from landing in between. When the
// outcome cannot be established, Auth is left alone and the case is logged.
async function restoreAuthIfRolledBack(
  c: Context<MiddlewareKeyVariables>,
  pgPool: ReturnType<typeof getPgClient>,
  id: string,
  lockedUpdatedAt: string | null,
  restoreAuth: () => Promise<void>,
) {
  try {
    await withPgTransaction(pgPool, async (client) => {
      const { rows } = await client.query<{ updated_at: string }>(
        'select updated_at::text as updated_at from public.sso_providers where id = $1 for update',
        [id],
      )
      if (rows[0]?.updated_at !== lockedUpdatedAt) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'SSO provider update outcome unclear or committed; Supabase Auth not restored', providerId: id })
        return
      }
      await restoreAuth()
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to restore Supabase Auth SSO provider after database update failure', providerId: id, error })
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

async function withPgPool<T>(c: Context<MiddlewareKeyVariables>, run: (pool: ReturnType<typeof getPgClient>) => Promise<T>): Promise<T> {
  const pgPool = getPgClient(c)
  try {
    return await run(pgPool)
  }
  finally {
    await closeClient(c, pgPool)
  }
}

interface ProviderForLink {
  id: string
  org_id: string
  domain: string
}

async function getProviderForLink(c: Context<MiddlewareKeyVariables>, id: string): Promise<ProviderForLink> {
  const provider = await withPgPool(c, async (pool) => {
    const { rows } = await pool.query<ProviderForLink>(
      'select id, org_id, domain from public.sso_providers where id = $1',
      [id],
    )
    return rows[0]
  })
  if (!provider)
    quickError(404, 'provider_not_found', 'SSO provider not found')
  return provider!
}

function parseUuidParam(value: string | undefined, error: string, message: string): string {
  const validation = safeParseSchema(uuidSchema, value)
  if (!validation.success)
    throw simpleError(error, message)
  return validation.data
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

  // Nothing is registered in Supabase Auth yet: the SAML provider is only
  // created on activation, once DNS ownership is proven, so a pending or
  // unverified domain can never be used to sign in.
  const { data, error } = await supabaseAdmin(c)
    .from('sso_providers')
    .insert({
      org_id: body.org_id,
      domain,
      status: 'pending_verification',
      dns_verification_token: generateDnsVerificationToken(),
      metadata_url: body.metadata_url ?? null,
      metadata_xml: body.metadata_xml ?? null,
      attribute_mapping: attributeMapping ?? null,
    } as any)
    .select('*')
    .single()

  if (error || !data) {
    if (error?.code === '23505')
      return quickError(409, 'domain_already_registered', 'This domain already has an SSO provider')
    return quickError(500, 'provider_create_failed', 'Failed to create SSO provider', { error })
  }

  return c.json(data)
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
    role_mapping?: unknown
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
    .select('id, org_id, domain, status, enforce_sso, provider_id, updated_at, metadata_url, metadata_xml, attribute_mapping, role_mapping')
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
  if (body.role_mapping !== undefined) {
    await requireSuperAdminForRoleMapping(c, provider.org_id)
    if (body.role_mapping)
      await requireMappingTargetsInOrg(c, provider.org_id, body.role_mapping)
    updates.role_mapping = body.role_mapping
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

  // The SAML provider only exists in Supabase Auth once activated (DNS proof
  // done): created on first activation, then sign-in is switched off and on by
  // removing/restoring its domain, which keeps the provider and so the users'
  // sso:<id> identities.
  const externalProviderId = provider.provider_id as string | null
  const managementUpdates: Parameters<typeof updateSSOProvider>[2] = {}
  if (updates.status !== undefined)
    managementUpdates.domains = becomesActive ? [provider.domain] : []
  if (body.metadata_url !== undefined)
    managementUpdates.metadata_url = body.metadata_url
  // Supabase Auth replaces the whole mapping: the attribute mapping plus one
  // claim per IdP attribute used by the role mapping.
  const nextAttributeMapping = (updates.attribute_mapping ?? provider.attribute_mapping ?? {}) as Record<string, string>
  const nextRoleMapping = (body.role_mapping !== undefined ? body.role_mapping : parseStoredRoleMapping(provider.role_mapping)) as SsoRoleMapping | null
  // Linked orgs' mappings are read before the row lock: saving one bumps the
  // provider's updated_at, so a stale read here fails with provider_changed.
  const linkedRoleMappings = await withPgPool(c, pool => loadLinkedRoleMappings(pool, id))
  const fullAttributeMapping = buildAuthAttributeMapping(nextAttributeMapping, [nextRoleMapping, ...linkedRoleMappings])
  if (body.attribute_mapping !== undefined || body.role_mapping !== undefined)
    managementUpdates.attribute_mapping = fullAttributeMapping

  const toManagementError = (err: unknown): never => {
    if (err instanceof ManagementAPIError)
      quickError(err.status >= 400 && err.status < 500 ? err.status : 502, 'provider_update_failed', err.message, { management_error_code: err.code })
    throw err
  }
  let updateAuth: (() => Promise<AuthChange | null>) | null = null
  if (!externalProviderId && becomesActive) {
    const metadataUrl = body.metadata_url ?? provider.metadata_url
    const metadata = metadataUrl ? { metadata_url: metadataUrl } : provider.metadata_xml ? { metadata_xml: provider.metadata_xml } : null
    if (!metadata)
      throw simpleError('missing_metadata', 'The provider has no SAML metadata to activate with')
    updateAuth = async () => {
      try {
        const created = await createSSOProvider(c, provider.domain, metadata, Object.keys(fullAttributeMapping).length > 0 ? fullAttributeMapping : undefined)
        return { providerId: created.id, restore: () => deleteSSOProvider(c, created.id) }
      }
      catch (err) {
        return toManagementError(err)
      }
    }
  }
  else if (externalProviderId && Object.keys(managementUpdates).length > 0) {
    updateAuth = async () => {
      try {
        // Snapshot first so Auth can be put back if the database write fails.
        const snapshot = await snapshotSSOProvider(c, externalProviderId)
        await updateSSOProvider(c, externalProviderId, managementUpdates)
        return { restore: () => restoreSSOProvider(c, externalProviderId, snapshot) }
      }
      catch (err) {
        return toManagementError(err)
      }
    }
  }

  let unmappedTargets: Parameters<typeof applyProviderUpdate>[6] = null
  if (body.role_mapping !== undefined) {
    const previous = mappingTargets(parseStoredRoleMapping(provider.role_mapping))
    const next = mappingTargets(body.role_mapping as SsoRoleMapping | null)
    const appIds = [...previous.appIds].filter(appId => !next.appIds.has(appId))
    const groupIds = [...previous.groupIds].filter(groupId => !next.groupIds.has(groupId))
    if (appIds.length > 0 || groupIds.length > 0)
      unmappedTargets = { orgId: provider.org_id, domain: provider.domain, appIds, groupIds }
  }

  const wasSsoEnforced = provider.status === 'active' && provider.enforce_sso === true
  const nextStatus = (updates.status as string | undefined) ?? provider.status
  const nextEnforce = (updates.enforce_sso as boolean | undefined) ?? provider.enforce_sso
  const isSsoEnforced = nextStatus === 'active' && nextEnforce === true

  let updatedProvider: Record<string, unknown> | undefined
  try {
    updatedProvider = await applyProviderUpdate(
      c,
      id,
      provider.updated_at,
      updates,
      wasSsoEnforced !== isSsoEnforced ? { domain: provider.domain, isSsoOnly: isSsoEnforced } : null,
      updateAuth,
      unmappedTargets,
    )
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to update SSO provider', providerId: id, domain: provider.domain, error })
    return quickError(500, 'provider_update_failed', 'Failed to update SSO provider')
  }
  if (!updatedProvider) {
    quickError(404, 'provider_not_found', 'SSO provider not found')
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

// ---------------------------------------------------------------------------
// Sharing a provider with other orgs of the same company (same IdP, same
// email domain). Only one org can own a domain, so the other orgs link to the
// owner's provider and keep their own role mapping.

// Providers the org owns with the orgs they are shared with, and providers
// other orgs share with it.
app.get('/:orgId/links', async (c) => {
  const orgId = parseUuidParam(c.req.param('orgId'), 'invalid_org_id', 'Invalid org_id')
  await requireManageSsoPermission(c, orgId)

  const result = await withPgPool(c, async (pool) => {
    const [shared, linked] = await Promise.all([
      pool.query(
        `
          select l.sso_provider_id as provider_id, l.org_id, o.name as org_name, l.role_mapping is not null as has_role_mapping, l.created_at
          from public.sso_provider_org_links l
          join public.sso_providers p on p.id = l.sso_provider_id
          join public.orgs o on o.id = l.org_id
          where p.org_id = $1
          order by o.name
        `,
        [orgId],
      ),
      pool.query(
        `
          select p.id as provider_id, p.domain, p.status, p.org_id as owner_org_id, o.name as owner_org_name, l.role_mapping, l.created_at
          from public.sso_provider_org_links l
          join public.sso_providers p on p.id = l.sso_provider_id
          join public.orgs o on o.id = p.org_id
          where l.org_id = $1
          order by p.domain
        `,
        [orgId],
      ),
    ])
    return { shared: shared.rows, linked: linked.rows }
  })
  return c.json(result)
})

// Being super admin of both orgs is the consent of both sides.
app.post('/:id/links', async (c) => {
  const id = parseUuidParam(c.req.param('id'), 'invalid_provider_id', 'Invalid provider id')
  const validation = safeParseSchema(createLinkBodySchema, await parseBody<{ org_id?: string }>(c))
  if (!validation.success)
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  const targetOrgId = validation.data.org_id

  const provider = await getProviderForLink(c, id)
  if (provider.org_id === targetOrgId)
    throw simpleError('invalid_link', 'The provider already belongs to this organization')
  if (!await isOrgSuperAdmin(c, provider.org_id) || !await isOrgSuperAdmin(c, targetOrgId))
    quickError(403, 'link_requires_super_admin', 'You must be super admin of both organizations to share an SSO provider')
  await requireEnterprisePlan(c, targetOrgId)

  const auth = c.get('auth')!
  try {
    const link = await withPgPool(c, async (pool) => {
      const { rows } = await pool.query(
        `
          insert into public.sso_provider_org_links (sso_provider_id, org_id, linked_by)
          values ($1, $2, $3)
          returning sso_provider_id as provider_id, org_id, role_mapping, created_at
        `,
        [id, targetOrgId, auth.authType === 'jwt' ? auth.userId : null],
      )
      return rows[0]
    })
    return c.json(link)
  }
  catch (error) {
    if ((error as { code?: string })?.code === '23505')
      return quickError(409, 'link_exists', 'The SSO provider is already shared with this organization')
    if ((error as { code?: string })?.code === '23503')
      return quickError(404, 'org_not_found', 'Organization not found')
    throw error
  }
})

// The linked org's super admins own its mapping, like the owner org's.
app.put('/:id/links/:orgId', async (c) => {
  const id = parseUuidParam(c.req.param('id'), 'invalid_provider_id', 'Invalid provider id')
  const orgId = parseUuidParam(c.req.param('orgId'), 'invalid_org_id', 'Invalid org_id')
  const validation = safeParseSchema(updateLinkBodySchema, await parseBody<{ role_mapping?: unknown }>(c))
  if (!validation.success)
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  const roleMapping = validation.data.role_mapping

  const provider = await getProviderForLink(c, id)
  await requireManageSsoPermission(c, orgId)
  await requireSuperAdminForRoleMapping(c, orgId)
  if (roleMapping)
    await requireMappingTargetsInOrg(c, orgId, roleMapping)

  const pgPool = getPgClient(c)
  try {
    const link = await withPgTransaction(pgPool, async (client) => {
      // Up to two Management API calls (8s each) run while the row is locked.
      await client.query('SET LOCAL idle_in_transaction_session_timeout = 30000')
      // Same lock as a provider PATCH: the Auth attribute mapping is the union
      // of every org's mapping, so writes to it are serialized per provider.
      const locked = await client.query<{ provider_id: string | null, attribute_mapping: Record<string, string> | null, role_mapping: unknown }>(
        'select provider_id, attribute_mapping, role_mapping from public.sso_providers where id = $1 for update',
        [id],
      )
      const current = locked.rows[0]
      if (!current)
        quickError(404, 'provider_not_found', 'SSO provider not found')
      const existing = await client.query<{ role_mapping: unknown }>(
        'select role_mapping from public.sso_provider_org_links where sso_provider_id = $1 and org_id = $2 for update',
        [id, orgId],
      )
      if (!existing.rows[0])
        quickError(404, 'link_not_found', 'The SSO provider is not shared with this organization')

      if (current!.provider_id) {
        const otherMappings = await loadLinkedRoleMappings(client, id, orgId)
        const allMappings = [parseStoredRoleMapping(current!.role_mapping), ...otherMappings]
        const before = buildAuthAttributeMapping(current!.attribute_mapping ?? {}, [...allMappings, parseStoredRoleMapping(existing.rows[0]!.role_mapping)])
        const after = buildAuthAttributeMapping(current!.attribute_mapping ?? {}, [...allMappings, roleMapping])
        // Auth only ever gains claims here, so nothing has to be restored if
        // the write below fails: an unused claim is harmless. Attributes only
        // the previous mapping used are left in place for the same reason.
        if (Object.keys(after).some(key => !(key in before))) {
          try {
            await updateSSOProvider(c, current!.provider_id, { attribute_mapping: { ...before, ...after } })
          }
          catch (err) {
            if (err instanceof ManagementAPIError)
              quickError(err.status >= 400 && err.status < 500 ? err.status : 502, 'provider_update_failed', err.message, { management_error_code: err.code })
            throw err
          }
        }
      }

      const { rows } = await client.query(
        `
          update public.sso_provider_org_links
          set role_mapping = $3, updated_at = now()
          where sso_provider_id = $1 and org_id = $2
          returning sso_provider_id as provider_id, org_id, role_mapping, created_at
        `,
        [id, orgId, roleMapping === null ? null : JSON.stringify(roleMapping)],
      )
      // Invalidates provider PATCHes computed from the previous mappings.
      await client.query('update public.sso_providers set updated_at = now() where id = $1', [id])

      const previous = mappingTargets(parseStoredRoleMapping(existing.rows[0]!.role_mapping))
      const next = mappingTargets(roleMapping)
      const appIds = [...previous.appIds].filter(appId => !next.appIds.has(appId))
      const groupIds = [...previous.groupIds].filter(groupId => !next.groupIds.has(groupId))
      await revokeUnmappedSsoAccess(client, orgId, provider.domain, appIds, groupIds)
      return rows[0]
    })
    return c.json(link)
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to update SSO provider link', providerId: id, orgId, error })
    return quickError(500, 'link_update_failed', 'Failed to update the shared SSO provider')
  }
  finally {
    await closeClient(c, pgPool)
  }
})

// Either side can end the sharing. Access SSO already granted in the linked
// org stays as is (like deleting a provider): admins manage those members
// manually from then on.
app.delete('/:id/links/:orgId', async (c) => {
  const id = parseUuidParam(c.req.param('id'), 'invalid_provider_id', 'Invalid provider id')
  const orgId = parseUuidParam(c.req.param('orgId'), 'invalid_org_id', 'Invalid org_id')

  const provider = await getProviderForLink(c, id)
  if (!await isOrgSuperAdmin(c, orgId) && !await isOrgSuperAdmin(c, provider.org_id))
    quickError(403, 'link_requires_super_admin', 'Only super admins of either organization can stop sharing an SSO provider')

  const deleted = await withPgPool(c, pool => withPgTransaction(pool, async (client) => {
    const result = await client.query('delete from public.sso_provider_org_links where sso_provider_id = $1 and org_id = $2', [id, orgId])
    // Like a mapping save: invalidates provider PATCHes computed with this link.
    if ((result.rowCount ?? 0) > 0)
      await client.query('update public.sso_providers set updated_at = now() where id = $1', [id])
    return result.rowCount ?? 0
  }))
  if (deleted === 0)
    quickError(404, 'link_not_found', 'The SSO provider is not shared with this organization')
  return c.json(BRES)
})

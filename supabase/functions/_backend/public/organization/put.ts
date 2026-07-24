import type { Context } from 'hono'
import type { AuthInfo, MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl, normalizeImagePath } from '../../utils/storage.ts'
import { getStripeCustomerName, isDeterministicStripeCustomerUpdateError, updateCustomerOrganizationName } from '../../utils/stripe.ts'
import { apikeyHasOrgRightWithPolicy, supabaseAdmin, supabaseApikey, supabaseClient } from '../../utils/supabase.ts'
import { normalizeWebsiteUrl } from './website.ts'

const passwordPolicyMinLengthSchema = z.number().int().min(6).refine(
  value => value <= 72,
  { message: 'a value <= 72' },
)

const passwordPolicyConfigSchema = z.object({
  enabled: z.boolean(),
  min_length: passwordPolicyMinLengthSchema,
  require_uppercase: z.boolean(),
  require_number: z.boolean(),
  require_special: z.boolean(),
})

const bodySchema = z.object({
  orgId: z.string(),
  logo: z.string().optional(),
  name: z.string().optional(),
  website: z.string().nullable().optional(),
  management_email: z.email().optional(),
  require_apikey_expiration: z.boolean().optional(),
  max_apikey_expiration_days: z.number().nullable().optional(),
  enforce_hashed_api_keys: z.boolean().optional(),
  enforce_encrypted_bundles: z.boolean().optional(),
  required_encryption_key: z.string().nullable().optional(),
  enforcing_2fa: z.boolean().optional(),
  password_policy_config: passwordPolicyConfigSchema.nullable().optional(),
})

type OrgRow = Database['public']['Tables']['orgs']['Row']
type OrgUpdateFields = Partial<Database['public']['Tables']['orgs']['Update']>
type PasswordPolicyConfig = z.infer<typeof passwordPolicyConfigSchema>

interface OrganizationPutBody {
  orgId: string
  logo?: string
  name?: string
  website?: string | null
  management_email?: string
  require_apikey_expiration?: boolean
  max_apikey_expiration_days?: number | null
  enforce_hashed_api_keys?: boolean
  enforce_encrypted_bundles?: boolean
  required_encryption_key?: string | null
  enforcing_2fa?: boolean
  password_policy_config?: PasswordPolicyConfig | null
}

interface PgTransactionClient {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[], rowCount?: number | null }>
  release: () => void
}

const ORGANIZATION_UPDATE_COLUMNS = {
  logo: 'logo',
  name: 'name',
  website: 'website',
  management_email: 'management_email',
  require_apikey_expiration: 'require_apikey_expiration',
  max_apikey_expiration_days: 'max_apikey_expiration_days',
  enforce_hashed_api_keys: 'enforce_hashed_api_keys',
  enforce_encrypted_bundles: 'enforce_encrypted_bundles',
  required_encryption_key: 'required_encryption_key',
  enforcing_2fa: 'enforcing_2fa',
  password_policy_config: 'password_policy_config', // NOSONAR: SQL column identifier, not a credential.
} as const

function getOrganizationUpdateColumn(field: string) {
  const column = ORGANIZATION_UPDATE_COLUMNS[field as keyof typeof ORGANIZATION_UPDATE_COLUMNS]
  if (!column)
    throw new Error('invalid_organization_update_field')
  return column
}

function buildOrganizationUpdateQuery(
  orgId: string,
  updateFields: OrgUpdateFields,
  options?: { expectedCurrentName?: string, expectedCurrentFields?: OrgUpdateFields },
) {
  const params: unknown[] = []
  const assignments: string[] = []
  for (const [field, value] of Object.entries(updateFields)) {
    if (value === undefined)
      continue
    params.push(value)
    assignments.push(`${getOrganizationUpdateColumn(field)} = $${params.length}`)
  }

  params.push(orgId)
  const conditions = [`id = $${params.length}::uuid`]
  const addExpectedCondition = (field: string, value: unknown) => {
    const column = getOrganizationUpdateColumn(field)
    if (value === null) {
      conditions.push(`${column} IS NULL`)
      return
    }
    params.push(value)
    conditions.push(`${column} = $${params.length}`)
  }

  if (options?.expectedCurrentName !== undefined)
    addExpectedCondition('name', options.expectedCurrentName)
  if (options?.expectedCurrentFields) {
    for (const [field, value] of Object.entries(options.expectedCurrentFields)) {
      if (value !== undefined)
        addExpectedCondition(field, value)
    }
  }

  const where = conditions.join(' AND ')
  return assignments.length === 0
    ? { query: `SELECT * FROM public.orgs WHERE ${where}`, params }
    : { query: `UPDATE public.orgs SET ${assignments.join(', ')} WHERE ${where} RETURNING *`, params }
}

async function setOrganizationUpdateAuditActor(
  c: Context<MiddlewareKeyVariables>,
  dbClient: PgTransactionClient,
  auth: AuthInfo,
) {
  const isJwt = auth.authType === 'jwt'
  const claims = isJwt ? auth.claims ?? { sub: auth.userId, role: 'authenticated' } : {}
  const role = isJwt ? 'authenticated' : 'anon'
  const subject = isJwt ? auth.userId : ''
  await dbClient.query(
    'SELECT set_config($1, $2, true)',
    ['request.jwt.claim.sub', subject],
  )
  await dbClient.query(
    'SELECT set_config($1, $2, true)',
    ['request.jwt.claim.role', role],
  )
  await dbClient.query(
    'SELECT set_config($1, $2, true)',
    ['request.jwt.claims', JSON.stringify(claims)],
  )

  let requestHeaders: Record<string, string> = {}
  if (auth.authType === 'apikey') {
    const apikey = c.get('capgkey') ?? auth.apikey?.key
    if (!apikey)
      throw simpleError('cannot_access_organization', 'You can\'t access this organization')
    requestHeaders = { capgkey: apikey }
  }
  await dbClient.query(
    'SELECT set_config($1, $2, true)',
    ['request.headers', JSON.stringify(requestHeaders)],
  )
  await dbClient.query(isJwt ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon')
}

function parseOrganizationBody(bodyRaw: unknown): OrganizationPutBody {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  return bodyParsed.data
}

async function ensureOrgAccess(
  c: Context<MiddlewareKeyVariables>,
  apikey: Database['public']['Tables']['apikeys']['Row'] | null | undefined,
  orgId: string,
  supabase: ReturnType<typeof supabaseApikey>,
) {
  if (!(await checkPermission(c, 'org.update_settings', { orgId }))) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId })
  }

  if (!apikey) {
    return
  }

  const orgCheck = await apikeyHasOrgRightWithPolicy(c, apikey, orgId, supabase)
  if (orgCheck.valid) {
    return
  }
  if (orgCheck.error === 'org_requires_expiring_key') {
    throw quickError(401, 'org_requires_expiring_key', 'This organization requires API keys with an expiration date. Please use a different key or update this key with an expiration date.')
  }
  throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId })
}

function validateMaxExpirationDays(maxDays?: number | null) {
  if (maxDays === undefined || maxDays === null) {
    return
  }
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 365) {
    throw simpleError('invalid_max_expiration_days', 'Maximum expiration days must be between 1 and 365')
  }
}

function normalizeRequiredEncryptionKey(requiredEncryptionKey?: string | null) {
  if (requiredEncryptionKey === undefined) {
    return undefined
  }
  const normalized = requiredEncryptionKey?.trim() ?? null
  return normalized === '' ? null : normalized
}

function validateRequiredEncryptionKey(requiredKey?: string | null) {
  const normalized = normalizeRequiredEncryptionKey(requiredKey)
  if (normalized === undefined || normalized === null) {
    return normalized
  }
  if (normalized.length !== 20 && normalized.length !== 21) {
    throw simpleError('invalid_required_encryption_key', 'Encryption key fingerprint must be 20 or 21 characters')
  }
  return normalized
}

function buildUpdateFields(body: OrganizationPutBody, sanitizedName?: string) {
  const updateFields: OrgUpdateFields = {}
  if (body.name !== undefined)
    updateFields.name = sanitizedName ?? body.name
  if (body.website !== undefined)
    updateFields.website = normalizeWebsiteUrl(body.website)
  if (body.logo !== undefined)
    updateFields.logo = normalizeImagePath(body.logo) ?? body.logo
  if (body.management_email !== undefined)
    updateFields.management_email = body.management_email
  if (body.require_apikey_expiration !== undefined)
    updateFields.require_apikey_expiration = body.require_apikey_expiration
  if (body.max_apikey_expiration_days !== undefined)
    updateFields.max_apikey_expiration_days = body.max_apikey_expiration_days
  if (body.enforce_hashed_api_keys !== undefined)
    updateFields.enforce_hashed_api_keys = body.enforce_hashed_api_keys
  if (body.enforce_encrypted_bundles !== undefined)
    updateFields.enforce_encrypted_bundles = body.enforce_encrypted_bundles
  if (body.required_encryption_key !== undefined)
    updateFields.required_encryption_key = validateRequiredEncryptionKey(body.required_encryption_key)
  if (body.enforcing_2fa !== undefined)
    updateFields.enforcing_2fa = body.enforcing_2fa
  if (body.password_policy_config !== undefined)
    updateFields.password_policy_config = body.password_policy_config
  return updateFields
}

async function sanitizeOrgNameForSync(
  supabase: ReturnType<typeof supabaseApikey>,
  name: string,
) {
  const { data, error } = await supabase.rpc('strip_html', { input: name })

  if (error || data === null) {
    throw simpleError('cannot_update_org', 'Cannot update org', {
      error: error?.message ?? 'cannot_sanitize_org_name',
    })
  }

  const sanitizedName = data.trim()
  if (!sanitizedName) {
    throw simpleError('invalid_body', 'Invalid body', {
      error: 'sanitized_name_empty',
    })
  }

  return sanitizedName
}

async function enforceSelf2faRequirement(authUserId: string, c: Context<MiddlewareKeyVariables>) {
  const { data: has2faEnabled, error } = await supabaseAdmin(c)
    .rpc('has_2fa_enabled', { user_id: authUserId })

  if (error) {
    throw quickError(500, 'cannot_check_2fa', 'Cannot verify your 2FA status', { error: error.message })
  }
  if (!has2faEnabled) {
    throw simpleError('requires_2fa_to_enforce_2fa', 'You must enable 2FA before enforcing it for your organization')
  }
}

async function updateOrg(
  c: Context<MiddlewareKeyVariables>,
  auth: AuthInfo,
  orgId: string,
  updateFields: OrgUpdateFields,
  options?: { expectedCurrentName?: string, expectedCurrentFields?: OrgUpdateFields },
) {
  let pgPool: ReturnType<typeof getPgClient> | null = null
  let dbClient: PgTransactionClient | null = null
  let transactionStarted = false
  let data: OrgRow | undefined
  try {
    pgPool = getPgClient(c)
    dbClient = await pgPool.connect() as PgTransactionClient
    await dbClient.query('BEGIN')
    transactionStarted = true
    // Use the primary connection with the request role and claims so RLS and audit triggers remain authoritative.
    await setOrganizationUpdateAuditActor(c, dbClient, auth)
    const { query, params } = buildOrganizationUpdateQuery(orgId, updateFields, options)
    data = (await dbClient.query<OrgRow>(query, params)).rows[0]
    await dbClient.query('COMMIT')
  }
  catch (error) {
    if (dbClient && transactionStarted) {
      try {
        await dbClient.query('ROLLBACK')
      }
      catch {
        // Keep the original database error as the response cause.
      }
    }
    throw simpleError('cannot_update_org', 'Cannot update org', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  finally {
    dbClient?.release()
    if (pgPool)
      await closeClient(c, pgPool)
  }

  if (!data) {
    throw simpleError('cannot_update_org', 'Cannot update org', {
      error: 'org_name_changed',
      orgId,
    })
  }

  return data
}

function buildRollbackFields(
  currentOrg: OrgRow,
  updateFields: OrgUpdateFields,
) {
  const rollbackFields: OrgUpdateFields = {}

  for (const key of Object.keys(updateFields) as Array<keyof OrgUpdateFields>) {
    rollbackFields[key] = currentOrg[key as keyof OrgRow] as never
  }

  return rollbackFields
}

function buildExpectedCurrentFields(
  currentOrg: OrgRow,
  updateFields: OrgUpdateFields,
) {
  const expectedCurrentFields: OrgUpdateFields = {}

  for (const key of Object.keys(updateFields) as Array<keyof OrgUpdateFields>) {
    expectedCurrentFields[key] = currentOrg[key as keyof OrgRow] as never
  }

  return expectedCurrentFields
}

async function getOrgForNameSync(
  supabase: ReturnType<typeof supabaseApikey>,
  orgId: string,
): Promise<OrgRow> {
  const { error, data } = await supabase
    .from('orgs')
    .select('*')
    .eq('id', orgId)
    .single()

  if (error) {
    throw simpleError('cannot_get_org', 'Cannot get org', { error: error.message })
  }

  return data
}

function getErrorDetail(error: unknown) {
  if (error instanceof HTTPException) {
    const httpErrorDetail = (error.cause as { moreInfo?: { error?: unknown } } | undefined)?.moreInfo?.error
    if (httpErrorDetail !== undefined)
      return httpErrorDetail
  }

  if (error instanceof Error)
    return error.message

  return error
}

export async function put(
  c: Context<MiddlewareKeyVariables>,
  bodyRaw: any,
  apikey: Database['public']['Tables']['apikeys']['Row'] | null | undefined,
): Promise<Response> {
  const body = parseOrganizationBody(bodyRaw)
  const auth = c.get('auth')
  if (!auth?.userId) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  const rawApiKey = apikey?.key ?? c.get('capgkey')
  const supabase = auth.authType === 'jwt' && auth.jwt
    ? supabaseClient(c, auth.jwt)
    : supabaseApikey(c, rawApiKey)
  const authUserId = auth.userId

  // Auth context is already set by middlewareAuth
  await ensureOrgAccess(c, apikey, body.orgId, supabase)

  if (body.enforcing_2fa) {
    await enforceSelf2faRequirement(authUserId, c)
  }

  validateMaxExpirationDays(body.max_apikey_expiration_days)
  validateRequiredEncryptionKey(body.required_encryption_key)
  const sanitizedOrgName = body.name !== undefined
    ? await sanitizeOrgNameForSync(supabase, body.name)
    : undefined
  const updateFields = buildUpdateFields(body, sanitizedOrgName)
  const shouldSyncStripeName = body.name !== undefined
  const currentOrg = shouldSyncStripeName
    ? await getOrgForNameSync(supabase, body.orgId)
    : null

  const dataOrg: Database['public']['Tables']['orgs']['Row'] = await updateOrg(c, auth, body.orgId, updateFields, {
    expectedCurrentName: shouldSyncStripeName ? currentOrg?.name : undefined,
  })

  const committedCustomerId = dataOrg.customer_id

  if (shouldSyncStripeName && currentOrg && committedCustomerId && !committedCustomerId.startsWith('pending_')) {
    try {
      await updateCustomerOrganizationName(c, committedCustomerId, dataOrg.name)
    }
    catch (stripeError) {
      const stripeCustomerName = await getStripeCustomerName(c, committedCustomerId)

      if (stripeCustomerName === dataOrg.name) {
        // Stripe can time out after persisting the update; don't roll back the DB in that case.
      }
      else if (stripeCustomerName !== undefined || isDeterministicStripeCustomerUpdateError(stripeError)) {
        const rollbackFields = buildRollbackFields(currentOrg, updateFields)

        try {
          await updateOrg(c, auth, body.orgId, rollbackFields, {
            expectedCurrentName: dataOrg.name,
            expectedCurrentFields: buildExpectedCurrentFields(dataOrg, updateFields),
          })
        }
        catch (rollbackError) {
          throw simpleError('cannot_update_org', 'Cannot update org', {
            error: getErrorDetail(stripeError),
            rollbackError: getErrorDetail(rollbackError),
          })
        }

        throw simpleError('cannot_update_org', 'Cannot update org', {
          error: getErrorDetail(stripeError),
        })
      }
      else {
        throw simpleError('cannot_update_org', 'Cannot update org', {
          error: getErrorDetail(stripeError),
          stripeSyncState: 'unknown',
        })
      }
    }
  }

  if (dataOrg.logo) {
    const signedLogo = await createSignedImageUrl(c, dataOrg.logo)
    dataOrg.logo = signedLogo ?? null
  }

  return c.json({ status: 'Organization updated', id: dataOrg.id, data: dataOrg }, 200)
}

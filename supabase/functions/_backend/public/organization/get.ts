import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { RlsPrincipal } from '../../utils/pg_rls.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { z } from 'zod'
import { integerLikeSchema, safeParseSchema } from '../../utils/schema_validation.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../utils/pg_rls.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { createSignedImageUrl } from '../../utils/storage.ts'
import { apikeyHasOrgRightWithPolicy } from '../../utils/supabase.ts'
import { fetchLimit } from '../../utils/utils.ts'

const bodySchema = z.object({
  orgId: z.string().optional(),
  page: integerLikeSchema.refine(page => Number.isSafeInteger(page) && page >= 0, { message: 'page must be a non-negative integer' }).optional(),
})
// The DB only constrains min_length when present, so stored policies can be partial.
const passwordPolicyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  min_length: z.number().int().optional(),
  require_uppercase: z.boolean().optional(),
  require_number: z.boolean().optional(),
  require_special: z.boolean().optional(),
})

const orgSchema = z.object({
  id: z.uuid(),
  created_by: z.uuid(),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
  logo: z.string().nullable(),
  name: z.string(),
  management_email: z.email(),
  customer_id: z.string().nullable(),
  website: z.string().nullable(),
  enforcing_2fa: z.boolean(),
  password_policy_config: passwordPolicyConfigSchema.nullable(),
  require_apikey_expiration: z.boolean(),
  max_apikey_expiration_days: z.number().nullable(),
  enforce_hashed_api_keys: z.boolean(),
})

const orgsSchema = z.array(orgSchema)

function parseBody(bodyRaw: unknown) {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  return bodyParsed.data
}

function parseOrg(data: unknown) {
  const dataParsed = safeParseSchema(orgSchema, data)
  if (!dataParsed.success) {
    throw simpleError('cannot_parse_organization', 'Cannot parse organization', { error: dataParsed.error })
  }
  return dataParsed.data
}

function parseOrgs(data: unknown) {
  const dataParsed = safeParseSchema(orgsSchema, data)
  if (!dataParsed.success) {
    throw simpleError('cannot_parse_organizations', 'Cannot parse organizations', { error: dataParsed.error })
  }
  return dataParsed.data
}

async function ensureOrgAccess(
  c: Context<MiddlewareKeyVariables>,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  orgId: string,
  principal: RlsPrincipal,
) {
  if (!(await checkPermission(c, 'org.read', { orgId }))) {
    throw simpleError('invalid_org_id', 'You can\'t access this organization', { org_id: orgId })
  }

  const orgCheck = await apikeyHasOrgRightWithPolicy(c, apikey, orgId, principal)
  if (orgCheck.valid) {
    return
  }
  if (orgCheck.error === 'org_requires_expiring_key') {
    throw quickError(401, 'org_requires_expiring_key', 'This organization requires API keys with an expiration date. Please use a different key or update this key with an expiration date.')
  }
  throw simpleError('invalid_org_id', 'You can\'t access this organization', { org_id: orgId })
}

async function fetchOrg(
  c: Context<MiddlewareKeyVariables>,
  principal: RlsPrincipal,
  orgId: string,
) {
  let data: unknown[]
  try {
    data = await withRlsContext(c, principal, client => queryJson(client, 'SELECT * FROM public.orgs WHERE id = $1', [orgId]))
  }
  catch (error) {
    throw simpleError('cannot_get_organization', 'Cannot get organization', { error })
  }
  // single(): no visible row was an error too.
  if (data.length !== 1) {
    throw simpleError('cannot_get_organization', 'Cannot get organization', { error: null })
  }
  return parseOrg(data[0])
}

async function fetchOrgs(
  c: Context<MiddlewareKeyVariables>,
  principal: RlsPrincipal,
  page = 0,
) {
  const from = page * fetchLimit
  let data: unknown[]
  try {
    data = await withRlsContext(c, principal, client => queryJson(client, 'SELECT * FROM public.orgs LIMIT $1 OFFSET $2', [fetchLimit, from]))
  }
  catch (error) {
    throw simpleError('cannot_get_organizations', 'Cannot get organizations', { error })
  }
  return parseOrgs(data)
}

export async function get(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  const body = parseBody(bodyRaw)
  const principal = apikeyPrincipal(c, apikey.key)

  // Auth context is already set by middlewareKey
  if (body.orgId) {
    await ensureOrgAccess(c, apikey, body.orgId, principal)
    const org = await fetchOrg(c, principal, body.orgId)
    if (org.logo) {
      const signedLogo = await createSignedImageUrl(c, org.logo, { orgId: org.id })
      org.logo = signedLogo ?? null
    }

    return c.json(org)
  }

  const orgs = await fetchOrgs(c, principal, body.page)
  const signedOrgs = await Promise.all(orgs.map(async (org) => {
    if (!org.logo)
      return org
    const signedLogo = await createSignedImageUrl(c, org.logo, { orgId: org.id })
    return {
      ...org,
      logo: signedLogo ?? null,
    }
  }))

  return c.json(signedOrgs)
}

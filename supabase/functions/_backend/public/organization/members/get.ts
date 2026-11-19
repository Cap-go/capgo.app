import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../../utils/hono.ts'
import type { Database } from '../../../utils/supabase.types.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../../utils/schema_validation.ts'
import { quickError, simpleError } from '../../../utils/hono.ts'
import { cloudlog } from '../../../utils/logging.ts'
import { apikeyPrincipal, queryJson, withRlsContext } from '../../../utils/pg_rls.ts'
import { checkPermission } from '../../../utils/rbac.ts'
import { createSignedImageUrl } from '../../../utils/storage.ts'
import { apikeyHasOrgRightWithPolicy } from '../../../utils/supabase.ts'

export const MAX_MEMBERS_PAGE_SIZE = 1000

const bodySchema = z.object({
  orgId: z.string(),
  // Optional paging; omit both to get every member as before. GET passes them as query strings.
  limit: z.coerce.number().int().min(1).max(MAX_MEMBERS_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

type Member = z.infer<typeof memberSchema>[number]

function compareMembers(a: Member, b: Member) {
  if (a.email !== b.email)
    return a.email < b.email ? -1 : 1
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0
}

/** Pages by email then user id so consecutive pages neither repeat nor skip members. */
function pageMembers(members: Member[], limit: number | undefined, offset: number | undefined): Member[] {
  if (limit === undefined && offset === undefined)
    return members
  const start = offset ?? 0
  const sorted = [...members].sort(compareMembers)
  return limit === undefined ? sorted.slice(start) : sorted.slice(start, start + limit)
}

const memberSchema = z.array(z.object({
  uid: z.uuid(),
  email: z.email(),
  image_url: z.string().nullish(),
  role: z.string(),
  is_tmp: z.boolean(),
}))

export async function get(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
  const bodyParsed = safeParseSchema(bodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data
  const auth = c.get('auth') as { apikey?: Database['public']['Tables']['apikeys']['Row'] } | undefined
  const effectiveApikey = auth?.apikey ?? apikey

  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'org.read_members', { orgId: body.orgId }))) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  const principal = apikeyPrincipal(c, effectiveApikey.key)
  const orgCheck = await apikeyHasOrgRightWithPolicy(c, effectiveApikey, body.orgId, principal)
  if (!orgCheck.valid) {
    if (orgCheck.error === 'org_requires_expiring_key') {
      throw quickError(401, 'org_requires_expiring_key', 'This organization requires API keys with an expiration date. Please use a different key or update this key with an expiration date.')
    }
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  // Run as the caller so RLS and the RPC's EXECUTE grant still apply
  let data: unknown[] | null = null
  let error: unknown = null
  try {
    data = await withRlsContext(c, principal, client => queryJson(
      client,
      'SELECT * FROM public.get_org_members(guild_id => $1::uuid)',
      [body.orgId],
    ))
  }
  catch (rpcError) {
    error = rpcError
  }

  cloudlog({ requestId: c.get('requestId'), message: 'data', data, error })
  if (error) {
    throw simpleError('cannot_get_organization_members', 'Cannot get organization members', { error })
  }

  const parsed = safeParseSchema(memberSchema, data)
  if (!parsed.success) {
    throw simpleError('cannot_parse_members', 'Cannot parse members', { error: parsed.error })
  }
  // Page before signing image URLs, so a page only signs the images it returns.
  const members = pageMembers(parsed.data, body.limit, body.offset)
  const signedMembers = await Promise.all(members.map(async (member) => {
    if (!member.image_url) {
      return {
        ...member,
        image_url: '',
      }
    }
    const signedImage = await createSignedImageUrl(c, member.image_url, { userId: member.uid })
    return {
      ...member,
      image_url: signedImage ?? '',
    }
  }))

  cloudlog({ requestId: c.get('requestId'), message: 'Members', data: signedMembers })
  return c.json(signedMembers)
}

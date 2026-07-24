import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../../utils/hono.ts'
import type { Database } from '../../../utils/supabase.types.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../../utils/schema_validation.ts'
import { quickError, simpleError } from '../../../utils/hono.ts'
import { cloudlog } from '../../../utils/logging.ts'
import { checkPermission } from '../../../utils/rbac.ts'
import { createSignedImageUrl } from '../../../utils/storage.ts'
import { apikeyHasOrgRightWithPolicy, supabaseApikey } from '../../../utils/supabase.ts'

const bodySchema = z.object({
  orgId: z.string(),
})

const memberSchema = z.array(z.object({
  uid: z.uuid(),
  email: z.email(),
  image_url: z.string().nullish(),
  role: z.string(),
  is_tmp: z.boolean(),
}))

export async function get(c: Context<MiddlewareKeyVariables>, bodyRaw: any, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<Response> {
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

  const supabase = supabaseApikey(c, effectiveApikey.key)
  const orgCheck = await apikeyHasOrgRightWithPolicy(c, effectiveApikey, body.orgId, supabase)
  if (!orgCheck.valid) {
    if (orgCheck.error === 'org_requires_expiring_key') {
      throw quickError(401, 'org_requires_expiring_key', 'This organization requires API keys with an expiration date. Please use a different key or update this key with an expiration date.')
    }
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  // Use authenticated client for data queries - RLS will enforce access
  const { data, error } = await supabase
    .rpc('get_org_members', {
      guild_id: body.orgId,
    })

  cloudlog({ requestId: c.get('requestId'), message: 'data', data, error })
  if (error) {
    throw simpleError('cannot_get_organization_members', 'Cannot get organization members', { error })
  }

  const parsed = safeParseSchema(memberSchema, data)
  if (!parsed.success) {
    throw simpleError('cannot_parse_members', 'Cannot parse members', { error: parsed.error })
  }
  const signedMembers = await Promise.all(parsed.data.map(async (member) => {
    if (!member.image_url) {
      return {
        ...member,
        image_url: '',
      }
    }
    const signedImage = await createSignedImageUrl(c, member.image_url)
    return {
      ...member,
      image_url: signedImage ?? '',
    }
  }))

  cloudlog({ requestId: c.get('requestId'), message: 'Members', data: signedMembers })
  return c.json(signedMembers)
}

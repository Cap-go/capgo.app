import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../../utils/hono.ts'
import type { Database } from '../../../utils/supabase.types.ts'
import { z } from 'zod'
import { safeParseSchema } from '../../../utils/schema_validation.ts'
import { BRES, simpleError } from '../../../utils/hono.ts'
import { cloudlog } from '../../../utils/logging.ts'
import { checkPermission } from '../../../utils/rbac.ts'
import { supabaseApikey } from '../../../utils/supabase.ts'

const rbacInviteRoles = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin'] as const

type RbacInviteRole = (typeof rbacInviteRoles)[number]

const inviteRoleAliases: Record<string, RbacInviteRole> = {
  read: 'org_member',
  upload: 'org_member',
  write: 'org_member',
  admin: 'org_admin',
  super_admin: 'org_super_admin',
  invite_read: 'org_member',
  invite_upload: 'org_member',
  invite_write: 'org_member',
  invite_admin: 'org_admin',
  invite_super_admin: 'org_super_admin',
}

const allowedInviteRoles = [...rbacInviteRoles, ...Object.keys(inviteRoleAliases)]
const allowedInviteRoleSet = new Set<string>(allowedInviteRoles)
const rbacInviteRoleSet = new Set<string>(rbacInviteRoles)
const inviteTypeSchema = z.enum(allowedInviteRoles as [string, ...string[]])

const inviteBodySchema = z.object({
  orgId: z.string(),
  email: z.email(),
  invite_type: inviteTypeSchema,
})

export function normalizeInviteRole(inviteType: string): RbacInviteRole | null {
  if (!allowedInviteRoleSet.has(inviteType))
    return null

  if (rbacInviteRoleSet.has(inviteType))
    return inviteType as RbacInviteRole

  return inviteRoleAliases[inviteType]
}

export async function post(c: Context<MiddlewareKeyVariables>, bodyRaw: any, _apikey: Database['public']['Tables']['apikeys']['Row']) {
  const bodyParsed = safeParseSchema(inviteBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'org.invite_user', { orgId: body.orgId }))) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  const supabase = supabaseApikey(c, _apikey?.key)

  const rbacRoleName = normalizeInviteRole(body.invite_type)

  if (!rbacRoleName)
    throw simpleError('invalid_body', 'Invalid invite type', { invite_type: body.invite_type })

  const { data, error } = await supabase.rpc('invite_user_to_org_rbac', {
    email: body.email,
    org_id: body.orgId,
    role_name: rbacRoleName,
  })

  if (error) {
    throw simpleError('error_inviting_user_to_organization', 'Error inviting user to organization', { error })
  }
  if (data && data !== 'OK') {
    throw simpleError('error_inviting_user_to_organization', 'Error inviting user to organization', { data })
  }
  cloudlog({ requestId: c.get('requestId'), message: 'User invited to organization', data: { email: body.email, org_id: body.orgId } })
  return c.json(BRES)
}

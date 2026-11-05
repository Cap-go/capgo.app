import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../../utils/hono.ts'
import { and, eq, isNull } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { getCallerMaxPriorityRank, isLastSuperAdminDemotionError, lockRbacOrgs, updateRoleBindingRole } from '../../../private/role_bindings.ts'
import { BRES, quickError, simpleError } from '../../../utils/hono.ts'
import { cloudlog } from '../../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../../utils/pg.ts'
import { schema } from '../../../utils/postgres_schema.ts'
import { checkPermission, checkPermissionPg } from '../../../utils/rbac.ts'
import { safeParseSchema } from '../../../utils/schema_validation.ts'
import { inviteTypeSchema, normalizeInviteRole } from './post.ts'

const updateRoleBodySchema = z.object({
  orgId: z.string().uuid(),
  email: z.email(),
  role: inviteTypeSchema,
})

type DrizzleClient = ReturnType<typeof getDrizzleClient>

/**
 * Change the org-level role of an existing member (same action as "edit role" in Settings > Members).
 * Requires org.update_user_roles. The caller can never assign or modify a role ranked above its own,
 * cannot change its own role, and cannot change the organization owner's role.
 */
export async function updateMemberRole(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown) {
  const bodyParsed = safeParseSchema(updateRoleBodySchema, bodyRaw)
  if (!bodyParsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  const body = bodyParsed.data
  const roleName = normalizeInviteRole(body.role)
  if (!roleName)
    throw simpleError('invalid_role', 'Invalid role', { role: body.role })

  const auth = c.get('auth')
  if (!auth?.userId)
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })

  // Target lookup stays behind role-management permission to avoid user enumeration.
  if (!(await checkPermission(c, 'org.update_user_roles', { orgId: body.orgId })))
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })

  let pgClient: Awaited<ReturnType<typeof getPgClient>> | undefined
  let targetUserId: string
  try {
    pgClient = await getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    // single(): a missing or ambiguous email is not found.
    const targetUsers = await drizzle
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .limit(2)
      .catch(() => null)
    if (targetUsers?.length !== 1)
      throw quickError(404, 'user_not_found', 'User not found')
    targetUserId = targetUsers[0].id
    if (targetUserId === auth.userId)
      throw simpleError('cannot_change_own_role', 'You cannot change your own role')

    const [org] = await drizzle
      .select({ created_by: schema.orgs.created_by })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, body.orgId))
      .catch(() => [])
    if (!org)
      throw quickError(404, 'organization_not_found', 'Organization not found', { orgId: body.orgId })
    if (org.created_by === targetUserId)
      throw simpleError('cannot_change_owner_role', 'The organization owner role cannot be changed', { orgId: body.orgId })

    const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null
    const callerPrincipalId = auth.authType === 'apikey' ? auth.apikey?.rbac_id : auth.userId
    if (!callerPrincipalId)
      throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })

    await drizzle.transaction(async (tx) => {
      const txDrizzle = tx as unknown as DrizzleClient
      await lockRbacOrgs(txDrizzle, [body.orgId])

      // Recheck under the RBAC org lock, not the request-level snapshot.
      if (!(await checkPermissionPg(c, 'org.update_user_roles', { orgId: body.orgId }, txDrizzle, auth.userId, apikeyString)))
        throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })

      const [role] = await txDrizzle
        .select()
        .from(schema.roles)
        .where(and(eq(schema.roles.name, roleName), eq(schema.roles.scope_type, 'org')))
        .limit(1)
      if (!role || !role.is_assignable)
        throw simpleError('invalid_role', 'Role is not assignable', { role: roleName })

      const [binding] = await txDrizzle
        .select()
        .from(schema.role_bindings)
        .where(and(
          eq(schema.role_bindings.principal_type, 'user'),
          eq(schema.role_bindings.principal_id, targetUserId),
          eq(schema.role_bindings.scope_type, 'org'),
          eq(schema.role_bindings.org_id, body.orgId),
          isNull(schema.role_bindings.app_id),
          isNull(schema.role_bindings.channel_id),
        ))
        .limit(1)
      if (!binding)
        throw quickError(404, 'organization_member_not_found', 'User is not a member of this organization', { orgId: body.orgId })

      const callerMaxRank = await getCallerMaxPriorityRank(txDrizzle, auth.authType, callerPrincipalId, body.orgId)
      if (role.priority_rank > callerMaxRank)
        throw quickError(403, 'cannot_assign_higher_role', 'Cannot assign a role with higher privileges than your own', { orgId: body.orgId })

      // Only updates when the member's current role is not ranked above the caller.
      const updated = await updateRoleBindingRole(txDrizzle, binding.id, binding, role.id, callerMaxRank)
      if (!updated)
        throw quickError(403, 'cannot_modify_higher_role', 'Cannot modify a member with a role higher than your own', { orgId: body.orgId })
    })
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    if (isLastSuperAdminDemotionError(error))
      throw simpleError('CANNOT_REMOVE_LAST_SUPER_ADMIN', 'Cannot demote the last super admin of the organization', { orgId: body.orgId })
    throw simpleError('cannot_update_member_role', 'Cannot update member role', { error: error instanceof Error ? error.message : String(error) })
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'Organization member role updated', data: { user_id: targetUserId, org_id: body.orgId, role: roleName } })
  return c.json(BRES)
}

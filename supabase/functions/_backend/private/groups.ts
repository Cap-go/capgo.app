import type { AuthInfo } from '../utils/hono.ts'
import { sValidator } from '@hono/standard-validator'
import { and, eq, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { createHono, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_middleware.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'
import { schema } from '../utils/postgres_schema.ts'
import { checkPermission, checkPermissionPg } from '../utils/rbac.ts'
import { version } from '../utils/version.ts'
import {
  addGroupMemberBodyHook,
  addGroupMemberBodySchema,
  createGroupBodyHook,
  createGroupBodySchema,
  groupIdParamSchema,
  groupMemberParamSchema,
  invalidGroupIdHook,
  invalidGroupMemberParamHook,
  invalidOrgIdHook,
  orgIdParamSchema,
  updateGroupBodyHook,
  updateGroupBodySchema,
  validateJsonBody,
} from './rbac_validation.ts'
import { lockRbacOrgs } from './role_bindings.ts'

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth())
type DrizzleClient = ReturnType<typeof getDrizzleClient>

interface GroupRankPrincipal {
  principalType: 'user' | 'apikey'
  principalId: string
}

function getGroupRankPrincipal(auth: AuthInfo): GroupRankPrincipal | null {
  if (auth.authType === 'apikey') {
    if (!auth.apikey?.rbac_id)
      return null

    return {
      principalType: 'apikey',
      principalId: auth.apikey.rbac_id,
    }
  }

  return {
    principalType: 'user',
    principalId: auth.userId,
  }
}

async function canManageGroupRank(
  drizzle: DrizzleClient,
  auth: AuthInfo,
  groupId: string,
): Promise<boolean> {
  const principal = getGroupRankPrincipal(auth)
  if (!principal)
    return false

  const result = await drizzle.execute(sql`
    SELECT public.principal_can_manage_group_rank(
      ${principal.principalType}::text,
      ${principal.principalId}::uuid,
      ${groupId}::uuid
    ) AS allowed
  `)

  return (result.rows[0] as { allowed?: boolean } | undefined)?.allowed === true
}

async function canManageGroupRoles(
  c: Parameters<typeof checkPermission>[0],
  drizzle: DrizzleClient,
  orgId: string,
): Promise<boolean> {
  const auth = c.get('auth')
  if (!auth?.userId) {
    return false
  }

  return await checkPermissionPg(
    c,
    'org.update_user_roles',
    { orgId },
    drizzle,
    auth.userId,
    auth.apikey?.key ?? c.get('capgkey') ?? null,
  )
}

type GroupRecord = typeof schema.groups.$inferSelect

async function loadGroupLockOrgId(
  drizzle: DrizzleClient,
  groupId: string,
): Promise<string | null> {
  const [group] = await drizzle
    .select({ orgId: schema.groups.org_id })
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1)

  return group?.orgId ?? null
}

async function withLockedGroup<T>(
  drizzle: DrizzleClient,
  groupId: string,
  operation: (txDrizzle: DrizzleClient, group: GroupRecord) => Promise<T>,
): Promise<T | null> {
  const lockOrgId = await loadGroupLockOrgId(drizzle, groupId)
  if (!lockOrgId)
    return null

  return await drizzle.transaction(async (tx) => {
    const txDrizzle = tx as unknown as DrizzleClient
    await lockRbacOrgs(txDrizzle, [lockOrgId])
    const [group] = await txDrizzle
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1)
    if (!group)
      return null
    return await operation(txDrizzle, group)
  })
}

function isLastEffectiveSuperAdminError(error: unknown): boolean {
  let currentError = error
  for (let depth = 0; depth < 4 && currentError !== null && currentError !== undefined; depth += 1) {
    const errorRecord = typeof currentError === 'object'
      ? currentError as { cause?: unknown, message?: unknown }
      : null
    let errorMessage = ''
    if (typeof errorRecord?.message === 'string')
      errorMessage = errorRecord.message
    else if (typeof currentError === 'string')
      errorMessage = currentError
    if (errorMessage.includes('CANNOT_REMOVE_LAST_EFFECTIVE_SUPER_ADMIN'))
      return true
    currentError = errorRecord?.cause
  }
  return false
}

// GET /private/groups/:org_id - List groups for an org
app.get('/:org_id', sValidator('param', orgIdParamSchema, invalidOrgIdHook), async (c) => {
  const { org_id: orgId } = c.req.valid('param')
  const userId = c.get('auth')?.userId

  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  if (!(await checkPermission(c, 'org.update_user_roles', { orgId }))) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    // Fetch groups
    const groups = await drizzle
      .select({
        id: schema.groups.id,
        name: schema.groups.name,
        description: schema.groups.description,
        is_system: schema.groups.is_system,
        created_at: schema.groups.created_at,
      })
      .from(schema.groups)
      .where(eq(schema.groups.org_id, orgId))
      .orderBy(schema.groups.name)

    return c.json(groups)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'groups_fetch_failed',
      orgId,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// POST /private/groups/:org_id - Create a group
app.post(
  '/:org_id',
  sValidator('param', orgIdParamSchema, invalidOrgIdHook),
  async (c) => {
    const { org_id: orgId } = c.req.valid('param')
    const userId = c.get('auth')?.userId

    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (!(await checkPermission(c, 'org.update_user_roles', { orgId }))) {
      return c.json({ error: 'Forbidden - Admin rights required' }, 403)
    }

    const bodyResult = await validateJsonBody(c, createGroupBodySchema, createGroupBodyHook)
    if (!bodyResult.ok) {
      return bodyResult.response
    }

    const { name, description } = bodyResult.data

    let pgClient
    try {
      pgClient = getPgClient(c)
      const drizzle = getDrizzleClient(pgClient)

      // Create the group
      const [group] = await drizzle
        .insert(schema.groups)
        .values({
          org_id: orgId,
          name,
          description: description || null,
          created_by: userId,
          is_system: false,
        })
        .returning()

      return c.json(group)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'group_create_failed',
        orgId,
        error,
      })
      return c.json({ error: 'Internal server error' }, 500)
    }
    finally {
      if (pgClient) {
        await closeClient(c, pgClient)
      }
    }
  },
)

// PUT /private/groups/:group_id - Update a group
app.put(
  '/:group_id',
  sValidator('param', groupIdParamSchema, invalidGroupIdHook),
  async (c) => {
    const { group_id: groupId } = c.req.valid('param')
    const auth = c.get('auth')
    const userId = auth?.userId

    if (!auth || !userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    let pgClient
    try {
      pgClient = getPgClient(c)
      const drizzle = getDrizzleClient(pgClient)
      const result = await withLockedGroup(drizzle, groupId, async (txDrizzle, group) => {
        if (group.is_system) {
          return { ok: false as const, response: c.json({ error: 'Cannot modify system group' }, 403) }
        }

        if (!(await canManageGroupRoles(c, txDrizzle, group.org_id))) {
          return { ok: false as const, response: c.json({ error: 'Forbidden - Admin rights required' }, 403) }
        }

        if (!(await canManageGroupRank(txDrizzle, auth, groupId))) {
          return { ok: false as const, response: c.json({ error: 'Forbidden - Cannot manage a group with higher privileges than your own' }, 403) }
        }

        const bodyResult = await validateJsonBody(c, updateGroupBodySchema, updateGroupBodyHook)
        if (!bodyResult.ok) {
          return { ok: false as const, response: bodyResult.response }
        }

        const { name, description } = bodyResult.data
        const [updated] = await txDrizzle
          .update(schema.groups)
          .set({
            name: name || group.name,
            description: description !== undefined ? description : group.description,
          })
          .where(eq(schema.groups.id, groupId))
          .returning()

        return { ok: true as const, data: updated }
      })

      if (!result) {
        return c.json({ error: 'Group not found' }, 404)
      }
      if (!result.ok) {
        return result.response
      }

      return c.json(result.data)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'group_update_failed',
        groupId,
        error,
      })
      return c.json({ error: 'Internal server error' }, 500)
    }
    finally {
      if (pgClient) {
        await closeClient(c, pgClient)
      }
    }
  },
)

// DELETE /private/groups/:group_id - Delete a group
app.delete('/:group_id', sValidator('param', groupIdParamSchema, invalidGroupIdHook), async (c) => {
  const { group_id: groupId } = c.req.valid('param')
  const auth = c.get('auth')
  const userId = auth?.userId

  if (!auth || !userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const result = await withLockedGroup(drizzle, groupId, async (txDrizzle, group) => {
      if (group.is_system) {
        return { ok: false as const, response: c.json({ error: 'Cannot delete system group' }, 403) }
      }

      if (!(await canManageGroupRoles(c, txDrizzle, group.org_id))) {
        return { ok: false as const, response: c.json({ error: 'Forbidden - Admin rights required' }, 403) }
      }

      if (!(await canManageGroupRank(txDrizzle, auth, groupId))) {
        return { ok: false as const, response: c.json({ error: 'Forbidden - Cannot manage a group with higher privileges than your own' }, 403) }
      }

      await txDrizzle
        .delete(schema.role_bindings)
        .where(
          and(
            eq(schema.role_bindings.principal_type, 'group'),
            eq(schema.role_bindings.principal_id, groupId),
          ),
        )

      await txDrizzle
        .delete(schema.groups)
        .where(eq(schema.groups.id, groupId))

      return { ok: true as const }
    })

    if (!result) {
      return c.json({ error: 'Group not found' }, 404)
    }
    if (!result.ok) {
      return result.response
    }

    return c.json({ success: true })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'group_delete_failed',
      groupId,
      error,
    })
    if (isLastEffectiveSuperAdminError(error))
      return c.json({ error: 'Cannot remove the last org_super_admin' }, 409)
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// GET /private/groups/:group_id/members - Group members
app.get('/:group_id/members', sValidator('param', groupIdParamSchema, invalidGroupIdHook), async (c) => {
  const { group_id: groupId } = c.req.valid('param')
  const auth = c.get('auth')
  const userId = auth?.userId

  if (!auth || !userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)

    // Fetch the group and verify access
    const [group] = await drizzle
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1)

    if (!group) {
      return c.json({ error: 'Group not found' }, 404)
    }
    const isDirectMember = auth.authType === 'jwt'
      && await drizzle
        .select({ userId: schema.group_members.user_id })
        .from(schema.group_members)
        .where(
          and(
            eq(schema.group_members.group_id, groupId),
            eq(schema.group_members.user_id, auth.userId),
          ),
        )
        .limit(1)
        .then(rows => rows.length > 0)

    if (!isDirectMember) {
      const canManageGroup = await checkPermission(c, 'org.update_user_roles', { orgId: group.org_id })
      if (!canManageGroup || !(await canManageGroupRank(drizzle, auth, groupId))) {
        throw quickError(403, 'forbidden', 'Forbidden')
      }
    }

    // Fetch members with details
    const members = await drizzle
      .select({
        user_id: schema.group_members.user_id,
        email: schema.users.email,
        added_at: schema.group_members.added_at,
      })
      .from(schema.group_members)
      .innerJoin(schema.users, eq(schema.group_members.user_id, schema.users.id))
      .where(eq(schema.group_members.group_id, groupId))
      .orderBy(schema.users.email)

    return c.json(members)
  }
  catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'group_members_fetch_failed',
      groupId,
      error,
    })
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

// POST /private/groups/:group_id/members - Add a member
app.post(
  '/:group_id/members',
  sValidator('param', groupIdParamSchema, invalidGroupIdHook),
  async (c) => {
    const { group_id: groupId } = c.req.valid('param')
    const auth = c.get('auth')
    const userId = auth?.userId

    if (!auth || !userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    let pgClient
    let targetUserId: string | undefined
    try {
      pgClient = getPgClient(c)
      const drizzle = getDrizzleClient(pgClient)
      const result = await withLockedGroup(drizzle, groupId, async (txDrizzle, group) => {
        if (!(await canManageGroupRoles(c, txDrizzle, group.org_id))) {
          return { ok: false as const, response: c.json({ error: 'Forbidden - Admin rights required' }, 403) }
        }

        const bodyResult = await validateJsonBody(c, addGroupMemberBodySchema, addGroupMemberBodyHook)
        if (!bodyResult.ok) {
          return { ok: false as const, response: bodyResult.response }
        }

        targetUserId = bodyResult.data.user_id
        const targetRbacAccess = await txDrizzle
          .select({ id: schema.role_bindings.id })
          .from(schema.role_bindings)
          .where(
            and(
              eq(schema.role_bindings.principal_type, 'user'),
              eq(schema.role_bindings.principal_id, targetUserId),
              eq(schema.role_bindings.org_id, group.org_id),
              sql`(${schema.role_bindings.expires_at} IS NULL OR ${schema.role_bindings.expires_at} > now())`,
            ),
          )
          .limit(1)

        if (!targetRbacAccess.length) {
          return { ok: false as const, response: c.json({ error: 'User is not a member of this org' }, 400) }
        }

        if (!(await canManageGroupRank(txDrizzle, auth, groupId))) {
          return { ok: false as const, response: c.json({ error: 'Forbidden - Cannot manage a group with higher privileges than your own' }, 403) }
        }

        const [member] = await txDrizzle
          .insert(schema.group_members)
          .values({
            group_id: groupId,
            user_id: targetUserId,
            added_by: userId,
          })
          .onConflictDoNothing()
          .returning()

        return { ok: true as const, data: member || { message: 'User already in group' } }
      })

      if (!result) {
        return c.json({ error: 'Group not found' }, 404)
      }
      if (!result.ok) {
        return result.response
      }

      return c.json(result.data)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'group_member_add_failed',
        groupId,
        targetUserId,
        error,
      })
      return c.json({ error: 'Internal server error' }, 500)
    }
    finally {
      if (pgClient) {
        await closeClient(c, pgClient)
      }
    }
  },
)

// DELETE /private/groups/:group_id/members/:user_id - Remove a member
app.delete('/:group_id/members/:user_id', sValidator('param', groupMemberParamSchema, invalidGroupMemberParamHook), async (c) => {
  const { group_id: groupId, user_id: targetUserId } = c.req.valid('param')
  const auth = c.get('auth')
  const userId = auth?.userId

  if (!auth || !userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzle = getDrizzleClient(pgClient)
    const result = await withLockedGroup(drizzle, groupId, async (txDrizzle, group) => {
      if (!(await canManageGroupRoles(c, txDrizzle, group.org_id))) {
        return { ok: false as const, response: c.json({ error: 'Forbidden - Admin rights required' }, 403) }
      }

      if (!(await canManageGroupRank(txDrizzle, auth, groupId))) {
        return { ok: false as const, response: c.json({ error: 'Forbidden - Cannot manage a group with higher privileges than your own' }, 403) }
      }

      await txDrizzle
        .delete(schema.group_members)
        .where(
          and(
            eq(schema.group_members.group_id, groupId),
            eq(schema.group_members.user_id, targetUserId),
          ),
        )

      return { ok: true as const }
    })

    if (!result) {
      return c.json({ error: 'Group not found' }, 404)
    }
    if (!result.ok) {
      return result.response
    }

    return c.json({ success: true })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'group_member_remove_failed',
      groupId,
      targetUserId,
      error,
    })
    if (isLastEffectiveSuperAdminError(error))
      return c.json({ error: 'Cannot remove the last org_super_admin' }, 409)
    return c.json({ error: 'Internal server error' }, 500)
  }
  finally {
    if (pgClient) {
      await closeClient(c, pgClient)
    }
  }
})

import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { unsubscribeBento } from '../utils/bento.ts'
import { normalizeBentoEmail, suppressAndUnsubscribeDeletedUserRecovery } from '../utils/bento_first_org.ts'
import { BRES, middlewareAPISecret, quickError, triggerValidator } from '../utils/hono.ts'
import { removeImageFolder } from '../utils/image_storage.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJson } from '../utils/pg_rls.ts'
import { cancelSubscription } from '../utils/stripe.ts'

export const app = new Hono<MiddlewareKeyVariables>()

const BENTO_USER_DELETE_TIMEOUT_MS = 5_000
const SUPER_ADMIN_ROLES = ['org_super_admin']

interface RbacBinding {
  org_id?: string | null
  principal_id?: string | null
  expires_at?: string | null
}

interface GroupMember {
  group_id?: string | null
  user_id?: string | null
}

function logFailure(c: Context, message: string, error?: unknown) {
  cloudlog({ requestId: c.get('requestId'), message, error })
}

function getBindingOrgId(binding: RbacBinding) {
  return binding.org_id ?? null
}

function getBindingPrincipalId(binding: RbacBinding) {
  return binding.principal_id ?? null
}

function isBindingActive(binding: RbacBinding, now: Date) {
  const expiresAt = binding.expires_at
  return !expiresAt || new Date(expiresAt) > now
}

async function fetchDirectRbacBindings(
  c: Context,
  pg: PgClient,
  userId: string,
) {
  try {
    return await queryJson<RbacBinding>(
      pg,
      `SELECT rb.org_id, rb.expires_at
      FROM public.role_bindings rb
      JOIN public.roles r ON r.id = rb.role_id
      WHERE rb.principal_type = 'user' AND rb.principal_id = $1 AND rb.scope_type = 'org' AND r.name = ANY($2)`,
      [userId, SUPER_ADMIN_ROLES],
    )
  }
  catch (error) {
    logFailure(c, 'direct RBAC super admin lookup failed', error)
    return null
  }
}

async function fetchUserGroupIds(
  c: Context,
  pg: PgClient,
  userId: string,
) {
  try {
    const { rows } = await pg.query<{ group_id: string | null }>('SELECT group_id FROM public.group_members WHERE user_id = $1', [userId])
    return rows
      .map(group => group.group_id)
      .filter((groupId): groupId is string => Boolean(groupId))
  }
  catch (error) {
    logFailure(c, 'user group lookup failed', error)
    return null
  }
}

async function fetchGroupRbacBindings(
  c: Context,
  pg: PgClient,
  groupIds: string[],
) {
  if (groupIds.length === 0)
    return [] as RbacBinding[]

  try {
    return await queryJson<RbacBinding>(
      pg,
      `SELECT rb.org_id, rb.principal_id, rb.expires_at
      FROM public.role_bindings rb
      JOIN public.roles r ON r.id = rb.role_id
      WHERE rb.principal_type = 'group' AND rb.scope_type = 'org' AND rb.principal_id = ANY($1::uuid[]) AND r.name = ANY($2)`,
      [groupIds, SUPER_ADMIN_ROLES],
    )
  }
  catch (error) {
    logFailure(c, 'group RBAC super admin lookup failed', error)
    return null
  }
}

function collectCandidateOrgIds(
  directBindings: RbacBinding[],
  groupBindings: RbacBinding[],
  now: Date,
) {
  const candidateOrgIds = new Set<string>()

  for (const binding of directBindings) {
    if (!isBindingActive(binding, now))
      continue
    const orgId = getBindingOrgId(binding)
    if (orgId)
      candidateOrgIds.add(orgId)
  }

  for (const binding of groupBindings) {
    if (!isBindingActive(binding, now))
      continue
    const orgId = getBindingOrgId(binding)
    if (orgId)
      candidateOrgIds.add(orgId)
  }

  return Array.from(candidateOrgIds)
}

async function fetchRbacUserAdmins(
  c: Context,
  pg: PgClient,
  orgIds: string[],
) {
  try {
    return await queryJson<RbacBinding>(
      pg,
      `SELECT rb.org_id, rb.principal_id, rb.expires_at
      FROM public.role_bindings rb
      JOIN public.roles r ON r.id = rb.role_id
      WHERE rb.principal_type = 'user' AND rb.scope_type = 'org' AND rb.org_id = ANY($1::uuid[]) AND r.name = ANY($2)`,
      [orgIds, SUPER_ADMIN_ROLES],
    )
  }
  catch (error) {
    logFailure(c, 'RBAC user admin count failed', error)
    return null
  }
}

async function fetchRbacGroupAdmins(
  c: Context,
  pg: PgClient,
  orgIds: string[],
) {
  try {
    return await queryJson<RbacBinding>(
      pg,
      `SELECT rb.org_id, rb.principal_id, rb.expires_at
      FROM public.role_bindings rb
      JOIN public.roles r ON r.id = rb.role_id
      WHERE rb.principal_type = 'group' AND rb.scope_type = 'org' AND rb.org_id = ANY($1::uuid[]) AND r.name = ANY($2)`,
      [orgIds, SUPER_ADMIN_ROLES],
    )
  }
  catch (error) {
    logFailure(c, 'RBAC group admin count failed', error)
    return null
  }
}

async function fetchGroupMembers(
  c: Context,
  pg: PgClient,
  groupIds: string[],
) {
  if (groupIds.length === 0)
    return [] as GroupMember[]

  try {
    const { rows } = await pg.query<GroupMember>('SELECT group_id, user_id FROM public.group_members WHERE group_id = ANY($1::uuid[])', [groupIds])
    return rows
  }
  catch (error) {
    logFailure(c, 'RBAC group members count failed', error)
    return null
  }
}

function buildGroupMembersByGroup(groupMembers: GroupMember[]) {
  const groupMembersByGroup = new Map<string, string[]>()
  for (const member of groupMembers) {
    if (!member.group_id || !member.user_id)
      continue
    const existing = groupMembersByGroup.get(member.group_id) ?? []
    existing.push(member.user_id)
    groupMembersByGroup.set(member.group_id, existing)
  }
  return groupMembersByGroup
}

function buildOrgAdminUsers(
  rbacUserAdmins: RbacBinding[],
  activeGroupBindings: RbacBinding[],
  groupMembersByGroup: Map<string, string[]>,
  now: Date,
) {
  const orgAdminUsers = new Map<string, Set<string>>()
  const addOrgAdminUser = (orgId: string | null | undefined, userId: string | null | undefined) => {
    if (!orgId || !userId)
      return
    const existing = orgAdminUsers.get(orgId) ?? new Set<string>()
    existing.add(userId)
    orgAdminUsers.set(orgId, existing)
  }

  for (const binding of rbacUserAdmins) {
    if (!isBindingActive(binding, now))
      continue
    addOrgAdminUser(getBindingOrgId(binding), getBindingPrincipalId(binding))
  }

  for (const binding of activeGroupBindings) {
    const orgId = getBindingOrgId(binding)
    const groupId = getBindingPrincipalId(binding)
    if (!orgId || !groupId)
      continue
    const members = groupMembersByGroup.get(groupId) ?? []
    for (const userId of members) {
      addOrgAdminUser(orgId, userId)
    }
  }

  return orgAdminUsers
}

function getSingleSuperAdminOrgs(
  orgIds: string[],
  orgAdminUsers: Map<string, Set<string>>,
  userId: string,
) {
  return orgIds.filter((orgId) => {
    const admins = orgAdminUsers.get(orgId)
    return admins?.size === 1 && admins.has(userId)
  })
}

function buildCleanupPromises(
  c: Context,
  orgs: Array<{ customer_id: string | null, management_email: string | null }> | null,
) {
  const promises: Promise<unknown>[] = []
  if (orgs && orgs.length > 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'cleaning up orgs', count: orgs.length })

    for (const org of orgs) {
      if (org.customer_id) {
        promises.push(cancelSubscription(c, org.customer_id))
      }
      if (org.management_email) {
        promises.push(unsubscribeBento(c, org.management_email))
      }
    }
  }

  return promises
}

async function suppressDeletedUserInBento(
  c: Context,
  record: Database['public']['Tables']['users']['Row'],
  signal?: AbortSignal,
) {
  if (!record.email)
    return true

  const email = normalizeBentoEmail(record.email)
  try {
    await suppressAndUnsubscribeDeletedUserRecovery(c, email, signal)
    return true
  }
  catch (error) {
    logFailure(c, 'Bento user deletion cleanup failed', error)
    return false
  }
}

async function suppressDeletedUserInBentoWithinBudget(
  c: Context,
  record: Database['public']['Tables']['users']['Row'],
) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), BENTO_USER_DELETE_TIMEOUT_MS)
  try {
    const result = await suppressDeletedUserInBento(c, record, controller.signal)
    if (controller.signal.aborted) {
      logFailure(c, 'Bento user deletion cleanup timed out')
      return false
    }
    return result
  }
  finally {
    clearTimeout(timeoutId)
  }
}

function finishDeleteUserResponse(c: Context, bentoCleanupSucceeded: boolean, resourceCleanupSucceeded: boolean) {
  if (!bentoCleanupSucceeded || !resourceCleanupSucceeded)
    quickError(500, 'user_delete_cleanup_failed', 'User deletion cleanup failed')
  return c.json(BRES)
}

async function deleteUserImages(
  c: Context,
  userId: string,
) {
  try {
    const deleted = await removeImageFolder(c, userId)
    if (deleted > 0)
      cloudlog({ requestId: c.get('requestId'), message: 'deleted user images', count: deleted, user_id: userId })
    return true
  }
  catch (error) {
    logFailure(c, 'user image deletion failed', error)
    return false
  }
}

async function cleanupDeletedUserResources(c: Context, record: Database['public']['Tables']['users']['Row']) {
  let pg: PgClient
  try {
    pg = await getPgClient(c)
  }
  catch (error) {
    logFailure(c, 'user cleanup database connection failed', error)
    return false
  }
  try {
    return await cleanupDeletedUserResourcesWithClient(c, pg, record)
  }
  finally {
    closeClient(c, pg)
  }
}

async function cleanupDeletedUserResourcesWithClient(c: Context, pg: PgClient, record: Database['public']['Tables']['users']['Row']) {
  // Process user deletion with timeout protection
  const startTime = Date.now()
  const now = new Date()

  // 1. Find organizations where this user is the only RBAC super admin
  const directRbacBindings = await fetchDirectRbacBindings(c, pg, record.id)
  if (!directRbacBindings)
    return false

  const groupIds = await fetchUserGroupIds(c, pg, record.id)
  if (!groupIds)
    return false

  const groupRbacBindings = await fetchGroupRbacBindings(c, pg, groupIds)
  if (!groupRbacBindings)
    return false

  const orgIds = collectCandidateOrgIds(directRbacBindings, groupRbacBindings, now)
  if (orgIds.length === 0)
    return true

  // For each org where user is super admin, check if they are the only one
  const rbacUserAdmins = await fetchRbacUserAdmins(c, pg, orgIds)
  if (!rbacUserAdmins)
    return false

  const rbacGroupAdmins = await fetchRbacGroupAdmins(c, pg, orgIds)
  if (!rbacGroupAdmins)
    return false

  const activeGroupBindings = rbacGroupAdmins.filter(binding => isBindingActive(binding, now))
  const rbacGroupIds = activeGroupBindings
    .map(binding => getBindingPrincipalId(binding))
    .filter((groupId): groupId is string => Boolean(groupId))

  const groupMembers = await fetchGroupMembers(c, pg, rbacGroupIds)
  if (!groupMembers)
    return false

  const groupMembersByGroup = buildGroupMembersByGroup(groupMembers)
  const orgAdminUsers = buildOrgAdminUsers(
    rbacUserAdmins,
    activeGroupBindings,
    groupMembersByGroup,
    now,
  )

  const singleSuperAdminOrgs = getSingleSuperAdminOrgs(orgIds, orgAdminUsers, record.id)

  if (singleSuperAdminOrgs.length === 0)
    return true

  let orgs: Array<{ id: string, customer_id: string | null, management_email: string | null }>
  try {
    orgs = (await pg.query<{ id: string, customer_id: string | null, management_email: string | null }>(
      'SELECT id, customer_id, management_email FROM public.orgs WHERE id = ANY($1::uuid[])',
      [singleSuperAdminOrgs],
    )).rows
  }
  catch (orgLookupError) {
    logFailure(c, 'organization cleanup lookup failed', orgLookupError)
    return false
  }

  const promises = buildCleanupPromises(c, orgs)
  promises.push(deleteUserImages(c, record.id))

  let cleanupResults: unknown[]
  try {
    cleanupResults = await Promise.all(promises)
  }
  catch (error) {
    logFailure(c, 'user resource cleanup failed', error)
    return false
  }
  if (cleanupResults.includes(false)) {
    logFailure(c, 'user resource cleanup reported a failure')
    return false
  }

  // 4. Track performance metrics
  const endTime = Date.now()
  const duration = endTime - startTime

  cloudlog({
    requestId: c.get('requestId'),
    context: 'user deletion completed',
    duration_ms: duration,
    user_id: record.id,
  })
  return true
}

// on_user_delete - this is called 30 days before the user is actually deleted.
// Start provider cleanup and core subscription/image cleanup together so a
// slow Bento request cannot consume the queue handler's entire 15-second
// budget before Stripe cancellation begins.
async function deleteUser(c: Context, record: Database['public']['Tables']['users']['Row']) {
  const [bentoCleanupSucceeded, resourceCleanupSucceeded] = await Promise.all([
    suppressDeletedUserInBentoWithinBudget(c, record),
    cleanupDeletedUserResources(c, record),
  ])
  return finishDeleteUserResponse(c, bentoCleanupSucceeded, resourceCleanupSucceeded)
}

app.post('/', middlewareAPISecret, triggerValidator('users', 'DELETE'), async (c) => {
  const record = c.get('webhookBody') as Database['public']['Tables']['users']['Row']
  cloudlog({ requestId: c.get('requestId'), message: 'record', record })

  if (!record?.id) {
    cloudlog({ requestId: c.get('requestId'), message: 'no user id' })
    return c.json(BRES)
  }

  return deleteUser(c, record)
})

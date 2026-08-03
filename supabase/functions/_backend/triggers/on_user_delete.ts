import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { unsubscribeBento } from '../utils/bento.ts'
import { normalizeBentoEmail, suppressAndUnsubscribeDeletedUserRecovery } from '../utils/bento_first_org.ts'
import { BRES, middlewareAPISecret, quickError, triggerValidator } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { cancelSubscription } from '../utils/stripe.ts'
import { supabaseAdmin } from '../utils/supabase.ts'

export const app = new Hono<MiddlewareKeyVariables>()

const BENTO_USER_DELETE_TIMEOUT_MS = 5_000

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
  supabase: ReturnType<typeof supabaseAdmin>,
  userId: string,
) {
  const { data, error } = await supabase
    .from('role_bindings')
    .select('org_id, expires_at, roles!inner(name)')
    .eq('principal_type', 'user')
    .eq('principal_id', userId)
    .eq('scope_type', 'org')
    .in('roles.name', ['org_super_admin'])

  if (error) {
    logFailure(c, 'direct RBAC super admin lookup failed', error)
    return null
  }

  return (data ?? []) as RbacBinding[]
}

async function fetchUserGroupIds(
  c: Context,
  supabase: ReturnType<typeof supabaseAdmin>,
  userId: string,
) {
  const { data, error } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)

  if (error) {
    logFailure(c, 'user group lookup failed', error)
    return null
  }

  return (data ?? [])
    .map(group => group.group_id)
    .filter((groupId): groupId is string => Boolean(groupId))
}

async function fetchGroupRbacBindings(
  c: Context,
  supabase: ReturnType<typeof supabaseAdmin>,
  groupIds: string[],
) {
  if (groupIds.length === 0)
    return [] as RbacBinding[]

  const { data, error } = await supabase
    .from('role_bindings')
    .select('org_id, principal_id, expires_at, roles!inner(name)')
    .eq('principal_type', 'group')
    .eq('scope_type', 'org')
    .in('principal_id', groupIds)
    .in('roles.name', ['org_super_admin'])

  if (error) {
    logFailure(c, 'group RBAC super admin lookup failed', error)
    return null
  }

  return (data ?? []) as RbacBinding[]
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
  supabase: ReturnType<typeof supabaseAdmin>,
  orgIds: string[],
) {
  const { data, error } = await supabase
    .from('role_bindings')
    .select('org_id, principal_id, expires_at, roles!inner(name)')
    .eq('principal_type', 'user')
    .eq('scope_type', 'org')
    .in('org_id', orgIds)
    .in('roles.name', ['org_super_admin'])

  if (error) {
    logFailure(c, 'RBAC user admin count failed', error)
    return null
  }

  return (data ?? []) as RbacBinding[]
}

async function fetchRbacGroupAdmins(
  c: Context,
  supabase: ReturnType<typeof supabaseAdmin>,
  orgIds: string[],
) {
  const { data, error } = await supabase
    .from('role_bindings')
    .select('org_id, principal_id, expires_at, roles!inner(name)')
    .eq('principal_type', 'group')
    .eq('scope_type', 'org')
    .in('org_id', orgIds)
    .in('roles.name', ['org_super_admin'])

  if (error) {
    logFailure(c, 'RBAC group admin count failed', error)
    return null
  }

  return (data ?? []) as RbacBinding[]
}

async function fetchGroupMembers(
  c: Context,
  supabase: ReturnType<typeof supabaseAdmin>,
  groupIds: string[],
) {
  if (groupIds.length === 0)
    return [] as GroupMember[]

  const { data, error } = await supabase
    .from('group_members')
    .select('group_id, user_id')
    .in('group_id', groupIds)

  if (error) {
    logFailure(c, 'RBAC group members count failed', error)
    return null
  }

  return (data ?? []) as GroupMember[]
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
  supabase: ReturnType<typeof supabaseAdmin>,
  userId: string,
) {
  try {
    const { data: files, error: listError } = await supabase
      .storage
      .from('images')
      .list(userId)
    if (listError) {
      logFailure(c, 'user image listing failed', listError)
      return false
    }

    if (files && files.length > 0) {
      const filePaths = files.map(file => `${userId}/${file.name}`)
      const { error: removeError } = await supabase
        .storage
        .from('images')
        .remove(filePaths)
      if (removeError) {
        logFailure(c, 'user image deletion failed', removeError)
        return false
      }
      cloudlog({ requestId: c.get('requestId'), message: 'deleted user images', count: files.length, user_id: userId })
    }
    return true
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'error deleting user images', error, user_id: userId })
    return false
  }
}

async function cleanupDeletedUserResources(c: Context, record: Database['public']['Tables']['users']['Row']) {
  // Process user deletion with timeout protection
  const startTime = Date.now()
  const supabase = supabaseAdmin(c)
  const now = new Date()

  // 1. Find organizations where this user is the only RBAC super admin
  const directRbacBindings = await fetchDirectRbacBindings(c, supabase, record.id)
  if (!directRbacBindings)
    return false

  const groupIds = await fetchUserGroupIds(c, supabase, record.id)
  if (!groupIds)
    return false

  const groupRbacBindings = await fetchGroupRbacBindings(c, supabase, groupIds)
  if (!groupRbacBindings)
    return false

  const orgIds = collectCandidateOrgIds(directRbacBindings, groupRbacBindings, now)
  if (orgIds.length === 0)
    return true

  // For each org where user is super admin, check if they are the only one
  const rbacUserAdmins = await fetchRbacUserAdmins(c, supabase, orgIds)
  if (!rbacUserAdmins)
    return false

  const rbacGroupAdmins = await fetchRbacGroupAdmins(c, supabase, orgIds)
  if (!rbacGroupAdmins)
    return false

  const activeGroupBindings = rbacGroupAdmins.filter(binding => isBindingActive(binding, now))
  const rbacGroupIds = activeGroupBindings
    .map(binding => getBindingPrincipalId(binding))
    .filter((groupId): groupId is string => Boolean(groupId))

  const groupMembers = await fetchGroupMembers(c, supabase, rbacGroupIds)
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

  const { data: orgs, error: orgLookupError } = await supabaseAdmin(c)
    .from('orgs')
    .select('id, customer_id, management_email')
    .in('id', singleSuperAdminOrgs)
  if (orgLookupError) {
    logFailure(c, 'organization cleanup lookup failed', orgLookupError)
    return false
  }

  const promises = buildCleanupPromises(c, orgs ?? null)
  promises.push(deleteUserImages(c, supabase, record.id))

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

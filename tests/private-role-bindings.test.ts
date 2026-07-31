import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validatePrincipalAccess, validateRoleScope } from '../supabase/functions/_backend/private/role_bindings.ts'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, POSTGRES_URL, USER_ID, USER_ID_2, USER_PASSWORD } from './test-utils.ts'

let authHeaders: Record<string, string>
let user2AuthHeaders: Record<string, string>
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

interface RoleBindingFixture {
  attackerOrgId: string
  attackerAppUuid: string
  attackerChannelRbacId: string
  victimOrgId: string
  victimAppUuid: string
  victimPublicAppId: string
  cleanup: () => Promise<void>
}

async function createRoleBindingFixture(): Promise<RoleBindingFixture> {
  const id = randomUUID()
  const attackerOrgId = randomUUID()
  const attackerAppUuid = randomUUID()
  const attackerPublicAppId = `com.role-binding.attacker.${id}`
  const victimOrgId = randomUUID()
  const victimAppUuid = randomUUID()
  const victimPublicAppId = `com.role-binding.victim.${id}`
  const supabase = getSupabaseClient()

  const { error: attackerOrgError } = await supabase.from('orgs').insert({
    id: attackerOrgId,
    created_by: USER_ID,
    name: `Role Binding Attacker Org ${id}`,
    management_email: `role-binding-attacker-${id}@capgo.app`,
  })
  if (attackerOrgError)
    throw attackerOrgError

  const { error: victimOrgError } = await supabase.from('orgs').insert({
    id: victimOrgId,
    created_by: USER_ID_2,
    name: `Role Binding Victim Org ${id}`,
    management_email: `role-binding-victim-${id}@capgo.app`,
  })
  if (victimOrgError)
    throw victimOrgError

  const { error: attackerAppError } = await supabase.from('apps').insert({
    id: attackerAppUuid,
    app_id: attackerPublicAppId,
    owner_org: attackerOrgId,
    icon_url: 'role-binding-test-icon',
    name: `Attacker App ${id}`,
  })
  if (attackerAppError)
    throw attackerAppError

  const { error: victimAppError } = await supabase.from('apps').insert({
    id: victimAppUuid,
    app_id: victimPublicAppId,
    owner_org: victimOrgId,
    icon_url: 'role-binding-test-icon',
    name: `Victim App ${id}`,
  })
  if (victimAppError)
    throw victimAppError

  const { data: attackerVersion, error: attackerVersionError } = await supabase
    .from('app_versions')
    .insert({
      app_id: attackerPublicAppId,
      name: `role-binding-version-${id.slice(0, 8)}`,
      owner_org: attackerOrgId,
      user_id: USER_ID,
      checksum: `checksum-${id}`,
      storage_provider: 'r2',
      r2_path: `orgs/${attackerOrgId}/apps/${attackerPublicAppId}/${id}.zip`,
      deleted: false,
    })
    .select('id')
    .single()
  if (attackerVersionError)
    throw attackerVersionError

  const { data: attackerChannel, error: attackerChannelError } = await supabase
    .from('channels')
    .insert({
      app_id: attackerPublicAppId,
      name: `role-binding-channel-${id.slice(0, 8)}`,
      version: attackerVersion.id,
      owner_org: attackerOrgId,
      created_by: USER_ID,
      public: false,
      allow_emulator: false,
    })
    .select('id, rbac_id')
    .single()
  if (attackerChannelError)
    throw attackerChannelError

  return {
    attackerOrgId,
    attackerAppUuid,
    attackerChannelRbacId: attackerChannel.rbac_id,
    victimOrgId,
    victimAppUuid,
    victimPublicAppId,
    cleanup: async () => {
      await supabase.from('role_bindings').delete().in('org_id', [attackerOrgId, victimOrgId])
      await supabase.from('org_users').delete().in('org_id', [attackerOrgId, victimOrgId])
      await supabase.from('channels').delete().eq('owner_org', attackerOrgId)
      await supabase.from('app_versions').delete().eq('owner_org', attackerOrgId)
      await supabase.from('apps').delete().in('id', [attackerAppUuid, victimAppUuid])
      await supabase.from('orgs').delete().in('id', [attackerOrgId, victimOrgId])
    },
  }
}

async function createUserOrgBinding(orgId: string, userId: string, roleName: string, grantedBy: string) {
  const supabase = getSupabaseClient()
  const { data: role, error: roleError } = await supabase
    .from('roles')
    .select('id')
    .eq('name', roleName)
    .eq('scope_type', 'org')
    .single()
  if (roleError)
    throw roleError

  const { error: bindingError } = await supabase.from('role_bindings').insert({
    principal_type: 'user',
    principal_id: userId,
    role_id: role!.id,
    scope_type: 'org',
    org_id: orgId,
    granted_by: grantedBy,
    reason: 'Test RBAC binding',
    is_direct: true,
  })
  if (bindingError && bindingError.code !== '23505')
    throw bindingError
}

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    return

  authHeaders = await getAuthHeaders()
  user2AuthHeaders = await getAuthHeadersForCredentials('test2@capgo.app', USER_PASSWORD)
})

// /private/role_bindings is currently served by the Supabase private functions stack, not the Cloudflare API worker.
describe.skipIf(USE_CLOUDFLARE)('/private/role_bindings', () => {
  it('accepts channel-scoped bindings when channel_id is the channel RBAC uuid', async () => {
    const fixture = await createRoleBindingFixture()

    try {
      const createResponse = await fetch(getEndpointUrl('/private/role_bindings'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          principal_type: 'user',
          principal_id: USER_ID,
          role_name: 'channel_admin',
          scope_type: 'channel',
          org_id: fixture.attackerOrgId,
          app_id: fixture.attackerAppUuid,
          channel_id: fixture.attackerChannelRbacId,
          reason: 'channel uuid regression',
        }),
      })

      const createData = await createResponse.json() as { id: string, app_id: string, channel_id: string, scope_type: string }
      expect(createResponse.status).toBe(200)
      expect(createData.scope_type).toBe('channel')
      expect(createData.app_id).toBe(fixture.attackerAppUuid)
      expect(createData.channel_id).toBe(fixture.attackerChannelRbacId)

      const { data: binding, error: bindingError } = await getSupabaseClient()
        .from('role_bindings')
        .select('channel_id')
        .eq('id', createData.id)
        .single()

      expect(bindingError).toBeNull()
      expect(binding?.channel_id).toBe(fixture.attackerChannelRbacId)
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('allows app role managers to create, update, and delete channel-scoped bindings', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const appUuid = randomUUID()
    const publicAppId = `com.role-binding.app-manager.${id}`
    const supabase = getSupabaseClient()

    try {
      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID_2,
        name: `Role Binding App Manager Org ${id}`,
        management_email: `role-binding-app-manager-${id}@capgo.app`,
      })
      expect(orgError).toBeNull()

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: orgId,
        user_id: USER_ID,
        rbac_role_name: 'org_member',
      })
      expect(memberError).toBeNull()

      const { error: appError } = await supabase.from('apps').insert({
        id: appUuid,
        app_id: publicAppId,
        owner_org: orgId,
        icon_url: 'role-binding-test-icon',
        name: `App Manager App ${id}`,
      })
      expect(appError).toBeNull()

      const { data: version, error: versionError } = await supabase
        .from('app_versions')
        .insert({
          app_id: publicAppId,
          name: `role-binding-version-${id.slice(0, 8)}`,
          owner_org: orgId,
          user_id: USER_ID_2,
          checksum: `checksum-${id}`,
          storage_provider: 'r2',
          r2_path: `orgs/${orgId}/apps/${publicAppId}/${id}.zip`,
          deleted: false,
        })
        .select('id')
        .single()
      expect(versionError).toBeNull()

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .insert({
          app_id: publicAppId,
          name: `role-binding-channel-${id.slice(0, 8)}`,
          version: version!.id,
          owner_org: orgId,
          created_by: USER_ID_2,
          public: false,
          allow_emulator: false,
        })
        .select('id, rbac_id')
        .single()
      expect(channelError).toBeNull()

      const { data: appAdminRole, error: appAdminRoleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', 'app_admin')
        .single()
      expect(appAdminRoleError).toBeNull()

      const { error: appAdminBindingError } = await supabase.from('role_bindings').insert({
        principal_type: 'user',
        principal_id: USER_ID,
        role_id: appAdminRole!.id,
        scope_type: 'app',
        org_id: orgId,
        app_id: appUuid,
        channel_id: null,
        granted_by: USER_ID_2,
        reason: 'app-manager-channel-binding-test',
        is_direct: true,
      })
      expect(appAdminBindingError).toBeNull()

      const createResponse = await fetch(getEndpointUrl('/private/role_bindings'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          principal_type: 'user',
          principal_id: USER_ID_2,
          role_name: 'channel_reader',
          scope_type: 'channel',
          org_id: orgId,
          app_id: appUuid,
          channel_id: channel!.id,
          reason: 'app manager assigns lower-level channel role',
        }),
      })

      const createData = await createResponse.json() as { id: string, channel_id: string, role_id: string, error?: string }
      expect(createResponse.status).toBe(200)
      expect(createData.channel_id).toBe(channel!.rbac_id)

      const patchResponse = await fetch(getEndpointUrl(`/private/role_bindings/${createData.id}`), {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ role_name: 'channel_admin' }),
      })
      const patchData = await patchResponse.json() as { id: string, error?: string }
      expect(patchResponse.status).toBe(200)
      expect(patchData.id).toBe(createData.id)

      const deleteResponse = await fetch(getEndpointUrl(`/private/role_bindings/${createData.id}`), {
        method: 'DELETE',
        headers: authHeaders,
      })
      const deleteData = await deleteResponse.json() as { success?: boolean, error?: string }
      expect(deleteResponse.status).toBe(200)
      expect(deleteData.success).toBe(true)
    }
    finally {
      await supabase.from('role_bindings').delete().eq('org_id', orgId)
      await supabase.from('org_users').delete().eq('org_id', orgId)
      await supabase.from('channels').delete().eq('owner_org', orgId)
      await supabase.from('app_versions').delete().eq('owner_org', orgId)
      await supabase.from('apps').delete().eq('id', appUuid)
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })

  it.concurrent('allows app readers to fetch direct channel bindings for an app', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const appUuid = randomUUID()
    const publicAppId = `com.role-binding.app-reader.${id}`
    const supabase = getSupabaseClient()

    try {
      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID_2,
        name: `Role Binding App Reader Org ${id}`,
        management_email: `role-binding-app-reader-${id}@capgo.app`,
      })
      expect(orgError).toBeNull()

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: orgId,
        user_id: USER_ID,
        rbac_role_name: 'org_member',
      })
      expect(memberError).toBeNull()

      const { error: appError } = await supabase.from('apps').insert({
        id: appUuid,
        app_id: publicAppId,
        owner_org: orgId,
        icon_url: 'role-binding-test-icon',
        name: `App Reader App ${id}`,
      })
      expect(appError).toBeNull()

      const { data: version, error: versionError } = await supabase
        .from('app_versions')
        .insert({
          app_id: publicAppId,
          name: `role-binding-version-${id.slice(0, 8)}`,
          owner_org: orgId,
          user_id: USER_ID_2,
          checksum: `checksum-${id}`,
          storage_provider: 'r2',
          r2_path: `orgs/${orgId}/apps/${publicAppId}/${id}.zip`,
          deleted: false,
        })
        .select('id')
        .single()
      expect(versionError).toBeNull()

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .insert({
          app_id: publicAppId,
          name: `role-binding-channel-${id.slice(0, 8)}`,
          version: version!.id,
          owner_org: orgId,
          created_by: USER_ID_2,
          public: false,
          allow_emulator: false,
        })
        .select('id, rbac_id')
        .single()
      expect(channelError).toBeNull()

      const { data: roles, error: rolesError } = await supabase
        .from('roles')
        .select('id, name')
        .in('name', ['app_reader', 'channel_reader'])
      expect(rolesError).toBeNull()

      const roleIds = new Map((roles ?? []).map(role => [role.name, role.id]))
      const appReaderRoleId = roleIds.get('app_reader')
      const channelReaderRoleId = roleIds.get('channel_reader')
      expect(appReaderRoleId).toBeTruthy()
      expect(channelReaderRoleId).toBeTruthy()

      const { error: bindingError } = await supabase.from('role_bindings').insert([
        {
          principal_type: 'user',
          principal_id: USER_ID,
          role_id: appReaderRoleId!,
          scope_type: 'app',
          org_id: orgId,
          app_id: appUuid,
          channel_id: null,
          granted_by: USER_ID_2,
          reason: 'app-reader-fetches-channel-bindings-test',
          is_direct: true,
        },
        {
          principal_type: 'user',
          principal_id: USER_ID,
          role_id: channelReaderRoleId!,
          scope_type: 'channel',
          org_id: orgId,
          app_id: appUuid,
          channel_id: channel!.rbac_id,
          granted_by: USER_ID_2,
          reason: 'app-reader-fetches-channel-bindings-test',
          is_direct: true,
        },
      ])
      expect(bindingError).toBeNull()

      const response = await fetch(getEndpointUrl(`/private/role_bindings/app/${appUuid}/channel`), {
        method: 'GET',
        headers: authHeaders,
      })
      const data = await response.json() as Array<{ app_id: string, channel_id: string, role_name: string, scope_type: string }>

      expect(response.status).toBe(200)
      expect(data.every(binding => binding.scope_type === 'channel' && binding.app_id === appUuid)).toBe(true)
      expect(data).toContainEqual(expect.objectContaining({
        channel_id: channel!.rbac_id,
        role_name: 'channel_reader',
      }))
    }
    finally {
      await supabase.from('role_bindings').delete().eq('org_id', orgId)
      await supabase.from('org_users').delete().eq('org_id', orgId)
      await supabase.from('channels').delete().eq('owner_org', orgId)
      await supabase.from('app_versions').delete().eq('owner_org', orgId)
      await supabase.from('apps').delete().eq('id', appUuid)
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })

  it.concurrent('allows app role managers to fetch assignable principals for an app', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const appUuid = randomUUID()
    const groupId = randomUUID()
    const membershipOnlyUserId = randomUUID()
    const publicAppId = `com.role-binding.app-principals.${id}`
    const supabase = getSupabaseClient()

    try {
      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID_2,
        name: `Role Binding App Principals Org ${id}`,
        management_email: `role-binding-app-principals-${id}@capgo.app`,
      })
      expect(orgError).toBeNull()

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: orgId,
        user_id: USER_ID_2,
        rbac_role_name: 'org_member',
      })
      expect(memberError).toBeNull()

      const membershipOnlyEmail = `membership-only-role-binding-${id}@capgo.app`
      const { error: membershipOnlyAuthError } = await supabase.auth.admin.createUser({
        id: membershipOnlyUserId,
        email: membershipOnlyEmail,
        email_confirm: true,
      })
      expect(membershipOnlyAuthError).toBeNull()

      const { error: membershipOnlyUserError } = await supabase.from('users').insert({
        id: membershipOnlyUserId,
        email: membershipOnlyEmail,
      })
      expect(membershipOnlyUserError).toBeNull()

      const { error: membershipOnlyMemberError } = await supabase.from('org_users').insert({
        org_id: orgId,
        user_id: membershipOnlyUserId,
        rbac_role_name: 'org_member',
      })
      expect(membershipOnlyMemberError).toBeNull()

      const { error: membershipOnlyBindingDeleteError } = await supabase
        .from('role_bindings')
        .delete()
        .eq('principal_type', 'user')
        .eq('principal_id', membershipOnlyUserId)
        .eq('org_id', orgId)
      expect(membershipOnlyBindingDeleteError).toBeNull()

      const { error: appError } = await supabase.from('apps').insert({
        id: appUuid,
        app_id: publicAppId,
        owner_org: orgId,
        icon_url: 'role-binding-test-icon',
        name: `App Principals App ${id}`,
      })
      expect(appError).toBeNull()

      const { error: groupError } = await supabase.from('groups').insert({
        id: groupId,
        org_id: orgId,
        name: `Role Binding Principal Group ${id}`,
        description: 'Assignable app principal',
        created_by: USER_ID_2,
      })
      expect(groupError).toBeNull()

      const { data: roles, error: rolesError } = await supabase
        .from('roles')
        .select('id, name')
        .in('name', ['app_admin', 'app_reader'])
      expect(rolesError).toBeNull()

      const roleIds = new Map((roles ?? []).map(role => [role.name, role.id]))
      const appAdminRoleId = roleIds.get('app_admin')
      const appReaderRoleId = roleIds.get('app_reader')
      expect(appAdminRoleId).toBeTruthy()
      expect(appReaderRoleId).toBeTruthy()

      const { error: appAdminBindingError } = await supabase.from('role_bindings').insert({
        principal_type: 'user',
        principal_id: USER_ID,
        role_id: appAdminRoleId!,
        scope_type: 'app',
        org_id: orgId,
        app_id: appUuid,
        channel_id: null,
        granted_by: USER_ID_2,
        reason: 'app-principals-manager-test',
        is_direct: true,
      })
      expect(appAdminBindingError).toBeNull()

      const managerResponse = await fetch(getEndpointUrl(`/private/role_bindings/app/${appUuid}/principals`), {
        method: 'GET',
        headers: authHeaders,
      })
      const managerData = await managerResponse.json() as Array<{ type: string, id: string, label: string, detail: string | null }>

      expect(managerResponse.status).toBe(200)
      expect(managerData).toContainEqual(expect.objectContaining({
        type: 'user',
        id: USER_ID_2,
        label: 'test2@capgo.app',
      }))
      expect(managerData).not.toContainEqual(expect.objectContaining({
        type: 'user',
        id: membershipOnlyUserId,
      }))
      expect(managerData).toContainEqual(expect.objectContaining({
        type: 'group',
        id: groupId,
        label: `Role Binding Principal Group ${id}`,
      }))

      const { error: appReaderBindingError } = await supabase
        .from('role_bindings')
        .update({ role_id: appReaderRoleId })
        .eq('principal_type', 'user')
        .eq('principal_id', USER_ID)
        .eq('scope_type', 'app')
        .eq('app_id', appUuid)
      expect(appReaderBindingError).toBeNull()

      const readerResponse = await fetch(getEndpointUrl(`/private/role_bindings/app/${appUuid}/principals`), {
        method: 'GET',
        headers: authHeaders,
      })
      const readerData = await readerResponse.json() as { error?: string }

      expect(readerResponse.status).toBe(403)
      expect(readerData.error).toBe('Forbidden')
    }
    finally {
      await supabase.from('role_bindings').delete().eq('org_id', orgId)
      await supabase.from('groups').delete().eq('id', groupId)
      await supabase.from('org_users').delete().eq('org_id', orgId)
      await supabase.from('users').delete().eq('id', membershipOnlyUserId)
      await supabase.auth.admin.deleteUser(membershipOnlyUserId)
      await supabase.from('apps').delete().eq('id', appUuid)
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })

  it('rejects app-scoped bindings when the target app belongs to another org', async () => {
    const fixture = await createRoleBindingFixture()

    try {
      const createResponse = await fetch(getEndpointUrl('/private/role_bindings'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          principal_type: 'user',
          principal_id: USER_ID,
          role_name: 'app_admin',
          scope_type: 'app',
          org_id: fixture.attackerOrgId,
          app_id: fixture.victimAppUuid,
          reason: 'cross-org regression',
        }),
      })

      const createData = await createResponse.json() as { error: string }
      expect(createResponse.status).toBe(404)
      expect(['App not found in this org', 'not_found']).toContain(createData.error)

      const { data: bindings, error: bindingsError } = await getSupabaseClient()
        .from('role_bindings')
        .select('id')
        .eq('org_id', fixture.attackerOrgId)
        .eq('app_id', fixture.victimAppUuid)
        .eq('principal_type', 'user')
        .eq('principal_id', USER_ID)

      expect(bindingsError).toBeNull()
      expect(bindings ?? []).toHaveLength(0)
    }
    finally {
      await fixture.cleanup()
    }
  })

  it('clears org_users RBAC role when an org-scope user binding is deleted', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const supabase = getSupabaseClient()

    try {
      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID,
        name: `Role Binding Delete Org ${id}`,
        management_email: `role-binding-delete-${id}@capgo.app`,
      })
      expect(orgError).toBeNull()

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: orgId,
        user_id: USER_ID_2,
        rbac_role_name: 'org_super_admin',
      })
      expect(memberError).toBeNull()
      await createUserOrgBinding(orgId, USER_ID_2, 'org_super_admin', USER_ID)

      const { data: binding, error: bindingError } = await supabase
        .from('role_bindings')
        .select('id')
        .eq('principal_type', 'user')
        .eq('principal_id', USER_ID_2)
        .eq('scope_type', 'org')
        .eq('org_id', orgId)
        .single()

      expect(bindingError).toBeNull()
      expect(binding?.id).toBeTruthy()

      const deleteResponse = await fetch(getEndpointUrl(`/private/role_bindings/${binding!.id}`), {
        method: 'DELETE',
        headers: authHeaders,
      })

      const deleteData = await deleteResponse.json() as { success?: boolean, error?: string }
      expect(deleteResponse.status).toBe(200)
      expect(deleteData.success).toBe(true)

      const { data: orgUserRows, error: orgUserError } = await supabase
        .from('org_users')
        .select('rbac_role_name, is_invite')
        .eq('org_id', orgId)
        .eq('user_id', USER_ID_2)
        .is('app_id', null)
        .is('channel_id', null)

      expect(orgUserError).toBeNull()
      expect(orgUserRows).toHaveLength(1)
      expect(orgUserRows?.[0]?.rbac_role_name).toBeNull()
      expect(orgUserRows?.[0]?.is_invite).toBe(false)
    }
    finally {
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })

  it.concurrent('removes user channel permission overrides when app access is removed', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const appUuid = randomUUID()
    const publicAppId = `com.role-binding.override-cleanup.${id}`
    const supabase = getSupabaseClient()

    try {
      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID_2,
        name: `Role Binding Override Cleanup Org ${id}`,
        management_email: `role-binding-override-cleanup-${id}@capgo.app`,
      })
      expect(orgError).toBeNull()

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: orgId,
        user_id: USER_ID_2,
        rbac_role_name: 'org_member',
      })
      expect(memberError).toBeNull()

      const { error: appError } = await supabase.from('apps').insert({
        id: appUuid,
        app_id: publicAppId,
        owner_org: orgId,
        icon_url: 'role-binding-test-icon',
        name: `Override Cleanup App ${id}`,
      })
      expect(appError).toBeNull()

      const { data: version, error: versionError } = await supabase
        .from('app_versions')
        .insert({
          app_id: publicAppId,
          name: `role-binding-version-${id.slice(0, 8)}`,
          owner_org: orgId,
          user_id: USER_ID_2,
          checksum: `checksum-${id}`,
          storage_provider: 'r2',
          r2_path: `orgs/${orgId}/apps/${publicAppId}/${id}.zip`,
          deleted: false,
        })
        .select('id')
        .single()
      expect(versionError).toBeNull()

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .insert({
          app_id: publicAppId,
          name: `role-binding-channel-${id.slice(0, 8)}`,
          version: version!.id,
          owner_org: orgId,
          created_by: USER_ID_2,
          public: false,
          allow_emulator: false,
        })
        .select('id')
        .single()
      expect(channelError).toBeNull()

      const { data: roles, error: rolesError } = await supabase
        .from('roles')
        .select('id, name')
        .in('name', ['app_admin', 'app_reader'])
      expect(rolesError).toBeNull()

      const roleIds = new Map((roles ?? []).map(role => [role.name, role.id]))
      const appAdminRoleId = roleIds.get('app_admin')
      const appReaderRoleId = roleIds.get('app_reader')
      expect(appAdminRoleId).toBeTruthy()
      expect(appReaderRoleId).toBeTruthy()

      const { error: managerBindingError } = await supabase.from('role_bindings').insert({
        principal_type: 'user',
        principal_id: USER_ID,
        role_id: appAdminRoleId!,
        scope_type: 'app',
        org_id: orgId,
        app_id: appUuid,
        channel_id: null,
        granted_by: USER_ID_2,
        reason: 'override-cleanup-manager-test',
        is_direct: true,
      })
      expect(managerBindingError).toBeNull()

      const { data: targetBinding, error: targetBindingError } = await supabase
        .from('role_bindings')
        .insert({
          principal_type: 'user',
          principal_id: USER_ID_2,
          role_id: appReaderRoleId!,
          scope_type: 'app',
          org_id: orgId,
          app_id: appUuid,
          channel_id: null,
          granted_by: USER_ID,
          reason: 'override-cleanup-target-test',
          is_direct: true,
        })
        .select('id')
        .single()
      expect(targetBindingError).toBeNull()

      const { error: overrideError } = await supabase.from('channel_permission_overrides').insert({
        principal_type: 'user',
        principal_id: USER_ID_2,
        channel_id: channel!.id,
        permission_key: 'channel.promote_bundle',
        is_allowed: true,
      })
      expect(overrideError).toBeNull()

      const deleteResponse = await fetch(getEndpointUrl(`/private/role_bindings/${targetBinding!.id}`), {
        method: 'DELETE',
        headers: authHeaders,
      })
      const deleteData = await deleteResponse.json() as { success?: boolean, error?: string }

      expect(deleteResponse.status).toBe(200)
      expect(deleteData.success).toBe(true)

      const { data: overrides, error: overridesError } = await supabase
        .from('channel_permission_overrides')
        .select('id')
        .eq('principal_type', 'user')
        .eq('principal_id', USER_ID_2)
        .eq('channel_id', channel!.id)

      expect(overridesError).toBeNull()
      expect(overrides ?? []).toHaveLength(0)
    }
    finally {
      await supabase.from('channel_permission_overrides').delete().eq('principal_id', USER_ID_2)
      await supabase.from('role_bindings').delete().eq('org_id', orgId)
      await supabase.from('org_users').delete().eq('org_id', orgId)
      await supabase.from('channels').delete().eq('owner_org', orgId)
      await supabase.from('app_versions').delete().eq('owner_org', orgId)
      await supabase.from('apps').delete().eq('id', appUuid)
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })
})

describe.skipIf(USE_CLOUDFLARE)('[PATCH] /private/role_bindings/:binding_id', () => {
  it('rejects org_admin demotion of an existing org_super_admin binding', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const supabase = getSupabaseClient()

    try {
      const { data: roles, error: rolesError } = await supabase
        .from('roles')
        .select('id, name')
        .eq('name', 'org_super_admin')
      if (rolesError)
        throw rolesError

      const superAdminRoleId = roles?.[0]?.id
      if (!superAdminRoleId)
        throw new Error('Expected RBAC org_super_admin role to exist')

      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID_2,
        name: `Role Binding Rank Org ${id}`,
        management_email: `role-binding-rank-${id}@capgo.app`,
      })
      if (orgError)
        throw orgError

      const { error: membersError } = await supabase.from('org_users').insert([
        { org_id: orgId, user_id: USER_ID, rbac_role_name: 'org_admin' },
      ])
      if (membersError)
        throw membersError
      await createUserOrgBinding(orgId, USER_ID, 'org_admin', USER_ID_2)

      const { data: targetBinding, error: bindingError } = await supabase
        .from('role_bindings')
        .select('id, role_id')
        .eq('org_id', orgId)
        .eq('principal_type', 'user')
        .eq('principal_id', USER_ID_2)
        .eq('scope_type', 'org')
        .single()
      if (bindingError)
        throw bindingError

      expect(targetBinding.role_id).toBe(superAdminRoleId)

      const response = await fetch(getEndpointUrl(`/private/role_bindings/${targetBinding.id}`), {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ role_name: 'org_member' }),
      })
      const data = await response.json() as { error: string }

      expect(response.status).toBe(403)
      expect(data.error).toBe('Cannot modify a binding for a role with higher privileges than your own')

      const { data: unchangedBinding, error: unchangedError } = await supabase
        .from('role_bindings')
        .select('role_id')
        .eq('id', targetBinding.id)
        .single()

      expect(unchangedError).toBeNull()
      expect(unchangedBinding?.role_id).toBe(superAdminRoleId)
    }
    finally {
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })

  it('returns a conflict when the last org_super_admin binding cannot be demoted', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const supabase = getSupabaseClient()

    try {
      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        created_by: USER_ID_2,
        name: `Last Super Admin API Org ${id}`,
        management_email: `last-super-admin-api-${id}@capgo.app`,
      })
      if (orgError)
        throw orgError

      const { data: targetBinding, error: bindingError } = await supabase
        .from('role_bindings')
        .select('id')
        .eq('org_id', orgId)
        .eq('principal_type', 'user')
        .eq('principal_id', USER_ID_2)
        .eq('scope_type', 'org')
        .single()
      if (bindingError)
        throw bindingError

      const response = await fetch(getEndpointUrl(`/private/role_bindings/${targetBinding.id}`), {
        method: 'PATCH',
        headers: user2AuthHeaders,
        body: JSON.stringify({ role_name: 'org_member' }),
      })
      const data = await response.json() as { error: string }

      expect(response.status).toBe(409)
      expect(data.error).toBe('Cannot demote the last org_super_admin')
    }
    finally {
      await supabase.from('orgs').delete().eq('id', orgId)
    }
  })
})

describe('private role bindings helpers', () => {
  let pool: Pool
  let client: PoolClient

  const query = (text: string, params?: Array<string | boolean | number | null>) => {
    return client.query(text, params)
  }

  async function createFixture(targetRoleName: 'org_admin' | 'org_member', isInvite = false) {
    const id = randomUUID()
    const orgId = randomUUID()
    const managementEmail = `role-binding-${id}@capgo.app`

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Role Binding Test Org ${id}`, managementEmail, USER_ID])

    await query(`
      INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
      VALUES ($1::uuid, $2::uuid, $3, $4)
    `, [orgId, USER_ID_2, targetRoleName, isInvite])

    if (!isInvite) {
      await query(`
        INSERT INTO public.role_bindings (
          principal_type,
          principal_id,
          role_id,
          scope_type,
          org_id,
          granted_by,
          granted_at,
          reason,
          is_direct
        )
        SELECT
          public.rbac_principal_user(),
          $1::uuid,
          r.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          now(),
          'fixture RBAC membership',
          true
        FROM public.roles r
        WHERE r.name = $4
          AND r.scope_type = public.rbac_scope_org()
        ON CONFLICT DO NOTHING
      `, [USER_ID_2, orgId, USER_ID, targetRoleName])
    }

    return { orgId }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL })
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    if (!client)
      return
    try {
      await client.query('ROLLBACK')
    }
    finally {
      client.release()
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('blocks direct role_bindings escalation above the caller org rank', async () => {
    const id = randomUUID()
    const orgId = randomUUID()

    const roleResult = await query(`
      SELECT id, name
      FROM public.roles
      WHERE name IN ('org_super_admin', 'org_admin', 'org_member')
        AND scope_type = public.rbac_scope_org()
    `)
    const roleIds = new Map(roleResult.rows.map(row => [row.name, row.id]))
    const superAdminRoleId = roleIds.get('org_super_admin')
    const adminRoleId = roleIds.get('org_admin')
    const memberRoleId = roleIds.get('org_member')
    expect(superAdminRoleId).toBeTruthy()
    expect(adminRoleId).toBeTruthy()
    expect(memberRoleId).toBeTruthy()

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Role Binding Direct Escalation Org ${id}`, `role-binding-direct-escalation-${id}@capgo.app`, USER_ID])

    await query(`
      INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
      VALUES ($1::uuid, $2::uuid, 'org_admin', false)
    `, [orgId, USER_ID_2])

    await query(`
      INSERT INTO public.role_bindings (
        principal_type,
        principal_id,
        role_id,
        scope_type,
        org_id,
        granted_by,
        reason,
        is_direct
      )
      VALUES (
        public.rbac_principal_user(),
        $1::uuid,
        $2::uuid,
        public.rbac_scope_org(),
        $3::uuid,
        $4::uuid,
        'direct escalation regression setup',
        true
      )
      ON CONFLICT (principal_type, principal_id, org_id, scope_type)
      WHERE scope_type = public.rbac_scope_org()
      DO UPDATE SET role_id = EXCLUDED.role_id
    `, [USER_ID_2, adminRoleId, orgId, USER_ID])

    await query('SET LOCAL ROLE authenticated')
    await query(`
      SELECT
        set_config('request.jwt.claim.sub', $1, true),
        set_config('request.jwt.claim.role', 'authenticated', true)
    `, [USER_ID_2])

    await query('SAVEPOINT blocked_role_escalation')
    await expect(query(`
      UPDATE public.role_bindings
      SET role_id = $1::uuid
      WHERE principal_type = public.rbac_principal_user()
        AND principal_id = $2::uuid
        AND scope_type = public.rbac_scope_org()
        AND org_id = $3::uuid
    `, [superAdminRoleId, USER_ID_2, orgId])).rejects.toThrow(/Admins cannot elevate privileges/)
    await query('ROLLBACK TO SAVEPOINT blocked_role_escalation')

    const allowedUpdate = await query(`
      UPDATE public.role_bindings
      SET role_id = $1::uuid
      WHERE principal_type = public.rbac_principal_user()
        AND principal_id = $2::uuid
        AND scope_type = public.rbac_scope_org()
        AND org_id = $3::uuid
      RETURNING role_id
    `, [memberRoleId, USER_ID_2, orgId])

    expect(allowedUpdate.rowCount).toBe(1)
    expect(allowedUpdate.rows[0]?.role_id).toBe(memberRoleId)
  })

  it('accepts active org members as assignment targets', async () => {
    const fixture = await createFixture('org_admin')
    const drizzle = getDrizzleClient(client as any)

    const result = await validatePrincipalAccess(drizzle, 'user', USER_ID_2, fixture.orgId)

    expect(result).toEqual({ ok: true, data: null })
  })

  it('rejects pending invitees as assignment targets', async () => {
    const fixture = await createFixture('org_member', true)
    const drizzle = getDrizzleClient(client as any)

    const result = await validatePrincipalAccess(drizzle, 'user', USER_ID_2, fixture.orgId)

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'User has not accepted the org invitation yet',
    })
  })

  it('accepts active scope-valid RBAC bindings as membership proof', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const drizzle = getDrizzleClient(client as any)

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Role Binding Membership Org ${id}`, `role-binding-membership-${id}@capgo.app`, USER_ID])

    await query(`
      INSERT INTO public.role_bindings (
        principal_type,
        principal_id,
        role_id,
        scope_type,
        org_id,
        granted_by,
        granted_at,
        reason,
        is_direct
      )
      SELECT
        public.rbac_principal_user(),
        $1::uuid,
        r.id,
        public.rbac_scope_org(),
        $2::uuid,
        $3::uuid,
        now(),
        'membership-proof-test',
        true
      FROM public.roles r
      WHERE r.name = public.rbac_role_org_member()
    `, [USER_ID_2, orgId, USER_ID])

    const result = await validatePrincipalAccess(drizzle, 'user', USER_ID_2, orgId)

    expect(result).toEqual({ ok: true, data: null })
  })

  it('ignores expired RBAC bindings as membership proof', async () => {
    const id = randomUUID()
    const orgId = randomUUID()
    const drizzle = getDrizzleClient(client as any)

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Expired Role Binding Org ${id}`, `expired-role-binding-${id}@capgo.app`, USER_ID])

    await query(`
      INSERT INTO public.role_bindings (
        principal_type,
        principal_id,
        role_id,
        scope_type,
        org_id,
        granted_by,
        granted_at,
        expires_at,
        reason,
        is_direct
      )
      SELECT
        public.rbac_principal_user(),
        $1::uuid,
        r.id,
        public.rbac_scope_org(),
        $2::uuid,
        $3::uuid,
        now(),
        now() - interval '1 hour',
        'expired-membership-proof-test',
        true
      FROM public.roles r
      WHERE r.name = public.rbac_role_org_member()
    `, [USER_ID_2, orgId, USER_ID])

    const result = await validatePrincipalAccess(drizzle, 'user', USER_ID_2, orgId)

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'User is not a member of this org',
    })
  })

  it('requires the role family to match the requested binding scope', () => {
    expect(validateRoleScope('app', 'app')).toEqual({ ok: true, data: null })
    expect(validateRoleScope('org', 'app')).toEqual({
      ok: false,
      status: 400,
      error: 'Role scope_type does not match binding scope',
    })
  })

  it('blocks demoting the last org_super_admin binding at the database layer', async () => {
    const id = randomUUID()
    const orgId = randomUUID()

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Last Super Admin Demotion Org ${id}`, `last-super-admin-demotion-${id}@capgo.app`, USER_ID])

    const bindingResult = await query(`
      SELECT rb.id, member_role.id AS member_role_id
      FROM public.role_bindings rb
      INNER JOIN public.roles bound_role
        ON bound_role.id = rb.role_id
      CROSS JOIN public.roles member_role
      WHERE rb.org_id = $1::uuid
        AND rb.principal_type = public.rbac_principal_user()
        AND rb.principal_id = $2::uuid
        AND rb.scope_type = public.rbac_scope_org()
        AND bound_role.name = public.rbac_role_org_super_admin()
        AND member_role.name = public.rbac_role_org_member()
      LIMIT 1
    `, [orgId, USER_ID])

    expect(bindingResult.rowCount).toBe(1)

    await expect(query(`
      UPDATE public.role_bindings
      SET role_id = $2::uuid
      WHERE id = $1::uuid
    `, [bindingResult.rows[0].id, bindingResult.rows[0].member_role_id]))
      .rejects
      .toThrow('CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING')
  })

  it('blocks deleting the last active org_super_admin when only an expired invite binding remains', async () => {
    const id = randomUUID()
    const orgId = randomUUID()

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Last Super Admin Expired Delete Org ${id}`, `last-super-admin-expired-delete-${id}@capgo.app`, USER_ID])

    const roleResult = await query(`
      SELECT id, name
      FROM public.roles
      WHERE name IN ('org_super_admin', 'org_member')
        AND scope_type = public.rbac_scope_org()
    `)
    const roleIds = new Map(roleResult.rows.map(row => [row.name, row.id]))
    const superAdminRoleId = roleIds.get('org_super_admin')
    expect(superAdminRoleId).toBeTruthy()

    await query(`
      INSERT INTO public.role_bindings (
        principal_type,
        principal_id,
        role_id,
        scope_type,
        org_id,
        granted_by,
        granted_at,
        expires_at,
        reason,
        is_direct
      ) VALUES (
        public.rbac_principal_user(),
        $1::uuid,
        $2::uuid,
        public.rbac_scope_org(),
        $3::uuid,
        $4::uuid,
        now(),
        now() - INTERVAL '1 second',
        'expired invite placeholder regression',
        true
      )
    `, [USER_ID_2, superAdminRoleId, orgId, USER_ID])

    const activeBindingResult = await query(`
      SELECT rb.id
      FROM public.role_bindings rb
      WHERE rb.org_id = $1::uuid
        AND rb.principal_type = public.rbac_principal_user()
        AND rb.principal_id = $2::uuid
        AND rb.scope_type = public.rbac_scope_org()
        AND rb.role_id = $3::uuid
      LIMIT 1
    `, [orgId, USER_ID, superAdminRoleId])
    expect(activeBindingResult.rowCount).toBe(1)

    await expect(query(`
      DELETE FROM public.role_bindings
      WHERE id = $1::uuid
    `, [activeBindingResult.rows[0].id]))
      .rejects
      .toThrow('CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING')
  })

  it('blocks demoting the last active org_super_admin when only an expired invite binding remains', async () => {
    const id = randomUUID()
    const orgId = randomUUID()

    await query(`
      INSERT INTO public.orgs (id, name, management_email, created_by)
      VALUES ($1::uuid, $2, $3, $4::uuid)
    `, [orgId, `Last Super Admin Expired Demotion Org ${id}`, `last-super-admin-expired-demotion-${id}@capgo.app`, USER_ID])

    const roleResult = await query(`
      SELECT id, name
      FROM public.roles
      WHERE name IN ('org_super_admin', 'org_member')
        AND scope_type = public.rbac_scope_org()
    `)
    const roleIds = new Map(roleResult.rows.map(row => [row.name, row.id]))
    const superAdminRoleId = roleIds.get('org_super_admin')
    const memberRoleId = roleIds.get('org_member')
    expect(superAdminRoleId).toBeTruthy()
    expect(memberRoleId).toBeTruthy()

    await query(`
      INSERT INTO public.role_bindings (
        principal_type,
        principal_id,
        role_id,
        scope_type,
        org_id,
        granted_by,
        granted_at,
        expires_at,
        reason,
        is_direct
      ) VALUES (
        public.rbac_principal_user(),
        $1::uuid,
        $2::uuid,
        public.rbac_scope_org(),
        $3::uuid,
        $4::uuid,
        now(),
        now() - INTERVAL '1 second',
        'expired invite placeholder regression',
        true
      )
    `, [USER_ID_2, superAdminRoleId, orgId, USER_ID])

    const activeBindingResult = await query(`
      SELECT rb.id
      FROM public.role_bindings rb
      WHERE rb.org_id = $1::uuid
        AND rb.principal_type = public.rbac_principal_user()
        AND rb.principal_id = $2::uuid
        AND rb.scope_type = public.rbac_scope_org()
        AND rb.role_id = $3::uuid
      LIMIT 1
    `, [orgId, USER_ID, superAdminRoleId])
    expect(activeBindingResult.rowCount).toBe(1)

    await expect(query(`
      UPDATE public.role_bindings
      SET role_id = $2::uuid
      WHERE id = $1::uuid
    `, [activeBindingResult.rows[0].id, memberRoleId]))
      .rejects
      .toThrow('CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING')
  })
})

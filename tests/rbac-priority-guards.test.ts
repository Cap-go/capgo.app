import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POSTGRES_URL, USER_ID, USER_ID_2, USER_ID_NONMEMBER } from './test-utils.ts'

interface RankFixture {
  orgId: string
  highBindingId: string
  highGroupId: string
  lowGroupId: string
}

interface AppScopedMembershipFixture extends RankFixture {
  appId: string
}

interface MembershipCleanupFixture extends AppScopedMembershipFixture {
  apiKeyRbacId: string
  channelId: number
}

interface SoleSuperAdminFixture {
  bindingId: string
  orgId: string
}

interface CreateFixtureOptions {
  user2Role?: 'org_admin' | 'org_super_admin'
}

describe('direct RBAC mutation priority guards', () => {
  let pool: Pool
  let client: PoolClient

  const query = (text: string, params?: Array<string | number | null>) => client.query(text, params)

  const withAuthClaim = async (userId: string) => {
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.sub', userId])
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.role', 'authenticated'])
    await query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claims',
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
      }),
    ])
    await query('SET LOCAL ROLE authenticated')
  }

  const withServiceRole = async () => {
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.role', 'service_role'])
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claims', JSON.stringify({ role: 'service_role' })])
    await query('SET LOCAL ROLE service_role')
  }

  const expectRejected = async (
    statement: string,
    params: Array<string | number | null>,
    expectedMessage: string,
  ) => {
    await query('SAVEPOINT rbac_priority_guard')
    let thrown: unknown
    try {
      await query(statement, params)
    }
    catch (error) {
      thrown = error
    }
    await query('ROLLBACK TO SAVEPOINT rbac_priority_guard')
    await query('RELEASE SAVEPOINT rbac_priority_guard')

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain(expectedMessage)
  }

  const expectRejectedAfterConstraintCheck = async (
    statement: string,
    params: Array<string | number | null>,
    expectedMessage: string,
  ) => {
    await query('SAVEPOINT rbac_priority_constraint_guard')
    let thrown: unknown
    try {
      await query(statement, params)
      await query('SET CONSTRAINTS ALL IMMEDIATE')
    }
    catch (error) {
      thrown = error
    }
    await query('ROLLBACK TO SAVEPOINT rbac_priority_constraint_guard')
    await query('RELEASE SAVEPOINT rbac_priority_constraint_guard')

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain(expectedMessage)
  }

  const createFixture = async ({ user2Role = 'org_admin' }: CreateFixtureOptions = {}): Promise<RankFixture> => {
    const fixtureId = randomUUID()
    const orgId = randomUUID()
    const highGroupId = randomUUID()
    const lowGroupId = randomUUID()

    await query(
      `
        INSERT INTO public.orgs (id, name, management_email, created_by)
        VALUES ($1::uuid, $2, $3, $4::uuid)
      `,
      [orgId, `RBAC priority ${fixtureId}`, `rbac-priority-${fixtureId}@capgo.app`, USER_ID],
    )

    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, public.rbac_role_org_admin(), false)
      `,
      [orgId, USER_ID_2],
    )

    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id, granted_by, is_direct
        )
        SELECT
          public.rbac_principal_user(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          true
        FROM public.roles
        WHERE roles.name = $4
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [USER_ID_2, orgId, USER_ID, user2Role],
    )

    await query(
      `
        INSERT INTO public.groups (id, org_id, name, description, created_by)
        VALUES
          ($1::uuid, $3::uuid, $5, 'High role group', $4::uuid),
          ($2::uuid, $3::uuid, $6, 'Unprivileged group', $4::uuid)
      `,
      [highGroupId, lowGroupId, orgId, USER_ID, `high-${fixtureId}`, `low-${fixtureId}`],
    )

    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id, granted_by, is_direct
        )
        SELECT
          public.rbac_principal_group(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_super_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [highGroupId, orgId, USER_ID],
    )

    await query(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES
          ($1::uuid, $3::uuid, $3::uuid),
          ($2::uuid, $3::uuid, $3::uuid)
      `,
      [highGroupId, lowGroupId, USER_ID],
    )

    const highBinding = await query(
      `
        SELECT role_bindings.id
        FROM public.role_bindings
        INNER JOIN public.roles
          ON roles.id = role_bindings.role_id
          AND roles.scope_type = role_bindings.scope_type
        WHERE role_bindings.principal_type = public.rbac_principal_user()
          AND role_bindings.principal_id = $1::uuid
          AND role_bindings.org_id = $2::uuid
          AND roles.name = public.rbac_role_org_super_admin()
        LIMIT 1
      `,
      [USER_ID, orgId],
    )

    const highBindingId = highBinding.rows[0]?.id as string | undefined
    expect(highBindingId).toBeTruthy()

    return { orgId, highBindingId: highBindingId!, highGroupId, lowGroupId }
  }

  const createSoleSuperAdminFixture = async (): Promise<SoleSuperAdminFixture> => {
    const fixtureId = randomUUID()
    const orgId = randomUUID()

    await query(
      `
        INSERT INTO public.orgs (id, name, management_email, created_by)
        VALUES ($1::uuid, $2, $3, $4::uuid)
      `,
      [orgId, `RBAC sole super admin ${fixtureId}`, `rbac-sole-super-admin-${fixtureId}@capgo.app`, USER_ID],
    )

    const binding = await query(
      `
        SELECT role_bindings.id
        FROM public.role_bindings
        INNER JOIN public.roles
          ON roles.id = role_bindings.role_id
          AND roles.scope_type = role_bindings.scope_type
        WHERE role_bindings.principal_type = public.rbac_principal_user()
          AND role_bindings.principal_id = $1::uuid
          AND role_bindings.org_id = $2::uuid
          AND role_bindings.scope_type = public.rbac_scope_org()
          AND roles.name = public.rbac_role_org_super_admin()
      `,
      [USER_ID, orgId],
    )
    expect(binding.rows).toHaveLength(1)

    return { bindingId: binding.rows[0].id as string, orgId }
  }

  const createAppScopedMembershipFixture = async (
    options: CreateFixtureOptions = {},
  ): Promise<AppScopedMembershipFixture> => {
    const fixture = await createFixture(options)
    const fixtureId = randomUUID()
    const appId = `com.rbac.app-scoped-membership.${fixtureId}`

    await query(
      `
        INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
        VALUES ($1::uuid, $2, $3, $4, $5::uuid)
      `,
      [randomUUID(), appId, `RBAC app-scoped membership ${fixtureId}`, 'rbac-app-scoped-membership-icon', fixture.orgId],
    )

    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, app_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, $3, public.rbac_role_org_admin(), false)
      `,
      [fixture.orgId, USER_ID, appId],
    )

    return { ...fixture, appId }
  }

  const createMembershipCleanupFixture = async (): Promise<MembershipCleanupFixture> => {
    const fixture = await createAppScopedMembershipFixture({ user2Role: 'org_super_admin' })
    const fixtureId = randomUUID()

    const version = await query(
      `
        INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
        VALUES ($1, $2, $3::uuid, $4::uuid, 'r2-direct')
        RETURNING id
      `,
      [fixture.appId, `1.0.0-rbac-cleanup-${fixtureId}`, fixture.orgId, USER_ID],
    )
    const versionId = Number(version.rows[0]?.id)
    expect(Number.isFinite(versionId)).toBe(true)

    const channel = await query(
      `
        INSERT INTO public.channels (name, app_id, version, created_by, owner_org)
        VALUES ($1, $2, $3::bigint, $4::uuid, $5::uuid)
        RETURNING id
      `,
      [`rbac-cleanup-${fixtureId}`, fixture.appId, versionId, USER_ID, fixture.orgId],
    )
    const channelId = Number(channel.rows[0]?.id)
    expect(Number.isFinite(channelId)).toBe(true)

    const apiKey = await query(
      `
        INSERT INTO public.apikeys (user_id, key, name)
        VALUES ($1::uuid, $2, $3)
        RETURNING rbac_id
      `,
      [USER_ID, `rbac-cleanup-${fixtureId}`, `RBAC cleanup ${fixtureId}`],
    )
    const apiKeyRbacId = apiKey.rows[0]?.rbac_id as string | undefined
    expect(apiKeyRbacId).toBeTruthy()

    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id, granted_by, is_direct
        )
        SELECT
          public.rbac_principal_apikey(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [apiKeyRbacId!, fixture.orgId, USER_ID],
    )

    await query(
      `
        INSERT INTO public.channel_permission_overrides (
          principal_type, principal_id, channel_id, permission_key, is_allowed
        )
        VALUES
          (
            public.rbac_principal_user(),
            $1::uuid,
            $2::bigint,
            public.rbac_perm_channel_promote_bundle(),
            false
          ),
          (
            public.rbac_principal_apikey(),
            $3::uuid,
            $2::bigint,
            public.rbac_perm_channel_promote_bundle(),
            false
          )
      `,
      [USER_ID, channelId, apiKeyRbacId!],
    )

    return { ...fixture, apiKeyRbacId: apiKeyRbacId!, channelId }
  }

  beforeAll(() => {
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

  it('blocks direct authenticated group and binding mutations above the caller rank', async () => {
    const fixture = await createFixture()
    await withAuthClaim(USER_ID_2)

    await expectRejected(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $2::uuid)
      `,
      [fixture.highGroupId, USER_ID_2],
      'Admins cannot elevate privileges!',
    )

    const hiddenDelete = await query(
      `
        DELETE FROM public.group_members
        WHERE group_id = $1::uuid
          AND user_id = $2::uuid
      `,
      [fixture.highGroupId, USER_ID],
    )
    expect(hiddenDelete.rowCount).toBe(0)

    await expectRejected(
      `
        UPDATE public.group_members
        SET group_id = $1::uuid
        WHERE group_id = $2::uuid
          AND user_id = $3::uuid
      `,
      [fixture.highGroupId, fixture.lowGroupId, USER_ID],
      'Admins cannot elevate privileges!',
    )

    const hiddenGroupUpdate = await query(
      `UPDATE public.groups SET description = 'rank guard' WHERE id = $1::uuid`,
      [fixture.highGroupId],
    )
    expect(hiddenGroupUpdate.rowCount).toBe(0)

    await expectRejected(
      `DELETE FROM public.role_bindings WHERE id = $1::uuid`,
      [fixture.highBindingId],
      'Admins cannot elevate privileges!',
    )

    await expectRejected(
      `UPDATE public.role_bindings SET expires_at = pg_catalog.now() WHERE id = $1::uuid`,
      [fixture.highBindingId],
      'Admins cannot elevate privileges!',
    )
  })

  it('rejects arbitrary group assignments and external group structure changes', async () => {
    const fixture = await createFixture()
    await withAuthClaim(USER_ID_2)

    await expectRejected(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [fixture.lowGroupId, USER_ID_NONMEMBER, USER_ID_2],
      'GROUP_MEMBER_NOT_IN_ORG',
    )

    await expectRejected(
      `UPDATE public.groups SET is_system = true WHERE id = $1::uuid`,
      [fixture.lowGroupId],
      'GROUP_STRUCTURE_MUTATION_FORBIDDEN',
    )

    const rawDelete = await query(
      `DELETE FROM public.groups WHERE id = $1::uuid RETURNING id`,
      [fixture.highGroupId],
    )
    expect(rawDelete.rows).toEqual([])
  })

  it('allows only base self-departure and atomically revokes user and owned-key org access', async () => {
    const fixture = await createMembershipCleanupFixture()
    await withAuthClaim(USER_ID_2)

    const managerDelete = await query(
      `
        DELETE FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
        RETURNING user_id
      `,
      [fixture.orgId, USER_ID],
    )
    expect(managerDelete.rows).toEqual([])

    await query('RESET ROLE')
    await withAuthClaim(USER_ID)
    const scopedDelete = await query(
      `
        DELETE FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id = $3
        RETURNING user_id, app_id
      `,
      [fixture.orgId, USER_ID, fixture.appId],
    )
    expect(scopedDelete.rows).toEqual([])

    const selfDelete = await query(
      `
        DELETE FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id IS NULL
          AND channel_id IS NULL
        RETURNING user_id
      `,
      [fixture.orgId, USER_ID],
    )
    expect(selfDelete.rows).toEqual([{ user_id: USER_ID }])

    await query('RESET ROLE')
    const cleanup = await query(
      `
        SELECT
          EXISTS (SELECT 1 FROM public.orgs WHERE id = $1::uuid) AS org_exists,
          EXISTS (
            SELECT 1
            FROM public.org_users
            WHERE org_id = $1::uuid
              AND user_id = $2::uuid
              AND app_id IS NULL
              AND channel_id IS NULL
          ) AS base_membership_exists,
          EXISTS (
            SELECT 1
            FROM public.org_users
            WHERE org_id = $1::uuid
              AND user_id = $2::uuid
              AND app_id = $3
          ) AS scoped_membership_exists,
          EXISTS (
            SELECT 1
            FROM public.group_members
            INNER JOIN public.groups ON groups.id = group_members.group_id
            WHERE groups.org_id = $1::uuid
              AND group_members.user_id = $2::uuid
          ) AS group_membership_exists,
          EXISTS (
            SELECT 1
            FROM public.role_bindings
            WHERE principal_type = public.rbac_principal_user()
              AND principal_id = $2::uuid
              AND org_id = $1::uuid
          ) AS user_binding_exists,
          EXISTS (
            SELECT 1
            FROM public.role_bindings
            WHERE principal_type = public.rbac_principal_apikey()
              AND principal_id = $4::uuid
              AND org_id = $1::uuid
          ) AS apikey_binding_exists,
          EXISTS (
            SELECT 1
            FROM public.channel_permission_overrides
            WHERE principal_type = public.rbac_principal_user()
              AND principal_id = $2::uuid
              AND channel_id = $5::bigint
          ) AS user_override_exists,
          EXISTS (
            SELECT 1
            FROM public.channel_permission_overrides
            WHERE principal_type = public.rbac_principal_apikey()
              AND principal_id = $4::uuid
              AND channel_id = $5::bigint
          ) AS apikey_override_exists
      `,
      [fixture.orgId, USER_ID, fixture.appId, fixture.apiKeyRbacId, fixture.channelId],
    )

    expect(cleanup.rows[0]).toEqual({
      org_exists: true,
      base_membership_exists: false,
      scoped_membership_exists: false,
      group_membership_exists: false,
      user_binding_exists: false,
      apikey_binding_exists: false,
      user_override_exists: false,
      apikey_override_exists: false,
    })
  })

  it('does not tear down an organization when app deletion cleans an app-scoped membership row', async () => {
    const fixture = await createAppScopedMembershipFixture()
    await withServiceRole()

    const deleted = await query(
      `
        DELETE FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id = $3
        RETURNING user_id, app_id
      `,
      [fixture.orgId, USER_ID, fixture.appId],
    )
    expect(deleted.rows).toEqual([{ user_id: USER_ID, app_id: fixture.appId }])

    const state = await query(
      `
        SELECT
          EXISTS (SELECT 1 FROM public.orgs WHERE id = $1::uuid) AS org_exists,
          EXISTS (
            SELECT 1
            FROM public.org_users
            WHERE org_id = $1::uuid
              AND user_id = $2::uuid
              AND app_id IS NULL
              AND channel_id IS NULL
          ) AS base_membership_exists,
          EXISTS (
            SELECT 1
            FROM public.role_bindings
            WHERE id = $3::uuid
          ) AS owner_binding_exists
      `,
      [fixture.orgId, USER_ID, fixture.highBindingId],
    )
    expect(state.rows[0]).toEqual({
      org_exists: true,
      base_membership_exists: true,
      owner_binding_exists: true,
    })
  })

  it('blocks removal of the last group-derived effective org super admin', async () => {
    const fixture = await createFixture()
    await withServiceRole()

    await query(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [fixture.highGroupId, USER_ID_2, USER_ID],
    )
    await query(
      `
        DELETE FROM public.group_members
        WHERE group_id = $1::uuid
          AND user_id = $2::uuid
      `,
      [fixture.highGroupId, USER_ID],
    )
    await query(
      `DELETE FROM public.role_bindings WHERE id = $1::uuid`,
      [fixture.highBindingId],
    )

    await query('RESET ROLE')
    await withAuthClaim(USER_ID_2)
    await expectRejectedAfterConstraintCheck(
      `
        DELETE FROM public.group_members
        WHERE group_id = $1::uuid
          AND user_id = $2::uuid
      `,
      [fixture.highGroupId, USER_ID_2],
      'CANNOT_REMOVE_LAST_EFFECTIVE_SUPER_ADMIN',
    )
  })

  it('blocks future expiry of the sole effective org super admin', async () => {
    const fixture = await createSoleSuperAdminFixture()
    await withServiceRole()

    await expectRejected(
      `
        UPDATE public.role_bindings
        SET expires_at = pg_catalog.now() + INTERVAL '1 day'
        WHERE id = $1::uuid
      `,
      [fixture.bindingId],
      'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING',
    )
  })

  it('blocks removal or demotion when the only successor expires in the future', async () => {
    const fixture = await createSoleSuperAdminFixture()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await withServiceRole()

    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id, granted_by, expires_at, is_direct
        )
        SELECT
          public.rbac_principal_user(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          $4::timestamptz,
          true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_super_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [USER_ID_2, fixture.orgId, USER_ID, expiresAt],
    )

    await expectRejected(
      `DELETE FROM public.role_bindings WHERE id = $1::uuid`,
      [fixture.bindingId],
      'CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING',
    )
    await expectRejected(
      `
        UPDATE public.role_bindings
        SET role_id = (
          SELECT roles.id
          FROM public.roles
          WHERE roles.name = public.rbac_role_org_admin()
            AND roles.scope_type = public.rbac_scope_org()
        )
        WHERE id = $1::uuid
      `,
      [fixture.bindingId],
      'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING',
    )
  })

  it('blocks self-leave and preserves base membership when the only successor expires in the future', async () => {
    const fixture = await createSoleSuperAdminFixture()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await withServiceRole()

    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, public.rbac_role_org_member(), false)
      `,
      [fixture.orgId, USER_ID_2],
    )
    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id, granted_by, expires_at, is_direct
        )
        SELECT
          public.rbac_principal_user(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          $4::timestamptz,
          true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_super_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [USER_ID_2, fixture.orgId, USER_ID, expiresAt],
    )

    await query('RESET ROLE')
    await withAuthClaim(USER_ID)
    await expectRejected(
      `
        DELETE FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id IS NULL
          AND channel_id IS NULL
      `,
      [fixture.orgId, USER_ID],
      'CANNOT_REMOVE_LAST_EFFECTIVE_SUPER_ADMIN',
    )

    await query('RESET ROLE')
    const membership = await query(
      `
        SELECT user_id
        FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id IS NULL
          AND channel_id IS NULL
      `,
      [fixture.orgId, USER_ID],
    )
    expect(membership.rows).toEqual([{ user_id: USER_ID }])
  })

  it('blocks removal when the only group-derived successor expires in the future', async () => {
    const fixture = await createSoleSuperAdminFixture()
    const groupId = randomUUID()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await withServiceRole()

    await query(
      `
        INSERT INTO public.groups (id, org_id, name, description, created_by)
        VALUES ($1::uuid, $2::uuid, $3, 'Future-expiring successor', $4::uuid)
      `,
      [groupId, fixture.orgId, `future-expiring-${randomUUID()}`, USER_ID],
    )
    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id, granted_by, expires_at, is_direct
        )
        SELECT
          public.rbac_principal_group(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          $4::timestamptz,
          true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_super_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [groupId, fixture.orgId, USER_ID, expiresAt],
    )
    await query(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [groupId, USER_ID_2, USER_ID],
    )

    await expectRejected(
      `DELETE FROM public.role_bindings WHERE id = $1::uuid`,
      [fixture.bindingId],
      'CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING',
    )
  })

  it('permits internal role-binding cleanup transactions', async () => {
    const fixture = await createFixture()
    await withServiceRole()

    const deleted = await query(
      `DELETE FROM public.role_bindings WHERE id = $1::uuid RETURNING id`,
      [fixture.highBindingId],
    )
    expect(deleted.rows).toEqual([{ id: fixture.highBindingId }])
  })
})

import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POSTGRES_URL, USER_EMAIL_NONMEMBER, USER_ID, USER_ID_NONMEMBER } from './test-utils.ts'

// public.org_users still carries legacy app-scoped rows (app_id set). Those rows share
// (org_id, user_id) with the organization membership row, so every org-level lookup in the
// invite path has to filter them out.
describe('org invite path ignores app-scoped org_users rows', () => {
  let pool: Pool
  let client: PoolClient

  const query = (text: string, params?: Array<string | number | null>) => client.query(text, params)

  const withAuthClaim = async (userId: string) => {
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.sub', userId])
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.role', 'authenticated'])
    await query(`SELECT set_config($1, $2, true)`, [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' }),
    ])
    await query('SET LOCAL ROLE authenticated')
  }

  const withServiceRole = async () => {
    await query('RESET ROLE')
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.sub', ''])
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claim.role', 'service_role'])
    await query(`SELECT set_config($1, $2, true)`, ['request.jwt.claims', JSON.stringify({ role: 'service_role' })])
    await query('SET LOCAL ROLE service_role')
  }

  beforeAll(() => {
    pool = new Pool({
      connectionString: POSTGRES_URL,
      // Keep one connection so SET LOCAL ROLE and JWT claims stay on the same session.
      max: 1,
    })
  })

  beforeEach(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
  })

  afterEach(async () => {
    if (!client)
      return
    try {
      await query('ROLLBACK')
    }
    finally {
      client.release()
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  // Org owned by USER_ID, who ends up with the org_super_admin binding.
  const createOrgOwnedByUser = async (ownerId: string) => {
    const orgId = randomUUID()
    await withServiceRole()
    await query(
      `
        INSERT INTO public.orgs (id, name, management_email, created_by)
        VALUES ($1::uuid, $2, $3, $4::uuid)
      `,
      [orgId, `Scoped invite org ${orgId}`, `scoped-invite-${orgId}@capgo.app`, ownerId],
    )
    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id,
          granted_by, granted_at, reason, is_direct
        )
        SELECT
          public.rbac_principal_user(), $1::uuid, roles.id, public.rbac_scope_org(), $2::uuid,
          $1::uuid, now(), 'Test owner binding', true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_super_admin()
          AND roles.scope_type = public.rbac_scope_org()
        ON CONFLICT DO NOTHING
      `,
      [ownerId, orgId],
    )
    return orgId
  }

  const createApp = async (orgId: string, ownerId: string) => {
    const appId = `scoped.invite.${orgId.slice(0, 8)}`
    await withServiceRole()
    await query(
      `
        INSERT INTO public.apps (app_id, name, icon_url, owner_org, user_id)
        VALUES ($1, $2, '', $3::uuid, $4::uuid)
      `,
      [appId, 'Scoped invite app', orgId, ownerId],
    )
    return appId
  }

  // Legacy leftover: a row for the same (org_id, user_id) that is scoped to a single app.
  const createAppScopedRow = async (orgId: string, appId: string, userId: string) => {
    await withServiceRole()
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, app_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, $3, 'app_developer', true)
      `,
      [orgId, userId, appId],
    )
  }

  const createPendingOrgInvite = async (orgId: string, inviteeId: string, roleName: string) => {
    await withServiceRole()
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, $3, true)
      `,
      [orgId, inviteeId, roleName],
    )
    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id,
          granted_by, granted_at, expires_at, reason, is_direct
        )
        SELECT
          public.rbac_principal_user(), $1::uuid, roles.id, public.rbac_scope_org(), $2::uuid,
          $3::uuid, now(), now() - INTERVAL '1 second', 'Pending invitation', true
        FROM public.roles
        WHERE roles.name = $4
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [inviteeId, orgId, USER_ID, roleName],
    )
  }

  it('accepts an org invitation even when an app-scoped row exists', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    await createPendingOrgInvite(orgId, USER_ID_NONMEMBER, 'org_admin')
    await createAppScopedRow(orgId, appId, USER_ID_NONMEMBER)

    await withAuthClaim(USER_ID_NONMEMBER)
    const result = await query(`SELECT public.accept_invitation_to_org($1::uuid) AS status`, [orgId])
    expect(result.rows[0]?.status).toBe('OK')

    await withServiceRole()
    const membership = await query(
      `
        SELECT rbac_role_name, is_invite
        FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id IS NULL
          AND channel_id IS NULL
      `,
      [orgId, USER_ID_NONMEMBER],
    )
    expect(membership.rows).toEqual([{ rbac_role_name: 'org_admin', is_invite: false }])
  })

  it('leaves the app-scoped row untouched when accepting an org invitation', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    await createPendingOrgInvite(orgId, USER_ID_NONMEMBER, 'org_admin')
    await createAppScopedRow(orgId, appId, USER_ID_NONMEMBER)

    await withAuthClaim(USER_ID_NONMEMBER)
    const accepted = await query(`SELECT public.accept_invitation_to_org($1::uuid) AS status`, [orgId])
    expect(accepted.rows[0]?.status).toBe('OK')

    await withServiceRole()
    const appRow = await query(
      `
        SELECT rbac_role_name, is_invite
        FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id = $3
      `,
      [orgId, USER_ID_NONMEMBER, appId],
    )
    expect(appRow.rows).toEqual([{ rbac_role_name: 'app_developer', is_invite: true }])
  })

  it('invites a user who only has an app-scoped row', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    await createAppScopedRow(orgId, appId, USER_ID_NONMEMBER)

    await withAuthClaim(USER_ID)
    const result = await query(
      `SELECT public.invite_user_to_org_rbac($1, $2::uuid, $3) AS status`,
      [USER_EMAIL_NONMEMBER, orgId, 'org_admin'],
    )
    expect(result.rows[0]?.status).toBe('OK')

    await withServiceRole()
    const invite = await query(
      `
        SELECT rbac_role_name, is_invite
        FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
          AND app_id IS NULL
          AND channel_id IS NULL
      `,
      [orgId, USER_ID_NONMEMBER],
    )
    expect(invite.rows).toEqual([{ rbac_role_name: 'org_admin', is_invite: true }])
  })

  it('retargets only the org-level pending row when the invite role changes', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    await createPendingOrgInvite(orgId, USER_ID_NONMEMBER, 'org_member')
    await createAppScopedRow(orgId, appId, USER_ID_NONMEMBER)

    await withAuthClaim(USER_ID)
    const result = await query(
      `SELECT public.update_org_invite_role_rbac($1::uuid, $2::uuid, $3) AS status`,
      [orgId, USER_ID_NONMEMBER, 'org_admin'],
    )
    expect(result.rows[0]?.status).toBe('OK')

    await withServiceRole()
    const rows = await query(
      `
        SELECT app_id, rbac_role_name
        FROM public.org_users
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
        ORDER BY app_id NULLS FIRST
      `,
      [orgId, USER_ID_NONMEMBER],
    )
    expect(rows.rows).toEqual([
      { app_id: null, rbac_role_name: 'org_admin' },
      { app_id: appId, rbac_role_name: 'app_developer' },
    ])
  })

  it('does not list app-scoped rows as pending org invitations', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    await createAppScopedRow(orgId, appId, USER_ID_NONMEMBER)

    await withAuthClaim(USER_ID)
    const members = await query(
      `
        SELECT user_id, role_name, is_invite
        FROM public.get_org_members_rbac($1::uuid)
        WHERE is_invite IS TRUE
      `,
      [orgId],
    )
    expect(members.rows).toEqual([])
  })

  it('does not accept an app-scoped invite row as proof for an org-role elevation', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    const groupId = randomUUID()

    await withServiceRole()
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, public.rbac_role_org_admin(), false)
      `,
      [orgId, USER_ID_NONMEMBER],
    )
    await query(
      `
        INSERT INTO public.groups (id, org_id, name, created_by)
        VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
      `,
      [groupId, orgId, `Scoped invite guard ${groupId}`, USER_ID],
    )
    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id,
          granted_by, granted_at, reason, is_direct
        )
        SELECT
          public.rbac_principal_group(), $1::uuid, roles.id, public.rbac_scope_org(), $2::uuid,
          $3::uuid, now(), 'Test group admin binding', true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [groupId, orgId, USER_ID],
    )
    await query(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [groupId, USER_ID_NONMEMBER, USER_ID],
    )
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, app_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, $3, public.rbac_role_org_super_admin(), true)
      `,
      [orgId, USER_ID_NONMEMBER, appId],
    )

    await withAuthClaim(USER_ID_NONMEMBER)

    let thrown: unknown
    try {
      await query(
        `
          INSERT INTO public.role_bindings (
            principal_type, principal_id, role_id, scope_type, org_id,
            granted_by, granted_at, reason, is_direct
          )
          SELECT
            public.rbac_principal_user(), $1::uuid, roles.id, public.rbac_scope_org(), $2::uuid,
            $1::uuid, now(), 'Accepted invitation', true
          FROM public.roles
          WHERE roles.name = public.rbac_role_org_super_admin()
            AND roles.scope_type = public.rbac_scope_org()
        `,
        [USER_ID_NONMEMBER, orgId],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')
  })

  it('does not allow an app-scoped row to be converted into an org invitation', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    const appId = await createApp(orgId, USER_ID)
    const groupId = randomUUID()

    await withServiceRole()
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, public.rbac_role_org_admin(), false)
      `,
      [orgId, USER_ID_NONMEMBER],
    )
    await query(
      `
        INSERT INTO public.groups (id, org_id, name, created_by)
        VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
      `,
      [groupId, orgId, `Scoped invite conversion ${groupId}`, USER_ID],
    )
    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id,
          granted_by, granted_at, reason, is_direct
        )
        SELECT
          public.rbac_principal_group(), $1::uuid, roles.id, public.rbac_scope_org(), $2::uuid,
          $3::uuid, now(), 'Test group admin binding', true
        FROM public.roles
        WHERE roles.name = public.rbac_role_org_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [groupId, orgId, USER_ID],
    )
    await query(
      `
        INSERT INTO public.group_members (group_id, user_id, added_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid)
      `,
      [groupId, USER_ID_NONMEMBER, USER_ID],
    )
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, app_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, $3, public.rbac_role_org_super_admin(), true)
      `,
      [orgId, USER_ID_NONMEMBER, appId],
    )

    await withAuthClaim(USER_ID_NONMEMBER)

    let thrown: unknown
    try {
      await query(
        `
          UPDATE public.org_users
          SET app_id = NULL
          WHERE org_id = $1::uuid
            AND user_id = $2::uuid
            AND app_id = $3
        `,
        [orgId, USER_ID_NONMEMBER, appId],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot move org membership scopes!')
  })
})

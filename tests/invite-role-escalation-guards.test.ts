import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOrgOwnedByUser,
  insertPendingOrgInvitation,
  POSTGRES_URL,
  setAuthenticatedClaim,
  setServiceRoleClaim,
  USER_ID,
  USER_ID_2,
  USER_ID_NONMEMBER,
} from './test-utils.ts'

describe('invite role escalation guards', () => {
  let pool: Pool
  let client: PoolClient

  const query = (text: string, params?: Array<string | number | null>) => client.query(text, params)

  beforeAll(() => {
    pool = new Pool({
      connectionString: POSTGRES_URL,
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

  async function bindOrgRole(orgId: string, userId: string, roleName: string, grantedBy = USER_ID) {
    await query(
      `
        INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
        VALUES ($1::uuid, $2::uuid, $3, false)
        ON CONFLICT DO NOTHING
      `,
      [orgId, userId, roleName],
    )

    await query(
      `
        INSERT INTO public.role_bindings (
          principal_type, principal_id, role_id, scope_type, org_id,
          granted_by, reason, is_direct
        )
        SELECT
          public.rbac_principal_user(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          'Invite escalation guard test',
          true
        FROM public.roles
        WHERE roles.name = $4
          AND roles.scope_type = public.rbac_scope_org()
        ON CONFLICT DO NOTHING
      `,
      [userId, orgId, grantedBy, roleName],
    )
  }

  async function insertTmpInvite(options: {
    orgId: string
    email: string
    roleName: string
    invitedBy: string | null
    magicString?: string
  }) {
    const magicString = options.magicString ?? `magic-${randomUUID()}`
    await setServiceRoleClaim(query)
    await query(
      `
        INSERT INTO public.tmp_users (
          email, org_id, rbac_role_name, first_name, last_name,
          invited_by_user_id, invite_magic_string
        ) VALUES ($1, $2::uuid, $3, 'Escalation', 'Target', $4::uuid, $5)
      `,
      [options.email, options.orgId, options.roleName, options.invitedBy, magicString],
    )
    return magicString
  }

  it('blocks org_admin from escalating a tmp_users invite to org_super_admin', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite escalation org')
    await bindOrgRole(orgId, USER_ID_2, 'org_admin')
    const email = `tmp-escalation-${randomUUID()}@capgo.app`
    await insertTmpInvite({
      orgId,
      email,
      roleName: 'org_member',
      invitedBy: USER_ID_2,
    })

    await setAuthenticatedClaim(query, USER_ID_2)

    let thrown: unknown
    await query('SAVEPOINT invite_escalation_block')
    try {
      await query(
        `SELECT public.update_tmp_invite_role_rbac($1::uuid, $2, $3)`,
        [orgId, email, 'org_super_admin'],
      )
    }
    catch (error) {
      thrown = error
      await query('ROLLBACK TO SAVEPOINT invite_escalation_block')
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')

    await setServiceRoleClaim(query)
    const invite = await query(
      `SELECT rbac_role_name FROM public.tmp_users WHERE org_id = $1::uuid AND email = $2`,
      [orgId, email],
    )
    expect(invite.rows[0]?.rbac_role_name).toBe('org_member')
  })

  it('allows org_super_admin to set a tmp_users invite role to org_super_admin', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite super admin org')
    const email = `tmp-super-${randomUUID()}@capgo.app`
    await insertTmpInvite({
      orgId,
      email,
      roleName: 'org_member',
      invitedBy: USER_ID,
    })

    await setAuthenticatedClaim(query, USER_ID)
    const result = await query(
      `SELECT public.update_tmp_invite_role_rbac($1::uuid, $2, $3) AS status`,
      [orgId, email, 'org_super_admin'],
    )
    expect(result.rows[0]?.status).toBe('OK')

    await setServiceRoleClaim(query)
    const invite = await query(
      `SELECT rbac_role_name FROM public.tmp_users WHERE org_id = $1::uuid AND email = $2`,
      [orgId, email],
    )
    expect(invite.rows[0]?.rbac_role_name).toBe('org_super_admin')
  })

  it('blocks org_admin from escalating a pending org_users invite to org_super_admin', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Org invite escalation org')
    await bindOrgRole(orgId, USER_ID_2, 'org_admin')
    await setServiceRoleClaim(query)
    await insertPendingOrgInvitation(query, {
      orgId,
      inviteeId: USER_ID_NONMEMBER,
      roleName: 'org_member',
      grantedBy: USER_ID_2,
    })

    await setAuthenticatedClaim(query, USER_ID_2)

    let thrown: unknown
    try {
      await query(
        `SELECT public.update_org_invite_role_rbac($1::uuid, $2::uuid, $3)`,
        [orgId, USER_ID_NONMEMBER, 'org_super_admin'],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')
  })

  it('rejects accept_invitation_to_org when the invite role exceeds inviter rank', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Accept invite escalation org')
    await bindOrgRole(orgId, USER_ID_2, 'org_admin')
    await setServiceRoleClaim(query)
    await insertPendingOrgInvitation(query, {
      orgId,
      inviteeId: USER_ID_NONMEMBER,
      roleName: 'org_member',
      grantedBy: USER_ID_2,
    })

    await query(
      `
        UPDATE public.org_users
        SET rbac_role_name = public.rbac_role_org_super_admin()
        WHERE org_id = $1::uuid
          AND user_id = $2::uuid
      `,
      [orgId, USER_ID_NONMEMBER],
    )

    await query(
      `
        UPDATE public.role_bindings rb
        SET role_id = roles.id
        FROM public.roles
        WHERE rb.principal_type = public.rbac_principal_user()
          AND rb.principal_id = $1::uuid
          AND rb.org_id = $2::uuid
          AND rb.scope_type = public.rbac_scope_org()
          AND roles.name = public.rbac_role_org_super_admin()
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [USER_ID_NONMEMBER, orgId],
    )

    await setAuthenticatedClaim(query, USER_ID_NONMEMBER)

    let thrown: unknown
    try {
      await query(
        `SELECT public.accept_invitation_to_org($1::uuid) AS status`,
        [orgId],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')
  })

  it('rejects accept_tmp_user_invitation when the invite role exceeds inviter rank', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite accept escalation org')
    await bindOrgRole(orgId, USER_ID_2, 'org_admin')
    const email = `tmp-accept-escalation-${randomUUID()}@capgo.app`
    const magicString = await insertTmpInvite({
      orgId,
      email,
      roleName: 'org_member',
      invitedBy: USER_ID_2,
    })

    await setServiceRoleClaim(query)
    await query(
      `UPDATE public.tmp_users SET rbac_role_name = public.rbac_role_org_super_admin() WHERE invite_magic_string = $1`,
      [magicString],
    )

    let thrown: unknown
    await query('SAVEPOINT tmp_invite_accept_escalation')
    try {
      await query(
        `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
        [magicString, USER_ID_NONMEMBER],
      )
    }
    catch (error) {
      thrown = error
      await query('ROLLBACK TO SAVEPOINT tmp_invite_accept_escalation')
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')

    const invite = await query(
      `SELECT id FROM public.tmp_users WHERE invite_magic_string = $1`,
      [magicString],
    )
    expect(invite.rows.length).toBe(1)
  })

  it('rejects accept_tmp_user_invitation when invited_by_user_id is null', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Legacy tmp invite org')
    const email = `legacy-invite-${randomUUID()}@capgo.app`
    const magicString = await insertTmpInvite({
      orgId,
      email,
      roleName: 'org_member',
      invitedBy: null,
    })

    await setServiceRoleClaim(query)
    const result = await query(
      `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
      [magicString, USER_ID_NONMEMBER],
    )
    expect(result.rows[0]?.status).toBe('INVITER_NOT_FOUND')
  })

  it('rejects accept_tmp_user_invitation when the invitee is already an active org member', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite already member org')
    await bindOrgRole(orgId, USER_ID_NONMEMBER, 'org_member')
    const email = `already-member-${randomUUID()}@capgo.app`
    const magicString = await insertTmpInvite({
      orgId,
      email,
      roleName: 'org_admin',
      invitedBy: USER_ID,
    })

    await setServiceRoleClaim(query)
    const result = await query(
      `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
      [magicString, USER_ID_NONMEMBER],
    )
    expect(result.rows[0]?.status).toBe('ALREADY_MEMBER')

    const invite = await query(
      `SELECT id FROM public.tmp_users WHERE invite_magic_string = $1`,
      [magicString],
    )
    expect(invite.rows.length).toBe(1)
  })

  it('records the inviter as granted_by when accepting a tmp_users invitation', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite granted_by org')
    const email = `granted-by-${randomUUID()}@capgo.app`
    const magicString = await insertTmpInvite({
      orgId,
      email,
      roleName: 'org_member',
      invitedBy: USER_ID,
    })

    await setServiceRoleClaim(query)
    const acceptResult = await query(
      `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
      [magicString, USER_ID_NONMEMBER],
    )
    expect(acceptResult.rows[0]?.status).toBe('OK')

    const binding = await query(
      `
        SELECT granted_by
        FROM public.role_bindings
        WHERE principal_type = public.rbac_principal_user()
          AND principal_id = $1::uuid
          AND org_id = $2::uuid
          AND scope_type = public.rbac_scope_org()
          AND reason = 'Accepted invitation'
      `,
      [USER_ID_NONMEMBER, orgId],
    )
    expect(binding.rows[0]?.granted_by).toBe(USER_ID)
  })

  it('rejects assert_principal_can_grant_org_role for escalated tmp invite roles', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite assert org')
    await bindOrgRole(orgId, USER_ID_2, 'org_admin')

    await setServiceRoleClaim(query)
    let thrown: unknown
    try {
      await query(
        `
          SELECT public.assert_principal_can_grant_org_role(
            $1::uuid,
            $2::uuid,
            public.rbac_role_org_super_admin(),
            'test'
          )
        `,
        [orgId, USER_ID_2],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')
  })
})

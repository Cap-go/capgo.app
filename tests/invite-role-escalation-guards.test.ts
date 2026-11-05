import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createOrgAdminApiKey,
  createOrgOwnedByUser,
  insertPendingOrgInvitation,
  POSTGRES_URL,
  setAnonCapgkeyClaim,
  setAuthenticatedClaim,
  setServiceRoleClaim,
  USER_ID,
  USER_ID_2,
  USER_ID_NONMEMBER,
} from './test-utils.ts'

// Database-level guards for org invitations and memberships. Every test runs in
// its own transaction on a single connection (so SET LOCAL ROLE and JWT claims
// stick) and is rolled back afterwards.
describe('org invitation database guards', () => {
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

  async function expectQueryError(text: string, params: Array<string | number | null>, message: string) {
    let thrown: unknown
    await query('SAVEPOINT expect_query_error')
    try {
      await query(text, params)
    }
    catch (error) {
      thrown = error
      await query('ROLLBACK TO SAVEPOINT expect_query_error')
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain(message)
  }

  const createPendingInvite = async (orgId: string, inviteeId: string, roleName: string, grantedBy = USER_ID) => {
    await setServiceRoleClaim(query)
    await insertPendingOrgInvitation(query, {
      orgId,
      inviteeId,
      roleName,
      grantedBy,
    })
  }

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

  describe('invite role escalation', () => {
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

      await expectQueryError(
        `SELECT public.update_tmp_invite_role_rbac($1::uuid, $2, $3)`,
        [orgId, email, 'org_super_admin'],
        'Admins cannot elevate privileges!',
      )

      await setServiceRoleClaim(query)
      const invite = await query(
        `SELECT rbac_role_name FROM public.tmp_users WHERE org_id = $1::uuid AND email = $2`,
        [orgId, email],
      )
      expect(invite.rows[0]?.rbac_role_name).toBe('org_member')
    })

    it('allows accepting a tmp_users invite after a super admin promotes an admin-created invitation', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Tmp invite promote then accept org')
      await bindOrgRole(orgId, USER_ID_2, 'org_admin')
      const email = `tmp-promote-accept-${randomUUID()}@capgo.app`
      const magicString = await insertTmpInvite({
        orgId,
        email,
        roleName: 'org_member',
        invitedBy: USER_ID_2,
      })

      await setAuthenticatedClaim(query, USER_ID)
      const promoteResult = await query(
        `SELECT public.update_tmp_invite_role_rbac($1::uuid, $2, $3) AS status`,
        [orgId, email, 'org_super_admin'],
      )
      expect(promoteResult.rows[0]?.status).toBe('OK')

      await setServiceRoleClaim(query)
      const inviter = await query(
        `SELECT invited_by_user_id FROM public.tmp_users WHERE invite_magic_string = $1`,
        [magicString],
      )
      expect(inviter.rows[0]?.invited_by_user_id).toBe(USER_ID)

      const acceptResult = await query(
        `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
        [magicString, USER_ID_NONMEMBER],
      )
      expect(acceptResult.rows[0]?.status).toBe('OK')
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
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member', USER_ID_2)

      await setAuthenticatedClaim(query, USER_ID_2)

      await expectQueryError(
        `SELECT public.update_org_invite_role_rbac($1::uuid, $2::uuid, $3)`,
        [orgId, USER_ID_NONMEMBER, 'org_super_admin'],
        'Admins cannot elevate privileges!',
      )
    })

    it('rejects accept_invitation_to_org when the invite role exceeds inviter rank', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Accept invite escalation org')
      await bindOrgRole(orgId, USER_ID_2, 'org_admin')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member', USER_ID_2)

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

      await expectQueryError(
        `SELECT public.accept_invitation_to_org($1::uuid) AS status`,
        [orgId],
        'Admins cannot elevate privileges!',
      )
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

      await expectQueryError(
        `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
        [magicString, USER_ID_NONMEMBER],
        'Admins cannot elevate privileges!',
      )

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

    it('accepts legacy tmp_users invite after update_tmp_invite_role_rbac records the inviter', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Legacy tmp invite refresh org')
      const email = `legacy-refresh-${randomUUID()}@capgo.app`
      const magicString = await insertTmpInvite({
        orgId,
        email,
        roleName: 'org_member',
        invitedBy: null,
      })

      await setAuthenticatedClaim(query, USER_ID)
      const refreshResult = await query(
        `SELECT public.update_tmp_invite_role_rbac($1::uuid, $2, $3) AS status`,
        [orgId, email, 'org_member'],
      )
      expect(refreshResult.rows[0]?.status).toBe('OK')

      await setServiceRoleClaim(query)
      const acceptResult = await query(
        `SELECT public.accept_tmp_user_invitation($1, $2::uuid) AS status`,
        [magicString, USER_ID_NONMEMBER],
      )
      expect(acceptResult.rows[0]?.status).toBe('OK')
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

    it('records the inviter as granted_by when accepting an org_users invitation', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Org invite granted_by org')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member')

      await setAuthenticatedClaim(query, USER_ID_NONMEMBER)
      const acceptResult = await query(
        `SELECT public.accept_invitation_to_org($1::uuid) AS status`,
        [orgId],
      )
      expect(acceptResult.rows[0]?.status).toBe('OK')

      await setServiceRoleClaim(query)
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
      await expectQueryError(
        `
            SELECT public.assert_principal_can_grant_org_role(
              $1::uuid,
              $2::uuid,
              public.rbac_role_org_super_admin(),
              'test'
            )
          `,
        [orgId, USER_ID_2],
        'Admins cannot elevate privileges!',
      )
    })
  })

  describe('org_users require pending invite on insert', () => {
    it('restores caller auth context after createOrgOwnedByUser', async () => {
      await setAuthenticatedClaim(query, USER_ID)
      const before = await query(`
        SELECT
          current_user AS sql_role,
          current_setting('request.jwt.claim.role', true) AS jwt_role,
          current_setting('request.jwt.claims', true) AS jwt_claims
      `)

      await createOrgOwnedByUser(query, USER_ID, 'Auth restore org')

      const after = await query(`
        SELECT
          current_user AS sql_role,
          current_setting('request.jwt.claim.role', true) AS jwt_role,
          current_setting('request.jwt.claims', true) AS jwt_claims
      `)

      expect(after.rows[0]?.sql_role).toBe(before.rows[0]?.sql_role)
      expect(after.rows[0]?.jwt_role).toBe(before.rows[0]?.jwt_role)
      expect(after.rows[0]?.jwt_claims).toBe(before.rows[0]?.jwt_claims)
    })

    it('rejects org admin direct INSERT of an active third-party membership', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite insert org')

      await setAuthenticatedClaim(query, USER_ID)
      await expectQueryError(
        `
            INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
            VALUES ($1::uuid, $2::uuid, $3, false)
          `,
        [USER_ID_NONMEMBER, orgId, 'org_member'],
        'Admins cannot insert active org memberships!',
      )
    })

    it('rejects anon API-key INSERT of an active third-party membership', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite insert anon org')
      const apiKey = await createOrgAdminApiKey(query, {
        orgId,
        ownerId: USER_ID,
        label: `Invite insert anon ${orgId}`,
      })

      await setAnonCapgkeyClaim(query, apiKey)
      await expectQueryError(
        `
            INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
            VALUES ($1::uuid, $2::uuid, $3, false)
          `,
        [USER_ID_NONMEMBER, orgId, 'org_member'],
        'Admins cannot insert active org memberships!',
      )
    })

    it('allows org admin to INSERT a pending invite', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite insert org')

      await setAuthenticatedClaim(query, USER_ID)
      const result = await query(
        `
          INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
          VALUES ($1::uuid, $2::uuid, $3, true)
          RETURNING is_invite, rbac_role_name
        `,
        [USER_ID_NONMEMBER, orgId, 'org_member'],
      )

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.is_invite).toBe(true)
      expect(result.rows[0]?.rbac_role_name).toBe('org_member')
    })

    it('allows an invitee to accept a pending invitation', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite insert org')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member')

      await setAuthenticatedClaim(query, USER_ID_NONMEMBER)
      const result = await query(
        `SELECT public.accept_invitation_to_org($1::uuid) AS status`,
        [orgId],
      )
      expect(result.rows[0]?.status).toBe('OK')

      const membership = await query(
        `
          SELECT is_invite, rbac_role_name
          FROM public.org_users
          WHERE org_id = $1::uuid
            AND user_id = $2::uuid
        `,
        [orgId, USER_ID_NONMEMBER],
      )
      expect(membership.rows).toHaveLength(1)
      expect(membership.rows[0]?.is_invite).toBe(false)
      expect(membership.rows[0]?.rbac_role_name).toBe('org_member')
    })

    it('allows an org admin to clear is_invite on a pending membership', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite insert org')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member')

      await setAuthenticatedClaim(query, USER_ID)
      const result = await query(
        `
          UPDATE public.org_users
          SET is_invite = false
          WHERE org_id = $1::uuid
            AND user_id = $2::uuid
          RETURNING is_invite, rbac_role_name
        `,
        [orgId, USER_ID_NONMEMBER],
      )

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.is_invite).toBe(false)
      expect(result.rows[0]?.rbac_role_name).toBe('org_member')
    })
  })

  describe('accept_invitation_to_org privilege guards', () => {
    it('allows an invitee to accept an org_admin invitation without privilege escalation errors', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Accept invite org')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_admin')

      await setAuthenticatedClaim(query, USER_ID_NONMEMBER)
      const result = await query(
        `SELECT public.accept_invitation_to_org($1::uuid) AS status`,
        [orgId],
      )
      expect(result.rows[0]?.status).toBe('OK')

      const membership = await query(
        `
          SELECT is_invite, rbac_role_name
          FROM public.org_users
          WHERE org_id = $1::uuid
            AND user_id = $2::uuid
        `,
        [orgId, USER_ID_NONMEMBER],
      )
      expect(membership.rows).toHaveLength(1)
      expect(membership.rows[0]?.is_invite).toBe(false)
      expect(membership.rows[0]?.rbac_role_name).toBe('org_admin')

      const bindings = await query(
        `
          SELECT roles.name AS role_name, role_bindings.reason, role_bindings.expires_at
          FROM public.role_bindings
          JOIN public.roles
            ON roles.id = role_bindings.role_id
            AND roles.scope_type = role_bindings.scope_type
          WHERE role_bindings.principal_type = public.rbac_principal_user()
            AND role_bindings.principal_id = $1::uuid
            AND role_bindings.org_id = $2::uuid
            AND role_bindings.scope_type = public.rbac_scope_org()
        `,
        [USER_ID_NONMEMBER, orgId],
      )
      expect(bindings.rows).toHaveLength(1)
      expect(bindings.rows[0]?.role_name).toBe('org_admin')
      expect(bindings.rows[0]?.reason).toBe('Accepted invitation')
      expect(bindings.rows[0]?.expires_at).toBeNull()
    })

    it('allows an invitee to accept an org_super_admin invitation', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Accept invite org')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_super_admin')

      await setAuthenticatedClaim(query, USER_ID_NONMEMBER)
      const result = await query(
        `SELECT public.accept_invitation_to_org($1::uuid) AS status`,
        [orgId],
      )
      expect(result.rows[0]?.status).toBe('OK')

      const bindings = await query(
        `
          SELECT roles.name AS role_name
          FROM public.role_bindings
          JOIN public.roles
            ON roles.id = role_bindings.role_id
            AND roles.scope_type = role_bindings.scope_type
          WHERE role_bindings.principal_type = public.rbac_principal_user()
            AND role_bindings.principal_id = $1::uuid
            AND role_bindings.org_id = $2::uuid
            AND (
              role_bindings.expires_at IS NULL
              OR role_bindings.expires_at > now()
            )
        `,
        [USER_ID_NONMEMBER, orgId],
      )
      expect(bindings.rows).toEqual([{ role_name: 'org_super_admin' }])
    })

    it('still blocks invitees from inventing a higher role binding without a matching invite', async () => {
      const orgId = await createOrgOwnedByUser(query, USER_ID, 'Accept invite org')
      await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member')

      await setAuthenticatedClaim(query, USER_ID_NONMEMBER)

      await expectQueryError(
        `
            INSERT INTO public.role_bindings (
              principal_type, principal_id, role_id, scope_type, org_id,
              granted_by, granted_at, reason, is_direct
            )
            SELECT
              public.rbac_principal_user(),
              $1::uuid,
              roles.id,
              public.rbac_scope_org(),
              $2::uuid,
              $1::uuid,
              now(),
              'Accepted invitation',
              true
            FROM public.roles
            WHERE roles.name = public.rbac_role_org_admin()
              AND roles.scope_type = public.rbac_scope_org()
          `,
        [USER_ID_NONMEMBER, orgId],
        'Admins cannot elevate privileges!',
      )
    })
  })
})

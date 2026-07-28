import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POSTGRES_URL, USER_ID, USER_ID_NONMEMBER } from './test-utils.ts'

describe('accept_invitation_to_org privilege guards', () => {
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

  const createOrgOwnedByUser = async (ownerId: string) => {
    const orgId = randomUUID()
    await withServiceRole()
    await query(
      `
        INSERT INTO public.orgs (id, name, management_email, created_by)
        VALUES ($1::uuid, $2, $3, $4::uuid)
      `,
      [orgId, `Accept invite org ${orgId}`, `accept-invite-${orgId}@capgo.app`, ownerId],
    )
    return orgId
  }

  const createPendingInvite = async (orgId: string, inviteeId: string, roleName: string) => {
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
          public.rbac_principal_user(),
          $1::uuid,
          roles.id,
          public.rbac_scope_org(),
          $2::uuid,
          $3::uuid,
          now(),
          now() - INTERVAL '1 second',
          'Pending invitation',
          true
        FROM public.roles
        WHERE roles.name = $4
          AND roles.scope_type = public.rbac_scope_org()
      `,
      [inviteeId, orgId, USER_ID, roleName],
    )
  }

  it('allows an invitee to accept an org_admin invitation without privilege escalation errors', async () => {
    const orgId = await createOrgOwnedByUser(USER_ID)
    await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_admin')

    await withAuthClaim(USER_ID_NONMEMBER)
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
    const orgId = await createOrgOwnedByUser(USER_ID)
    await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_super_admin')

    await withAuthClaim(USER_ID_NONMEMBER)
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
    const orgId = await createOrgOwnedByUser(USER_ID)
    await createPendingInvite(orgId, USER_ID_NONMEMBER, 'org_member')

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
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot elevate privileges!')
  })
})

import type { PoolClient } from 'pg'
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
  USER_ID_NONMEMBER,
} from './test-utils.ts'

describe('org_users require pending invite on insert', () => {
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

  const createPendingInvite = async (orgId: string, inviteeId: string, roleName: string) => {
    await setServiceRoleClaim(query)
    await insertPendingOrgInvitation(query, {
      orgId,
      inviteeId,
      roleName,
      grantedBy: USER_ID,
    })
  }

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
    let thrown: unknown
    try {
      await query(
        `
          INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
          VALUES ($1::uuid, $2::uuid, $3, false)
        `,
        [USER_ID_NONMEMBER, orgId, 'org_member'],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot insert active org memberships!')
  })

  it('rejects anon API-key INSERT of an active third-party membership', async () => {
    const orgId = await createOrgOwnedByUser(query, USER_ID, 'Invite insert anon org')
    const apiKey = await createOrgAdminApiKey(query, {
      orgId,
      ownerId: USER_ID,
      label: `Invite insert anon ${orgId}`,
    })

    await setAnonCapgkeyClaim(query, apiKey)
    let thrown: unknown
    try {
      await query(
        `
          INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
          VALUES ($1::uuid, $2::uuid, $3, false)
        `,
        [USER_ID_NONMEMBER, orgId, 'org_member'],
      )
    }
    catch (error) {
      thrown = error
    }

    expect(thrown).toBeTruthy()
    expect((thrown as Error).message).toContain('Admins cannot insert active org memberships!')
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

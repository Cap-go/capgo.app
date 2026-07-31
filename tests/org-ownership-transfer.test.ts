import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getPostgresClient,
  USER_ID,
  USER_ID_2,
} from './test-utils.ts'

const transferOrgId = randomUUID()
const protectedOrgId = randomUUID()
const orgIds = [transferOrgId, protectedOrgId]

async function withAuthenticatedUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getPostgresClient()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.sub', userId])
    await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.role', 'authenticated'])
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' }),
    ])

    const result = await fn(client)
    await client.query('COMMIT')
    return result
  }
  catch (error) {
    try {
      await client.query('ROLLBACK')
    }
    catch {
      // Keep the database error that caused the authenticated request to fail.
    }
    throw error
  }
  finally {
    client.release()
  }
}

async function createOrgWithMember(orgId: string) {
  await executeSQL(
    `INSERT INTO public.orgs (id, created_by, management_email, name, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, NOW())`,
    [orgId, USER_ID, `ownership-transfer-${orgId}@capgo.app`, `Ownership transfer ${orgId}`],
  )

  await executeSQL(
    `INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
     VALUES ($1::uuid, $2::uuid, 'org_member', false)`,
    [orgId, USER_ID_2],
  )

  const bindings = await executeSQL(
    `INSERT INTO public.role_bindings (
       principal_type, principal_id, role_id, scope_type, org_id,
       granted_by, reason, is_direct
     )
     SELECT
       public.rbac_principal_user(), $1::uuid, roles.id, public.rbac_scope_org(), $2::uuid,
       $3::uuid, 'Ownership transfer test member fixture', true
     FROM public.roles
     WHERE roles.name = public.rbac_role_org_member()
       AND roles.scope_type = public.rbac_scope_org()
     RETURNING id`,
    [USER_ID_2, orgId, USER_ID],
  )
  if (!bindings[0])
    throw new Error('Expected org_member role')
}

describe('organization ownership transfer', () => {
  beforeAll(async () => {
    for (const orgId of orgIds) {
      await createOrgWithMember(orgId)
    }
  })

  afterAll(async () => {
    const orgs = await executeSQL(
      'SELECT customer_id FROM public.orgs WHERE id = ANY($1::uuid[])',
      [orgIds],
    )

    // Delete orgs first so role_bindings cascade without hitting
    // prevent_last_super_admin_binding_delete on direct binding deletes.
    await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [orgIds])

    for (const org of orgs) {
      if (org.customer_id?.startsWith('pending_')) {
        await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [org.customer_id])
      }
    }
  })

  it.concurrent('lets an owner delegate super admin and leave the org', async () => {
    const promoteResult = await withAuthenticatedUser(USER_ID, client => client.query(
      'SELECT public.update_org_member_role($1::uuid, $2::uuid, $3) AS status',
      [transferOrgId, USER_ID_2, 'org_super_admin'],
    ))
    expect(promoteResult.rows[0]?.status).toBe('OK')

    const leaveResult = await withAuthenticatedUser(USER_ID, client => client.query(
      'SELECT public.delete_org_member_role($1::uuid, $2::uuid) AS status',
      [transferOrgId, USER_ID],
    ))
    expect(leaveResult.rows[0]?.status).toBe('OK')

    const [org] = await executeSQL('SELECT created_by FROM public.orgs WHERE id = $1::uuid', [transferOrgId])
    expect(org?.created_by).toBe(USER_ID_2)
  })

  it.concurrent('does not let another super admin remove the owner', async () => {
    const promoteResult = await withAuthenticatedUser(USER_ID, client => client.query(
      'SELECT public.update_org_member_role($1::uuid, $2::uuid, $3) AS status',
      [protectedOrgId, USER_ID_2, 'org_super_admin'],
    ))
    expect(promoteResult.rows[0]?.status).toBe('OK')

    await expect(withAuthenticatedUser(USER_ID_2, client => client.query(
      'SELECT public.delete_org_member_role($1::uuid, $2::uuid)',
      [protectedOrgId, USER_ID],
    ))).rejects.toThrow('CANNOT_CHANGE_OWNER_ROLE')

    const [org] = await executeSQL('SELECT created_by FROM public.orgs WHERE id = $1::uuid', [protectedOrgId])
    expect(org?.created_by).toBe(USER_ID)
  })
})

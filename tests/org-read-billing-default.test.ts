import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL, USER_ID, USER_PASSWORD_HASH, withAuthenticatedUser } from './test-utils.ts'

const fixtureId = randomUUID()
const orgId = randomUUID()
const customerId = `cus_read_billing_${fixtureId.replaceAll('-', '').slice(0, 20)}`
const memberWithDefaultId = randomUUID()
const memberWithoutBillingId = randomUUID()

let pool: Pool
let noBillingRoleId: string
let orgMemberRoleId: string

async function createAuthUser(client: PoolClient, userId: string, email: string) {
  await client.query(`
    INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
    VALUES ($1::uuid, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `, [userId, email, USER_PASSWORD_HASH])

  await client.query(`
    INSERT INTO public.users (id, email, first_name)
    VALUES ($1::uuid, $2, 'Read Billing Fixture')
    ON CONFLICT (id) DO NOTHING
  `, [userId, email])
}

beforeAll(async () => {
  pool = new Pool({ connectionString: POSTGRES_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const roles = await client.query(`
      SELECT id
      FROM public.roles
      WHERE name = public.rbac_role_org_member()
      LIMIT 1
    `)
    orgMemberRoleId = roles.rows[0]?.id
    expect(orgMemberRoleId).toBeTruthy()

    // Guard: org_member must include org.read_billing by default.
    const memberPerm = await client.query(`
      SELECT 1
      FROM public.role_permissions rp
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1::uuid
        AND p.key = public.rbac_perm_org_read_billing()
      LIMIT 1
    `, [orgMemberRoleId])
    expect(memberPerm.rowCount).toBe(1)

    await client.query(`
      INSERT INTO public.stripe_info (
        customer_id, status, product_id, subscription_id, trial_at, is_good_plan
      )
      VALUES (
        $1, 'succeeded', 'prod_LQIregjtNduh4q', $2, now() + interval '15 days', true
      )
    `, [customerId, `sub_${fixtureId}`])

    await client.query(`
      INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5)
    `, [orgId, USER_ID, `Read Billing Org ${fixtureId}`, `read-billing-${fixtureId}@capgo.app`, customerId])

    await createAuthUser(client, memberWithDefaultId, `read-billing-default-${fixtureId}@capgo.app`)
    await createAuthUser(client, memberWithoutBillingId, `read-billing-denied-${fixtureId}@capgo.app`)

    // Dedicated role without org.read_billing for revoke/deny coverage.
    const noBillingRole = await client.query(`
      INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
      VALUES (
        $1,
        public.rbac_scope_org(),
        'Test role without billing read',
        4,
        true,
        $2::uuid
      )
      RETURNING id
    `, [`org_no_billing_${fixtureId.slice(0, 8)}`, USER_ID])
    noBillingRoleId = noBillingRole.rows[0].id

    await client.query(`
      INSERT INTO public.role_permissions (role_id, permission_id)
      SELECT $1::uuid, p.id
      FROM public.permissions p
      WHERE p.key IN (
        public.rbac_perm_org_read(),
        public.rbac_perm_org_read_members()
      )
      ON CONFLICT DO NOTHING
    `, [noBillingRoleId])

    await client.query(`
      INSERT INTO public.role_bindings (
        principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct
      )
      VALUES
        (public.rbac_principal_user(), $1::uuid, $2::uuid, public.rbac_scope_org(), $3::uuid, $4::uuid, 'default member', true),
        (public.rbac_principal_user(), $5::uuid, $6::uuid, public.rbac_scope_org(), $3::uuid, $4::uuid, 'no billing member', true)
    `, [
      memberWithDefaultId,
      orgMemberRoleId,
      orgId,
      USER_ID,
      memberWithoutBillingId,
      noBillingRoleId,
    ])

    await client.query(`
      INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
      VALUES
        ($1::uuid, $2::uuid, public.rbac_role_org_member(), false),
        ($1::uuid, $3::uuid, public.rbac_role_org_member(), false)
    `, [orgId, memberWithDefaultId, memberWithoutBillingId])

    await client.query(`
      INSERT INTO public.usage_credit_grants (
        org_id, credits_total, credits_consumed, expires_at, source, notes
      )
      VALUES ($1::uuid, 250, 50, now() + interval '30 days', 'manual', 'read billing fixture')
    `, [orgId])

    await client.query('COMMIT')
  }
  catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
  finally {
    client.release()
  }
})

afterAll(async () => {
  const client = await pool.connect()
  try {
    await client.query('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
    await client.query('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
    await client.query('DELETE FROM public.roles WHERE id = $1::uuid', [noBillingRoleId])
    await client.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [[
      memberWithDefaultId,
      memberWithoutBillingId,
    ]])
    await client.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [[
      memberWithDefaultId,
      memberWithoutBillingId,
    ]])
  }
  finally {
    client.release()
    await pool.end()
  }
})

describe('org.read_billing default + redaction', () => {
  it.concurrent('org_member default sees credit fields from get_orgs_v7', async () => {
    const rows = await withAuthenticatedUser(pool, memberWithDefaultId, async (client) => {
      const result = await client.query(`
        SELECT gid, credit_available, credit_total, paying, management_email
        FROM public.get_orgs_v7()
        WHERE gid = $1::uuid
      `, [orgId])
      return result.rows
    })

    expect(rows).toHaveLength(1)
    expect(Number(rows[0].credit_available)).toBe(200)
    expect(Number(rows[0].credit_total)).toBe(250)
    expect(rows[0].paying).toBe(true)
    expect(rows[0].management_email).toBeTruthy()
  })

  it.concurrent('member without org.read_billing gets billing fields redacted', async () => {
    const rows = await withAuthenticatedUser(pool, memberWithoutBillingId, async (client) => {
      const result = await client.query(`
        SELECT gid, credit_available, credit_total, paying, trial_left, can_use_more,
               is_canceled, subscription_start, subscription_end, management_email, is_yearly,
               credit_next_expiration
        FROM public.get_orgs_v7()
        WHERE gid = $1::uuid
      `, [orgId])
      return result.rows
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].credit_available).toBeNull()
    expect(rows[0].credit_total).toBeNull()
    expect(rows[0].credit_next_expiration).toBeNull()
    expect(rows[0].paying).toBe(false)
    expect(rows[0].trial_left).toBe(0)
    expect(rows[0].can_use_more).toBe(false)
    expect(rows[0].is_canceled).toBe(false)
    expect(rows[0].subscription_start).toBeNull()
    expect(rows[0].subscription_end).toBeNull()
    expect(rows[0].management_email).toBeNull()
    expect(rows[0].is_yearly).toBe(false)
  })

  it.concurrent('stripe_info is hidden without org.read_billing', async () => {
    const denied = await withAuthenticatedUser(pool, memberWithoutBillingId, async (client) => {
      const result = await client.query(`
        SELECT customer_id FROM public.stripe_info WHERE customer_id = $1
      `, [customerId])
      return result.rows
    })
    expect(denied).toEqual([])

    const allowed = await withAuthenticatedUser(pool, memberWithDefaultId, async (client) => {
      const result = await client.query(`
        SELECT customer_id, status FROM public.stripe_info WHERE customer_id = $1
      `, [customerId])
      return result.rows
    })
    expect(allowed).toHaveLength(1)
    expect(allowed[0].customer_id).toBe(customerId)
  })
})

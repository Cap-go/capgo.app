import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL, USER_ID, USER_PASSWORD_HASH, withAuthenticatedUser } from './test-utils.ts'

const fixtureId = randomUUID()
const orgId = randomUUID()
const appRbacId = randomUUID()
const appId = `com.test.readbilling.${fixtureId.slice(0, 8)}`
const customerId = `cus_read_billing_${fixtureId.replaceAll('-', '').slice(0, 20)}`
const memberWithDefaultId = randomUUID()
const memberWithoutBillingId = randomUUID()
const appOnlyBackfillId = randomUUID()
const alreadyHasBillingId = randomUUID()

let pool: Pool
let noBillingRoleId: string
let orgMemberRoleId: string
let billingReaderRoleId: string
let appReaderRoleId: string
let backfillGroupId: string

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
      SELECT
        MAX(id) FILTER (WHERE name = public.rbac_role_org_member()) AS org_member_id,
        MAX(id) FILTER (WHERE name = 'org_billing_reader') AS billing_reader_id,
        MAX(id) FILTER (WHERE name = public.rbac_role_app_reader()) AS app_reader_id
      FROM public.roles
    `)
    orgMemberRoleId = roles.rows[0]?.org_member_id
    billingReaderRoleId = roles.rows[0]?.billing_reader_id
    appReaderRoleId = roles.rows[0]?.app_reader_id
    expect(orgMemberRoleId).toBeTruthy()
    expect(billingReaderRoleId).toBeTruthy()
    expect(appReaderRoleId).toBeTruthy()

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

    await client.query(`
      INSERT INTO public.apps (id, app_id, name, icon_url, owner_org)
      VALUES ($1::uuid, $2, $3, 'https://example.com/icon.png', $4::uuid)
    `, [appRbacId, appId, `Read Billing App ${fixtureId}`, orgId])

    await createAuthUser(client, memberWithDefaultId, `read-billing-default-${fixtureId}@capgo.app`)
    await createAuthUser(client, memberWithoutBillingId, `read-billing-denied-${fixtureId}@capgo.app`)
    await createAuthUser(client, appOnlyBackfillId, `read-billing-app-only-${fixtureId}@capgo.app`)
    await createAuthUser(client, alreadyHasBillingId, `read-billing-already-${fixtureId}@capgo.app`)

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
        principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct
      )
      VALUES
        (public.rbac_principal_user(), $1::uuid, $2::uuid, public.rbac_scope_org(), $3::uuid, NULL, $4::uuid, 'default member', true),
        (public.rbac_principal_user(), $5::uuid, $6::uuid, public.rbac_scope_org(), $3::uuid, NULL, $4::uuid, 'no billing member', true),
        (public.rbac_principal_user(), $7::uuid, $8::uuid, public.rbac_scope_app(), $3::uuid, $9::uuid, $4::uuid, 'app only', true),
        (public.rbac_principal_user(), $10::uuid, $2::uuid, public.rbac_scope_org(), $3::uuid, NULL, $4::uuid, 'already has billing', true)
    `, [
      memberWithDefaultId,
      orgMemberRoleId,
      orgId,
      USER_ID,
      memberWithoutBillingId,
      noBillingRoleId,
      appOnlyBackfillId,
      appReaderRoleId,
      appRbacId,
      alreadyHasBillingId,
    ])

    // Simulate migration backfill for app-only users: system group + org_billing_reader.
    const group = await client.query(`
      INSERT INTO public.groups (org_id, name, description, is_system, created_by)
      VALUES (
        $1::uuid,
        '__capgo_billing_read_backfill',
        'Test backfill group',
        true,
        $2::uuid
      )
      RETURNING id
    `, [orgId, USER_ID])
    backfillGroupId = group.rows[0].id

    await client.query(`
      INSERT INTO public.role_bindings (
        principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct
      )
      VALUES (
        public.rbac_principal_group(), $1::uuid, $2::uuid, public.rbac_scope_org(), $3::uuid, $4::uuid,
        'test backfill', true
      )
    `, [backfillGroupId, billingReaderRoleId, orgId, USER_ID])

    await client.query(`
      INSERT INTO public.group_members (group_id, user_id, added_by)
      VALUES ($1::uuid, $2::uuid, $3::uuid)
    `, [backfillGroupId, appOnlyBackfillId, USER_ID])

    await client.query(`
      INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
      VALUES
        ($1::uuid, $2::uuid, public.rbac_role_org_member(), false),
        ($1::uuid, $3::uuid, public.rbac_role_org_member(), false),
        ($1::uuid, $4::uuid, public.rbac_role_org_member(), false)
    `, [orgId, memberWithDefaultId, memberWithoutBillingId, alreadyHasBillingId])

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
      appOnlyBackfillId,
      alreadyHasBillingId,
    ]])
    await client.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [[
      memberWithDefaultId,
      memberWithoutBillingId,
      appOnlyBackfillId,
      alreadyHasBillingId,
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
        SELECT gid, credit_available, credit_total, paying, management_email, role, next_stats_update_at
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
    expect(rows[0].role).toBe('org_member')
    expect(rows[0].next_stats_update_at).toBeTruthy()
  })

  it.concurrent('member without org.read_billing gets billing fields redacted', async () => {
    const rows = await withAuthenticatedUser(pool, memberWithoutBillingId, async (client) => {
      const result = await client.query(`
        SELECT gid, credit_available, credit_total, paying, trial_left, can_use_more,
               is_canceled, subscription_start, subscription_end, management_email, is_yearly,
               credit_next_expiration, next_stats_update_at, role, created_at, app_count
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
    expect(rows[0].next_stats_update_at).toBeNull()
    expect(rows[0].role).not.toBe('org_billing_reader')
    expect(rows[0].created_at).toBeTruthy()
    expect(Number(rows[0].app_count)).toBeGreaterThanOrEqual(1)
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

  it.concurrent('app-only backfill group keeps billing without exposing org_billing_reader role', async () => {
    const rows = await withAuthenticatedUser(pool, appOnlyBackfillId, async (client) => {
      const result = await client.query(`
        SELECT gid, credit_available, credit_total, paying, role
        FROM public.get_orgs_v7()
        WHERE gid = $1::uuid
      `, [orgId])
      return result.rows
    })

    expect(rows).toHaveLength(1)
    expect(Number(rows[0].credit_available)).toBe(200)
    expect(rows[0].paying).toBe(true)
    // Non-assignable backfill role must not replace the public role label.
    expect(rows[0].role).toBe('org_member')
    expect(rows[0].role).not.toBe('org_billing_reader')
  })

  it.concurrent('user who already has org.read_billing gets no duplicate org_billing_reader binding', async () => {
    const bindings = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM public.role_bindings rb
      JOIN public.roles r ON r.id = rb.role_id
      WHERE rb.principal_type = public.rbac_principal_user()
        AND rb.principal_id = $1::uuid
        AND rb.org_id = $2::uuid
        AND r.name = 'org_billing_reader'
    `, [alreadyHasBillingId, orgId])
    expect(bindings.rows[0].cnt).toBe(0)

    const groupMembership = await pool.query(`
      SELECT COUNT(*)::int AS cnt
      FROM public.group_members gm
      JOIN public.groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1::uuid
        AND g.org_id = $2::uuid
        AND g.name = '__capgo_billing_read_backfill'
    `, [alreadyHasBillingId, orgId])
    expect(groupMembership.rows[0].cnt).toBe(0)
  })
})

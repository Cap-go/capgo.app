import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL, TEST_EMAIL, USER_ID } from './test-utils.ts'

const pgPool = new Pool({ connectionString: POSTGRES_URL })

afterAll(async () => {
  await pgPool.end()
})

describe('cleanup_expired_mcp_webhooks', () => {
  it.concurrent('keeps execute privilege only for service-role callers', async () => {
    const { rows } = await pgPool.query<{
      service_role_can_execute: boolean
      anon_can_execute: boolean
      authenticated_can_execute: boolean
      public_can_execute: boolean
    }>(`
      SELECT
        has_function_privilege('service_role', 'public.cleanup_expired_mcp_webhooks()', 'EXECUTE') AS service_role_can_execute,
        has_function_privilege('anon', 'public.cleanup_expired_mcp_webhooks()', 'EXECUTE') AS anon_can_execute,
        has_function_privilege('authenticated', 'public.cleanup_expired_mcp_webhooks()', 'EXECUTE') AS authenticated_can_execute,
        has_function_privilege('public', 'public.cleanup_expired_mcp_webhooks()', 'EXECUTE') AS public_can_execute
    `)

    expect(rows).toEqual([{
      service_role_can_execute: true,
      anon_can_execute: false,
      authenticated_can_execute: false,
      public_can_execute: false,
    }])
  })

  it.concurrent('deletes only expired MCP rows and enforces webhooks_source_check', async () => {
    const orgId = randomUUID()
    const expiredId = randomUUID()
    const activeId = randomUUID()
    const customerId = `cus_mcp_cleanup_${randomUUID().replace(/-/g, '').slice(0, 16)}`

    await pgPool.query(
      `INSERT INTO public.stripe_info (customer_id, status, product_id, subscription_id, trial_at, is_good_plan)
       VALUES ($1, 'succeeded', 'prod_LQIregjtNduh4q', $2, now() + interval '30 days', true)`,
      [customerId, `sub_${randomUUID()}`],
    )
    await pgPool.query(
      `INSERT INTO public.orgs (id, name, management_email, created_by, customer_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, 'MCP cleanup org', TEST_EMAIL, USER_ID, customerId],
    )

    await pgPool.query(
      `INSERT INTO public.webhooks (
         id, org_id, name, url, secret, enabled, events, created_by, delivery_version,
         source, expires_at, mcp_event, mcp_arguments, mcp_verified_at
       ) VALUES
         ($1, $3, 'expired mcp', 'https://example.com/expired', 'secret', true, ARRAY['bundle.uploaded']::text[], $4, 'standard',
          'mcp', now() - interval '1 hour', 'bundle.uploaded', '{}'::jsonb, now()),
         ($2, $3, 'active mcp', 'https://example.com/active', 'secret', true, ARRAY['bundle.uploaded']::text[], $4, 'standard',
          'mcp', now() + interval '1 day', 'bundle.uploaded', '{}'::jsonb, now())`,
      [expiredId, activeId, orgId, USER_ID],
    )

    await expect(pgPool.query(
      `INSERT INTO public.webhooks (org_id, name, url, secret, enabled, events, created_by, source)
       VALUES ($1, 'bad source', 'https://example.com/bad', 'secret', true, ARRAY['app_versions']::text[], $2, 'agent')`,
      [orgId, USER_ID],
    )).rejects.toThrow()

    await pgPool.query(`SELECT public.cleanup_expired_mcp_webhooks()`)

    const { rows } = await pgPool.query<{ id: string }>(
      `SELECT id FROM public.webhooks WHERE id = ANY($1::uuid[])`,
      [[expiredId, activeId]],
    )
    expect(rows.map(row => row.id).sort()).toEqual([activeId])
  })
})

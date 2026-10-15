import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { executeSQL } from './test-utils.ts'

describe('canceled org retention cleanup', () => {
  const userId = '6aa76066-55ef-4238-ade6-0b32334a4097'

  async function cleanupRetentionFixture(orgId: string, customerId: string) {
    await executeSQL(
      `DELETE FROM pgmq.q_canceled_org_retention_alerts
       WHERE message -> 'payload' ->> 'org_id' = $1`,
      [orgId],
    ).catch(() => undefined)
    await executeSQL('DELETE FROM public.notifications WHERE owner_org = $1::uuid', [orgId])
    await executeSQL('DELETE FROM public.old_apps WHERE owner_org = $1::uuid', [orgId])
    await executeSQL('DELETE FROM public.apps WHERE owner_org = $1::uuid', [orgId])
    await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
  }

  it('extends the retention anchor from recent app activity and blocks delete without warning', async () => {
    const orgId = randomUUID()
    const customerId = `cus_retention_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const appId = `com.test.retention.${randomUUID().replace(/-/g, '').slice(0, 12)}`
    await executeSQL(
      `INSERT INTO public.stripe_info (
        customer_id, status, product_id, trial_at, is_good_plan,
        subscription_anchor_start, subscription_anchor_end, canceled_at
      ) VALUES (
        $1, 'canceled', 'prod_LQIregjtNduh4q', now() - interval '300 days', false,
        now() - interval '300 days', now() - interval '200 days', now() - interval '200 days'
      )`,
      [customerId],
    )
    await executeSQL(
      `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id, has_usage_credits)
       VALUES ($1::uuid, $2::uuid, 'Retention Test Org', 'retention@example.com', $3, false)`,
      [orgId, userId, customerId],
    )
    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, owner_org, name, user_id, created_at)
       VALUES ($1, '', $2::uuid, 'Retention App', $3::uuid, now() - interval '30 days')`,
      [appId, orgId, userId],
    )

    const anchor = await executeSQL<{ anchor: string }>(
      'SELECT public.canceled_org_retention_anchor($1::uuid) AS anchor',
      [orgId],
    )
    expect(new Date(anchor[0]!.anchor).getTime()).toBeGreaterThan(Date.now() - 35 * 86400 * 1000)

    const pastGrace = await executeSQL<{ org_id: string }>(
      `SELECT grace.org_id
       FROM public.canceled_org_ids_past_grace(95) AS grace(org_id)
       WHERE grace.org_id = $1::uuid`,
      [orgId],
    )
    expect(pastGrace).toHaveLength(0)

    const deleted = await executeSQL<{ delete_apps_for_long_canceled_orgs: string }>(
      'SELECT public.delete_apps_for_long_canceled_orgs(10)',
    )
    expect(Number(deleted[0]?.delete_apps_for_long_canceled_orgs ?? 0)).toBe(0)

    const appsLeft = await executeSQL<{ app_id: string }>(
      'SELECT app_id FROM public.apps WHERE owner_org = $1::uuid',
      [orgId],
    )
    expect(appsLeft).toHaveLength(1)

    await cleanupRetentionFixture(orgId, customerId)
  })

  it('queues app-deletion warnings past the old 5-day window and requires notification lead time', async () => {
    const orgId = randomUUID()
    const customerId = `cus_retention_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const appId = `com.test.retention.${randomUUID().replace(/-/g, '').slice(0, 12)}`
    await executeSQL(
      `INSERT INTO public.stripe_info (
        customer_id, status, product_id, trial_at, is_good_plan,
        subscription_anchor_start, subscription_anchor_end, canceled_at
      ) VALUES (
        $1, 'canceled', 'prod_LQIregjtNduh4q', now() - interval '300 days', false,
        now() - interval '300 days', now() - interval '120 days', now() - interval '120 days'
      )`,
      [customerId],
    )
    await executeSQL(
      `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id, has_usage_credits)
       VALUES ($1::uuid, $2::uuid, 'Retention Ultra Org', 'retention-ultra@example.com', $3, false)`,
      [orgId, userId, customerId],
    )
    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, owner_org, name, user_id)
       VALUES ($1, '', $2::uuid, 'Retention Ultra App', $3::uuid)`,
      [appId, orgId, userId],
    )

    const queued = await executeSQL<{ queue_canceled_org_retention_alerts: string }>(
      `SELECT public.queue_canceled_org_retention_alerts('app_deletion_warning', 90, 10)`,
    )
    expect(Number(queued[0]?.queue_canceled_org_retention_alerts ?? 0)).toBe(1)

    const withoutWarning = await executeSQL<{ delete_apps_for_long_canceled_orgs: string }>(
      'SELECT public.delete_apps_for_long_canceled_orgs(10)',
    )
    expect(Number(withoutWarning[0]?.delete_apps_for_long_canceled_orgs ?? 0)).toBe(0)

    await executeSQL(
      `INSERT INTO public.notifications (owner_org, event, uniq_id, created_at, last_send_at)
       VALUES (
         $1::uuid,
         'org:apps_will_be_deleted',
         public.canceled_org_retention_uniq_id($1::uuid, 'app_deletion_warning'),
         now() - interval '10 days',
         now() - interval '10 days'
       )`,
      [orgId],
    )

    const meetsLead = await executeSQL<{ ok: boolean }>(
      `SELECT public.canceled_org_retention_warning_meets_lead_time($1::uuid, 'app_deletion_warning', 5) AS ok`,
      [orgId],
    )
    expect(meetsLead[0]?.ok).toBe(true)

    const deleted = await executeSQL<{ delete_apps_for_long_canceled_orgs: string }>(
      'SELECT public.delete_apps_for_long_canceled_orgs(10)',
    )
    expect(Number(deleted[0]?.delete_apps_for_long_canceled_orgs ?? 0)).toBe(1)

    await cleanupRetentionFixture(orgId, customerId)
  })
})

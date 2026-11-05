import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { executeSQL } from './test-utils.ts'

const USER_ID = '6aa76066-55ef-4238-ade6-0b32334a4097'
const PRODUCT_ID = 'prod_LQIregjtNduh4q'

interface RetentionFixture {
  appId: string
  customerId: string
  orgId: string
}

async function createCanceledOrg(canceledDaysAgo: number, appCreatedDaysAgo: number): Promise<RetentionFixture> {
  const suffix = randomUUID().replace(/-/g, '')
  const fixture = {
    appId: `com.test.retention.${suffix.slice(0, 12)}`,
    customerId: `cus_retention_${suffix.slice(0, 16)}`,
    orgId: randomUUID(),
  }
  await executeSQL(
    `INSERT INTO public.stripe_info (
      customer_id, status, product_id, trial_at, is_good_plan,
      subscription_anchor_start, subscription_anchor_end, canceled_at
    ) VALUES (
      $1, 'canceled', $2, now() - interval '300 days', false,
      now() - interval '300 days', now() - make_interval(days => $3), now() - make_interval(days => $3)
    )`,
    [fixture.customerId, PRODUCT_ID, canceledDaysAgo],
  )
  await executeSQL(
    `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id, has_usage_credits)
     VALUES ($1::uuid, $2::uuid, 'Retention Test Org', 'retention@example.com', $3, false)`,
    [fixture.orgId, USER_ID, fixture.customerId],
  )
  await executeSQL(
    `INSERT INTO public.apps (app_id, icon_url, owner_org, name, user_id, created_at)
     VALUES ($1, '', $2::uuid, 'Retention App', $3::uuid, now() - make_interval(days => $4))`,
    [fixture.appId, fixture.orgId, USER_ID, appCreatedDaysAgo],
  )
  return fixture
}

async function cleanupFixture({ orgId, customerId }: RetentionFixture) {
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

async function insertAppWarning(orgId: string, suffix: string, daysAgo: number) {
  await executeSQL(
    `INSERT INTO public.notifications (owner_org, event, uniq_id, created_at, last_send_at)
     VALUES (
       $1::uuid,
       'org:apps_will_be_deleted',
       public.canceled_org_retention_uniq_id($1::uuid, 'app_deletion_warning') || $2,
       now() - make_interval(days => $3),
       now() - make_interval(days => $3)
     )`,
    [orgId, suffix, daysAgo],
  )
}

async function appWarningMeetsLeadTime(orgId: string) {
  const rows = await executeSQL<{ ok: boolean }>(
    `SELECT public.canceled_org_retention_warning_meets_lead_time($1::uuid, 'app_deletion_warning', 5) AS ok`,
    [orgId],
  )
  return rows[0]?.ok
}

async function appExists(appId: string) {
  const rows = await executeSQL<{ app_id: string }>('SELECT app_id FROM public.apps WHERE app_id = $1', [appId])
  return rows.length === 1
}

describe('canceled org retention cleanup', () => {
  it('extends the retention anchor from recent app activity and keeps the app', async () => {
    const fixture = await createCanceledOrg(200, 30)
    try {
      const anchor = await executeSQL<{ anchor: string }>(
        'SELECT public.canceled_org_retention_anchor($1::uuid) AS anchor',
        [fixture.orgId],
      )
      expect(new Date(anchor[0]!.anchor).getTime()).toBeGreaterThan(Date.now() - 35 * 86400 * 1000)

      const pastGrace = await executeSQL<{ org_id: string }>(
        `SELECT grace.org_id
         FROM public.canceled_org_ids_past_grace(95) AS grace(org_id)
         WHERE grace.org_id = $1::uuid`,
        [fixture.orgId],
      )
      expect(pastGrace).toHaveLength(0)

      await executeSQL('SELECT public.delete_apps_for_long_canceled_orgs(10)')
      expect(await appExists(fixture.appId)).toBe(true)
    }
    finally {
      await cleanupFixture(fixture)
    }
  })

  it('queues a catch-up app warning and deletes only after a delivered warning is 5 days old', async () => {
    const fixture = await createCanceledOrg(120, 150)
    try {
      await executeSQL(`SELECT public.queue_canceled_org_retention_alerts('app_deletion_warning', 90, 500)`)
      const queued = await executeSQL<{ days_until_deletion: number }>(
        `SELECT (message -> 'payload' ->> 'days_until_deletion')::int AS days_until_deletion
         FROM pgmq.q_canceled_org_retention_alerts
         WHERE message -> 'payload' ->> 'org_id' = $1
           AND message -> 'payload' ->> 'alert_type' = 'app_deletion_warning'`,
        [fixture.orgId],
      )
      expect(queued).toHaveLength(1)
      // Past day 95 already, but deletion still waits for the 5-day lead time.
      expect(queued[0]!.days_until_deletion).toBe(5)

      await executeSQL('SELECT public.delete_apps_for_long_canceled_orgs(500)')
      expect(await appExists(fixture.appId)).toBe(true)

      // No-recipient claims and a bare recipient claim (the send may have
      // failed) are not delivered warnings.
      await insertAppWarning(fixture.orgId, ':no_recipients', 10)
      await insertAppWarning(fixture.orgId, ':recipienthash', 10)
      expect(await appWarningMeetsLeadTime(fixture.orgId)).toBe(false)

      await insertAppWarning(fixture.orgId, ':recipienthash:delivered', 10)
      expect(await appWarningMeetsLeadTime(fixture.orgId)).toBe(true)

      await executeSQL('SELECT public.delete_apps_for_long_canceled_orgs(500)')
      expect(await appExists(fixture.appId)).toBe(false)
      const archived = await executeSQL<{ app_id: string }>(
        'SELECT app_id FROM public.old_apps WHERE app_id = $1 AND owner_org = $2::uuid',
        [fixture.appId, fixture.orgId],
      )
      expect(archived).toHaveLength(1)
    }
    finally {
      await cleanupFixture(fixture)
    }
  })
})

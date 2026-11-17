import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, executeSQL, USER_ID } from './test-utils.ts'

// Storage is billed in GB-hours per org. When an app moves from org A to org B between two stats
// refreshes, A must still be billed for its hours up to the transfer and B only from it.

const HOUR_MS = 60 * 60 * 1000
const BUNDLE_SIZE = 1_000_000
const testId = randomUUID().slice(0, 8)
const appId = `com.storage.transfer.${testId}`
const formerOrg = randomUUID()
const newOrg = randomUUID()
const versionId = 900_000_000 + Math.floor(Math.random() * 1_000_000)

const now = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS)
const addedAt = new Date(now.getTime() - 6 * HOUR_MS)
const transferredAt = new Date(now.getTime() - 3 * HOUR_MS)

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

async function byteHoursByOrg() {
  const rows = await executeSQL<{ owner_org: string, byte_hours: number }>(
    `SELECT owner_org, SUM(storage_byte_hours)::double precision AS byte_hours
     FROM public.daily_storage_hourly
     WHERE app_id = $1
     GROUP BY owner_org`,
    [appId],
  )
  return new Map(rows.map(row => [row.owner_org, Number(row.byte_hours)]))
}

describe('storage byte-hours across an app transfer', () => {
  beforeAll(async () => {
    for (const [orgId, label] of [[formerOrg, 'former'], [newOrg, 'new']] as const) {
      await executeSQL(
        `INSERT INTO public.orgs (id, created_by, name, management_email) VALUES ($1::uuid, $2::uuid, $3, $4)`,
        [orgId, USER_ID, `Storage transfer ${label} ${testId}`, `storage-transfer-${label}-${testId}@capgo.app`],
      )
    }
    // The app was created by the former org, then transferred to the new org.
    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id, created_at, transfer_history)
       VALUES ($1, '', $1, $2::uuid, $3::uuid, $4::timestamptz, ARRAY[pg_catalog.jsonb_build_object(
         'transferred_at', $5::text,
         'transferred_from', $6::text,
         'transferred_to', $2::text
       )])`,
      [appId, newOrg, USER_ID, new Date(now.getTime() - 24 * HOUR_MS).toISOString(), transferredAt.toISOString(), formerOrg],
    )
    // One bundle stored since before the transfer, never deleted.
    await executeSQL(
      `INSERT INTO public.version_meta (timestamp, app_id, version_id, size) VALUES ($1::timestamptz, $2, $3, $4)`,
      [addedAt.toISOString(), appId, versionId, BUNDLE_SIZE],
    )
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.daily_storage_hourly WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.version_meta WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.app_stats_refresh_state WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [[formerOrg, newOrg]])
  })

  it('bills the former owner up to the transfer and the new owner after it', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ appId, orgId: newOrg, currentHour: now.toISOString() }),
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const byOrg = await byteHoursByOrg()
    // 3 hours on each side of the transfer, whatever billing cycles they fall in.
    expect(byOrg.get(formerOrg)).toBeCloseTo(BUNDLE_SIZE * 3, 0)
    expect(byOrg.get(newOrg)).toBeCloseTo(BUNDLE_SIZE * 3, 0)
  }, 60_000)

  it('keeps both orgs\' hours on a later refresh', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ appId, orgId: newOrg, currentHour: new Date(now.getTime() + HOUR_MS).toISOString() }),
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const byOrg = await byteHoursByOrg()
    expect(byOrg.get(formerOrg)).toBeCloseTo(BUNDLE_SIZE * 3, 0)
    expect(byOrg.get(newOrg)).toBeCloseTo(BUNDLE_SIZE * 4, 0)
  }, 60_000)
})

// An idle app transferred long before its next refresh: the former owner already has rows from
// its last refresh before the transfer, and the new owner's first refresh comes 10 days later.
describe('storage byte-hours when the first refresh after a transfer is late', () => {
  const lateAppId = `com.storage.transfer.late.${testId}`
  const lateFormerOrg = randomUUID()
  const lateNewOrg = randomUUID()
  const lateVersionId = versionId + 1
  const lateAddedAt = new Date(now.getTime() - 15 * 24 * HOUR_MS)
  const lateTransferredAt = new Date(now.getTime() - 10 * 24 * HOUR_MS)

  beforeAll(async () => {
    for (const [orgId, label] of [[lateFormerOrg, 'late-former'], [lateNewOrg, 'late-new']] as const) {
      await executeSQL(
        `INSERT INTO public.orgs (id, created_by, name, management_email) VALUES ($1::uuid, $2::uuid, $3, $4)`,
        [orgId, USER_ID, `Storage transfer ${label} ${testId}`, `storage-transfer-${label}-${testId}@capgo.app`],
      )
    }
    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id, created_at, transfer_history)
       VALUES ($1, '', $1, $2::uuid, $3::uuid, $4::timestamptz, ARRAY[pg_catalog.jsonb_build_object(
         'transferred_at', $5::text,
         'transferred_from', $6::text,
         'transferred_to', $2::text
       )])`,
      [lateAppId, lateNewOrg, USER_ID, new Date(now.getTime() - 20 * 24 * HOUR_MS).toISOString(), lateTransferredAt.toISOString(), lateFormerOrg],
    )
    await executeSQL(
      `INSERT INTO public.version_meta (timestamp, app_id, version_id, size) VALUES ($1::timestamptz, $2, $3, $4)`,
      [lateAddedAt.toISOString(), lateAppId, lateVersionId, BUNDLE_SIZE],
    )
    // The former owner's last refresh ran one day after the upload, before the transfer.
    await executeSQL(
      `INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, storage_byte_hours, updated_at)
       VALUES ($1, $2::uuid, $3::date, $3::date, $4, $5::timestamptz)`,
      [lateAppId, lateFormerOrg, lateAddedAt.toISOString().slice(0, 10), BUNDLE_SIZE * 24, new Date(lateAddedAt.getTime() + 24 * HOUR_MS).toISOString()],
    )
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.daily_storage_hourly WHERE app_id = $1', [lateAppId])
    await executeSQL('DELETE FROM public.daily_storage_hourly_refreshes WHERE app_id = $1', [lateAppId])
    await executeSQL('DELETE FROM public.version_meta WHERE app_id = $1', [lateAppId])
    await executeSQL('DELETE FROM public.app_stats_refresh_state WHERE app_id = $1', [lateAppId])
    await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [lateAppId])
    await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [[lateFormerOrg, lateNewOrg]])
  })

  it('records the former owner up to the transfer on a refresh 10 days later', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ appId: lateAppId, orgId: lateNewOrg, currentHour: now.toISOString() }),
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const rows = await executeSQL<{ owner_org: string, byte_hours: number }>(
      `SELECT owner_org, SUM(storage_byte_hours)::double precision AS byte_hours
       FROM public.daily_storage_hourly
       WHERE app_id = $1
       GROUP BY owner_org`,
      [lateAppId],
    )
    const byOrg = new Map(rows.map(row => [row.owner_org, Number(row.byte_hours)]))
    // Upload to transfer: 5 days, replacing the 1 day the former owner's last refresh recorded.
    expect(byOrg.get(lateFormerOrg)).toBeCloseTo(BUNDLE_SIZE * 5 * 24, 0)
    expect(byOrg.get(lateNewOrg) ?? 0).toBeGreaterThan(0)
  }, 60_000)
})

// A bundle removed shortly before a rollover whose removal is recorded only after the first refresh
// of the new cycle already finalized the previous one: the late event, dated inside that cycle,
// must reopen it.
describe('storage byte-hours when a removal is recorded after its cycle was finalized', () => {
  const lateRemovalAppId = `com.storage.lateremoval.${testId}`
  const lateRemovalOrg = randomUUID()
  const lateRemovalVersionId = versionId + 2

  async function previousCycle() {
    const [cycle] = await executeSQL<{ cycle_start: string, cycle_end: string, cycle_day: string }>(
      `SELECT previous.cycle_start::text, previous.cycle_end::text, (previous.cycle_start AT TIME ZONE 'UTC')::date::text AS cycle_day
       FROM public.orgs o
       LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
       CROSS JOIN LATERAL public.billing_cycle_for_anchor(si.subscription_anchor_start, si.subscription_anchor_end, pg_catalog.now()) AS current_cycle
       CROSS JOIN LATERAL public.billing_cycle_for_anchor(si.subscription_anchor_start, si.subscription_anchor_end, current_cycle.cycle_start - interval '1 second') AS previous
       WHERE o.id = $1::uuid`,
      [lateRemovalOrg],
    )
    return cycle
  }

  async function refresh() {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ appId: lateRemovalAppId, orgId: lateRemovalOrg }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
  }

  beforeAll(async () => {
    await executeSQL(
      `INSERT INTO public.orgs (id, created_by, name, management_email) VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [lateRemovalOrg, USER_ID, `Storage late removal ${testId}`, `storage-late-removal-${testId}@capgo.app`],
    )
    await executeSQL(
      `INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id, created_at)
       VALUES ($1, '', $1, $2::uuid, $3::uuid, pg_catalog.now() - interval '120 days')`,
      [lateRemovalAppId, lateRemovalOrg, USER_ID],
    )
    await executeSQL(
      `INSERT INTO public.version_meta (timestamp, app_id, version_id, size)
       VALUES (pg_catalog.timezone('UTC', pg_catalog.now() - interval '100 days'), $1, $2, $3)`,
      [lateRemovalAppId, lateRemovalVersionId, BUNDLE_SIZE],
    )
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.daily_storage_hourly WHERE app_id = $1', [lateRemovalAppId])
    await executeSQL('DELETE FROM public.daily_storage_hourly_refreshes WHERE app_id = $1', [lateRemovalAppId])
    await executeSQL('DELETE FROM public.version_meta WHERE app_id = $1', [lateRemovalAppId])
    await executeSQL('DELETE FROM public.app_stats_refresh_state WHERE app_id = $1', [lateRemovalAppId])
    await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [lateRemovalAppId])
    await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [lateRemovalOrg])
  })

  it('recomputes the finalized previous cycle from the late removal', async () => {
    const cycle = await previousCycle()
    // The first refresh of this cycle finalizes the previous one with the bundle still stored.
    await refresh()
    const byteHoursOfCycle = async () => {
      const [row] = await executeSQL<{ byte_hours: number }>(
        `SELECT COALESCE(SUM(storage_byte_hours), 0)::double precision AS byte_hours
         FROM public.daily_storage_hourly
         WHERE app_id = $1 AND owner_org = $2::uuid AND cycle_start = $3::date`,
        [lateRemovalAppId, lateRemovalOrg, cycle.cycle_day],
      )
      return Number(row.byte_hours)
    }
    const cycleHours = (Date.parse(cycle.cycle_end) - Date.parse(cycle.cycle_start)) / HOUR_MS
    expect(await byteHoursOfCycle()).toBeCloseTo(BUNDLE_SIZE * cycleHours, -3)

    // The removal happened one day into that cycle, but its event is only recorded now.
    await executeSQL(
      `INSERT INTO public.version_meta (timestamp, app_id, version_id, size)
       VALUES (pg_catalog.timezone('UTC', $3::timestamptz + interval '1 day'), $1, $2, $4)`,
      [lateRemovalAppId, lateRemovalVersionId, cycle.cycle_start, -BUNDLE_SIZE],
    )
    await refresh()
    expect(await byteHoursOfCycle()).toBeCloseTo(BUNDLE_SIZE * 24, -3)
  }, 60_000)
})

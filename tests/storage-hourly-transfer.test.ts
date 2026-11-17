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

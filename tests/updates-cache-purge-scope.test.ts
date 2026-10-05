import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPostgresClient, resetAndSeedAppData, resetAppData } from './test-utils.ts'

/**
 * Purge scopes of the plugin edge cache queue (updates_cache_purge_pending):
 * bundle-name lookups (versions tag) are purged on any app_versions identity
 * change, the app's main tag keeps its channel-served gate. Every scenario
 * runs in its own rolled-back transaction with the Vault switch on.
 */

const APP_ID = `com.test.edgecachescope.${randomUUID().slice(0, 8)}`
let client: PoolClient

/** Sets the Vault switch inside the current transaction (it may already exist locally). */
async function setPurgeSwitch(value: 'true' | 'false') {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM vault.secrets WHERE name = 'CAPGO_UPDATES_CACHE_PURGE_ENABLED'`)
  if (rows[0])
    await client.query('SELECT vault.update_secret($1, $2)', [rows[0].id, value])
  else
    await client.query(`SELECT vault.create_secret($1, 'CAPGO_UPDATES_CACHE_PURGE_ENABLED', 'purge scope test')`, [value])
}

async function inTransaction(run: () => Promise<void>, purgeSwitch: 'true' | 'false' = 'true') {
  await client.query('BEGIN')
  try {
    await setPurgeSwitch(purgeSwitch)
    await run()
  }
  finally {
    await client.query('ROLLBACK')
  }
}

async function pending() {
  const { rows } = await client.query<{ scope: string, initial: boolean }>(
    'SELECT scope, initial FROM public.updates_cache_purge_pending WHERE app_id = $1 ORDER BY id',
    [APP_ID],
  )
  return rows.map(row => row.scope)
}

async function clearPending() {
  await client.query('DELETE FROM public.updates_cache_purge_pending WHERE app_id = $1', [APP_ID])
}

async function insertBundle(name: string) {
  await client.query(
    `INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider)
     SELECT app_id, $2, owner_org, 'r2-direct' FROM public.apps WHERE app_id = $1`,
    [APP_ID, name],
  )
}

describe('updates cache purge scopes', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
    client = await (await getPostgresClient()).connect()
  })

  afterAll(async () => {
    client?.release()
    await resetAppData(APP_ID)
  })

  it('queues only the versions scope for a new, renamed, soft-deleted or deleted unserved bundle', async () => {
    await inTransaction(async () => {
      await clearPending()
      await insertBundle('9.9.9-scope')
      expect(await pending()).toEqual(['versions'])

      await clearPending()
      // Metadata of an unserved bundle changes no cached read.
      await client.query(`UPDATE public.app_versions SET comment = 'note', link = 'https://example.com' WHERE app_id = $1 AND name = '9.9.9-scope'`, [APP_ID])
      expect(await pending()).toEqual([])

      await client.query(`UPDATE public.app_versions SET name = '9.9.9-scope-b' WHERE app_id = $1 AND name = '9.9.9-scope'`, [APP_ID])
      expect(await pending()).toEqual(['versions'])

      await clearPending()
      await client.query(`UPDATE public.app_versions SET deleted = true WHERE app_id = $1 AND name = '9.9.9-scope-b'`, [APP_ID])
      expect(await pending()).toEqual(['versions'])

      await clearPending()
      await client.query(`DELETE FROM public.app_versions WHERE app_id = $1 AND name = '9.9.9-scope-b'`, [APP_ID])
      expect(await pending()).toEqual(['versions'])
    })
  })

  it('keeps the main tag for served bundles and channel changes', async () => {
    await inTransaction(async () => {
      await clearPending()
      await client.query(
        `UPDATE public.app_versions SET comment = 'release note'
         WHERE id = (SELECT version FROM public.channels WHERE app_id = $1 AND name = 'production')`,
        [APP_ID],
      )
      expect(await pending()).toEqual(['app'])

      await clearPending()
      await client.query(`UPDATE public.channels SET allow_device_self_set = NOT allow_device_self_set WHERE app_id = $1 AND name = 'production'`, [APP_ID])
      expect(await pending()).toEqual(['app'])

      // Channel pause (20261002150000) stays in the compared columns.
      await clearPending()
      await client.query(`UPDATE public.channels SET paused_at = now() WHERE app_id = $1 AND name = 'production'`, [APP_ID])
      expect(await pending()).toEqual(['app'])
    })
  })

  it('claims one entry per (app, scope) and re-purges each scope', async () => {
    await inTransaction(async () => {
      // Claims are global: start from an empty, unthrottled queue in this transaction.
      await client.query('DELETE FROM public.updates_cache_purge_pending')
      await client.query(`UPDATE public.updates_cache_purge_state SET last_claim_at = '-infinity'`)
      await insertBundle('9.9.8-scope')
      await insertBundle('9.9.7-scope')
      await client.query(`UPDATE public.channels SET allow_emulator = NOT allow_emulator WHERE app_id = $1 AND name = 'production'`, [APP_ID])

      const { rows: [{ claim }] } = await client.query<{ claim: { status: string, lease_token: string, apps: { app_id: string, scope: string, initial: boolean }[] } }>(
        'SELECT public.claim_updates_cache_purge(100) AS claim',
      )
      expect(claim.status).toBe('ok')
      expect(claim.apps.filter(app => app.app_id === APP_ID).map(app => app.scope).sort()).toEqual(['app', 'versions'])

      await client.query('SELECT public.ack_updates_cache_purge($1, true, 5)', [claim.lease_token])
      const { rows } = await client.query<{ scope: string, initial: boolean, delay: number }>(
        `SELECT scope, initial, extract(epoch FROM due_at - clock_timestamp())::float8 AS delay
         FROM public.updates_cache_purge_pending WHERE app_id = $1 ORDER BY scope, due_at`,
        [APP_ID],
      )
      expect(rows.map(row => [row.scope, row.initial])).toEqual([
        ['app', false],
        ['app', false],
        ['app', false],
        ['app', false],
        ['versions', false],
        ['versions', false],
        ['versions', false],
        ['versions', false],
      ])
      // Re-purges are scheduled +3s / +10s / +60s / +180s from the ack; allow for test latency.
      const expected = [3, 10, 60, 180, 3, 10, 60, 180]
      rows.forEach((row, index) => {
        expect(row.delay).toBeLessThanOrEqual(expected[index])
        expect(row.delay).toBeGreaterThan(expected[index] - 5)
      })
    })
  })

  it('queues per-zone rows on their slot and claims them apart from every-zone rows', async () => {
    const fastZone = 'a'.repeat(32)
    const slowZone = 'b'.repeat(32)
    await inTransaction(async () => {
      await client.query('DELETE FROM public.updates_cache_purge_pending')
      await client.query(`UPDATE public.updates_cache_purge_state SET last_claim_at = '-infinity'`)
      await client.query(`UPDATE public.channels SET allow_emulator = NOT allow_emulator WHERE app_id = $1 AND name = 'production'`, [APP_ID])

      const { rows: [{ claim }] } = await client.query<{ claim: { lease_token: string, apps: { app_id: string, zone_id: string | null }[] } }>(
        'SELECT public.claim_updates_cache_purge(100) AS claim',
      )
      expect(claim.apps).toEqual([{ app_id: APP_ID, scope: 'app', zone_id: null, initial: true }])

      await client.query('SELECT public.ack_updates_cache_purge($1, true, 5, $2::jsonb)', [claim.lease_token, JSON.stringify([
        // Slow zone deferral: due on the next 15s slot.
        { app_id: APP_ID, scope: 'app', zone_id: slowZone, delay_seconds: 0, slot_seconds: 15 },
        // Failed fast zone call: due after its Retry-After.
        { app_id: APP_ID, scope: 'app', zone_id: fastZone, delay_seconds: 7, slot_seconds: 0 },
        // Invalid rows are ignored.
        { app_id: APP_ID, scope: 'app', zone_id: 'not-a-zone', delay_seconds: 0, slot_seconds: 0 },
        { app_id: APP_ID, scope: 'bogus', zone_id: fastZone, delay_seconds: 0, slot_seconds: 0 },
      ])])

      const { rows } = await client.query<{ zone_id: string, delay: number, slot_aligned: boolean }>(
        `SELECT zone_id, extract(epoch FROM due_at - clock_timestamp())::float8 AS delay,
                extract(epoch FROM due_at)::numeric % 15 = 0 AS slot_aligned
         FROM public.updates_cache_purge_pending WHERE app_id = $1 AND zone_id IS NOT NULL ORDER BY zone_id`,
        [APP_ID],
      )
      expect(rows.map(row => row.zone_id)).toEqual([fastZone, slowZone])
      expect(rows[0].delay).toBeGreaterThan(2)
      expect(rows[0].delay).toBeLessThanOrEqual(7)
      expect(rows[1].slot_aligned).toBe(true)
      expect(rows[1].delay).toBeLessThanOrEqual(15)

      // Due zone rows are claimed per zone, next to the every-zone rows.
      await client.query(`UPDATE public.updates_cache_purge_pending SET due_at = clock_timestamp() - interval '1 second' WHERE app_id = $1`, [APP_ID])
      await client.query(`UPDATE public.updates_cache_purge_state SET last_claim_at = '-infinity'`)
      const { rows: [{ claim: next }] } = await client.query<{ claim: { apps: { app_id: string, zone_id: string | null }[] } }>(
        'SELECT public.claim_updates_cache_purge(100) AS claim',
      )
      expect(next.apps.map(app => app.zone_id).sort()).toEqual([fastZone, slowZone, null].sort())
    })
  })

  it('queues nothing while the Vault switch is off', async () => {
    await inTransaction(async () => {
      await clearPending()
      await insertBundle('9.9.6-scope')
      expect(await pending()).toEqual([])
    }, 'false')
  })
})

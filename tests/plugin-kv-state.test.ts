import type { PluginStateFixture } from '../scripts/benchmark-plugin-state.ts'
import { setTimeout } from 'node:timers/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  comparePluginState,
  comparePluginStateChannelSequence,
  createPluginStateFixture,
  evictPluginStateCache,
  measurePluginStatePropagation,
  probePluginState,
  syncPluginState,
} from '../scripts/benchmark-plugin-state.ts'
import { API_SECRET, CLOUDFLARE_API_URL, createAppVersions, executeSQL, insertManifestRows } from './test-utils.ts'

describe.skipIf(process.env.PLUGIN_STATE_KV_TESTS !== 'true')('KV and replica plugin response parity', () => {
  let fixture: PluginStateFixture

  beforeAll(async () => {
    fixture = await createPluginStateFixture()
    await syncPluginState([fixture.appId])
  }, 120_000)

  beforeEach(async () => {
    // Each mutation test starts from the same published channel, independently
    // of a previous propagation/rollout test or an assertion failure.
    fixture.base.device_id = crypto.randomUUID()
    await executeSQL(`UPDATE public.channels SET version = $2::bigint, update_package = 'all',
      rollout_enabled = false, rollout_version = NULL, rollout_percentage_bps = 0,
      rollout_paused_at = NULL, ios = true, android = true, allow_device_self_set = true
      WHERE app_id = $1 AND name = 'production'`, [fixture.appId, fixture.stable.id])
    // A semantic no-op still rewrites PostgreSQL heap rows and can change
    // unordered list scan order. Republish this fixture for an exact pair.
    await syncPluginState([fixture.appId])
  }, 60_000)

  afterAll(async () => {
    if (fixture)
      await fixture.cleanup()
  }, 60_000)

  it('returns identical existing bundle, new bundle, channel, stats and manifest size responses', async () => {
    for (const probe of fixture.readProbes) {
      const { db, kv } = await comparePluginState(probe)
      expect(db.status).toBe(200)
      expect(kv.body).toEqual(db.body)
    }
    const upToDate = await probePluginState(fixture.updateProbe(fixture.stable.name), 'kv')
    expect(upToDate.body).toMatchObject({ kind: 'up_to_date', error: 'no_new_version_available' })
    const update = await probePluginState(fixture.updateProbe(), 'kv')
    expect(update.body).toMatchObject({ version: fixture.stable.name, url: 'https://example.com/plugin-state/stable.zip' })
    const sizes = await probePluginState(fixture.manifestProbe, 'kv')
    expect(sizes.body).toMatchObject({ totalSize: 384, knownFiles: 2, unknownFiles: 0 })
  })

  it('keeps status and JSON parity after Cache API eviction', async () => {
    for (const probe of fixture.readProbes) {
      await evictPluginStateCache(fixture.appId)
      await comparePluginState(probe, true)
    }
  })

  it('uses the replica for a new app before its first publication in authoritative mode', async () => {
    const isolated = await createPluginStateFixture()
    try {
      const synced = await executeSQL<{ synced: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM public.plugin_state_sync_apps WHERE app_id = $1
      ) AS synced`, [isolated.appId])
      expect(synced).toEqual([{ synced: false }])
      const probe = { name: 'New app before publication', path: '/channel_self', method: 'PUT', body: isolated.base } as const
      const db = await probePluginState(probe, 'db')
      expect(db.status).toBe(200)
      expect(db.body).toMatchObject({ channel: 'production', status: 'default' })
      for (let request = 0; request < 2; request++) {
        const pending = await probePluginState(probe, 'kv')
        expect(pending.status).toBe(db.status)
        expect(pending.body).toEqual(db.body)
        expect(pending.state).toBe('miss')
      }
      await syncPluginState([isolated.appId])
      const published = await probePluginState(probe, 'kv')
      expect(published.status).toBe(db.status)
      expect(published.body).toEqual(db.body)
      expect(published.state).toBe('kv')
    }
    finally {
      await isolated.cleanup()
      await syncPluginState()
    }
  }, 60_000)

  it('preserves the deprecated plugin endpoint aliases', async () => {
    for (const probe of fixture.readProbes) {
      const { kv, db } = await comparePluginState({ ...probe, path: `/plugin${probe.path}` })
      expect(kv.status).toBe(db.status)
    }
  })

  it.each(['7.0.0', '7.34.0'])('preserves channel surfing and immediate read-after-write for plugin %s', async (pluginVersion) => {
    // Each mode gets a fresh device and executes the full lifecycle. Sharing
    // one device would make the second DELETE observe an already-cleared row.
    const measurements = await comparePluginStateChannelSequence(fixture, pluginVersion, pluginVersion === '7.34.0')
    expect(measurements.map(result => result.scenario)).toEqual([
      `${pluginVersion} SET beta`,
      `${pluginVersion} GET current after SET`,
      `${pluginVersion} DELETE override`,
      `${pluginVersion} GET current after DELETE`,
    ])
  })

  it('returns a complete 5,000-file delta bundle with identical order and sizes', async () => {
    const version = await createAppVersions('1.3.0', fixture.appId, { checksum: 'large-delta-checksum' })
    const files = Array.from({ length: 5000 }, (_, index) => ({
      app_version_id: version.id,
      file_name: `assets/file-${index}.js`,
      file_hash: index.toString(16).padStart(64, '0'),
      s3_path: `plugin-state/assets/file-${index}.js`,
      file_size: index + 1,
    }))
    await insertManifestRows(files)
    await executeSQL('UPDATE public.app_versions SET manifest_count = 5000 WHERE id = $1', [version.id])
    await executeSQL('UPDATE public.apps SET manifest_bundle_count = 2 WHERE app_id = $1', [fixture.appId])
    await executeSQL(`UPDATE public.channels SET version = $2::bigint, update_package = 'delta'
      WHERE app_id = $1 AND name = 'production'`, [fixture.appId, version.id])
    await syncPluginState()
    try {
      const probe = { ...fixture.updateProbe(), body: { ...fixture.base, plugin_version: '7.34.0' } }
      const { kv } = await comparePluginState(probe)
      const result = z.object({ version: z.string(), manifest: z.array(z.object({ file_name: z.string(), file_hash: z.string(), download_url: z.string() })) }).parse(kv.body)
      expect(result.version).toBe(version.name)
      expect(result.manifest).toHaveLength(5000)
      expect(result.manifest.map(file => file.file_name)).toEqual(files.map(file => file.file_name))
      const sizeProbe = {
        ...fixture.manifestProbe,
        body: { ...fixture.base, version: version.name, files: result.manifest },
      }
      const sizes = await comparePluginState(sizeProbe)
      expect(sizes.kv.body).toMatchObject({ totalSize: 12_502_500, knownFiles: 5000, unknownFiles: 0 })

      // Historical bundles must retain correct lookup behavior after retirement.
      await executeSQL(`UPDATE public.channels SET version = $2::bigint, update_package = 'all'
        WHERE app_id = $1 AND name = 'production'`, [fixture.appId, fixture.stable.id])
      await executeSQL('UPDATE public.app_versions SET deleted = true WHERE id = $1', [version.id])
      await syncPluginState()
      // The DB cohort retains its original untagged day-long size map. A KV
      // publication must evict only the KV cohort's short-lived map, so URL-
      // scoped cached answers intentionally differ until the DB map expires.
      const retiredKv = await probePluginState(sizeProbe, 'kv')
      expect(retiredKv.state).toBe('kv')
      expect(retiredKv.body).toMatchObject({ totalSize: 0, knownFiles: 0, unknownFiles: 5000 })
      const cachedDb = await probePluginState(sizeProbe, 'db')
      expect(cachedDb.state).not.toBe('kv')
      expect(cachedDb.body).toMatchObject({ totalSize: 12_502_500, knownFiles: 5000, unknownFiles: 0 })

      // Hash-only requests with an explicit version id use fresh lookups on
      // both paths rather than the URL-scoped size-map cache. Their complete
      // post-deletion status and JSON must still match.
      const retired = await comparePluginState({
        ...sizeProbe,
        name: 'Fresh retired manifest sizes',
        body: {
          ...sizeProbe.body,
          version_id: version.id,
          files: result.manifest.map(file => ({ file_name: file.file_name, file_hash: file.file_hash })),
        },
      })
      expect(retired.kv.body).toMatchObject({ totalSize: 0, knownFiles: 0, unknownFiles: 5000 })
    }
    finally {
      await executeSQL(`UPDATE public.channels SET version = $2::bigint, update_package = 'all'
        WHERE app_id = $1 AND name = 'production'`, [fixture.appId, fixture.stable.id])
      await syncPluginState()
    }
  }, 120_000)

  it('preserves zero/full rollout decisions and disabled channel behavior', async () => {
    try {
      for (const share of [0, 10_000]) {
        await executeSQL(`UPDATE public.channels SET rollout_version = $2::bigint,
          rollout_enabled = true, rollout_percentage_bps = $3, rollout_paused_at = NULL
          WHERE app_id = $1 AND name = 'production'`, [fixture.appId, fixture.next.id, share])
        await syncPluginState()
        const result = await comparePluginState(fixture.updateProbe())
        expect(result.kv.body).toMatchObject({ version: share === 0 ? fixture.stable.name : fixture.next.name })
      }
      await executeSQL(`UPDATE public.channels SET rollout_enabled = false, ios = false
        WHERE app_id = $1 AND name = 'production'`, [fixture.appId])
      await syncPluginState()
      const result = await comparePluginState({ ...fixture.updateProbe(), body: { ...fixture.base, platform: 'ios', defaultChannel: 'production' } })
      expect(z.object({ error: z.string() }).safeParse(result.kv.body).success).toBe(true)
    }
    finally {
      await executeSQL(`UPDATE public.channels SET rollout_enabled = false, rollout_version = NULL,
        rollout_percentage_bps = 0, ios = true WHERE app_id = $1 AND name = 'production'`, [fixture.appId])
      await syncPluginState()
    }
  }, 60_000)

  it('publishes channel changes while the writer and local purge run concurrently with reads', async () => {
    await setTimeout(1100)
    const result = await measurePluginStatePropagation(fixture, fixture.next)
    expect(result.db.requests).toBeGreaterThan(0)
    expect(result.kv.requests).toBeGreaterThan(0)
    const { kv } = await comparePluginState(fixture.updateProbe())
    expect(kv.body).toMatchObject({ version: fixture.next.name })
  }, 30_000)

  it('mirrors app setting changes and preserves plan rejection responses', async () => {
    await executeSQL('UPDATE public.apps SET block_provider_infra_requests = false WHERE app_id = $1', [fixture.appId])
    await syncPluginState()
    await comparePluginState(fixture.updateProbe())
    await executeSQL(`UPDATE public.stripe_info SET mau_exceeded = true, bandwidth_exceeded = true, trial_at = now() - interval '1 day'
      WHERE customer_id = (SELECT customer_id FROM public.orgs WHERE id = (SELECT owner_org FROM public.apps WHERE app_id = $1))`, [fixture.appId])
    await syncPluginState()
    const { kv } = await comparePluginState(fixture.updateProbe())
    expect(kv.status).toBe(429)
    const error = z.object({ error: z.string() }).parse(kv.body)
    // /updates deliberately preserves its legacy on_premise_app payload for
    // cancelled plans; /stats has a separate need_plan_upgrade contract.
    expect(error.error).toBe('on_premise_app')
    expect(kv.body).toMatchObject({ moreInfo: { retryAfterSeconds: 3600 } })
  })

  it.each(['channel promotion', 'app deletion'])('publishes %s while a full repair remains archived', async (change) => {
    const isolated = await createPluginStateFixture()
    try {
      await syncPluginState([isolated.appId])
      const before = await comparePluginState(isolated.updateProbe())
      expect(before.kv.body).toMatchObject({ version: isolated.stable.name })
      await executeSQL(`INSERT INTO public.plugin_state_sync_failed (app_id, kind, ref, repair_at)
        VALUES ($1, 'full', '', now() + interval '1 day')`, [isolated.appId])
      await executeSQL('UPDATE public.plugin_state_sync_apps SET full_synced_at = NULL WHERE app_id = $1', [isolated.appId])
      if (change === 'channel promotion') {
        await executeSQL(`UPDATE public.channels SET version = $2::bigint
          WHERE app_id = $1 AND name = 'production'`, [isolated.appId, isolated.next.id])
      }
      else {
        await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [isolated.appId])
      }
      // Drain ordinary jobs, without requesting a new explicit full repair.
      await syncPluginState()
      const { kv } = await comparePluginState(isolated.updateProbe())
      if (change === 'channel promotion')
        expect(kv.body).toMatchObject({ version: isolated.next.name })
      else
        expect(kv.status).toBeGreaterThanOrEqual(400)
      const [archive] = await executeSQL<{ count: string }>(`SELECT count(*)::text AS count
        FROM public.plugin_state_sync_failed WHERE app_id = $1 AND kind = 'full'`, [isolated.appId])
      expect(archive.count).toBe('1')
      const [pending] = await executeSQL<{ count: string }>(`SELECT count(*)::text AS count
        FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = 'full'`, [isolated.appId])
      expect(pending.count).toBe('0')
    }
    finally {
      await executeSQL('DELETE FROM public.plugin_state_sync_failed WHERE app_id = $1', [isolated.appId])
      await isolated.cleanup()
      await syncPluginState()
    }
  }, 60_000)

  it.each(['inline', 'per-device'])('publishes %s overrides during full-repair backoff without losing its cursor', async (mode) => {
    const isolated = await createPluginStateFixture()
    try {
      await executeSQL(`INSERT INTO public.channel_devices (app_id, device_id, channel_id)
        SELECT app_id, $2, id FROM public.channels WHERE app_id = $1 AND name = 'production'`, [isolated.appId, isolated.base.device_id])
      if (mode === 'per-device') {
        await executeSQL(`INSERT INTO public.channel_devices (app_id, device_id, channel_id)
          SELECT c.app_id, 'backoff-device-' || n, c.id FROM public.channels c
          CROSS JOIN generate_series(1, 500) AS n WHERE c.app_id = $1 AND c.name = 'production'`, [isolated.appId])
      }
      // The scheduler is quiesced: materialize the count that enables forced
      // override reads on both the replica and KV paths.
      await executeSQL('UPDATE public.apps SET channel_device_count = $2::integer WHERE app_id = $1', [isolated.appId, mode === 'per-device' ? 501 : 1])
      await syncPluginState([isolated.appId])
      const probe = isolated.updateProbe()
      const before = await comparePluginState(probe)
      expect(before.kv.body).toMatchObject({ version: isolated.stable.name })
      const cursor = JSON.stringify({ p: 'devices', after: 'backoff-device-250' })
      await executeSQL(`INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref, due_at, attempts)
        VALUES ($1, 'full', $2, now() + interval '5 minutes', 1)`, [isolated.appId, cursor])
      await executeSQL('UPDATE public.plugin_state_sync_apps SET full_synced_at = NULL WHERE app_id = $1', [isolated.appId])
      await executeSQL(`UPDATE public.channel_devices SET channel_id = (
        SELECT id FROM public.channels WHERE app_id = $1 AND name = 'beta')
        WHERE app_id = $1 AND device_id = $2`, [isolated.appId, isolated.base.device_id])
      // A complete-drain helper would correctly wait for the future cursor.
      // Run one bounded invocation to process the due override change only.
      const response = await fetch(`${CLOUDFLARE_API_URL}/triggers/plugin_state_sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apisecret: API_SECRET },
        body: JSON.stringify({ drain: true }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ failed: 0 })
      const after = await comparePluginState(probe)
      expect(after.kv.body).toMatchObject({ version: isolated.next.name })
      const pending = await executeSQL<{ ref: string, attempts: number }>(`SELECT ref, attempts
        FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = 'full'`, [isolated.appId])
      expect(pending).toEqual([{ ref: cursor, attempts: 1 }])
      const [sync] = await executeSQL<{ complete: boolean }>('SELECT full_synced_at IS NOT NULL AS complete FROM public.plugin_state_sync_apps WHERE app_id = $1', [isolated.appId])
      expect(sync.complete).toBe(false)
    }
    finally {
      await executeSQL('DELETE FROM public.plugin_state_sync_pending WHERE app_id = $1 AND kind = \'full\'', [isolated.appId])
      await isolated.cleanup()
      // Leave other tests' deferred counts untouched when removing this
      // fixture's bulk override rows.
      await executeSQL('DELETE FROM pgmq.q_channel_device_counts WHERE message ->> \'app_id\' = $1', [isolated.appId])
      await syncPluginState()
    }
  }, 120_000)
})

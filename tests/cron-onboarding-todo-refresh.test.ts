import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { refreshAppOnboardingTodoBatch } from '../supabase/functions/_backend/utils/app_onboarding_todo_refresh.ts'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { getPostgresClient } from './test-utils.ts'

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEventBatch: vi.fn(async () => true) }))

afterAll(async () => (await getPostgresClient()).end())

describe('queued onboarding todo refresh', () => {
  it('writes positive evidence to supported versions, preserves concurrent progress and unrelated JSON, and replays safely', async () => {
    const pool = await getPostgresClient()
    const orgId = randomUUID()
    const versions = [1, 2, 3, 4, 3]
    const appIds = versions.map(version => `com.example.todo.cron.${version}.${randomUUID()}`)
    const oldAt = '2026-09-01T00:00:00.000Z'
    let customerId: string | null = null
    try {
      const owner = (await pool.query('SELECT id FROM public.users WHERE email = $1', ['test@capgo.app'])).rows[0].id
      await pool.query('INSERT INTO public.orgs(id,created_by,name,management_email) VALUES ($1,$2,$3,$4)', [orgId, owner, 'Todo cron fixture', 'customer-onboarding@example.com'])
      customerId = (await pool.query('SELECT customer_id FROM public.orgs WHERE id=$1', [orgId])).rows[0].customer_id
      for (const [index, appId] of appIds.entries()) {
        const version = versions[index]
        const onboarding = {
          setup: {
            todo_list_version: version,
            ...(version === 4 ? { ota_todo_list_version: '1', paths: ['ota'], selected_path: 'ota' } : {}),
            outcome: index === 4 ? 'completed' : 'in_progress',
            steps: index === 4
              ? {}
              : version === 4
                ? { ota: { add_channel: { status: 'pending' }, run_device: { status: 'pending' } } }
                : version === 3
                  ? { add_channel: { status: 'done', at: oldAt, update_history: [{ status: 'done', at: oldAt }] } }
                  : {},
          },
          features: { ota: { stage: 'test' } },
          custom: { keep: true },
        }
        await pool.query('INSERT INTO public.apps(app_id,owner_org,name,icon_url,need_onboarding) VALUES ($1,$2,$3,$4,false)', [appId, orgId, 'Todo cron fixture', ''])
        await pool.query('UPDATE public.apps SET onboarding=$2::jsonb WHERE app_id=$1', [appId, JSON.stringify(onboarding)])
      }

      const c = { get: (key: string) => key === 'APISecret' ? true : 'test-request', req: { header: () => 'true' } } as any
      const gatherEvidence = vi.fn(async () => {
        // A CLI report lands after evidence collection starts but before the
        // worker locks rows. The worker must preserve its timestamp and history.
        await pool.query(`UPDATE public.apps SET onboarding = jsonb_set(onboarding,
          '{setup,steps,run_device}', $2::jsonb, true) WHERE app_id=$1`, [appIds[2], JSON.stringify({ status: 'done', at: oldAt, update_history: [{ status: 'done', at: oldAt }] })])
        return { channel: new Set(appIds), device: new Set(appIds), bundle: new Set(appIds), update: new Set(appIds), errors: [] }
      })
      const body = { appIds, queuedAt: new Date().toISOString() }
      const first = await refreshAppOnboardingTodoBatch(c, getDrizzleClient(pool), body, { gatherEvidence: gatherEvidence as any })
      expect(first.updated).toBe(4)
      expect(first.steps).toBe(8)

      const rows = (await pool.query('SELECT app_id, onboarding FROM public.apps WHERE app_id=ANY($1::varchar[])', [appIds])).rows
      const byId = new Map(rows.map(row => [row.app_id, row.onboarding]))
      for (const appId of appIds) {
        const onboarding = byId.get(appId)
        expect(onboarding.custom).toEqual({ keep: true })
        expect(onboarding.features.ota).toEqual({ stage: 'test' })
        const index = appIds.indexOf(appId)
        const version = versions[index]
        const steps = version === 4 ? onboarding.setup.steps.ota : onboarding.setup.steps
        if (index === 4) {
          expect(onboarding.setup.outcome).toBe('completed')
          expect(steps).toEqual({})
          continue
        }
        expect(steps.add_channel.status).toBe('done')
        if (version < 3) {
          expect(steps.run_device).toBeUndefined()
          expect(steps.upload_bundle).toBeUndefined()
          expect(steps.test_update).toBeUndefined()
        }
        else {
          expect(steps.run_device.status).toBe('done')
          expect(steps.upload_bundle.status).toBe('done')
          expect(steps.test_update.status).toBe('done')
        }
      }
      const v3Steps = byId.get(appIds[2]).setup.steps
      expect(v3Steps.add_channel.at).toBe(oldAt)
      expect(v3Steps.add_channel.update_history).toEqual([{ status: 'done', at: oldAt }])
      expect(v3Steps.run_device.at).toBe(oldAt)
      expect(v3Steps.run_device.update_history).toEqual([{ status: 'done', at: oldAt }])

      const beforeReplay = (await pool.query('SELECT app_id, onboarding FROM public.apps WHERE app_id=ANY($1::varchar[]) ORDER BY app_id', [appIds])).rows
      const replay = await refreshAppOnboardingTodoBatch(c, getDrizzleClient(pool), body, { gatherEvidence: async () => ({ channel: new Set(appIds), device: new Set(appIds), bundle: new Set(appIds), update: new Set(appIds), errors: [] }) })
      expect(replay.updated).toBe(0)
      expect((await pool.query('SELECT app_id, onboarding FROM public.apps WHERE app_id=ANY($1::varchar[]) ORDER BY app_id', [appIds])).rows).toEqual(beforeReplay)
    }
    finally {
      await pool.query('DELETE FROM public.apps WHERE app_id=ANY($1::varchar[])', [appIds])
      await pool.query('DELETE FROM public.orgs WHERE id=$1', [orgId])
      if (customerId)
        await pool.query('DELETE FROM public.stripe_info WHERE customer_id=$1', [customerId])
    }
  })

  it('repairs Builder cloud-build steps from independent platform evidence', async () => {
    const pool = await getPostgresClient()
    const orgId = randomUUID()
    const appId = `com.example.todo.builder.${randomUUID()}`
    let customerId: string | null = null
    try {
      const owner = (await pool.query('SELECT id FROM public.users WHERE email = $1', ['test@capgo.app'])).rows[0].id
      await pool.query('INSERT INTO public.orgs(id,created_by,name,management_email) VALUES ($1,$2,$3,$4)', [orgId, owner, 'Builder todo cron fixture', 'customer-onboarding@example.com'])
      customerId = (await pool.query('SELECT customer_id FROM public.orgs WHERE id=$1', [orgId])).rows[0].customer_id
      await pool.query('INSERT INTO public.apps(app_id,owner_org,name,icon_url,need_onboarding) VALUES ($1,$2,$3,$4,false)', [appId, orgId, 'Builder todo cron fixture', ''])
      const onboarding = {
        setup: {
          todo_list_version: 4,
          builder_todo_list_version: '1',
          paths: ['builder'],
          selected_path: 'builder',
          source: 'manual',
          outcome: 'in_progress',
          steps: {
            builder: {
              ios: { successful_cloud_build: { status: 'pending' } },
              android: { successful_cloud_build: { status: 'pending' } },
            },
          },
        },
        features: { builder: { keep: true } },
      }
      await pool.query('UPDATE public.apps SET onboarding=$2::jsonb WHERE app_id=$1', [appId, JSON.stringify(onboarding)])
      await pool.query(`INSERT INTO public.build_requests(
        app_id,owner_org,requested_by,platform,status,upload_session_key,upload_path,upload_url,upload_expires_at,created_at,completed_at)
        VALUES
          ($1,$2,$3,'ios','failed','todo-ios-failed','fixture/ios-failed','https://example.com',now(),now()-interval '3 minutes',now()-interval '2 minutes'),
          ($1,$2,$3,'ios','released','todo-ios-released','fixture/ios-released','https://example.com',now(),now()-interval '2 minutes',now()-interval '1 minute'),
          ($1,$2,$3,'android','failed','todo-android-failed','fixture/android-failed','https://example.com',now(),now()-interval '1 minute',now())`, [appId, orgId, owner])

      const c = { get: (key: string) => key === 'APISecret' ? true : 'test-request', req: { header: () => 'true' } } as any
      const noTodoEvidence = async () => ({ channel: new Set<string>(), device: new Set<string>(), bundle: new Set<string>(), update: new Set<string>(), errors: [] })
      const body = { appIds: [appId], queuedAt: new Date().toISOString() }
      expect(await refreshAppOnboardingTodoBatch(c, getDrizzleClient(pool), body, { gatherEvidence: noTodoEvidence })).toMatchObject({ updated: 1, steps: 2 })

      const repaired = (await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [appId])).rows[0].onboarding
      expect(repaired.features).toEqual(onboarding.features)
      expect(repaired).not.toHaveProperty('refreshed_at')
      expect(repaired.setup.steps.builder.ios.successful_cloud_build).toMatchObject({
        status: 'done',
        update_history: [{ status: 'done' }],
      })
      expect(repaired.setup.steps.builder.ios.successful_cloud_build).not.toHaveProperty('annotation')
      expect(repaired.setup.steps.builder.android.successful_cloud_build).toMatchObject({
        status: 'warning',
        annotation: 'cloud_build_failed',
        annotation_type: 'warning',
        update_history: [{ status: 'warning' }],
      })

      expect(await refreshAppOnboardingTodoBatch(c, getDrizzleClient(pool), body, { gatherEvidence: noTodoEvidence })).toMatchObject({ updated: 0, steps: 0 })
      expect((await pool.query('SELECT onboarding FROM public.apps WHERE app_id=$1', [appId])).rows[0].onboarding).toEqual(repaired)
    }
    finally {
      await pool.query('DELETE FROM public.build_requests WHERE app_id=$1', [appId])
      await pool.query('DELETE FROM public.apps WHERE app_id=$1', [appId])
      await pool.query('DELETE FROM public.orgs WHERE id=$1', [orgId])
      if (customerId)
        await pool.query('DELETE FROM public.stripe_info WHERE customer_id=$1', [customerId])
    }
  })
})

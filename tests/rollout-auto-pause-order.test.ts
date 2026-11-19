import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { __rolloutAutoPauseTestUtils__ } from '../supabase/functions/_backend/triggers/cron_rollout_auto_pause.ts'
import { executeSQL, getPostgresClient, ORG_ID, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

// The auto-pause cron takes the channels with the oldest of (last check, last
// failed attempt) first, so apps whose stats reads keep failing do not use up
// every run's time budget ahead of the others.

const appId = `com.rollout.order.${randomUUID().slice(0, 8)}`
const names = ['never-checked', 'checked-long-ago', 'failed-recently', 'checked-recently']
let channelIds: Record<string, number> = {}

describe('rollout auto-pause run order', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(appId)
    const [version] = await executeSQL<{ id: number }>(
      `INSERT INTO public.app_versions (app_id, name, owner_org) VALUES ($1, '9.9.9', $2) RETURNING id`,
      [appId, ORG_ID],
    )
    const rows = await executeSQL<{ id: number, name: string }>(
      `INSERT INTO public.channels (app_id, name, owner_org, created_by, version, rollout_version, rollout_enabled, rollout_percentage_bps, auto_pause_enabled, auto_pause_last_checked_at)
        SELECT $1, ch.name, $2, $4, $3, $3, true, 1000, true, ch.checked_at
        FROM (VALUES
          ('never-checked', NULL::timestamptz),
          ('checked-long-ago', now() - INTERVAL '3 hours'),
          ('failed-recently', now() - INTERVAL '2 hours'),
          ('checked-recently', now() - INTERVAL '1 hour')
        ) AS ch(name, checked_at)
        RETURNING id, name`,
      [appId, ORG_ID, version!.id, USER_ID],
    )
    channelIds = Object.fromEntries(rows.map(row => [row.name, Number(row.id)]))
    await executeSQL(
      `INSERT INTO public.channel_auto_pause_attempts (channel_id, failed_at) VALUES ($1, now() - INTERVAL '30 minutes')`,
      [channelIds['failed-recently']],
    )
  })

  afterAll(async () => {
    await executeSQL(`DELETE FROM public.channels WHERE app_id = $1`, [appId])
    await resetAppData(appId)
  })

  it('puts recently failed channels behind channels checked earlier', async () => {
    const result = await __rolloutAutoPauseTestUtils__.loadAutoPauseChannels(await getPostgresClient() as any, 10_000)
    expect(result.error).toBeNull()
    const order = (result.data ?? []).filter(channel => channel.app_id === appId).map(channel => channel.name)
    expect(order).toEqual(['never-checked', 'checked-long-ago', 'checked-recently', 'failed-recently'])
    expect(names.every(name => order.includes(name))).toBe(true)
  })

  it('keeps the attempts table away from API roles', async () => {
    const grants = await executeSQL<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'channel_auto_pause_attempts'`,
    )
    const grantees = grants.map(grant => grant.grantee)
    expect(grantees).not.toContain('anon')
    expect(grantees).not.toContain('authenticated')
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createIsolatedSeedAppOptions,
  executeSQL,
  fetchTestRequest,
  getAuthHeaders,
  getEndpointUrl,
  resetAndSeedAppData,
  resetAppData,
  USER_ID_2,
} from './test-utils.ts'

const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
const APPNAME = `com.channel_impact_${suffix}`
// Seeded in an org the default test user does not belong to.
const FOREIGN_APPNAME = `com.channel_impact_foreign_${suffix}`
const foreignSeed = { ...createIsolatedSeedAppOptions(), userId: USER_ID_2 }

let authHeaders: Record<string, string>
let channelId: number
let foreignChannelId: number
let majorBundleId: number

function postImpact(body: Record<string, unknown>) {
  return fetchTestRequest(getEndpointUrl('/private/channel_impact'), {
    method: 'POST',
    retryUnsafe: true,
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function insertBundle(name: string) {
  const [row] = await executeSQL<{ id: number }>(
    `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, r2_path, storage_provider, checksum)
     SELECT a.app_id, $2::text, a.owner_org, a.user_id, 'orgs/' || a.owner_org || '/apps/' || a.app_id || '/' || $2::text || '.zip', 'r2', 'deadbeef'
     FROM public.apps a WHERE a.app_id = $1
     RETURNING id`,
    [APPNAME, name],
  )
  return Number(row.id)
}

async function insertDevices(count: number, values: { platform: 'ios' | 'android', native: string, bundle: string, channel: string | null }) {
  await executeSQL(
    `INSERT INTO public.devices (updated_at, device_id, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator, version_name, default_channel)
     SELECT now(), $1::text || '-' || g, $2::text, $3::public.platform_os, '7.20.0', '18.0', $4::text, '', true, false, $5::text, $6::text
     FROM generate_series(1, $7::int) AS g`,
    [`impact-${suffix}-${values.channel ?? 'none'}-${values.platform}-${values.native}-${values.bundle}`, APPNAME, values.platform, values.native, values.bundle, values.channel, count],
  )
}

beforeAll(async () => {
  await Promise.all([
    resetAndSeedAppData(APPNAME),
    resetAndSeedAppData(FOREIGN_APPNAME, foreignSeed),
  ])
  authHeaders = await getAuthHeaders()

  const [channel] = await executeSQL<{ id: number }>(`SELECT id FROM public.channels WHERE app_id = $1 AND name = 'production'`, [APPNAME])
  channelId = Number(channel.id)
  const [foreignChannel] = await executeSQL<{ id: number }>(`SELECT id FROM public.channels WHERE app_id = $1 AND name = 'production'`, [FOREIGN_APPNAME])
  foreignChannelId = Number(foreignChannel.id)

  const previousBundleId = await insertBundle('1.9.3')
  const currentBundleId = await insertBundle('1.9.4')
  majorBundleId = await insertBundle('2.0.0')
  await executeSQL(
    `UPDATE public.channels SET ios = true, android = true, disable_auto_update = 'major', disable_auto_update_under_native = true, version = $2 WHERE id = $1`,
    [channelId, previousBundleId],
  )
  await executeSQL(`UPDATE public.channels SET version = $2 WHERE id = $1`, [channelId, currentBundleId])
  await executeSQL(`UPDATE public.deploy_history SET deployed_at = now() - interval '1 day' WHERE channel_id = $1 AND version_id = $2`, [channelId, previousBundleId])

  // Old store builds stay on 1.x; the new 2.0.0 store build already ships 2.0.0.
  await insertDevices(6, { platform: 'ios', native: '1.9.0', bundle: '1.9.4', channel: 'production' })
  await insertDevices(3, { platform: 'android', native: '1.9.0', bundle: '1.9.4', channel: 'production' })
  await insertDevices(2, { platform: 'android', native: '2.0.0', bundle: '2.0.0', channel: 'production' })
  await insertDevices(1, { platform: 'ios', native: '2.0.1', bundle: '2.0.1', channel: 'production' })
  // Another channel: never counted here.
  await insertDevices(4, { platform: 'ios', native: '1.9.0', bundle: '1.9.4', channel: 'beta' })
})

afterAll(async () => {
  await executeSQL('DELETE FROM public.devices WHERE app_id = $1', [APPNAME])
  await Promise.all([resetAppData(APPNAME), resetAppData(FOREIGN_APPNAME)])
})

describe('POST /private/channel_impact', () => {
  it('explains a major bump against the store builds of the channel', async () => {
    const response = await postImpact({ app_id: APPNAME, channel_id: channelId, targets: [{ kind: 'bundle', version_id: majorBundleId }] })
    const body = await response.json() as any
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.total_devices).toBe(12)
    expect(body.channel).toMatchObject({ strategy: 'major', under_native_guard: true, current_bundle: { name: '1.9.4' } })
    const [impact] = body.impacts
    expect(impact.target).toEqual({ kind: 'bundle', id: majorBundleId, name: '2.0.0' })
    expect(impact.outcomes.blocked_major).toBe(9)
    expect(impact.outcomes.already_on_target).toBe(2)
    expect(impact.outcomes.blocked_under_native).toBe(1)
    expect(impact.receive).toBe(0)
    expect(impact.requirement).toEqual({ strategy: 'major', native: '2.0.0' })
    expect(body.samples_included).toBe(true)
    expect(impact.samples.length).toBeGreaterThanOrEqual(3)
    expect(impact.samples.every((sample: { device_id: string }) => sample.device_id.startsWith(`impact-${suffix}-`))).toBe(true)
  })

  it('answers both revert choices from one request', async () => {
    const response = await postImpact({ app_id: APPNAME, channel_id: channelId, targets: [{ kind: 'previous' }, { kind: 'builtin' }] })
    const body = await response.json() as any
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.previous_bundle).toMatchObject({ name: '1.9.3' })
    const [previous, builtin] = body.impacts
    expect(previous.target.name).toBe('1.9.3')
    expect(previous.receive).toBe(9)
    expect(previous.outcomes.blocked_under_native).toBe(3)
    expect(builtin.target.kind).toBe('builtin')
    expect(builtin.outcomes.revert_to_builtin).toBe(9)
    expect(builtin.outcomes.already_on_target).toBe(3)
  })

  it('estimates the first wave of a progressive rollout', async () => {
    const response = await postImpact({ app_id: APPNAME, channel_id: channelId, targets: [{ kind: 'previous' }], mode: 'rollout', rollout_percentage_bps: 5000 })
    const body = await response.json() as any
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.impacts[0].rollout_receive).toBe(Math.round(body.impacts[0].receive / 2))
  })

  it('refuses channels of other apps and apps the caller cannot read', async () => {
    const otherApp = await postImpact({ app_id: APPNAME, channel_id: foreignChannelId, targets: [{ kind: 'builtin' }] })
    expect([403, 404]).toContain(otherApp.status)
    await otherApp.arrayBuffer()

    const foreign = await postImpact({ app_id: FOREIGN_APPNAME, channel_id: foreignChannelId, targets: [{ kind: 'builtin' }] })
    expect(foreign.status).toBe(403)
    await foreign.arrayBuffer()
  })

  it('rejects malformed bodies and anonymous callers', async () => {
    const malformed = await postImpact({ app_id: APPNAME, channel_id: channelId, targets: [] })
    expect(malformed.status).toBe(400)
    await malformed.arrayBuffer()

    const anonymous = await fetchTestRequest(getEndpointUrl('/private/channel_impact'), {
      method: 'POST',
      retryUnsafe: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APPNAME, channel_id: channelId, targets: [{ kind: 'builtin' }] }),
    })
    expect(anonymous.status).toBe(401)
    await anonymous.arrayBuffer()
  })
})

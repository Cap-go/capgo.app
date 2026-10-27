import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  fetchTestRequest,
  getAuthHeaders,
  getEndpointUrl,
  getSupabaseClient,
  resetAndSeedAppData,
  resetAppData,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_ID,
} from './test-utils.ts'

const APPNAME = `com.channel_history_rbac_${randomUUID().replaceAll('-', '').slice(0, 12)}`

let authHeaders: Record<string, string>
let deniedChannelId: number
let allowedChannelId: number

function userClient() {
  return createClient<Database>(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeaders.Authorization ?? authHeaders.authorization } },
  })
}

async function readDeployHistory(channelId: number) {
  const { data, error } = await userClient()
    .from('deploy_history')
    .select('id, channel_id')
    .eq('app_id', APPNAME)
    .eq('channel_id', channelId)
  expect(error).toBeNull()
  return data ?? []
}

function postJson(path: string, body: Record<string, unknown>) {
  return fetchTestRequest(getEndpointUrl(path), {
    method: 'POST',
    retryUnsafe: true,
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function setHistoryOverride(channelId: number, isAllowed: boolean | null) {
  if (isAllowed === null) {
    await executeSQL(
      `DELETE FROM public.channel_permission_overrides
       WHERE principal_type = public.rbac_principal_user()
         AND principal_id = $1
         AND channel_id = $2
         AND permission_key = public.rbac_perm_channel_read_history()`,
      [USER_ID, channelId],
    )
    return
  }
  await executeSQL(
    `INSERT INTO public.channel_permission_overrides (
       principal_type, principal_id, channel_id, permission_key, is_allowed
     ) VALUES (
       public.rbac_principal_user(), $1, $2, public.rbac_perm_channel_read_history(), $3
     )
     ON CONFLICT (principal_type, principal_id, channel_id, permission_key)
     DO UPDATE SET is_allowed = excluded.is_allowed`,
    [USER_ID, channelId, isAllowed],
  )
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
  authHeaders = await getAuthHeaders()

  const { data: channels, error } = await getSupabaseClient()
    .from('channels')
    .select('id, name')
    .eq('app_id', APPNAME)
    .in('name', ['production', 'beta'])
  expect(error).toBeNull()
  deniedChannelId = channels!.find(channel => channel.name === 'production')!.id
  allowedChannelId = channels!.find(channel => channel.name === 'beta')!.id
})

afterAll(async () => {
  if (deniedChannelId)
    await setHistoryOverride(deniedChannelId, null)
  await resetAppData(APPNAME)
})

describe('channel.read_history enforcement', () => {
  it('lets an app reader read channel history without an override', async () => {
    expect((await readDeployHistory(deniedChannelId)).length).toBeGreaterThan(0)

    const response = await postJson('/private/channel_stats', { app_id: APPNAME, channel_id: deniedChannelId, days: 7 })
    const body = await response.json() as Record<string, unknown>
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(Array.isArray(body.deploymentHistory)).toBe(true)
  })

  it('hides history of a channel with a channel.read_history deny override', async () => {
    await setHistoryOverride(deniedChannelId, false)
    try {
      expect(await readDeployHistory(deniedChannelId)).toEqual([])
      // Other channels of the same app stay readable.
      expect((await readDeployHistory(allowedChannelId)).length).toBeGreaterThan(0)

      const denied = await postJson('/private/channel_stats', { app_id: APPNAME, channel_id: deniedChannelId, days: 7 })
      const deniedBody = await denied.json() as { error?: string }
      expect(denied.status, JSON.stringify(deniedBody)).toBe(403)
      expect(deniedBody.error).toBe('channel_access_denied')

      const allowed = await postJson('/private/channel_stats', { app_id: APPNAME, channel_id: allowedChannelId, days: 7 })
      expect(allowed.status).toBe(200)

      const installStats = await postJson('/private/bundle_install_stats', { app_id: APPNAME, channel_id: deniedChannelId, days: 7 })
      const installStatsBody = await installStats.json() as { error?: string }
      expect(installStats.status, JSON.stringify(installStatsBody)).toBe(403)
      expect(installStatsBody.error).toBe('channel_access_denied')

      type ReleaseLiveBody = { error?: string, channel?: { id: number } | null, channels?: Array<{ id: number }>, recent_deployments?: Array<{ channel_id: number | null }> }
      const releaseLive = await postJson('/private/release_live', { app_id: APPNAME })
      const releaseLiveBody = await releaseLive.json() as ReleaseLiveBody
      expect(releaseLive.status, JSON.stringify(releaseLiveBody)).toBe(200)
      expect(releaseLiveBody.channel?.id).not.toBe(deniedChannelId)
      expect((releaseLiveBody.channels ?? []).map(channel => channel.id)).not.toContain(deniedChannelId)
      expect((releaseLiveBody.recent_deployments ?? []).some(deployment => deployment.channel_id === deniedChannelId)).toBe(false)

      const releaseLiveDenied = await postJson('/private/release_live', { app_id: APPNAME, channel_id: deniedChannelId })
      const releaseLiveDeniedBody = await releaseLiveDenied.json() as ReleaseLiveBody
      expect(releaseLiveDenied.status, JSON.stringify(releaseLiveDeniedBody)).toBe(403)
      expect(releaseLiveDeniedBody.error).toBe('channel_access_denied')

      // History of permitted channels is still returned.
      const releaseLiveAllowed = await postJson('/private/release_live', { app_id: APPNAME, channel_id: allowedChannelId })
      const releaseLiveAllowedBody = await releaseLiveAllowed.json() as ReleaseLiveBody
      expect(releaseLiveAllowed.status, JSON.stringify(releaseLiveAllowedBody)).toBe(200)
      expect(releaseLiveAllowedBody.channel?.id).toBe(allowedChannelId)
      expect((releaseLiveAllowedBody.recent_deployments ?? []).some(deployment => deployment.channel_id === allowedChannelId)).toBe(true)
    }
    finally {
      await setHistoryOverride(deniedChannelId, null)
    }

    expect((await readDeployHistory(deniedChannelId)).length).toBeGreaterThan(0)
  })
})

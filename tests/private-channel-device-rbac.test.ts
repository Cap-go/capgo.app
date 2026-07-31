import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectApiKeyWithBindings, getEndpointUrl, getSupabaseClient, ORG_ID, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

const APPNAME = `com.private_channel_device_${randomUUID()}`

async function createPrivateChannel(channelName: string) {
  const supabase = getSupabaseClient()
  const { data: version, error: versionError } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', APPNAME)
    .limit(1)
    .single()
  expect(versionError).toBeNull()
  expect(version?.id).toBeTruthy()

  const { data: channel, error: channelError } = await supabase
    .from('channels')
    .insert({
      name: channelName,
      app_id: APPNAME,
      version: version!.id,
      owner_org: ORG_ID,
      created_by: USER_ID,
      public: false,
      disable_auto_update_under_native: true,
      disable_auto_update: 'major',
      allow_device_self_set: false,
      allow_emulator: false,
      allow_device: false,
      allow_dev: false,
      allow_prod: false,
      ios: false,
      android: false,
    })
    .select('id, rbac_id')
    .single()
  expect(channelError).toBeNull()
  expect(channel?.id).toBeTruthy()
  expect(channel?.rbac_id).toBeTruthy()

  return channel!
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

describe('[POST] /private/channel_device RBAC', () => {
  it('allows channel-scoped API keys to insert forced device overrides through anon RLS', async () => {
    const supabase = getSupabaseClient()
    const channelName = `forced-device-${randomUUID().slice(0, 8)}`
    const channel = await createPrivateChannel(channelName)
    const deviceId = randomUUID().toLowerCase()

    const { data: app, error: appError } = await supabase
      .from('apps')
      .select('id')
      .eq('app_id', APPNAME)
      .single()
    expect(appError).toBeNull()
    expect(app?.id).toBeTruthy()

    const { data: channelAdminRole, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'channel_admin')
      .eq('scope_type', 'channel')
      .single()
    expect(roleError).toBeNull()
    expect(channelAdminRole?.id).toBeTruthy()

    const key = `private-channel-device-${randomUUID()}`
    const apiKey = await createDirectApiKeyWithBindings({
      key,
      name: `Private channel device ${channelName}`,
      orgId: ORG_ID,
      roleName: 'org_member',
    })
    const resolvedKey = apiKey.key ?? key

    try {
      const { error: bindingError } = await supabase
        .from('role_bindings')
        .insert({
          principal_type: 'apikey',
          principal_id: apiKey.rbac_id,
          role_id: channelAdminRole!.id,
          scope_type: 'channel',
          org_id: ORG_ID,
          app_id: app!.id,
          channel_id: channel.rbac_id,
          granted_by: apiKey.user_id,
          reason: 'Private channel_device API-key RBAC regression test',
          is_direct: true,
        })
      expect(bindingError).toBeNull()

      const { data: directAllowed, error: directError } = await supabase.rpc('rbac_check_permission_direct' as any, {
        p_permission_key: 'channel.manage_forced_devices',
        p_user_id: apiKey.user_id,
        p_org_id: ORG_ID,
        p_app_id: APPNAME,
        p_channel_id: channel.id,
        p_apikey: resolvedKey,
      })
      expect(directError).toBeNull()
      expect(directAllowed).toBe(true)

      const response = await fetch(getEndpointUrl('/private/channel_device'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': resolvedKey,
        },
        body: JSON.stringify({
          app_id: APPNAME,
          device_id: deviceId,
          channel_id: channel.id,
        }),
      })
      const responseBody = await response.json().catch(() => null)
      expect(response.status, JSON.stringify(responseBody)).toBe(200)
      expect(responseBody).toEqual({ status: 'ok' })

      const { data: override, error: overrideError } = await supabase
        .from('channel_devices')
        .select('app_id, channel_id, owner_org')
        .eq('app_id', APPNAME)
        .eq('device_id', deviceId)
        .single()
      expect(overrideError).toBeNull()
      expect(override).toEqual({
        app_id: APPNAME,
        channel_id: channel.id,
        owner_org: ORG_ID,
      })
    }
    finally {
      await supabase.from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
      await supabase.from('apikeys').delete().eq('id', apiKey.id)
    }
  })

  it('allows channel-scoped API keys to set forced device overrides through public device API', async () => {
    const supabase = getSupabaseClient()
    const channelName = `public-forced-device-${randomUUID().slice(0, 8)}`
    const channel = await createPrivateChannel(channelName)
    const deviceId = randomUUID().toLowerCase()

    const { data: app, error: appError } = await supabase
      .from('apps')
      .select('id')
      .eq('app_id', APPNAME)
      .single()
    expect(appError).toBeNull()
    expect(app?.id).toBeTruthy()

    const { data: channelAdminRole, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'channel_admin')
      .eq('scope_type', 'channel')
      .single()
    expect(roleError).toBeNull()
    expect(channelAdminRole?.id).toBeTruthy()

    const key = `public-channel-device-${randomUUID()}`
    const apiKey = await createDirectApiKeyWithBindings({
      key,
      name: `Public channel device ${channelName}`,
      orgId: ORG_ID,
      roleName: 'org_member',
    })
    const resolvedKey = apiKey.key ?? key

    try {
      const { error: bindingError } = await supabase
        .from('role_bindings')
        .insert({
          principal_type: 'apikey',
          principal_id: apiKey.rbac_id,
          role_id: channelAdminRole!.id,
          scope_type: 'channel',
          org_id: ORG_ID,
          app_id: app!.id,
          channel_id: channel.rbac_id,
          granted_by: apiKey.user_id,
          reason: 'Public device API channel-admin RBAC regression test',
          is_direct: true,
        })
      expect(bindingError).toBeNull()

      const { data: directAllowed, error: directError } = await supabase.rpc('rbac_check_permission_direct' as any, {
        p_permission_key: 'channel.manage_forced_devices',
        p_user_id: apiKey.user_id,
        p_org_id: ORG_ID,
        p_app_id: APPNAME,
        p_channel_id: channel.id,
        p_apikey: resolvedKey,
      })
      expect(directError).toBeNull()
      expect(directAllowed).toBe(true)

      const response = await fetch(getEndpointUrl('/device'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': resolvedKey,
        },
        body: JSON.stringify({
          app_id: APPNAME,
          device_id: deviceId,
          channel: channelName,
        }),
      })
      const responseBody = await response.json().catch(() => null)
      expect(response.status, JSON.stringify(responseBody)).toBe(200)
      expect(responseBody).toEqual({ status: 'ok' })

      const { data: override, error: overrideError } = await supabase
        .from('channel_devices')
        .select('app_id, channel_id, owner_org')
        .eq('app_id', APPNAME)
        .eq('device_id', deviceId)
        .single()
      expect(overrideError).toBeNull()
      expect(override).toEqual({
        app_id: APPNAME,
        channel_id: channel.id,
        owner_org: ORG_ID,
      })
    }
    finally {
      await supabase.from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
      await supabase.from('apikeys').delete().eq('id', apiKey.id)
    }
  })
})

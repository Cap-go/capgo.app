import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestSDK } from './cli-sdk-utils'
import { BASE_URL, createDirectApiKeyWithBindings, createIsolatedSeedAppOptions, getSupabaseClient, resetAndSeedAppData, resetAppData, SUPABASE_ANON_KEY, SUPABASE_BASE_URL, USER_ID } from './test-utils'

const seedOptions = createIsolatedSeedAppOptions()

// Helper to generate unique channel names for concurrent tests
const generateChannelName = () => `test-channel-${randomUUID().slice(0, 8)}`

// Cache version ID per app to avoid repeated queries
const versionCache = new Map<string, number>()

// Helper to create channel directly in database for faster test setup
async function createChannel(channelName: string, appId: string) {
  let versionId = versionCache.get(appId)

  if (!versionId) {
    // Only query once per app
    const { data: versionData } = await getSupabaseClient()
      .from('app_versions')
      .select('id')
      .eq('app_id', appId)
      .limit(1)
      .single()

    versionId = versionData?.id || 1
    versionCache.set(appId, versionId)
  }

  const { error } = await getSupabaseClient()
    .from('channels')
    .insert({
      name: channelName,
      app_id: appId,
      version: versionId,
      owner_org: seedOptions.orgId,
      created_by: USER_ID,
      public: false,
      disable_auto_update_under_native: true,
      disable_auto_update: 'major' as const,
      allow_device_self_set: false,
      allow_emulator: false,
      allow_device: false,
      allow_dev: false,
      allow_prod: false,
      ios: false,
      android: false,
    })
  if (error)
    throw error
}

describe('tests CLI channel commands', () => {
  const id = randomUUID()
  const APPNAME = `com.cli_channel_${id}`
  const invalidAppName = `invalid-app-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    await resetAndSeedAppData(APPNAME, seedOptions)
  })

  afterAll(async () => {
    await resetAppData(APPNAME)
  })

  describe.concurrent('channel creation', () => {
    it('should create a channel', async () => {
      const channelName = generateChannelName()
      const result = await createTestSDK().addChannel({ channelId: channelName, appId: APPNAME })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })

    it.concurrent('should fail to create a channel with invalid app ID', async () => {
      const testChannelName = generateChannelName()
      const result = await createTestSDK().addChannel({ channelId: testChannelName, appId: invalidAppName })
      expect(result.success).toBe(false)
      expect(result.error).toContain('does not exist')

      // Verify channel wasn't created
      const { data } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', invalidAppName)
      expect(data).toHaveLength(0)
    })

    it.concurrent('should fail to create a duplicate channel', async () => {
      const channelName = generateChannelName()
      // Create the channel first
      await createChannel(channelName, APPNAME)

      const result = await createTestSDK().addChannel({ channelId: channelName, appId: APPNAME })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe.concurrent('channel listing', () => {
    it.concurrent('should list channels', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const result = await createTestSDK().listChannels(APPNAME)
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()

      const channel = result.data!.find(c => c.name === channelName)
      expect(channel).toBeDefined()
    })

    it.concurrent('should show empty list for invalid app ID', async () => {
      const testInvalidApp = `invalid-app-${randomUUID().slice(0, 8)}`
      const result = await createTestSDK().listChannels(testInvalidApp)

      // SDK will fail for non-existent app
      expect(result.success).toBe(false)

      // Optional: verify no channels exist for invalid app
      const { data } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('app_id', testInvalidApp)
      expect(data).toHaveLength(0)
    })
  })

  describe.concurrent('channel bundle operations', () => {
    it.concurrent('should set channel bundle', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const bundle = `1.0.${Math.floor(Math.random() * 10000)}`
      await getSupabaseClient()
        .from('app_versions')
        .insert({
          app_id: APPNAME,
          name: bundle,
          owner_org: seedOptions.orgId,
          user_id: USER_ID,
          storage_provider: 'r2-direct',
        })
        .throwOnError()

      const result = await createTestSDK().updateChannel({ channelId: channelName, appId: APPNAME, bundle })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('id, version:app_versions!channels_version_fkey(id, name)')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.version?.name).toBe(bundle)
    })

    it.concurrent('should get current bundle with a channel-scoped reader key', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const supabase = getSupabaseClient()
      const { data: app, error: appError } = await supabase
        .from('apps')
        .select('id')
        .eq('app_id', APPNAME)
        .single()
      expect(appError).toBeNull()
      expect(app?.id).toBeTruthy()

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .select('id, rbac_id, version ( name )')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
      expect(channelError).toBeNull()
      expect(channel?.rbac_id).toBeTruthy()
      expect(channel?.version?.name).toBeTruthy()
      const { data: channelReaderRole, error: roleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', 'channel_reader')
        .eq('scope_type', 'channel')
        .single()
      expect(roleError).toBeNull()
      expect(channelReaderRole?.id).toBeTruthy()

      const key = `channel-current-bundle-${randomUUID()}`
      const apiKey = await createDirectApiKeyWithBindings({
        key,
        name: `Channel current bundle reader ${channelName}`,
        orgId: seedOptions.orgId,
        roleName: 'org_member',
      })
      const resolvedKey = apiKey.key ?? key

      try {
        const { error: bindingError } = await supabase
          .from('role_bindings')
          .insert({
            principal_type: 'apikey',
            principal_id: apiKey.rbac_id,
            role_id: channelReaderRole!.id,
            scope_type: 'channel',
            org_id: seedOptions.orgId,
            app_id: app!.id,
            channel_id: channel!.rbac_id,
            granted_by: apiKey.user_id,
            reason: 'CLI current bundle channel-reader regression test',
            is_direct: true,
          })
        expect(bindingError).toBeNull()

        const { data: directAllowed, error: directError } = await supabase.rpc('rbac_check_permission_direct' as any, {
          p_permission_key: 'channel.read',
          p_user_id: apiKey.user_id,
          p_org_id: seedOptions.orgId,
          p_app_id: APPNAME,
          p_channel_id: channel!.id,
          p_apikey: resolvedKey,
        })
        expect(directError).toBeNull()
        expect(directAllowed).toBe(true)

        const result = await createTestSDK(resolvedKey).getCurrentBundle(APPNAME, channelName)
        expect(result.success, result.error).toBe(true)
        expect(result.data).toBe(channel?.version?.name)
      }
      finally {
        await supabase.from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
        await supabase.from('apikeys').delete().eq('id', apiKey.id)
      }
    })

    it.concurrent('should set channel bundle with a channel-scoped admin key', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const bundle = `1.0.${Math.floor(Math.random() * 10000)}`
      await getSupabaseClient()
        .from('app_versions')
        .insert({
          app_id: APPNAME,
          name: bundle,
          owner_org: seedOptions.orgId,
          user_id: USER_ID,
          storage_provider: 'r2-direct',
        })
        .throwOnError()

      const supabase = getSupabaseClient()
      const { data: app, error: appError } = await supabase
        .from('apps')
        .select('id')
        .eq('app_id', APPNAME)
        .single()
      expect(appError).toBeNull()
      expect(app?.id).toBeTruthy()

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .select('id, rbac_id')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
      expect(channelError).toBeNull()
      expect(channel?.rbac_id).toBeTruthy()

      const { data: channelAdminRole, error: roleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', 'channel_admin')
        .eq('scope_type', 'channel')
        .single()
      expect(roleError).toBeNull()
      expect(channelAdminRole?.id).toBeTruthy()

      const key = `channel-update-${randomUUID()}`
      const apiKey = await createDirectApiKeyWithBindings({
        key,
        name: `Channel update admin ${channelName}`,
        orgId: seedOptions.orgId,
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
            org_id: seedOptions.orgId,
            app_id: app!.id,
            channel_id: channel!.rbac_id,
            granted_by: apiKey.user_id,
            reason: 'CLI channel set channel-admin regression test',
            is_direct: true,
          })
        expect(bindingError).toBeNull()

        const { data: directAllowed, error: directError } = await supabase.rpc('rbac_check_permission_direct' as any, {
          p_permission_key: 'channel.update_settings',
          p_user_id: apiKey.user_id,
          p_org_id: seedOptions.orgId,
          p_app_id: APPNAME,
          p_channel_id: channel!.id,
          p_apikey: resolvedKey,
        })
        expect(directError).toBeNull()
        expect(directAllowed).toBe(true)

        const result = await createTestSDK(resolvedKey).updateChannel({ channelId: channelName, appId: APPNAME, bundle })
        expect(result.success, result.error).toBe(true)
      }
      finally {
        await supabase.from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
        await supabase.from('apikeys').delete().eq('id', apiKey.id)
      }
    })

    it.concurrent('should set channel bundle with app developer promotion permission only', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const bundle = `1.0.${Math.floor(Math.random() * 10000)}`
      await getSupabaseClient()
        .from('app_versions')
        .insert({
          app_id: APPNAME,
          name: bundle,
          owner_org: seedOptions.orgId,
          user_id: USER_ID,
          storage_provider: 'r2-direct',
        })
        .throwOnError()

      const apiKey = await createDirectApiKeyWithBindings({
        key: `channel-promote-${randomUUID()}`,
        name: `Channel promote developer ${channelName}`,
        orgId: seedOptions.orgId,
        roleName: 'org_member',
        appId: APPNAME,
        appRoleName: 'app_developer',
      })
      const resolvedKey = apiKey.key ?? ''

      try {
        const supabase = getSupabaseClient()
        const { data: channel, error: channelError } = await supabase
          .from('channels')
          .select('id')
          .eq('name', channelName)
          .eq('app_id', APPNAME)
          .single()
        expect(channelError).toBeNull()
        expect(channel?.id).toBeTruthy()

        const { data: canPromote, error: promoteError } = await supabase.rpc('rbac_check_permission_direct' as any, {
          p_permission_key: 'channel.promote_bundle',
          p_user_id: apiKey.user_id,
          p_org_id: seedOptions.orgId,
          p_app_id: APPNAME,
          p_channel_id: channel!.id,
          p_apikey: resolvedKey,
        })
        expect(promoteError).toBeNull()
        expect(canPromote).toBe(true)

        const { data: canUpdateSettings, error: settingsError } = await supabase.rpc('rbac_check_permission_direct' as any, {
          p_permission_key: 'channel.update_settings',
          p_user_id: apiKey.user_id,
          p_org_id: seedOptions.orgId,
          p_app_id: APPNAME,
          p_channel_id: channel!.id,
          p_apikey: resolvedKey,
        })
        expect(settingsError).toBeNull()
        expect(canUpdateSettings).toBe(false)

        const result = await createTestSDK(resolvedKey).updateChannel({ channelId: channelName, appId: APPNAME, bundle })
        expect(result.success, result.error).toBe(true)
      }
      finally {
        await getSupabaseClient().from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
        await getSupabaseClient().from('apikeys').delete().eq('id', apiKey.id)
      }
    })

    it.concurrent('should fail to set bundle for invalid channel name', async () => {
      const bundle = '1.0.0'
      const testInvalidChannel = generateChannelName()
      const result = await createTestSDK().updateChannel({ channelId: testInvalidChannel, appId: APPNAME, bundle })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Cannot find channel')
    })

    it.concurrent('should fail to set invalid bundle version', async () => {
      const invalidBundle = 'not-a-version'
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: invalidBundle })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Cannot find version')
    })
  })

  describe.concurrent('channel state operations', () => {
    it.concurrent('should set channel state to default', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: channelName, appId: APPNAME, bundle: undefined, ...{ state: 'default' } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.public).toBe(true)
    })

    it.concurrent('should set channel state to public', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: channelName, appId: APPNAME, bundle: undefined, ...{ state: 'normal' } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.public).toBe(false)
    })

    it.concurrent('should fail to set invalid state', async () => {
      const invalidState = 'invalid-state'
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)
      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ state: invalidState } })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown state')
    })
  })

  describe.concurrent('channel policy operations', () => {
    it.concurrent('should set channel downgrade policy', async () => {
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ downgrade: true } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.disable_auto_update_under_native).toBe(false)
    })
  })

  describe.concurrent('channel platform operations', () => {
    it.concurrent('should set channel platform to ios', async () => {
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ ios: true } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.ios).toBe(true)
    })

    it.concurrent('should set channel platform to android', async () => {
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ android: true } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.android).toBe(true)
    })

    it.concurrent('should set both platforms simultaneously', async () => {
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ ios: true, android: true } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.ios).toBe(true)
      expect(data?.android).toBe(true)
    })
  })

  describe.concurrent('channel self-assign operations', () => {
    it.concurrent('should set channel self-assign', async () => {
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ selfAssign: true } })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.allow_device_self_set).toBe(true)
    })
  })

  it.concurrent('should disable auto update for channel', async () => {
    const testChannelName = generateChannelName()
    await createChannel(testChannelName, APPNAME)

    const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ disableAutoUpdate: 'major' } })
    expect(result.success).toBe(true)

    // Verify in database
    const { data, error } = await getSupabaseClient()
      .from('channels')
      .select('*')
      .eq('name', testChannelName)
      .eq('app_id', APPNAME)
      .single()
      .throwOnError()
    expect(error).toBeNull()
    expect(data?.disable_auto_update).toBe('major')
  })

  it.concurrent('should set channel for dev environment', async () => {
    const testChannelName = generateChannelName()
    await createChannel(testChannelName, APPNAME)

    const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ dev: true } })
    expect(result.success).toBe(true)

    // Verify in database
    const { data, error } = await getSupabaseClient()
      .from('channels')
      .select('*')
      .eq('name', testChannelName)
      .eq('app_id', APPNAME)
      .single()
      .throwOnError()
    expect(error).toBeNull()
    expect(data?.allow_dev).toBe(true)
  })

  it.concurrent('should set channel for emulator environment', async () => {
    const testChannelName = generateChannelName()
    await createChannel(testChannelName, APPNAME)

    const result = await createTestSDK().updateChannel({ channelId: testChannelName, appId: APPNAME, bundle: undefined, ...{ emulator: true } })
    expect(result.success).toBe(true)

    // Verify in database
    const { data, error } = await getSupabaseClient()
      .from('channels')
      .select('*')
      .eq('name', testChannelName)
      .eq('app_id', APPNAME)
      .single()
      .throwOnError()
    expect(error).toBeNull()
    expect(data?.allow_emulator).toBe(true)
  })

  describe.concurrent('channel info operations', () => {
    it.concurrent('should get current bundle of channel', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const sdk = createTestSDK()
      const result = await sdk.getCurrentBundle(APPNAME, channelName)

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('version:app_versions!channels_version_fkey(name)')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(result.data).toBe(data?.version?.name)
    })

    it.concurrent('should fail to get bundle for non-existent channel', async () => {
      const testInvalidChannel = generateChannelName()

      const sdk = createTestSDK()
      const result = await sdk.getCurrentBundle(APPNAME, testInvalidChannel)

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe.concurrent('combined operations', () => {
    it.concurrent('should set multiple properties in a single command', async () => {
      const testChannelName = generateChannelName()
      await createChannel(testChannelName, APPNAME)

      const result = await createTestSDK().updateChannel({
        channelId: testChannelName,
        appId: APPNAME,
        state: 'default',
        downgrade: true,
        ios: true,
      })
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', testChannelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()
      expect(error).toBeNull()
      expect(data?.public).toBe(true)
      expect(data?.disable_auto_update_under_native).toBe(false)
      expect(data?.ios).toBe(true)
    })
  })

  describe.concurrent('channel deletion', () => {
    it.concurrent('should delete a channel', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const result = await createTestSDK().deleteChannel(channelName, APPNAME, false)
      expect(result.success).toBe(true)

      // Verify in database
      const { data, error } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
      expect(error).toBeDefined()
      expect(data).toBeNull()
    })

    it.concurrent('should delete channel and associated channel_devices', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      // Get the channel ID
      const { data: channelData } = await getSupabaseClient()
        .from('channels')
        .select('id')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
        .throwOnError()

      const channelId = channelData!.id

      // Create some channel_devices
      const deviceIds = [randomUUID(), randomUUID(), randomUUID()]
      for (const deviceId of deviceIds) {
        await getSupabaseClient()
          .from('channel_devices')
          .insert({
            channel_id: channelId,
            device_id: deviceId,
            app_id: APPNAME,
            owner_org: seedOptions.orgId,
          })
          .throwOnError()
      }

      // Verify channel_devices were created
      const { data: devicesBefore } = await getSupabaseClient()
        .from('channel_devices')
        .select('*')
        .eq('channel_id', channelId)
      expect(devicesBefore).toHaveLength(3)

      // Delete the channel
      const result = await createTestSDK().deleteChannel(channelName, APPNAME, false)
      expect(result.success).toBe(true)

      // Verify channel is deleted
      const { data: channelAfter, error: channelError } = await getSupabaseClient()
        .from('channels')
        .select('*')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
      expect(channelError).toBeDefined()
      expect(channelAfter).toBeNull()

      // Verify channel_devices are also deleted
      const { data: devicesAfter } = await getSupabaseClient()
        .from('channel_devices')
        .select('*')
        .eq('channel_id', channelId)
      expect(devicesAfter).toHaveLength(0)
    })

    it.concurrent('should delete channel with a channel-scoped admin key', async () => {
      const channelName = generateChannelName()
      await createChannel(channelName, APPNAME)

      const supabase = getSupabaseClient()
      const { data: app, error: appError } = await supabase
        .from('apps')
        .select('id')
        .eq('app_id', APPNAME)
        .single()
      expect(appError).toBeNull()
      expect(app?.id).toBeTruthy()

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .select('id, rbac_id')
        .eq('name', channelName)
        .eq('app_id', APPNAME)
        .single()
      expect(channelError).toBeNull()
      expect(channel?.rbac_id).toBeTruthy()

      const deviceId = randomUUID()
      await supabase
        .from('channel_devices')
        .insert({
          channel_id: channel!.id,
          device_id: deviceId,
          app_id: APPNAME,
          owner_org: seedOptions.orgId,
        })
        .throwOnError()

      const { data: channelAdminRole, error: roleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', 'channel_admin')
        .eq('scope_type', 'channel')
        .single()
      expect(roleError).toBeNull()
      expect(channelAdminRole?.id).toBeTruthy()

      const key = `channel-delete-${randomUUID()}`
      const apiKey = await createDirectApiKeyWithBindings({
        key,
        name: `Channel delete admin ${channelName}`,
        orgId: seedOptions.orgId,
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
            org_id: seedOptions.orgId,
            app_id: app!.id,
            channel_id: channel!.rbac_id,
            granted_by: apiKey.user_id,
            reason: 'CLI channel delete channel-admin regression test',
            is_direct: true,
          })
        expect(bindingError).toBeNull()

        const { data: directAllowed, error: directError } = await supabase.rpc('rbac_check_permission_direct' as any, {
          p_permission_key: 'channel.delete',
          p_user_id: apiKey.user_id,
          p_org_id: seedOptions.orgId,
          p_app_id: APPNAME,
          p_channel_id: channel!.id,
          p_apikey: resolvedKey,
        })
        expect(directError).toBeNull()
        expect(directAllowed).toBe(true)

        const result = await createTestSDK(resolvedKey).deleteChannel(channelName, APPNAME, false)
        expect(result.success, result.error).toBe(true)

        const { data: channelAfter, error: deletedChannelError } = await supabase
          .from('channels')
          .select('id')
          .eq('id', channel!.id)
          .single()
        expect(deletedChannelError).toBeDefined()
        expect(channelAfter).toBeNull()

        const { data: devicesAfter } = await supabase
          .from('channel_devices')
          .select('id')
          .eq('channel_id', channel!.id)
        expect(devicesAfter).toHaveLength(0)
      }
      finally {
        await supabase.from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
        await supabase.from('apikeys').delete().eq('id', apiKey.id)
      }
    })

    it.concurrent('should fail to delete non-existent channel', async () => {
      const testInvalidChannel = generateChannelName()
      const result = await createTestSDK().deleteChannel(testInvalidChannel, APPNAME, false)
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it.concurrent('should fail to delete channel with invalid app ID', async () => {
      const testChannelName = generateChannelName()
      const testInvalidApp = `invalid-app-${randomUUID().slice(0, 8)}`
      const result = await createTestSDK().deleteChannel(testChannelName, testInvalidApp, false)
      expect(result.success).toBe(false)
      expect(result.error).toContain('does not exist')
    })
  })

  describe('channel-admin HTTP and PostgREST isolation', () => {
    it('allows settings-only POST and DELETE for the target channel while RLS hides its sibling', async () => {
      const targetChannelName = generateChannelName()
      const siblingChannelName = generateChannelName()
      await createChannel(targetChannelName, APPNAME)
      await createChannel(siblingChannelName, APPNAME)

      const supabase = getSupabaseClient()
      const [{ data: app, error: appError }, { data: target, error: targetError }, { data: sibling, error: siblingError }, { data: channelAdminRole, error: roleError }] = await Promise.all([
        supabase.from('apps').select('id').eq('app_id', APPNAME).single(),
        supabase.from('channels').select('id, rbac_id, version').eq('app_id', APPNAME).eq('name', targetChannelName).single(),
        supabase.from('channels').select('id, rbac_id').eq('app_id', APPNAME).eq('name', siblingChannelName).single(),
        supabase.from('roles').select('id').eq('name', 'channel_admin').eq('scope_type', 'channel').single(),
      ])
      expect(appError).toBeNull()
      expect(targetError).toBeNull()
      expect(siblingError).toBeNull()
      expect(roleError).toBeNull()
      expect(app?.id).toBeTruthy()
      expect(target?.rbac_id).toBeTruthy()
      expect(channelAdminRole?.id).toBeTruthy()

      const key = `channel-http-admin-${randomUUID()}`
      const apiKey = await createDirectApiKeyWithBindings({
        key,
        name: `Channel HTTP admin ${targetChannelName}`,
        orgId: seedOptions.orgId,
        roleName: 'org_billing_admin',
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
            org_id: seedOptions.orgId,
            app_id: app!.id,
            channel_id: target!.rbac_id,
            granted_by: apiKey.user_id,
            reason: 'Channel HTTP and RLS isolation regression test',
            is_direct: true,
          })
        expect(bindingError).toBeNull()

        const scopedSupabase = createClient<Database>(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false },
          global: { headers: { capgkey: resolvedKey } },
        })
        const { data: scopedApps, error: scopedAppsError } = await scopedSupabase
          .from('apps')
          .select('app_id')
          .eq('app_id', APPNAME)
        expect(scopedAppsError).toBeNull()
        expect(scopedApps).toHaveLength(0)
        const { data: scopedChannels, error: scopedChannelsError } = await scopedSupabase
          .from('channels')
          .select('id, name')
          .eq('app_id', APPNAME)
          .in('name', [targetChannelName, siblingChannelName])
        expect(scopedChannelsError).toBeNull()
        expect(scopedChannels).toEqual([{ id: target!.id, name: targetChannelName }])

        const { error: targetUpdateError } = await scopedSupabase
          .from('channels')
          .update({ public: true })
          .eq('id', target!.id)
        expect(targetUpdateError).toBeNull()

        const { error: siblingUpdateError } = await scopedSupabase
          .from('channels')
          .update({ public: true })
          .eq('id', sibling!.id)
        expect(siblingUpdateError).toBeNull()

        const { data: siblingAfterDirectUpdate, error: siblingAfterDirectUpdateError } = await supabase
          .from('channels')
          .select('public')
          .eq('id', sibling!.id)
          .single()
        expect(siblingAfterDirectUpdateError).toBeNull()
        expect(siblingAfterDirectUpdate?.public).toBe(false)

        const postResponse = await fetch(`${BASE_URL}/channel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'capgkey': resolvedKey,
          },
          body: JSON.stringify({
            app_id: APPNAME,
            channel: targetChannelName,
            public: false,
          }),
        })
        expect(postResponse.status).toBe(200)

        const { data: targetAfterPost, error: targetAfterPostError } = await supabase
          .from('channels')
          .select('version, public')
          .eq('id', target!.id)
          .single()
        expect(targetAfterPostError).toBeNull()
        expect(targetAfterPost).toEqual({ version: target!.version, public: false })

        const deleteResponse = await fetch(`${BASE_URL}/channel?app_id=${encodeURIComponent(APPNAME)}&channel=${encodeURIComponent(targetChannelName)}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'capgkey': resolvedKey,
          },
        })
        expect(deleteResponse.status).toBe(200)

        const { data: targetAfterDelete, error: targetAfterDeleteError } = await supabase
          .from('channels')
          .select('id')
          .eq('id', target!.id)
          .maybeSingle()
        expect(targetAfterDeleteError).toBeNull()
        expect(targetAfterDelete).toBeNull()
      }
      finally {
        await supabase.from('role_bindings').delete().eq('principal_id', apiKey.rbac_id)
        await supabase.from('apikeys').delete().eq('id', apiKey.id)
      }
    })
  })
})

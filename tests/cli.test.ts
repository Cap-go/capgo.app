import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uploadBundleSDK } from './cli-sdk-utils'
import { cleanupCli, getSemver, prepareCli, tempFileFolder } from './cli-utils'
import { BASE_URL, createDirectApiKeyWithBindings, createIsolatedSeedAppOptions, getSupabaseClient, headers, NON_OWNER_ORG_ID, resetAndSeedAppData, resetAppData, resetAppDataStats, USER_ID } from './test-utils'

async function createOrgBoundApiKey(orgId: string, roleName = 'org_admin') {
  const data = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: randomUUID(),
    name: `cli-test-${randomUUID()}`,
    orgId,
    roleName,
  })

  expect(data.id).toBeTypeOf('number')
  expect(data.key).toBeTypeOf('string')
  if (!data.key)
    throw new Error('Failed to seed CLI API key')

  return {
    id: data.id,
    key: data.key,
  }
}

async function deleteScopedApiKey(id: number) {
  await fetch(`${BASE_URL}/apikey/${id}`, {
    method: 'DELETE',
    headers,
  })
}

describe('tests CLI upload', () => {
  const idSuccess = randomUUID()
  const APPNAME_success = `com.cli_${idSuccess}`
  const successSeedOptions = createIsolatedSeedAppOptions()

  beforeAll(async () => {
    await Promise.all([
      resetAndSeedAppData(APPNAME_success, successSeedOptions),
      prepareCli(APPNAME_success),
    ])
  })

  afterAll(async () => {
    await Promise.all([
      cleanupCli(APPNAME_success),
      resetAppData(APPNAME_success),
      resetAppDataStats(APPNAME_success),
    ])
  })

  it('should upload bundle successfully', async () => {
    const result = await uploadBundleSDK(APPNAME_success, getSemver(), 'production', {
      ignoreCompatibilityCheck: true,
    })
    expect(result.success).toBe(true)
  }, 60000)

  it('should link uploaded bundle to multiple comma-separated channels', async () => {
    const appName = `com.cli_multi_channel_${randomUUID()}`
    const extraChannel = `multi-${randomUUID().slice(0, 8)}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    try {
      const supabase = getSupabaseClient()
      const { data: versionData, error: versionError } = await supabase
        .from('app_versions')
        .select('id')
        .eq('app_id', appName)
        .limit(1)
        .single()

      expect(versionError).toBeNull()
      if (!versionData)
        throw new Error('Missing seeded app version')

      const { error: channelError } = await supabase
        .from('channels')
        .insert({
          name: extraChannel,
          app_id: appName,
          version: versionData.id,
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

      expect(channelError).toBeNull()

      const version = getSemver()
      const result = await uploadBundleSDK(appName, version, `production,${extraChannel}`, {
        ignoreCompatibilityCheck: true,
      })
      expect(result.success).toBe(true)

      const { data: channels, error } = await supabase
        .from('channels')
        .select('name, version(name)')
        .eq('app_id', appName)
        .in('name', ['production', extraChannel])

      expect(error).toBeNull()
      const versionsByChannel = new Map((channels ?? []).map(row => [row.name, (row.version as any)?.name]))
      expect(versionsByChannel.get('production')).toBe(version)
      expect(versionsByChannel.get(extraChannel)).toBe(version)
    }
    finally {
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)

  it('creates a missing explicit channel before assigning the uploaded bundle', async () => {
    const appName = `com.cli_new_channel_upload_${randomUUID()}`
    const targetChannel = `upload-target-${randomUUID().slice(0, 8)}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    try {
      const version = getSemver()
      const result = await uploadBundleSDK(appName, version, targetChannel, {
        ignoreCompatibilityCheck: true,
      })
      expect(result.success).toBe(true)

      const { data: channel, error } = await getSupabaseClient()
        .from('channels')
        .select('name, version(name)')
        .eq('app_id', appName)
        .eq('name', targetChannel)
        .single()

      expect(error).toBeNull()
      expect(channel?.name).toBe(targetChannel)
      expect((channel?.version as any)?.name).toBe(version)
    }
    finally {
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)

  it('allows app_uploader to pass explicit channel upload preflight', async () => {
    const appName = `com.cli_channel_preflight_${randomUUID()}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    let createdApikeyId: number | null = null
    try {
      const createdApikey = await createDirectApiKeyWithBindings({
        userId: USER_ID,
        key: randomUUID(),
        name: `cli-channel-preflight-${randomUUID()}`,
        orgId: seedOptions.orgId,
        roleName: 'apikey_org_reader',
        appId: appName,
        appRoleName: 'app_uploader',
      })
      createdApikeyId = createdApikey.id

      const version = getSemver()
      const result = await uploadBundleSDK(appName, version, 'production', {
        ignoreCompatibilityCheck: true,
        apikey: createdApikey.key ?? undefined,
      })
      expect(result.success).toBe(true)

      const { count, error } = await getSupabaseClient()
        .from('app_versions')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', appName)
        .eq('name', version)

      expect(error).toBeNull()
      expect(count).toBe(1)
    }
    finally {
      if (createdApikeyId !== null)
        await deleteScopedApiKey(createdApikeyId)
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)

  it('allows app_uploader to pass default channel upload preflight', async () => {
    const appName = `com.cli_default_channel_preflight_${randomUUID()}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    let createdApikeyId: number | null = null
    try {
      const createdApikey = await createDirectApiKeyWithBindings({
        userId: USER_ID,
        key: randomUUID(),
        name: `cli-default-channel-preflight-${randomUUID()}`,
        orgId: seedOptions.orgId,
        roleName: 'apikey_org_reader',
        appId: appName,
        appRoleName: 'app_uploader',
      })
      createdApikeyId = createdApikey.id

      const version = getSemver()
      const result = await uploadBundleSDK(appName, version, undefined, {
        ignoreCompatibilityCheck: true,
        apikey: createdApikey.key ?? undefined,
      })
      expect(result.success).toBe(true)

      const { count, error } = await getSupabaseClient()
        .from('app_versions')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', appName)
        .eq('name', version)

      expect(error).toBeNull()
      expect(count).toBe(1)
    }
    finally {
      if (createdApikeyId !== null)
        await deleteScopedApiKey(createdApikeyId)
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)

  it('does not create a missing explicit channel when create-channel preflight fails', async () => {
    const appName = `com.cli_channel_no_orphan_${randomUUID()}`
    const targetChannel = `upload-target-${randomUUID().slice(0, 8)}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    let createdApikeyId: number | null = null
    try {
      const createdApikey = await createDirectApiKeyWithBindings({
        userId: USER_ID,
        key: randomUUID(),
        name: `cli-channel-no-orphan-${randomUUID()}`,
        orgId: seedOptions.orgId,
        roleName: 'apikey_org_reader',
        appId: appName,
        appRoleName: 'app_uploader',
      })
      createdApikeyId = createdApikey.id

      const result = await uploadBundleSDK(appName, getSemver(), targetChannel, {
        ignoreCompatibilityCheck: true,
        apikey: createdApikey.key ?? undefined,
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('app.create_channel')

      const { count, error } = await getSupabaseClient()
        .from('channels')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', appName)
        .eq('name', targetChannel)

      expect(error).toBeNull()
      expect(count).toBe(0)
    }
    finally {
      if (createdApikeyId !== null)
        await deleteScopedApiKey(createdApikeyId)
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)

  it('fails self-assign upload before creating a bundle when channel settings permission is missing', async () => {
    const appName = `com.cli_self_assign_preflight_${randomUUID()}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    let createdApikeyId: number | null = null
    try {
      const createdApikey = await createDirectApiKeyWithBindings({
        userId: USER_ID,
        key: randomUUID(),
        name: `cli-self-assign-preflight-${randomUUID()}`,
        orgId: seedOptions.orgId,
        roleName: 'org_member',
        appId: appName,
        appRoleName: 'app_developer',
      })
      createdApikeyId = createdApikey.id

      const version = getSemver()
      const result = await uploadBundleSDK(appName, version, 'production', {
        ignoreCompatibilityCheck: true,
        selfAssign: true,
        apikey: createdApikey.key ?? undefined,
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('channel.update_settings')

      const { count, error } = await getSupabaseClient()
        .from('app_versions')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', appName)
        .eq('name', version)

      expect(error).toBeNull()
      expect(count).toBe(0)
    }
    finally {
      if (createdApikeyId !== null)
        await deleteScopedApiKey(createdApikeyId)
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)

  it('should not upload same hash twice', async () => {
    const appName = `com.cli_duplicate_${randomUUID()}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(appName, seedOptions),
      prepareCli(appName),
    ])

    try {
      // First upload
      const version = getSemver()
      const firstUpload = await uploadBundleSDK(appName, version, 'production', {
        ignoreCompatibilityCheck: true,
      })
      expect(firstUpload.success).toBe(true)

      // Second upload with same content should be skipped
      const result2 = await uploadBundleSDK(appName, version, 'production', {
        ignoreCompatibilityCheck: true,
      })
      expect(result2.success).toBe(false)
      expect(
        result2.error?.includes('same bundle content')
        || result2.error?.includes('already exists'),
      ).toBe(true)
    }
    finally {
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }
  }, 60000)
})

describe('tests CLI upload options in parallel', () => {
  const sharedId = randomUUID()
  const SHARED_APPNAME = `com.cli_shared_${sharedId}`

  interface PreparedCliApp {
    id: string
    APPNAME: string
    seedOptions: ReturnType<typeof createIsolatedSeedAppOptions>
  }

  const sharedSeedOptions = createIsolatedSeedAppOptions()

  // Use Maps with unique keys for atomic access in concurrent tests
  const fileTestApps = new Map<string, PreparedCliApp>()
  const apiTestApps = new Map<string, PreparedCliApp>()
  const usedApps: Array<string> = []

  const prepareApp = async () => {
    const id = randomUUID()
    const APPNAME = `com.cli_ccr_${id}`
    const seedOptions = createIsolatedSeedAppOptions()
    await Promise.all([
      resetAndSeedAppData(APPNAME, seedOptions),
      prepareCli(APPNAME),
    ])
    return { id, APPNAME, seedOptions }
  }

  beforeAll(async () => {
    const promises = []

    promises.push(Promise.all([
      resetAndSeedAppData(SHARED_APPNAME, sharedSeedOptions),
      prepareCli(SHARED_APPNAME),
    ]))

    // Use unique keys for each test that needs an app
    promises.push(prepareApp().then(app => fileTestApps.set('code-check', app)))
    promises.push(prepareApp().then(app => apiTestApps.set('org-limited', app)))
    promises.push(prepareApp().then(app => apiTestApps.set('wrong-org', app)))

    await Promise.all(promises)
  })

  afterAll(async () => {
    const allApps = [SHARED_APPNAME, ...usedApps]

    await Promise.all(allApps.map(async (appName) => {
      await Promise.all([
        cleanupCli(appName),
        resetAppData(appName),
        resetAppDataStats(appName),
      ])
    }))
  })

  it.concurrent('test code check (missing notifyAppReady)', async () => {
    const app = fileTestApps.get('code-check')
    if (!app)
      throw new Error('No file test app available for code-check test')
    usedApps.push(app.APPNAME)

    const semver = getSemver()
    writeFileSync(join(tempFileFolder(app.APPNAME), 'dist', 'index.js'), 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\';\nconsole.log("Hello world!!!");')

    const result = await uploadBundleSDK(app.APPNAME, semver, 'production', {
      ignoreCompatibilityCheck: true,
      disableCodeCheck: false, // Enable code check for this test
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('notifyAppReady')
  }, 60000)

  it('test --min-update-version', async () => {
    const semver = getSemver()
    const result = await uploadBundleSDK(SHARED_APPNAME, semver, 'production', {
      ignoreCompatibilityCheck: true,
      minUpdateVersion: '1.0.0',
    })
    expect(result.success).toBe(true)

    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from('app_versions')
      .select('min_update_version')
      .eq('name', semver)
      .eq('app_id', SHARED_APPNAME)
      .single()

    expect(error).toBeNull()
    expect(data?.min_update_version).toBe('1.0.0')
  }, 60000)

  it('cannot upload with wrong api key', async () => {
    const testApiKey = randomUUID()
    const semver = getSemver()
    const result = await uploadBundleSDK(SHARED_APPNAME, semver, 'production', {
      ignoreCompatibilityCheck: true,
      apikey: testApiKey,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid API key')
  }, 60000)

  it.concurrent('should test upload with org-limited API key', async () => {
    const app = apiTestApps.get('org-limited')
    if (!app)
      throw new Error('No API test app available for org-limited test')
    usedApps.push(app.APPNAME)

    const semver = getSemver()
    let createdApikeyId: number | null = null
    let createdPlainKey: string | null = null

    try {
      const createdApikey = await createOrgBoundApiKey(app.seedOptions.orgId)
      createdApikeyId = createdApikey.id
      createdPlainKey = createdApikey.key

      const result = await uploadBundleSDK(app.APPNAME, semver, 'production', {
        ignoreCompatibilityCheck: true,
        apikey: createdPlainKey as string,
      })
      expect(result.success).toBe(true)
    }
    finally {
      if (createdApikeyId !== null)
        await deleteScopedApiKey(createdApikeyId)
    }
  }, 60000)

  it.concurrent('should fail upload with wrong org-limited API key', async () => {
    const app = apiTestApps.get('wrong-org')
    if (!app)
      throw new Error('No API test app available for wrong-org test')
    usedApps.push(app.APPNAME)

    const semver = getSemver()
    let createdApikeyId: number | null = null
    let createdPlainKey: string | null = null

    try {
      const createdApikey = await createOrgBoundApiKey(NON_OWNER_ORG_ID, 'org_member')
      createdApikeyId = createdApikey.id
      createdPlainKey = createdApikey.key

      const result = await uploadBundleSDK(app.APPNAME, semver, 'production', {
        ignoreCompatibilityCheck: true,
        apikey: createdPlainKey as string,
      })
      expect(result.success).toBe(false)
      // Error message can vary - either explicit org mismatch or generic permission error
      expect(
        result.error?.includes('Cannot get organization id for app id')
        || result.error?.includes('Invalid API key or insufficient permissions'),
      ).toBe(true)
    }
    finally {
      if (createdApikeyId !== null)
        await deleteScopedApiKey(createdApikeyId)
    }
  }, 60000)
})

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { APP_NAME_STATS, appApiKeyBindings, BASE_URL, createDirectApiKeyWithBindings, getAuthHeadersForCredentials, getSupabaseClient, headersStats, ORG_ID_STATS, USER_ID_STATS } from './test-utils.ts'

function hasSeededStats(statsData: unknown) {
  if (!Array.isArray(statsData))
    return false

  return statsData.some((stat: any) =>
    (stat.mau ?? 0) > 0
    || (stat.storage ?? 0) > 0
    || (stat.bandwidth ?? 0) > 0
    || (stat.get ?? 0) > 0,
  )
}

async function deleteApikeyById(id: number) {
  await getSupabaseClient()
    .from('apikeys')
    .delete()
    .eq('id', id)
    .throwOnError()
}

async function createStatsSiblingApp(appId: string) {
  await getSupabaseClient()
    .from('apps')
    .insert({
      app_id: appId,
      icon_url: '',
      name: 'Stats sibling oracle test app',
      last_version: '1.0.0',
      updated_at: new Date().toISOString(),
      owner_org: ORG_ID_STATS,
      user_id: USER_ID_STATS,
    })
    .throwOnError()
}

async function deleteAppByAppId(appId: string) {
  await getSupabaseClient()
    .from('apps')
    .delete()
    .eq('app_id', appId)
    .throwOnError()
}

async function createStatsAppReadKey(name: string) {
  const keyData = await createDirectApiKeyWithBindings({
    userId: USER_ID_STATS,
    key: randomUUID(),
    name,
    orgId: ORG_ID_STATS,
    roleName: 'org_member',
    appId: APP_NAME_STATS,
    appRoleName: 'app_reader',
  })

  return keyData.id
}

describe('[GET] /statistics operations with and without subkey', () => {
  const APPNAME = APP_NAME_STATS // Use the seeded stats app
  let subkeyId = 0

  afterAll(async () => {
    if (subkeyId)
      await deleteApikeyById(subkeyId)
  })

  it('should get app statistics without subkey', async () => {
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getStats = await fetch(`${BASE_URL}/statistics/app/${APPNAME}?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: headersStats,
    })
    expect(getStats.status).toBe(200)
    const statsData = await getStats.json()
    expect(Array.isArray(statsData)).toBe(true)
    expect(hasSeededStats(statsData)).toBe(true)
  })

  it('should get organization statistics without subkey', async () => {
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getOrgStats = await fetch(`${BASE_URL}/statistics/org/${ORG_ID_STATS}?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: headersStats,
    })
    const orgStatsData = await getOrgStats.json()
    expect(getOrgStats.status, JSON.stringify(orgStatsData)).toBe(200)
    expect(Array.isArray(orgStatsData)).toBe(true)
    expect(hasSeededStats(orgStatsData)).toBe(true)
  })

  it('should get organization statistics breakdown without subkey', async () => {
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getOrgStats = await fetch(`${BASE_URL}/statistics/org/${ORG_ID_STATS}?from=${fromDate}&to=${toDate}&breakdown=true&noAccumulate=true`, {
      method: 'GET',
      headers: headersStats,
    })
    expect(getOrgStats.status).toBe(200)
    const orgStatsData = await getOrgStats.json() as { global: any[], byApp: any[] }
    expect(Array.isArray(orgStatsData.global)).toBe(true)
    expect(Array.isArray(orgStatsData.byApp)).toBe(true)
    expect(hasSeededStats(orgStatsData.global)).toBe(true)
    expect(orgStatsData.byApp.some(stat => stat.app_id === APPNAME)).toBe(true)
  })

  it('should get organization statistics breakdown with jwt', async () => {
    const authHeaders = await getAuthHeadersForCredentials('stats@capgo.app', 'testtest')
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getOrgStats = await fetch(`${BASE_URL}/statistics/org/${ORG_ID_STATS}?from=${fromDate}&to=${toDate}&breakdown=true&noAccumulate=true`, {
      method: 'GET',
      headers: authHeaders,
    })
    expect(getOrgStats.status).toBe(200)
    const orgStatsData = await getOrgStats.json() as { global: any[], byApp: any[] }
    expect(Array.isArray(orgStatsData.global)).toBe(true)
    expect(Array.isArray(orgStatsData.byApp)).toBe(true)
    expect(hasSeededStats(orgStatsData.global)).toBe(true)
    expect(orgStatsData.byApp.some(stat => stat.app_id === APPNAME)).toBe(true)
  })

  it('should get user statistics without subkey', async () => {
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getUserStats = await fetch(`${BASE_URL}/statistics/user?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: headersStats,
    })
    expect(getUserStats.status).toBe(200)
    const userStatsData = await getUserStats.json()
    expect(Array.isArray(userStatsData)).toBe(true)
  })

  it('should get bundle usage statistics without subkey', async () => {
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getBundleUsage = await fetch(`${BASE_URL}/statistics/app/${APPNAME}/bundle_usage?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: headersStats,
    })
    expect(getBundleUsage.status).toBe(200)
    const bundleUsageData = await getBundleUsage.json()
    expect(bundleUsageData).toHaveProperty('labels')
    expect(bundleUsageData).toHaveProperty('datasets')
  })

  it('should get native version usage statistics without subkey', async () => {
    const prefix = `native-version-${randomUUID()}`
    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const timestamp = `${fromDate}T12:00:00.000Z`
    const versionA = `${prefix}-1.0.0`
    const versionB = `${prefix}-1.1.0`
    const iosLabel = `iOS ${versionA}`
    const androidLabel = `Android ${versionA}`
    const electronLabel = `Electron ${versionB}`

    await getSupabaseClient()
      .from('device_usage')
      .insert([
        { app_id: APPNAME, device_id: `${prefix}-a`, org_id: ORG_ID_STATS, platform: 'ios', timestamp, version_build: versionA },
        { app_id: APPNAME, device_id: `${prefix}-a`, org_id: ORG_ID_STATS, platform: 'ios', timestamp, version_build: versionA },
        { app_id: APPNAME, device_id: `${prefix}-b`, org_id: ORG_ID_STATS, platform: 'android', timestamp, version_build: versionA },
        { app_id: APPNAME, device_id: `${prefix}-c`, org_id: ORG_ID_STATS, platform: 'electron', timestamp, version_build: versionB },
      ])
      .throwOnError()

    try {
      const getNativeUsage = await fetch(`${BASE_URL}/statistics/app/${APPNAME}/native_usage?from=${fromDate}&to=${toDate}`, {
        method: 'GET',
        headers: headersStats,
      })
      expect(getNativeUsage.status).toBe(200)
      const nativeUsageData = await getNativeUsage.json() as { labels: string[], datasets: Array<{ label: string, metaCounts: number[] }> }
      expect(nativeUsageData).toHaveProperty('labels')
      expect(nativeUsageData).toHaveProperty('datasets')

      if (process.env.USE_CLOUDFLARE_WORKERS !== 'true') {
        const dayIndex = nativeUsageData.labels.indexOf(fromDate)
        const iosVersion = nativeUsageData.datasets.find(dataset => dataset.label === iosLabel)
        const androidVersion = nativeUsageData.datasets.find(dataset => dataset.label === androidLabel)
        const electronVersion = nativeUsageData.datasets.find(dataset => dataset.label === electronLabel)
        expect(dayIndex).toBeGreaterThanOrEqual(0)
        expect(iosVersion?.metaCounts[dayIndex]).toBe(1)
        expect(androidVersion?.metaCounts[dayIndex]).toBe(1)
        expect(electronVersion?.metaCounts[dayIndex]).toBe(1)
      }
    }
    finally {
      await getSupabaseClient()
        .from('device_usage')
        .delete()
        .like('device_id', `${prefix}%`)
        .throwOnError()
    }
  })

  it('should seed app-bound key for statistics checks', async () => {
    subkeyId = await createStatsAppReadKey('Stats app-bound key')
    expect(subkeyId).toBeTypeOf('number')
  })

  it('should get app statistics with subkey', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getStats = await fetch(`${BASE_URL}/statistics/app/${APPNAME}?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getStats.status).toBe(200)
    const statsData = await getStats.json()
    expect(Array.isArray(statsData)).toBe(true)
    expect(hasSeededStats(statsData)).toBe(true)
  })

  it.concurrent('should not reveal sibling app existence outside an app-limited subkey', async () => {
    const localSubkey = { id: await createStatsAppReadKey('Stats oracle app-bound key') }
    const siblingApp = `com.stats.oracle.${randomUUID().replaceAll('-', '')}`
    const fakeApp = `com.stats.fake.${randomUUID().replaceAll('-', '')}`

    try {
      await createStatsSiblingApp(siblingApp)
      const subkeyHeaders = { 'x-limited-key-id': String(localSubkey.id) }
      const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const toDate = new Date().toISOString().split('T')[0]
      const headers = { ...headersStats, ...subkeyHeaders }
      const [realSiblingStats, fakeStats] = await Promise.all([
        fetch(`${BASE_URL}/statistics/app/${siblingApp}?from=${fromDate}&to=${toDate}`, {
          method: 'GET',
          headers,
        }),
        fetch(`${BASE_URL}/statistics/app/${fakeApp}?from=${fromDate}&to=${toDate}`, {
          method: 'GET',
          headers,
        }),
      ])

      expect(realSiblingStats.status).toBe(401)
      expect(fakeStats.status).toBe(401)
      const realSiblingData = await realSiblingStats.json<{ error: string }>()
      const fakeData = await fakeStats.json<{ error: string }>()
      expect(realSiblingData.error).toBe('no_access_to_app')
      expect(fakeData.error).toBe('no_access_to_app')
    }
    finally {
      await deleteAppByAppId(siblingApp)
      await deleteApikeyById(localSubkey.id)
    }
  })

  it('should get organization statistics with subkey', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getOrgStats = await fetch(`${BASE_URL}/statistics/org/${ORG_ID_STATS}?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getOrgStats.status).toBe(200)
  })

  it('should get user statistics with subkey', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getUserStats = await fetch(`${BASE_URL}/statistics/user?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getUserStats.status).toBe(200)
    const userStatsData = await getUserStats.json()
    expect(Array.isArray(userStatsData)).toBe(true)
  })

  it('should get bundle usage statistics with subkey', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getBundleUsage = await fetch(`${BASE_URL}/statistics/app/${APPNAME}/bundle_usage?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getBundleUsage.status).toBe(200)
    const bundleUsageData = await getBundleUsage.json()
    expect(bundleUsageData).toHaveProperty('labels')
    expect(bundleUsageData).toHaveProperty('datasets')
  })

  it('should get native version usage statistics with subkey', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const getNativeUsage = await fetch(`${BASE_URL}/statistics/app/${APPNAME}/native_usage?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getNativeUsage.status).toBe(200)
    const nativeUsageData = await getNativeUsage.json()
    expect(nativeUsageData).toHaveProperty('labels')
    expect(nativeUsageData).toHaveProperty('datasets')
  })

  it('should fail to get app statistics with subkey for app not belonging to user', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const nonUserApp = 'com.nonuser.app'
    const getStats = await fetch(`${BASE_URL}/statistics/app/${nonUserApp}?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getStats.status).toBe(401)
    const statsData = await getStats.json()
    expect(statsData).toHaveProperty('error', 'no_access_to_app')
  })

  it('should fail to get organization statistics with subkey for org not belonging to user', async () => {
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const toDate = new Date().toISOString().split('T')[0]
    const nonUserOrg = 'non-user-org-id'
    const getOrgStats = await fetch(`${BASE_URL}/statistics/org/${nonUserOrg}?from=${fromDate}&to=${toDate}`, {
      method: 'GET',
      headers: { ...headersStats, ...subkeyHeaders },
    })
    expect(getOrgStats.status).toBe(401)
    const orgStatsData = await getOrgStats.json<{ error: string }>()
    expect(orgStatsData.error).toBe('no_access_to_organization')
  })

  it('rejects nested API key creation from API key auth for org bindings', async () => {
    const limitedKey = randomUUID()
    const keyData = await createDirectApiKeyWithBindings({
      userId: USER_ID_STATS,
      key: limitedKey,
      name: `Nested create blocked org ${limitedKey}`,
      orgId: ORG_ID_STATS,
      roleName: 'org_member',
    })

    if (!keyData.key)
      throw new Error('Expected plain API key value')

    try {
      const createSubkey = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': keyData.key!,
        },
        body: JSON.stringify({
          name: 'Nested Stats Org Key',
          bindings: [{
            role_name: 'org_member',
            scope_type: 'org',
            org_id: ORG_ID_STATS,
          }],
        }),
      })
      expect(createSubkey.status).toBe(400)
      const subkeyData = await createSubkey.json<{ error: string }>()
      expect(subkeyData.error).toBe('cannot_create_apikey')
    }
    finally {
      await deleteApikeyById(keyData.id)
    }
  })

  it('rejects nested API key creation from API key auth for app bindings', async () => {
    const limitedKey = randomUUID()
    const keyData = await createDirectApiKeyWithBindings({
      userId: USER_ID_STATS,
      key: limitedKey,
      name: `Nested create blocked app ${limitedKey}`,
      orgId: ORG_ID_STATS,
      roleName: 'org_member',
      appId: APPNAME,
      appRoleName: 'app_reader',
    })

    if (!keyData.key)
      throw new Error('Expected plain API key value')

    try {
      const createSubkey = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': keyData.key!,
        },
        body: JSON.stringify({
          name: 'Nested Stats App Key',
          bindings: await appApiKeyBindings(APPNAME, 'app_reader'),
        }),
      })
      expect(createSubkey.status).toBe(400)
      const subkeyData = await createSubkey.json<{ error: string }>()
      expect(subkeyData.error).toBe('cannot_create_apikey')
    }
    finally {
      await deleteApikeyById(keyData.id)
    }
  })
})

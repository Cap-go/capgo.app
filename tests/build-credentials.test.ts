import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, createDirectApiKeyWithBindings, getSupabaseClient, resetAndSeedAppData, resetAppData, USER_ID_2 } from './test-utils.ts'

// Dedicated app/org per run: these tests write stored credentials for their own app only.
describe('/build/credentials stored native build credentials', () => {
  const id = randomUUID()
  const appId = `com.test.buildcreds.${id}`
  const orgId = randomUUID()
  const userId = USER_ID_2
  const stripeCustomerId = `cus_buildcreds_${id.replaceAll('-', '').slice(0, 16)}`

  const certSecret = `cert-secret-${id}`
  const keystoreSecret = `keystore-secret-${id}`
  const provisioningMap = JSON.stringify({ [appId]: { profile: Buffer.from('profile').toString('base64'), name: 'Test Profile' } })

  let adminKey = ''
  let developerKey = ''
  let apikeyIds: number[] = []

  function headers(key: string) {
    return { 'Authorization': key, 'Content-Type': 'application/json' }
  }

  async function putCredentials(key: string, body: Record<string, unknown>) {
    return fetch(`${BASE_URL}/build/credentials`, { method: 'PUT', headers: headers(key), body: JSON.stringify(body) })
  }

  beforeAll(async () => {
    await resetAndSeedAppData(appId, { orgId, userId, stripeCustomerId })
    const admin = await createDirectApiKeyWithBindings({
      userId,
      key: randomUUID(),
      name: `test-build-credentials-admin-${id}`,
      orgId,
      roleName: 'org_member',
      appId,
      appRoleName: 'app_admin',
    })
    const developer = await createDirectApiKeyWithBindings({
      userId,
      key: randomUUID(),
      name: `test-build-credentials-developer-${id}`,
      orgId,
      roleName: 'org_member',
      appId,
      appRoleName: 'app_developer',
    })
    if (!admin?.key || !developer?.key)
      throw new Error('Seeded API keys missing generated key values')
    adminKey = admin.key
    developerKey = developer.key
    apikeyIds = [admin.id, developer.id]
  })

  afterAll(async () => {
    const supabase = getSupabaseClient()
    await supabase.from('app_build_credentials').delete().eq('app_id', appId)
    await supabase.from('build_credentials_upload_token_uses').delete().eq('app_id', appId)
    if (apikeyIds.length)
      await supabase.from('apikeys').delete().in('id', apikeyIds)
    await resetAppData(appId)
  })

  it('stores, summarizes, merges, uploads by signed URL and deletes credentials', async () => {
    // Empty state is readable with app.build_native.
    let response = await fetch(`${BASE_URL}/build/credentials?app_id=${encodeURIComponent(appId)}`, { headers: headers(developerKey) })
    expect(response.status).toBe(200)
    let status = await response.json() as { platforms: Array<{ platform: string, configured: boolean, summary?: Record<string, unknown> }> }
    expect(status.platforms).toEqual([{ platform: 'ios', configured: false }, { platform: 'android', configured: false }])

    // Writing needs app.update_settings: app_developer is denied.
    response = await putCredentials(developerKey, { app_id: appId, platform: 'ios', credentials: { BUILD_CERTIFICATE_BASE64: certSecret } })
    expect(response.status).toBe(403)
    expect(await response.json()).toHaveProperty('error', 'permission_denied')

    // Invalid key names are rejected with the --build-env message.
    response = await putCredentials(adminKey, { app_id: appId, platform: 'ios', credentials: { JOB_ID: 'x' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_build_credentials', message: '--build-env JOB_ID: reserved by Capgo; use the dedicated build option instead' })

    // Loader/interpreter env names would run in every later build: never stored.
    response = await putCredentials(adminKey, { app_id: appId, platform: 'ios', credentials: { NODE_OPTIONS: '--require /tmp/x.js', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', SENTRY_AUTH_TOKEN: 'ok' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_build_credentials', message: expect.stringContaining('DYLD_INSERT_LIBRARIES, NODE_OPTIONS: cannot be stored on Capgo') })

    // Partial iOS set is stored; summary reports what is still missing, never values.
    response = await putCredentials(adminKey, {
      app_id: appId,
      platform: 'ios',
      credentials: { BUILD_CERTIFICATE_BASE64: certSecret, P12_PASSWORD: 'p12', CAPGO_IOS_PROVISIONING_MAP: provisioningMap, CAPGO_IOS_DISTRIBUTION: 'ad_hoc' },
    })
    expect(response.status).toBe(200)
    let text = await response.text()
    expect(text).not.toContain(certSecret)
    let write = JSON.parse(text) as { summary: { keys: string[], missing: string[], ios_distribution: string } }
    expect(write.summary.ios_distribution).toBe('ad_hoc')
    expect(write.summary.missing).toEqual(['APP_STORE_CONNECT_TEAM_ID (or --app-store-connect-team-id)'])

    // Merge adds the team id while keeping the stored certificate.
    response = await putCredentials(adminKey, { app_id: appId, platform: 'ios', mode: 'merge', credentials: { APP_STORE_CONNECT_TEAM_ID: 'TEAM123' } })
    expect(response.status).toBe(200)
    write = await response.json() as typeof write
    expect(write.summary.keys).toEqual(expect.arrayContaining(['BUILD_CERTIFICATE_BASE64', 'APP_STORE_CONNECT_TEAM_ID']))
    expect(write.summary.missing).toEqual([])

    // The database row only holds ciphertext.
    const { data: row } = await getSupabaseClient().from('app_build_credentials').select('ciphertext, key_version, owner_org').eq('app_id', appId).eq('platform', 'ios').single()
    expect(row?.owner_org).toBe(orgId)
    expect(row?.ciphertext).toMatch(/^v1:/)
    expect(row?.ciphertext).not.toContain(certSecret)

    // Summary GET for a developer, still no secrets.
    response = await fetch(`${BASE_URL}/build/credentials?app_id=${encodeURIComponent(appId)}`, { headers: headers(developerKey) })
    text = await response.text()
    expect(text).not.toContain(certSecret)
    status = JSON.parse(text)
    expect(status.platforms[0]).toMatchObject({ platform: 'ios', configured: true })

    // Signed upload URL: token-only PUT of the whole CLI credentials file shape.
    response = await fetch(`${BASE_URL}/build/credentials/upload-url`, { method: 'POST', headers: headers(adminKey), body: JSON.stringify({ app_id: appId, platform: 'android' }) })
    expect(response.status).toBe(200)
    const upload = await response.json() as { upload_url: string, method: string, expires_at: string }
    expect(upload.method).toBe('PUT')
    const token = upload.upload_url.split('/build/credentials/upload/')[1]!
    response = await fetch(`${BASE_URL}/build/credentials/upload/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        [appId]: { android: { ANDROID_KEYSTORE_FILE: keystoreSecret, KEYSTORE_KEY_ALIAS: 'alias', KEYSTORE_STORE_PASSWORD: 'pw', PLAY_CONFIG_JSON: 'play' } },
        'com.unrelated.app': { android: { ANDROID_KEYSTORE_FILE: 'ignored' } },
      }),
    })
    expect(response.status).toBe(200)
    text = await response.text()
    expect(text).not.toContain(keystoreSecret)
    expect(JSON.parse(text)).toMatchObject({ platform: 'android', summary: { missing: [], play_store_upload: true } })

    // Single use: replaying the same URL is refused, even with a valid body.
    response = await fetch(`${BASE_URL}/build/credentials/upload/${token}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ android: { ANDROID_KEYSTORE_FILE: 'replayed', KEYSTORE_KEY_ALIAS: 'alias', KEYSTORE_STORE_PASSWORD: 'pw' } }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toHaveProperty('error', 'upload_url_used')

    // A rejected body does not burn the URL: the fixed file can be re-sent.
    response = await fetch(`${BASE_URL}/build/credentials/upload-url`, { method: 'POST', headers: headers(adminKey), body: JSON.stringify({ app_id: appId, platform: 'android', mode: 'merge' }) })
    const retryToken = (await response.json() as { upload_url: string }).upload_url.split('/build/credentials/upload/')[1]!
    response = await fetch(`${BASE_URL}/build/credentials/upload/${retryToken}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ LD_PRELOAD: '/tmp/x.so' }) })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_build_credentials', message: expect.stringContaining('LD_PRELOAD: cannot be stored on Capgo') })
    response = await fetch(`${BASE_URL}/build/credentials/upload/${retryToken}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ PLAY_STORE_TRACK: 'beta' }) })
    expect(response.status).toBe(200)

    response = await fetch(`${BASE_URL}/build/credentials/upload/${token.slice(0, -2)}xx`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(401)

    // Audit rows carry summaries only.
    const { data: audits } = await getSupabaseClient().from('audit_logs').select('operation, new_record').eq('table_name', 'app_build_credentials').eq('org_id', orgId)
    expect(audits?.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(audits)).not.toContain(certSecret)
    expect(JSON.stringify(audits)).not.toContain(keystoreSecret)

    // Delete is admin-only and 404s once gone.
    response = await fetch(`${BASE_URL}/build/credentials`, { method: 'DELETE', headers: headers(developerKey), body: JSON.stringify({ app_id: appId, platform: 'android' }) })
    expect(response.status).toBe(403)
    response = await fetch(`${BASE_URL}/build/credentials`, { method: 'DELETE', headers: headers(adminKey), body: JSON.stringify({ app_id: appId, platform: 'android' }) })
    expect(response.status).toBe(200)
    response = await fetch(`${BASE_URL}/build/credentials`, { method: 'DELETE', headers: headers(adminKey), body: JSON.stringify({ app_id: appId, platform: 'android' }) })
    expect(response.status).toBe(404)
  })

  it('POST /build/request with use_stored_credentials requires app admin rights', async () => {
    // app_developer has app.build_native but not app.update_settings: build scripts in the
    // uploaded project could read the stored signing secrets, so the request is refused.
    const response = await fetch(`${BASE_URL}/build/request`, {
      method: 'POST',
      headers: headers(developerKey),
      body: JSON.stringify({ app_id: appId, platform: 'ios', use_stored_credentials: true, build_options: {}, build_credentials: {} }),
    })
    expect(response.status).toBe(403)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('permission_denied')
    expect(body.message).toContain('requires app admin rights (app.update_settings)')
    expect(body.message).toContain('Ask an app admin to run this build, or provide the signing credentials directly')
  })

  it('POST /build/request with use_stored_credentials validates the merged set', async () => {
    // No stored android credentials (other test deletes them; ios-only seed here keeps this independent).
    let response = await fetch(`${BASE_URL}/build/request`, {
      method: 'POST',
      headers: headers(adminKey),
      body: JSON.stringify({ app_id: appId, platform: 'android', use_stored_credentials: true, build_options: {}, build_credentials: {} }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error', 'build_credentials_not_found')

    // Stored iOS set + request override that makes it invalid -> CLI-style message.
    const put = await putCredentials(adminKey, {
      app_id: appId,
      platform: 'ios',
      credentials: { BUILD_CERTIFICATE_BASE64: certSecret, CAPGO_IOS_PROVISIONING_MAP: provisioningMap, CAPGO_IOS_DISTRIBUTION: 'ad_hoc', APP_STORE_CONNECT_TEAM_ID: 'TEAM123' },
    })
    expect(put.status).toBe(200)
    response = await fetch(`${BASE_URL}/build/request`, {
      method: 'POST',
      headers: headers(adminKey),
      body: JSON.stringify({ app_id: appId, platform: 'ios', use_stored_credentials: true, build_options: { submitToStoreReview: true }, build_credentials: {} }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('invalid_build_credentials')
    expect(body.message).toContain('--submit-to-store-review on iOS requires --ios-distribution app_store')
    expect(body.message).not.toContain(certSecret)
  })
})

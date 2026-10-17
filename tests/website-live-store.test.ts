import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { encode } from 'fast-png'
import forge from 'node-forge'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APIKEY_MANAGEMENT_ORG_SUPER_ADMIN, APIKEY_TEST_UPLOAD, BASE_URL, fetchTestRequest, getSupabaseClient, headers, resetAndSeedAppData, resetAppData } from './test-utils.ts'

const id = randomUUID().replaceAll('-', '').slice(0, 12)
const APP_ID = `com.wlstore.app${id}`
const CLASSIC_APP_ID = `com.wlstore.classic${id}`
// Super admin of another organization, and an uploader of this one.
const otherOrgHeaders = { ...headers, Authorization: APIKEY_MANAGEMENT_ORG_SUPER_ADMIN }
const uploaderHeaders = { ...headers, Authorization: APIKEY_TEST_UPLOAD }

function storeUrl(path = '', query?: Record<string, string>) {
  const url = new URL(`${BASE_URL}/website_live_store${path}`)
  for (const [key, value] of Object.entries(query ?? {}))
    url.searchParams.set(key, value)
  return url.toString()
}

function iconBase64(size = 600) {
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 17
    data[i + 1] = 158
    data[i + 2] = 255
    data[i + 3] = 255
  }
  return Buffer.from(encode({ width: size, height: size, data, channels: 4, depth: 8 })).toString('base64')
}

beforeAll(async () => {
  await Promise.all([resetAndSeedAppData(APP_ID), resetAndSeedAppData(CLASSIC_APP_ID)])
})

afterAll(async () => {
  await Promise.all([resetAppData(APP_ID), resetAppData(CLASSIC_APP_ID)])
})

describe('website live store publishing', () => {
  it('reports what is missing before setup', async () => {
    const response = await fetchTestRequest(storeUrl('', { app_id: APP_ID }), { headers })
    expect(response.status).toBe(200)
    const state = await response.json() as any
    expect(state.bundle_id).toBe(APP_ID)
    expect(state.credentials).toEqual({ ios: null, android: null })
    expect(state.readiness.ios.ready).toBe(false)
    expect(state.readiness.ios.missing).toEqual(expect.arrayContaining(['website_live', 'icon', 'ios_credentials']))
  })

  it('hides the setup from other organizations', async () => {
    const response = await fetchTestRequest(storeUrl('', { app_id: APP_ID }), { headers: otherOrgHeaders })
    expect(response.status).toBe(403)
  })

  it('turns on Web2App and saves the listing settings', async () => {
    const response = await fetchTestRequest(storeUrl(), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ app_id: APP_ID, website_url: 'app.example.com', app_name: 'Example & Co', version_name: '1.2.0', icon_background_color: '#119eff', force: true }),
    })
    expect(response.status).toBe(200)
    const state = await response.json() as any
    expect(state.update_mode).toBe('website')
    expect(state.website_url).toBe('https://app.example.com/')
    expect(state.config).toMatchObject({ app_name: 'Example & Co', version_name: '1.2.0', icon_background_color: '#119EFF', submit_for_review: true })

    const { data } = await getSupabaseClient().from('apps').select('update_mode, website_url').eq('app_id', APP_ID).single()
    expect(data).toEqual({ update_mode: 'website', website_url: 'https://app.example.com/' })
  })

  it('never fetches private hosts', async () => {
    for (const websiteUrl of ['https://metadata.internal/', 'https://printer.local/', 'https://localhost/']) {
      const response = await fetchTestRequest(storeUrl('/check'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ app_id: CLASSIC_APP_ID, website_url: websiteUrl }),
      })
      expect(response.status).toBe(400)
      expect((await response.json() as any).error).toBe('invalid_website_url')
    }
  })

  it('does not save a website that fails the check', async () => {
    const response = await fetchTestRequest(storeUrl(), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ app_id: CLASSIC_APP_ID, website_url: 'https://capgo-website-live-check.invalid/' }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toBe('website_not_compatible')
    expect(body.moreInfo.website_check.checks[0]).toMatchObject({ id: 'public_html', status: 'fail', essential: true })
    const { data } = await getSupabaseClient().from('apps').select('update_mode').eq('app_id', CLASSIC_APP_ID).single()
    expect(data?.update_mode).not.toBe('website')
  })

  it('rejects websites served from a sub path', async () => {
    const response = await fetchTestRequest(storeUrl(), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ app_id: CLASSIC_APP_ID, website_url: 'https://example.com/app/' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as any).error).toBe('invalid_website_url')
  })

  it('generates the icon set from one PNG', async () => {
    const response = await fetchTestRequest(storeUrl('/icon'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: APP_ID, image_base64: iconBase64() }),
    })
    expect(response.status).toBe(200)
    const state = await response.json() as any
    expect(state.icon_preview_url).toEqual(expect.any(String))
    expect(state.readiness.android.missing).toEqual(['android_credentials'])
  })

  it('rejects icons smaller than 512 pixels', async () => {
    const response = await fetchTestRequest(storeUrl('/icon'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: APP_ID, image_base64: iconBase64(256) }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as any).error).toBe('icon_too_small')
  })

  it('generates an Android upload key once and lets the owner download it', async () => {
    const response = await fetchTestRequest(storeUrl('/credentials'), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ app_id: APP_ID, platform: 'android', generate_keystore: true }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.generated_keystore.key_alias).toBe('upload')
    expect(body.state.credentials.android.metadata).toMatchObject({ key_alias: 'upload', generated: true, play_client_email: null })
    expect(JSON.stringify(body.state)).not.toContain(body.generated_keystore.password)
    expect(body.state.readiness.android.ready).toBe(true)

    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(body.generated_keystore.keystore_base64)), body.generated_keystore.password)
    expect(p12.getBags({ friendlyName: 'upload' }).friendlyName?.length).toBeGreaterThan(0)

    const again = await fetchTestRequest(storeUrl('/credentials'), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ app_id: APP_ID, platform: 'android', generate_keystore: true }),
    })
    expect(again.status).toBe(400)
    expect((await again.json() as any).error).toBe('android_keystore_exists')

    const exported = await fetchTestRequest(storeUrl('/credentials/android/export'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: APP_ID }),
    })
    expect(exported.status).toBe(200)
    expect((await exported.json() as any).keystore_base64).toBe(body.generated_keystore.keystore_base64)

    const { data } = await getSupabaseClient().from('website_live_store_credentials' as any).select('secret_ciphertext').eq('app_id', APP_ID).single()
    expect((data as any).secret_ciphertext).toMatch(/^v1:/)
    expect((data as any).secret_ciphertext).not.toContain(body.generated_keystore.password)
  })

  it('only gives the upload key to users who can build', async () => {
    for (const requestHeaders of [otherOrgHeaders, uploaderHeaders]) {
      const response = await fetchTestRequest(storeUrl('/credentials/android/export'), {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ app_id: APP_ID }),
      })
      expect(response.status).toBe(403)
    }
  })

  it('validates the Play service account file', async () => {
    const response = await fetchTestRequest(storeUrl('/credentials'), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ app_id: APP_ID, platform: 'android', play_service_account_json: '{"type":"user"}' }),
    })
    expect(response.status).toBe(400)
    expect((await response.json() as any).error).toBe('invalid_play_service_account')
  })

  it('does not publish an app that is not set up', async () => {
    const response = await fetchTestRequest(storeUrl('/publish'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ app_id: CLASSIC_APP_ID, platform: 'android' }),
    })
    expect(response.status).toBe(400)
    const body = await response.json() as any
    expect(body.error).toBe('website_live_store_not_ready')
    expect(body.moreInfo.missing).toEqual(expect.arrayContaining(['website_live', 'icon', 'android_credentials']))
  })

  it('deletes stored keys', async () => {
    const response = await fetchTestRequest(storeUrl('/credentials', { app_id: APP_ID, platform: 'android' }), { method: 'DELETE', headers })
    expect(response.status).toBe(200)
    expect((await response.json() as any).credentials.android).toBeNull()
  })
})

import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, getSupabaseClient, headers, resetAndSeedAppData, resetAppData, TEST_EMAIL, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.bundle.create.${id}`
let testOrgId: string
type AppInsert = Database['public']['Tables']['apps']['Insert']

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)

  // Create test organization
  const { data: orgData, error: orgError } = await getSupabaseClient().from('orgs').insert({
    id: randomUUID(),
    name: `Test Bundle Create Org ${id}`,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
  }).select().single()

  if (orgError)
    throw orgError
  testOrgId = orgData.id

  // Create test app
  const appInsert: AppInsert = {
    app_id: APPNAME,
    name: `Test Bundle Create App`,
    icon_url: 'https://example.com/icon.png',
    owner_org: testOrgId,
  }
  await getSupabaseClient().from('apps').insert(appInsert)
})

afterAll(async () => {
  await resetAppData(APPNAME)
  await getSupabaseClient().from('orgs').delete().eq('id', testOrgId)
})

describe('[POST] /bundle - Create Bundle with External URL', () => {
  it('should create bundle with valid GitHub ZIP URL', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        version: '1.0.0-github-zip',
        external_url: 'https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.zip', // Valid ZIP file from GitHub
      }),
    })

    // This should succeed as it's a valid HTTPS ZIP file
    expect(response.status).toBe(200)
    const data = await response.json() as { status: string, bundle: any }
    expect(data.status).toBe('success')
    expect(data.bundle).toBeTruthy()
    expect(data.bundle.name).toBe('1.0.0-github-zip')
    expect(data.bundle.external_url).toBe('https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.zip')
    expect(data.bundle.storage_provider).toBe('external')
  })

  // it.only('should reject non-ZIP files from GitHub', async () => {
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-tar-gz',
  //       external_url: 'https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.tar.gz', // tar.gz instead of zip
  //     }),
  //   })

  //   // This should fail because .tar.gz is not a ZIP file
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   console.log(data)
  //   expect(data.error).toBe('url_not_zip')
  // })

  it('should return 400 when app_id is missing', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        version: '1.0.0',
        external_url: 'https://example.com/test.zip',
        // Missing app_id
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_app_id')
  })

  it('should return 400 when version is missing', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        app_id: APPNAME,
        external_url: 'https://example.com/test.zip',
        // Missing version
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_version')
  })

  it('should return 400 when external_url is missing', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        app_id: APPNAME,
        version: '1.0.0',
        // Missing external_url
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_external_url')
  })

  it('should return 400 when URL is not HTTPS', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        app_id: APPNAME,
        version: '1.0.0-http',
        external_url: 'http://example.com/test.zip', // HTTP instead of HTTPS
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_protocol')
  })

  it('should return 400 when user cannot access the app', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        app_id: 'nonexistent.app',
        version: '1.0.0',
        external_url: 'https://example.com/test.zip',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_create_bundle')
  })

  it('should return 400 when version already exists', async () => {
    // First create a version
    const supabase = getSupabaseClient()
    await supabase
      .from('app_versions')
      .insert({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        app_id: APPNAME,
        name: '1.0.0-duplicate',
        owner_org: testOrgId,
        storage_provider: 'r2',
      })

    // Try to create the same version again
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
        app_id: APPNAME,
        version: '1.0.0-duplicate',
        external_url: 'https://example.com/test.zip',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('version_already_exists')
  })

  // it('should return 400 when URL does not point to ZIP file', async () => {
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-not-zip',
  //       external_url: 'https://httpbin.org/json', // Returns JSON, not ZIP
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   expect(['url_not_zip', 'url_fetch_error'].includes(data.error)).toBe(true)
  // })

  // it('should return 400 when URL points to HTML page', async () => {
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-html',
  //       external_url: 'https://httpbin.org/html', // Returns HTML
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   expect(['url_not_file', 'url_fetch_error'].includes(data.error)).toBe(true)
  // })

  it('should handle invalid JSON body', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  // it('should validate URL accessibility', async () => {
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-404',
  //       external_url: 'https://httpbin.org/status/404', // Returns 404
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   expect(['url_not_accessible', 'url_fetch_error'].includes(data.error)).toBe(true)
  // })

  // it('should handle network errors gracefully', async () => {
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-network-error',
  //       external_url: 'https://nonexistent-domain-12345.com/test.zip',
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   expect(['url_fetch_error', 'url_not_accessible'].includes(data.error)).toBe(true)
  // })

  // it('should follow redirects properly', async () => {
  //   // Using httpbin.org/redirect-to which redirects to the target URL
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-redirect-test',
  //       external_url: 'https://httpbin.org/redirect-to?url=https://httpbin.org/json&status_code=302',
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   // Should fail with url_not_zip (because it redirects to JSON), not url_not_accessible
  //   // This proves the redirect was followed successfully
  //   expect(['url_not_zip', 'url_fetch_error'].includes(data.error)).toBe(true)
  // })

  // it('should handle multiple redirects (up to 5)', async () => {
  //   // Test with multiple redirects
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-multi-redirect',
  //       external_url: 'https://httpbin.org/redirect/3', // 3 redirects chain
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   // Should follow the redirects and then fail on final content validation
  //   expect(['url_not_zip', 'url_fetch_error', 'url_not_file'].includes(data.error)).toBe(true)
  // })

  // it('should reject too many redirects', async () => {
  //   // Test with more than 5 redirects
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-too-many-redirects',
  //       external_url: 'https://httpbin.org/redirect/10', // 10 redirects (should exceed limit)
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   // Should fail with too many redirects error
  //   expect(['url_fetch_error'].includes(data.error)).toBe(true)
  // })

  // it('should validate Content-Disposition header for filename', async () => {
  //   // This test demonstrates that Content-Disposition header checking is implemented
  //   // Most real-world URLs with proper Content-Disposition headers would be inaccessible in tests
  //   const response = await fetch(`${BASE_URL}/bundle`, {
  //     method: 'POST',
  //     headers,
  //     body: JSON.stringify({
  //       app_id: APPNAME,
  //       version: '1.0.0-content-disposition',
  //       external_url: 'https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3D%22bundle.zip%22',
  //     }),
  //   })
  //   expect(response.status).toBe(400)
  //   const data = await response.json() as { error: string }
  //   // Should check Content-Disposition but still fail on content-type or accessibility
  //   expect(['url_not_zip', 'url_fetch_error', 'url_not_file'].includes(data.error)).toBe(true)
  // })
})

describe('[POST] /bundle - Signed bundle metadata', () => {
  const checksum = 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd'
  const signature = '0123456789abcdef'.repeat(32)
  const manifestSignature = 'fedcba9876543210'.repeat(32)

  it('stores signature and manifest_signature when provided', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        checksum,
        version: '1.0.0-signed',
        external_url: 'https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.zip',
        signature,
        manifest_signature: manifestSignature,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { status: string, bundle: { signature: string | null, manifest_signature: string | null } }
    expect(data.status).toBe('success')
    expect(data.bundle.signature).toBe(signature)
    expect(data.bundle.manifest_signature).toBe(manifestSignature)
  })

  it('keeps both columns null when the bundle is not signed', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        checksum,
        version: '1.0.0-unsigned',
        external_url: 'https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.zip',
        signature: '',
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { bundle: { signature: string | null, manifest_signature: string | null } }
    expect(data.bundle.signature).toBeNull()
    expect(data.bundle.manifest_signature).toBeNull()
  })

  it.each([
    ['too short', 'abcdef'],
    ['uppercase hex', '0123456789ABCDEF'.repeat(32)],
    ['non hex', 'g'.repeat(512)],
    ['wrong type', 12345],
  ])('rejects an invalid signature (%s)', async (_label, invalid) => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        checksum,
        version: '1.0.0-bad-signature',
        external_url: 'https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.zip',
        signature: invalid,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_signature')
  })

  it('rejects an invalid manifest_signature without creating the bundle', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        checksum,
        version: '1.0.0-bad-manifest-signature',
        external_url: 'https://github.com/Cap-go/capgo/archive/refs/tags/v12.12.32.zip',
        signature,
        manifest_signature: 'not-hex',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_manifest_signature')

    const { data: row } = await getSupabaseClient()
      .from('app_versions')
      .select('id')
      .eq('app_id', APPNAME)
      .eq('name', '1.0.0-bad-manifest-signature')
      .maybeSingle()
    expect(row).toBeNull()
  })
})

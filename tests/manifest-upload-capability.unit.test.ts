import { describe, expect, it } from 'vitest'
import { createManifestUploadResponse, resolveManifestUploadPublicBaseUrl, validateManifestUploadRequest } from '../supabase/functions/_backend/utils/manifest_upload.ts'

const encoder = new TextEncoder()
const secret = '0123456789abcdef0123456789abcdef'

function base64Url(bytes: ArrayBuffer) {
  let binary = ''
  for (const byte of new Uint8Array(bytes))
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('manifest upload capability projection', () => {
  it('derives encrypted Unicode paths and signs the documented canonical payload', async () => {
    const request = validateManifestUploadRequest({
      protocol_version: 1,
      version_id: 12345,
      delta_encryption: { enabled: true },
      manifest_upload_auto_enabled: true,
      file_hash_format: 'rsa_v3_hex',
      entries: [{
        id: -7,
        file_name: 'assets/100% café/猫.br',
        compression: 'brotli',
        file_hash: 'c'.repeat(512),
        uploaded_bytes_sha256: 'd'.repeat(64),
        uploaded_bytes_size: 0,
      }],
    })
    const response = await createManifestUploadResponse(request, {
      ownerOrg: '00000000-0000-0000-0000-000000000001',
      appId: 'com.example.app',
      sessionKey: 'a:b',
      secret,
      keyId: '2026-10-a',
      publicBaseUrl: 'https://uploads.example.invalid/functions/v1/',
      nowUnix: 1_790_957_000,
      concurrency: 4,
    })

    expect(response.default_s3_path_prefix).toBe('orgs/00000000-0000-0000-0000-000000000001/apps/com.example.app/delta/613a62/')
    expect(response.entries[0]).toMatchObject({
      id: -7,
      s3_path_suffix: expect.stringMatching(/^[0-9a-f]{64}_assets\/100%25%20caf%C3%A9\/%E7%8C%AB\.br$/),
    })
    expect(response.upload_targets[0]).toMatchObject({
      upload_url: 'https://uploads.example.invalid/functions/v1/files/upload/attachments/',
      existence_check_url_prefix: 'https://uploads.example.invalid/functions/v1/files/read/attachments/',
      authorization: {
        token_prefix: 'v1.2026-10-a.1790957600.12345.1.',
        expires_at: 1_790_957_600,
      },
    })

    const path = `${response.default_s3_path_prefix}${response.entries[0]!.s3_path_suffix}`
    const payload = [
      'capgo-manifest-upload:v1',
      '2026-10-a',
      '1790957600',
      '12345',
      '1',
      'tus-write',
      path,
    ].join('\n')
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const expectedSignature = base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
    expect(response.entries[0]!.upload_token).toBe(expectedSignature)
    expect(response.entries[0]).not.toHaveProperty('file_hash')
    expect(response.entries[0]).not.toHaveProperty('file_name')
  })

  it('preserves the Supabase functions prefix when no public URL is configured', () => {
    expect(resolveManifestUploadPublicBaseUrl(
      'http://127.0.0.1:54321/functions/v1/private/request_manifest_upload',
      '',
    )).toBe('http://127.0.0.1:54321/functions/v1')
  })

  it('rejects encoded paths before initializing capability signing', async () => {
    const request = validateManifestUploadRequest({
      protocol_version: 1,
      version_id: 12345,
      delta_encryption: { enabled: false },
      manifest_upload_auto_enabled: false,
      file_hash_format: 'sha256_hex',
      entries: [{
        id: 0,
        file_name: `${'é'.repeat(400)}.js`,
        compression: 'none',
        file_hash: 'a'.repeat(64),
        uploaded_bytes_sha256: 'b'.repeat(64),
        uploaded_bytes_size: 1,
      }],
    })

    await expect(createManifestUploadResponse(request, {
      ownerOrg: '00000000-0000-0000-0000-000000000001',
      appId: 'com.example.app',
      sessionKey: null,
      secret: 'invalid',
      keyId: 'invalid key',
      publicBaseUrl: 'https://uploads.example.invalid',
    })).rejects.toMatchObject({
      status: 422,
      code: 'error_manifest_entry_invalid',
      moreInfo: { field: 'entries[0].file_name', index: 0 },
    })
  })
})

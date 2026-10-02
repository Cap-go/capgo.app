import { describe, expect, it } from 'vitest'
import { ManifestUploadRequestError, parseManifestUploadRequestBody, validateManifestUploadRequest } from '../supabase/functions/_backend/utils/manifest_upload.ts'

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 0,
    file_name: 'index.html',
    compression: 'none',
    file_hash: 'a'.repeat(64),
    uploaded_bytes_sha256: 'b'.repeat(64),
    uploaded_bytes_size: 123,
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: 1,
    version_id: 123,
    delta_encryption: { enabled: false },
    manifest_upload_auto_enabled: false,
    file_hash_format: 'sha256_hex',
    entries: [entry()],
    ...overrides,
  }
}

function expectRequestError(input: Record<string, unknown>, status: number, code: string, field?: string) {
  try {
    validateManifestUploadRequest(input)
    throw new Error('Expected request validation to fail')
  }
  catch (error) {
    expect(error).toBeInstanceOf(ManifestUploadRequestError)
    expect(error).toMatchObject({ status, code })
    if (field)
      expect(error).toMatchObject({ moreInfo: { field } })
  }
}

describe('manifest upload request contract', () => {
  it('consumes the original request so error reporting cannot copy the complete manifest', async () => {
    const rawRequest = new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      body: JSON.stringify(request()),
    })

    await parseManifestUploadRequestBody(rawRequest)

    expect(rawRequest.bodyUsed).toBe(true)
  })

  it('accepts the protocol-v1 unencrypted shape', () => {
    expect(validateManifestUploadRequest(request())).toEqual(request())
  })

  it.each([
    ['protocol_version', request({ protocol_version: 2 })],
    ['version_id', request({ version_id: 0 })],
    ['delta_encryption', request({ delta_encryption: {} })],
    ['manifest_upload_auto_enabled', request({ manifest_upload_auto_enabled: 'false' })],
    ['file_hash_format', request({ file_hash_format: 'sha512_hex' })],
    ['entries', request({ entries: [] })],
  ])('rejects an invalid top-level %s', (field, input) => {
    expectRequestError(input, 400, 'error_manifest_upload_request_invalid', field)
  })

  it('rejects more than 10,000 entries with the payload-too-large contract', () => {
    expectRequestError(
      request({ entries: Array.from({ length: 10_001 }, (_, id) => entry({ id, file_name: `file-${id}.js` })) }),
      413,
      'error_manifest_too_large',
      'entries',
    )
  })

  it('rejects unexpected nested fields', () => {
    expectRequestError(
      request({ delta_encryption: { enabled: false, iv_session_key_hex: 'client-owned' } }),
      400,
      'error_manifest_upload_request_invalid',
      'delta_encryption.iv_session_key_hex',
    )
    expectRequestError(
      request({ entries: [entry({ s3_path: 'client-owned' })] }),
      400,
      'error_manifest_upload_request_invalid',
      'entries[0].s3_path',
    )
  })

  it('rejects duplicate request-local IDs', () => {
    expectRequestError(
      request({ entries: [entry(), entry({ file_name: 'second.js' })] }),
      400,
      'error_manifest_upload_request_invalid',
      'entries[1].id',
    )
  })

  it.each([
    ['entries[0].id', entry({ id: 1.5 })],
    ['entries[0].file_name', entry({ file_name: '' })],
    ['entries[0].file_name', entry({ file_name: '/absolute.js' })],
    ['entries[0].file_name', entry({ file_name: 'parent/../escape.js' })],
    ['entries[0].file_name', entry({ file_name: 'empty//segment.js' })],
    ['entries[0].file_name', entry({ file_name: 'windows\\path.js' })],
    ['entries[0].file_name', entry({ file_name: 'nul\0path.js' })],
    ['entries[0].compression', entry({ compression: 'gzip' })],
    ['entries[0].file_name', entry({ compression: 'brotli' })],
    ['entries[0].file_name', entry({ file_name: 'already.br' })],
    ['entries[0].file_hash', entry({ file_hash: 'A'.repeat(64) })],
    ['entries[0].uploaded_bytes_sha256', entry({ uploaded_bytes_sha256: 'B'.repeat(64) })],
    ['entries[0].uploaded_bytes_size', entry({ uploaded_bytes_size: -1 })],
  ])('rejects invalid entry data at %s', (field, invalidEntry) => {
    expectRequestError(
      request({ entries: [invalidEntry] }),
      422,
      'error_manifest_entry_invalid',
      field,
    )
  })

  it('rejects duplicate logical filenames', () => {
    expectRequestError(
      request({ entries: [entry(), entry({ id: 1 })] }),
      422,
      'error_manifest_entry_invalid',
      'entries[1].file_name',
    )
  })

  it('requires hash formats to agree with delta encryption', () => {
    expectRequestError(
      request({ delta_encryption: { enabled: true } }),
      409,
      'error_delta_encryption_invalid',
      'file_hash_format',
    )
    expectRequestError(
      request({ file_hash_format: 'rsa_v3_hex' }),
      409,
      'error_delta_encryption_invalid',
      'file_hash_format',
    )
  })

  it('accepts canonical RSA v2 base64 and RSA v3 hex hashes for encrypted deltas', () => {
    const rsaV2 = btoa(String.fromCharCode(...new Uint8Array(256).fill(1)))
    expect(validateManifestUploadRequest(request({
      delta_encryption: { enabled: true },
      file_hash_format: 'rsa_v2_base64',
      entries: [entry({ file_hash: rsaV2 })],
    }))).toMatchObject({ file_hash_format: 'rsa_v2_base64' })
    expect(validateManifestUploadRequest(request({
      delta_encryption: { enabled: true },
      file_hash_format: 'rsa_v3_hex',
      entries: [entry({ file_hash: 'c'.repeat(512) })],
    }))).toMatchObject({ file_hash_format: 'rsa_v3_hex' })
  })
})

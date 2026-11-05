import { describe, expect, it } from 'vitest'
import { createManifestUploadResponse, ManifestUploadRequestError, MAX_MANIFEST_UPLOAD_BODY_BYTES, parseManifestUploadRequestBody, resolveManifestUploadPublicBaseUrl, validateManifestUploadRequest } from '../supabase/functions/_backend/utils/manifest_upload.ts'

const SECRET = '0123456789abcdef0123456789abcdef'

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

async function expectBodyError(rawRequest: Request, status: number, code: string) {
  try {
    await parseManifestUploadRequestBody(rawRequest)
    throw new Error('Expected request parsing to fail')
  }
  catch (error) {
    expect(error).toBeInstanceOf(ManifestUploadRequestError)
    expect(error).toMatchObject({ status, code, moreInfo: { field: 'body' } })
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

  it('rejects an oversized declared body before reading it', async () => {
    const rawRequest = new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      headers: { 'content-length': String(MAX_MANIFEST_UPLOAD_BODY_BYTES + 1) },
      body: '{}',
    })

    await expectBodyError(rawRequest, 413, 'error_manifest_too_large')
  })

  it('stops reading a chunked body when it crosses the byte cap', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let emitted = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
        emitted++
      },
      cancel() {
        cancelled = true
      },
    })
    const rawRequest = new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    await expectBodyError(rawRequest, 413, 'error_manifest_too_large')

    expect(emitted).toBe(Math.floor(MAX_MANIFEST_UPLOAD_BODY_BYTES / chunk.length) + 1)
    expect(cancelled).toBe(true)
    expect(rawRequest.bodyUsed).toBe(true)
  })

  it('rejects malformed JSON with the invalid-request contract', async () => {
    const rawRequest = new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      body: '{',
    })

    await expectBodyError(rawRequest, 400, 'error_manifest_upload_request_invalid')

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

const encoder = new TextEncoder()

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
      secret: SECRET,
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
    const key = await crypto.subtle.importKey('raw', encoder.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
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

const ENTRY_COUNT = 10_000

async function gzipSize(value: string): Promise<number> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

async function runScaleCase(encrypted: boolean) {
  const requestJson = JSON.stringify({
    protocol_version: 1,
    version_id: 987654,
    delta_encryption: { enabled: encrypted },
    manifest_upload_auto_enabled: false,
    file_hash_format: encrypted ? 'rsa_v3_hex' : 'sha256_hex',
    entries: Array.from({ length: ENTRY_COUNT }, (_, id) => ({
      id,
      file_name: `assets/file-${id}.js${encrypted ? '.br' : ''}`,
      compression: encrypted ? 'brotli' : 'none',
      file_hash: encrypted ? 'a'.repeat(512) : 'a'.repeat(64),
      uploaded_bytes_sha256: 'b'.repeat(64),
      uploaded_bytes_size: id,
    })),
  })
  const startedAt = performance.now()
  const parsed = await parseManifestUploadRequestBody(new Request('https://api.capgo.app/private/request_manifest_upload', {
    method: 'POST',
    body: requestJson,
  }))
  const request = validateManifestUploadRequest(parsed.body)
  const response = await createManifestUploadResponse(request, {
    ownerOrg: '00000000-0000-0000-0000-000000000001',
    appId: 'com.example.scale',
    sessionKey: encrypted ? 'iv-base64:rsa-encrypted-session-key-base64' : null,
    secret: SECRET,
    keyId: 'scale-v1',
    publicBaseUrl: 'https://api.capgo.app',
    nowUnix: 1_790_957_000,
  })
  const responseJson = JSON.stringify(response)
  return {
    elapsedMs: performance.now() - startedAt,
    requestBytes: parsed.byteLength,
    responseBytes: new TextEncoder().encode(responseJson).byteLength,
    compressedResponseBytes: await gzipSize(responseJson),
    response,
  }
}

describe('manifest upload production-scale boundary', () => {
  it('bounds 10,000-entry unencrypted and encrypted projections', { timeout: 30_000 }, async () => {
    for (const encrypted of [false, true]) {
      const result = await runScaleCase(encrypted)
      expect(result.response.entries).toHaveLength(ENTRY_COUNT)
      expect(result.requestBytes).toBeLessThan(MAX_MANIFEST_UPLOAD_BODY_BYTES)
      expect(result.responseBytes).toBeLessThan(MAX_MANIFEST_UPLOAD_BODY_BYTES)
      expect(result.compressedResponseBytes).toBeLessThan(result.responseBytes)
      expect(result.elapsedMs).toBeLessThan(20_000)
    }
  })
})

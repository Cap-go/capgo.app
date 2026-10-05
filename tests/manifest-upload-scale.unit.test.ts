import { describe, expect, it } from 'vitest'
import { createManifestUploadResponse, MAX_MANIFEST_UPLOAD_BODY_BYTES, parseManifestUploadRequestBody, validateManifestUploadRequest } from '../supabase/functions/_backend/utils/manifest_upload.ts'

const ENTRY_COUNT = 10_000
const SECRET = '0123456789abcdef0123456789abcdef'

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

import type { ManifestUploadRequest, ManifestUploadResponse, ResolvedManifestUpload } from '../../src/bundle/manifest-upload'
import type { UploadReporter } from '../../src/bundle/reporter'
import type { OptionsUpload } from '../../src/bundle/upload_interface'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { brotliCompressSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { encryptSource } from '../../src/api/crypto'
import { isManifestUploadAutoEnabled, manifestUploadFileHashFormat, requestManifestUpload, resolveManifestUploadResponse } from '../../src/bundle/manifest-upload'
import { buildPartialUploadHeaders, fileExistsAtUploadTarget, PartialUploadValidationError, prepareManifestUploadEntries, uploadPartial } from '../../src/bundle/partial'
import { runWithUploadReporter } from '../../src/bundle/reporter'

const request: ManifestUploadRequest = {
  protocol_version: 1,
  version_id: 123,
  delta_encryption: { enabled: false },
  manifest_upload_auto_enabled: false,
  file_hash_format: 'sha256_hex',
  entries: [
    {
      id: 0,
      file_name: 'index.html.br',
      compression: 'brotli',
      file_hash: 'a'.repeat(64),
      uploaded_bytes_sha256: 'b'.repeat(64),
      uploaded_bytes_size: 42,
    },
    {
      id: 1,
      file_name: 'assets/logo.png',
      compression: 'none',
      file_hash: 'c'.repeat(64),
      uploaded_bytes_sha256: 'd'.repeat(64),
      uploaded_bytes_size: 84,
    },
    {
      id: 2,
      file_name: 'main.js',
      compression: 'none',
      file_hash: 'e'.repeat(64),
      uploaded_bytes_sha256: 'f'.repeat(64),
      uploaded_bytes_size: 126,
    },
  ],
}

function response(): ManifestUploadResponse {
  return {
    protocol_version: 1,
    version_id: 123,
    default_action: 'upload_if_doesnt_exist',
    default_s3_path_prefix: 'orgs/org-id/apps/com.example.app/delta/',
    default_upload_target: 'primary',
    upload_targets: [
      {
        id: 'primary',
        protocol: 'tus',
        upload_url: 'https://files.example.test/files/upload/attachments/',
        existence_check_url_prefix: 'https://files.example.test/files/read/attachments/',
        authorization: {
          type: 'header',
          header_name: 'X-Capgo-Upload-Token',
          token_prefix: 'opaque-prefix.',
          expires_at: 1,
        },
      },
      {
        id: 'secondary',
        protocol: 'tus',
        upload_url: 'https://secondary.example.test/upload/',
        existence_check_url_prefix: 'https://secondary.example.test/read/',
        authorization: {
          type: 'header',
          header_name: 'X-Future-Capability',
          token_prefix: '',
          expires_at: 2,
        },
      },
    ],
    entries: [
      { id: 0, s3_path_suffix: `hash_${request.entries[0]!.file_name}`, upload_token: 'x'.repeat(4_096) },
      {
        id: 1,
        action: 'reuse',
        s3_path: 'orgs/org-id/apps/com.example.app/server-selected/hash_assets%2Flogo.png',
        file_size_receipt: 'receipt',
      },
      {
        id: 2,
        action: 'upload',
        upload_target: 'secondary',
        s3_path_suffix: 'hash_main.js',
        upload_token: 'future-token-format',
      },
    ],
  }
}

function recordingReporter(events: string[]): UploadReporter {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    intro: () => {},
    outro: () => {},
    spinner: () => ({
      start: message => events.push(`start:${message}`),
      message: message => events.push(`message:${message}`),
      stop: message => events.push(`stop:${message ?? ''}`),
      error: message => events.push(`error:${message}`),
    }),
  }
}

describe('manifest upload response contract', () => {
  it('selects request hash metadata and fallback mode from the actual upload mode', () => {
    expect(manifestUploadFileHashFormat(false, false)).toBe('sha256_hex')
    expect(manifestUploadFileHashFormat(true, false)).toBe('rsa_v2_base64')
    expect(manifestUploadFileHashFormat(true, true)).toBe('rsa_v3_hex')
    expect(isManifestUploadAutoEnabled(false, true)).toBe(true)
    expect(isManifestUploadAutoEnabled(true, true)).toBe(false)
    expect(isManifestUploadAutoEnabled(false, false)).toBe(false)
  })

  it('resolves all actions, mixed path forms, target overrides, and opaque tokens', () => {
    const resolved = resolveManifestUploadResponse(request, response())

    expect(resolved.entries.map(entry => entry.action)).toEqual(['upload_if_doesnt_exist', 'reuse', 'upload'])
    expect(resolved.entries[0]!.s3Path).toBe('orgs/org-id/apps/com.example.app/delta/hash_index.html.br')
    expect(resolved.entries[0]!.uploadAuthorization).toEqual({
      headerName: 'X-Capgo-Upload-Token',
      value: `opaque-prefix.${'x'.repeat(4_096)}`,
    })
    expect(resolved.entries[1]!.s3Path).toBe('orgs/org-id/apps/com.example.app/server-selected/hash_assets%2Flogo.png')
    expect(resolved.entries[1]!.fileSizeReceipt).toBe('receipt')
    expect(resolved.entries[1]!.uploadTarget).toBeUndefined()
    expect(resolved.entries[2]!.uploadTarget?.id).toBe('secondary')
    expect(resolved.entries[2]!.uploadAuthorization?.value).toBe('future-token-format')

    const headers = buildPartialUploadHeaders(resolved.entries[2])
    expect(headers['X-Future-Capability']).toBe('future-token-format')
    expect(headers.Authorization).toBeUndefined()
    expect(headers['x-cli-version']).toBeTruthy()
  })

  it('does not locally reject or reinterpret an expired authorization', () => {
    const expired = response()
    expired.upload_targets[0]!.authorization.expires_at = 1
    expect(resolveManifestUploadResponse(request, expired).entries).toHaveLength(3)
  })

  it('requires HTTPS for capability-bearing targets except local development loopback URLs', () => {
    const insecure = response()
    insecure.upload_targets[0]!.upload_url = 'http://files.example.test/files/upload/attachments/'
    expect(() => resolveManifestUploadResponse(request, insecure)).toThrow('must use HTTPS')

    const loopback = response()
    loopback.upload_targets[0]!.upload_url = 'http://127.0.0.1:8787/files/upload/attachments/'
    loopback.upload_targets[0]!.existence_check_url_prefix = 'http://localhost:8787/files/read/attachments/'
    expect(resolveManifestUploadResponse(request, loopback).entries).toHaveLength(3)
  })

  it('calls the private endpoint with the complete request', async () => {
    let calledPath = ''
    let calledOptions: unknown
    const resolved = await requestManifestUpload('api-key', request, { apiHost: 'https://supabase.example.test/functions/v1' }, async (path, options) => {
      calledPath = path
      calledOptions = options
      return { data: response(), error: null }
    })

    expect(calledPath).toBe('private/request_manifest_upload')
    expect(calledOptions).toMatchObject({
      apikey: 'api-key',
      body: request,
      apiHost: 'https://supabase.example.test/functions/v1',
    })
    expect(resolved.entries).toHaveLength(3)
  })

  it('only shows the authorization spinner when the request takes longer than 500 ms', async () => {
    const fastEvents: string[] = []
    await runWithUploadReporter(recordingReporter(fastEvents), async () => requestManifestUpload('api-key', request, {}, async () => ({
      data: response(),
      error: null,
    })))
    expect(fastEvents).toEqual([])

    const slowEvents: string[] = []
    let resolveRequest!: () => void
    const requestPending = new Promise<void>((resolve) => {
      resolveRequest = resolve
    })
    const slowRequest = runWithUploadReporter(recordingReporter(slowEvents), async () => requestManifestUpload('api-key', request, {}, async () => {
      await requestPending
      return { data: response(), error: null }
    }))

    await Bun.sleep(550)
    expect(slowEvents).toEqual(['start:Requesting delta upload authorization'])

    resolveRequest()
    await slowRequest
    expect(slowEvents).toEqual([
      'start:Requesting delta upload authorization',
      'stop:Delta upload authorized',
    ])
  })

  it.each([
    ['wrong protocol', (value: ManifestUploadResponse) => { value.protocol_version = 2 }],
    ['wrong version', (value: ManifestUploadResponse) => { value.version_id = 124 }],
    ['missing entry', (value: ManifestUploadResponse) => { value.entries.pop() }],
    ['duplicate entry', (value: ManifestUploadResponse) => { value.entries[1] = { ...value.entries[0]! } }],
    ['unknown target', (value: ManifestUploadResponse) => { value.entries[0]!.upload_target = 'missing' }],
    ['both path forms', (value: ManifestUploadResponse) => { value.entries[0]!.s3_path = 'orgs/org-id/apps/com.example.app/delta/other' }],
    ['missing reuse receipt', (value: ManifestUploadResponse) => { delete value.entries[1]!.file_size_receipt }],
    ['missing upload token', (value: ManifestUploadResponse) => { delete value.entries[0]!.upload_token }],
    ['unsafe header', (value: ManifestUploadResponse) => { value.upload_targets[0]!.authorization.header_name = 'Bad\nHeader' }],
    ['unsafe token', (value: ManifestUploadResponse) => { value.entries[0]!.upload_token = 'bad\r\ntoken' }],
    ['duplicate path', (value: ManifestUploadResponse) => {
      value.entries[2]!.s3_path_suffix = value.entries[0]!.s3_path_suffix
    }],
  ])('rejects a response with %s', (_name, mutate) => {
    const invalid = response()
    mutate(invalid)
    expect(() => resolveManifestUploadResponse(request, invalid)).toThrow('Invalid manifest upload authorization response')
  })
})

describe('manifest upload request entries', () => {
  it('marks local delta validation failures separately from file preparation failures', async () => {
    await expect(prepareManifestUploadEntries(
      [{ file: 'file with spaces.txt', hash: 'a'.repeat(64) }],
      tmpdir(),
      undefined,
      {} as OptionsUpload,
    )).rejects.toBeInstanceOf(PartialUploadValidationError)
  })

  it('hashes and sizes the exact bytes produced after compression and encryption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capgo-manifest-upload-'))
    try {
      const small = Buffer.from('plain upload bytes')
      const compressible = Buffer.from('manifest upload '.repeat(2_000))
      await writeFile(join(directory, 'plain.txt'), small)
      await writeFile(join(directory, 'large.js'), compressible)
      const manifest = [
        { file: 'plain.txt', hash: createHash('sha256').update(small).digest('hex') },
        { file: 'large.js', hash: createHash('sha256').update(compressible).digest('hex') },
      ]
      const options = {} as OptionsUpload

      const entries = await prepareManifestUploadEntries(manifest, directory, undefined, options)
      const compressed = brotliCompressSync(compressible)
      expect(entries[0]).toMatchObject({
        id: 0,
        file_name: 'plain.txt',
        compression: 'none',
        uploaded_bytes_sha256: manifest[0]!.hash,
        uploaded_bytes_size: small.byteLength,
      })
      expect(entries[1]).toMatchObject({
        id: 1,
        file_name: 'large.js.br',
        compression: 'brotli',
        uploaded_bytes_sha256: createHash('sha256').update(compressed).digest('hex'),
        uploaded_bytes_size: compressed.byteLength,
      })

      const sessionKey = Buffer.alloc(16, 7)
      const ivSessionKey = `${Buffer.alloc(16, 3).toString('base64')}:unused-for-encryption`
      const encryptedEntries = await prepareManifestUploadEntries(
        manifest.slice(0, 1),
        directory,
        { sessionKey, ivSessionKey },
        options,
      )
      const encrypted = encryptSource(small, sessionKey, ivSessionKey)
      expect(encryptedEntries[0]).toMatchObject({
        file_name: 'plain.txt',
        compression: 'none',
        uploaded_bytes_sha256: createHash('sha256').update(encrypted).digest('hex'),
        uploaded_bytes_size: encrypted.byteLength,
      })
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('manifest upload existence probe', () => {
  it('uses the server URL, identifies the CLI, and consumes the size receipt', async () => {
    const originalFetch = globalThis.fetch
    let requestedUrl = ''
    let requestedHeaders: Record<string, string> | undefined
    let redirectMode: RequestRedirect | undefined
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input)
      requestedHeaders = init?.headers as Record<string, string>
      redirectMode = init?.redirect
      return new Response('', {
        status: 200,
        headers: { 'X-Capgo-Manifest-Size-Receipt': 'signed-size' },
      })
    }) as typeof fetch
    try {
      const result = await fileExistsAtUploadTarget(
        'https://files.example.test/files/read/attachments/',
        'orgs/org/apps/app/delta/hash_assets/logo.png',
      )
      expect(result).toEqual({ exists: true, receipt: 'signed-size' })
      expect(requestedUrl).toContain('/files/read/attachments/orgs%2Forg%2Fapps%2Fapp%2Fdelta%2Fhash_assets%2Flogo.png?nocache=')
      expect(requestedHeaders?.['x-cli-version']).toBeTruthy()
      expect(requestedHeaders?.range).toBeUndefined()
      expect(redirectMode).toBe('error')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('treats only 404 as missing', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch
      await expect(fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file')).resolves.toEqual({ exists: false })

      globalThis.fetch = (async () => new Response('temporary failure', { status: 503 })) as typeof fetch
      await expect(fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file')).rejects.toThrow('HTTP 503')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retries a transient transport failure', async () => {
    const originalFetch = globalThis.fetch
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts++
      if (attempts === 1)
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
      return new Response('', { status: 404 })
    }) as typeof fetch
    try {
      await expect(fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file')).resolves.toEqual({ exists: false })
      expect(attempts).toBe(2)
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('includes the immediate probe failure reason without verbose output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capgo-manifest-upload-probe-error-'))
    const originalFetch = globalThis.fetch
    const originalDisableTelemetry = env.CAPGO_DISABLE_TELEMETRY
    const contents = Buffer.from('probe failure fixture')
    const hash = createHash('sha256').update(contents).digest('hex')
    const requestEntry = {
      id: 0,
      file_name: 'payload.txt',
      compression: 'none' as const,
      file_hash: hash,
      uploaded_bytes_sha256: hash,
      uploaded_bytes_size: contents.byteLength,
    }
    const uploadTarget = {
      id: 'primary',
      protocol: 'tus' as const,
      upload_url: 'https://files.example.test/upload/',
      existence_check_url_prefix: 'https://files.example.test/read/',
      authorization: {
        type: 'header' as const,
        header_name: 'X-Capgo-Upload-Token',
        token_prefix: '',
        expires_at: Date.now() + 60_000,
      },
    }
    const manifestUpload: ResolvedManifestUpload = {
      response: {
        protocol_version: 1,
        version_id: 123,
        default_action: 'upload_if_doesnt_exist',
        default_s3_path_prefix: 'orgs/org/apps/app/delta/',
        default_upload_target: 'primary',
        upload_targets: [uploadTarget],
        entries: [],
      },
      entries: [{
        request: requestEntry,
        action: 'upload_if_doesnt_exist',
        s3Path: 'orgs/org/apps/app/delta/payload.txt',
        uploadTarget,
        uploadAuthorization: { headerName: 'X-Capgo-Upload-Token', value: 'token' },
      }],
    }
    const events: string[] = []
    const reporter = recordingReporter(events)
    reporter.error = message => events.push(`error:${message}`)
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch
    env.CAPGO_DISABLE_TELEMETRY = '1'

    try {
      await writeFile(join(directory, 'payload.txt'), contents)
      await expect(runWithUploadReporter(reporter, () => uploadPartial(
        'api-key',
        [{ file: 'payload.txt', hash }],
        directory,
        'com.example.app',
        'org-id',
        undefined,
        { disableBrotli: true, userRequestedDelta: true, verbose: false } as OptionsUpload,
        manifestUpload,
      ))).rejects.toThrow('Cannot check whether delta file exists: payload.txt')
      expect(events.find(event => event.includes('Error uploading delta update'))).toContain('HTTP 503')
    }
    finally {
      globalThis.fetch = originalFetch
      if (originalDisableTelemetry === undefined)
        delete env.CAPGO_DISABLE_TELEMETRY
      else
        env.CAPGO_DISABLE_TELEMETRY = originalDisableTelemetry
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('manifest upload concurrency', () => {
  async function measureMaxActiveProbes(deltaUploadConcurrency?: number): Promise<number> {
    const directory = await mkdtemp(join(tmpdir(), 'capgo-manifest-upload-concurrency-'))
    const originalFetch = globalThis.fetch
    const originalDisableTelemetry = env.CAPGO_DISABLE_TELEMETRY
    const contents = Buffer.from('changed stress-test content')
    const hash = createHash('sha256').update(contents).digest('hex')
    const manifest = Array.from({ length: 60 }, () => ({ file: 'payload.txt', hash }))
    const uploadTarget = {
      id: 'primary',
      protocol: 'tus' as const,
      upload_url: 'https://files.example.test/upload/',
      existence_check_url_prefix: 'https://files.example.test/read/',
      authorization: {
        type: 'header' as const,
        header_name: 'X-Capgo-Upload-Token',
        token_prefix: '',
        expires_at: Date.now() + 60_000,
      },
    }
    const requestEntries = manifest.map((entry, id) => ({
      id,
      file_name: entry.file,
      compression: 'none' as const,
      file_hash: entry.hash,
      uploaded_bytes_sha256: hash,
      uploaded_bytes_size: contents.byteLength,
    }))
    const manifestUpload: ResolvedManifestUpload = {
      response: {
        protocol_version: 1,
        version_id: 123,
        default_action: 'upload_if_doesnt_exist',
        default_s3_path_prefix: 'orgs/org/apps/app/delta/',
        default_upload_target: 'primary',
        upload_targets: [uploadTarget],
        entries: [],
      },
      entries: requestEntries.map(requestEntry => ({
        request: requestEntry,
        action: 'upload_if_doesnt_exist',
        s3Path: `orgs/org/apps/app/delta/${requestEntry.id}_payload.txt`,
        uploadTarget,
        uploadAuthorization: { headerName: 'X-Capgo-Upload-Token', value: 'token' },
      })),
    }

    let activeProbes = 0
    let maxActiveProbes = 0
    globalThis.fetch = (async () => {
      activeProbes++
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      await new Promise(resolve => setTimeout(resolve, 5))
      activeProbes--
      return new Response('', {
        status: 200,
        headers: { 'X-Capgo-Manifest-Size-Receipt': 'signed-size' },
      })
    }) as typeof fetch
    env.CAPGO_DISABLE_TELEMETRY = '1'

    try {
      await writeFile(join(directory, 'payload.txt'), contents)
      await runWithUploadReporter(recordingReporter([]), () => uploadPartial(
        'api-key',
        manifest,
        directory,
        'com.example.app',
        'org-id',
        undefined,
        { disableBrotli: true, userRequestedDelta: true, deltaUploadConcurrency } as OptionsUpload,
        manifestUpload,
      ))
      return maxActiveProbes
    }
    finally {
      globalThis.fetch = originalFetch
      if (originalDisableTelemetry === undefined)
        delete env.CAPGO_DISABLE_TELEMETRY
      else
        env.CAPGO_DISABLE_TELEMETRY = originalDisableTelemetry
      await rm(directory, { recursive: true, force: true })
    }
  }

  it('limits simultaneous file existence probes to 50 by default', async () => {
    expect(await measureMaxActiveProbes()).toBeLessThanOrEqual(50)
  })

  it('uses the requested delta upload concurrency', async () => {
    expect(await measureMaxActiveProbes(20)).toBeLessThanOrEqual(20)
  })
})

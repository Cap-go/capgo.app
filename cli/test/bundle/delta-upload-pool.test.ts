import type { ResolvedManifestUpload } from '../../src/bundle/manifest-upload'
import type { UploadReporter } from '../../src/bundle/reporter'
import type { OptionsUpload } from '../../src/bundle/upload_interface'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { describe, expect, it } from 'bun:test'
import { ManifestPayloadCache } from '../../src/bundle/manifest-payload-cache'
import { fileExistsAtUploadTarget, prepareManifestUploadEntries, uploadPartial } from '../../src/bundle/partial'
import { runWithUploadReporter } from '../../src/bundle/reporter'
import { defaultCpuConcurrency, runWorkerPool } from '../../src/shared/worker-pool'

function silentReporter(): UploadReporter {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    spinner: () => ({
      start: () => {},
      message: () => {},
      stop: () => {},
      error: () => {},
    }),
  } as unknown as UploadReporter
}

async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await run()
  }
  finally {
    globalThis.fetch = originalFetch
  }
}

/** A Response whose body records whether the probe cancelled it. */
function trackedResponse(status: number, headers: Record<string, string> = {}, method = 'GET') {
  const state = { cancelled: false }
  const body = method === 'HEAD'
    ? null
    : new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024))
        },
        cancel() {
          state.cancelled = true
        },
      })
  return { response: new Response(body, { status, headers }), state }
}

describe('worker pool', () => {
  it('never runs more than the concurrency cap', async () => {
    let active = 0
    let maxActive = 0
    const results = await runWorkerPool(40, 5, async (index) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 1 + (index % 3)))
      active--
      return index * 2
    })
    expect(maxActive).toBe(5)
    expect(results).toEqual(Array.from({ length: 40 }, (_, index) => index * 2))
  })

  it('keeps other slots busy while one task is slow (no batch stall)', async () => {
    const started: number[] = []
    let releaseSlow!: () => void
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const pool = runWorkerPool(20, 4, async (index) => {
      started.push(index)
      if (index === 0)
        await slow
      return index
    })
    // With fixed batches of 4, items 4..19 would wait for item 0.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started.length).toBe(20)
    releaseSlow()
    expect(await pool).toHaveLength(20)
  })

  it('rejects on the first failure and starts no new tasks', async () => {
    const started: number[] = []
    await expect(runWorkerPool(50, 2, async (index) => {
      started.push(index)
      await new Promise(resolve => setTimeout(resolve, 1))
      if (index === 3)
        throw new Error('boom')
      return index
    })).rejects.toThrow('boom')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(started.length).toBeLessThan(10)
  })

  it('waits for running tasks to settle before rejecting with the first error', async () => {
    let releaseSlow: () => void = () => {}
    let slowSettled = false
    const pool = runWorkerPool(2, 2, async (index) => {
      if (index === 0)
        throw new Error('first')
      await new Promise<void>((resolve) => { releaseSlow = resolve })
      slowSettled = true
      throw new Error('second')
    })
    let rejected = false
    pool.catch(() => { rejected = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(rejected).toBe(false)
    releaseSlow()
    await expect(pool).rejects.toThrow('first')
    expect(slowSettled).toBe(true)
  })

  it('resolves an empty pool and bounds CPU concurrency', async () => {
    expect(await runWorkerPool(0, 4, async () => 1)).toEqual([])
    expect(defaultCpuConcurrency()).toBeGreaterThanOrEqual(1)
    expect(defaultCpuConcurrency(2)).toBeLessThanOrEqual(2)
  })
})

describe('fallback existence probe', () => {
  it('uses HEAD and never downloads the object', async () => {
    const methods: string[] = []
    const result = await withFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return trackedResponse(200, { 'X-Capgo-Manifest-Size-Receipt': 'signed-size' }, 'HEAD').response
    }) as typeof fetch, () => fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file'))
    expect(result).toEqual({ exists: true, receipt: 'signed-size' })
    expect(methods).toEqual(['HEAD'])
  })

  it('falls back to GET when HEAD is not allowed, and cancels the GET body', async () => {
    const methods: string[] = []
    const tracked: Array<{ cancelled: boolean }> = []
    const result = await withFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      const { response, state } = method === 'HEAD'
        ? trackedResponse(405)
        : trackedResponse(200, { 'X-Capgo-Manifest-Size-Receipt': 'signed-size' })
      tracked.push(state)
      return response
    }) as typeof fetch, () => fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file'))
    expect(result).toEqual({ exists: true, receipt: 'signed-size' })
    expect(methods).toEqual(['HEAD', 'GET'])
    expect(tracked.every(state => state.cancelled)).toBe(true)
  })

  it('falls back to GET when HEAD carries no size receipt', async () => {
    const methods: string[] = []
    const getState = { cancelled: false }
    const result = await withFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'HEAD')
        return new Response(null, { status: 200 })
      const { response, state } = trackedResponse(200, { 'X-Capgo-Manifest-Size-Receipt': 'from-get' })
      Object.defineProperty(getState, 'cancelled', { get: () => state.cancelled })
      return response
    }) as typeof fetch, () => fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file'))
    expect(result).toEqual({ exists: true, receipt: 'from-get' })
    expect(methods).toEqual(['HEAD', 'GET'])
    expect(getState.cancelled).toBe(true)
  })

  it('cancels the body of a retried error response', async () => {
    const states: Array<{ cancelled: boolean }> = []
    let attempts = 0
    const result = await withFetch((async () => {
      attempts++
      const { response, state } = attempts === 1 ? trackedResponse(502) : trackedResponse(404)
      states.push(state)
      return response
    }) as typeof fetch, () => fileExistsAtUploadTarget('https://files.example.test/read/', 'orgs/org/apps/app/delta/file'))
    expect(result).toEqual({ exists: false })
    expect(states.every(state => state.cancelled)).toBe(true)
  })
})

describe('prepared payload reuse', () => {
  it('prepares in parallel, keeps manifest order for onPayload, and caches exact bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capgo-delta-prepare-'))
    const cache = await ManifestPayloadCache.create()
    try {
      const files = Array.from({ length: 25 }, (_, index) => ({
        name: `file-${index}.js`,
        bytes: Buffer.from(`content ${index} `.repeat(index % 2 === 0 ? 2_000 : 3)),
      }))
      for (const file of files)
        await writeFile(join(directory, file.name), file.bytes)
      const manifest = files.map(file => ({ file: file.name, hash: createHash('sha256').update(file.bytes).digest('hex') }))
      const order: number[] = []
      const entries = await prepareManifestUploadEntries(manifest, directory, undefined, {} as OptionsUpload, (entry) => {
        order.push(entry.id)
      }, cache)

      expect(order).toEqual(files.map((_, index) => index))
      expect(entries.map(entry => entry.id)).toEqual(order)
      for (const entry of entries) {
        const cached = cache.get(entry.id)
        expect(cached?.fileName).toBe(entry.file_name)
        const bytes = await cache.read(entry.id)
        expect(bytes?.byteLength).toBe(entry.uploaded_bytes_size)
        expect(createHash('sha256').update(bytes!).digest('hex')).toBe(entry.uploaded_bytes_sha256)
      }
    }
    finally {
      await cache.dispose()
      await rm(directory, { recursive: true, force: true })
    }
    expect(await cache.read(0)).toBeUndefined()
  })

  it('never reads local files for server-decided reuse entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'capgo-delta-reuse-'))
    const originalDisableTelemetry = env.CAPGO_DISABLE_TELEMETRY
    env.CAPGO_DISABLE_TELEMETRY = '1'
    try {
      const manifest = Array.from({ length: 30 }, (_, index) => ({ file: `missing-${index}.js`, hash: createHash('sha256').update(`${index}`).digest('hex') }))
      const manifestUpload: ResolvedManifestUpload = {
        response: {
          protocol_version: 1,
          version_id: 1,
          default_action: 'upload_if_doesnt_exist',
          default_s3_path_prefix: 'orgs/org/apps/app/delta/',
          upload_targets: [],
          entries: [],
        },
        entries: manifest.map((file, id) => ({
          request: {
            id,
            file_name: file.file,
            compression: 'none',
            file_hash: file.hash,
            uploaded_bytes_sha256: 'a'.repeat(64),
            uploaded_bytes_size: 1,
          },
          action: 'reuse',
          s3Path: `orgs/org/apps/app/delta/${id}_${file.file}`,
          fileSizeReceipt: `receipt-${id}`,
        })),
      }
      let fetches = 0
      const results = await withFetch((async () => {
        fetches++
        return new Response(null, { status: 500 })
      }) as typeof fetch, () => runWithUploadReporter(silentReporter(), () => uploadPartial(
        'api-key',
        manifest,
        directory,
        'com.example.app',
        'org-id',
        undefined,
        { disableBrotli: true, userRequestedDelta: true } as OptionsUpload,
        manifestUpload,
      )))
      // The source files do not exist: any read or probe would have failed.
      expect(results?.map(result => result.file_size_receipt)).toEqual(manifest.map((_, id) => `receipt-${id}`))
      expect(fetches).toBe(0)
    }
    finally {
      if (originalDisableTelemetry === undefined)
        delete env.CAPGO_DISABLE_TELEMETRY
      else
        env.CAPGO_DISABLE_TELEMETRY = originalDisableTelemetry
      await rm(directory, { recursive: true, force: true })
    }
  })
})

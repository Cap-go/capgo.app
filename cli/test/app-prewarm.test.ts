import type { OptionsBase } from '../src/schemas/base'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { describePrewarmRegion, prewarmApp } from '../src/app/prewarm'
import { withCwd } from '../src/build/cwd'
import { getConfig } from '../src/utils'

const base = { region: 'na', placement: 'remote-CMH', revision: '7', cached: 0, skipped: null, error: null }

test('describes what the prewarm did in each region', () => {
  expect(describePrewarmRegion({ ...base, cached: 3 })).toBe('wrote 3 documents to the cache')
  expect(describePrewarmRegion({ ...base, cached: 1 })).toBe('wrote 1 document to the cache')
  expect(describePrewarmRegion(base)).toBe('already warm')
  expect(describePrewarmRegion({ ...base, skipped: 'disabled' })).toBe('skipped (KV reads off in this region)')
  expect(describePrewarmRegion({ ...base, skipped: 'unpublished' })).toBe('skipped (unpublished)')
  expect(describePrewarmRegion({ ...base, cached: 2, error: 'http_error' })).toBe('failed: http_error')
  expect(describePrewarmRegion({ ...base, cached: 1, placement: null })).toBe('wrote 1 document to the cache (not confirmed in the region\'s pinned data center)')
  expect(describePrewarmRegion({ ...base, cached: 1, placement: 'local-LHR' })).toBe('wrote 1 document to the cache (not confirmed in the region\'s pinned data center)')
  expect(describePrewarmRegion({ ...base, cached: 1, placement: 'local-LHR', pinned: true })).toBe('wrote 1 document to the cache')
})

test('prewarms an explicit app id outside a Capacitor project', async () => {
  const requests: { path: string, apikey: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, apikey: request.headers.get('capgkey') ?? request.headers.get('authorization') })
      return Response.json({ app_id: 'com.example.prewarm', regions: [{ ...base, cached: 2 }] })
    },
  })
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-prewarm-')))
  try {
    await withCwd(dir, async () => {
      // Capacitor looks for a config in parent folders too: a temp folder inside
      // a project would let a regression that still loads the config pass.
      await expect(getConfig(true)).rejects.toThrow()
      await prewarmApp('com.example.prewarm', { apikey: 'test-key', apiHost: server.url.origin } as OptionsBase)
    })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
    server.stop(true)
  }
  expect(requests.map(request => request.path)).toEqual(['/app/com.example.prewarm/prewarm'])
  expect(requests[0].apikey).toContain('test-key')
})

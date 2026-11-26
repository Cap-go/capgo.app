import type { OptionsBase } from '../src/schemas/base'
import { expect, spyOn, test } from 'bun:test'
import { describePrewarmRegion, prewarmApp } from '../src/app/prewarm'
import * as utils from '../src/utils'

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

test('prewarms an explicit app id without loading a Capacitor config', async () => {
  const requests: { path: string, apikey: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, apikey: request.headers.get('capgkey') ?? request.headers.get('authorization') })
      return Response.json({ app_id: 'com.example.prewarm', regions: [{ ...base, cached: 2 }] })
    },
  })
  // Behave as if no Capacitor project exists, whatever folder the test runs in.
  // The API host lookup tolerates that (it falls back to Capgo cloud); prewarm
  // must too when the app id is given.
  const getConfig = spyOn(utils, 'getConfig').mockImplementation(async () => {
    throw new Error('no Capacitor project')
  })
  const options = { apikey: 'test-key', apiHost: server.url.origin } as OptionsBase
  try {
    await prewarmApp('com.example.prewarm', options)
    // Without an app id, the project config is the only source: it still fails.
    await expect(prewarmApp(undefined, options)).rejects.toThrow('no Capacitor project')
  }
  finally {
    getConfig.mockRestore()
    server.stop(true)
  }
  expect(requests.map(request => request.path)).toEqual(['/app/com.example.prewarm/prewarm'])
  expect(requests[0].apikey).toContain('test-key')
})

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { fetchBuildMonitor } from '../src/build/monitor'
import { fetchObserve } from '../src/observe/api'
import { mcpBuildMonitorInputSchema, mcpObserveInputSchema } from '../src/mcp/tool-schemas'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('AI monitoring requests', () => {
  test('sends release channel selection and updater log source', async () => {
    const calls: Array<{ url: string, body: unknown }> = []
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ app_id: 'com.example.app', view: 'release', release: null })
    }, { preconnect: originalFetch.preconnect })
    await fetchObserve({ appId: 'com.example.app', view: 'release', channelId: 42, versionName: '1.2.0', apikey: 'example-test-key', apiHost: 'http://localhost:8787' })
    expect(calls[0].body).toMatchObject({ view: 'release', channelId: 42, versionName: '1.2.0' })
    await fetchObserve({ appId: 'com.example.app', view: 'errors', source: 'updater', apikey: 'example-test-key', apiHost: 'http://localhost:8787' })
    expect(calls[1].body).toMatchObject({ view: 'errors', source: 'updater' })
  })
  test('reads arbitrary cloud jobs through non-cancelling JSON snapshots', async () => {
    const calls: Array<{ url: string, method: string | undefined }> = []
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method })
      return Response.json(String(input).includes('/build/status') ? { job_id: 'ci/job-id', status: 'queued' } : { job_id: 'ci/job-id', logs: 'compile error', cursor: 12, truncated: false })
    }, { preconnect: originalFetch.preconnect })
    const options = { appId: 'com.example.app', jobId: 'ci/job-id', apikey: 'example-test-key', apiHost: 'http://localhost:8787', cursor: 7 }
    expect(await fetchBuildMonitor('logs', options)).toMatchObject({ cursor: 12 })
    expect(calls[0]).toMatchObject({ method: 'GET' })
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/build/logs/ci%2Fjob-id')
    expect(url.searchParams.get('app_id')).toBe(options.appId)
    expect(url.searchParams.get('snapshot')).toBe('true')
    expect(url.searchParams.get('cursor')).toBe('7')
    await fetchBuildMonitor('status', options)
    expect(new URL(calls[1].url).pathname).toBe('/build/status')
    expect(new URL(calls[1].url).searchParams.get('app_id')).toBe(options.appId)
  })
  test('MCP schemas expose monitoring fields but omit hosts and credentials', () => {
    expect(mcpObserveInputSchema.parse({ appId: 'com.example.app', view: 'release', channelId: 42, apiHost: 'https://example.com' })).toEqual({ appId: 'com.example.app', view: 'release', channelId: 42 })
    expect(mcpBuildMonitorInputSchema.parse({ appId: 'com.example.app', job_id: 'cloud-job', cursor: 7, apikey: 'secret' })).toEqual({ appId: 'com.example.app', job_id: 'cloud-job', cursor: 7 })
    expect(mcpBuildMonitorInputSchema.safeParse({ appId: 'com.example.app', job_id: 'job', cursor: -1 }).success).toBe(false)
  })
})


test.each([null, [], {}, 'unexpected', { app_id: 'com.example.app', view: 'release' }].map(body => ({ body })))('rejects unusable monitoring responses: %j', async ({ body }) => {
  globalThis.fetch = Object.assign(async () => Response.json(body), { preconnect: originalFetch.preconnect })
  const options = { appId: 'com.example.app', apikey: 'example-test-key', apiHost: 'http://localhost:8787' }
  await expect(fetchBuildMonitor('status', { ...options, jobId: 'ci-job' })).rejects.toThrow('invalid build status response')
  await expect(fetchBuildMonitor('logs', { ...options, jobId: 'ci-job' })).rejects.toThrow('invalid build logs response')
  await expect(fetchObserve({ ...options, view: 'release' })).rejects.toThrow('invalid Observe response')
})

test('rejects malformed JSON instead of treating it as healthy empty data', async () => {
  globalThis.fetch = Object.assign(async () => new Response('{broken', { headers: { 'content-type': 'application/json' } }), { preconnect: originalFetch.preconnect })
  await expect(fetchObserve({ appId: 'com.example.app', view: 'release', apikey: 'example-test-key', apiHost: 'http://localhost:8787' })).rejects.toThrow('invalid Observe response')
})

test('CLI help only advertises filters supported by each Observe view', () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const help = (view: string) => execFileSync('node', [entry, 'observe', view, '--help'], { encoding: 'utf8' })
  for (const view of ['summary', 'versions']) {
    expect(help(view)).not.toContain('--version-name')
    expect(help(view)).not.toContain('--action')
  }
  expect(help('release')).not.toContain('--days')
  expect(help('release')).toContain('--channel-id')
  expect(help('errors')).toContain('update_fail')
  expect(help('errors').replace(/\s+/g, ' ')).toContain('overrides the default action filter')
})

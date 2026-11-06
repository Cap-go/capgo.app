#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  createTimedFetch,
  deriveApiOperation,
  enableApiInstrumentation,
  getApiCallSource,
  isApiInstrumentationEnabled,
  setApiCallRecorder,
  SLOW_THRESHOLD_MS,
  withApiCallSource,
} from '../src/analytics/api-perf.ts'
import { invokeCapgoCliApi } from '../src/utils.ts'
import { resolveOwnerOrgId } from '../src/analytics/org-resolver.ts'

console.log('🧪 Testing api-perf...\n')

const originalFetch = globalThis.fetch

try {
  // 1. deriveApiOperation: query strings stripped, only static route segments kept
  assert.equal(deriveApiOperation('private/cli/preflight', 'POST'), 'POST private/cli/preflight')
  assert.equal(deriveApiOperation('private/cli/channels?app_id=com.x', 'GET'), 'GET private/cli/channels')
  assert.equal(deriveApiOperation('https://api.example.com/files/upload_link', 'POST'), 'POST files/upload_link')
  assert.equal(deriveApiOperation('not a url', 'GET'), 'GET not a url')

  // 2. enable flag defaults off
  assert.equal(isApiInstrumentationEnabled(), false)

  // 3. SLOW_THRESHOLD_MS is a positive number
  assert.equal(typeof SLOW_THRESHOLD_MS, 'number')
  assert.ok(SLOW_THRESHOLD_MS > 0)

  // 4. withApiCallSource is async-safe across Promise.all (no cross-talk)
  const tick = () => new Promise(r => setTimeout(r, 1))
  const labels = await Promise.all([
    withApiCallSource('a', async () => { await tick(); return getApiCallSource() }),
    withApiCallSource('b', async () => { await tick(); return getApiCallSource() }),
  ])
  assert.deepEqual(labels, ['a', 'b'])
  assert.equal(getApiCallSource(), undefined, 'no source outside a scope')

  // 5. timed fetch records raw info, returns the real response, captures source
  const recorded = []
  setApiCallRecorder(info => recorded.push(info))
  globalThis.fetch = async () => new Response('{}', { status: 200 })
  const tf = createTimedFetch()
  const res = await withApiCallSource('apps.list', () => tf('https://api.example.com/app?limit=1', { method: 'GET' }))
  assert.equal(res.status, 200, 'returns the real response')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].method, 'GET')
  assert.equal(recorded[0].ok, true)
  assert.equal(recorded[0].status, 200)
  assert.equal(recorded[0].source, 'apps.list')
  assert.equal(typeof recorded[0].durationMs, 'number')

  // 6. timed fetch rethrows the real error and records a failure
  globalThis.fetch = async () => { throw new Error('boom') }
  await assert.rejects(() => tf('https://api.example.com/app', { method: 'GET' }), /boom/)
  assert.equal(recorded[1].ok, false)
  assert.equal(recorded[1].status, 0)

  // --- Task 3: full `API Call` event via the wired real recorder ---
  const { flushAnalytics, trackCommandInvoked } = await import('../src/analytics/track.ts')
  const originalToken = process.env.CAPGO_TOKEN
  const originalDisable = process.env.CAPGO_DISABLE_TELEMETRY
  const originalDisablePosthog = process.env.CAPGO_DISABLE_POSTHOG
  delete process.env.CAPGO_DISABLE_TELEMETRY
  delete process.env.CAPGO_DISABLE_POSTHOG
  process.env.CAPGO_TOKEN = 'perf-key'

  const stubPerf = () => {
    const reqs = []
    globalThis.fetch = async (url, init) => {
      reqs.push({ url: String(url), init })
      if (String(url).startsWith('https://api.example.com/'))
        return new Response('{}', { status: 200 })
      if (String(url).endsWith('/private/config'))
        return new Response('', { status: 500 })
      return new Response('{}', { status: 200 })
    }
    return reqs
  }
  const findPerfEvent = reqs => reqs.find(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'API Call')

  // fast success path → no API Call event (volume guard)
  trackCommandInvoked('bundle upload', { flags: [], positional_arg_count: 0 })
  let reqs = stubPerf()
  const tf3 = createTimedFetch()
  await withApiCallSource('apps.list', () => tf3('https://api.example.com/app?limit=1', { method: 'GET' }))
  await flushAnalytics()
  assert.equal(findPerfEvent(reqs), undefined, 'fast success => no perf event')

  // HTTP failure path → ok:false, error_category from status (504 => timeout)
  reqs = []
  globalThis.fetch = async (url, init) => {
    reqs.push({ url: String(url), init })
    if (String(url).startsWith('https://api.example.com/'))
      return new Response('', { status: 504 })
    return new Response('{}', { status: 200 })
  }
  await withApiCallSource('apps.list', () => tf3('https://api.example.com/private/cli/preflight', { method: 'POST' }))
  await flushAnalytics()
  let ev = JSON.parse(findPerfEvent(reqs).init.body)
  assert.equal(ev.event, 'API Call')
  assert.equal(ev.channel, 'cli-perf')
  assert.equal(ev.tags.ok, false)
  assert.equal(ev.tags.operation, 'POST private/cli/preflight')
  assert.equal(ev.tags.source, 'apps.list')
  assert.equal(ev.tags.command_path, 'bundle upload')
  assert.equal(ev.tags.error_category, 'timeout')

  // slow success path → still emitted with slow:true
  reqs = []
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    globalThis.fetch = async (url, init) => {
      reqs.push({ url: String(url), init })
      now += SLOW_THRESHOLD_MS + 1
      return new Response('{}', { status: 200 })
    }
    await withApiCallSource('apps.list', () => tf3('https://api.example.com/app?limit=1', { method: 'GET' }))
    await flushAnalytics()
    ev = JSON.parse(findPerfEvent(reqs).init.body)
    assert.equal(ev.tags.ok, true)
    assert.equal(ev.tags.slow, true)
    assert.equal(ev.tags.operation, 'GET app')
  }
  finally {
    Date.now = realNow
  }

  process.env.CAPGO_TOKEN = originalToken
  if (originalDisable !== undefined) process.env.CAPGO_DISABLE_TELEMETRY = originalDisable
  if (originalDisablePosthog !== undefined) process.env.CAPGO_DISABLE_POSTHOG = originalDisablePosthog

  // --- Task 4: invokeCapgoCliApi gate + recursion guard ---
  // NOTE: this 'disabled' assertion depends on instrumentation still being OFF
  // here. enableApiInstrumentation() (called just below, and never reset in
  // finally) is process-wide — do not insert an enabling test before this block.
  process.env.CAPGO_TOKEN = 'perf-key'
  delete process.env.CAPGO_DISABLE_TELEMETRY
  delete process.env.CAPGO_DISABLE_POSTHOG

  const apiOptions = { apikey: 'perf-key', method: 'GET', apiHost: 'https://api.example.com' }
  const stubApi = (status) => {
    const reqs = []
    globalThis.fetch = async (url, init) => {
      reqs.push({ url: String(url), init })
      if (String(url).startsWith('https://api.example.com/'))
        return new Response(status === 200 ? '[]' : '', { status, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 200 })
    }
    return reqs
  }
  const findPerf = reqs => reqs.find(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'API Call')

  // disabled (default): no timed fetch attached → no perf event
  let creqs = stubApi(500)
  await invokeCapgoCliApi('private/cli/channels?app_id=com.demo', apiOptions)
  await flushAnalytics()
  assert.equal(findPerf(creqs), undefined, 'disabled => no perf event')

  // enabled + fast success: timed fetch attached, but no event (volume guard)
  enableApiInstrumentation()
  creqs = stubApi(200)
  await invokeCapgoCliApi('private/cli/channels?app_id=com.demo', apiOptions)
  await flushAnalytics()
  assert.equal(findPerf(creqs), undefined, 'enabled fast success => no perf event')

  // enabled + HTTP failure: perf event with operation
  creqs = stubApi(500)
  await invokeCapgoCliApi('private/cli/channels?app_id=com.demo', apiOptions)
  await flushAnalytics()
  const cev = findPerf(creqs)
  assert.ok(cev, 'enabled failure => perf event')
  assert.equal(JSON.parse(cev.init.body).tags.operation, 'GET private/cli/channels')
  assert.equal(JSON.parse(cev.init.body).tags.ok, false)

  // Routes keep only static path segments (no app ids)
  assert.equal(deriveApiOperation('https://api.capgo.app/app/com.demo.app', 'GET'), 'GET app')
  assert.equal(deriveApiOperation('https://api.capgo.app/private/cli/channels?app_id=x', 'GET'), 'GET private/cli/channels')
  assert.equal(deriveApiOperation('https://api.capgo.app/private/cli/organizations?permission=x', 'GET'), 'GET private/cli/organizations')

  // recursion guard: org-resolver must use an uninstrumented request
  creqs = []
  globalThis.fetch = async (url, init) => {
    creqs.push({ url: String(url), init })
    if (String(url).startsWith('https://api.example.com/'))
      return new Response('', { status: 500 })
    return new Response('{}', { status: 200 })
  }
  const orgId = await resolveOwnerOrgId('recursion-key', 'com.recursion.test', { apiHost: 'https://api.example.com' })
  await flushAnalytics()
  assert.equal(orgId, undefined)
  assert.equal(findPerf(creqs), undefined, 'org-resolver must not emit perf events')

  // --- Task 6: source label flows into failed events ---
  process.env.CAPGO_TOKEN = 'perf-key'
  const lreqs = stubApi(503)
  await withApiCallSource('apps.list', () => invokeCapgoCliApi('app', apiOptions))
  await flushAnalytics()
  const lev = findPerf(lreqs)
  assert.ok(lev, 'labeled failed query emits a perf event')
  const ltags = JSON.parse(lev.init.body).tags
  assert.equal(ltags.source, 'apps.list')
  assert.equal(ltags.operation, 'GET app')
  assert.equal(ltags.ok, false)

  // --- Codex P2: perf telemetry uses the key from the request's capgkey header ---
  // (so events fire for --apikey usage, not just env / saved-file keys)
  process.env.CAPGO_TOKEN = 'env-fallback-key'
  const hreqs = []
  globalThis.fetch = async (url, init) => {
    hreqs.push({ url: String(url), init })
    return new Response('', { status: 500 })
  }
  const tfHeader = createTimedFetch()
  await tfHeader('https://api.example.com/app?limit=1', { method: 'GET', headers: { capgkey: 'header-key' } })
  await flushAnalytics()
  const headerEvent = hreqs.find(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'API Call')
  assert.ok(headerEvent, 'perf event fires using the key from the request header')
  assert.equal(headerEvent.init.headers.capgkey, 'header-key', 'perf telemetry uses the capgkey from the request, not the env fallback')

  // --- Codex P2: MCP command_path is per-invocation (no cross-talk between overlapping tools) ---
  const { withMcpToolTracking } = await import('../src/analytics/track.ts')
  process.env.CAPGO_TOKEN = 'perf-key'
  const mreqs = []
  globalThis.fetch = async (url, init) => {
    mreqs.push({ url: String(url), init })
    return new Response('', { status: 500 })
  }
  const tickMs = () => new Promise(r => setTimeout(r, 5))
  const tfMcp = createTimedFetch()
  const handlerA = withMcpToolTracking('tool_a', async () => { await tickMs(); await tfMcp('https://api.example.com/app', { method: 'GET' }) })
  const handlerB = withMcpToolTracking('tool_b', async () => { await tfMcp('https://api.example.com/channel', { method: 'GET' }) })
  await Promise.all([handlerA({}), handlerB({})])
  await flushAnalytics()
  const mcpPerf = mreqs
    .filter(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'API Call')
    .map(r => JSON.parse(r.init.body).tags)
  assert.equal(mcpPerf.find(t => t.operation === 'GET app').command_path, 'mcp:tool_a', 'tool_a API call attributed to tool_a despite interleaving')
  assert.equal(mcpPerf.find(t => t.operation === 'GET channel').command_path, 'mcp:tool_b', 'tool_b API call attributed to tool_b')

  console.log('✅ api-perf tests passed')
}
finally {
  globalThis.fetch = originalFetch
}

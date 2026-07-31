#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  createTimedFetch,
  deriveSupabaseOperation,
  enableSupabaseInstrumentation,
  getSupabaseSource,
  isSupabaseInstrumentationEnabled,
  setSupabaseCallRecorder,
  SLOW_THRESHOLD_MS,
  withSupabaseSource,
} from '../src/analytics/supabase-perf.ts'
import { createSupabaseClient } from '../src/utils.ts'
import { resolveOwnerOrgId } from '../src/analytics/org-resolver.ts'

console.log('🧪 Testing supabase-perf...\n')

const originalFetch = globalThis.fetch

try {
  // 1. deriveSupabaseOperation: query strings stripped, rpc vs table
  assert.equal(deriveSupabaseOperation('https://db.co/rest/v1/rpc/get_user_id', 'POST'), 'rpc:get_user_id')
  assert.equal(deriveSupabaseOperation('https://db.co/rest/v1/apps?select=*&app_id=eq.com.x', 'GET'), 'GET apps')
  assert.equal(deriveSupabaseOperation('https://db.co/rest/v1/app_versions', 'POST'), 'POST app_versions')
  assert.equal(deriveSupabaseOperation('https://db.co/functions/v1/files/upload_link', 'POST'), 'POST functions:files/upload_link')
  assert.equal(deriveSupabaseOperation('https://db.co/functions/v1/private/delete_failed_version', 'DELETE'), 'DELETE functions:private/delete_failed_version')
  assert.equal(deriveSupabaseOperation('not a url', 'GET'), 'GET not a url')

  // 2. enable flag defaults off
  assert.equal(isSupabaseInstrumentationEnabled(), false)

  // 3. SLOW_THRESHOLD_MS is a positive number
  assert.equal(typeof SLOW_THRESHOLD_MS, 'number')
  assert.ok(SLOW_THRESHOLD_MS > 0)

  // 4. withSupabaseSource is async-safe across Promise.all (no cross-talk)
  const tick = () => new Promise(r => setTimeout(r, 1))
  const labels = await Promise.all([
    withSupabaseSource('a', async () => { await tick(); return getSupabaseSource() }),
    withSupabaseSource('b', async () => { await tick(); return getSupabaseSource() }),
  ])
  assert.deepEqual(labels, ['a', 'b'])
  assert.equal(getSupabaseSource(), undefined, 'no source outside a scope')

  // 5. timed fetch records raw info, returns the real response, captures source
  const recorded = []
  setSupabaseCallRecorder(info => recorded.push(info))
  globalThis.fetch = async () => new Response('{}', { status: 200 })
  const tf = createTimedFetch()
  const res = await withSupabaseSource('apps.list', () => tf('https://db.co/rest/v1/apps?select=*', { method: 'GET' }))
  assert.equal(res.status, 200, 'returns the real response')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].method, 'GET')
  assert.equal(recorded[0].ok, true)
  assert.equal(recorded[0].status, 200)
  assert.equal(recorded[0].source, 'apps.list')
  assert.equal(typeof recorded[0].durationMs, 'number')

  // 6. timed fetch rethrows the real error and records a failure
  globalThis.fetch = async () => { throw new Error('boom') }
  await assert.rejects(() => tf('https://db.co/rest/v1/apps', { method: 'GET' }), /boom/)
  assert.equal(recorded[1].ok, false)
  assert.equal(recorded[1].status, 0)

  // --- Task 3: full `Supabase Call` event via the wired real recorder ---
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
      if (String(url).includes('/rest/v1/'))
        return new Response('{}', { status: 200 })
      if (String(url).endsWith('/private/config'))
        return new Response('', { status: 500 })
      return new Response('{}', { status: 200 })
    }
    return reqs
  }
  const findPerfEvent = reqs => reqs.find(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'Supabase Call')

  // fast success path → no Supabase Call event (volume guard)
  trackCommandInvoked('bundle upload', { flags: [], positional_arg_count: 0 })
  let reqs = stubPerf()
  const tf3 = createTimedFetch()
  await withSupabaseSource('apps.list', () => tf3('https://db.co/rest/v1/apps?select=*', { method: 'GET' }))
  await flushAnalytics()
  assert.equal(findPerfEvent(reqs), undefined, 'fast success => no perf event')

  // HTTP failure path → ok:false, error_category from status (504 => timeout)
  reqs = []
  globalThis.fetch = async (url, init) => {
    reqs.push({ url: String(url), init })
    if (String(url).includes('/rest/v1/'))
      return new Response('', { status: 504 })
    return new Response('{}', { status: 200 })
  }
  await withSupabaseSource('apps.list', () => tf3('https://db.co/rest/v1/rpc/get_user_id', { method: 'POST' }))
  await flushAnalytics()
  let ev = JSON.parse(findPerfEvent(reqs).init.body)
  assert.equal(ev.event, 'Supabase Call')
  assert.equal(ev.channel, 'cli-perf')
  assert.equal(ev.tags.ok, false)
  assert.equal(ev.tags.operation, 'rpc:get_user_id')
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
    await withSupabaseSource('apps.list', () => tf3('https://db.co/rest/v1/apps?select=*', { method: 'GET' }))
    await flushAnalytics()
    ev = JSON.parse(findPerfEvent(reqs).init.body)
    assert.equal(ev.tags.ok, true)
    assert.equal(ev.tags.slow, true)
    assert.equal(ev.tags.operation, 'GET apps')
  }
  finally {
    Date.now = realNow
  }

  process.env.CAPGO_TOKEN = originalToken
  if (originalDisable !== undefined) process.env.CAPGO_DISABLE_TELEMETRY = originalDisable
  if (originalDisablePosthog !== undefined) process.env.CAPGO_DISABLE_POSTHOG = originalDisablePosthog

  // --- Task 4: createSupabaseClient gate + recursion guard ---
  // NOTE: this 'disabled' assertion depends on instrumentation still being OFF
  // here. enableSupabaseInstrumentation() (called just below, and never reset in
  // finally) is process-wide — do not insert an enabling test before this block.
  process.env.CAPGO_TOKEN = 'perf-key'
  delete process.env.CAPGO_DISABLE_TELEMETRY
  delete process.env.CAPGO_DISABLE_POSTHOG

  const stubClient = () => {
    const reqs = []
    globalThis.fetch = async (url, init) => {
      reqs.push({ url: String(url), init })
      if (String(url).endsWith('/private/config'))
        return new Response(JSON.stringify({ supaHost: 'https://db.co', supaKey: 'anon' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (String(url).includes('/rest/v1/'))
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 200 })
    }
    return reqs
  }
  const findPerf = reqs => reqs.find(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'Supabase Call')

  // disabled (default): no timed fetch attached → no Supabase Call event
  let creqs = stubClient()
  let sb = await createSupabaseClient('perf-key', 'https://db.co', 'anon')
  await sb.from('demo').select('*')
  await flushAnalytics()
  assert.equal(findPerf(creqs), undefined, 'disabled => no perf event')

  // enabled + fast success: timed fetch attached, but no event (volume guard)
  enableSupabaseInstrumentation()
  creqs = stubClient()
  sb = await createSupabaseClient('perf-key', 'https://db.co', 'anon')
  await sb.from('demo').select('*')
  await flushAnalytics()
  assert.equal(findPerf(creqs), undefined, 'enabled fast success => no perf event')

  // enabled + HTTP failure: Supabase Call event with operation
  creqs = []
  globalThis.fetch = async (url, init) => {
    creqs.push({ url: String(url), init })
    if (String(url).endsWith('/private/config'))
      return new Response(JSON.stringify({ supaHost: 'https://db.co', supaKey: 'anon' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (String(url).includes('/rest/v1/'))
      return new Response('', { status: 500, headers: { 'Content-Type': 'application/json' } })
    return new Response('{}', { status: 200 })
  }
  sb = await createSupabaseClient('perf-key', 'https://db.co', 'anon')
  await sb.from('demo').select('*')
  await flushAnalytics()
  const cev = findPerf(creqs)
  assert.ok(cev, 'enabled failure => perf event')
  assert.equal(JSON.parse(cev.init.body).tags.operation, 'GET demo')
  assert.equal(JSON.parse(cev.init.body).tags.ok, false)

  // recursion guard: org-resolver must build an UNinstrumented client
  let capturedInstrument
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    abortSignal: () => chain,
    maybeSingle: async () => ({ data: { owner_org: 'org-x' } }),
  }
  const orgId = await resolveOwnerOrgId('recursion-key', 'com.recursion.test', {
    createClient: async (_apikey, _host, _key, _silent, instrument) => {
      capturedInstrument = instrument
      return chain
    },
  })
  assert.equal(orgId, 'org-x')
  assert.equal(capturedInstrument, false, 'org-resolver must create an uninstrumented client')

  // --- Task 6: source label flows into failed events ---
  process.env.CAPGO_TOKEN = 'perf-key'
  let lreqs = []
  globalThis.fetch = async (url, init) => {
    lreqs.push({ url: String(url), init })
    if (String(url).endsWith('/private/config'))
      return new Response(JSON.stringify({ supaHost: 'https://db.co', supaKey: 'anon' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (String(url).includes('/rest/v1/'))
      return new Response('', { status: 503, headers: { 'Content-Type': 'application/json' } })
    return new Response('{}', { status: 200 })
  }
  enableSupabaseInstrumentation()
  const lsb = await createSupabaseClient('perf-key', 'https://db.co', 'anon')
  await withSupabaseSource('apps.list', () => lsb
    .from('apps')
    .select()
    .order('created_at', { ascending: false }))
  await flushAnalytics()
  const lev = findPerf(lreqs)
  assert.ok(lev, 'labeled failed query emits a perf event')
  const ltags = JSON.parse(lev.init.body).tags
  assert.equal(ltags.source, 'apps.list')
  assert.equal(ltags.operation, 'GET apps')
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
  await tfHeader('https://db.co/rest/v1/apps?select=*', { method: 'GET', headers: { capgkey: 'header-key' } })
  await flushAnalytics()
  const headerEvent = hreqs.find(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'Supabase Call')
  assert.ok(headerEvent, 'perf event fires using the key from the request header')
  assert.equal(headerEvent.init.headers.capgkey, 'header-key', 'perf telemetry uses the capgkey from the Supabase request, not the env fallback')

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
  const handlerA = withMcpToolTracking('tool_a', async () => { await tickMs(); await tfMcp('https://db.co/rest/v1/apps', { method: 'GET' }) })
  const handlerB = withMcpToolTracking('tool_b', async () => { await tfMcp('https://db.co/rest/v1/channels', { method: 'GET' }) })
  await Promise.all([handlerA({}), handlerB({})])
  await flushAnalytics()
  const mcpPerf = mreqs
    .filter(r => r.url.endsWith('/private/events') && JSON.parse(r.init.body).event === 'Supabase Call')
    .map(r => JSON.parse(r.init.body).tags)
  assert.equal(mcpPerf.find(t => t.operation === 'GET apps').command_path, 'mcp:tool_a', 'tool_a Supabase call attributed to tool_a despite interleaving')
  assert.equal(mcpPerf.find(t => t.operation === 'GET channels').command_path, 'mcp:tool_b', 'tool_b Supabase call attributed to tool_b')

  console.log('✅ supabase-perf tests passed')
}
finally {
  globalThis.fetch = originalFetch
}

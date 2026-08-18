#!/usr/bin/env node
import assert from 'node:assert/strict'
import { deferCommandInvocation, extractCommandContext, flushAnalytics, flushDeferredCommandInvocation, getGlobalAnalyticsProps, setInvocationSource, trackCommandFailed, trackCommandInvoked, trackCommandSucceeded, trackEvent } from '../src/analytics/track.ts'

console.log('🧪 Testing analytics track.ts...\n')

const originalFetch = globalThis.fetch
const originalDisable = process.env.CAPGO_DISABLE_TELEMETRY
const originalDisablePosthog = process.env.CAPGO_DISABLE_POSTHOG
const originalToken = process.env.CAPGO_TOKEN

function stubFetch() {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url) })
    if (String(url).endsWith('/private/config'))
      return new Response('', { status: 500 })
    return new Response('{}', { headers: { 'Content-Type': 'application/json' }, status: 200 })
  }
  return requests
}
const findEvent = requests => requests.find(r => r.url.endsWith('/private/events'))

try {
  // 1. global props shape
  setInvocationSource('cli')
  const props = getGlobalAnalyticsProps()
  assert.equal(typeof props.cli_version, 'string')
  assert.equal(typeof props.node_version, 'string')
  assert.equal(typeof props.os_platform, 'string')
  assert.equal(typeof props.os_arch, 'string')
  assert.equal(typeof props.os_release, 'string')
  assert.equal(typeof props.timezone, 'string')
  assert.equal(typeof props.is_ci, 'boolean')
  assert.equal(typeof props.is_tty, 'boolean')
  assert.equal(props.invocation_source, 'cli')

  // 2. v2 actor-scoped payload (explicit org + app => no context lookup)
  delete process.env.CAPGO_DISABLE_TELEMETRY
  delete process.env.CAPGO_DISABLE_POSTHOG
  let requests = stubFetch()
  await trackEvent({ apikey: 'capgo-key', channel: 'cli-usage', event: 'Test Event', orgId: 'org-1', appId: 'com.example.app', tags: { foo: 'bar', count: 3, flag: true } })
  await flushAnalytics()
  const req = findEvent(requests)
  assert.ok(req, 'expected a /private/events request')
  assert.equal(req.init.method, 'POST')
  assert.equal(req.init.headers.capgkey, 'capgo-key')
  let body = JSON.parse(req.init.body)
  assert.equal(body.event, 'Test Event')
  assert.equal(body.channel, 'cli-usage')
  assert.equal('icon' in body, false)
  assert.equal('notify' in body, false)
  assert.equal('parser' in body, false)
  assert.equal(body.org_id, 'org-1')
  assert.equal(body.tracking_version, 2)
  assert.equal(body.user_id, undefined, 'CLI must not send user_id (backend derives it)')
  assert.equal(body.tags.app_id, 'com.example.app')
  assert.equal(body.tags.foo, 'bar')
  assert.equal(body.tags.count, 3)
  assert.equal(body.tags.flag, true)
  assert.equal(body.nonPersonTags.invocation_source, 'cli')
  assert.equal(typeof body.nonPersonTags.cli_version, 'string')

  // 3. opt-out suppresses the send
  process.env.CAPGO_DISABLE_TELEMETRY = '1'
  requests = stubFetch()
  await trackEvent({ apikey: 'capgo-key', channel: 'cli-usage', event: 'Nope', orgId: 'o', appId: 'a' })
  await flushAnalytics()
  assert.equal(findEvent(requests), undefined, 'opt-out must suppress events')
  delete process.env.CAPGO_DISABLE_TELEMETRY

  // (the no-key early return is exercised in the migration suite; it can't be
  //  simulated reliably here because the dev machine has a saved ~/.capgo)

  // 5. command-context extraction (flag NAMES only)
  const fakeCommand = {
    args: ['com.example.app'],
    opts: () => ({ channel: 'production', apikey: 'x', verbose: false }),
    getOptionValueSource: key => (key === 'verbose' ? 'default' : 'cli'),
  }
  const ctx = extractCommandContext(fakeCommand)
  assert.deepEqual(ctx.flags, ['apikey', 'channel'], 'only user-set flag names, sorted')
  assert.equal(ctx.positional_arg_count, 1)

  // 6. lifecycle (key via env; context resolved best-effort, asserted loosely)
  process.env.CAPGO_TOKEN = 'lifecycle-key'
  requests = stubFetch()
  trackCommandInvoked('bundle upload', ctx)
  await flushAnalytics()
  body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.event, 'CLI Command Invoked')
  assert.equal(body.channel, 'cli-usage')
  assert.equal(body.tags.command_path, 'bundle upload')
  assert.equal(body.tags.flags, 'apikey,channel')
  assert.equal(body.tags.flags_count, 2)
  assert.equal(body.tags.positional_arg_count, 1)

  // 6b. login/init defer invocation until an explicitly validated key is available
  process.env.CAPGO_TOKEN = 'stale-key'
  requests = stubFetch()
  deferCommandInvocation('login', { flags: ['apikey'], positional_arg_count: 0 })
  await flushAnalytics()
  assert.equal(findEvent(requests), undefined, 'deferred invocation must not use a stale saved or environment key')

  flushDeferredCommandInvocation('validated-key')
  await flushAnalytics()
  const deferredRequests = requests.filter(request => request.url.endsWith('/private/events'))
  assert.equal(deferredRequests.length, 1, 'deferred invocation emits exactly once after validation')
  assert.equal(deferredRequests[0].init.headers.capgkey, 'validated-key', 'deferred invocation uses the validated key explicitly')
  body = JSON.parse(deferredRequests[0].init.body)
  assert.equal(body.event, 'CLI Command Invoked')
  assert.equal(body.tags.command_path, 'login')
  assert.equal(body.tags.flags, 'apikey')
  assert.equal(JSON.stringify(body.tags).includes('validated-key'), false, 'validated API keys must not appear in analytics tags')

  flushDeferredCommandInvocation('validated-key')
  await flushAnalytics()
  assert.equal(requests.filter(request => request.url.endsWith('/private/events')).length, 1, 'flushing a consumed invocation does not duplicate it')

  requests = stubFetch()
  trackCommandSucceeded('bundle upload')
  await flushAnalytics()
  body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.event, 'CLI Command Succeeded')
  assert.equal(typeof body.tags.duration_ms, 'number')

  requests = stubFetch()
  trackCommandFailed('bundle upload', { errorCategory: 'network_error', exitCode: 1 })
  await flushAnalytics()
  body = JSON.parse(findEvent(requests).init.body)
  assert.equal(body.event, 'CLI Command Failed')
  assert.equal(body.tags.error_category, 'network_error')
  assert.equal(body.tags.exit_code, 1)

  // 7. flush aborts in-flight telemetry so the CLI process can exit promptly
  //    (offline/firewalled users must not hang on a stuck telemetry socket).
  let capturedSignal
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/private/config'))
      return new Response('', { status: 500 })
    capturedSignal = init?.signal
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  const hung = trackEvent({ apikey: 'flush-key', channel: 'cli-usage', event: 'Hang', orgId: 'o', appId: 'a' })
  await flushAnalytics(50)
  assert.ok(capturedSignal, 'in-flight telemetry fetch received an abort signal')
  assert.equal(capturedSignal.aborted, true, 'flush aborts in-flight telemetry past its window')
  await hung.catch(() => {})

  console.log('✅ analytics track.ts tests passed')
}
finally {
  globalThis.fetch = originalFetch
  if (originalDisable === undefined)
    delete process.env.CAPGO_DISABLE_TELEMETRY
  else process.env.CAPGO_DISABLE_TELEMETRY = originalDisable
  if (originalDisablePosthog === undefined)
    delete process.env.CAPGO_DISABLE_POSTHOG
  else process.env.CAPGO_DISABLE_POSTHOG = originalDisablePosthog
  if (originalToken === undefined)
    delete process.env.CAPGO_TOKEN
  else process.env.CAPGO_TOKEN = originalToken
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const BASE = 'https://api.cloudflare.com/client/v4/zones/7fe39404d772c5a0b4444f5a0475a586/snippets'
const NAME = 'plugin_load_balancer'
const MAX_MODULE_BYTES = 32 * 1024
const MAX_RULES_BYTES = 256 * 1024
const sha256 = value => createHash('sha256').update(value).digest('hex')

class CheckFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

async function boundedText(response, limit) {
  if (!response.body)
    throw new CheckFailure('empty_provider_response')
  const reader = response.body.getReader()
  const parts = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        return Buffer.concat(parts).toString('utf8')
      bytes += value.byteLength
      if (bytes > limit)
        throw new CheckFailure('provider_response_too_large')
      parts.push(value)
    }
  }
  finally {
    await reader.cancel().catch(() => {})
  }
}

export async function readLiveGuard({ token, expected, fetcher = fetch }) {
  if (!token || !expected || Buffer.byteLength(expected) > MAX_MODULE_BYTES)
    throw new CheckFailure('invalid_check_configuration')
  const startedAt = new Date().toISOString()
  let requests = 0
  async function get(path, limit) {
    requests++
    const response = await fetcher(`${BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new CheckFailure('provider_request_failed') })
    if (!response.ok)
      throw new CheckFailure(`provider_http_${response.status}`)
    const text = await boundedText(response, limit)
    return new Response(text, { headers: response.headers })
  }
  async function rules() {
    const data = await (await get('/snippet_rules', MAX_RULES_BYTES)).json().catch(() => null)
    if (!data || data.success !== true || !Array.isArray(data.result)
      || data.result.some(rule => !rule || typeof rule.snippet_name !== 'string'
        || typeof rule.expression !== 'string' || typeof rule.enabled !== 'boolean'
        || (rule.description != null && typeof rule.description !== 'string')))
      throw new CheckFailure('invalid_rules_response')
    const normalized = data.result.map(({ snippet_name, expression, enabled, description }) => ({
      snippet_name, expression, enabled, description: description ?? '',
    }))
    const plugin = normalized.filter(rule => rule.snippet_name === NAME)
    if (plugin.length !== 1 || !plugin[0].enabled)
      throw new CheckFailure('plugin_rule_not_uniquely_enabled')
    return { sha256: sha256(JSON.stringify(normalized)), count: normalized.length,
      pluginRuleSha256: sha256(JSON.stringify(plugin[0])) }
  }

  const before = await rules()
  // Multipart overhead is bounded separately from the module's provider limit.
  const response = await get(`/${NAME}/content`, MAX_MODULE_BYTES + 16 * 1024)
  const form = await response.formData().catch(() => null)
  const files = form ? [...form.values()].filter(value => typeof value !== 'string') : []
  if (files.length !== 1 || files[0].size > MAX_MODULE_BYTES)
    throw new CheckFailure('invalid_module_response')
  const live = await files[0].text()
  if (live !== expected)
    throw new CheckFailure('live_module_differs_from_pinned_build')
  const after = await rules()
  if (before.sha256 !== after.sha256)
    throw new CheckFailure('rules_changed_during_read')
  return { live, receipt: {
    startedAt, completedAt: new Date().toISOString(), method: 'GET', requests,
    moduleSha256: sha256(live), moduleBytes: Buffer.byteLength(live),
    compiledModuleEqualsLive: true, rulesStableDuringRead: true,
    rulesSha256: after.sha256, ruleCount: after.count,
    pluginRuleSha256: after.pluginRuleSha256, pluginRuleEnabled: true,
    ruleExpressionCoverageVerified: false,
  } }
}

// Execute only a module already equal to the pinned public build. The context has
// no process, token, real fetch, imports or real Cache API. All fixtures are fake.
export async function validateGuard(code) {
  const appId = 'com.example.snippetguard'
  const deviceId = '00000000-0000-4000-8000-000000000001'
  const otherDeviceId = '00000000-0000-4000-8000-000000000002'
  const noNew = { error: 'no_new_version_available', message: 'No new version available', kind: 'up_to_date' }
  const fill = encodeURIComponent(JSON.stringify({ v: 2, bps: 10000, ttl: 900,
    tags: `capgo-updates-${appId},capgo-snippet-edge-answers`, e: 'updates', n: '1.2.3', k: null, cs: true }))
  const context = vm.createContext({ Request, Response, Headers, URL, URLSearchParams,
    TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, btoa,
    console: { log() {} } }, { codeGeneration: { strings: false, wasm: false } })
  const module = new vm.SourceTextModule(code, { context })
  await module.link(() => { throw new CheckFailure('module_import_not_allowed') })
  await module.evaluate({ timeout: 1000 })
  const handler = module.namespace.default
  if (typeof handler?.fetch !== 'function')
    throw new CheckFailure('module_has_no_handler')
  let passed = 0

  function request(endpoint = 'updates', device = deviceId) {
    const body = { app_id: appId, device_id: device, platform: 'ios', version_name: '1.2.3',
      version_build: '2.0', plugin_version: '7.40.0', is_emulator: false, is_prod: true,
      defaultChannel: 'production', action: 'app_moved_to_foreground' }
    const url = new URL(`https://api.capgo.app/${endpoint}`)
    if (endpoint === 'channel_self')
      url.search = new URLSearchParams(body).toString()
    const req = new Request(url, { method: endpoint === 'channel_self' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      ...(endpoint === 'channel_self' ? {} : { body: JSON.stringify(body) }) })
    Object.defineProperty(req, 'cf', { value: { colo: 'SFO', asn: 3215, country: 'US' } })
    return req
  }
  function runtime(provider) {
    const entries = new Map()
    const puts = []
    let fetches = 0
    let operations = 0
    const keyOf = key => key instanceof Request ? key.url : String(key)
    context.caches = { default: {
      async match(key) { operations++; return entries.get(keyOf(key))?.clone() },
      async put(key, response) { operations++; puts.push(keyOf(key)); entries.set(keyOf(key), response.clone()) },
      async delete(key) { operations++; return entries.delete(keyOf(key)) },
    } }
    context.fetch = async () => { operations++; return provider(++fetches) }
    return { puts, fetches: () => fetches, operations: () => operations,
      appPuts: () => puts.filter(key => !key.includes('/edge-ip-limit-v1/') && !key.includes('/circuit-breaker/')) }
  }
  const bodyFor = kind => kind === 'on-prem' ? { error: 'on_premise_app' }
    : kind === 'stats-on-prem' ? { isOnprem: true }
      : kind === 'plan' ? { error: 'need_plan_upgrade' } : noNew
  function response(kind, source, status) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
    if (source) headers['X-Plugin-State'] = source
    if (kind === 'edge-fill') headers['X-Capgo-Edge-Fill'] = fill
    return new Response(JSON.stringify(bodyFor(kind)), { status, headers })
  }
  async function shared(kind, source, endpoint = 'updates', status = kind === 'edge-fill' ? 200 : 429) {
    const calls = runtime(n => response(kind, n === 1 ? source : undefined, status))
    const first = await handler.fetch(request(endpoint))
    assert.equal(first.status, status)
    assert.equal(JSON.stringify(await first.json()), JSON.stringify(bodyFor(kind)))
    const skips = source?.startsWith('kv') === true
    assert.equal(calls.appPuts().length > 0, !skips)
    assert.equal(calls.fetches(), 1)
    assert.ok(calls.operations() <= 5)
    assert.equal(first.headers.get('X-Capgo-Edge-Fill'), null)
    const second = await handler.fetch(request(endpoint, otherDeviceId))
    assert.equal(JSON.stringify(await second.json()), JSON.stringify(bodyFor(kind)))
    assert.equal(calls.fetches(), skips ? 2 : 1)
    passed++
  }
  for (const kind of ['on-prem', 'stats-on-prem', 'plan', 'edge-fill'])
    for (const source of [undefined, 'fallback', 'kv', 'kv-escaped', 'kv-future'])
      await shared(kind, source)
  for (const source of [undefined, 'fallback', 'kv', 'kv-escaped', 'kv-future'])
    await shared('stats-on-prem', source, 'stats', 200)
  for (const source of ['kv', 'kv-escaped', 'db']) {
    const reset = Math.ceil(Date.now() / 1000) + 600
    const calls = runtime(() => new Response(JSON.stringify(bodyFor('on-prem')), { status: 429, headers: {
      'X-Plugin-State': source, 'Cache-Control': 'private, no-store',
      'X-Capgo-Edge-Ip-Limit': String(reset), 'X-RateLimit-Reset': String(reset), 'Retry-After': '600',
    } }))
    const result = await handler.fetch(request())
    assert.equal(result.status, 429)
    assert.equal(result.headers.get('Retry-After'), '600')
    assert.equal(result.headers.get('X-RateLimit-Reset'), String(reset))
    assert.equal(result.headers.get('X-Capgo-Edge-Ip-Limit'), null)
    assert.equal(calls.appPuts().length, 0)
    assert.equal(calls.puts.filter(key => key.includes('/edge-ip-limit-v1/')).length, 1)
    assert.ok(calls.operations() <= 5)
    passed++
    const retry = runtime(() => new Response(JSON.stringify(bodyFor('on-prem')), { status: 429, headers: {
      'X-Plugin-State': source, 'Cache-Control': 'public, max-age=600', 'Retry-After': '600', 'X-RateLimit-Reset': String(reset),
    } }))
    const retryResult = await handler.fetch(request())
    assert.equal(retryResult.headers.get('Retry-After'), '600')
    assert.equal(retryResult.headers.get('X-RateLimit-Reset'), String(reset))
    assert.equal(retry.appPuts().length > 0, !source.startsWith('kv'))
    assert.ok(retry.operations() <= 5)
    passed++
  }
  for (const source of ['db', 'kv']) {
    const fallback = runtime(n => n === 1 ? new Response('upstream error', { status: 502 }) : response('on-prem', source, 429))
    assert.equal((await handler.fetch(request())).status, 429)
    assert.equal(fallback.fetches(), 2)
    assert.equal(fallback.appPuts().length, 0)
    assert.ok(fallback.operations() <= 5)
    passed++
    const plain = runtime(() => new Response('plain backend reply', { headers: {
      'Content-Type': 'text/plain', 'X-Plugin-State': source, 'X-Fixture-Header': 'preserved',
    } }))
    const result = await handler.fetch(request())
    assert.equal(await result.text(), 'plain backend reply')
    assert.equal(result.headers.get('X-Fixture-Header'), 'preserved')
    assert.equal(plain.fetches(), 1)
    assert.equal(plain.appPuts().length, 0)
    assert.ok(plain.operations() <= 5)
    passed++
    await shared('on-prem', source, 'channel_self')
  }
  return { passed, realNetworkCalls: 0, fakeFixturesOnly: true }
}

async function main() {
  const [mode, directory] = process.argv.slice(2)
  if (!['capture', 'validate'].includes(mode) || !directory || process.argv.length !== 4)
    throw new CheckFailure('invalid_arguments')
  const path = name => resolve(directory, name)
  if (mode === 'capture') {
    await chmod(directory, 0o700)
    const expected = await readFile(path('expected.mjs'), 'utf8')
    const { live, receipt } = await readLiveGuard({ token: process.env.CLOUDFLARE_API_TOKEN, expected })
    await writeFile(path('live.mjs'), live, { mode: 0o600, flag: 'wx' })
    await writeFile(path('capture.json'), JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
    return
  }
  if (process.env.CLOUDFLARE_API_TOKEN)
    throw new CheckFailure('token_present_during_behavior_validation')
  const [code, expected, receipt] = await Promise.all([
    readFile(path('live.mjs'), 'utf8'), readFile(path('expected.mjs'), 'utf8'),
    readFile(path('capture.json'), 'utf8').then(JSON.parse),
  ])
  if (code !== expected || sha256(code) !== receipt.moduleSha256)
    throw new CheckFailure('captured_module_changed')
  const guard = await validateGuard(code)
  const result = { ...receipt, guard, validatedAt: new Date().toISOString(),
    acceptedReleaseSha: process.env.ACCEPTED_RELEASE_SHA,
    checkerSha: process.env.CHECKER_SHA, bunBuildVersion: process.env.BUN_BUILD_VERSION,
    rolloutReadinessVerified: false, incidentResolutionVerified: false,
    actualProductionExecutionObserved: false,
    scope: 'Current module equality, enabled rule metadata and mocked guard behavior only; no rollout readiness or incident resolution.' }
  await writeFile(path('result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Never print provider bodies, live source, rule expressions or raw stacks.
    const reason = error instanceof CheckFailure ? error.code
      : error?.code === 'ERR_ASSERTION' ? 'guard_behavior_failed' : 'check_failed'
    console.error(JSON.stringify({ passed: false, reason }))
    process.exitCode = 1
  })
}

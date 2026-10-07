#!/usr/bin/env bun
/**
 * End-to-end benchmark: plugin edge cache (/updates, /stats, /channel_self)
 * vs the current path.
 *
 * Measures, against two locally running plugin workers sharing one local
 * Supabase database:
 * - Postgres statements executed per request (pg_stat_statements) on
 *   /updates, /stats and /channel_self
 * - client-observed response time
 * - time until a device receives a change made in the console / API
 *   (channel version switch, first device override, channel self-assign
 *   allowed, bundle uploaded after devices reported it) or through channel_self
 *
 * Setup (see PR description for the exact commands):
 * - BASE_URL: plugin worker with UPDATES_EDGE_CACHE=off (main, or this branch:
 *             off is the unchanged path)            (default http://127.0.0.1:18798)
 * - EDGE_URL: plugin worker from this branch with UPDATES_EDGE_CACHE=on
 *             and UPDATES_CACHE_LOCAL_PURGE_URL=<EDGE_URL>/cache_purge_local
 *                                                     (default http://127.0.0.1:18788)
 * - API_URL:  API worker from this branch (serves triggers/updates_cache_purge)
 *                                                     (default http://127.0.0.1:18787)
 * - DB_URL:   local Supabase Postgres URL (bun run supabase:status -- -o env)
 *
 * - BENCH_DOCKER_NETWORK: docker network of the local Supabase stack
 * - SUPABASE_API_URL: local Supabase API (kong) URL, receives the other triggers
 * - BENCH_RELAY_ONLY=1: only run the trigger relay (with purges on) until
 *   Ctrl+C, e.g. to run the plugin tests against EDGE_URL with the cache on
 * - optional: BENCH_REQUESTS (300), BENCH_FRESHNESS_TRIALS (3), BENCH_ONLY_EDGE,
 *   BENCH_SKIP_LOAD, BENCH_SKIP_UPDATES_LOAD, BENCH_SKIP_FRESHNESS,
 *   BENCH_DEBUG (prints top statements and timed-out answers)
 *
 * The script temporarily points the vault `db_url` (used by pg_net triggers)
 * at a mailbox container that relays /functions/v1/triggers/* to API_URL, and
 * restores it on exit.
 */
import { SQL } from 'bun'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:18798'
const EDGE_URL = process.env.EDGE_URL ?? 'http://127.0.0.1:18788'
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:18787'
const DB_URL = process.env.DB_URL
// Unique per run: re-seeding an existing app queues on_app_delete, which later
// deletes the rows of the new seed.
const APP_ID = process.env.BENCH_APP_ID ?? `com.bench.edgecache.r${Date.now()}`
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 300)
const FRESHNESS_TRIALS = Number(process.env.BENCH_FRESHNESS_TRIALS ?? 3)
const RELAY_PORT = Number(process.env.BENCH_RELAY_PORT ?? 18785)
const SUPABASE_API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:54321'
const POLL_MS = 25
const FRESHNESS_TIMEOUT_MS = 120_000
/** Just under the edge cache's 60s negative TTL. */
const NEGATIVE_TTL_EXPIRY_MS = 55_000

if (!DB_URL)
  throw new Error('DB_URL is required')

const sql = new SQL(DB_URL)
const allTargets = [
  { name: 'flag off (current path)', url: BASE_URL },
  { name: 'flag on (edge cache)', url: EDGE_URL },
] as const
const targets = process.env.BENCH_ONLY_EDGE ? allTargets.slice(1) : allTargets

let deviceCounter = 0
function newDeviceId() {
  deviceCounter++
  return `00000000-0000-4000-8000-${String(Date.now() % 1e6).padStart(6, '0')}${String(deviceCounter).padStart(6, '0')}`
}

function updateBody(deviceId: string, versionName: string, extra: Record<string, unknown> = {}) {
  return {
    platform: 'android',
    device_id: deviceId,
    app_id: APP_ID,
    custom_id: '',
    version_build: '1.0.0',
    version_code: '1',
    version_os: '13',
    version_name: versionName,
    plugin_version: '7.40.0',
    is_emulator: false,
    is_prod: true,
    ...extra,
  }
}

const REQUEST_TIMEOUT_MS = 15_000

async function postJson(url: string, body: unknown, method = 'POST') {
  // A hung worker must not stall the benchmark past its own deadlines.
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { response, json: await response.json() as Record<string, any> }
}

interface PluginRequest {
  path: '/updates' | '/stats' | '/channel_self'
  method?: 'POST' | 'PUT'
  body: Record<string, unknown>
}

function statsRequest(deviceId: string, versionName: string, action: string, extra: Record<string, unknown> = {}): PluginRequest {
  return { path: '/stats', body: { ...updateBody(deviceId, versionName), action, ...extra } }
}

async function versionIdOf(name: string) {
  const [row] = await sql`SELECT id FROM public.app_versions WHERE app_id = ${APP_ID} AND name = ${name}`
  return row.id as number
}

/** Production on 1.0.1, no overrides; waits for purges and async counters to settle. */
async function resetState() {
  await sql`DELETE FROM public.channel_devices WHERE app_id = ${APP_ID}`
  await setChannelVersion('production', '1.0.1')
  await sql`SELECT public.process_channel_device_counts_queue(1000)`
  await Bun.sleep(3000)
}

async function setChannelVersion(channel: string, versionName: string) {
  const id = await versionIdOf(versionName)
  await sql`UPDATE public.channels SET version = ${id} WHERE app_id = ${APP_ID} AND name = ${channel}`
}

// Statements the update path sends (drizzle quotes identifiers; the replica
// lag probe reads pg_stat_subscription). Cron/background SQL and PostgREST
// traffic from local trigger functions are excluded.
async function updatePathStatementCount() {
  const [row] = await sql.unsafe(`
    SELECT COALESCE(SUM(calls), 0)::bigint AS calls
    FROM extensions.pg_stat_statements
    WHERE (query ~ '"(apps|channels|channel_devices|manifest|app_versions|orgs|stripe_info)"' AND query NOT LIKE '%pgrst_source%' AND query NOT ILIKE '%pg_stat_statements%')
       OR query ILIKE '%pg_stat_subscription%'`)
  return Number(row.calls)
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

interface LoadResult {
  target: string
  scenario: string
  requests: number
  dbStatementsPerRequest: number
  cacheHitRatio: number | null
  p50Ms: number
  p95Ms: number
  meanMs: number
}

function runLoad(target: typeof allTargets[number], scenario: string, versionName: string, expect: (json: Record<string, any>) => boolean): Promise<LoadResult> {
  return runRequestLoad(target, scenario, deviceId => ({ path: '/updates', body: updateBody(deviceId, versionName) }), expect)
}

async function runRequestLoad(target: typeof allTargets[number], scenario: string, makeRequest: (deviceId: string) => PluginRequest, expect: (json: Record<string, any>) => boolean): Promise<LoadResult> {
  const send = (request: PluginRequest) => postJson(`${target.url}${request.path}`, request.body, request.method)
  // Warm-up request so both targets start from the same cache state.
  await send(makeRequest(newDeviceId()))
  await Bun.sleep(300)
  await sql.unsafe('SELECT extensions.pg_stat_statements_reset()')
  const before = await updatePathStatementCount()
  const latencies: number[] = []
  let hits = 0
  let cacheHeaderSeen = false
  for (let i = 0; i < REQUESTS; i++) {
    const request = makeRequest(newDeviceId())
    const start = performance.now()
    const { response, json } = await send(request)
    latencies.push(performance.now() - start)
    if (!expect(json))
      throw new Error(`${target.name} ${scenario}: unexpected answer ${JSON.stringify(json).slice(0, 200)}`)
    const cacheHeader = response.headers.get('X-Updates-Cache')
    if (cacheHeader) {
      cacheHeaderSeen = true
      if (cacheHeader === 'hit')
        hits++
    }
  }
  await Bun.sleep(500) // let waitUntil work (cache puts, lag probe) land
  const statements = await updatePathStatementCount() - before
  if (process.env.BENCH_DEBUG) {
    const top = await sql.unsafe(`SELECT calls, left(regexp_replace(query, '\\s+', ' ', 'g'), 120) AS q FROM extensions.pg_stat_statements
      WHERE (query ~ '"(apps|channels|channel_devices|manifest|app_versions|orgs|stripe_info)"' AND query NOT LIKE '%pgrst_source%' AND query NOT ILIKE '%pg_stat_statements%') OR query ILIKE '%pg_stat_subscription%' ORDER BY calls DESC LIMIT 5`)
    console.error(target.name, scenario, top.map((row: { calls: number, q: string }) => `${row.calls}x ${row.q}`))
  }
  return {
    target: target.name,
    scenario,
    requests: REQUESTS,
    dbStatementsPerRequest: round(statements / REQUESTS, 3),
    cacheHitRatio: cacheHeaderSeen ? round(hits / REQUESTS, 3) : null,
    p50Ms: round(percentile(latencies, 50)),
    p95Ms: round(percentile(latencies, 95)),
    meanMs: round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  }
}

async function waitUntilServed(target: typeof allTargets[number], body: () => Record<string, unknown>, expect: (json: Record<string, any>) => boolean) {
  const start = performance.now()
  let polls = 0
  let last: Record<string, any> = {}
  while (performance.now() - start < FRESHNESS_TIMEOUT_MS) {
    polls++
    const { json } = await postJson(`${target.url}/updates`, body())
    last = json
    if (expect(json))
      return { ms: performance.now() - start, polls }
    await Bun.sleep(POLL_MS)
  }
  // A timed-out trial is a failed measurement, not a data point.
  throw new Error(`${target.name}: change not served within ${FRESHNESS_TIMEOUT_MS} ms (${polls} polls), last answer ${JSON.stringify(last).slice(0, 300)}`)
}

interface FreshnessResult {
  target: string
  scenario: string
  trialsMs: number[]
}

/** Console/API switches the channel to another bundle while devices are up to date and cached. */
async function freshnessChannelSwitch(target: typeof allTargets[number]): Promise<FreshnessResult> {
  const trialsMs: number[] = []
  for (let trial = 0; trial < FRESHNESS_TRIALS; trial++) {
    await setChannelVersion('production', '1.0.1')
    // Converge: the target must serve the current state before the change.
    await waitUntilServed(target, () => updateBody(newDeviceId(), '1.0.0'), json => json.version === '1.0.1')
    const deviceId = newDeviceId()
    await waitUntilServed(target, () => updateBody(deviceId, '1.0.1'), json => json.error === 'no_new_version_available')
    // A few more hits so every cache layer holds the "up to date" answer.
    for (let i = 0; i < 3; i++)
      await postJson(`${target.url}/updates`, updateBody(deviceId, '1.0.1'))

    await setChannelVersion('production', '1.0.0') // commit = t0
    const result = await waitUntilServed(target, () => updateBody(deviceId, '1.0.1'), json => json.version === '1.0.0')
    trialsMs.push(round(result.ms, 0))
  }
  await setChannelVersion('production', '1.0.1')
  return { target: target.name, scenario: 'console: channel switched to another bundle', trialsMs }
}

/** Console adds the app's first device override (apps.channel_device_count 0 -> 1). */
async function freshnessFirstOverride(target: typeof allTargets[number]): Promise<FreshnessResult> {
  const trialsMs: number[] = []
  const [beta] = await sql`SELECT id, owner_org FROM public.channels WHERE app_id = ${APP_ID} AND name = 'beta'`
  for (let trial = 0; trial < FRESHNESS_TRIALS; trial++) {
    await sql`DELETE FROM public.channel_devices WHERE app_id = ${APP_ID}`
    await sql`SELECT public.process_channel_device_counts_queue(1000)`
    await Bun.sleep(3000)
    const deviceId = newDeviceId()
    await waitUntilServed(target, () => updateBody(deviceId, '1.0.1'), json => json.error === 'no_new_version_available')
    for (let i = 0; i < 3; i++)
      await postJson(`${target.url}/updates`, updateBody(deviceId, '1.0.1'))

    await sql`INSERT INTO public.channel_devices (device_id, channel_id, app_id, owner_org) VALUES (${deviceId}, ${beta.id}, ${APP_ID}, ${beta.owner_org})`
    const result = await waitUntilServed(target, () => updateBody(deviceId, '1.0.1'), json => json.version === '1.361.0')
    trialsMs.push(round(result.ms, 0))
  }
  await sql`DELETE FROM public.channel_devices WHERE app_id = ${APP_ID}`
  return { target: target.name, scenario: 'console: first device override on the app', trialsMs }
}

/** Device switches channel with channel_self (plugin >= 7.34 stores it locally and sends defaultChannel). */
async function freshnessChannelSelf(target: typeof allTargets[number], pluginVersion: string, scenario: string): Promise<FreshnessResult> {
  const trialsMs: number[] = []
  for (let trial = 0; trial < FRESHNESS_TRIALS; trial++) {
    const deviceId = newDeviceId()
    const base = { ...updateBody(deviceId, '1.0.1'), plugin_version: pluginVersion }
    await waitUntilServed(target, () => base, json => json.error === 'no_new_version_available')
    const start = performance.now()
    const { json } = await postJson(`${target.url}/channel_self`, { ...base, channel: 'beta' })
    if (json.status !== 'ok' && json.error)
      throw new Error(`${target.name} channel_self failed: ${JSON.stringify(json)}`)
    const localChannel = pluginVersion >= '7.34.0' ? { defaultChannel: 'beta' } : {}
    await waitUntilServed(target, () => ({ ...base, ...localChannel }), answer => answer.version === '1.361.0')
    trialsMs.push(round(performance.now() - start, 0))
  }
  return { target: target.name, scenario, trialsMs }
}

/** Console allows device self-assignment on a channel that refused it (channel_self POST, cached channel lookup). */
async function freshnessSelfAssignAllowed(target: typeof allTargets[number]): Promise<FreshnessResult> {
  const trialsMs: number[] = []
  const setAllowed = (allowed: boolean) => sql`UPDATE public.channels SET allow_device_self_set = ${allowed} WHERE app_id = ${APP_ID} AND name = 'beta'`
  const post = () => postJson(`${target.url}/channel_self`, { ...updateBody(newDeviceId(), '1.0.1'), channel: 'beta' })
  for (let trial = 0; trial < FRESHNESS_TRIALS; trial++) {
    await setAllowed(false)
    const start0 = performance.now()
    while ((await post()).json.error !== 'channel_self_set_not_allowed') {
      if (performance.now() - start0 > FRESHNESS_TIMEOUT_MS)
        throw new Error(`${target.name}: refusal not served`)
      await Bun.sleep(POLL_MS)
    }
    for (let i = 0; i < 3; i++)
      await post()

    await setAllowed(true) // commit = t0
    const start = performance.now()
    let last: Record<string, any> = {}
    while (performance.now() - start < FRESHNESS_TIMEOUT_MS) {
      last = (await post()).json
      if (last.status === 'ok')
        break
      await Bun.sleep(POLL_MS)
    }
    if (last.status !== 'ok')
      throw new Error(`${target.name}: self-assign not allowed within ${FRESHNESS_TIMEOUT_MS} ms, last answer ${JSON.stringify(last).slice(0, 300)}`)
    trialsMs.push(round(performance.now() - start, 0))
  }
  await setAllowed(true)
  return { target: target.name, scenario: 'console: channel allows device self-assign (channel_self POST)', trialsMs }
}

/**
 * A device reports a bundle before it exists (cached as unknown), then the
 * bundle is uploaded: time until /stats reads the bundle again. The worker
 * writes version usage to Analytics Engine locally, so the signal is the
 * read itself: the live path reads on every request (first request after the
 * commit), the cached path once the versions-tag purge evicted the unknown
 * answer (first `X-Updates-Cache: miss`).
 */
async function freshnessBundleUploaded(target: typeof allTargets[number]): Promise<FreshnessResult> {
  const trialsMs: number[] = []
  for (let trial = 0; trial < FRESHNESS_TRIALS; trial++) {
    const versionName = `1.0.${900 + trial}-r${Date.now() % 1_000_000}`
    // Same device every time: only the bundle lookup can miss once warm.
    const deviceId = newDeviceId()
    const report = () => postJson(`${target.url}/stats`, statsRequest(deviceId, versionName, 'app_moved_to_foreground').body)
    // The first report caches "unknown bundle" for the 60s negative TTL.
    const unknownCachedAt = performance.now()
    for (let i = 0; i < 4; i++)
      await report()
    const [org] = await sql`SELECT owner_org FROM public.apps WHERE app_id = ${APP_ID}`
    await sql`INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider) VALUES (${APP_ID}, ${versionName}, ${org.owner_org}, 'r2-direct')` // commit = t0
    const start = performance.now()
    let reread = false
    while (!reread && performance.now() - start < FRESHNESS_TIMEOUT_MS) {
      const cacheHeader = (await report()).response.headers.get('X-Updates-Cache')
      reread = cacheHeader === null || cacheHeader === 'miss'
      if (!reread)
        await Bun.sleep(POLL_MS)
    }
    if (!reread)
      throw new Error(`${target.name}: uploaded bundle not re-read by /stats within ${FRESHNESS_TIMEOUT_MS} ms`)
    // A re-read near the negative TTL is the entry expiring, not the purge.
    if (performance.now() - unknownCachedAt >= NEGATIVE_TTL_EXPIRY_MS)
      throw new Error(`${target.name}: /stats re-read the bundle only after the negative TTL expired; the versions purge did not land`)
    trialsMs.push(round(performance.now() - start, 0))
  }
  return { target: target.name, scenario: 'console: bundle uploaded after devices reported it (/stats re-reads it)', trialsMs }
}

// pg_net runs inside the Supabase Postgres container, which usually cannot
// open connections to the host. A mailbox container on the Supabase network
// receives the trigger POSTs; this process long-polls it (host -> container)
// and forwards /functions/v1/triggers/* to API_URL.
const MAILBOX_CODE = `
const queue = []; let waiters = []
Bun.serve({ port: 18785, hostname: '0.0.0.0', async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === '/__next') {
    if (queue.length) return Response.json(queue.splice(0))
    return new Promise((resolve) => {
      const waiter = (items) => { clearTimeout(timer); resolve(Response.json(items)) }
      const timer = setTimeout(() => { waiters = waiters.filter(w => w !== waiter); resolve(Response.json([])) }, 20000)
      waiters.push(waiter)
    })
  }
  const item = { path: url.pathname, headers: Object.fromEntries(request.headers), body: await request.text() }
  const waiter = waiters.shift()
  if (waiter) waiter([item]); else queue.push(item)
  return Response.json({ status: 'queued' })
} })`

async function withTriggerRelay<T>(run: () => Promise<T>): Promise<T> {
  const network = process.env.BENCH_DOCKER_NETWORK
  const image = process.env.BENCH_MAILBOX_IMAGE ?? 'oven/bun:1.3.12'
  if (!network)
    throw new Error('BENCH_DOCKER_NETWORK is required (docker network of the local Supabase stack)')
  const name = 'capgo-bench-trigger-mailbox'
  // Look everything up before changing anything that needs restoring.
  const [secret] = await sql`SELECT id, decrypted_secret FROM vault.decrypted_secrets WHERE name = 'db_url'`
  if (!secret)
    throw new Error('vault secret db_url is missing; seed the local database first')
  const [fn] = await sql`SELECT 1 FROM pg_proc WHERE proname = 'updates_cache_purge_enabled'`
  if (!fn)
    throw new Error('updates_cache_purge_enabled() is missing; apply the edge cache migration first')
  // Runtime switch is the CAPGO_UPDATES_CACHE_PURGE_ENABLED Vault secret.
  const [switchSecret] = await sql`SELECT id, decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CAPGO_UPDATES_CACHE_PURGE_ENABLED'`

  let running = true
  let pump: Promise<void> = Promise.resolve()
  let restored = false
  // Restores Vault and removes the container whatever happened (errors,
  // Ctrl+C), so local triggers keep reaching the Supabase functions.
  const restore = async () => {
    if (restored)
      return
    restored = true
    running = false
    await sql`SELECT vault.update_secret(${secret.id}, ${secret.decrypted_secret})`.catch(() => null)
    if (switchSecret)
      await sql`SELECT vault.update_secret(${switchSecret.id}, ${switchSecret.decrypted_secret})`.catch(() => null)
    else
      await sql`DELETE FROM vault.secrets WHERE name = 'CAPGO_UPDATES_CACHE_PURGE_ENABLED'`.catch(() => null)
    Bun.spawnSync(['docker', 'rm', '-f', name])
  }
  const onSignal = () => {
    void restore().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    Bun.spawnSync(['docker', 'rm', '-f', name])
    const started = Bun.spawnSync(['docker', 'run', '-d', '--rm', '--name', name, '--network', network, '-p', `${RELAY_PORT}:18785`, image, 'bun', '-e', MAILBOX_CODE])
    if (started.exitCode !== 0)
      throw new Error(`mailbox container failed: ${started.stderr.toString()}`)
    let ready = false
    for (let i = 0; i < 50 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`, { method: 'POST' }).then(r => r.ok).catch(() => false)
      if (!ready)
        await Bun.sleep(200)
    }
    if (!ready)
      throw new Error(`mailbox container not reachable on port ${RELAY_PORT}; purges would never arrive`)
    await fetch(`http://127.0.0.1:${RELAY_PORT}/__next`).catch(() => null) // drain health probes

    pump = (async () => {
      while (running) {
        const items = await fetch(`http://127.0.0.1:${RELAY_PORT}/__next`).then(r => r.json() as Promise<{ path: string, headers: Record<string, string>, body: string }[]>).catch(() => [])
        // Purges go to the branch API worker; every other trigger keeps flowing
        // to the local Supabase functions so the stack behaves normally.
        // Fire and forget: a slow unrelated trigger must not delay the next purge.
        for (const item of items) {
          const isPurge = item.path.startsWith('/functions/v1/triggers/updates_cache_purge')
          void fetch(isPurge
            ? `${API_URL}${item.path.replace('/functions/v1', '')}`
            : `${SUPABASE_API_URL}${item.path}`, { method: 'POST', headers: { 'Content-Type': item.headers['content-type'] ?? 'application/json', 'apisecret': item.headers.apisecret ?? '' }, body: item.body }).catch(() => null)
        }
      }
    })()

    await sql`SELECT vault.update_secret(${secret.id}, ${`http://${name}:18785`})`
    if (switchSecret)
      await sql`SELECT vault.update_secret(${switchSecret.id}, 'true')`
    else
      await sql`SELECT vault.create_secret('true', 'CAPGO_UPDATES_CACHE_PURGE_ENABLED', 'edge cache benchmark')`
    return await run()
  }
  finally {
    await restore()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await pump.catch(() => null)
  }
}

function median(values: number[]) {
  return percentile(values, 50)
}

async function main() {
  if (process.env.BENCH_RELAY_ONLY) {
    // Keeps the trigger relay and the purge switch up (until Ctrl+C) so other
    // suites, e.g. the plugin tests, can run against EDGE_URL with purges.
    console.log('Trigger relay up, purges reach API_URL. Ctrl+C restores Vault.')
    await withTriggerRelay(() => new Promise<never>(() => {}))
    return
  }
  await sql`SELECT public.reset_and_seed_app_data(${APP_ID})`
  const load: LoadResult[] = []
  const freshness: FreshnessResult[] = []
  await withTriggerRelay(async () => {
    const ok = (json: Record<string, any>) => json.status === 'ok'
    for (const target of process.env.BENCH_SKIP_LOAD ? [] : targets) {
      await resetState()
      load.push(await runRequestLoad(target, '/stats: app_moved_to_foreground', deviceId => statsRequest(deviceId, '1.0.1', 'app_moved_to_foreground'), ok))
      load.push(await runRequestLoad(target, '/stats: set (install, previous bundle known)', deviceId => statsRequest(deviceId, '1.0.1', 'set', { old_version_name: '1.0.0' }), ok))
      load.push(await runRequestLoad(target, '/stats: unknown bundle', deviceId => statsRequest(deviceId, '9.9.9-unknown', 'app_moved_to_foreground'), ok))
      load.push(await runRequestLoad(target, '/channel_self PUT (get channel)', deviceId => ({ path: '/channel_self', method: 'PUT', body: updateBody(deviceId, '1.0.1') }), json => json.status === 'default'))
      load.push(await runRequestLoad(target, '/channel_self POST (set channel)', deviceId => ({ path: '/channel_self', body: { ...updateBody(deviceId, '1.0.1'), channel: 'beta' } }), ok))
      if (process.env.BENCH_SKIP_UPDATES_LOAD)
        continue
      load.push(await runLoad(target, 'device up to date', '1.0.1', json => json.error === 'no_new_version_available'))
      load.push(await runLoad(target, 'device gets new bundle', '1.0.0', json => json.version === '1.0.1'))
      const [beta] = await sql`SELECT id, owner_org FROM public.channels WHERE app_id = ${APP_ID} AND name = 'beta'`
      await sql`INSERT INTO public.channel_devices (device_id, channel_id, app_id, owner_org) VALUES (${'bench-override-device'}, ${beta.id}, ${APP_ID}, ${beta.owner_org})`
      await sql`SELECT public.process_channel_device_counts_queue(1000)`
      // Let the 60s caches of the current path expire so both targets are
      // measured in their steady state for an app that has overrides.
      await Bun.sleep(65_000)
      load.push(await runLoad(target, 'app with device overrides, up to date', '1.0.1', json => json.error === 'no_new_version_available'))
    }
    for (const target of process.env.BENCH_SKIP_FRESHNESS ? [] : targets) {
      await resetState()
      freshness.push(await freshnessSelfAssignAllowed(target))
      await resetState()
      freshness.push(await freshnessBundleUploaded(target))
      await resetState()
      freshness.push(await freshnessChannelSwitch(target))
      await resetState()
      freshness.push(await freshnessFirstOverride(target))
      await resetState()
      freshness.push(await freshnessChannelSelf(target, '7.40.0', 'channel_self (plugin >= 7.34, local channel)'))
      await resetState()
      freshness.push(await freshnessChannelSelf(target, '7.20.0', 'channel_self (legacy plugin, server override)'))
    }
  })

  const lines = [
    '### Load (sequential, unique devices)',
    '',
    '| Scenario | Target | DB statements / request | Cache hit ratio | p50 ms | p95 ms | mean ms |',
    '|---|---|---|---|---|---|---|',
    ...load.map(r => `| ${r.scenario} | ${r.target} | ${r.dbStatementsPerRequest} | ${r.cacheHitRatio ?? 'n/a'} | ${r.p50Ms} | ${r.p95Ms} | ${r.meanMs} |`),
    '',
    '### Time until the device receives the change (ms, per trial)',
    '',
    '| Scenario | Target | Trials | Median |',
    '|---|---|---|---|',
    ...freshness.map(r => `| ${r.scenario} | ${r.target} | ${r.trialsMs.join(', ')} | ${round(median(r.trialsMs), 0)} |`),
  ]
  console.log(lines.join('\n'))
  console.log('\nRAW', JSON.stringify({ load, freshness }))
  await sql.close()
}

await main()

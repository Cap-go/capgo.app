import { strictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { updatesAppCacheTag, updatesVersionsCacheTag } from '../supabase/functions/_backend/plugin_runtime/utils/updatesCacheTag.ts'
import {
  API_SECRET,
  CLOUDFLARE_API_URL,
  CLOUDFLARE_PLUGIN_URL,
  createAppVersions,
  executeSQL,
  insertManifestRows,
  makeBaseData,
  POSTGRES_URL,
  resetAndSeedAppData,
  resetAppData,
  resetAppDataStats,
} from '../tests/test-utils.ts'

type Mode = 'db' | 'kv'
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface PluginStateProbe {
  name: string
  path: string
  method: Method
  body: object
}

export interface PluginStateProbeResult {
  status: number
  state: string | undefined
  body: unknown
  milliseconds: number
  startedAt: number
  finishedAt: number
}

function assertLocal(url: string) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Plugin state benchmarks may only use local test services')
}

/** Independent of the test suite fetch wrapper: no implicit sync before a request. */
function localRequest(base: string, path: string, method: Method, body: object, extraHeaders: Record<string, string> = {}): Promise<PluginStateProbeResult> {
  assertLocal(base)
  const url = new URL(path, base)
  const withBody = method === 'POST' || method === 'PUT'
  if (!withBody) {
    for (const [key, value] of Object.entries(body))
      url.searchParams.set(key, String(value))
  }
  const encoded = withBody ? JSON.stringify(body) : undefined
  const started = performance.now()
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('error', reject)
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          const state = response.headers['x-plugin-state']
          resolve({
            status: response.statusCode ?? 0,
            state: Array.isArray(state) ? state[0] : state,
            body: raw ? JSON.parse(raw) : null,
            milliseconds: performance.now() - started,
            startedAt,
            finishedAt: Date.now(),
          })
        }
        catch (error) {
          reject(error)
        }
      })
    })
    req.setTimeout(30_000, () => req.destroy(new Error('Local plugin probe timed out')))
    req.on('error', reject)
    req.end(encoded)
  })
}

export function probePluginState(probe: PluginStateProbe, mode: Mode) {
  return localRequest(CLOUDFLARE_PLUGIN_URL, probe.path, probe.method, probe.body, { 'x-capgo-plugin-state': mode })
}

const timedErrorBody = z.object({
  moreInfo: z.object({
    rateLimitResetAt: z.number().int().finite(),
    retryAfterSeconds: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough()

function comparableBody(response: PluginStateProbeResult) {
  const timedError = timedErrorBody.safeParse(response.body)
  if (!timedError.success)
    return response.body
  const { rateLimitResetAt, retryAfterSeconds, ...moreInfo } = timedError.data.moreInfo
  // The absolute retry timestamp is computed for each request. Verify its
  // semantics against that request's observed interval before comparing every
  // other field. Ceil-to-seconds can move the implied timestamp back <1s.
  const impliedRequestTime = rateLimitResetAt - retryAfterSeconds * 1000
  strictEqual(impliedRequestTime >= response.startedAt - 1000 && impliedRequestTime <= response.finishedAt,
    true, 'rateLimitResetAt must match this request and retryAfterSeconds')
  return { ...timedError.data, moreInfo: { ...moreInfo, retryAfterSeconds } }
}

function shortBody(body: unknown) {
  const json = JSON.stringify(body)
  return json.length > 800 ? `${json.slice(0, 800)}... (${json.length} characters)` : json
}

/** Force each side explicitly and fail if the new path silently falls back. */
export async function comparePluginState(probe: PluginStateProbe, kvFirst = false, beforeProbe?: () => Promise<void>) {
  await beforeProbe?.()
  const first = await probePluginState(probe, kvFirst ? 'kv' : 'db')
  // Same-device, same-channel SET is intentionally limited to once/second.
  // Wait between equivalent mutations; each HTTP timing excludes this pause.
  if (probe.path === '/channel_self' && probe.method === 'POST')
    await setTimeout(1100)
  await beforeProbe?.()
  const second = await probePluginState(probe, kvFirst ? 'db' : 'kv')
  const db = kvFirst ? second : first
  const kv = kvFirst ? first : second
  strictEqual(db.state === 'kv' || db.state === 'kv-escaped', false, `${probe.name}: DB request selected KV`)
  strictEqual(kv.state, 'kv', `${probe.name}: KV was not authoritative (${kv.state ?? 'none'}), status ${kv.status}, body ${shortBody(kv.body)}`)
  strictEqual(kv.status, db.status, `${probe.name}: status parity`)
  strictEqual(timedErrorBody.safeParse(kv.body).success, timedErrorBody.safeParse(db.body).success,
    `${probe.name}: retry timestamp fields must be present on both responses`)
  if (!isDeepStrictEqual(comparableBody(kv), comparableBody(db)))
    throw new Error(`${probe.name}: JSON parity failed. DB ${shortBody(db.body)}; KV ${shortBody(kv.body)}`)
  return { db, kv }
}

const syncResult = z.object({ claims: z.number(), failed: z.number() })

export async function syncPluginState(appIds: string[] = []) {
  for (let round = 0; round < 100; round++) {
    const response = await localRequest(CLOUDFLARE_API_URL, '/triggers/plugin_state_sync', 'POST', {
      drain: true,
      ...(round === 0 && appIds.length > 0 ? { apps: appIds } : {}),
    }, { apisecret: API_SECRET })
    strictEqual(response.status, 200, 'State sync HTTP status')
    const result = syncResult.parse(response.body)
    strictEqual(result.failed, 0, 'State sync failures')
    if (result.claims === 0) {
      // A rate-limited or leased item can be pending without being due yet.
      // Do not mistake a zero-claim drain for a completed synchronization.
      const [pending] = await executeSQL<{ count: string }>('SELECT count(*)::text AS count FROM public.plugin_state_sync_pending')
      if (Number(pending?.count ?? 0) === 0)
        return
    }
    // KV permits at most one write per key per second.
    await setTimeout(1100)
  }
  throw new Error('State sync failed to settle within 100 drains')
}

export async function evictPluginStateCache(appId: string) {
  const response = await localRequest(CLOUDFLARE_PLUGIN_URL, '/cache_purge_local', 'POST', {
    tags: [updatesAppCacheTag(appId), updatesVersionsCacheTag(appId)],
  }, { apisecret: API_SECRET })
  strictEqual(response.status, 200, 'Local tag purge HTTP status')
}

export async function createPluginStateFixture() {
  assertLocal(CLOUDFLARE_API_URL)
  assertLocal(CLOUDFLARE_PLUGIN_URL)
  assertLocal(POSTGRES_URL)
  const suffix = randomUUID()
  const appId = `com.example.plugin-state.${suffix}`
  const orgId = randomUUID()
  const stripeCustomerId = `cus_plugin_state_${suffix.replaceAll('-', '')}`
  await resetAndSeedAppData(appId, { orgId, stripeCustomerId })
  const stable = await createAppVersions('1.1.0', appId, {
    external_url: 'https://example.com/plugin-state/stable.zip',
    checksum: 'stable-checksum',
  })
  const next = await createAppVersions('1.2.0', appId, {
    external_url: 'https://example.com/plugin-state/next.zip',
    checksum: 'next-checksum',
  })
  await executeSQL('UPDATE public.channels SET public = false WHERE app_id = $1', [appId])
  await executeSQL(`UPDATE public.channels SET ios = true, android = true,
    allow_device_self_set = true, disable_auto_update = 'none', disable_auto_update_under_native = false,
    version = CASE WHEN name = 'production' THEN $2::bigint ELSE $3::bigint END
    WHERE app_id = $1`, [appId, stable.id, next.id])
  await executeSQL("UPDATE public.channels SET public = true WHERE app_id = $1 AND name = 'production'", [appId])
  await insertManifestRows([
    { app_version_id: stable.id, file_name: 'index.html', file_hash: 'a'.repeat(64), s3_path: 'plugin-state/index.html', file_size: 128 },
    { app_version_id: stable.id, file_name: 'main.js', file_hash: 'b'.repeat(64), s3_path: 'plugin-state/main.js', file_size: 256 },
  ])
  const base = { ...makeBaseData(appId), device_id: randomUUID(), plugin_version: '7.0.0' }
  const updateProbe = (versionName = '1.0.0'): PluginStateProbe => ({
    name: versionName === stable.name ? 'Existing bundle, up to date' : 'New bundle available',
    path: '/updates',
    method: 'POST',
    body: { ...base, version_name: versionName },
  })
  const manifestProbe: PluginStateProbe = {
    name: 'Manifest sizes',
    path: '/updates/manifest_size',
    method: 'POST',
    body: {
      ...base,
      version: stable.name,
      files: [
        { file_name: 'index.html', file_hash: 'a'.repeat(64), download_url: `https://example.com/files?key=${stable.id}` },
        { file_name: 'main.js', file_hash: 'b'.repeat(64), download_url: `https://example.com/files?key=${stable.id}` },
      ],
    },
  }
  return {
    appId,
    base,
    stable,
    next,
    updateProbe,
    manifestProbe,
    readProbes: [
      updateProbe(stable.name),
      updateProbe(),
      { name: 'Channel list', path: '/channel_self', method: 'GET', body: base },
      { name: 'Current channel', path: '/channel_self', method: 'PUT', body: base },
      { name: 'Stats', path: '/stats', method: 'POST', body: { ...base, version_name: stable.name, action: 'set' } },
      { name: 'Stats batch', path: '/stats', method: 'POST', body: [{ ...base, version_name: stable.name, action: 'get' }, { ...base, version_name: stable.name, action: 'set' }] },
      manifestProbe,
    ] satisfies PluginStateProbe[],
    async cleanup() {
      await resetAppData(appId)
      await resetAppDataStats(appId)
      await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
      await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [stripeCustomerId])
    },
  }
}

export type PluginStateFixture = Awaited<ReturnType<typeof createPluginStateFixture>>

const bodyWithDevice = z.object({ device_id: z.string() }).passthrough()

/** New device per benchmark pair avoids operation limits without changing app cache keys. */
function freshDeviceProbe(probe: PluginStateProbe): PluginStateProbe {
  const body = bodyWithDevice.safeParse(probe.body)
  if (body.success)
    return { ...probe, body: { ...body.data, device_id: randomUUID() } }
  const batch = z.array(bodyWithDevice).parse(probe.body)
  return { ...probe, body: batch.map(entry => ({ ...entry, device_id: randomUUID() })) }
}

/** Commit-to-visible comparison; reads run while the independently invoked writer is still in flight. */
export async function measurePluginStatePropagation(fixture: PluginStateFixture, target: { id: number, name: string }, timeoutMs = 15_000) {
  const probe = fixture.updateProbe()
  // Cache the old answer before the mutation, to exercise invalidation.
  await comparePluginState(probe)
  await executeSQL('UPDATE public.channels SET version = $2::bigint WHERE app_id = $1 AND name = $3', [fixture.appId, target.id, 'production'])
  const committed = performance.now()
  // Local workerd has no global purge service/cron. Request the real writer
  // with its local immediate tag purge, but do not await its response before
  // polling. The measurement includes writer execution and cache invalidation.
  const wake = localRequest(CLOUDFLARE_API_URL, '/triggers/plugin_state_sync', 'POST', { drain: true }, { apisecret: API_SECRET })
  async function visible(mode: Mode) {
    let requests = 0
    while (performance.now() - committed < timeoutMs) {
      const response = await probePluginState(probe, mode)
      if (mode === 'db')
        strictEqual(response.state === 'kv' || response.state === 'kv-escaped', false, 'Bundle propagation: DB request selected KV')
      requests++
      const body = z.object({ version: z.string().optional() }).passthrough().safeParse(response.body)
      if (response.status === 200 && body.success && body.data.version === target.name && (mode === 'db' || response.state === 'kv'))
        return { milliseconds: performance.now() - committed, requests }
      await setTimeout(25)
    }
    throw new Error(`${mode}: new channel bundle did not become visible within ${timeoutMs}ms`)
  }
  const [db, kv, wakeResult] = await Promise.all([visible('db'), visible('kv'), wake])
  strictEqual(wakeResult.status, 200, 'Asynchronous sync wake HTTP status')
  return { db, kv }
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (fraction: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0).toFixed(3))
  return { samples: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), min_ms: percentile(0), max_ms: percentile(1) }
}

/** Each mode gets its own fresh device and follows the same state transitions. */
export async function comparePluginStateChannelSequence(fixture: PluginStateFixture, pluginVersion: string, kvFirst: boolean) {
  const devices = { db: randomUUID(), kv: randomUUID() }
  const steps = [
    { label: 'SET beta', method: 'POST', status: 'ok' },
    { label: 'GET current after SET', method: 'PUT', status: 'override' },
    { label: 'DELETE override', method: 'DELETE', status: 'ok' },
    { label: 'GET current after DELETE', method: 'PUT', status: 'default' },
  ] satisfies Array<{ label: string, method: Method, status: string }>
  const measurements = []
  for (const step of steps) {
    const probeFor = (mode: Mode): PluginStateProbe => ({
      name: `Channel surfing ${pluginVersion} ${step.label}`,
      path: '/channel_self',
      method: step.method,
      // New plugins keep their selection locally and clear it after DELETE.
      // Omit it on the last read so the simulated client requests its default.
      body: { ...fixture.base, device_id: devices[mode], plugin_version: pluginVersion, channel: step.label === 'GET current after DELETE' ? undefined : 'beta' },
    })
    const first = await probePluginState(probeFor(kvFirst ? 'kv' : 'db'), kvFirst ? 'kv' : 'db')
    const second = await probePluginState(probeFor(kvFirst ? 'db' : 'kv'), kvFirst ? 'db' : 'kv')
    const db = kvFirst ? second : first
    const kv = kvFirst ? first : second
    const name = `${pluginVersion} ${step.label}`
    strictEqual(db.state === 'kv' || db.state === 'kv-escaped', false, `${name}: DB request selected KV`)
    strictEqual(db.status, 200, `${name}: DB HTTP status, body ${shortBody(db.body)}`)
    strictEqual(kv.status, db.status, `${name}: HTTP status parity`)
    strictEqual(kv.state, 'kv', `${name}: KV must serve the response, body ${shortBody(kv.body)}`)
    if (!isDeepStrictEqual(kv.body, db.body))
      throw new Error(`${name}: JSON parity failed. DB ${shortBody(db.body)}; KV ${shortBody(kv.body)}`)
    const result = z.object({ status: z.string(), channel: z.string().optional() }).parse(kv.body)
    strictEqual(result.status, step.status, `${name}: channel transition`)
    if (step.status === 'override')
      strictEqual(result.channel, 'beta', `${name}: selected channel`)
    measurements.push({ scenario: name, db_ms: db.milliseconds, kv_ms: kv.milliseconds })
  }
  return measurements
}

export async function runPluginStateBenchmark(samples = 40) {
  assertLocal(CLOUDFLARE_API_URL)
  assertLocal(CLOUDFLARE_PLUGIN_URL)
  assertLocal(POSTGRES_URL)
  const [sync] = await executeSQL<{ enabled: boolean }>('SELECT public.plugin_state_sync_enabled() AS enabled')
  if (sync?.enabled !== true)
    throw new Error('Plugin state benchmark requires CAPGO_PLUGIN_STATE_SYNC_ENABLED in local Vault. Enable sync or run the strict KV test setup documented in docs/plugin-state-kv.md before benchmarking.')
  const fixture = await createPluginStateFixture()
  try {
    await syncPluginState([fixture.appId])
    const measurements = []
    for (const probe of fixture.readProbes) {
      // Discard first requests so local worker startup is not counted as data latency.
      await comparePluginState(probe)
      const warm = { db: [] as number[], kv: [] as number[] }
      const evicted = { db: [] as number[], kv: [] as number[] }
      for (let i = 0; i < samples; i++) {
        const result = await comparePluginState(freshDeviceProbe(probe), i % 2 === 0)
        warm.db.push(result.db.milliseconds)
        warm.kv.push(result.kv.milliseconds)
      }
      for (let i = 0; i < Math.min(samples, 10); i++) {
        // Both cohorts must begin after eviction. A single purge before a
        // pair lets the first response warm shared caches for the second.
        const result = await comparePluginState(freshDeviceProbe(probe), i % 2 === 0, () => evictPluginStateCache(fixture.appId))
        evicted.db.push(result.db.milliseconds)
        evicted.kv.push(result.kv.milliseconds)
      }
      measurements.push({ scenario: probe.name, warm: { db: distribution(warm.db), kv: distribution(warm.kv) }, cache_api_evicted: { db: distribution(evicted.db), kv: distribution(evicted.kv) } })
    }
    const surfing: Array<{ scenario: string, db_ms: number, kv_ms: number }> = []
    for (const [index, pluginVersion] of ['7.0.0', '7.34.0'].entries())
      surfing.push(...await comparePluginStateChannelSequence(fixture, pluginVersion, index % 2 === 1))
    // Keep write rate below the platform's per-key limit before changing the app doc again.
    await setTimeout(1100)
    // Publish a bundle that did not exist in the initial backfill. Leave its
    // version and manifest jobs pending so propagation includes their sync.
    const published = await createAppVersions('1.3.0', fixture.appId, {
      external_url: 'https://example.com/plugin-state/published.zip',
      checksum: 'published-checksum',
    })
    await insertManifestRows([
      { app_version_id: published.id, file_name: 'index.html', file_hash: 'c'.repeat(64), s3_path: 'plugin-state/published/index.html', file_size: 192 },
      { app_version_id: published.id, file_name: 'main.js', file_hash: 'd'.repeat(64), s3_path: 'plugin-state/published/main.js', file_size: 320 },
    ])
    const propagation = await measurePluginStatePropagation(fixture, published)
    return {
      generated_at: new Date().toISOString(),
      environment: 'Local workerd; DB and KV on this machine; serial interleaved requests',
      publication: 'Immutable Workers KV values selected by conditional R2 pointers; Cache API in front',
      limitations: [
        'Local timings do not predict worldwide latency or KV replication lag.',
        'Cache API evictions do not evict the KV service cache or database buffers.',
        'Propagation is primary COMMIT to observed reply while an independently invoked writer drain and local tag purge run in flight; polling resolution is 25ms plus request time. No writer completion is awaited before polling.',
        'Channel surfing rows are single operations, not latency distributions.',
        'Channel surfing uses independent fresh devices per mode for the same SET/read/DELETE/read sequence; SET always performs its first assignment. Which mode runs first alternates by plugin generation.',
        'Every measured DB/KV pair has identical HTTP status and parsed JSON except absolute rateLimitResetAt timestamps, which are checked against each request interval and retryAfterSeconds. KV replies must carry X-Plugin-State: kv, and DB replies must not carry a KV marker.',
        'The fixture has fewer than 500 forced overrides and fitting manifests. Large override sets and manifests marked for replica fallback require separate regional cost and latency measurements.',
      ],
      measurements,
      channel_surfing: surfing,
      bundle_propagation: {
        description: 'New bundle metadata and manifest pending sync; timer starts at channel-promotion COMMIT, after upload preparation.',
        ...propagation,
      },
    }
  }
  finally {
    await fixture.cleanup()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sampleCount = z.coerce.number().int().min(5).max(1000).parse(process.env.PLUGIN_STATE_BENCH_SAMPLES ?? 40)
  const report = await runPluginStateBenchmark(sampleCount)
  const output = process.env.PLUGIN_STATE_BENCH_OUTPUT
  if (output)
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

#!/usr/bin/env bun
/**
 * Off-prod probe of what the snippet edge answers (plugin_runtime/utils/
 * snippetEdgeAnswer.ts) rely on, run on dedicated test hostnames of the
 * capgo.app zone (the only zone with Snippets + http_requests Logpush).
 * No production host, worker, snippet or Logpush job is touched.
 *
 *   snippet-edge-probe.capgo.app         probe snippet (probe-snippet.js)
 *   snippet-edge-test.capgo.app          the real snippet, worker URLs -> test origin
 *   snippet-edge-probe-origin.capgo.app  test origin worker (origin-worker.ts)
 *
 * Checks:
 *   1. subrequest limit, and whether Cache API calls count against it
 *   2. a snippet Cache API entry is purged by Cache-Tag
 *   3. snippet and worker of the zone share Cache API entries (same key)
 *   4. Logpush keeps the X-Capgo-Edge-Stat response header, by size
 *   5. real snippet end to end: learn, answer without origin, purge, IP limit
 *
 * Env: CLOUDFLARE_API_TOKEN with, on capgo.app: Snippets Edit, DNS Edit,
 * Cache Purge, Logs Edit, Zone Read (+ the account-level Workers/R2 rights
 * for wrangler, or a wrangler login). Optional CLOUDFLARE_ACCOUNT_ID.
 *
 *   bun scripts/snippet-edge-probe/run.ts setup [--dry-run]
 *   bun scripts/snippet-edge-probe/run.ts test
 *   bun scripts/snippet-edge-probe/run.ts logs       # Logpush part, 1-5 min after test
 *   bun scripts/snippet-edge-probe/run.ts teardown
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const ZONE_NAME = 'capgo.app'
const PROBE_HOST = 'snippet-edge-probe.capgo.app'
const TEST_HOST = 'snippet-edge-test.capgo.app'
const ORIGIN_HOST = 'snippet-edge-probe-origin.capgo.app'
const PROBE_SNIPPET = 'capgo_edge_probe'
const TEST_SNIPPET = 'capgo_edge_probe_real'
const LOGPUSH_JOB = 'capgo-snippet-edge-probe'
const BUCKET = 'capgo-snippet-edge-probe'
const STAT_HEADER = 'x-capgo-edge-stat'
const HEADER_SIZES = [512, 2048, 4096, 8192, 12000, 16000, 32000]
const DIR = resolve(import.meta.dir)
const ROOT = resolve(DIR, '../..')
const STATE_PATH = join(tmpdir(), 'capgo-snippet-edge-probe.json')

interface State { secret: string, zoneId?: string, dnsIds?: string[], logpushJobId?: number }

function loadState(): State {
  if (existsSync(STATE_PATH))
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  const state = { secret: crypto.randomUUID() }
  writeFileSync(STATE_PATH, JSON.stringify(state))
  return state
}

function saveState(state: State) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function token() {
  const value = process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (!value)
    throw new Error('Missing CLOUDFLARE_API_TOKEN')
  return value
}

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  const body = await response.json() as { success: boolean, result: T, errors?: unknown }
  if (!body.success)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${JSON.stringify(body.errors)}`)
  return body.result
}

function wrangler(args: string[], input?: string) {
  console.log(`$ wrangler ${args.join(' ')}`)
  const child = spawnSync('bunx', ['wrangler', ...args], { cwd: DIR, input, encoding: 'utf8' })
  const output = `${child.stdout}${child.stderr}`
  if (child.status !== 0 && !/already exists|already been taken|10004|not found|does not exist/i.test(output))
    throw new Error(output)
  return output
}

async function zoneId(state: State) {
  if (state.zoneId)
    return state.zoneId
  const [zone] = await cf<{ id: string }[]>(`/zones?name=${ZONE_NAME}`)
  if (!zone)
    throw new Error(`Zone ${ZONE_NAME} not found`)
  state.zoneId = zone.id
  saveState(state)
  return zone.id
}

/** The real snippet, with every regional plugin worker pointed at the test origin. */
async function buildTestSnippet() {
  const source = readFileSync(resolve(ROOT, 'cloudflare_workers/snippet/index.js'), 'utf8')
    .replace(/https:\/\/plugin\.[a-z]+\.capgo\.app/g, `https://${ORIGIN_HOST}`)
  if (source.includes('plugin.eu.capgo.app'))
    throw new Error('Test snippet still targets a production worker')
  const path = join(tmpdir(), 'capgo-edge-probe-real.js')
  writeFileSync(path, source)
  const result = await Bun.build({ entrypoints: [path], minify: true, target: 'browser', format: 'esm' })
  if (!result.success)
    throw new Error(result.logs.join('\n'))
  return await result.outputs[0]!.text()
}

async function uploadSnippet(zone: string, name: string, code: string) {
  const form = new FormData()
  form.append('files', new File([code], `${name}.js`, { type: 'application/javascript+module' }))
  form.append('metadata', JSON.stringify({ main_module: `${name}.js` }))
  await cf(`/zones/${zone}/snippets/${name}`, { method: 'PUT', body: form })
  console.log(`Uploaded snippet ${name} (${code.length} bytes)`)
}

interface SnippetRule { description?: string, enabled: boolean, expression: string, snippet_name: string }

/**
 * PUT snippet_rules replaces every rule of the zone: always resend the
 * existing (production) rules untouched, and check they survived.
 */
async function setProbeRules(zone: string, add: boolean, dryRun = false) {
  const existing = await cf<SnippetRule[] | null>(`/zones/${zone}/snippets/snippet_rules`) ?? []
  const others = existing.filter(rule => rule.snippet_name !== PROBE_SNIPPET && rule.snippet_name !== TEST_SNIPPET)
    .map(({ description, enabled, expression, snippet_name }) => ({ description, enabled, expression, snippet_name }))
  const ours: SnippetRule[] = add
    ? [
        { description: 'capgo edge probe (test host only)', enabled: true, expression: `(http.host eq "${PROBE_HOST}")`, snippet_name: PROBE_SNIPPET },
        { description: 'capgo edge probe real snippet (test host only)', enabled: true, expression: `(http.host eq "${TEST_HOST}")`, snippet_name: TEST_SNIPPET },
      ]
    : []
  console.log(`Snippet rules kept as is: ${others.map(rule => `${rule.snippet_name} [${rule.expression}]`).join(', ') || 'none'}`)
  if (dryRun) {
    console.log(`Would set ${ours.length} probe rule(s)`)
    return
  }
  if (others.length === 0 && existing.length === 0 && !add)
    return
  if (others.length === 0 && ours.length === 0) {
    await cf(`/zones/${zone}/snippets/snippet_rules`, { method: 'DELETE' })
    return
  }
  await cf(`/zones/${zone}/snippets/snippet_rules`, { method: 'PUT', body: JSON.stringify({ rules: [...others, ...ours] }) })
  const after = await cf<SnippetRule[]>(`/zones/${zone}/snippets/snippet_rules`) ?? []
  for (const rule of others) {
    if (!after.some(next => next.snippet_name === rule.snippet_name && next.expression === rule.expression && next.enabled === rule.enabled))
      throw new Error(`Snippet rule ${rule.snippet_name} changed: restore it now! ${JSON.stringify(rule)}`)
  }
}

async function ensureDns(zone: string, state: State) {
  state.dnsIds ??= []
  for (const name of [PROBE_HOST, TEST_HOST]) {
    const found = await cf<{ id: string }[]>(`/zones/${zone}/dns_records?name=${name}`)
    if (found.length > 0)
      continue
    // Proxied, originless: the snippet answers or calls the test origin itself.
    const record = await cf<{ id: string }>(`/zones/${zone}/dns_records`, { method: 'POST', body: JSON.stringify({ type: 'AAAA', name, content: '100::', proxied: true, comment: 'capgo snippet edge probe' }) })
    state.dnsIds.push(record.id)
    console.log(`DNS ${name} created`)
  }
  saveState(state)
}

async function ensureCustomField(zone: string) {
  const path = `/zones/${zone}/rulesets/phases/http_log_custom_fields/entrypoint`
  let rules: any[] = []
  try {
    rules = (await cf<{ rules?: any[] }>(path)).rules ?? []
  }
  catch {}
  const rule = rules.find(item => item.action === 'log_custom_field' && item.expression === 'true')
  const fields: { name: string }[] = rule?.action_parameters?.response_fields ?? []
  if (fields.some(field => field.name.toLowerCase() === STAT_HEADER))
    return
  const next = rule
    ? rules.map(item => item === rule ? { ...item, action_parameters: { ...item.action_parameters, response_fields: [...fields, { name: STAT_HEADER }] } } : item)
    : [...rules, { action: 'log_custom_field', expression: 'true', description: 'Capgo log fields', action_parameters: { response_fields: [{ name: STAT_HEADER }] } }]
  await cf(path, { method: 'PUT', body: JSON.stringify({ rules: next }) })
  console.log(`Custom log field ${STAT_HEADER} added (additive)`)
}

async function ensureLogpush(zone: string, state: State) {
  const jobs = await cf<{ id: number, name: string }[]>(`/zones/${zone}/logpush/jobs`)
  const found = jobs.find(job => job.name === LOGPUSH_JOB)
  if (found) {
    state.logpushJobId = found.id
    saveState(state)
    return
  }
  const destination = `https://${ORIGIN_HOST}/logpush?header_Authorization=${encodeURIComponent(`Bearer ${state.secret}`)}`
  const job = await cf<{ id: number }>(`/zones/${zone}/logpush/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      name: LOGPUSH_JOB,
      dataset: 'http_requests',
      enabled: true,
      destination_conf: destination,
      max_upload_interval_seconds: 30,
      output_options: { output_type: 'ndjson', field_names: ['ClientRequestHost', 'ClientRequestURI', 'EdgeResponseStatus', 'ResponseHeaders'] },
      filter: JSON.stringify({ where: { or: [PROBE_HOST, TEST_HOST].map(value => ({ key: 'ClientRequestHost', operator: 'eq', value })) } }),
    }),
  })
  state.logpushJobId = job.id
  saveState(state)
  console.log(`Logpush job ${job.id} created (test hosts only)`)
}

async function setup(dryRun: boolean) {
  const state = loadState()
  const zone = await zoneId(state)
  if (dryRun) {
    await setProbeRules(zone, true, true)
    console.log('Dry run: would create R2 bucket, deploy origin worker, DNS, 2 snippets, custom log field, Logpush job')
    return
  }
  wrangler(['r2', 'bucket', 'create', BUCKET])
  wrangler(['deploy'])
  wrangler(['secret', 'put', 'PROBE_SECRET'], state.secret)
  await ensureDns(zone, state)
  await uploadSnippet(zone, PROBE_SNIPPET, readFileSync(join(DIR, 'probe-snippet.js'), 'utf8'))
  await uploadSnippet(zone, TEST_SNIPPET, await buildTestSnippet())
  await setProbeRules(zone, true)
  await ensureCustomField(zone)
  await ensureLogpush(zone, state)
  console.log('Setup done. Give DNS/snippets ~30s, then: bun scripts/snippet-edge-probe/run.ts test')
}

async function get(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  }
  catch {}
  return { status: response.status, headers: response.headers, body }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function test() {
  const state = loadState()
  const zone = await zoneId(state)
  const run = Date.now().toString(36)
  const report: Record<string, unknown> = {}

  // 1. Subrequest limit
  for (const kind of ['match', 'fetch', 'mixed']) {
    const result = await get(`https://${PROBE_HOST}/__probe__/subreq?n=7&kind=${kind}`)
    report[`subrequests_${kind}`] = result.status === 200
      ? result.body.results.map((r: any) => `${r.i}:${r.op}:${r.ok ? 'ok' : `FAIL(${r.error})`}`)
      : `HTTP ${result.status} ${String(result.body).slice(0, 200)}`
  }

  // 2. Purge by tag of a snippet Cache API entry
  const tag = `capgo-edge-probe-purge-${run}`
  const key = `purge-${run}`
  await get(`https://${PROBE_HOST}/__probe__/put?key=${key}&tag=${tag}`)
  const before = await get(`https://${PROBE_HOST}/__probe__/get?key=${key}`)
  await cf(`/zones/${zone}/purge_cache`, { method: 'POST', body: JSON.stringify({ tags: [tag] }) })
  const purgeStart = Date.now()
  let purgedAfterMs: number | null = null
  while (Date.now() - purgeStart < 60_000) {
    const after = await get(`https://${PROBE_HOST}/__probe__/get?key=${key}`)
    if (!after.body.hit) {
      purgedAfterMs = Date.now() - purgeStart
      break
    }
    await sleep(2000)
  }
  report.purge_by_tag = { colo: before.body.colo, hitBeforePurge: before.body.hit, purgedAfterMs }

  // 3. Snippet <-> worker Cache API sharing (same key, same zone, same data center)
  const sharedW = `w-${run}`
  const wPut = await get(`https://${ORIGIN_HOST}/shared-put?key=${sharedW}`)
  const sGet = await get(`https://${PROBE_HOST}/__probe__/shared-get?key=${sharedW}`)
  const sharedS = `s-${run}`
  const sPut = await get(`https://${PROBE_HOST}/__probe__/shared-put?key=${sharedS}`)
  const wGet = await get(`https://${ORIGIN_HOST}/shared-get?key=${sharedS}`)
  report.shared_cache = {
    workerPutColo: wPut.body.colo,
    snippetSeesWorkerEntry: sGet.body.hit,
    snippetColo: sGet.body.colo,
    snippetPutColo: sPut.body.colo,
    workerSeesSnippetEntry: wGet.body.hit,
    workerColo: wGet.body.colo,
  }

  // 4. Response header sizes (Logpush part checked by `logs`)
  report.header_sizes = await Promise.all(HEADER_SIZES.map(async (size) => {
    const result = await get(`https://${PROBE_HOST}/__probe__/header?size=${size}&run=${run}`)
    return { size, status: result.status, clientHeaderLength: result.headers.get(STAT_HEADER)?.length ?? null }
  }))

  // 5. Real snippet end to end on the test host
  const appId = `com.probe.edge${run}`
  const body = (deviceId: string, versionName = '1.0.0') => JSON.stringify({
    app_id: appId,
    device_id: deviceId,
    platform: 'ios',
    version_name: versionName,
    version_build: '1.0.0',
    plugin_version: '8.1.0',
    is_emulator: false,
    is_prod: true,
    defaultChannel: 'production',
  })
  const post = (path: string, payload: string) => get(`https://${TEST_HOST}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
  const served = (result: Awaited<ReturnType<typeof get>>) => result.headers.get('X-Capgo-Edge') === 'answer' ? 'snippet' : result.headers.get('X-Probe-Origin') ? 'origin' : `other(${result.status})`
  const e2e: Record<string, string> = {}
  e2e.first = served(await post('/updates', body('00000000-0000-4000-8000-000000000001')))
  e2e.secondOtherDevice = served(await post('/updates', body('00000000-0000-4000-8000-000000000002')))
  e2e.oldBundle = served(await post('/updates', body('00000000-0000-4000-8000-000000000003', '0.9.0')))
  await cf(`/zones/${zone}/purge_cache`, { method: 'POST', body: JSON.stringify({ tags: [`capgo-edge-probe-${appId}`] }) })
  await sleep(5000)
  e2e.afterPurge = served(await post('/updates', body('00000000-0000-4000-8000-000000000004')))
  e2e.afterRefill = served(await post('/updates', body('00000000-0000-4000-8000-000000000005')))
  e2e.ipLimit = served(await post('/updates', body('ffffffff-0000-4000-8000-000000000006', '0.1.0')))
  e2e.afterIpLimit = served(await post('/updates', body('00000000-0000-4000-8000-000000000007')))
  const stats = JSON.stringify([{ app_id: appId, device_id: '00000000-0000-4000-8000-000000000008', platform: 'ios', version_name: '1.0.0', version_os: '18', is_emulator: false, is_prod: true, action: 'app_moved_to_foreground' }])
  e2e.statsFirst = served(await post('/stats', stats))
  e2e.statsSecond = served(await post('/stats', stats))
  report.real_snippet = e2e

  console.log(JSON.stringify(report, null, 2))
  console.log(`\nLogpush ships every ~30s: run "bun scripts/snippet-edge-probe/run.ts logs" in 1-5 min (run id ${run}).`)
}

async function logs() {
  const state = loadState()
  const result = await get(`https://${ORIGIN_HOST}/logpush-dump`, { headers: { Authorization: `Bearer ${state.secret}` } })
  if (result.status !== 200)
    throw new Error(`logpush-dump: HTTP ${result.status}`)
  const lines = result.body.lines as { host: string, uri: string, statLength: number | null }[]
  const headerLines = lines.filter(line => line.uri?.includes('/__probe__/header'))
  console.log(JSON.stringify({
    files: result.body.files,
    headerSizes: headerLines.map(line => ({ requested: Number(new URL(`https://x${line.uri}`).searchParams.get('size')), logged: line.statLength })),
    realSnippetAnswersLogged: lines.filter(line => line.host === TEST_HOST && line.statLength).length,
  }, null, 2))
}

async function teardown() {
  const state = loadState()
  const zone = await zoneId(state)
  await setProbeRules(zone, false)
  for (const name of [PROBE_SNIPPET, TEST_SNIPPET]) {
    try {
      await cf(`/zones/${zone}/snippets/${name}`, { method: 'DELETE' })
    }
    catch (error) {
      console.log(String(error))
    }
  }
  for (const id of state.dnsIds ?? []) {
    try {
      await cf(`/zones/${zone}/dns_records/${id}`, { method: 'DELETE' })
    }
    catch (error) {
      console.log(String(error))
    }
  }
  if (state.logpushJobId)
    await cf(`/zones/${zone}/logpush/jobs/${state.logpushJobId}`, { method: 'DELETE' })
  wrangler(['delete', '--force'])
  console.log(`Left in place: custom log field ${STAT_HEADER} (additive, needed by the rollout) and R2 bucket ${BUCKET} (delete with: bunx wrangler r2 bucket delete ${BUCKET} after emptying it).`)
  saveState({ secret: state.secret })
}

const command = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
const commands: Record<string, () => Promise<void>> = { setup: () => setup(dryRun), test, logs, teardown }
if (!commands[command ?? '']) {
  console.error('Usage: bun scripts/snippet-edge-probe/run.ts <setup|test|logs|teardown> [--dry-run]')
  process.exit(1)
}
commands[command!]!().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

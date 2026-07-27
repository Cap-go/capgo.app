#!/usr/bin/env bun
/**
 * HAR + CPU inspection for plugin endpoints using real test payloads.
 *
 * Builds the Cloudflare plugin worker (wrangler dry-run), boots ONE Miniflare
 * isolate, replays /ok + /updates + /stats + /channel_self bodies shaped like
 * tests/test-utils getBaseData(), captures:
 * - HAR 1.2 entries (timings / sizes / status)
 * - host-side process.cpuUsage() around dispatchFetch
 *
 * Usage:
 *   bun scripts/bench_plugin_har_inspect.ts
 *   bun scripts/bench_plugin_har_inspect.ts --save scripts/bench/plugin_har_inspect_results.json
 *   bun scripts/bench_plugin_har_inspect.ts --har scripts/bench/plugin_endpoints.har
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Miniflare } from 'miniflare'

const ROOT = resolve(import.meta.dirname, '..')

interface Scenario {
  name: string
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
  warmIters: number
}

interface RequestSample {
  name: string
  status: number
  wallMs: number
  cpuMs: number
  responseBytes: number
  startedDateTime: string
  time: number
  timings: {
    blocked: number
    dns: number
    connect: number
    send: number
    wait: number
    receive: number
    ssl: number
  }
}

function parseArgs(argv: string[]) {
  let savePath = 'scripts/bench/plugin_har_inspect_results.json'
  let harPath = 'scripts/bench/plugin_endpoints.har'
  let warmIters = 40
  let muteLogs = true
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--save')
      savePath = argv[++i]!
    else if (argv[i] === '--har')
      harPath = argv[++i]!
    else if (argv[i] === '--warm')
      warmIters = Number.parseInt(argv[++i]!, 10)
    else if (argv[i] === '--mute-logs')
      muteLogs = true
    else if (argv[i] === '--keep-logs')
      muteLogs = false
  }
  return { savePath, harPath, warmIters, muteLogs }
}

function withMutedConsole<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  if (!enabled)
    return fn()
  const noop = () => {}
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }
  console.log = noop
  console.info = noop
  console.warn = noop
  console.error = noop
  console.debug = noop
  return fn().finally(() => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    console.error = original.error
    console.debug = original.debug
  })
}

function buildPlugin(outDir: string) {
  mkdirSync(outDir, { recursive: true })
  const result = spawnSync('bunx', [
    'wrangler',
    'deploy',
    '--config',
    'cloudflare_workers/plugin/wrangler.jsonc',
    '--env=local',
    '--dry-run',
    '--minify',
    `--outdir=${outDir}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(`wrangler dry-run failed:\n${result.stdout}\n${result.stderr}`)
  const uploadMatch = result.stdout.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/)
  return {
    uploadKiB: uploadMatch ? Number.parseFloat(uploadMatch[1]) : null,
    gzipKiB: uploadMatch ? Number.parseFloat(uploadMatch[2]) : null,
    scriptPath: join(outDir, 'index.js'),
  }
}

function createMiniflare(scriptPath: string) {
  return new Miniflare({
    compatibilityDate: '2026-04-21',
    compatibilityFlags: ['nodejs_compat', 'nodejs_compat_populate_process_env'],
    modules: [
      {
        type: 'ESModule',
        path: 'index.js',
        contents: readFileSync(scriptPath, 'utf8'),
      },
    ],
    bindings: {
      ENV_NAME: 'capgo_plugin-local',
      CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
    },
  })
}

/** Mirror tests/test-utils makeBaseData / getBaseData shape. */
function basePluginBody(appId = 'com.demo.app', deviceId = '00009a6b-eefe-490a-9c60-8e965132ae51') {
  return {
    channel: 'production',
    platform: 'android',
    device_id: deviceId,
    app_id: appId,
    custom_id: '',
    version_build: '1.0.0',
    version_code: '1',
    version_os: '13',
    version_name: '1.0.0',
    plugin_version: '7.0.0',
    is_emulator: false,
    is_prod: true,
  }
}

function deviceIdFor(index: number) {
  // Unique per request so channel_self IP/device rate limits do not skew the bench.
  const hex = index.toString(16).padStart(12, '0')
  return `00009a6b-eefe-490a-9c60-${hex}`
}

function scenarios(warmIters: number): Scenario[] {
  const updateBody = basePluginBody()
  const statsBody = {
    ...basePluginBody(),
    action: 'get',
  }
  const channelSelfBody = {
    ...basePluginBody(),
    channel: 'production',
  }
  const invalidUpdate = {
    app_id: 'not a domain',
    device_id: 'bad',
    version_name: '1.0.0',
    version_build: '1.0.0',
    is_emulator: false,
    is_prod: true,
    platform: 'ios',
    plugin_version: 'nope',
  }
  return [
    { name: 'ok_get', method: 'GET', path: '/ok', warmIters },
    { name: 'updates_valid_shape', method: 'POST', path: '/updates', body: updateBody, headers: { 'content-type': 'application/json' }, warmIters },
    { name: 'updates_invalid', method: 'POST', path: '/updates', body: invalidUpdate, headers: { 'content-type': 'application/json' }, warmIters },
    { name: 'stats_valid_shape', method: 'POST', path: '/stats', body: statsBody, headers: { 'content-type': 'application/json' }, warmIters },
    { name: 'channel_self_valid_shape', method: 'POST', path: '/channel_self', body: channelSelfBody, headers: { 'content-type': 'application/json' }, warmIters },
  ]
}

async function sampleRequest(mf: Miniflare, scenario: Scenario, index: number): Promise<RequestSample> {
  let body = scenario.body
  if (body && typeof body === 'object' && scenario.name === 'channel_self_valid_shape')
    body = { ...body as Record<string, unknown>, device_id: deviceIdFor(index) }
  const bodyText = body === undefined ? undefined : JSON.stringify(body)
  const headers = new Headers(scenario.headers)
  if (bodyText)
    headers.set('content-type', headers.get('content-type') ?? 'application/json')
  // Mimic Cloudflare production: every edge request carries cf-ray.
  headers.set('cf-ray', `har-inspect-${scenario.name}-${index}`)

  const request = new Request(`http://local${scenario.path}`, {
    method: scenario.method,
    headers,
    body: bodyText,
  })

  const startedDateTime = new Date().toISOString()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  const response = await mf.dispatchFetch(request)
  const buf = await response.arrayBuffer()
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  const cpuMs = (cpu.user + cpu.system) / 1000

  return {
    name: scenario.name,
    status: response.status,
    wallMs,
    cpuMs,
    responseBytes: buf.byteLength,
    startedDateTime,
    time: wallMs,
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      send: 0,
      wait: wallMs,
      receive: 0,
      ssl: -1,
    },
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function p95(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
}

function toHar(samples: RequestSample[], scenariosList: Scenario[]) {
  const byName = new Map(scenariosList.map(s => [s.name, s]))
  return {
    log: {
      version: '1.2',
      creator: { name: 'capgo-bench_plugin_har_inspect', version: '1.0.0' },
      entries: samples.map((sample) => {
        const scenario = byName.get(sample.name)!
        const postData = scenario.body === undefined
          ? undefined
          : {
              mimeType: 'application/json',
              text: JSON.stringify(scenario.body),
            }
        return {
          startedDateTime: sample.startedDateTime,
          time: sample.time,
          request: {
            method: scenario.method,
            url: `http://local${scenario.path}`,
            httpVersion: 'HTTP/1.1',
            headers: [
              { name: 'content-type', value: 'application/json' },
              { name: 'cf-ray', value: 'har-inspect' },
            ],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: postData ? postData.text.length : 0,
            postData,
          },
          response: {
            status: sample.status,
            statusText: String(sample.status),
            httpVersion: 'HTTP/1.1',
            headers: [],
            cookies: [],
            content: {
              size: sample.responseBytes,
              mimeType: 'application/json',
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: sample.responseBytes,
          },
          cache: {},
          timings: sample.timings,
          comment: `cpuMs=${sample.cpuMs.toFixed(3)} wallMs=${sample.wallMs.toFixed(3)}`,
        }
      }),
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = mkdtempSync(join(tmpdir(), 'capgo-plugin-har-'))
  console.log(`Building plugin worker into ${outDir}`)
  const built = buildPlugin(outDir)
  console.log(`upload ${built.uploadKiB} KiB / gzip ${built.gzipKiB} KiB`)
  console.log(`log capture: ${args.muteLogs ? 'muted during samples (use --keep-logs to include console CPU)' : 'kept'}`)

  const list = scenarios(args.warmIters)
  const mf = createMiniflare(built.scriptPath)
  const allSamples: RequestSample[] = []
  const summary: Record<string, unknown> = {}

  try {
    // Cold /ok first (module eval)
    const cold = await withMutedConsole(args.muteLogs, () => sampleRequest(mf, { name: 'ok_get', method: 'GET', path: '/ok', warmIters: 1 }, 0))
    allSamples.push(cold)
    summary.cold_ok = {
      status: cold.status,
      wallMs: cold.wallMs,
      cpuMs: cold.cpuMs,
      responseBytes: cold.responseBytes,
    }

    for (const scenario of list) {
      const samples: RequestSample[] = []
      for (let i = 0; i < scenario.warmIters; i++)
        samples.push(await withMutedConsole(args.muteLogs, () => sampleRequest(mf, scenario, i + 1)))
      allSamples.push(...samples)
      const cpu = samples.map(s => s.cpuMs)
      const wall = samples.map(s => s.wallMs)
      summary[scenario.name] = {
        status: [...new Set(samples.map(s => s.status))],
        iters: samples.length,
        medianCpuMs: median(cpu),
        p95CpuMs: p95(cpu),
        medianWallMs: median(wall),
        p95WallMs: p95(wall),
        medianResponseBytes: median(samples.map(s => s.responseBytes)),
      }
      console.log(
        `${scenario.name.padEnd(28)} status=${(summary[scenario.name] as any).status.join(',')} `
        + `cpu(med/p95)=${median(cpu).toFixed(3)}/${p95(cpu).toFixed(3)} ms `
        + `wall(med/p95)=${median(wall).toFixed(3)}/${p95(wall).toFixed(3)} ms`,
      )
    }
  }
  finally {
    void mf.dispose().catch(() => {})
  }

  const ranked = Object.entries(summary)
    .filter(([k]) => k !== 'cold_ok')
    .map(([name, v]) => ({ name, ...(v as any) }))
    .sort((a, b) => b.medianCpuMs - a.medianCpuMs)

  console.log('\n=== Ranked by median CPU ms (warm) ===')
  for (const row of ranked)
    console.log(`${row.name.padEnd(28)} ${row.medianCpuMs.toFixed(3)} ms (p95 ${row.p95CpuMs.toFixed(3)}) status=${row.status}`)

  const report = {
    generatedAt: new Date().toISOString(),
    note: 'Without DB bindings, valid-shape /updates|/stats|/channel_self exercise middleware+parse+validation+early handler path (often fail after validation). Invalid paths stay pure CPU. Use --har for waterfall import.',
    bundle: { uploadKiB: built.uploadKiB, gzipKiB: built.gzipKiB },
    summary,
    rankedByMedianCpuMs: ranked,
  }

  const saveAbs = resolve(ROOT, args.savePath)
  mkdirSync(resolve(saveAbs, '..'), { recursive: true })
  writeFileSync(saveAbs, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nSaved ${saveAbs}`)

  const harAbs = resolve(ROOT, args.harPath)
  writeFileSync(harAbs, `${JSON.stringify(toHar(allSamples, list), null, 2)}\n`)
  console.log(`Saved HAR ${harAbs}`)

  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

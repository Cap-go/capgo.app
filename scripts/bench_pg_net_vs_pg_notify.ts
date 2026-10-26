// Benchmark: net.http_post (pg_net) vs pg_notify + an external LISTEN relay.
//
//   bun scripts/bench_pg_net_vs_pg_notify.ts
//
// Needs Docker and `bun install`. The script starts three containers on one
// Docker network (no host NAT in the request path):
//   - db:    the Supabase Postgres image production runs, with pg_net (4 CPU, 4 GB)
//   - sink:  a Bun HTTP server standing in for /functions/v1/triggers/*
//   - relay: a Bun process that LISTENs and forwards each payload as an HTTP
//            POST (1 CPU, 256 MB). pg_notify cannot send HTTP itself, so a
//            production switch needs this always-on process.
// For each variant it runs pgbench inside the db container and reports caller
// latency, TPS, WAL per transaction, database CPU (db container cgroup), pg_net
// worker CPU / memory, relay CPU / memory, net.* table growth and the time to
// deliver the whole burst (BENCH_SINK_DELAY_MS adds endpoint latency). Containers are removed at the end
// (BENCH_KEEP=1 keeps them).

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import pg from 'pg'

const IMAGE = process.env.BENCH_PG_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.143'
const BUN_IMAGE = process.env.BENCH_BUN_IMAGE ?? 'oven/bun:1.3-alpine'
const NETWORK = 'pgnet-bench'
const DB = 'pgnet-bench-db'
const SINK = 'pgnet-bench-sink'
const RELAY = 'pgnet-bench-relay'
const DB_PORT = Number(process.env.BENCH_DB_PORT ?? 55439)
const SINK_PORT = Number(process.env.BENCH_SINK_PORT ?? 18080)
const HOST_PG_URL = `postgres://supabase_admin:postgres@127.0.0.1:${DB_PORT}/postgres`
const NET_PG_URL = `postgres://supabase_admin:postgres@${DB}:5432/postgres`
const SINK_URL = `http://${SINK}:8080/sink`
const CHANNEL = 'capgo_http_request'
const TOTAL_TX = Number(process.env.BENCH_TOTAL_TX ?? 20000)
const CLIENTS = (process.env.BENCH_CLIENTS ?? '1,16,64').split(',').map(Number)
// Simulated endpoint latency (an edge function answers in tens of ms).
const SINK_DELAY_MS = Number(process.env.BENCH_SINK_DELAY_MS ?? 0)
const REPO = resolve(import.meta.dir, '..')
const SCRIPT_IN_CONTAINER = '/app/scripts/bench_pg_net_vs_pg_notify.ts'

// Same headers and body shape process_function_queue sends today.
const HEADERS = { 'Content-Type': 'application/json', 'apisecret': 'bench-secret-0123456789abcdef0123456789abcdef' }
const BODY_SQL = `pg_catalog.jsonb_build_object('queue_name', 'on_version_update', 'batch_size', 950, 'wait_for_completion', false)`

function sh(cmd: string, args: string[], input?: string): Promise<{ code: number, out: string, err: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => out += d)
    child.stderr.on('data', d => err += d)
    child.on('close', code => done({ code: code ?? 1, out, err }))
    if (input)
      child.stdin.write(input)
    child.stdin.end()
  })
}

async function docker(args: string[], input?: string) {
  const res = await sh('docker', args, input)
  if (res.code !== 0)
    throw new Error(`docker ${args.join(' ')} failed: ${res.err}`)
  return res.out
}

const exec = (container: string, args: string[], input?: string) => docker(['exec', '-i', container, ...args], input)

/** CPU (ms) and memory (KB) of a whole container from its cgroup. */
async function cgroup(container: string) {
  const out = await exec(container, ['sh', '-c', 'cat /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.stat'])
  const num = (name: string) => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(out)?.[1] ?? 0)
  return { cpuMs: num('usage_usec') / 1000, anonKb: num('anon') / 1024 }
}

/** CPU (ms) and private memory (KB) of one Postgres process. */
async function proc(pid: number) {
  const stat = await exec(DB, ['cat', `/proc/${pid}/stat`])
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const status = await exec(DB, ['cat', `/proc/${pid}/status`])
  return {
    cpuMs: (Number(fields[11]) + Number(fields[12])) * 10,
    anonKb: Number(/RssAnon:\s+(\d+)/.exec(status)?.[1] ?? 0),
  }
}

// ---------------------------------------------------------------------------
// sink (runs in its container): counts requests
// ---------------------------------------------------------------------------
function runSink() {
  let count = 0
  Bun.serve({
    port: 8080,
    hostname: '0.0.0.0',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/count')
        return Response.json({ count })
      if (path === '/reset') {
        count = 0
        return Response.json({ count })
      }
      await req.text()
      if (SINK_DELAY_MS)
        await Bun.sleep(SINK_DELAY_MS)
      count++
      return Response.json({ status: 'ok' })
    },
  })
}

// ---------------------------------------------------------------------------
// relay (runs in its container): LISTEN -> HTTP POST
// ---------------------------------------------------------------------------
async function runRelay() {
  const client = new pg.Client({ connectionString: NET_PG_URL, application_name: 'bench_notify_relay' })
  await client.connect()
  client.on('notification', (msg) => {
    fetch(SINK_URL, { method: 'POST', headers: HEADERS, body: msg.payload, signal: AbortSignal.timeout(8000) })
      .then(r => r.text())
      .catch(error => console.error('relay POST failed', error))
  })
  await client.query(`LISTEN ${CHANNEL}`)
  console.log('relay ready')
}

// ---------------------------------------------------------------------------
// orchestrator (host)
// ---------------------------------------------------------------------------
type Variant = 'baseline' | 'pg_net' | 'pg_notify'
type Workload = 'enqueue_only' | 'update_plus_enqueue'

function pgbenchScript(variant: Variant, workload: Workload) {
  const enqueue = {
    baseline: `SELECT 1;`,
    pg_net: `SELECT net.http_post(url := '${SINK_URL}', headers := '${JSON.stringify(HEADERS)}'::jsonb, body := ${BODY_SQL}, timeout_milliseconds := 8000);`,
    pg_notify: `SELECT pg_catalog.pg_notify('${CHANNEL}', ${BODY_SQL}::text);`,
  }[variant]
  if (workload === 'enqueue_only')
    return `${enqueue}\n`
  // A business write that fires the enqueue in the same transaction, like the
  // updates_cache_purge triggers on channels / apps / app_versions.
  return `\\set id random(1, 10000)\nBEGIN;\nUPDATE public.bench_rows SET n = n + 1 WHERE id = :id;\n${enqueue}\nCOMMIT;\n`
}

async function sinkCount() {
  const res = await fetch(`http://127.0.0.1:${SINK_PORT}/count`)
  return ((await res.json()) as { count: number }).count
}

async function waitDelivered(target: number, timeoutMs = 300_000) {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (await sinkCount() >= target)
      return Math.round(performance.now() - start)
    await Bun.sleep(5)
  }
  return Number.NaN
}

async function waitForDb() {
  for (let i = 0; i < 120; i++) {
    const res = await sh('docker', ['exec', DB, 'pg_isready', '-h', '127.0.0.1', '-U', 'supabase_admin'])
    if (res.code === 0) {
      const client = new pg.Client({ connectionString: HOST_PG_URL })
      try {
        await client.connect()
        await client.end()
        return
      }
      catch {}
    }
    await Bun.sleep(500)
  }
  throw new Error('database did not start')
}

async function removeContainers() {
  await sh('docker', ['rm', '-f', RELAY, SINK, DB])
  await sh('docker', ['network', 'rm', NETWORK])
}

async function startContainers() {
  await removeContainers()
  await docker(['network', 'create', NETWORK])
  await docker(['run', '-d', '--name', DB, '--network', NETWORK, '--cpus=4', '--memory=4g', '-p', `${DB_PORT}:5432`, '-e', 'POSTGRES_PASSWORD=postgres', IMAGE, 'postgres', '-c', 'listen_addresses=*', '-c', 'shared_preload_libraries=pg_net', '-c', 'max_connections=200'])
  const bun = (name: string, mode: string, extra: string[]) => docker(['run', '-d', '--name', name, '--network', NETWORK, ...extra, '-v', `${REPO}:/app:ro`, '-w', '/app', BUN_IMAGE, 'bun', SCRIPT_IN_CONTAINER, mode])
  await bun(SINK, 'sink', ['--cpus=2', '-p', `${SINK_PORT}:8080`, '-e', `BENCH_SINK_DELAY_MS=${SINK_DELAY_MS}`])
  await waitForDb()
  await bun(RELAY, 'relay', ['--cpus=1', '--memory=256m'])
}

interface Result {
  variant: Variant
  workload: Workload
  clients: number
  tx: number
  tps: number
  latencyAvgMs: number
  walBytesPerTx: number
  dbCpuMsPerTx: number
  drainMs: number
  delivered: number
  pgNetWorkerCpuMs?: number
  pgNetWorkerAnonKb?: number
  netTablesKb?: number
  relayCpuMs?: number
  relayAnonKb?: number
  relayBackendCpuMs?: number
}

async function main() {
  await startContainers()
  const db = new pg.Client({ connectionString: HOST_PG_URL })
  await db.connect()
  await db.query(`CREATE EXTENSION IF NOT EXISTS pg_net`)
  await db.query(`CREATE TABLE public.bench_rows (id int PRIMARY KEY, n bigint NOT NULL DEFAULT 0)`)
  await db.query(`INSERT INTO public.bench_rows (id) SELECT g FROM generate_series(1, 10000) g`)

  // The relay connects once the database accepts connections.
  let relayBackendPid = 0
  for (let i = 0; i < 100 && !relayBackendPid; i++) {
    relayBackendPid = Number((await db.query(`SELECT pid FROM pg_stat_activity WHERE application_name = 'bench_notify_relay' AND query ILIKE 'LISTEN%'`)).rows[0]?.pid ?? 0)
    if (!relayBackendPid)
      await Bun.sleep(200)
  }
  const workerPid = Number((await db.query(`SELECT pid FROM pg_stat_activity WHERE backend_type ILIKE 'pg_net%'`)).rows[0]?.pid ?? 0)
  if (!relayBackendPid || !workerPid)
    throw new Error(`missing relay backend (${relayBackendPid}) or pg_net worker (${workerPid})`)

  const results: Result[] = []
  for (const workload of ['enqueue_only', 'update_plus_enqueue'] as Workload[]) {
    for (const clients of CLIENTS) {
      for (const variant of ['baseline', 'pg_net', 'pg_notify'] as Variant[]) {
        const perClient = Math.ceil(TOTAL_TX / clients)
        const tx = perClient * clients
        // Same state for every run: empty pg_net tables (prod truncates
        // net._http_response hourly), clean checkpoint, zeroed sink.
        await db.query(`TRUNCATE net._http_response`)
        await db.query(`VACUUM FULL net.http_request_queue, net._http_response, public.bench_rows`)
        await db.query(`CHECKPOINT`)
        await fetch(`http://127.0.0.1:${SINK_PORT}/reset`)
        await Bun.sleep(500)

        await exec(DB, ['sh', '-c', 'cat > /tmp/bench.sql'], pgbenchScript(variant, workload))
        const walStart = (await db.query(`SELECT pg_current_wal_insert_lsn() AS lsn`)).rows[0].lsn
        const dbStart = await cgroup(DB)
        const relayStart = await cgroup(RELAY)
        const workerStart = await proc(workerPid)
        const relayBackendStart = await proc(relayBackendPid)

        const out = await exec(DB, ['pgbench', '-n', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres', '-c', String(clients), '-j', String(Math.min(clients, 4)), '-t', String(perClient), '-M', 'prepared', '-f', '/tmp/bench.sql'])
        const drainMs = variant === 'baseline' ? 0 : await waitDelivered(tx)
        // pg_net writes each response row after the request; let it settle.
        await Bun.sleep(1000)

        const walBytes = Number((await db.query(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1) AS b`, [walStart])).rows[0].b)
        const dbEnd = await cgroup(DB)
        const relayEnd = await cgroup(RELAY)
        const workerEnd = await proc(workerPid)
        const relayBackendEnd = await proc(relayBackendPid)
        const netTablesKb = Number((await db.query(`SELECT (pg_total_relation_size('net.http_request_queue') + pg_total_relation_size('net._http_response')) / 1024 AS kb`)).rows[0].kb)

        const result: Result = {
          variant,
          workload,
          clients,
          tx,
          tps: Math.round(Number(/tps = ([\d.]+)/.exec(out)?.[1] ?? 0)),
          latencyAvgMs: Number(/latency average = ([\d.]+) ms/.exec(out)?.[1] ?? 0),
          walBytesPerTx: Math.round(walBytes / tx),
          // Includes the pg_net worker and the relay's backend: all of it is
          // database CPU.
          dbCpuMsPerTx: Number(((dbEnd.cpuMs - dbStart.cpuMs) / tx).toFixed(4)),
          drainMs,
          delivered: await sinkCount(),
        }
        if (variant === 'pg_net') {
          result.pgNetWorkerCpuMs = workerEnd.cpuMs - workerStart.cpuMs
          result.pgNetWorkerAnonKb = workerEnd.anonKb
          result.netTablesKb = netTablesKb
        }
        if (variant === 'pg_notify') {
          result.relayCpuMs = Math.round(relayEnd.cpuMs - relayStart.cpuMs)
          result.relayAnonKb = Math.round(relayEnd.anonKb)
          result.relayBackendCpuMs = relayBackendEnd.cpuMs - relayBackendStart.cpuMs
        }
        results.push(result)
        console.error(JSON.stringify(result))
      }
    }
  }
  await db.end()
  console.log(JSON.stringify(results, null, 2))
}

const mode = process.argv[2] ?? 'run'
if (mode === 'sink') {
  runSink()
}
else if (mode === 'relay') {
  await runRelay()
}
else {
  try {
    await main()
  }
  finally {
    if (!process.env.BENCH_KEEP)
      await removeContainers()
  }
}

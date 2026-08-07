import type { Context } from 'hono'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

export interface BuilderCapacityEvent {
  created_at: number
  workers_total: number
  delta: number
}

export interface BuilderRunInterval {
  started_at: number
  completed_at: number | null
}

export interface BuilderCapacityHourPoint {
  date: string
  workers: number
  used: number
  free: number
  waiting: number
}

export interface BuilderCapacityLive {
  workers_total: number
  workers_online: number
  used: number
  free: number
  waiting: number
  offline: number
  builder_reachable: boolean
}

export interface BuilderCapacityResult {
  live: BuilderCapacityLive
  hourly: BuilderCapacityHourPoint[]
  capacity_events: number
  runs_sampled: number
}

interface BuilderRunner {
  id?: number | string
  online?: boolean
  currentJobId?: string | null
}

interface BuilderRunnersResponse {
  runners?: BuilderRunner[]
  pressure?: {
    waitingJobs?: number
    onlineRunners?: number
    registeredRunners?: number
  }
}

interface BuilderOkResponse {
  machines_set?: number
  machines_answering?: number
  status?: string
}

/** Statuses that occupy a runner machine (not queue wait). */
const OCCUPYING_BUILD_STATUSES = ['running'] as const
const HOUR_MS = 60 * 60 * 1000
const CAPACITY_ADVISORY_LOCK_KEY = 874_201_903

export function msFromBuilderTimestamp(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return null
  return Math.trunc(value)
}

export function isoFromBuilderTimestamp(value: number | null | undefined): string | null {
  const ms = msFromBuilderTimestamp(value)
  if (ms === null)
    return null
  return new Date(ms).toISOString()
}

export function workersAt(events: BuilderCapacityEvent[], atMs: number): number {
  let workers = 0
  for (const event of events) {
    if (event.created_at > atMs)
      break
    workers = event.workers_total
  }
  return workers
}

export function maxConcurrentUsed(
  intervals: BuilderRunInterval[],
  rangeStartMs: number,
  rangeEndMs: number,
): number {
  const events: Array<{ t: number, d: number }> = []
  for (const interval of intervals) {
    if (interval.started_at >= rangeEndMs)
      continue
    const end = interval.completed_at ?? rangeEndMs
    if (end <= rangeStartMs)
      continue
    const start = Math.max(interval.started_at, rangeStartMs)
    const stop = Math.min(end, rangeEndMs)
    if (stop <= start)
      continue
    events.push({ t: start, d: 1 })
    events.push({ t: stop, d: -1 })
  }
  events.sort((a, b) => a.t - b.t || a.d - b.d)

  let current = 0
  let max = 0
  for (const event of events) {
    current += event.d
    if (current > max)
      max = current
  }
  return max
}

/**
 * Single sweep over run intervals + capacity events.
 * First/last hour bins are clipped to [startMs, endMs].
 */
export function reconstructHourlyCapacity(
  events: BuilderCapacityEvent[],
  intervals: BuilderRunInterval[],
  startIso: string,
  endIso: string,
  waitingByHour: Map<string, number> = new Map(),
): BuilderCapacityHourPoint[] {
  const startMs = Date.parse(startIso)
  const endMs = Date.parse(endIso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs)
    return []

  const sortedEvents = [...events].sort((a, b) => a.created_at - b.created_at)

  const runEvents: Array<{ t: number, d: number }> = []
  for (const interval of intervals) {
    const start = Math.max(interval.started_at, startMs)
    const end = Math.min(interval.completed_at ?? endMs, endMs)
    if (end <= start)
      continue
    runEvents.push({ t: start, d: 1 }, { t: end, d: -1 })
  }
  runEvents.sort((a, b) => a.t - b.t || a.d - b.d)

  const firstHour = Math.floor(startMs / HOUR_MS) * HOUR_MS
  const points: BuilderCapacityHourPoint[] = []
  let ei = 0
  let current = 0

  for (let hour = firstHour; hour < endMs; hour += HOUR_MS) {
    const binStart = Math.max(hour, startMs)
    const binEnd = Math.min(hour + HOUR_MS, endMs)
    if (binEnd <= binStart)
      continue

    let maxUsed = current
    while (ei < runEvents.length && runEvents[ei].t < binEnd) {
      current += runEvents[ei].d
      if (runEvents[ei].t >= binStart)
        maxUsed = Math.max(maxUsed, current)
      ei += 1
    }

    const workers = workersAt(sortedEvents, binEnd - 1)
    const date = new Date(hour).toISOString()
    points.push({
      date,
      workers,
      used: maxUsed,
      free: Math.max(0, workers - maxUsed),
      waiting: waitingByHour.get(date) ?? 0,
    })
  }

  return points
}

async function fetchBuilderLive(c: Context): Promise<{
  live: BuilderCapacityLive
  source: string
}> {
  const empty: BuilderCapacityLive = {
    workers_total: 0,
    workers_online: 0,
    used: 0,
    free: 0,
    waiting: 0,
    offline: 0,
    builder_reachable: false,
  }

  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl) {
    return { live: empty, source: 'missing_builder_url' }
  }

  try {
    if (builderApiKey) {
      const response = await fetch(`${builderUrl}/gitlab-emulator/runners`, {
        method: 'GET',
        headers: { 'x-api-key': builderApiKey },
      })
      if (response.ok) {
        const body = await response.json() as BuilderRunnersResponse
        const runners = body.runners ?? []
        const online = runners.filter(r => r.online)
        const used = online.filter(r => !!r.currentJobId).length
        const free = Math.max(0, online.length - used)
        const offline = Math.max(0, runners.length - online.length)
        const waiting = body.pressure?.waitingJobs ?? 0
        return {
          live: {
            workers_total: runners.length,
            workers_online: online.length,
            used,
            free,
            waiting,
            offline,
            builder_reachable: true,
          },
          source: 'runners',
        }
      }
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'builder capacity runners fetch failed',
        status: response.status,
      })
    }

    const okResponse = await fetch(`${builderUrl}/ok`, { method: 'GET' })
    if (!okResponse.ok) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'builder capacity /ok fetch failed',
        status: okResponse.status,
      })
      return { live: empty, source: 'unreachable' }
    }
    const ok = await okResponse.json() as BuilderOkResponse
    const online = Math.max(0, Math.trunc(ok.machines_answering ?? 0))
    const total = Math.max(online, Math.trunc(ok.machines_set ?? online))
    return {
      live: {
        workers_total: total,
        workers_online: online,
        used: 0,
        free: online,
        waiting: 0,
        offline: Math.max(0, total - online),
        builder_reachable: true,
      },
      source: 'ok',
    }
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'builder capacity live fetch error',
      error: String(error),
    })
    return { live: empty, source: 'error' }
  }
}

async function countOccupyingBuilds(c: Context): Promise<number> {
  const { count, error } = await supabaseAdmin(c)
    .from('build_requests')
    .select('id', { count: 'exact', head: true })
    .in('status', [...OCCUPYING_BUILD_STATUSES])

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed counting occupying builds for capacity',
      error: error.message,
    })
    return 0
  }
  return count ?? 0
}

export async function recordBuilderCapacityIfChanged(
  c: Context,
  workersTotal: number,
  source = 'sync',
): Promise<BuilderCapacityEvent | null> {
  const total = Math.max(0, Math.trunc(workersTotal))
  const client = getPgClient(c)
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_ADVISORY_LOCK_KEY])

    const { rows: latestRows } = await client.query<{ workers_total: number }>(
      `SELECT workers_total
       FROM public.builder_capacity_events
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    const previous = latestRows[0]?.workers_total ?? null
    if (previous === total) {
      await client.query('COMMIT')
      return null
    }

    const delta = previous === null ? total : total - previous
    const { rows } = await client.query<{
      created_at: string
      workers_total: number
      delta: number
    }>(
      `INSERT INTO public.builder_capacity_events (workers_total, delta, source)
       VALUES ($1, $2, $3)
       RETURNING created_at, workers_total, delta`,
      [total, delta, source],
    )
    await client.query('COMMIT')

    const inserted = rows[0]
    if (!inserted)
      return null

    cloudlog({
      requestId: c.get('requestId'),
      message: 'builder capacity event recorded',
      workers_total: total,
      delta,
      source,
    })

    return {
      created_at: Date.parse(inserted.created_at),
      workers_total: inserted.workers_total,
      delta: inserted.delta,
    }
  }
  catch (error) {
    try {
      await client.query('ROLLBACK')
    }
    catch {
      // ignore rollback errors
    }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed recording builder capacity event',
      error: String(error),
    })
    return null
  }
  finally {
    await closeClient(c, client)
  }
}

async function loadCapacityEvents(
  c: Context,
  startIso: string,
  endIso: string,
): Promise<BuilderCapacityEvent[]> {
  const client = getPgClient(c)
  try {
    const { rows } = await client.query<{
      created_at: string
      workers_total: number
      delta: number
    }>(
      `WITH baseline AS (
         SELECT created_at, workers_total, delta
         FROM public.builder_capacity_events
         WHERE created_at < $1::timestamptz
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ),
       window_events AS (
         SELECT created_at, workers_total, delta
         FROM public.builder_capacity_events
         WHERE created_at >= $1::timestamptz
           AND created_at <= $2::timestamptz
       )
       SELECT * FROM baseline
       UNION ALL
       SELECT * FROM window_events
       ORDER BY created_at ASC`,
      [startIso, endIso],
    )
    return rows.map(row => ({
      created_at: Date.parse(row.created_at),
      workers_total: Number(row.workers_total) || 0,
      delta: Number(row.delta) || 0,
    }))
  }
  finally {
    await closeClient(c, client)
  }
}

async function loadRunIntervals(
  c: Context,
  startIso: string,
  endIso: string,
): Promise<BuilderRunInterval[]> {
  const client = getPgClient(c)
  try {
    // Only builder-reported run intervals (started_at set when the runner
    // actually starts). Exclude waiting_runner / queue time from "used".
    const { rows } = await client.query<{
      started_at: string | null
      completed_at: string | null
    }>(
      `WITH request_runs AS (
         SELECT
           br.started_at,
           br.completed_at
         FROM public.build_requests br
         WHERE br.started_at IS NOT NULL
           AND (
             br.completed_at IS NOT NULL
             OR br.status = 'running'
           )
           AND br.started_at < $2::timestamptz
           AND (br.completed_at IS NULL OR br.completed_at > $1::timestamptz)
           AND (br.completed_at IS NULL OR br.completed_at >= br.started_at)
       ),
       log_runs AS (
         SELECT
           (bl.created_at - make_interval(secs => GREATEST(bl.build_time_unit, 0))) AS started_at,
           bl.created_at AS completed_at
         FROM public.build_logs bl
         WHERE bl.created_at > $1::timestamptz
           AND bl.created_at - make_interval(secs => GREATEST(bl.build_time_unit, 0)) < $2::timestamptz
           AND bl.build_time_unit > 0
           AND NOT EXISTS (
             SELECT 1
             FROM public.build_requests br
             WHERE br.builder_job_id = bl.build_id
               AND br.started_at IS NOT NULL
           )
       )
       SELECT started_at, completed_at FROM request_runs
       UNION ALL
       SELECT started_at, completed_at FROM log_runs`,
      [startIso, endIso],
    )

    return rows
      .map((row) => {
        const started = row.started_at ? Date.parse(row.started_at) : NaN
        if (!Number.isFinite(started))
          return null
        const completed = row.completed_at ? Date.parse(row.completed_at) : null
        const completedMs = completed !== null && Number.isFinite(completed) ? completed : null
        if (completedMs !== null && completedMs < started)
          return null
        return {
          started_at: started,
          completed_at: completedMs,
        } satisfies BuilderRunInterval
      })
      .filter((row): row is BuilderRunInterval => row !== null)
  }
  finally {
    await closeClient(c, client)
  }
}

export async function getAdminBuilderCapacity(
  c: Context,
  startIso: string,
  endIso: string,
): Promise<BuilderCapacityResult> {
  const [{ live, source }, occupyingBuilds] = await Promise.all([
    fetchBuilderLive(c),
    countOccupyingBuilds(c),
  ])

  // Prefer builder machine occupancy; fall back to Capgo running jobs when /ok
  // path cannot see currentJobId. waiting_runner is demand, not used capacity.
  if (source === 'ok' || (!live.builder_reachable && occupyingBuilds > 0)) {
    live.used = Math.min(live.workers_online || occupyingBuilds, occupyingBuilds)
    live.free = Math.max(0, (live.workers_online || occupyingBuilds) - live.used)
  }

  const [events, intervals] = await Promise.all([
    loadCapacityEvents(c, startIso, endIso),
    loadRunIntervals(c, startIso, endIso),
  ])

  const hourly = reconstructHourlyCapacity(events, intervals, startIso, endIso)

  return {
    live,
    hourly,
    capacity_events: events.length,
    runs_sampled: intervals.length,
  }
}

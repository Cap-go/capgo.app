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

const ACTIVE_BUILD_STATUSES = ['starting', 'waiting_runner', 'running'] as const
const HOUR_MS = 60 * 60 * 1000

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
  hourStartMs: number,
  hourEndMs: number,
): number {
  const events: Array<{ t: number, d: number }> = []
  for (const interval of intervals) {
    if (interval.started_at >= hourEndMs)
      continue
    const end = interval.completed_at ?? hourEndMs
    if (end <= hourStartMs)
      continue
    const start = Math.max(interval.started_at, hourStartMs)
    const stop = Math.min(end, hourEndMs)
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
  const hourStart = Math.floor(startMs / HOUR_MS) * HOUR_MS
  const points: BuilderCapacityHourPoint[] = []

  for (let t = hourStart; t < endMs; t += HOUR_MS) {
    const hourEnd = t + HOUR_MS
    const date = new Date(t).toISOString()
    const workers = workersAt(sortedEvents, hourEnd - 1)
    const used = maxConcurrentUsed(intervals, t, hourEnd)
    const free = Math.max(0, workers - used)
    points.push({
      date,
      workers,
      used,
      free,
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

async function countActiveBuilds(c: Context): Promise<number> {
  const { count, error } = await supabaseAdmin(c)
    .from('build_requests')
    .select('id', { count: 'exact', head: true })
    .in('status', [...ACTIVE_BUILD_STATUSES])

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed counting active builds for capacity',
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
  const admin = supabaseAdmin(c)

  const { data: latest, error: latestError } = await admin
    .from('builder_capacity_events')
    .select('workers_total')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed reading latest builder capacity event',
      error: latestError.message,
    })
    return null
  }

  const previous = latest?.workers_total ?? null
  if (previous === total)
    return null

  const delta = previous === null ? total : total - previous
  const { data: inserted, error: insertError } = await admin
    .from('builder_capacity_events')
    .insert({
      workers_total: total,
      delta,
      source,
    })
    .select('created_at, workers_total, delta')
    .single()

  if (insertError || !inserted) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed inserting builder capacity event',
      error: insertError?.message,
    })
    return null
  }

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

async function loadCapacityEvents(
  c: Context,
  startIso: string,
  endIso: string,
): Promise<BuilderCapacityEvent[]> {
  const client = getPgClient(c)
  try {
    // Include the latest event before the window so workersAt() has a baseline.
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
    const { rows } = await client.query<{
      started_at: string | null
      completed_at: string | null
      created_at: string
      build_time_unit: number | null
      source: string
    }>(
      `WITH request_runs AS (
         SELECT
           br.started_at,
           br.completed_at,
           br.created_at,
           NULL::bigint AS build_time_unit,
           'request'::text AS source
         FROM public.build_requests br
         WHERE br.started_at IS NOT NULL
           AND br.started_at < $2::timestamptz
           AND (br.completed_at IS NULL OR br.completed_at > $1::timestamptz)
       ),
       log_runs AS (
         SELECT
           (bl.created_at - make_interval(secs => GREATEST(bl.build_time_unit, 0))) AS started_at,
           bl.created_at AS completed_at,
           bl.created_at,
           bl.build_time_unit,
           'log'::text AS source
         FROM public.build_logs bl
         WHERE bl.created_at > $1::timestamptz
           AND bl.created_at - make_interval(secs => GREATEST(bl.build_time_unit, 0)) < $2::timestamptz
           AND NOT EXISTS (
             SELECT 1
             FROM public.build_requests br
             WHERE br.builder_job_id = bl.build_id
               AND br.started_at IS NOT NULL
           )
       )
       SELECT started_at, completed_at, created_at, build_time_unit, source
       FROM request_runs
       UNION ALL
       SELECT started_at, completed_at, created_at, build_time_unit, source
       FROM log_runs`,
      [startIso, endIso],
    )

    return rows
      .map((row) => {
        const started = row.started_at ? Date.parse(row.started_at) : NaN
        if (!Number.isFinite(started))
          return null
        const completed = row.completed_at ? Date.parse(row.completed_at) : null
        return {
          started_at: started,
          completed_at: completed !== null && Number.isFinite(completed) ? completed : null,
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
  const [{ live, source }, activeBuilds] = await Promise.all([
    fetchBuilderLive(c),
    countActiveBuilds(c),
  ])

  // Prefer builder machine occupancy; fall back to Capgo active jobs when /ok
  // path cannot see currentJobId.
  if (source === 'ok' || (!live.builder_reachable && activeBuilds > 0)) {
    live.used = Math.min(live.workers_online || activeBuilds, activeBuilds)
    live.free = Math.max(0, (live.workers_online || activeBuilds) - live.used)
  }

  const poolSize = live.workers_online > 0 ? live.workers_online : live.workers_total
  if (live.builder_reachable)
    await recordBuilderCapacityIfChanged(c, poolSize, `admin_${source}`)

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

import type { Context } from 'hono'
import type { PgClient } from '../utils/pg.ts'
import type { RolloutChannelTotals, RolloutChannelWindow } from '../utils/cloudflare_rollout_stats.ts'
import type { AutoPauseAction } from '../utils/rollout.ts'
import { readRolloutVersionTotalsCF } from '../utils/cloudflare_rollout_stats.ts'
import { BRES, createHono, middlewareAPISecret } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { queryJson } from '../utils/pg_rls.ts'
import { evaluateAutoPausePolicy } from '../utils/rollout.ts'
import { readStatsVersion } from '../utils/stats.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { version } from '../utils/version.ts'

interface RolloutAutoPauseChannel {
  app_id: string
  auto_pause_action: string
  auto_pause_confidence: number | string
  auto_pause_cooldown_minutes: number
  auto_pause_enabled: boolean
  auto_pause_failure_rate_bps: number | null
  auto_pause_last_checked_at?: string | null
  auto_pause_last_triggered_at: string | null
  rollout_paused_at: string | null
  auto_pause_min_attempts: number | null
  auto_pause_min_failures: number | null
  auto_pause_window_minutes: number
  id: number
  name: string
  owner_org: string
  rollout_version: number
  rollout_version_info?: { name: string } | { name: string }[] | null
}

export const app = createHono('', version)
// Runs every 5 minutes through the queue consumer, which aborts the request
// after 15 s. Each run checks the channels checked longest ago first, stops
// starting new work after the time budget, and leaves the rest for the next
// run (they are then the oldest-checked ones).
const AUTO_PAUSE_MAX_CHANNELS_PER_RUN = 500
// One pair of Analytics Engine queries covers up to this many channels of one app.
const AUTO_PAUSE_CHANNELS_PER_QUERY = 20
const AUTO_PAUSE_QUERY_CONCURRENCY = 3
const AUTO_PAUSE_TIME_BUDGET_MS = 9_000
const AUTO_PAUSE_QUERY_TIMEOUT_MS = 4_000

function normalizeAction(action: string): AutoPauseAction {
  if (action === 'rollback' || action === 'notify')
    return action
  return 'pause'
}

function getRolloutVersionName(channel: RolloutAutoPauseChannel): string | null {
  const relation = channel.rollout_version_info
  if (!relation)
    return null
  if (Array.isArray(relation))
    return relation[0]?.name ?? null
  return relation.name ?? null
}

function getWindowStart(windowMinutes: number, now: Date): string {
  const minutes = Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : 60
  return new Date(now.getTime() - minutes * 60 * 1000).toISOString()
}

function buildReason(channel: RolloutAutoPauseChannel, versionName: string, result: ReturnType<typeof evaluateAutoPausePolicy>) {
  return `Auto-pause ${result.action} for ${channel.name} rollout ${versionName}: fail ${result.failureRateBps}bps, confidence lower bound ${result.lowerBoundBps}bps, threshold ${result.thresholdBps}bps, attempts ${result.attempts}.`
}

const CHANNEL_PATCH_COLUMNS = new Set([
  'auto_pause_last_checked_at',
  'auto_pause_last_triggered_at',
  'rollout_pause_reason',
  'rollout_paused_at',
  'rollout_enabled',
  'rollout_percentage_bps',
  'rollout_version',
])

async function updateCurrentRolloutChannel(pg: PgClient, channel: RolloutAutoPauseChannel, patch: Record<string, unknown>) {
  const entries = Object.entries(patch)
  for (const [column] of entries) {
    if (!CHANNEL_PATCH_COLUMNS.has(column))
      throw new Error(`Unexpected channel patch column ${column}`)
  }
  const assignments = entries.map(([column], index) => `"${column}" = $${index + 3}`).join(', ')
  const result = await pg.query(
    `UPDATE public.channels SET ${assignments}
    WHERE id = $1
      AND rollout_version = $2
      AND rollout_enabled = true
      AND rollout_percentage_bps > 0
      AND rollout_paused_at IS NULL
    RETURNING id`,
    [channel.id, channel.rollout_version, ...entries.map(([, value]) => value)],
  )

  return (result.rowCount ?? 0) > 0
}

type AutoPausePolicyResult = ReturnType<typeof evaluateAutoPausePolicy>

interface ChannelEvaluation {
  channel: RolloutAutoPauseChannel
  versionName: string
  result: AutoPausePolicyResult
}

function evaluatePolicy(channel: RolloutAutoPauseChannel, totals: RolloutChannelTotals, now: Date) {
  return evaluateAutoPausePolicy({
    action: normalizeAction(channel.auto_pause_action),
    confidence: Number(channel.auto_pause_confidence ?? 0.95),
    cooldownMinutes: channel.auto_pause_cooldown_minutes ?? 60,
    enabled: channel.auto_pause_enabled,
    failureRateBps: channel.auto_pause_failure_rate_bps,
    failures: totals.failures,
    installs: totals.installs,
    lastTriggeredAt: channel.auto_pause_last_triggered_at,
    minAttempts: channel.auto_pause_min_attempts,
    minFailures: channel.auto_pause_min_failures,
    now,
  })
}

/** Install and fail totals of each channel's rollout version inside its window. */
async function readChannelTotals(c: Context, windows: RolloutChannelWindow[], now: Date): Promise<RolloutChannelTotals[] | null> {
  if (c.env.VERSION_USAGE) {
    return readRolloutVersionTotalsCF(c, windows, now.toISOString(), {
      signal: AbortSignal.timeout(AUTO_PAUSE_QUERY_TIMEOUT_MS),
    })
  }
  // Postgres fallback (self-hosted, local): one read per channel, as before.
  // A failed read must not count as zero installs and fails: give up on the chunk.
  const totals: RolloutChannelTotals[] = []
  for (const window of windows) {
    let stats: Awaited<ReturnType<typeof readStatsVersion>>
    try {
      stats = await readStatsVersion(c, window.appId, window.start, now.toISOString(), window.channel, { throwOnError: true })
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Rollout auto-pause Postgres stats read failed', appId: window.appId, error })
      return null
    }
    totals.push(stats
      .filter(row => row.version_name === window.versionName)
      .reduce((acc, row) => {
        acc.installs += Number(row.install ?? 0)
        acc.failures += Number(row.fail ?? 0)
        return acc
      }, { installs: 0, failures: 0 }))
  }
  return totals
}

/**
 * Stamps auto_pause_last_checked_at on every channel that did not trigger, in
 * one statement. Channels whose rollout changed since they were loaded are
 * left alone, like updateCurrentRolloutChannel. Returns the stamped ids.
 */
async function stampCheckedChannels(pg: PgClient, channels: RolloutAutoPauseChannel[], now: Date) {
  if (channels.length === 0)
    return new Set<number>()
  const result = await pg.query<{ id: number | string }>(
    `UPDATE public.channels ch
    SET auto_pause_last_checked_at = $1::timestamptz
    FROM ROWS FROM (pg_catalog.unnest($2::bigint[]), pg_catalog.unnest($3::bigint[])) AS checked(id, rollout_version)
    WHERE ch.id = checked.id
      AND ch.rollout_version = checked.rollout_version
      AND ch.rollout_enabled = true
      AND ch.rollout_percentage_bps > 0
      AND ch.rollout_paused_at IS NULL
    RETURNING ch.id`,
    [now.toISOString(), channels.map(channel => channel.id), channels.map(channel => channel.rollout_version)],
  )
  return new Set(result.rows.map(row => Number(row.id)))
}

/** Records a failed evaluation attempt, which only affects the order of later runs. */
async function recordFailedAttempts(pg: PgClient, channels: RolloutAutoPauseChannel[], now: Date) {
  if (channels.length === 0)
    return
  await pg.query(
    `INSERT INTO public.channel_auto_pause_attempts (channel_id, failed_at)
    SELECT failed.id, $1::timestamptz
    FROM pg_catalog.unnest($2::bigint[]) AS failed(id)
    ON CONFLICT (channel_id) DO UPDATE SET failed_at = EXCLUDED.failed_at`,
    [now.toISOString(), channels.map(channel => channel.id)],
  )
}

async function triggerChannel(c: Context, pg: PgClient, { channel, versionName, result }: ChannelEvaluation, now: Date) {
  const reason = buildReason(channel, versionName, result)
  const basePatch = {
    auto_pause_last_checked_at: now.toISOString(),
    auto_pause_last_triggered_at: now.toISOString(),
    rollout_pause_reason: reason,
  } as any

  if (result.action === 'pause') {
    const updated = await updateCurrentRolloutChannel(pg, channel, {
      ...basePatch,
      rollout_paused_at: now.toISOString(),
    })
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
  }
  else if (result.action === 'rollback') {
    const updated = await updateCurrentRolloutChannel(pg, channel, {
      ...basePatch,
      rollout_enabled: false,
      rollout_percentage_bps: 0,
      rollout_version: null,
      rollout_paused_at: null,
    })
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
  }
  else {
    const updated = await updateCurrentRolloutChannel(pg, channel, basePatch)
    if (!updated)
      return { skipped: true, reason: 'stale_rollout_state' }
    await sendEventToTracking(c, {
      channel: 'rollout-auto-pause',
      event: 'Rollout Auto-Pause Notification',
      user_id: channel.owner_org,
      groups: { organization: channel.owner_org },
      tags: {
        app_id: channel.app_id,
        channel_id: channel.id,
        channel_name: channel.name,
        rollout_version: versionName,
      },
      description: reason,
    }, { background: false })
  }

  cloudlog({ requestId: c.get('requestId'), message: 'rollout auto-pause triggered', appId: channel.app_id, channelId: channel.id, action: result.action, reason })
  return { triggered: true, reason, result }
}

interface ChunkOutcome {
  checked: number
  triggered: number
}

/** Evaluates up to AUTO_PAUSE_CHANNELS_PER_QUERY channels of one app with one pair of Analytics Engine queries. */
async function evaluateChannelChunk(c: Context, pg: PgClient, channels: RolloutAutoPauseChannel[], now: Date): Promise<ChunkOutcome> {
  const candidates: Array<{ channel: RolloutAutoPauseChannel, versionName: string }> = []
  for (const channel of channels) {
    const versionName = getRolloutVersionName(channel)
    if (versionName)
      candidates.push({ channel, versionName })
  }
  // Channels without a version name were counted as checked and never stamped.
  const outcome: ChunkOutcome = { checked: channels.length - candidates.length, triggered: 0 }
  if (candidates.length === 0)
    return outcome

  const windows = candidates.map(({ channel, versionName }) => ({
    appId: channel.app_id,
    channel: { id: channel.id, name: channel.name },
    versionName,
    start: getWindowStart(channel.auto_pause_window_minutes, now),
  }))
  const totals = await readChannelTotals(c, windows, now)
  if (!totals) {
    // The stats read failed or timed out: do not evaluate these channels and
    // keep auto_pause_last_checked_at (no check happened). Record the attempt
    // so the next runs try other apps first.
    cloudlog({ requestId: c.get('requestId'), message: 'Rollout auto-pause deferred channels after a stats read failure', channelIds: channels.map(channel => channel.id) })
    try {
      await recordFailedAttempts(pg, channels, now)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Rollout auto-pause failed attempt record failed', channelIds: channels.map(channel => channel.id), error })
    }
    return { checked: 0, triggered: 0 }
  }

  const untriggered: RolloutAutoPauseChannel[] = []
  const toTrigger: ChannelEvaluation[] = []
  candidates.forEach(({ channel, versionName }, index) => {
    const result = evaluatePolicy(channel, totals[index]!, now)
    if (result.shouldTrigger)
      toTrigger.push({ channel, versionName, result })
    else
      untriggered.push(channel)
  })

  try {
    const stamped = await stampCheckedChannels(pg, untriggered, now)
    outcome.checked += untriggered.length
    const stale = untriggered.filter(channel => !stamped.has(Number(channel.id)))
    if (stale.length > 0)
      cloudlog({ requestId: c.get('requestId'), message: 'Rollout auto-pause skipped stale channels', channelIds: stale.map(channel => channel.id) })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Rollout auto-pause check stamp failed', channelIds: untriggered.map(channel => channel.id), error })
  }

  for (const evaluation of toTrigger) {
    try {
      const triggered = await triggerChannel(c, pg, evaluation, now)
      outcome.checked += 1
      if ('triggered' in triggered && triggered.triggered)
        outcome.triggered += 1
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Rollout auto-pause channel evaluation failed', channelId: evaluation.channel.id, appId: evaluation.channel.app_id, error })
    }
  }
  return outcome
}

/**
 * Chunks of at most `size` channels of one app, in first-seen order. One app
 * per Analytics Engine query keeps each app at the sample rate it gets alone.
 */
function chunkChannels(channels: RolloutAutoPauseChannel[], size: number) {
  const byApp = new Map<string, RolloutAutoPauseChannel[]>()
  for (const channel of channels) {
    const appChannels = byApp.get(channel.app_id) ?? []
    appChannels.push(channel)
    byApp.set(channel.app_id, appChannels)
  }
  const chunks: RolloutAutoPauseChannel[][] = []
  for (const appChannels of byApp.values()) {
    for (let index = 0; index < appChannels.length; index += size)
      chunks.push(appChannels.slice(index, index + size))
  }
  return chunks
}

interface RunOptions {
  chunkSize?: number
  concurrency?: number
  timeBudgetMs?: number
  clock?: () => number
}

/**
 * Evaluates chunks with bounded concurrency and stops starting new chunks once
 * the time budget is spent. Unstarted channels keep their old
 * auto_pause_last_checked_at, so the next run takes them first.
 */
async function evaluateChannels(c: Context, pg: PgClient, channels: RolloutAutoPauseChannel[], now: Date, options: RunOptions = {}) {
  const clock = options.clock ?? Date.now
  const startedAt = clock()
  const chunks = chunkChannels(channels, options.chunkSize ?? AUTO_PAUSE_CHANNELS_PER_QUERY)
  const timeBudgetMs = options.timeBudgetMs ?? AUTO_PAUSE_TIME_BUDGET_MS
  const totals = { checked: 0, triggered: 0, deferred: 0 }
  let cursor = 0

  async function worker() {
    while (cursor < chunks.length) {
      if (clock() - startedAt >= timeBudgetMs)
        return
      const chunk = chunks[cursor++]!
      try {
        const outcome = await evaluateChannelChunk(c, pg, chunk, now)
        totals.checked += outcome.checked
        totals.triggered += outcome.triggered
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Rollout auto-pause chunk evaluation failed', channelIds: chunk.map(channel => channel.id), error })
      }
    }
  }

  const workerCount = Math.min(Math.max(1, options.concurrency ?? AUTO_PAUSE_QUERY_CONCURRENCY), chunks.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  totals.deferred = chunks.slice(cursor).reduce((count, chunk) => count + chunk.length, 0)
  return totals
}

async function loadAutoPauseChannels(pg: Parameters<typeof queryJson>[0], limit = AUTO_PAUSE_MAX_CHANNELS_PER_RUN) {
  try {
    const rows = await queryJson<RolloutAutoPauseChannel>(
      pg,
      `SELECT
        ch.id,
        ch.name,
        ch.app_id,
        ch.owner_org,
        ch.rollout_version,
        ch.auto_pause_enabled,
        ch.auto_pause_window_minutes,
        ch.auto_pause_failure_rate_bps,
        ch.auto_pause_confidence,
        ch.auto_pause_min_attempts,
        ch.auto_pause_min_failures,
        ch.auto_pause_action,
        ch.auto_pause_cooldown_minutes,
        ch.auto_pause_last_checked_at,
        ch.auto_pause_last_triggered_at,
        ch.rollout_paused_at,
        (SELECT json_build_object('name', av.name) FROM public.app_versions av WHERE av.id = ch.rollout_version) AS rollout_version_info
      FROM public.channels ch
      LEFT JOIN public.channel_auto_pause_attempts attempt ON attempt.channel_id = ch.id
      WHERE ch.rollout_enabled = true
        AND ch.auto_pause_enabled = true
        AND ch.rollout_percentage_bps > 0
        AND ch.rollout_version IS NOT NULL
        AND ch.rollout_paused_at IS NULL
      -- Oldest of the last check and the last failed attempt first: never
      -- tried first, and apps whose reads keep failing move to the back.
      ORDER BY GREATEST(ch.auto_pause_last_checked_at, attempt.failed_at) ASC NULLS FIRST, ch.id ASC
      LIMIT $1`,
      [limit],
    )
    return { data: rows, error: null }
  }
  catch (error) {
    return { data: null, error }
  }
}

app.post('/', middlewareAPISecret, async (c) => {
  const pg = await getPgClient(c)
  try {
    const now = new Date()

    const { data, error } = await loadAutoPauseChannels(pg)

    if (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Cannot load rollout auto-pause channels', error })
      throw error
    }

    const channels = data ?? []
    const { checked, triggered, deferred } = await evaluateChannels(c, pg, channels, now)
    if (deferred > 0 || channels.length >= AUTO_PAUSE_MAX_CHANNELS_PER_RUN)
      cloudlog({ requestId: c.get('requestId'), message: 'Rollout auto-pause left channels for the next run', loaded: channels.length, deferred })

    return c.json({ ...BRES, checked, triggered, deferred })
  }
  finally {
    closeClient(c, pg)
  }
})

export const __rolloutAutoPauseTestUtils__ = {
  buildReason,
  evaluateChannels,
  getRolloutVersionName,
  getWindowStart,
  loadAutoPauseChannels,
}

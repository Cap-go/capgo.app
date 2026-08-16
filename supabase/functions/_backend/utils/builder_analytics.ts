import type { Context } from 'hono'
import { cloudlog } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { isPosthogReadConfigured, queryPosthogHogql } from './posthog_read.ts'

// Builder analytics for the admin dashboard. Live (no cache):
//  - Onboarding funnel / AI usage / per-org journeys come from PostHog (HogQL).
//  - Build outcomes / failures / durations come from Postgres (build_requests).
// PostHog is read via a personal API key in POSTHOG_READ_KEY; if unset, the PostHog-derived
// sections come back empty and the Postgres build sections still populate. The response
// carries posthog_configured / posthog_connected so the UI can distinguish "no data" from
// "PostHog unavailable".
//
// Build counts/status/daily/per-org are aggregated inside Postgres (COUNT / GROUP BY) so they
// are exact for any volume — there is no in-memory row cap that could silently under-count.
// Only the failed-build sample used for error fingerprinting is row-limited, and that fetch is
// ordered newest-first so the "new errors" detection keeps the most recent failures.

// ----------------------------------------------------------------- onboarding model

interface Milestone { key: string, label: string, steps: string[] }

const MILESTONES: Milestone[] = [
  { key: 'start', label: 'Started', steps: ['welcome', 'resume-prompt'] },
  { key: 'method', label: 'Setup method chosen', steps: ['setup-method-select', 'p8-method-select', 'keystore-method-select', 'service-account-method-select', 'android-package-select'] },
  { key: 'credentials', label: 'Credentials provided', steps: ['input-issuer-id', 'input-key-id', 'api-key-instructions', 'verifying-key', 'credentials-exist', 'saving-credentials', 'creating-certificate', 'creating-profile', 'import-scanning', 'detecting-ci-secrets', 'backing-up'] },
  { key: 'build-requested', label: 'Build requested', steps: ['ask-build', 'requesting-build'] },
  { key: 'build-complete', label: 'Build complete', steps: ['build-complete'] },
]
const TERMINAL_STEP = 'build-complete'
const AI_STEPS = new Set(['ai-analysis-prompt', 'ai-analysis-result', 'ai-analysis-running', 'ai-analysis-result-scroll'])
// Restart markers for synthetic (no journey_id) sessionization. Deliberately excludes
// 'setup-method-select' (it is a milestone-1 step; treating it as a restart marker would
// score a freshly-split session as milestone 1 without it ever reaching credentials).
const FIRST_STEPS = new Set(['welcome', 'resume-prompt'])
const GAP_MS = 30 * 60 * 1000
const ONBOARDING_EVENT_LIMIT = 200_000
const ERROR_SAMPLE_LIMIT = 50_000
const NEW_ERROR_MS = 3 * 24 * 60 * 60 * 1000

const STEP_TO_MILESTONE = new Map<string, number>()
MILESTONES.forEach((m, i) => m.steps.forEach(s => STEP_TO_MILESTONE.set(s, i)))

interface OnbEvent { ts: number, appId: string, orgId: string, platform: string, step: string, journeyId: string, errorCategory: string }
interface Journey { appId: string, orgId: string, platform: string, startedAt: number, endedAt: number, steps: string[], milestone: number, completed: boolean, lastStep: string, usedAi: boolean, errorCategories: string[] }

function sessionize(events: OnbEvent[]): Journey[] {
  const byKey = new Map<string, OnbEvent[]>()
  for (const e of events) {
    // Events with neither a journey_id nor an app_id cannot be attributed; skip them so
    // they do not all collapse into a single bogus "a:" journey.
    if (!e.journeyId && !e.appId)
      continue
    const key = e.journeyId ? `j:${e.journeyId}` : `a:${e.appId}`
    if (!byKey.has(key))
      byKey.set(key, [])
    byKey.get(key)!.push(e)
  }
  const out: Journey[] = []
  for (const [key, evs] of byKey) {
    evs.sort((a, b) => a.ts - b.ts)
    const synthetic = key.startsWith('a:')
    let bucket: OnbEvent[] = []
    let prevTs = 0
    let advanced = false
    const flush = () => {
      if (bucket.length)
        out.push(buildJourney(bucket))
      bucket = []
    }
    for (const e of evs) {
      const isFirst = e.step && FIRST_STEPS.has(e.step)
      const gap = prevTs && e.ts - prevTs > GAP_MS
      if (synthetic && bucket.length && (gap || (isFirst && advanced))) {
        flush()
        advanced = false
      }
      bucket.push(e)
      if (e.step && !FIRST_STEPS.has(e.step))
        advanced = true
      prevTs = e.ts
    }
    flush()
  }
  return out
}

function buildJourney(evs: OnbEvent[]): Journey {
  const first = evs[0]
  const steps = [...new Set(evs.map(e => e.step).filter(Boolean))]
  let milestone = -1
  for (const s of steps) {
    const idx = STEP_TO_MILESTONE.get(s)
    if (idx !== undefined && idx > milestone)
      milestone = idx
  }
  const stepEvents = evs.filter(e => e.step)
  // Error categories scoped to this journey, so the onboarding-error rollup is computed over
  // the same retained-journey population as every other onboarding metric.
  const errorCategories = evs.map(e => e.errorCategory).filter(Boolean)
  return {
    appId: first.appId,
    orgId: first.orgId,
    platform: first.platform || 'unknown',
    startedAt: first.ts,
    endedAt: evs.at(-1)!.ts,
    steps,
    milestone,
    completed: steps.includes(TERMINAL_STEP),
    lastStep: stepEvents.at(-1)?.step || first.step || '',
    usedAi: steps.some(s => AI_STEPS.has(s)),
    errorCategories,
  }
}

// ----------------------------------------------------------------- PostHog (HogQL)

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, '\'\'')}'`
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

interface OnboardingLoad { ok: boolean, events: OnbEvent[] }

async function loadOnboardingEvents(c: Context, start: string, end: string): Promise<OnboardingLoad> {
  // 'Builder Onboarding Quit' beacons carry the abandon point in `last_step`; fold that into the
  // generic `step` column so quit journeys are attributed to where the user actually gave up.
  const q = `
    SELECT
      toUnixTimestamp(timestamp) AS ts,
      properties.app_id AS app_id,
      properties.org_id AS org_id,
      properties.platform AS platform,
      if(event = 'Builder Onboarding Quit',
        JSONExtractString(toString(properties), 'last_step'),
        JSONExtractString(toString(properties), 'step')) AS step,
      JSONExtractString(toString(properties), 'journey_id') AS journey_id,
      properties.error_category AS error_category
    FROM events
    WHERE event IN ('Builder Onboarding Step', 'Builder Onboarding Action', 'Builder Onboarding Quit')
      AND timestamp >= parseDateTimeBestEffort(${sqlStr(start)})
      AND timestamp <= parseDateTimeBestEffort(${sqlStr(end)})
    ORDER BY timestamp DESC
    LIMIT ${ONBOARDING_EVENT_LIMIT}`
  const { connected, failureReason, rows } = await queryPosthogHogql(c, q)
  if (rows.length >= ONBOARDING_EVENT_LIMIT)
    cloudlog({ requestId: c.get('requestId'), message: 'builder_analytics onboarding events truncated', limit: ONBOARDING_EVENT_LIMIT })
  const events = rows
    .map(r => ({
      ts: num(r.ts) * 1000,
      appId: str(r.app_id),
      orgId: str(r.org_id),
      platform: str(r.platform),
      step: str(r.step),
      journeyId: str(r.journey_id),
      errorCategory: str(r.error_category),
    }))
    .filter(e => e.appId || e.journeyId)
  return { ok: connected && failureReason === null, events }
}

async function loadAiChoiceCount(c: Context, start: string, end: string): Promise<number> {
  const q = `
    SELECT count(DISTINCT properties.org_id) AS orgs
    FROM events
    WHERE event = 'CLI AI Build Analysis Choice'
      AND JSONExtractString(toString(properties), 'choice') IN ('capgo_ai', 'local_ai')
      AND timestamp >= parseDateTimeBestEffort(${sqlStr(start)})
      AND timestamp <= parseDateTimeBestEffort(${sqlStr(end)})`
  const { rows } = await queryPosthogHogql(c, q)
  return rows.length ? num(rows[0].orgs) : 0
}

// ----------------------------------------------------------------- error fingerprint

function fingerprint(raw: string): { fp: string, title: string } {
  const firstLine = (raw || '').split('\n')[0].trim()
  const norm = firstLine.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\/[^\s'"]+/g, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = (h * 33) ^ (norm.codePointAt(i) ?? 0)
  return { fp: (h >>> 0).toString(16), title: firstLine.slice(0, 140) }
}

// ----------------------------------------------------------------- main

const DAY = 86_400_000

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

interface StatusDayRow { status: string, day: string, n: number }
interface OrgBuildRow { ownerOrg: string, builds: number, succeeded: number, failed: number, lastMs: number }
interface FailedErrorRow { lastError: string, createdMs: number }

export async function getAdminBuilderAnalytics(c: Context, startDate: string, endDate: string) {
  const nowMs = Date.now()
  const startMs = Date.parse(startDate)
  const endMs = Date.parse(endDate)
  const posthogConfigured = isPosthogReadConfigured(c)

  // --- PostHog onboarding (parallel, each bounded by a fetch timeout) ---
  const [onboarding, aiOrgs] = await Promise.all([
    loadOnboardingEvents(c, startDate, endDate),
    loadAiChoiceCount(c, startDate, endDate),
  ])
  const events = onboarding.events
  // Keep only journeys that reached a recognized milestone, so the KPI count, the funnel
  // top, the orgs rollup and the quit metrics are all computed over the same population.
  const journeys = sessionize(events).filter(j => j.milestone >= 0 && j.startedAt >= startMs)

  const starts = journeys.length
  const completions = journeys.filter(j => j.completed).length

  // Funnel (furthest milestone reached). reached[0] === starts by construction above.
  const reached = MILESTONES.map(() => 0)
  for (const j of journeys) {
    for (let i = 0; i <= j.milestone; i++) reached[i]++
  }
  const funnel = MILESTONES.map((m, i) => {
    const prev = i === 0 ? reached[0] : reached[i - 1]
    return {
      key: m.key,
      label: m.label,
      reached: reached[i],
      drop_pct: prev > 0 ? ((prev - reached[i]) / prev) * 100 : 0,
      of_start_pct: reached[0] > 0 ? (reached[i] / reached[0]) * 100 : 0,
    }
  })

  // Quit-by-last-step (abandoned journeys).
  const quitMap = new Map<string, number>()
  for (const j of journeys) {
    if (!j.completed)
      quitMap.set(j.lastStep || '(unknown)', (quitMap.get(j.lastStep || '(unknown)') || 0) + 1)
  }
  const quit_steps = [...quitMap.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 15)

  // Onboarding error categories — computed from retained journeys (not raw events) so the
  // counts line up with the funnel / KPI / org population.
  const onbErrMap = new Map<string, number>()
  for (const j of journeys) {
    for (const cat of j.errorCategories)
      onbErrMap.set(cat, (onbErrMap.get(cat) || 0) + 1)
  }
  const onboarding_error_categories = [...onbErrMap.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)

  // --- Postgres builds (aggregated in-database; exact for any volume) ---
  const pgClient = getPgClient(c, true)
  try {
    const [statusDayRes, orgBuildRes, failedRes] = await Promise.all([
      pgClient.query(
        `SELECT status,
           to_char((created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           count(*)::bigint AS n
         FROM build_requests
         WHERE created_at >= $1 AND created_at <= $2
         GROUP BY status, day`,
        [startDate, endDate],
      ),
      pgClient.query(
        `SELECT owner_org::text AS owner_org,
           count(*)::bigint AS builds,
           count(*) FILTER (WHERE status = 'succeeded')::bigint AS succeeded,
           count(*) FILTER (WHERE status = 'failed')::bigint AS failed,
           (max(extract(epoch from created_at)) * 1000)::bigint AS last_ms
         FROM build_requests
         WHERE created_at >= $1 AND created_at <= $2 AND owner_org IS NOT NULL
         GROUP BY owner_org`,
        [startDate, endDate],
      ),
      // Only failed builds with a message, newest-first, so error fingerprints (and the
      // "new in last 3 days" detection) keep the most recent failures even if capped.
      pgClient.query(
        `SELECT last_error, (extract(epoch from created_at) * 1000)::bigint AS created_ms
         FROM build_requests
         WHERE created_at >= $1 AND created_at <= $2 AND status = 'failed' AND last_error IS NOT NULL
         ORDER BY created_at DESC LIMIT ${ERROR_SAMPLE_LIMIT}`,
        [startDate, endDate],
      ),
    ])

    const statusDayRows: StatusDayRow[] = (statusDayRes.rows as Record<string, unknown>[]).map(r => ({
      status: str(r.status),
      day: str(r.day),
      n: num(r.n),
    }))
    const orgBuildRows: OrgBuildRow[] = (orgBuildRes.rows as Record<string, unknown>[]).map(r => ({
      ownerOrg: str(r.owner_org),
      builds: num(r.builds),
      succeeded: num(r.succeeded),
      failed: num(r.failed),
      lastMs: num(r.last_ms),
    }))
    const failedRows: FailedErrorRow[] = (failedRes.rows as Record<string, unknown>[]).map(r => ({
      lastError: String(r.last_error),
      createdMs: num(r.created_ms),
    }))
    const errorsTruncated = failedRows.length >= ERROR_SAMPLE_LIMIT
    if (errorsTruncated)
      cloudlog({ requestId: c.get('requestId'), message: 'builder_analytics error sample truncated', limit: ERROR_SAMPLE_LIMIT })

    // Build outcome totals.
    const buildsTotal = statusDayRows.reduce((sum, r) => sum + r.n, 0)
    const ok = statusDayRows.filter(r => r.status === 'succeeded').reduce((sum, r) => sum + r.n, 0)
    const failed = statusDayRows.filter(r => r.status === 'failed').reduce((sum, r) => sum + r.n, 0)
    const STATUSES = ['succeeded', 'failed', 'expired', 'cancelled', 'starting']
    const status_breakdown = STATUSES.map(s => ({
      key: s,
      count: statusDayRows.filter(r => r.status === s).reduce((sum, r) => sum + r.n, 0),
    }))

    // Daily outcomes — bounded by the selected endDate (never past it), so historical
    // ranges are not padded with empty days up to today.
    const lastMs = Math.min(endMs, nowMs)
    const dayMap = new Map<string, { succeeded: number, failed: number }>()
    for (let t = startMs; t <= lastMs; t += DAY) dayMap.set(dayKey(t), { succeeded: 0, failed: 0 })
    for (const r of statusDayRows) {
      const d = dayMap.get(r.day)
      if (!d)
        continue
      if (r.status === 'succeeded')
        d.succeeded += r.n
      else if (r.status === 'failed')
        d.failed += r.n
    }
    const builds_daily = [...dayMap.entries()].map(([date, v]) => ({ date, succeeded: v.succeeded, failed: v.failed }))

    // Failure groups + "new in last 3 days". Novelty is window-relative (no historical
    // baseline is stored); it is only meaningful when the window extends at least a day past
    // the 3-day cutoff, otherwise every error in the window is trivially "new" — so guard.
    const noveltyMeaningful = startMs <= nowMs - NEW_ERROR_MS - DAY
    const groups = new Map<string, { fp: string, title: string, count: number, firstMs: number }>()
    for (const r of failedRows) {
      const { fp, title } = fingerprint(r.lastError)
      const g = groups.get(fp)
      if (g) {
        g.count++
        g.firstMs = Math.min(g.firstMs, r.createdMs)
      }
      else {
        groups.set(fp, { fp, title, count: 1, firstMs: r.createdMs })
      }
    }
    const allGroups = [...groups.values()].map(g => ({
      fingerprint: g.fp,
      title: g.title,
      count: g.count,
      is_new: noveltyMeaningful && g.firstMs >= nowMs - NEW_ERROR_MS,
    }))
    // new_count is over ALL groups, not just the displayed top-40, so a rare brand-new error
    // ranked outside the top-40 still raises the alert.
    const newCount = allGroups.filter(g => g.is_new).length
    const error_groups = allGroups.toSorted((a, b) => b.count - a.count).slice(0, 40)

    // Org names for the orgs that onboarded or built.
    const orgIds = [...new Set([...journeys.map(j => j.orgId), ...orgBuildRows.map(r => r.ownerOrg)].filter(Boolean))]
    const names: Record<string, string> = {}
    if (orgIds.length) {
      const nameRes = await pgClient.query('SELECT id::text AS id, name FROM orgs WHERE id::text = ANY($1::text[])', [orgIds])
      for (const r of nameRes.rows as Record<string, unknown>[]) names[str(r.id)] = str(r.name) || str(r.id)
    }

    // Per-org rollup — seeded from journeys AND builds, so build-only orgs are not dropped.
    interface OrgAgg { attempts: number, completed: number, usedAi: boolean, builds: number, buildsSucceeded: number, buildsFailed: number, lastSeen: number }
    const orgAgg = new Map<string, OrgAgg>()
    const ensureOrg = (id: string): OrgAgg => {
      let a = orgAgg.get(id)
      if (!a) {
        a = { attempts: 0, completed: 0, usedAi: false, builds: 0, buildsSucceeded: 0, buildsFailed: 0, lastSeen: 0 }
        orgAgg.set(id, a)
      }
      return a
    }
    for (const j of journeys) {
      const a = ensureOrg(j.orgId || `app:${j.appId}`)
      a.attempts++
      if (j.completed)
        a.completed++
      if (j.usedAi)
        a.usedAi = true
      a.lastSeen = Math.max(a.lastSeen, j.endedAt)
    }
    for (const r of orgBuildRows) {
      const a = ensureOrg(r.ownerOrg)
      a.builds += r.builds
      a.buildsSucceeded += r.succeeded
      a.buildsFailed += r.failed
      a.lastSeen = Math.max(a.lastSeen, r.lastMs)
    }
    const orgs = [...orgAgg.entries()].map(([id, a]) => ({
      org_id: id,
      org_name: names[id] || (id.startsWith('app:') ? id.slice(4) : id),
      attempts: a.attempts,
      completed: a.completed,
      succeeded: a.completed > 0 || a.buildsSucceeded > 0,
      used_ai: a.usedAi,
      builds: a.builds,
      builds_succeeded: a.buildsSucceeded,
      builds_failed: a.buildsFailed,
      last_seen: a.lastSeen,
    })).sort((x, y) => y.last_seen - x.last_seen).slice(0, 200)

    // Individual onboarding journeys (most recent first) — the "who gave up and where" list.
    const journey_list = journeys
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 300)
      .map(j => ({
        org_id: j.orgId || `app:${j.appId}`,
        org_name: names[j.orgId] || j.orgId || j.appId,
        app_id: j.appId,
        platform: j.platform,
        outcome: j.completed ? 'completed' : 'quit',
        milestone: j.milestone,
        milestone_label: MILESTONES[j.milestone]?.label ?? '',
        last_step: j.lastStep,
        used_ai: j.usedAi,
        started_at: j.startedAt,
        ended_at: j.endedAt,
        duration_ms: Math.max(0, j.endedAt - j.startedAt),
        steps: j.steps,
      }))

    cloudlog({ requestId: c.get('requestId'), message: 'builder_analytics computed', journeys: starts, builds: buildsTotal })

    return {
      kpis: {
        onboarding_starts: starts,
        completions,
        completion_rate: starts > 0 ? (completions / starts) * 100 : 0,
        builds_total: buildsTotal,
        builds_succeeded: ok,
        builds_failed: failed,
        build_success_rate: buildsTotal > 0 ? (ok / buildsTotal) * 100 : 0,
        ai_orgs: aiOrgs,
        journeys_used_ai: journeys.filter(j => j.usedAi).length,
      },
      funnel,
      quit_steps,
      builds_daily,
      status_breakdown,
      errors: {
        failed_builds: failed,
        groups: error_groups,
        new_count: newCount,
        novelty_meaningful: noveltyMeaningful,
        truncated: errorsTruncated,
        onboarding_error_categories,
      },
      orgs,
      journeys: journey_list,
      posthog_configured: posthogConfigured,
      // Connected = configured AND the onboarding query actually completed a round-trip.
      // Distinguishes "PostHog unreachable" from "PostHog returned zero events".
      posthog_connected: posthogConfigured && onboarding.ok,
    }
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
}

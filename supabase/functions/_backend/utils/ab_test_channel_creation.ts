import type { Context } from 'hono'
import type { PosthogReadFailureReason, PosthogReadResult } from './posthog_read.ts'
import { AB_TESTS_CONFIG } from './ab_tests.ts'
import { buildFrontendOnboardingProductionHostHogql } from './frontend_onboarding_analytics_model.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryPosthogHogql } from './posthog_read.ts'

export const ADMIN_CHANNEL_ANIMATION_STAGES = [
  'channel-routing',
  'channel-self-assign',
  'channel-console-assign',
] as const

export const ADMIN_CHANNEL_ANIMATION_COHORTS = [
  'automatic',
  'replay',
  'reduced_motion',
  'unavailable',
] as const

export type AdminChannelAnimationStageName = typeof ADMIN_CHANNEL_ANIMATION_STAGES[number]
export type AdminChannelAnimationCohortName = typeof ADMIN_CHANNEL_ANIMATION_COHORTS[number]
export type AdminChannelExperimentStatus = 'collecting' | 'treatment_ahead' | 'control_ahead' | 'inconclusive'

export const ADMIN_CHANNEL_OUTCOME_WINDOW_HOURS = 24
export const ADMIN_CHANNEL_MIN_BRANCH_SAMPLE = 100

const NEW_CHANNEL_ANALYTICS_VERSION = '5.E'
const NEW_CHANNEL_ANALYTICS_STARTED_AT = '2026-09-14 00:00:00'
const NEW_CHANNEL_TEST = 'new_channel'
const FIRST_RUN_TERMINAL_EVENTS = [
  'onboarding_channel_animation_completed',
  'onboarding_channel_animation_interrupted',
  'onboarding_channel_animation_skipped',
] as const

export interface AdminChannelExperimentOutcomeRow {
  assigned: number | string
  branch: string | null
  cohort_started_at?: string | null
  converted: number | string
  eligible: number | string
  pending: number | string
}

export interface AdminChannelAnimationPosthogRow extends Record<string, unknown> {
  stage?: string
}

export interface AdminChannelExperimentBranch {
  assigned: number
  branch: string
  conversion_percentage: number | null
  converted: number
  eligible: number
  label: string
  pending: number
}

export interface AdminChannelAnimationCohort {
  cohort: AdminChannelAnimationCohortName
  completed: number | null
  completion_percentage: number | null
  continued: number
  continued_percentage: number | null
  median_watch_ms: number | null
  users: number
}

export type AdminChannelAnimationRetentionProgress = 0 | 25 | 50 | 75 | 100
export type AdminChannelAnimationSkipProgressStart = 0 | 25 | 50 | 75
export type AdminChannelAnimationSkipProgressEnd = 24 | 49 | 74 | 99

export interface AdminChannelAnimationRetentionPoint {
  progress_percentage: AdminChannelAnimationRetentionProgress
  viewers: number
}

export interface AdminChannelAnimationSkipProgressBucket {
  from_percentage: AdminChannelAnimationSkipProgressStart
  skipped: number
  to_percentage: AdminChannelAnimationSkipProgressEnd
}

export interface AdminChannelAnimationStage {
  completed: number
  completion_percentage: number | null
  continued: number
  continued_percentage: number | null
  cohorts: AdminChannelAnimationCohort[]
  interrupted: number
  median_skip_progress_percentage: number | null
  median_watch_ms: number | null
  reached: number
  replays: number
  retention: AdminChannelAnimationRetentionPoint[]
  skip_progress: AdminChannelAnimationSkipProgressBucket[]
  skipped: number
  stage: AdminChannelAnimationStageName
  started: number
}

export interface AdminABTestChannelCreation {
  data_quality: {
    posthog_configured: boolean
    posthog_connected: boolean
    posthog_failure_reason: PosthogReadFailureReason | null
  }
  experiment: {
    branches: AdminChannelExperimentBranch[]
    confidence_percentage: number | null
    confidence_interval_percentage_points: { high: number, low: number } | null
    difference_percentage_points: number | null
    minimum_branch_sample: number
    observation_window_hours: number
    relative_lift_percentage: number | null
    status: AdminChannelExperimentStatus
    total_assigned: number
  }
  generated_at: string
  stages: AdminChannelAnimationStage[]
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === 'number')
    return value
  if (typeof value === 'string' && value.trim() !== '')
    return Number(value)
  return Number.NaN
}

function readCount(value: unknown): number | null {
  const count = numberFromUnknown(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function readMeasurement(value: unknown): number | null {
  const measurement = numberFromUnknown(value)
  return Number.isFinite(measurement) && measurement >= 0 ? measurement : null
}

function percentage(numerator: number, denominator: number): number | null {
  if (denominator === 0)
    return null
  return Math.round((numerator / denominator) * 1_000) / 10
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1
  const x = Math.abs(value) / Math.sqrt(2)
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

function experimentStatus(low: number, high: number): Exclude<AdminChannelExperimentStatus, 'collecting'> {
  if (low > 0)
    return 'treatment_ahead'
  if (high < 0)
    return 'control_ahead'
  return 'inconclusive'
}

function experimentInference(treatment: AdminChannelExperimentBranch, control: AdminChannelExperimentBranch) {
  if (treatment.eligible < ADMIN_CHANNEL_MIN_BRANCH_SAMPLE || control.eligible < ADMIN_CHANNEL_MIN_BRANCH_SAMPLE) {
    return {
      confidencePercentage: null,
      interval: null,
      status: 'collecting' as const,
    }
  }

  const treatmentRate = treatment.converted / treatment.eligible
  const controlRate = control.converted / control.eligible
  const difference = treatmentRate - controlRate
  const intervalStandardError = Math.sqrt(
    (treatmentRate * (1 - treatmentRate)) / treatment.eligible
    + (controlRate * (1 - controlRate)) / control.eligible,
  )
  const pooledRate = (treatment.converted + control.converted) / (treatment.eligible + control.eligible)
  const testStandardError = Math.sqrt(
    pooledRate * (1 - pooledRate) * (1 / treatment.eligible + 1 / control.eligible),
  )
  const margin = 1.96 * intervalStandardError
  const low = difference - margin
  const high = difference + margin
  const pValue = testStandardError === 0
    ? 1
    : 2 * (1 - normalCdf(Math.abs(difference / testStandardError)))
  return {
    confidencePercentage: roundOne(Math.max(0, Math.min(1, 1 - pValue)) * 100),
    interval: { high: roundOne(high * 100), low: roundOne(low * 100) },
    status: experimentStatus(low, high),
  }
}

function emptyCohort(cohort: AdminChannelAnimationCohortName): AdminChannelAnimationCohort {
  return {
    cohort,
    completed: cohort === 'reduced_motion' || cohort === 'unavailable' ? null : 0,
    completion_percentage: null,
    continued: 0,
    continued_percentage: null,
    median_watch_ms: null,
    users: 0,
  }
}

function emptyStage(stage: AdminChannelAnimationStageName): AdminChannelAnimationStage {
  return {
    completed: 0,
    completion_percentage: null,
    continued: 0,
    continued_percentage: null,
    cohorts: ADMIN_CHANNEL_ANIMATION_COHORTS.map(emptyCohort),
    interrupted: 0,
    median_skip_progress_percentage: null,
    median_watch_ms: null,
    reached: 0,
    replays: 0,
    retention: [0, 25, 50, 75, 100].map(progress => ({
      progress_percentage: progress as 0 | 25 | 50 | 75 | 100,
      viewers: 0,
    })),
    skip_progress: [
      { from_percentage: 0, skipped: 0, to_percentage: 24 },
      { from_percentage: 25, skipped: 0, to_percentage: 49 },
      { from_percentage: 50, skipped: 0, to_percentage: 74 },
      { from_percentage: 75, skipped: 0, to_percentage: 99 },
    ],
    skipped: 0,
    stage,
    started: 0,
  }
}

function readCohort(
  row: AdminChannelAnimationPosthogRow,
  cohort: AdminChannelAnimationCohortName,
): AdminChannelAnimationCohort {
  const users = readCount(row[`${cohort}_users`]) ?? 0
  const completed = cohort === 'reduced_motion' || cohort === 'unavailable'
    ? null
    : Math.min(readCount(row[`${cohort}_completed`]) ?? 0, users)
  const continued = Math.min(readCount(row[`${cohort}_continued`]) ?? 0, users)
  return {
    cohort,
    completed,
    completion_percentage: completed === null ? null : percentage(completed, users),
    continued,
    continued_percentage: percentage(continued, users),
    median_watch_ms: cohort === 'reduced_motion' || cohort === 'unavailable'
      ? null
      : readMeasurement(row[`${cohort}_median_watch_ms`]),
    users,
  }
}

function readStage(row: AdminChannelAnimationPosthogRow, stage: AdminChannelAnimationStageName): AdminChannelAnimationStage {
  const reached = readCount(row.reached) ?? 0
  const started = Math.min(readCount(row.started) ?? 0, reached)
  const completed = Math.min(readCount(row.completed) ?? 0, started)
  const skipped = Math.min(readCount(row.skipped) ?? 0, started)
  const interrupted = Math.min(readCount(row.interrupted) ?? 0, started)
  const continued = Math.min(readCount(row.continued) ?? 0, reached)
  const retention = [
    started,
    Math.min(readCount(row.retention_25) ?? 0, started),
    Math.min(readCount(row.retention_50) ?? 0, started),
    Math.min(readCount(row.retention_75) ?? 0, started),
    completed,
  ]
  for (let index = 1; index < retention.length; index++)
    retention[index] = Math.min(retention[index], retention[index - 1])

  return {
    completed,
    completion_percentage: percentage(completed, started),
    continued,
    continued_percentage: percentage(continued, reached),
    cohorts: ADMIN_CHANNEL_ANIMATION_COHORTS.map(cohort => readCohort(row, cohort)),
    interrupted,
    median_skip_progress_percentage: readMeasurement(row.median_skip_progress_percentage),
    median_watch_ms: readMeasurement(row.median_watch_ms),
    reached,
    replays: readCount(row.replays) ?? 0,
    retention: retention.map((viewers, index) => ({
      progress_percentage: [0, 25, 50, 75, 100][index] as 0 | 25 | 50 | 75 | 100,
      viewers,
    })),
    skip_progress: [
      { from_percentage: 0, skipped: readCount(row.skipped_0_24) ?? 0, to_percentage: 24 },
      { from_percentage: 25, skipped: readCount(row.skipped_25_49) ?? 0, to_percentage: 49 },
      { from_percentage: 50, skipped: readCount(row.skipped_50_74) ?? 0, to_percentage: 74 },
      { from_percentage: 75, skipped: readCount(row.skipped_75_99) ?? 0, to_percentage: 99 },
    ],
    skipped,
    stage,
    started,
  }
}

export function buildAdminABTestChannelCreation(
  outcomeRows: AdminChannelExperimentOutcomeRow[],
  posthog: Pick<PosthogReadResult, 'configured' | 'connected' | 'failureReason' | 'rows'>,
  generatedAt = new Date().toISOString(),
): AdminABTestChannelCreation {
  const config = AB_TESTS_CONFIG[NEW_CHANNEL_TEST]
  if (!config)
    throw new Error('Missing new channel A/B test configuration')

  const outcomeByBranch = new Map<string, AdminChannelExperimentOutcomeRow>()
  for (const row of outcomeRows) {
    if (!row.branch || !config.branches[row.branch])
      continue
    const assigned = readCount(row.assigned)
    const eligible = readCount(row.eligible)
    const converted = readCount(row.converted)
    const pending = readCount(row.pending)
    if (assigned === null || eligible === null || converted === null || pending === null
      || eligible > assigned || converted > eligible || pending > assigned || eligible + pending > assigned) {
      continue
    }
    outcomeByBranch.set(row.branch, row)
  }

  const branches = [config.treatment_branch, config.control_branch].map((branch) => {
    const row = outcomeByBranch.get(branch)
    const assigned = readCount(row?.assigned) ?? 0
    const eligible = readCount(row?.eligible) ?? 0
    const converted = readCount(row?.converted) ?? 0
    const pending = readCount(row?.pending) ?? 0
    return {
      assigned,
      branch,
      conversion_percentage: percentage(converted, eligible),
      converted,
      eligible,
      label: config.branches[branch].label,
      pending,
    }
  })
  const [treatment, control] = branches
  const treatmentRate = treatment.eligible > 0 ? treatment.converted / treatment.eligible : null
  const controlRate = control.eligible > 0 ? control.converted / control.eligible : null
  const difference = treatmentRate === null || controlRate === null ? null : treatmentRate - controlRate
  const inference = experimentInference(treatment, control)

  const posthogByStage = new Map<AdminChannelAnimationStageName, AdminChannelAnimationPosthogRow>()
  for (const row of posthog.rows) {
    if (typeof row.stage !== 'string' || !(ADMIN_CHANNEL_ANIMATION_STAGES as readonly string[]).includes(row.stage))
      continue
    posthogByStage.set(row.stage as AdminChannelAnimationStageName, row)
  }

  return {
    data_quality: {
      posthog_configured: posthog.configured,
      posthog_connected: posthog.connected,
      posthog_failure_reason: posthog.failureReason,
    },
    experiment: {
      branches,
      confidence_percentage: inference.confidencePercentage,
      confidence_interval_percentage_points: inference.interval,
      difference_percentage_points: difference === null ? null : roundOne(difference * 100),
      minimum_branch_sample: ADMIN_CHANNEL_MIN_BRANCH_SAMPLE,
      observation_window_hours: ADMIN_CHANNEL_OUTCOME_WINDOW_HOURS,
      relative_lift_percentage: difference === null || controlRate === null || controlRate === 0
        ? null
        : roundOne((difference / controlRate) * 100),
      status: inference.status,
      total_assigned: branches.reduce((sum, branch) => sum + branch.assigned, 0),
    },
    generated_at: generatedAt,
    stages: ADMIN_CHANNEL_ANIMATION_STAGES.map((stage) => {
      const row = posthogByStage.get(stage)
      return row ? readStage(row, stage) : emptyStage(stage)
    }),
  }
}

export function buildAdminChannelAnimationHogql(): string {
  const eventAllowlist = [
    'onboarding_channel_animation_completed',
    'onboarding_channel_animation_interrupted',
    'onboarding_channel_animation_replayed',
    'onboarding_channel_animation_skipped',
    'onboarding_channel_animation_started',
    'onboarding_channel_animation_unavailable',
    'onboarding_channel_reduced_motion_shown',
    'onboarding_channel_stage_continued',
    'onboarding_channel_stage_viewed',
  ].map(sqlString).join(', ')
  const stageAllowlist = ADMIN_CHANNEL_ANIMATION_STAGES.map(sqlString).join(', ')
  const terminalAllowlist = FIRST_RUN_TERMINAL_EVENTS.map(sqlString).join(', ')

  return `
    WITH channel_events AS (
      SELECT
        event,
        timestamp,
        toString(person_id) AS person_id,
        JSONExtractString(toString(properties), 'channel_stage') AS stage,
        toIntOrZero(toString(properties.animation_run_index)) AS run_index,
        toFloatOrZero(toString(properties.animation_progress_percent)) AS progress_percentage,
        toFloatOrZero(toString(properties.watch_duration_ms)) AS watch_ms
      FROM events
      WHERE timestamp >= toDateTime(${sqlString(NEW_CHANNEL_ANALYTICS_STARTED_AT)})
        AND event IN (${eventAllowlist})
        AND JSONExtractString(toString(properties), 'channel_stage') IN (${stageAllowlist})
        AND JSONExtractString(toString(properties), 'onboarding_version') = ${sqlString(NEW_CHANNEL_ANALYTICS_VERSION)}
        AND ${buildFrontendOnboardingProductionHostHogql('properties', 'timestamp')}
    ), per_person_stage AS (
      SELECT
        person_id,
        stage,
        max(event = 'onboarding_channel_stage_viewed') AS reached,
        max(event = 'onboarding_channel_animation_started' AND run_index = 1) AS started,
        max(event = 'onboarding_channel_animation_completed' AND run_index = 1) AS completed,
        max(event = 'onboarding_channel_animation_skipped' AND run_index = 1) AS skipped,
        max(event = 'onboarding_channel_animation_interrupted' AND run_index = 1) AS interrupted,
        max(event = 'onboarding_channel_stage_continued') AS continued,
        max(event = 'onboarding_channel_reduced_motion_shown') AS reduced_motion,
        max(event = 'onboarding_channel_animation_unavailable') AS unavailable,
        countIf(event = 'onboarding_channel_animation_replayed') AS replay_requests,
        max(event IN (${terminalAllowlist}) AND run_index = 1) AS first_run_terminal,
        maxIf(progress_percentage, event IN (${terminalAllowlist}) AND run_index = 1) AS first_run_progress,
        maxIf(watch_ms, event IN (${terminalAllowlist}) AND run_index = 1) AS first_run_watch_ms,
        max(event = 'onboarding_channel_animation_completed' AND run_index > 1) AS replay_completed,
        max(event IN (${terminalAllowlist}) AND run_index > 1) AS replay_terminal,
        maxIf(watch_ms, event IN (${terminalAllowlist}) AND run_index > 1) AS replay_watch_ms
      FROM channel_events
      WHERE trim(person_id) != ''
      GROUP BY person_id, stage
    )
    SELECT
      stage_metrics.stage AS stage,
      sum(stage_metrics.reached) AS reached,
      sum(stage_metrics.started) AS started,
      sum(stage_metrics.completed) AS completed,
      sum(stage_metrics.skipped) AS skipped,
      sum(stage_metrics.interrupted) AS interrupted,
      sum(stage_metrics.continued) AS continued,
      sum(stage_metrics.replay_requests) AS replays,
      round(quantileIf(0.5)(stage_metrics.first_run_watch_ms, stage_metrics.first_run_terminal = 1 AND stage_metrics.first_run_watch_ms > 0)) AS median_watch_ms,
      round(quantileIf(0.5)(stage_metrics.first_run_progress, stage_metrics.skipped = 1)) AS median_skip_progress_percentage,
      countIf(stage_metrics.first_run_terminal = 1 AND stage_metrics.first_run_progress >= 25) AS retention_25,
      countIf(stage_metrics.first_run_terminal = 1 AND stage_metrics.first_run_progress >= 50) AS retention_50,
      countIf(stage_metrics.first_run_terminal = 1 AND stage_metrics.first_run_progress >= 75) AS retention_75,
      countIf(stage_metrics.skipped = 1 AND stage_metrics.first_run_progress < 25) AS skipped_0_24,
      countIf(stage_metrics.skipped = 1 AND stage_metrics.first_run_progress >= 25 AND stage_metrics.first_run_progress < 50) AS skipped_25_49,
      countIf(stage_metrics.skipped = 1 AND stage_metrics.first_run_progress >= 50 AND stage_metrics.first_run_progress < 75) AS skipped_50_74,
      countIf(stage_metrics.skipped = 1 AND stage_metrics.first_run_progress >= 75 AND stage_metrics.first_run_progress < 100) AS skipped_75_99,
      sum(stage_metrics.started) AS automatic_users,
      sum(stage_metrics.completed) AS automatic_completed,
      countIf(stage_metrics.started = 1 AND stage_metrics.continued = 1) AS automatic_continued,
      round(quantileIf(0.5)(stage_metrics.first_run_watch_ms, stage_metrics.first_run_terminal = 1 AND stage_metrics.first_run_watch_ms > 0)) AS automatic_median_watch_ms,
      countIf(stage_metrics.replay_requests > 0) AS replay_users,
      sum(stage_metrics.replay_completed) AS replay_completed,
      countIf(stage_metrics.replay_requests > 0 AND stage_metrics.continued = 1) AS replay_continued,
      round(quantileIf(0.5)(stage_metrics.replay_watch_ms, stage_metrics.replay_terminal = 1 AND stage_metrics.replay_watch_ms > 0)) AS replay_median_watch_ms,
      sum(stage_metrics.reduced_motion) AS reduced_motion_users,
      countIf(stage_metrics.reduced_motion = 1 AND stage_metrics.continued = 1) AS reduced_motion_continued,
      sum(stage_metrics.unavailable) AS unavailable_users,
      countIf(stage_metrics.unavailable = 1 AND stage_metrics.continued = 1) AS unavailable_continued
    FROM per_person_stage AS stage_metrics
    GROUP BY stage_metrics.stage
    ORDER BY indexOf([${stageAllowlist}], stage_metrics.stage)`
}

export async function getAdminABTestChannelCreation(c: Context): Promise<AdminABTestChannelCreation> {
  const config = AB_TESTS_CONFIG[NEW_CHANNEL_TEST]
  if (!config)
    throw new Error('Missing new channel A/B test configuration')

  const pgClient = getPgClient(c, true)
  try {
    const [outcomeResult, posthog] = await Promise.all([
      pgClient.query<AdminChannelExperimentOutcomeRow>(
        String.raw`WITH assigned_users AS (
           SELECT
             user_account.id,
             assignment.value ->> 'branch' AS branch,
             CASE
               WHEN assignment.value ->> 'assigned_at' ~ '^\d{4}-\d{2}-\d{2}T'
                 THEN (assignment.value ->> 'assigned_at')::timestamptz
               ELSE NULL
             END AS assigned_at
           FROM public.users AS user_account
           CROSS JOIN LATERAL jsonb_each(
             CASE
               WHEN jsonb_typeof(user_account.onboarding -> 'abtests') = 'object'
                 THEN user_account.onboarding -> 'abtests'
               ELSE '{}'::jsonb
             END
           ) AS assignment(test_name, value)
           WHERE (user_account.onboarding -> 'abtests') ? $1
             AND assignment.test_name = $1
             AND assignment.value ->> 'branch' = ANY($2::text[])
             AND jsonb_typeof(assignment.value) = 'object'
         )
         SELECT
           assigned_user.branch,
           count(*)::bigint AS assigned,
           count(*) FILTER (
             WHERE assigned_user.assigned_at <= now() - make_interval(hours => $3)
           )::bigint AS eligible,
           count(*) FILTER (
             WHERE assigned_user.assigned_at > now() - make_interval(hours => $3)
               OR assigned_user.assigned_at IS NULL
           )::bigint AS pending,
           count(*) FILTER (
             WHERE assigned_user.assigned_at <= now() - make_interval(hours => $3)
               AND EXISTS (
                 SELECT 1
                 FROM public.audit_logs AS audit_log
                 WHERE audit_log.user_id = assigned_user.id
                   AND audit_log.table_name = 'channels'
                   AND audit_log.operation = 'INSERT'
                   AND audit_log.created_at >= assigned_user.assigned_at
                   AND audit_log.created_at < assigned_user.assigned_at + make_interval(hours => $3)
               )
           )::bigint AS converted,
           min(assigned_user.assigned_at)::text AS cohort_started_at
         FROM assigned_users AS assigned_user
         GROUP BY assigned_user.branch`,
        [NEW_CHANNEL_TEST, [config.treatment_branch, config.control_branch], ADMIN_CHANNEL_OUTCOME_WINDOW_HOURS],
      ),
      queryPosthogHogql(c, buildAdminChannelAnimationHogql()),
    ])

    return buildAdminABTestChannelCreation(outcomeResult.rows, posthog)
  }
  finally {
    await closeClient(c, pgClient)
  }
}

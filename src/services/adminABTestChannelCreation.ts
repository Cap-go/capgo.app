import type {
  AdminABTestChannelCreation,
  AdminChannelAnimationCohort,
  AdminChannelAnimationCohortName,
  AdminChannelAnimationStage,
  AdminChannelAnimationStageName,
  AdminChannelExperimentBranch,
  AdminChannelExperimentStatus,
} from '../../supabase/functions/_backend/utils/ab_test_channel_creation.ts'

export type {
  AdminABTestChannelCreation,
  AdminChannelAnimationCohortName,
  AdminChannelAnimationStage,
  AdminChannelAnimationStageName,
  AdminChannelExperimentStatus,
} from '../../supabase/functions/_backend/utils/ab_test_channel_creation.ts'

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

type AdminChannelPosthogFailureReason = NonNullable<AdminABTestChannelCreation['data_quality']['posthog_failure_reason']>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function measurement(value: unknown): number | null | undefined {
  if (value === null)
    return null
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function signedMeasurement(value: unknown): number | null | undefined {
  if (value === null)
    return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function percentage(value: unknown): number | null | undefined {
  const parsed = measurement(value)
  return parsed === null || (typeof parsed === 'number' && parsed <= 100) ? parsed : undefined
}

function parseBranch(value: unknown): AdminChannelExperimentBranch | null {
  if (!isRecord(value)
    || typeof value.branch !== 'string'
    || !value.branch
    || typeof value.label !== 'string'
    || !value.label) {
    return null
  }
  const assigned = count(value.assigned)
  const eligible = count(value.eligible)
  const converted = count(value.converted)
  const pending = count(value.pending)
  const conversionPercentage = percentage(value.conversion_percentage)
  if (assigned === null || eligible === null || converted === null || pending === null
    || conversionPercentage === undefined || eligible > assigned || converted > eligible
    || pending > assigned || eligible + pending > assigned) {
    return null
  }
  return {
    assigned,
    branch: value.branch,
    conversion_percentage: conversionPercentage,
    converted,
    eligible,
    label: value.label,
    pending,
  }
}

function isCohort(value: unknown): value is AdminChannelAnimationCohortName {
  return typeof value === 'string'
    && (ADMIN_CHANNEL_ANIMATION_COHORTS as readonly string[]).includes(value)
}

function parseCohort(value: unknown): AdminChannelAnimationCohort | null {
  if (!isRecord(value) || !isCohort(value.cohort))
    return null
  const users = count(value.users)
  const completed = value.completed === null ? null : count(value.completed)
  const continued = count(value.continued)
  const completionPercentage = percentage(value.completion_percentage)
  const continuedPercentage = percentage(value.continued_percentage)
  const medianWatch = measurement(value.median_watch_ms)
  if (users === null || completed === undefined || continued === null
    || completionPercentage === undefined || continuedPercentage === undefined || medianWatch === undefined
    || (completed !== null && completed > users) || continued > users) {
    return null
  }
  return {
    cohort: value.cohort,
    completed,
    completion_percentage: completionPercentage,
    continued,
    continued_percentage: continuedPercentage,
    median_watch_ms: medianWatch,
    users,
  }
}

function parseStage(value: unknown): AdminChannelAnimationStage | null {
  if (!isRecord(value)
    || typeof value.stage !== 'string'
    || !(ADMIN_CHANNEL_ANIMATION_STAGES as readonly string[]).includes(value.stage)
    || !Array.isArray(value.cohorts)
    || !Array.isArray(value.retention)
    || !Array.isArray(value.skip_progress)) {
    return null
  }

  const reached = count(value.reached)
  const started = count(value.started)
  const completed = count(value.completed)
  const skipped = count(value.skipped)
  const interrupted = count(value.interrupted)
  const continued = count(value.continued)
  const replays = count(value.replays)
  const completionPercentage = percentage(value.completion_percentage)
  const continuedPercentage = percentage(value.continued_percentage)
  const medianSkip = percentage(value.median_skip_progress_percentage)
  const medianWatch = measurement(value.median_watch_ms)
  if ([reached, started, completed, skipped, interrupted, continued, replays].includes(null)
    || completionPercentage === undefined || continuedPercentage === undefined
    || medianSkip === undefined || medianWatch === undefined) {
    return null
  }

  const cohorts = value.cohorts.map(parseCohort)
  if (cohorts.length !== ADMIN_CHANNEL_ANIMATION_COHORTS.length
    || cohorts.includes(null)
    || new Set(cohorts.map(item => item?.cohort)).size !== cohorts.length) {
    return null
  }

  const retention = value.retention.flatMap((item) => {
    if (!isRecord(item))
      return []
    const progress = item.progress_percentage
    const viewers = count(item.viewers)
    if (![0, 25, 50, 75, 100].includes(progress as number) || viewers === null)
      return []
    return [{ progress_percentage: progress as 0 | 25 | 50 | 75 | 100, viewers }]
  })
  const skipProgress = value.skip_progress.flatMap((item) => {
    if (!isRecord(item))
      return []
    const from = item.from_percentage
    const to = item.to_percentage
    const skippedCount = count(item.skipped)
    if (![0, 25, 50, 75].includes(from as number)
      || ![24, 49, 74, 99].includes(to as number)
      || skippedCount === null) {
      return []
    }
    return [{
      from_percentage: from as 0 | 25 | 50 | 75,
      skipped: skippedCount,
      to_percentage: to as 24 | 49 | 74 | 99,
    }]
  })
  if (retention.length !== 5 || skipProgress.length !== 4)
    return null

  return {
    completed: completed!,
    completion_percentage: completionPercentage,
    continued: continued!,
    continued_percentage: continuedPercentage,
    cohorts: cohorts as AdminChannelAnimationCohort[],
    interrupted: interrupted!,
    median_skip_progress_percentage: medianSkip,
    median_watch_ms: medianWatch,
    reached: reached!,
    replays: replays!,
    retention,
    skip_progress: skipProgress,
    skipped: skipped!,
    stage: value.stage as AdminChannelAnimationStageName,
    started: started!,
  }
}

function isExperimentStatus(value: unknown): value is AdminChannelExperimentStatus {
  return typeof value === 'string'
    && ['collecting', 'treatment_ahead', 'control_ahead', 'inconclusive'].includes(value)
}

function isFailureReason(value: unknown): value is AdminChannelPosthogFailureReason {
  return typeof value === 'string'
    && ['too_large', 'unconfigured', 'timeout', 'unavailable'].includes(value)
}

function parseConfidenceInterval(value: unknown): { high: number, low: number } | null | undefined {
  if (value === null)
    return null
  if (!isRecord(value)
    || typeof value.low !== 'number' || !Number.isFinite(value.low)
    || typeof value.high !== 'number' || !Number.isFinite(value.high)) {
    return undefined
  }
  return { high: value.high, low: value.low }
}

export function parseAdminABTestChannelCreation(value: unknown): AdminABTestChannelCreation | null {
  if (!isRecord(value)
    || !isRecord(value.data_quality)
    || !isRecord(value.experiment)
    || typeof value.generated_at !== 'string'
    || !Number.isFinite(Date.parse(value.generated_at))
    || !Array.isArray(value.stages)
    || !Array.isArray(value.experiment.branches)
    || typeof value.data_quality.posthog_configured !== 'boolean'
    || typeof value.data_quality.posthog_connected !== 'boolean'
    || (value.data_quality.posthog_failure_reason !== null && !isFailureReason(value.data_quality.posthog_failure_reason))
    || !isExperimentStatus(value.experiment.status)) {
    return null
  }

  const branches = value.experiment.branches.map(parseBranch)
  const stages = value.stages.map(parseStage)
  const totalAssigned = count(value.experiment.total_assigned)
  const minimumBranchSample = count(value.experiment.minimum_branch_sample)
  const observationWindowHours = count(value.experiment.observation_window_hours)
  const confidence = percentage(value.experiment.confidence_percentage)
  const difference = signedMeasurement(value.experiment.difference_percentage_points)
  const relativeLift = signedMeasurement(value.experiment.relative_lift_percentage)
  const interval = parseConfidenceInterval(value.experiment.confidence_interval_percentage_points)
  if (branches.length !== 2 || branches.includes(null)
    || stages.length !== ADMIN_CHANNEL_ANIMATION_STAGES.length || stages.includes(null)
    || totalAssigned === null || minimumBranchSample === null || observationWindowHours === null
    || confidence === undefined || difference === undefined || relativeLift === undefined || interval === undefined
    || totalAssigned !== branches.reduce((sum, branch) => sum + (branch?.assigned ?? 0), 0)) {
    return null
  }

  return {
    data_quality: {
      posthog_configured: value.data_quality.posthog_configured,
      posthog_connected: value.data_quality.posthog_connected,
      posthog_failure_reason: value.data_quality.posthog_failure_reason,
    },
    experiment: {
      branches: branches as AdminChannelExperimentBranch[],
      confidence_percentage: confidence,
      confidence_interval_percentage_points: interval,
      difference_percentage_points: difference,
      minimum_branch_sample: minimumBranchSample,
      observation_window_hours: observationWindowHours,
      relative_lift_percentage: relativeLift,
      status: value.experiment.status,
      total_assigned: totalAssigned,
    },
    generated_at: value.generated_at,
    stages: stages as AdminChannelAnimationStage[],
  }
}

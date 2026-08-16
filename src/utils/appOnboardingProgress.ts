import type { Json } from '~/types/supabase.types'

export const APP_ONBOARDING_FEATURES = ['cli_install', 'ota', 'builder'] as const
export type AppOnboardingFeatureKey = typeof APP_ONBOARDING_FEATURES[number]

export const APP_ONBOARDING_STAGES = [
  'no_device',
  'local_only',
  'native_unknown',
  'play_unknown',
  'testflight',
  'store_live',
] as const
export type AppOnboardingStage = typeof APP_ONBOARDING_STAGES[number]

export interface AppOnboardingFeature {
  started_at?: string | null
  succeeded_at?: string | null
  last_used_at?: string | null
  retained_30d_at?: string | null
  stage?: AppOnboardingStage | null
}

export interface AppOnboardingLedger {
  refreshed_at?: string | null
  getting_started_dismissed_at?: string | null
  features?: Partial<Record<string, AppOnboardingFeature>>
}

const STAGE_RANK = new Map<AppOnboardingStage, number>(
  APP_ONBOARDING_STAGES.map((stage, index) => [stage, index]),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asTimestamp(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseAppOnboardingStage(value: unknown): AppOnboardingStage | null {
  if (typeof value !== 'string')
    return null
  return (APP_ONBOARDING_STAGES as readonly string[]).includes(value)
    ? value as AppOnboardingStage
    : null
}

export function parseAppOnboardingFeature(value: unknown): AppOnboardingFeature {
  if (!isRecord(value))
    return {}

  return {
    started_at: asTimestamp(value.started_at),
    succeeded_at: asTimestamp(value.succeeded_at),
    last_used_at: asTimestamp(value.last_used_at),
    retained_30d_at: asTimestamp(value.retained_30d_at),
    stage: parseAppOnboardingStage(value.stage),
  }
}

export function parseAppOnboardingLedger(value: unknown): AppOnboardingLedger {
  if (!isRecord(value))
    return {}

  const featuresValue = value.features
  const features: AppOnboardingLedger['features'] = {}
  if (isRecord(featuresValue)) {
    for (const [key, feature] of Object.entries(featuresValue))
      features[key] = parseAppOnboardingFeature(feature)
  }

  return {
    refreshed_at: asTimestamp(value.refreshed_at),
    getting_started_dismissed_at: asTimestamp(value.getting_started_dismissed_at),
    features,
  }
}

export function withGettingStartedDismissed(
  value: unknown,
  at = new Date().toISOString(),
): Json {
  const existing: { [key: string]: Json | undefined } = isRecord(value)
    ? { ...value as { [key: string]: Json | undefined } }
    : {}
  if (typeof existing.getting_started_dismissed_at === 'string' && existing.getting_started_dismissed_at.length > 0)
    return existing
  return {
    ...existing,
    getting_started_dismissed_at: at,
  }
}

export function getAppOnboardingFeature(
  ledger: AppOnboardingLedger,
  key: AppOnboardingFeatureKey,
): AppOnboardingFeature {
  return parseAppOnboardingLedger(ledger).features?.[key] ?? {}
}

export function rankAppOnboardingStage(stage: AppOnboardingStage | null | undefined): number {
  if (!stage)
    return -1
  return STAGE_RANK.get(stage) ?? -1
}

export function highestAppOnboardingStage(
  stages: Array<AppOnboardingStage | null | undefined>,
): AppOnboardingStage | null {
  let best: AppOnboardingStage | null = null
  let bestRank = -1
  for (const stage of stages) {
    const rank = rankAppOnboardingStage(stage)
    if (rank > bestRank) {
      best = stage ?? null
      bestRank = rank
    }
  }
  return best
}

export function isFeatureRetained30d(feature: AppOnboardingFeature): boolean {
  return Boolean(feature.retained_30d_at)
}

export function isFeatureUsedSince(feature: AppOnboardingFeature, sinceMs: number, now = Date.now()): boolean {
  if (!feature.last_used_at)
    return false
  const usedAt = Date.parse(feature.last_used_at)
  return Number.isFinite(usedAt) && usedAt >= now - sinceMs
}

export function nextOnboardingAction(ledger: AppOnboardingLedger): {
  feature: AppOnboardingFeatureKey
  stage: AppOnboardingStage | null
} {
  const cliInstall = ledger.features?.cli_install ?? {}
  const ota = ledger.features?.ota ?? {}
  const builder = ledger.features?.builder ?? {}
  const cliDone = Boolean(cliInstall.succeeded_at)
    || Boolean(ota.succeeded_at)
    || rankAppOnboardingStage(parseAppOnboardingStage(ota.stage)) > rankAppOnboardingStage('local_only')
  const stage = parseAppOnboardingStage(ota.stage) ?? (cliDone ? 'native_unknown' : 'no_device')

  if (builder.started_at && !builder.succeeded_at)
    return { feature: 'builder', stage }
  if (!cliDone)
    return { feature: 'cli_install', stage }
  if (!ota.started_at || !ota.succeeded_at)
    return { feature: 'ota', stage }
  if (stage === 'testflight' || stage === 'play_unknown' || stage === 'native_unknown')
    return { feature: 'ota', stage }
  return { feature: 'ota', stage }
}

export function shouldShowOnboardingNextStep(ledger: AppOnboardingLedger): boolean {
  return nextOnboardingAction(ledger).stage !== 'store_live'
}

export const GETTING_STARTED_STEP_IDS = ['cli_install', 'live_update', 'store_release', 'builder'] as const
export type GettingStartedStepId = typeof GETTING_STARTED_STEP_IDS[number]
export type GettingStartedGroup = 'essential' | 'grow'

export interface GettingStartedStep {
  id: GettingStartedStepId
  group: GettingStartedGroup
  done: boolean
  titleKey: string
  descKey: string
  actionKey: string
}

export interface GettingStartedStepExtras {
  builderDone?: boolean
  storeReleaseValidated?: boolean
}

const GETTING_STARTED_STEP_DEFS: Array<Omit<GettingStartedStep, 'done'>> = [
  {
    id: 'cli_install',
    group: 'essential',
    titleKey: 'onboarding-next-cli-install',
    descKey: 'onboarding-next-cli-install-desc',
    actionKey: 'getting-started-action-setup',
  },
  {
    id: 'live_update',
    group: 'essential',
    titleKey: 'getting-started-live-update',
    descKey: 'getting-started-live-update-desc',
    actionKey: 'getting-started-action-setup',
  },
  {
    id: 'store_release',
    group: 'essential',
    titleKey: 'store-release-validation-badge',
    descKey: 'onboarding-next-ota-store-desc',
    actionKey: 'getting-started-action-validate',
  },
  {
    id: 'builder',
    group: 'grow',
    titleKey: 'builder-promo-banner-title',
    descKey: 'builder-promo-banner-subtitle',
    actionKey: 'getting-started-action-explore',
  },
]

function onboardingStage(ledger: AppOnboardingLedger): AppOnboardingStage | null {
  const ota = ledger.features?.ota ?? {}
  const cliInstall = ledger.features?.cli_install ?? {}
  return parseAppOnboardingStage(ota.stage) ?? parseAppOnboardingStage(cliInstall.stage)
}

export function isGettingStartedStepDone(
  ledger: AppOnboardingLedger,
  id: GettingStartedStepId,
  extras?: GettingStartedStepExtras,
): boolean {
  const cliInstall = ledger.features?.cli_install ?? {}
  const ota = ledger.features?.ota ?? {}
  const builder = ledger.features?.builder ?? {}
  const stage = onboardingStage(ledger)

  if (id === 'cli_install') {
    return Boolean(cliInstall.succeeded_at)
      || Boolean(ota.succeeded_at)
      || rankAppOnboardingStage(stage) > rankAppOnboardingStage('local_only')
  }
  if (id === 'live_update')
    return Boolean(ota.succeeded_at)
  if (id === 'store_release')
    return stage === 'store_live' || extras?.storeReleaseValidated === true
  return extras?.builderDone === true || Boolean(builder.succeeded_at)
}

export function buildGettingStartedSteps(
  ledger: AppOnboardingLedger,
  extras?: GettingStartedStepExtras,
): GettingStartedStep[] {
  return GETTING_STARTED_STEP_DEFS.map(def => ({
    ...def,
    done: isGettingStartedStepDone(ledger, def.id, extras),
  }))
}

export function gettingStartedProgress(steps: GettingStartedStep[]): {
  done: number
  total: number
  percent: number
} {
  const total = steps.length
  const done = steps.filter(step => step.done).length
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  }
}

export function shouldShowGettingStartedNav(ledger: AppOnboardingLedger, extras?: GettingStartedStepExtras): boolean {
  if (ledger.getting_started_dismissed_at)
    return false
  return buildGettingStartedSteps(ledger, extras)
    .some(step => step.group === 'essential' && !step.done)
}

export function onboardingNextStepMessageKeys(ledger: AppOnboardingLedger): {
  titleKey: string
  descKey: string
} {
  const next = nextOnboardingAction(ledger)
  if (next.feature === 'cli_install') {
    return {
      titleKey: 'onboarding-next-cli-install',
      descKey: 'onboarding-next-cli-install-desc',
    }
  }
  if (next.feature === 'builder') {
    return {
      titleKey: 'onboarding-next-builder',
      descKey: 'onboarding-next-builder-desc',
    }
  }
  if (next.stage === 'testflight' || next.stage === 'play_unknown' || next.stage === 'native_unknown') {
    return {
      titleKey: 'onboarding-next-ota-store',
      descKey: 'onboarding-next-ota-store-desc',
    }
  }
  return {
    titleKey: 'onboarding-next-ota-device',
    descKey: 'onboarding-next-ota-device-desc',
  }
}

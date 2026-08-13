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
    features,
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
  const stage = parseAppOnboardingStage(ota.stage) ?? (cliInstall.succeeded_at ? 'native_unknown' : 'no_device')

  if (!cliInstall.started_at)
    return { feature: 'cli_install', stage }
  if (!cliInstall.succeeded_at || stage === 'no_device' || stage === 'local_only')
    return { feature: 'cli_install', stage }
  if (!ota.started_at || !ota.succeeded_at)
    return { feature: 'ota', stage }
  if (stage === 'testflight' || stage === 'play_unknown' || stage === 'native_unknown')
    return { feature: 'ota', stage }
  if (builder.started_at && !builder.succeeded_at)
    return { feature: 'builder', stage }
  return { feature: 'ota', stage }
}

export function shouldShowOnboardingNextStep(ledger: AppOnboardingLedger): boolean {
  return nextOnboardingAction(ledger).stage !== 'store_live'
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

export const FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS = [
  'cli_copy_init',
  'ai_copy_init',
  'both_copy_init',
  'no_copy_init',
  'cli_copy_other_cli',
  'ai_copy_other_cli',
  'both_copy_other_cli',
  'no_copy_other_cli',
  'cli_copy_no_cli',
  'ai_copy_no_cli',
  'both_copy_no_cli',
  'no_action',
] as const

export type FrontendOnboardingDailySetupCliOutcomeKey = typeof FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS[number]
export type FrontendOnboardingDailySetupCliLifecycle = 'first_time' | 'returning'
export type FrontendOnboardingDailySetupCliEventKind = 'setup' | 'cli_copy' | 'ai_copy' | 'cli_command'

export interface FrontendOnboardingDailySetupCliEvent {
  personId: string
  timestampMs: number
  kind: FrontendOnboardingDailySetupCliEventKind
  commandPath?: string
}

export interface FrontendOnboardingDailySetupCliSignals {
  cliCopied: boolean
  aiCopied: boolean
  initRun: boolean
  otherCliRun: boolean
}

export type FrontendOnboardingDailySetupCliOutcomeCounts = Record<FrontendOnboardingDailySetupCliOutcomeKey, number>

export interface FrontendOnboardingDailySetupCliOutcomePoint {
  date: string
  first_time: FrontendOnboardingDailySetupCliOutcomeCounts
  returning: FrontendOnboardingDailySetupCliOutcomeCounts
}

export function createFrontendOnboardingDailySetupCliOutcomeCounts(): FrontendOnboardingDailySetupCliOutcomeCounts {
  return Object.fromEntries(
    FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS.map(key => [key, 0]),
  ) as FrontendOnboardingDailySetupCliOutcomeCounts
}

export function classifyFrontendOnboardingDailySetupCliOutcome(
  signals: FrontendOnboardingDailySetupCliSignals,
): FrontendOnboardingDailySetupCliOutcomeKey {
  const copyPrefix = signals.cliCopied && signals.aiCopied
    ? 'both_copy'
    : signals.cliCopied
      ? 'cli_copy'
      : signals.aiCopied
        ? 'ai_copy'
        : 'no_copy'

  if (signals.initRun)
    return `${copyPrefix}_init` as FrontendOnboardingDailySetupCliOutcomeKey

  if (signals.otherCliRun)
    return `${copyPrefix}_other_cli` as FrontendOnboardingDailySetupCliOutcomeKey

  if (copyPrefix !== 'no_copy')
    return `${copyPrefix}_no_cli` as FrontendOnboardingDailySetupCliOutcomeKey

  return 'no_action'
}

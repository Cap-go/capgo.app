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
export type FrontendOnboardingDailySetupCliOutcomeLifecycle = 'first_time' | 'returning'
export type FrontendOnboardingDailySetupCliOutcomeEventKind = 'setup' | 'cli_copy' | 'ai_copy' | 'cli_command'

export interface FrontendOnboardingDailySetupCliOutcomeEvent {
  personId: string
  timestampMs: number
  kind: FrontendOnboardingDailySetupCliOutcomeEventKind
  commandPath?: string
}

export interface FrontendOnboardingDailySetupCliOutcomeSignals {
  cliCopied: boolean
  aiCopied: boolean
  initRun: boolean
  otherCliRun: boolean
}

export type FrontendOnboardingDailySetupCliOutcomeCounts = Record<FrontendOnboardingDailySetupCliOutcomeKey, number>

export interface FrontendOnboardingDailySetupCliOutcomeDailyPoint {
  date: string
  first_time: FrontendOnboardingDailySetupCliOutcomeCounts
  returning: FrontendOnboardingDailySetupCliOutcomeCounts
}

export function createFrontendOnboardingDailySetupCliOutcomeCounts(): FrontendOnboardingDailySetupCliOutcomeCounts {
  return {
    cli_copy_init: 0,
    ai_copy_init: 0,
    both_copy_init: 0,
    no_copy_init: 0,
    cli_copy_other_cli: 0,
    ai_copy_other_cli: 0,
    both_copy_other_cli: 0,
    no_copy_other_cli: 0,
    cli_copy_no_cli: 0,
    ai_copy_no_cli: 0,
    both_copy_no_cli: 0,
    no_action: 0,
  }
}

export function classifyFrontendOnboardingDailySetupCliOutcome(
  signals: FrontendOnboardingDailySetupCliOutcomeSignals,
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

import { describe, expect, it } from 'vitest'
import {
  classifyFrontendOnboardingDailySetupCliOutcome,
  FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS,
} from '../supabase/functions/_backend/utils/frontend_onboarding_daily_setup_cli_outcomes_model.ts'

describe('classifyFrontendOnboardingDailySetupCliOutcome', () => {
  it.each([
    [true, false, true, false, 'cli_copy_init'],
    [false, true, true, false, 'ai_copy_init'],
    [true, true, true, false, 'both_copy_init'],
    [false, false, true, false, 'no_copy_init'],
    [true, false, false, true, 'cli_copy_other_cli'],
    [false, true, false, true, 'ai_copy_other_cli'],
    [true, true, false, true, 'both_copy_other_cli'],
    [false, false, false, true, 'no_copy_other_cli'],
    [true, false, false, false, 'cli_copy_no_cli'],
    [false, true, false, false, 'ai_copy_no_cli'],
    [true, true, false, false, 'both_copy_no_cli'],
    [false, false, false, false, 'no_action'],
  ] as const)('classifies cliCopied=%s, aiCopied=%s, initRun=%s, otherCliRun=%s as %s', (cliCopied, aiCopied, initRun, otherCliRun, expected) => {
    expect(classifyFrontendOnboardingDailySetupCliOutcome({ cliCopied, aiCopied, initRun, otherCliRun })).toBe(expected)
  })

  it('prioritizes init when init and another CLI command both run', () => {
    expect(classifyFrontendOnboardingDailySetupCliOutcome({
      cliCopied: true,
      aiCopied: true,
      initRun: true,
      otherCliRun: true,
    })).toBe('both_copy_init')
  })

  it('exports every outcome key once in taxonomy order', () => {
    expect(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS).toEqual([
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
    ])
    expect(new Set(FRONTEND_ONBOARDING_DAILY_SETUP_CLI_OUTCOME_KEYS)).toHaveLength(12)
  })
})

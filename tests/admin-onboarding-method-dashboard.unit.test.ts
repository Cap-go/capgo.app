import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  aggregateAppOnboardingMethodTotals,
  aggregateAppOnboardingOutcomeTotals,
} from '../src/services/adminAppOnboarding'

describe('admin app onboarding dashboard', () => {
  it.concurrent('wires method and outcome trends to stacked charts', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/onboarding/sources.vue', import.meta.url), 'utf8')

    expect(source).toContain('onboarding_method_trend?.some')
    expect(source).toContain('onboarding_outcome_trend?.some')
    expect(source).toContain('hasAppOnboardingMethodTrendData')
    expect(source).toContain('hasAppOnboardingOutcomeTrendData')
    expect(source).toContain('AdminStackedBarChart')
    expect(source).toContain(`t('onboarding-source-cli')`)
    expect(source).toContain(`t('onboarding-source-mcp')`)
    expect(source).toContain(`t('onboarding-source-ai')`)
    expect(source).toContain(`t('onboarding-source-manual')`)
    expect(source).toContain(`t('onboarding-outcome-completed')`)
    expect(source).toContain(`t('onboarding-outcome-skipped')`)
    expect(source).toContain(`t('onboarding-outcome-switched-to-manual')`)
  })

  it.concurrent('sums onboarding method and outcome totals for the selected period', () => {
    expect(aggregateAppOnboardingMethodTotals([
      { date: '2026-08-13', manual: 2, cli: 1, mcp: 0, ai: 1 },
      { date: '2026-08-14', manual: 1, cli: 3, mcp: 2, ai: 0 },
    ])).toEqual({
      manual: 3,
      cli: 4,
      mcp: 2,
      ai: 1,
    })

    expect(aggregateAppOnboardingOutcomeTotals([
      { date: '2026-08-13', completed: 1, skipped: 0, switched_to_manual: 1, in_progress: 2 },
      { date: '2026-08-14', completed: 2, skipped: 1, switched_to_manual: 0, in_progress: 1 },
    ])).toEqual({
      completed: 3,
      skipped: 1,
      switchedToManual: 1,
      inProgress: 3,
    })
  })

  it.concurrent('renders selected-period onboarding totals below the stacked charts', async () => {
    const source = await readFile(new URL('../src/pages/admin/dashboard/onboarding/sources.vue', import.meta.url), 'utf8')

    expect(source).toContain('aggregateAppOnboardingMethodTotals(onboardingFunnelData.value?.onboarding_method_trend ?? [])')
    expect(source).toContain('aggregateAppOnboardingOutcomeTotals(onboardingFunnelData.value?.onboarding_outcome_trend ?? [])')
    expect(source).toContain(':value="appOnboardingMethodTotals.cli"')
    expect(source).toContain(':value="appOnboardingOutcomeTotals.switchedToManual"')
    expect(source).toContain('data-test="app-onboarding-method-totals"')
    expect(source).toContain('data-test="app-onboarding-outcome-totals"')

    const methodChartIndex = source.indexOf(`t('apps-onboarding-by-method')`)
    const outcomeChartIndex = source.indexOf(`t('apps-onboarding-by-outcome')`)

    expect(methodChartIndex).toBeGreaterThan(-1)
    expect(outcomeChartIndex).toBeGreaterThan(methodChartIndex)
    expect(source.indexOf(`t('admin-users-email-type-breakdown')`)).toBeGreaterThan(outcomeChartIndex)
  })

  it.concurrent('defines every app onboarding label in English', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['apps-onboarding-by-method']).toBe('App onboarding by method')
    expect(messages['apps-onboarding-by-outcome']).toBe('Setup outcomes')
    expect(messages['onboarding-source-cli']).toBe('CLI')
    expect(messages['onboarding-outcome-switched-to-manual']).toBe('Switched to dashboard')
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  parseAdminABTestDistribution,
  totalABTestAssignments,
} from '../src/services/adminABTestDistribution'
import { parseAdminABTestPublishIntentOutcome } from '../src/services/adminABTestPublishIntentOutcome'

const payload = [
  {
    test_name: 'new_emails',
    label: 'Email template',
    total: 803,
    branches: [
      { branch: 'A', label: 'New emails', count: 400, percentage: 49.8 },
      { branch: 'B', label: 'Old emails', count: 403, percentage: 50.2 },
    ],
  },
]

const outcomePayload = {
  total: 356,
  outcomes: [
    { outcome: 'selected_publish', count: 104 },
    { outcome: 'selected_another_intent', count: 197 },
    { outcome: 'no_selection_yet', count: 55 },
  ],
}

describe('admin A/B test dashboard presentation', () => {
  it.concurrent('accepts a valid distribution response', () => {
    expect(parseAdminABTestDistribution(payload)).toEqual(payload)
    expect(totalABTestAssignments(payload)).toBe(803)
  })

  it.concurrent('rejects malformed distribution responses', () => {
    expect(parseAdminABTestDistribution(null)).toBeNull()
    expect(parseAdminABTestDistribution([{ ...payload[0], total: -1 }])).toBeNull()
    expect(parseAdminABTestDistribution([{ ...payload[0], branches: [] }])).toBeNull()
    expect(parseAdminABTestDistribution([{
      ...payload[0],
      branches: [{ ...payload[0].branches[0], percentage: 101 }, payload[0].branches[1]],
    }])).toBeNull()
    expect(parseAdminABTestDistribution([{
      ...payload[0],
      branches: [{ ...payload[0].branches[0], percentage: 49.9 }, payload[0].branches[1]],
    }])).toBeNull()
    expect(parseAdminABTestDistribution([{
      ...payload[0],
      total: 0,
      branches: [
        { ...payload[0].branches[0], count: 0, percentage: 50 },
        { ...payload[0].branches[1], count: 0, percentage: 50 },
      ],
    }])).toBeNull()
  })

  it.concurrent('accepts a valid Publish intent outcome response', () => {
    expect(parseAdminABTestPublishIntentOutcome(outcomePayload)).toEqual(outcomePayload)
  })

  it.concurrent('rejects malformed Publish intent outcome responses', () => {
    expect(parseAdminABTestPublishIntentOutcome(null)).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({ ...outcomePayload, total: -1 })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({ ...outcomePayload, outcomes: outcomePayload.outcomes.slice(0, 2) })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({
      ...outcomePayload,
      outcomes: [outcomePayload.outcomes[0], outcomePayload.outcomes[0], outcomePayload.outcomes[2]],
    })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({
      ...outcomePayload,
      outcomes: [{ outcome: 'unknown', count: 104 }, ...outcomePayload.outcomes.slice(1)],
    })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({
      ...outcomePayload,
      outcomes: [{ ...outcomePayload.outcomes[0], count: -1 }, ...outcomePayload.outcomes.slice(1)],
    })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({ ...outcomePayload, total: 355 })).toBeNull()
  })

  it.concurrent('wires the admin tab, metrics, and dashboard cards', async () => {
    const [tabsSource, storeSource, pageSource, matrixSource, outcomeSource] = await Promise.all([
      readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/stores/adminDashboard.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pages/admin/dashboard/ab-tests.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestDistributionMatrix.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestPublishIntentOutcome.vue', import.meta.url), 'utf8'),
    ])

    expect(tabsSource).toContain(`label: 'admin-ab-tests'`)
    expect(tabsSource).toContain(`key: '/ab-tests'`)
    expect(storeSource).toContain(`'ab_test_distribution'`)
    expect(storeSource).toContain(`'ab_test_publish_intent_outcome'`)
    expect(pageSource).toContain(`fetchStats('ab_test_distribution', forceRefresh)`)
    expect(pageSource).toContain(`fetchStats('ab_test_publish_intent_outcome', forceRefresh)`)
    expect(pageSource).toContain('<AdminABTestDistributionMatrix')
    expect(pageSource).toContain('<AdminABTestPublishIntentOutcome')
    expect(matrixSource).toContain('role="progressbar"')
    expect(matrixSource).toContain('formatNumberValue(branch.count)')
    expect(matrixSource).toContain('formatPercentage(branch.percentage)')
    expect(matrixSource).toContain(`t('admin-ab-tests-treatment')`)
    expect(matrixSource).toContain(`t('admin-ab-tests-control')`)
    expect(matrixSource).not.toContain(`t('admin-ab-tests-variant')`)
    expect(outcomeSource).toContain('role="progressbar"')
    expect(outcomeSource).toContain('formatNumberValue(outcome.total)')
    expect(outcomeSource).not.toContain('formatPercentage')
  })

  it.concurrent('defines the A/B test dashboard copy', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['admin-ab-tests']).toBe('A/B Tests')
    expect(messages['admin-ab-tests-description']).toBe('Assignment distribution across every experiment.')
    expect(messages['admin-ab-tests-total']).toBe('{tests} tests · {assignments} assignments')
    expect(messages['admin-ab-tests-experiment']).toBe('Experiment')
    expect(messages['admin-ab-tests-treatment']).toBe('Treatment')
    expect(messages['admin-ab-tests-control']).toBe('Control')
    expect(messages['admin-ab-tests-publish-outcome-title']).toBe('New Publish intent outcome')
    expect(messages['admin-ab-tests-publish-outcome-description']).toBe('Unique people who saw the new Publish intent through either experiment.')
    expect(messages['admin-ab-tests-publish-outcome-cohort']).toBe('Publish intent treatment or Development environment treatment · duplicates counted once')
    expect(messages['admin-ab-tests-publish-outcome-exposed']).toBe('unique people exposed')
    expect(messages['admin-ab-tests-publish-outcome-selected-publish']).toBe('Selected Publish')
    expect(messages['admin-ab-tests-publish-outcome-selected-another-intent']).toBe('Selected another intent')
    expect(messages['admin-ab-tests-publish-outcome-no-selection-yet']).toBe('No selection yet')
    expect(messages['admin-ab-tests-load-error']).toBe('Unable to load A/B test data. Please try again.')
    expect(messages['admin-ab-tests-empty']).toBe('No A/B tests are configured.')
  })
})

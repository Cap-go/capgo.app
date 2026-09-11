import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  parseAdminABTestDistribution,
  totalABTestAssignments,
} from '../src/services/adminABTestDistribution'

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

  it.concurrent('wires the admin tab, metric, and compact matrix page', async () => {
    const [tabsSource, storeSource, pageSource, matrixSource] = await Promise.all([
      readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/stores/adminDashboard.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pages/admin/dashboard/ab-tests.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestDistributionMatrix.vue', import.meta.url), 'utf8'),
    ])

    expect(tabsSource).toContain(`label: 'admin-ab-tests'`)
    expect(tabsSource).toContain(`key: '/ab-tests'`)
    expect(storeSource).toContain(`'ab_test_distribution'`)
    expect(pageSource).toContain(`fetchStats('ab_test_distribution', forceRefresh)`)
    expect(pageSource).toContain('<AdminABTestDistributionMatrix v-else')
    expect(matrixSource).toContain('role="progressbar"')
    expect(matrixSource).toContain('formatNumberValue(branch.count)')
    expect(matrixSource).toContain('formatPercentage(branch.percentage)')
  })

  it.concurrent('defines the A/B test dashboard copy', async () => {
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['admin-ab-tests']).toBe('A/B Tests')
    expect(messages['admin-ab-tests-description']).toBe('Assignment distribution across every experiment.')
    expect(messages['admin-ab-tests-total']).toBe('{tests} tests · {assignments} assignments')
    expect(messages['admin-ab-tests-experiment']).toBe('Experiment')
    expect(messages['admin-ab-tests-variant']).toBe('Variant')
    expect(messages['admin-ab-tests-load-error']).toBe('Unable to load A/B test distribution. Please try again.')
    expect(messages['admin-ab-tests-empty']).toBe('No A/B tests are configured.')
  })
})

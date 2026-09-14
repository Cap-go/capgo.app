import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseAdminABTestChannelCreation } from '../src/services/adminABTestChannelCreation'
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
  inferred_from_organization: 14,
  total: 356,
  outcomes: [
    { outcome: 'selected_publish', count: 104 },
    { outcome: 'selected_another_intent', count: 197 },
    { outcome: 'no_selection_yet', count: 55 },
  ],
}

const channelCreationPayload = {
  data_quality: {
    posthog_configured: true,
    posthog_connected: true,
    posthog_failure_reason: null,
  },
  experiment: {
    branches: [
      { assigned: 11, branch: 'A', conversion_percentage: 50, converted: 4, eligible: 8, label: 'Guided channel flow', pending: 3 },
      { assigned: 16, branch: 'B', conversion_percentage: 41.7, converted: 5, eligible: 12, label: 'Current channel flow', pending: 4 },
    ],
    confidence_percentage: null,
    confidence_interval_percentage_points: null,
    difference_percentage_points: 8.3,
    minimum_branch_sample: 100,
    observation_window_hours: 24,
    relative_lift_percentage: 20,
    status: 'collecting',
    total_assigned: 27,
  },
  generated_at: '2026-09-14T12:00:00.000Z',
  stages: ['channel-routing', 'channel-self-assign', 'channel-console-assign'].map(stage => ({
    completed: 6,
    completion_percentage: 66.7,
    continued: 7,
    continued_percentage: 77.8,
    cohorts: [
      { cohort: 'automatic', completed: 6, completion_percentage: 66.7, continued: 7, continued_percentage: 77.8, median_watch_ms: 42_000, users: 9 },
      { cohort: 'replay', completed: 2, completion_percentage: 100, continued: 2, continued_percentage: 100, median_watch_ms: 48_000, users: 2 },
      { cohort: 'reduced_motion', completed: null, completion_percentage: null, continued: 1, continued_percentage: 100, median_watch_ms: null, users: 1 },
      { cohort: 'unavailable', completed: null, completion_percentage: null, continued: 0, continued_percentage: null, median_watch_ms: null, users: 0 },
    ],
    interrupted: 1,
    median_skip_progress_percentage: 46,
    median_watch_ms: 42_000,
    reached: 9,
    replays: 2,
    retention: [0, 25, 50, 75, 100].map((progress, index) => ({ progress_percentage: progress, viewers: [9, 8, 7, 6, 6][index] })),
    skip_progress: [
      { from_percentage: 0, skipped: 0, to_percentage: 24 },
      { from_percentage: 25, skipped: 1, to_percentage: 49 },
      { from_percentage: 50, skipped: 1, to_percentage: 74 },
      { from_percentage: 75, skipped: 0, to_percentage: 99 },
    ],
    skipped: 2,
    stage,
    started: 9,
  })),
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
    expect(parseAdminABTestPublishIntentOutcome({
      outcomes: outcomePayload.outcomes,
      total: outcomePayload.total,
    })).toEqual({
      inferred_from_organization: 0,
      outcomes: outcomePayload.outcomes,
      total: outcomePayload.total,
    })
  })

  it.concurrent('rejects malformed Publish intent outcome responses', () => {
    expect(parseAdminABTestPublishIntentOutcome(null)).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({ ...outcomePayload, total: -1 })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({ ...outcomePayload, inferred_from_organization: -1 })).toBeNull()
    expect(parseAdminABTestPublishIntentOutcome({ ...outcomePayload, inferred_from_organization: 302 })).toBeNull()
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

  it.concurrent('accepts valid channel creation diagnostics and rejects malformed stages', () => {
    expect(parseAdminABTestChannelCreation(channelCreationPayload)).toEqual(channelCreationPayload)
    expect(parseAdminABTestChannelCreation({
      ...channelCreationPayload,
      experiment: {
        ...channelCreationPayload.experiment,
        difference_percentage_points: -8.3,
        relative_lift_percentage: -20,
      },
    })).not.toBeNull()
    expect(parseAdminABTestChannelCreation(null)).toBeNull()
    expect(parseAdminABTestChannelCreation({ ...channelCreationPayload, stages: channelCreationPayload.stages.slice(0, 2) })).toBeNull()
    expect(parseAdminABTestChannelCreation({
      ...channelCreationPayload,
      stages: [{ ...channelCreationPayload.stages[0], reached: -1 }, ...channelCreationPayload.stages.slice(1)],
    })).toBeNull()
  })

  it.concurrent('wires the admin tab, metrics, and dashboard cards', async () => {
    const [tabsSource, storeSource, pageSource, matrixSource, channelSource, retentionSource, outcomeSource] = await Promise.all([
      readFile(new URL('../src/constants/adminTabs.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/stores/adminDashboard.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pages/admin/dashboard/ab-tests.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestDistributionMatrix.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestChannelCreation.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestAnimationRetentionChart.vue', import.meta.url), 'utf8'),
      readFile(new URL('../src/components/admin/AdminABTestPublishIntentOutcome.vue', import.meta.url), 'utf8'),
    ])

    expect(tabsSource).toContain(`label: 'admin-ab-tests'`)
    expect(tabsSource).toContain(`key: '/ab-tests'`)
    expect(storeSource).toContain(`'ab_test_distribution'`)
    expect(storeSource).toContain(`'ab_test_channel_creation'`)
    expect(storeSource).toContain(`'ab_test_publish_intent_outcome'`)
    expect(pageSource).toContain(`fetchStats('ab_test_distribution', forceRefresh)`)
    expect(pageSource).toContain(`fetchStats('ab_test_channel_creation', forceRefresh)`)
    expect(pageSource).toContain(`fetchStats('ab_test_publish_intent_outcome', forceRefresh)`)
    expect(pageSource).toContain('<AdminABTestDistributionMatrix')
    expect(pageSource).toContain('<AdminABTestChannelCreation')
    expect(pageSource).toContain('<AdminABTestPublishIntentOutcome')
    expect(matrixSource).toContain('role="progressbar"')
    expect(matrixSource).toContain('formatNumberValue(branch.count)')
    expect(matrixSource).toContain('formatPercentage(branch.percentage)')
    expect(matrixSource).toContain(`t('admin-ab-tests-treatment')`)
    expect(matrixSource).toContain(`t('admin-ab-tests-control')`)
    expect(matrixSource).not.toContain(`t('admin-ab-tests-variant')`)
    expect(channelSource).toContain('role="tablist"')
    expect(channelSource).toContain(':aria-selected="stage.stage === selectedStageName"')
    expect(channelSource).toContain('posthog_failure_reason === null')
    expect(channelSource).not.toContain('Channel creation" class="bg-')
    expect(retentionSource).toContain('stepped: true')
    expect(retentionSource).toContain(`t('admin-ab-tests-channel-skip-bucket'`)
    expect(outcomeSource).toContain('<progress')
    expect(outcomeSource).not.toContain('role="progressbar"')
    expect(outcomeSource).toContain('formatNumberValue(outcome.total)')
    expect(outcomeSource).toContain('outcome.inferred_from_organization > 0')
    expect(outcomeSource).toContain(`t('admin-ab-tests-publish-outcome-inferred-note'`)
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
    expect(messages['admin-ab-tests-channel-title']).toBe('Channel creation — overall result')
    expect(messages['admin-ab-tests-channel-animation-title']).toBe('Animation diagnostics')
    expect(messages['admin-ab-tests-channel-stage-routing']).toBe('Default routing')
    expect(messages['admin-ab-tests-channel-stage-self-assign']).toBe('Device self-assignment')
    expect(messages['admin-ab-tests-channel-stage-console-assign']).toBe('Console assignment')
    expect(messages['admin-ab-tests-channel-diagnostic-note']).toContain('only treatment versus control')
    expect(messages['admin-ab-tests-publish-outcome-title']).toBe('New Publish intent outcome')
    expect(messages['admin-ab-tests-publish-outcome-description']).toBe('Unique people who saw the new Publish intent through either experiment.')
    expect(messages['admin-ab-tests-publish-outcome-cohort']).toBe('Publish intent treatment or Development environment treatment · duplicates counted once')
    expect(messages['admin-ab-tests-publish-outcome-exposed']).toBe('unique people exposed')
    expect(messages['admin-ab-tests-publish-outcome-selected-publish']).toBe('Selected Publish')
    expect(messages['admin-ab-tests-publish-outcome-selected-another-intent']).toBe('Selected another intent')
    expect(messages['admin-ab-tests-publish-outcome-no-selection-yet']).toBe('No selection yet')
    expect(messages['admin-ab-tests-publish-outcome-inferred-note']).toBe('Some intent selections were inferred from organization data because an earlier onboarding issue removed them from user onboarding ({count} inferred).')
    expect(messages['admin-ab-tests-load-error']).toBe('Unable to load A/B test data. Please try again.')
    expect(messages['admin-ab-tests-empty']).toBe('No A/B tests are configured.')
  })
})

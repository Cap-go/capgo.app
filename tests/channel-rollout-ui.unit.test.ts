import { describe, expect, it } from 'vitest'
import {
  rolloutPercentageDraftFromBps,
  shouldShowRolloutEnableRow,
  shouldShowRolloutSettings,
} from '../src/services/channelRolloutUi.ts'

describe('channel rollout UI helpers', () => {
  it('shows rollout settings when a rollout target exists', () => {
    expect(shouldShowRolloutSettings(42)).toBe(true)
    expect(shouldShowRolloutSettings(null)).toBe(false)
  })

  it('hides the enable row when a rollout target already exists', () => {
    expect(shouldShowRolloutEnableRow(42, false)).toBe(false)
    expect(shouldShowRolloutEnableRow(null, false)).toBe(true)
    expect(shouldShowRolloutEnableRow(null, true)).toBe(false)
  })

  it('initializes rollout percentage draft from basis points', () => {
    expect(rolloutPercentageDraftFromBps(2500)).toBe('25')
    expect(rolloutPercentageDraftFromBps(null)).toBe('0')
  })
})

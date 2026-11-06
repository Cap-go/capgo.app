// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getReachedTrialCardMilestones,
  markTrialCardMilestonesHandled,
  pickTrialCardMilestone,
  readHandledTrialCardMilestones,
} from '../src/utils/trialCardPrompt'

function app(features: Record<string, { started_at?: string | null, succeeded_at?: string | null }>) {
  return { onboarding: { features } }
}

describe('trial card prompt milestones', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('ignores apps that only started a feature', () => {
    const reached = getReachedTrialCardMilestones([
      app({ ota: { started_at: '2026-10-01T00:00:00Z', succeeded_at: null }, builder: { started_at: '2026-10-02T00:00:00Z' } }),
      { onboarding: null },
      { onboarding: 'invalid' },
    ])
    expect(reached).toEqual([])
    expect(pickTrialCardMilestone(reached, [])).toBeNull()
  })

  it('keeps the earliest success per milestone across apps', () => {
    const reached = getReachedTrialCardMilestones([
      app({ ota: { succeeded_at: '2026-10-05T00:00:00Z' } }),
      app({ ota: { succeeded_at: '2026-10-02T00:00:00Z' }, builder: { succeeded_at: '2026-10-04T00:00:00Z' } }),
    ])
    expect(reached).toEqual([
      { milestone: 'ota', reachedAt: '2026-10-02T00:00:00Z' },
      { milestone: 'builder', reachedAt: '2026-10-04T00:00:00Z' },
    ])
  })

  it('asks about the latest milestone not handled yet', () => {
    const reached = getReachedTrialCardMilestones([
      app({ ota: { succeeded_at: '2026-10-02T00:00:00Z' }, builder: { succeeded_at: '2026-10-04T00:00:00Z' } }),
    ])
    expect(pickTrialCardMilestone(reached, [])).toBe('builder')
    expect(pickTrialCardMilestone(reached, ['builder'])).toBe('ota')
    expect(pickTrialCardMilestone(reached, ['ota', 'builder'])).toBeNull()
  })

  it('persists handled milestones per organization', () => {
    markTrialCardMilestonesHandled('org-a', ['ota'])
    markTrialCardMilestonesHandled('org-a', ['builder', 'ota'])
    expect(readHandledTrialCardMilestones('org-a')).toEqual(['ota', 'builder'])
    expect(readHandledTrialCardMilestones('org-b')).toEqual([])

    localStorage.setItem('capgo-trial-card-prompt:org-c', '{"broken"')
    expect(readHandledTrialCardMilestones('org-c')).toEqual([])
    localStorage.setItem('capgo-trial-card-prompt:org-d', '["ota","unknown"]')
    expect(readHandledTrialCardMilestones('org-d')).toEqual(['ota'])
  })
})

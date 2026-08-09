import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlansVisitTracker } from '../src/services/plansVisitTracking'

describe('plans visit tracking', () => {
  const sender = vi.fn(async () => null)

  beforeEach(() => {
    sender.mockReset()
    sender.mockResolvedValue(null)
  })

  it('sends the existing User visit event with an explicit plans page property', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track('org-1')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(1)
    expect(sender).toHaveBeenCalledWith({
      channel: 'usage',
      event: 'User visit',
      icon: '💳',
      org_id: 'org-1',
      tracking_version: 2,
      notify: false,
      tags: { page: 'plans' },
    })
  })

  it('does not send twice for the same organization during one route activation', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track('org-1')).toBe(true)
    expect(tracker.track('org-1')).toBe(false)
    expect(sender).toHaveBeenCalledTimes(1)
  })

  it('tracks a different organization during the same route activation', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track('org-1')).toBe(true)
    expect(tracker.track('org-2')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(2)
  })

  it('allows the organization to be tracked again after leaving the route', () => {
    const tracker = createPlansVisitTracker(sender)

    tracker.track('org-1')
    tracker.reset()

    expect(tracker.track('org-1')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(2)
  })

  it('ignores a missing organization id', () => {
    const tracker = createPlansVisitTracker(sender)

    expect(tracker.track(undefined)).toBe(false)
    expect(sender).not.toHaveBeenCalled()
  })
})

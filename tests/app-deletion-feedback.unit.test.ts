import { describe, expect, it } from 'vitest'
import {
  canContinueAppDeletion,
  getAppDeletionTrackingProperties,
  isAppDeletionConfirmationValid,
} from '../src/utils/appDeletionFeedback'

describe('app deletion feedback', () => {
  it('requires a reason before continuing', () => {
    expect(canContinueAppDeletion({ reason: null })).toBe(false)
    expect(canContinueAppDeletion({ reason: 'duplicate_test' })).toBe(true)
    expect(canContinueAppDeletion({ reason: 'other' })).toBe(true)
  })

  it('requires an exact, case-sensitive app ID confirmation', () => {
    expect(isAppDeletionConfirmationValid('com.example.app', 'com.example.app')).toBe(true)
    expect(isAppDeletionConfirmationValid('com.example.App', 'com.example.app')).toBe(false)
    expect(isAppDeletionConfirmationValid(' com.example.app ', 'com.example.app')).toBe(false)
  })

  it('builds event properties and records the nested opt-out choice', () => {
    expect(getAppDeletionTrackingProperties({
      reason: 'other',
      detail: 'no_feedback',
      note: 'Previously entered feedback',
    }, {
      appId: 'com.example.app',
      orgId: 'example-org',
    })).toEqual({
      app_id: 'com.example.app',
      org_id: 'example-org',
      deletion_reason: 'other',
      deletion_detail: 'no_feedback',
      feedback_opt_out: true,
    })
  })
})

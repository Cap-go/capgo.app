import { describe, expect, it } from 'vitest'
import {
  AI_INSTRUCTIONS_COPIED_EVENT,
  buildAiInstructionsCopiedBentoEvent,
} from '../supabase/functions/_backend/utils/onboarding_copy_tracking.ts'

describe('onboarding copy tracking', () => {
  it.concurrent('builds a per-attempt Bento event for the allowlisted AI copy', () => {
    const attemptId = '7e64f484-4171-47b6-86f7-0ef5d49e0ef8'
    expect(buildAiInstructionsCopiedBentoEvent({
      appId: 'com.example.app',
      event: AI_INSTRUCTIONS_COPIED_EVENT,
      nonPersonTags: {
        flow: 'pre_org',
        onboarding_attempt_id: attemptId,
        onboarding_version: 2,
        resumed: false,
        setup_command: 'ota',
      },
      orgId: 'org-id',
    })).toEqual({
      data: {
        app_id: 'com.example.app',
        flow: 'pre_org',
        onboarding_attempt_id: attemptId,
        onboarding_version: 2,
        org_id: 'org-id',
        resumed: false,
        setup_command: 'ota',
      },
      event: 'app:ai_instructions_copied',
      once: true,
      preferenceKey: 'onboarding',
      uniqId: `app:ai_instructions_copied:com.example.app:${attemptId}`,
    })
  })

  it.concurrent('rejects arbitrary or incomplete events', () => {
    expect(buildAiInstructionsCopiedBentoEvent({
      appId: 'com.example.app',
      event: 'arbitrary_event',
      nonPersonTags: { onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8' },
      orgId: 'org-id',
    })).toBeUndefined()
    expect(buildAiInstructionsCopiedBentoEvent({
      appId: 'com.example.app',
      event: AI_INSTRUCTIONS_COPIED_EVENT,
      nonPersonTags: {},
      orgId: 'org-id',
    })).toBeUndefined()
  })
})

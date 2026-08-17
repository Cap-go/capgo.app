import { describe, expect, it } from 'vitest'
import {
  buildUserOnboardingProgress,
  clampResumableOnboardingStep,
  parseUserOnboardingProgress,
  shouldPromptOnboardingResume,
  USER_ONBOARDING_MAX_JSON_BYTES,
} from '../src/utils/userOnboardingProgress'

describe('user onboarding progress', () => {
  it.concurrent('parses saved wizard progress and rejects empty or invalid payloads', () => {
    expect(parseUserOnboardingProgress({})).toBeNull()
    expect(parseUserOnboardingProgress({ status: 'in_progress' })).toBeNull()
    expect(parseUserOnboardingProgress({
      status: 'nope',
      step: 'details',
      flow: 'pre_org',
    })).toBeNull()

    expect(parseUserOnboardingProgress({
      status: 'in_progress',
      step: 'organization',
      flow: 'pre_org',
      intent: 'ota',
      details_step: 'icon',
      app_name: 'Acme',
      app_id: 'com.acme.app',
      existing_app: false,
      org_name: 'Acme Org',
      onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
      last_run_id: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
      updated_at: '2026-08-15T00:00:00.000Z',
    })).toEqual({
      status: 'in_progress',
      step: 'organization',
      flow: 'pre_org',
      intent: 'ota',
      details_step: 'icon',
      app_name: 'Acme',
      app_id: 'com.acme.app',
      existing_app: false,
      org_name: 'Acme Org',
      onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
      last_run_id: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
      updated_at: '2026-08-15T00:00:00.000Z',
    })
  })

  it.concurrent('ignores malformed telemetry metadata without invalidating saved progress', () => {
    expect(parseUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      onboarding_attempt_id: 'not-an-attempt-id',
      last_run_id: 'ir_not-a-run-id',
      updated_at: '2026-08-15T00:00:00.000Z',
    })).toEqual({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      updated_at: '2026-08-15T00:00:00.000Z',
    })
  })

  it.concurrent('builds a compact jsonb payload without empty strings or icon data', () => {
    const progress = buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      intent: 'builder',
      detailsStep: 'app_id',
      appName: '  Hello  ',
      appId: '',
      existingApp: true,
      existingAppSetup: 'import',
      storeUrl: 'https://apps.apple.com/app/id123',
      orgName: '  ',
      onboardingAttemptId: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
      lastRunId: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })

    expect(progress).toEqual({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      intent: 'builder',
      details_step: 'app_id',
      app_name: 'Hello',
      existing_app: true,
      existing_app_setup: 'import',
      store_url: 'https://apps.apple.com/app/id123',
      onboarding_attempt_id: '7e64f484-4171-47b6-86f7-0ef5d49e0ef8',
      last_run_id: 'ir_6b735b41-f8ea-45b9-a46e-10c8be795276',
      updated_at: '2026-08-15T00:00:00.000Z',
    })
    expect(JSON.stringify(progress)).not.toContain('data:image')
  })

  it.concurrent('prompts to resume only after the user left the first empty step', () => {
    expect(shouldPromptOnboardingResume(null, 'pre_org')).toBe(false)
    expect(shouldPromptOnboardingResume(buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'intent',
      flow: 'pre_org',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }), 'pre_org')).toBe(false)
    expect(shouldPromptOnboardingResume(buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'intent',
      flow: 'pre_org',
      intent: 'ota',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }), 'pre_org')).toBe(true)
    expect(shouldPromptOnboardingResume(buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'organization',
      flow: 'pre_org',
      appName: 'Acme',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }), 'pre_org')).toBe(true)
    expect(shouldPromptOnboardingResume(buildUserOnboardingProgress({
      status: 'completed',
      step: 'setup',
      flow: 'pre_org',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }), 'pre_org')).toBe(false)
    expect(shouldPromptOnboardingResume(buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'existing_org',
      appName: 'Acme',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }), 'pre_org')).toBe(false)
  })

  it.concurrent('clamps post-org steps back to organization for the pre-org wizard', () => {
    expect(clampResumableOnboardingStep('setup', 'pre_org')).toBe('organization')
    expect(clampResumableOnboardingStep('install', 'existing_org')).toBe('install')
    expect(clampResumableOnboardingStep('details', 'pre_org')).toBe('details')
  })

  it.concurrent('clamps oversize optional strings before they can fail the jsonb check', () => {
    const parsed = parseUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      app_name: 'A'.repeat(1200),
      updated_at: '2026-08-15T00:00:00.000Z',
    })
    expect(parsed?.app_name).toHaveLength(1024)
  })

  it.concurrent('truncates optional strings on Unicode code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}'
    const boundary = `${'A'.repeat(1023)}${emoji}`
    expect(boundary.slice(0, 1024)).not.toBe(boundary)

    const kept = buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      appName: boundary,
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    expect(kept.app_name).toBe(boundary)

    const truncated = buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      appName: `${'A'.repeat(1024)}${emoji}`,
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    expect(truncated.app_name).toBe('A'.repeat(1024))
  })

  it.concurrent('keeps the built jsonb payload under the database byte limit', () => {
    const fourByteChar = '\u{1F600}'
    const progress = buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      appName: fourByteChar.repeat(1024),
      appId: fourByteChar.repeat(1024),
      storeUrl: fourByteChar.repeat(1024),
      importedStoreAppId: fourByteChar.repeat(1024),
      orgName: fourByteChar.repeat(1024),
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    expect(new TextEncoder().encode(JSON.stringify(progress)).length).toBeLessThanOrEqual(USER_ONBOARDING_MAX_JSON_BYTES)
  })
})

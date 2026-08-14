import { describe, expect, it } from 'vitest'
import {
  buildUserOnboardingProgress,
  clampResumableOnboardingStep,
  parseUserOnboardingProgress,
  shouldPromptOnboardingResume,
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
      app_name: 'Acme',
      app_id: 'com.acme.app',
      existing_app: false,
      org_name: 'Acme Org',
      updated_at: '2026-08-15T00:00:00.000Z',
    })).toEqual({
      status: 'in_progress',
      step: 'organization',
      flow: 'pre_org',
      intent: 'ota',
      app_name: 'Acme',
      app_id: 'com.acme.app',
      existing_app: false,
      org_name: 'Acme Org',
      updated_at: '2026-08-15T00:00:00.000Z',
    })
  })

  it.concurrent('builds a compact jsonb payload without empty strings or icon data', () => {
    const progress = buildUserOnboardingProgress({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      intent: 'builder',
      appName: '  Hello  ',
      appId: '',
      existingApp: true,
      existingAppSetup: 'import',
      storeUrl: 'https://apps.apple.com/app/id123',
      orgName: '  ',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })

    expect(progress).toEqual({
      status: 'in_progress',
      step: 'details',
      flow: 'pre_org',
      intent: 'builder',
      app_name: 'Hello',
      existing_app: true,
      existing_app_setup: 'import',
      store_url: 'https://apps.apple.com/app/id123',
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
})

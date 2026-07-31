import { beforeEach, describe, expect, it, vi } from 'vitest'

const syncBentoSubscriberTagsMock = vi.hoisted(() => vi.fn(async () => true))
const getOrgAdminMemberEmailsForTagsMock = vi.hoisted(() => vi.fn(async () => ({ emails: ['admin@capgo.app'], resolutionFailed: false })))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: vi.fn(() => true),
  syncBentoSubscriberTags: syncBentoSubscriberTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/org_email_notifications.ts', () => ({
  getOrgAdminMemberEmailsForTags: getOrgAdminMemberEmailsForTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => key === 'WEBAPP_URL' ? 'https://console.capgo.app/' : undefined,
  backgroundTask: async (_c: unknown, task: () => Promise<unknown>) => task(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(() => ({
    end: vi.fn(async () => undefined),
  })),
  getDrizzleClient: vi.fn(() => ({})),
}))

import {
  buildOnboardingIntentBentoEventData,
  buildOnboardingIntentBentoTags,
  parseOrgOnboardingIntent,
  syncOrgOnboardingIntentBentoTags,
  syncOrgOnboardingIntentForOrg,
} from '../supabase/functions/_backend/utils/org_onboarding_intent.ts'

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

describe('parseOrgOnboardingIntent', () => {
  it.concurrent('returns unknown for invalid payloads', () => {
    expect(parseOrgOnboardingIntent(null)).toBe('unknown')
    expect(parseOrgOnboardingIntent({})).toBe('unknown')
    expect(parseOrgOnboardingIntent({ intent: 'invalid' })).toBe('unknown')
  })

  it.concurrent('returns the stored intent when valid', () => {
    expect(parseOrgOnboardingIntent({ intent: 'ota' })).toBe('ota')
    expect(parseOrgOnboardingIntent({ intent: 'builder' })).toBe('builder')
    expect(parseOrgOnboardingIntent({ intent: 'both' })).toBe('both')
    expect(parseOrgOnboardingIntent({ intent: 'exploring' })).toBe('exploring')
  })
})

describe('buildOnboardingIntentBentoTags', () => {
  it.concurrent('activates one intent tag and removes the others', () => {
    expect(buildOnboardingIntentBentoTags('both')).toEqual({
      segments: ['onboarding_intent:both'],
      deleteSegments: [
        'onboarding_intent:unknown',
        'onboarding_intent:ota',
        'onboarding_intent:builder',
        'onboarding_intent:exploring',
      ],
    })
  })
})

describe('buildOnboardingIntentBentoEventData', () => {
  it.concurrent('includes intent-specific onboarding URLs for Bento emails', () => {
    const c = createContext()

    const ota = buildOnboardingIntentBentoEventData(c, 'ota', {
      id: 'org-1',
      name: 'Acme',
      website: 'https://acme.example/',
    })
    expect(ota.onboarding_intent).toBe('ota')
    expect(ota.onboarding_url).toBe('https://console.capgo.app/app/new')
    expect(ota.onboarding_url_ota).toBe('https://console.capgo.app/app/new')

    const builder = buildOnboardingIntentBentoEventData(c, 'builder', {
      id: 'org-1',
      name: 'Acme',
      website: 'https://acme.example/',
    })
    expect(builder.onboarding_url).toBe('https://console.capgo.app/apps')
    expect(builder.onboarding_url_builder).toBe('https://console.capgo.app/apps')
    expect(builder.onboarding_url_ota).toBe('https://console.capgo.app/app/new')
  })
})

describe('syncOrgOnboardingIntentBentoTags', () => {
  beforeEach(() => {
    syncBentoSubscriberTagsMock.mockClear()
  })

  it('writes one active intent tag per user subscriber profile', async () => {
    await syncOrgOnboardingIntentBentoTags(createContext(), 'builder', [
      'Admin@Capgo.app',
      'admin@capgo.app',
      'other@capgo.app',
    ])

    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      [
        {
          email: 'admin@capgo.app',
          segments: ['onboarding_intent:builder'],
          deleteSegments: [
            'onboarding_intent:unknown',
            'onboarding_intent:ota',
            'onboarding_intent:both',
            'onboarding_intent:exploring',
          ],
        },
        {
          email: 'other@capgo.app',
          segments: ['onboarding_intent:builder'],
          deleteSegments: [
            'onboarding_intent:unknown',
            'onboarding_intent:ota',
            'onboarding_intent:both',
            'onboarding_intent:exploring',
          ],
        },
      ],
    )
  })
})

describe('syncOrgOnboardingIntentForOrg', () => {
  beforeEach(() => {
    syncBentoSubscriberTagsMock.mockClear()
    getOrgAdminMemberEmailsForTagsMock.mockClear()
  })

  it('tags every org admin user resolved for the org', async () => {
    getOrgAdminMemberEmailsForTagsMock.mockResolvedValueOnce({
      emails: ['admin@capgo.app', 'billing@capgo.app'],
      resolutionFailed: false,
    })

    await syncOrgOnboardingIntentForOrg(createContext(), {
      id: 'org-1',
      management_email: 'billing@capgo.app',
      created_by: 'user-1',
      onboarding: { intent: 'ota' },
    })

    expect(getOrgAdminMemberEmailsForTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      expect.anything(),
    )
    expect(syncBentoSubscriberTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ email: 'admin@capgo.app', segments: ['onboarding_intent:ota'] }),
        expect.objectContaining({ email: 'billing@capgo.app', segments: ['onboarding_intent:ota'] }),
      ]),
    )
  })

})

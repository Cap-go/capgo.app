import { beforeEach, describe, expect, it, vi } from 'vitest'
import { put } from '../supabase/functions/_backend/public/app/put.ts'

const mocks = vi.hoisted(() => ({
  trackBentoEvent: vi.fn(async () => true),
  org: { onboarding: { intent: 'ota' } } as { onboarding: { intent: string } },
  orgSelect: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: vi.fn(async () => true),
}))

vi.mock('../supabase/functions/_backend/utils/demo.ts', () => ({
  lockOnboardingApp: vi.fn(async () => ({})),
  unlockOnboardingApp: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/appStatus.ts', () => ({
  deleteAppStatus: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', () => ({
  createIfNotExistStoreInfo: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  trackBentoEvent: mocks.trackBentoEvent,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseWithAuth: vi.fn(() => ({
    from: () => {
      let updated = false
      return {
        update() {
          updated = true
          return this
        },
        select() { return this },
        eq() { return this },
        single: async () => ({
          data: {
            app_id: 'com.example.pending',
            owner_org: 'org-id',
            name: 'Example app',
            need_onboarding: !updated,
            icon_url: '',
            onboarding: {},
          },
          error: null,
        }),
      }
    },
  })),
  supabaseAdmin: vi.fn(() => ({
    from: () => ({
      select(columns: string) {
        mocks.orgSelect(columns)
        return this
      },
      eq() { return this },
      single: async () => ({
        data: Object.fromEntries(
          ['management_email', 'name', 'website', 'onboarding']
            .filter(key => mocks.orgSelect.mock.lastCall?.[0].split(', ').includes(key))
            .map(key => [key, {
              management_email: 'owner@example.com',
              name: 'Example org',
              website: 'https://example.com',
              onboarding: mocks.org.onboarding,
            }[key as 'management_email' | 'name' | 'website' | 'onboarding']]),
        ),
        error: null,
      }),
    }),
  })),
}))

describe('pending onboarding Bento event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['ota', 'publish'])('preserves app:created with %s intent when pending onboarding completes', async (intent) => {
    mocks.org.onboarding = { intent }
    const context = {
      env: { WEBAPP_URL: 'https://console.example' },
      get: (key: string) => key === 'auth' ? { authType: 'jwt', userId: 'user-id' } : undefined,
      json: (data: unknown) => Response.json(data),
    } as any

    const response = await put(context, 'com.example.pending', { need_onboarding: false }, { key: 'test-key' } as any)

    expect(response.status).toBe(200)
    expect(mocks.trackBentoEvent).toHaveBeenCalledOnce()
    expect(mocks.trackBentoEvent).toHaveBeenCalledWith(context, 'owner@example.com', expect.objectContaining({
      app_name: 'Example app',
      onboarding_intent: intent,
      org_id: 'org-id',
      org_website: 'https://example.com',
    }), 'app:created')
  })
})

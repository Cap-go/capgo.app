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

// Caller RLS context: the pending app is loaded, then the update completes onboarding.
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: vi.fn(async (_c: unknown, _principal: unknown, run: (client: unknown, drizzle: unknown) => Promise<unknown>) => run({
      query: async (text: string) => ({
        rows: [{ row: {
          app_id: 'com.example.pending',
          owner_org: 'org-id',
          name: 'Example app',
          need_onboarding: !text.includes('UPDATE public.apps'),
          icon_url: '',
          onboarding: {},
        } }],
      }),
    }, {})),
  }
})

// Service connection for the org lookup: return only the selected columns.
vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  return {
    ...actual,
    closeClient: vi.fn(),
    getPgClient: vi.fn(async () => ({
      query: async (text: string) => {
        mocks.orgSelect(text)
        const org = {
          management_email: 'owner@example.com',
          name: 'Example org',
          website: 'https://example.com',
          onboarding: mocks.org.onboarding,
        }
        const columns = /SELECT (.+) FROM public\.orgs/.exec(text)?.[1].split(', ') ?? []
        return { rows: [Object.fromEntries(columns.map(key => [key, org[key as keyof typeof org]]))] }
      },
    })),
  }
})

describe('pending onboarding Bento event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(['ota', 'publish'])('preserves app:created with %s intent when pending onboarding completes', async (intent) => {
    mocks.org.onboarding = { intent }
    const context = {
      env: { WEBAPP_URL: 'https://console.example' },
      get: (key: string) => key === 'auth' ? { authType: 'jwt', userId: 'user-id', jwt: 'user-jwt' } : undefined,
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

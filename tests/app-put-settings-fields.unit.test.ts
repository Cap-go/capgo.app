import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(async () => true),
  deleteAppStatus: vi.fn(async () => undefined),
  lockOnboardingApp: vi.fn(async () => null),
  unlockOnboardingApp: vi.fn(async () => undefined),
  createSignedImageUrl: vi.fn(async () => ''),
  updatePayload: vi.fn(),
  channelSelect: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
  checkPermissionPg: vi.fn(async () => true),
}))

vi.mock('../supabase/functions/_backend/utils/appStatus.ts', () => ({
  deleteAppStatus: (...args: unknown[]) => mocks.deleteAppStatus(...args),
}))

vi.mock('../supabase/functions/_backend/utils/demo.ts', () => ({
  lockOnboardingApp: (...args: unknown[]) => mocks.lockOnboardingApp(...args),
  unlockOnboardingApp: (...args: unknown[]) => mocks.unlockOnboardingApp(...args),
}))

vi.mock('../supabase/functions/_backend/utils/storage.ts', () => ({
  createSignedImageUrl: (...args: unknown[]) => mocks.createSignedImageUrl(...args),
  getStorageAllowedOrigins: () => [],
  resolveWritableImageValue: () => undefined,
}))

function createSupabaseClientMock() {
  return {
    from: (table: string) => {
      if (table === 'channels') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: mocks.channelSelect,
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            app_id: 'com.example.app',
            owner_org: 'org-123',
            name: 'Example app',
            need_onboarding: false,
            onboarding: {},
          },
          error: null,
        }),
        update: (payload: unknown) => {
          mocks.updatePayload(payload)
          return {
            eq: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                app_id: 'com.example.app',
                owner_org: 'org-123',
                name: 'Example app',
                need_onboarding: false,
                onboarding: {},
                icon_url: '',
                allow_preview: true,
                build_timeout_seconds: 1800,
                default_upload_channel: 'production',
              },
              error: null,
            }),
          }
        },
      }
    },
  }
}

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseWithAuth: vi.fn(() => createSupabaseClientMock()),
  supabaseAdmin: vi.fn(),
  supabaseApikey: vi.fn(() => createSupabaseClientMock()),
}))

const { put } = await import('../supabase/functions/_backend/public/app/put.ts')

function createContext() {
  return {
    get: vi.fn((key: string) => key === 'auth' ? undefined : undefined),
    json: (body: unknown) => Response.json(body),
  } as any
}

describe('app put settings fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.channelSelect.mockResolvedValue({ data: { id: 7 }, error: null })
  })

  it('persists allow_preview, build_timeout_seconds, and default_upload_channel', async () => {
    const response = await put(createContext(), 'com.example.app', {
      allow_preview: true,
      build_timeout_seconds: 1800,
      default_upload_channel: 'production',
    }, { key: 'test-key' } as any)

    expect(response.status).toBe(200)
    expect(mocks.updatePayload).toHaveBeenCalledWith(expect.objectContaining({
      allow_preview: true,
      build_timeout_seconds: 1800,
      default_upload_channel: 'production',
    }))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  deleteAppStatus: vi.fn(),
  lockOnboardingApp: vi.fn(),
  unlockOnboardingApp: vi.fn(),
  createSignedImageUrl: vi.fn(),
  updatePayload: vi.fn(),
  callerChannelSelect: vi.fn(),
  channelPrincipal: vi.fn(),
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

const UPDATED_APP = {
  app_id: 'com.example.app',
  owner_org: 'org-123',
  name: 'Example app',
  need_onboarding: false,
  onboarding: {},
  icon_url: '',
  allow_preview: true,
  build_timeout_seconds: 1800,
  default_upload_channel: 'production',
}

// Direct Postgres under the caller's RLS context: route each statement by its SQL.
function createRlsClientMock(principal: unknown) {
  return {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes('FROM public.channels')) {
        mocks.channelPrincipal(principal)
        const { data } = await mocks.callerChannelSelect()
        return { rows: data ? [{ row: data }] : [] }
      }
      if (text.includes('UPDATE public.apps')) {
        mocks.updatePayload(JSON.parse(values[1] as string))
        return { rows: [{ row: UPDATED_APP }] }
      }
      if (text.includes('FROM public.apps')) {
        return { rows: [{ row: {
          app_id: 'com.example.app',
          owner_org: 'org-123',
          name: 'Example app',
          need_onboarding: false,
          onboarding: {},
        } }] }
      }
      throw new Error(`unexpected query ${text}`)
    }),
  }
}

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: vi.fn(async (_c: unknown, principal: unknown, run: (client: unknown, drizzle: unknown) => Promise<unknown>) => run(createRlsClientMock(principal), {})),
  }
})

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
    mocks.checkPermission.mockResolvedValue(true)
    mocks.deleteAppStatus.mockResolvedValue(undefined)
    mocks.lockOnboardingApp.mockResolvedValue(null)
    mocks.unlockOnboardingApp.mockResolvedValue(undefined)
    mocks.createSignedImageUrl.mockResolvedValue('')
    // Caller RLS hides channels (no channel.read); validation must not depend on it.
    mocks.callerChannelSelect.mockResolvedValue({ data: { id: 7 }, error: null })
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
    expect(mocks.callerChannelSelect).toHaveBeenCalled()
    expect(mocks.channelPrincipal).toHaveBeenCalledWith({ kind: 'apikey', apikey: 'test-key' })
  })

  it('rejects a default_upload_channel that does not exist for the app', async () => {
    mocks.callerChannelSelect.mockResolvedValue({ data: null, error: null })
    await expect(put(createContext(), 'com.example.app', {
      default_upload_channel: 'missing',
    }, { key: 'test-key' } as any)).rejects.toMatchObject({ status: 400, cause: { error: 'channel_not_found' } })
    expect(mocks.updatePayload).not.toHaveBeenCalled()
  })

  it.each([60, 6 * 60 * 60 + 1, Number.NaN, '900'])('rejects out-of-range build_timeout_seconds %s', async (value) => {
    await expect(put(createContext(), 'com.example.app', {
      build_timeout_seconds: value as number,
    }, { key: 'test-key' } as any)).rejects.toMatchObject({ status: 400, cause: { error: 'invalid_build_timeout_seconds' } })
    expect(mocks.updatePayload).not.toHaveBeenCalled()
  })

  it('accepts build_timeout_seconds at the range bounds and truncates fractions', async () => {
    await put(createContext(), 'com.example.app', { build_timeout_seconds: 300.9 }, { key: 'test-key' } as any)
    expect(mocks.updatePayload).toHaveBeenLastCalledWith(expect.objectContaining({ build_timeout_seconds: 300 }))
    await put(createContext(), 'com.example.app', { build_timeout_seconds: 21600 }, { key: 'test-key' } as any)
    expect(mocks.updatePayload).toHaveBeenLastCalledWith(expect.objectContaining({ build_timeout_seconds: 21600 }))
  })
})

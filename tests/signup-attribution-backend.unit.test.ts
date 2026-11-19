import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUserByIdMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/gotrue_admin.ts', () => ({
  gotrueAdmin: () => ({
    getUserById: getUserByIdMock,
  }),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
}))

describe('resolveSignupAttributionForOrg', () => {
  beforeEach(() => {
    getUserByIdMock.mockReset()
    vi.resetModules()
  })

  it('keeps org signup_plugin when creator lookup rejects', async () => {
    getUserByIdMock.mockRejectedValue(new Error('auth unavailable'))
    const { resolveSignupAttributionForOrg } = await import('../supabase/functions/_backend/utils/signup_attribution.ts')
    const context = { get: () => undefined } as unknown as import('hono').Context

    const attribution = await resolveSignupAttributionForOrg(context, {
      created_by: 'user-1',
      signup_plugin: 'capacitor-updater',
    })

    expect(attribution).toEqual({ signup_plugin: 'capacitor-updater' })
  })

  it('drops unsafe org signup_plugin values', async () => {
    getUserByIdMock.mockResolvedValue({ data: { user: { user_metadata: {} } }, error: null })
    const { resolveSignupAttributionForOrg } = await import('../supabase/functions/_backend/utils/signup_attribution.ts')
    const context = { get: () => undefined } as unknown as import('hono').Context

    const attribution = await resolveSignupAttributionForOrg(context, {
      created_by: 'user-1',
      signup_plugin: 'user@example.com',
    })

    expect(attribution).toEqual({})
  })

  it('prefers org signup_plugin over creator metadata plugin', async () => {
    getUserByIdMock.mockResolvedValue({
      data: {
        user: {
          user_metadata: {
            signup_plugin: 'from_creator',
            signup_source: 'plugin_from_creator',
          },
        },
      },
      error: null,
    })
    const { resolveSignupAttributionForOrg } = await import('../supabase/functions/_backend/utils/signup_attribution.ts')
    const context = { get: () => undefined } as unknown as import('hono').Context

    const attribution = await resolveSignupAttributionForOrg(context, {
      created_by: 'user-1',
      signup_plugin: 'org-stored',
    })

    expect(attribution.signup_plugin).toBe('org-stored')
    expect(attribution.signup_source).toBe('plugin_from_creator')
  })
})

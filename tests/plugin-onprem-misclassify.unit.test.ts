import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookupAppOwnerPostgresMock = vi.fn()
const setAppStatusMock = vi.fn(() => Promise.resolve())
const getAppStatusMock = vi.fn(async () => ({
  status: 'onprem' as const,
  allow_device_custom_id: true,
  block_provider_infra_requests: false,
  cacheHit: true,
  onprem_retry_reset_at: Date.now() + 3_600_000,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')>()
  return {
    ...actual,
    lookupAppOwnerPostgres: lookupAppOwnerPostgresMock,
  }
})

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: getAppStatusMock,
  setAppStatus: setAppStatusMock,
  deleteAppStatus: vi.fn(() => Promise.resolve()),
}))

describe('plugin on-prem misclassification guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('self-heals worker onprem cache when replica finds a valid cloud app', async () => {
    lookupAppOwnerPostgresMock.mockResolvedValue({
      status: 'found',
      owner: {
        owner_org: 'org-1',
        plan_valid: true,
        channel_device_count: 0,
        manifest_bundle_count: 0,
        rollout_channel_count: 0,
        rollout_paused_version_names: [],
        expose_metadata: false,
        allow_device_custom_id: true,
        block_provider_infra_requests: false,
        orgs: { created_by: 'user-1', id: 'org-1', management_email: 'owner@example.com' },
      },
    })

    const { tryHealCachedOnpremAppOwner } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_app_classification.ts')
    const result = await tryHealCachedOnpremAppOwner(
      { get: () => undefined, req: { raw: { cf: {} } } } as any,
      'com.dopaminquest.app',
      {} as any,
      ['mau', 'bandwidth'],
      {
        status: 'onprem',
        allow_device_custom_id: true,
        block_provider_infra_requests: false,
        cacheHit: true,
      },
    )

    expect(result.kind).toBe('healed')
    expect(setAppStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'com.dopaminquest.app',
      'cloud',
      true,
      false,
    )
  })

  it('returns upstream on replica lookup errors instead of sticky onprem', async () => {
    lookupAppOwnerPostgresMock.mockResolvedValue({ status: 'error' })

    const { tryHealCachedOnpremAppOwner } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_app_classification.ts')
    const result = await tryHealCachedOnpremAppOwner(
      { get: () => undefined, req: { raw: { cf: {} } } } as any,
      'com.dopaminquest.app',
      {} as any,
      ['mau', 'bandwidth'],
      {
        status: 'onprem',
        allow_device_custom_id: true,
        block_provider_infra_requests: false,
        cacheHit: true,
      },
    )

    expect(result.kind).toBe('upstream')
    expect(setAppStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'com.dopaminquest.app',
      'onprem',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('reclassifies sticky onprem to cancelled when replica finds app but plan is invalid', async () => {
    lookupAppOwnerPostgresMock.mockResolvedValue({
      status: 'found',
      owner: {
        owner_org: 'org-1',
        plan_valid: false,
        channel_device_count: 0,
        manifest_bundle_count: 0,
        rollout_channel_count: 0,
        rollout_paused_version_names: [],
        expose_metadata: false,
        allow_device_custom_id: true,
        block_provider_infra_requests: false,
        orgs: { created_by: 'user-1', id: 'org-1', management_email: 'owner@example.com' },
      },
    })

    const { tryHealCachedOnpremAppOwner } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_app_classification.ts')
    const result = await tryHealCachedOnpremAppOwner(
      { get: () => undefined, req: { raw: { cf: {} } } } as any,
      'com.dopaminquest.app',
      {} as any,
      ['mau', 'bandwidth'],
      {
        status: 'onprem',
        allow_device_custom_id: true,
        block_provider_infra_requests: false,
        cacheHit: true,
      },
    )

    expect(result.kind).toBe('cancelled')
    expect(setAppStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      'com.dopaminquest.app',
      'cancelled',
      true,
      false,
    )
  })
})

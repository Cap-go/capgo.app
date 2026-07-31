import { beforeEach, describe, expect, it, vi } from 'vitest'

const hasCliPermissionMock = vi.hoisted(() => vi.fn())

vi.mock('../cli/src/utils', () => ({
  getPMAndCommand: () => ({ runner: 'bunx' }),
  hasCliPermission: hasCliPermissionMock,
  show2FADeniedError: vi.fn(() => {
    throw new Error('2FA required')
  }),
}))

const { checkAppExistsAndHasPermissionOrgErr } = await import('../cli/src/api/app')

function createSupabaseMock(exists = true) {
  const rpcCalls = vi.fn(async (name: string) => {
    if (name === 'exist_app_v2')
      return { data: exists, error: null }

    return { data: false, error: null }
  })

  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === 'exist_app_v2') {
        return {
          single: vi.fn(async () => {
            await rpcCalls(name, args)
            return { data: exists, error: null }
          }),
        }
      }

      return rpcCalls(name, args)
    },
    rpcCalls,
  }
}

describe('CLI app permission helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasCliPermissionMock.mockResolvedValue(true)
  })

  it('does not require app-wide read before channel-scoped RBAC checks', async () => {
    const supabase = createSupabaseMock(false)

    await expect(checkAppExistsAndHasPermissionOrgErr(
      supabase as any,
      'test-key',
      'com.test.app',
      'channel.delete',
      true,
      true,
      123,
    )).resolves.toBe(true)

    expect(supabase.rpcCalls).not.toHaveBeenCalledWith('exist_app_v2', expect.anything())
    expect(hasCliPermissionMock).toHaveBeenCalledWith(supabase, 'test-key', 'channel.delete', {
      appId: 'com.test.app',
      channelId: 123,
    })
  })

  it('keeps the app existence precheck for app-scoped RBAC checks', async () => {
    const supabase = createSupabaseMock(false)

    await expect(checkAppExistsAndHasPermissionOrgErr(
      supabase as any,
      'test-key',
      'com.missing.app',
      'app.delete',
      true,
      true,
    )).rejects.toThrow('App com.missing.app does not exist')

    expect(supabase.rpcCalls).toHaveBeenCalledWith('exist_app_v2', { appid: 'com.missing.app' })
    expect(hasCliPermissionMock).not.toHaveBeenCalled()
  })
})

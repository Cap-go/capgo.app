import { beforeEach, describe, expect, it, vi } from 'vitest'

const hasCliPermissionMock = vi.hoisted(() => vi.fn())
const invokeCapgoCliApiMock = vi.hoisted(() => vi.fn())
const getCapgoCliHttpStatusMock = vi.hoisted(() => vi.fn())

vi.mock('../cli/src/utils', () => ({
  appAddHintMessage: (appId: string) => `App ${appId} does not exist, run first \`bunx @capgo/cli app add ${appId}\` to create it`,
  getPMAndCommand: () => ({ runner: 'bunx' }),
  hasCliPermission: hasCliPermissionMock,
  invokeCapgoCliApi: invokeCapgoCliApiMock,
  getCapgoCliHttpStatus: getCapgoCliHttpStatusMock,
  show2FADeniedError: vi.fn(() => {
    throw new Error('2FA required')
  }),
}))

const { checkAppExistsAndHasPermissionOrgErr } = await import('../cli/src/api/app')

function createSupabaseMock() {
  return {
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseKey: 'test-anon',
    rpc: vi.fn(),
  }
}

describe('CLI app permission helper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hasCliPermissionMock.mockResolvedValue(true)
    getCapgoCliHttpStatusMock.mockReturnValue(404)
    invokeCapgoCliApiMock.mockResolvedValue({ data: null, error: Object.assign(new Error('missing'), { context: { status: 404 } }) })
  })

  it('does not require app-wide read before channel-scoped RBAC checks', async () => {
    const supabase = createSupabaseMock()

    await expect(checkAppExistsAndHasPermissionOrgErr(
      supabase as any,
      'test-key',
      'com.test.app',
      'channel.delete',
      true,
      true,
      123,
    )).resolves.toBe(true)

    expect(invokeCapgoCliApiMock).not.toHaveBeenCalled()
    expect(hasCliPermissionMock).toHaveBeenCalledWith(supabase, 'test-key', 'channel.delete', {
      appId: 'com.test.app',
      channelId: 123,
    })
  })

  it('keeps the app existence precheck for app-scoped RBAC checks', async () => {
    const supabase = createSupabaseMock()

    await expect(checkAppExistsAndHasPermissionOrgErr(
      supabase as any,
      'test-key',
      'com.missing.app',
      'app.delete',
      true,
      true,
    )).rejects.toThrow('App com.missing.app does not exist')

    expect(invokeCapgoCliApiMock).toHaveBeenCalledWith('app/com.missing.app', expect.objectContaining({
      apikey: 'test-key',
      method: 'GET',
      supaHost: 'http://127.0.0.1:54321',
      supaAnon: 'test-anon',
    }))
    expect(hasCliPermissionMock).not.toHaveBeenCalled()
  })
})

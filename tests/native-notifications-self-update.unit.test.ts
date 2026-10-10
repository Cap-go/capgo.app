import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SELF_NOTIFICATION_APP_IDS, getSelfNotificationAppIds } from '../supabase/functions/_backend/private/notification_self_proof.ts'

const mocks = vi.hoisted(() => ({
  appState: { isActive: false },
  backgroundListener: null as null | ((event: unknown) => void),
  configure: vi.fn(async () => {}),
  enableUpdaterIntegration: vi.fn(async () => {}),
  register: vi.fn(async () => ({})),
  runUpdateCheck: vi.fn(async () => ({ status: 'installed', version: '1.2.3' })),
  invokeCapgoApi: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@capacitor/app', () => ({
  App: {
    getInfo: vi.fn(async () => ({ id: 'ee.forgr.capacitor_go' })),
    getState: vi.fn(async () => mocks.appState),
  },
}))
vi.mock('@capgo/capacitor-notifications', () => ({
  CapgoNotifications: {
    addListener: vi.fn(async (eventName: string, listener: (event: unknown) => void) => {
      if (eventName === 'backgroundNotification')
        mocks.backgroundListener = listener
      return { remove: async () => {} }
    }),
    configure: mocks.configure,
    enableUpdaterIntegration: mocks.enableUpdaterIntegration,
    register: mocks.register,
    runUpdateCheck: mocks.runUpdateCheck,
  },
}))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: mocks.invokeCapgoApi }))
vi.mock('~/services/supabase', () => ({ defaultApiHost: 'https://api.capgo.app' }))

const { registerNativeNotifications, resolveUpdateInstallMode, setupNativeNotifications } = await import('../src/services/nativeNotifications.ts')

async function pushBackground(data: Record<string, unknown>) {
  const finish = vi.fn(async () => {})
  mocks.backgroundListener?.({ notification: { id: 'n1', data }, finish })
  await vi.waitFor(() => expect(finish).toHaveBeenCalled())
  return finish
}

describe('capgo app native notifications', () => {
  beforeEach(async () => {
    mocks.appState.isActive = false
    mocks.runUpdateCheck.mockClear()
    mocks.register.mockClear()
    mocks.invokeCapgoApi.mockReset()
    await setupNativeNotifications()
  })

  it('turns the plugin update handler off before configuring the bridge', () => {
    expect(mocks.enableUpdaterIntegration).toHaveBeenCalledWith({ enabled: false })
    expect(mocks.enableUpdaterIntegration.mock.invocationCallOrder[0]).toBeLessThan(mocks.configure.mock.invocationCallOrder[0])
    expect(mocks.configure).toHaveBeenCalledWith({ appId: 'ee.forgr.capacitor_go', serverUrl: 'https://api.capgo.app', autoUpdater: false })
  })

  it('applies the update right away when the push arrives in the background', async () => {
    const finish = await pushBackground({ capgoAction: 'update_check', capgoUpdateChannel: 'dev' })
    expect(mocks.runUpdateCheck).toHaveBeenCalledWith({ enabled: true, installMode: 'set' })
    expect(finish).toHaveBeenCalledWith('newData')
  })

  it('queues the update for later while the user is using the app', async () => {
    mocks.appState.isActive = true
    await pushBackground({ capgoAction: 'update_check', capgoUpdateInstallMode: 'set' })
    expect(mocks.runUpdateCheck).toHaveBeenCalledWith({ enabled: true, installMode: 'next' })
  })

  it('leaves the update to the native plugin when it already ran it', async () => {
    const finish = await pushBackground({ capgoAction: 'update_check', capgoNativeUpdateCheck: 'queued' })
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith('newData')
  })

  it('falls back to the JavaScript update when the native updater is unsupported', async () => {
    await pushBackground({ capgoAction: 'update_check', capgoNativeUpdateCheck: 'unsupported' })
    expect(mocks.runUpdateCheck).toHaveBeenCalled()
  })

  it('ignores background pushes that are not update checks', async () => {
    const finish = await pushBackground({ capgoAction: 'background' })
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledWith('noData')
  })

  it('reports a failed update check to the OS', async () => {
    mocks.runUpdateCheck.mockResolvedValueOnce({ status: 'failed', error: 'boom' } as never)
    const finish = await pushBackground({ capgoAction: 'update_check' })
    expect(finish).toHaveBeenCalledWith('failed')
  })

  it('registers the signed-in user with a server minted proof', async () => {
    mocks.invokeCapgoApi.mockResolvedValueOnce({ data: { appId: 'ee.forgr.capacitor_go', externalId: 'user-1', identityProof: 'proof' }, error: null })
    await registerNativeNotifications('user-1')
    expect(mocks.invokeCapgoApi).toHaveBeenCalledWith('private/notification_self_proof', { method: 'POST', body: { appId: 'ee.forgr.capacitor_go' } })
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'user-1', identityProof: 'proof', serverUrl: 'https://api.capgo.app' }))

    await registerNativeNotifications('user-1')
    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(1)
  })

  it('does not register when the proof belongs to another user', async () => {
    mocks.invokeCapgoApi.mockResolvedValueOnce({ data: { appId: 'ee.forgr.capacitor_go', externalId: 'someone-else', identityProof: 'proof' }, error: null })
    await registerNativeNotifications('user-2')
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('resolves the install mode from app state', () => {
    expect(resolveUpdateInstallMode('', false)).toBe('set')
    expect(resolveUpdateInstallMode('next', false)).toBe('next')
    expect(resolveUpdateInstallMode('set', true)).toBe('next')
  })
})

describe('notification self proof app allow-list', () => {
  it('defaults to the Capgo app and accepts an override list', () => {
    expect(getSelfNotificationAppIds(undefined)).toEqual(DEFAULT_SELF_NOTIFICATION_APP_IDS)
    expect(getSelfNotificationAppIds(' com.a.app , ,com.b.app')).toEqual(['com.a.app', 'com.b.app'])
  })
})

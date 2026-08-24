import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  getSession: vi.fn(),
  invokeCapgoApi: vi.fn(),
  onDialogDismiss: vi.fn(),
  openDialog: vi.fn(),
  openWindow: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.getPlatform },
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})

vi.mock('vue-sonner', () => ({
  toast: { error: mocks.toastError },
}))

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: mocks.invokeCapgoApi,
}))

vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => ({
    onDialogDismiss: mocks.onDialogDismiss,
    openDialog: mocks.openDialog,
  }),
}))

vi.mock('../src/services/supabase', () => ({
  useSupabase: () => ({ auth: { getSession: mocks.getSession } }),
}))

interface TestDialogOptions {
  buttons: Array<{
    id?: string
    handler?: () => Promise<void>
  }>
}

function confirmHandler(dialogIndex: number) {
  const dialog = mocks.openDialog.mock.calls[dialogIndex]?.[0] as TestDialogOptions
  const handler = dialog.buttons.find(button => button.id === 'confirm-button')?.handler
  expect(handler).toBeDefined()
  return handler!
}

describe('stripe portal URL cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('location', { href: 'https://app.example/billing' })
    vi.stubGlobal('open', mocks.openWindow)
    mocks.getPlatform.mockReturnValue('web')
    mocks.getSession.mockResolvedValue({ data: { session: {} }, error: null })
    mocks.onDialogDismiss.mockResolvedValue(undefined)
    mocks.openWindow.mockReturnValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens the confirmation dialog before a pending portal request resolves', async () => {
    mocks.getSession.mockReturnValue(new Promise(() => {}))
    mocks.invokeCapgoApi.mockReturnValue(new Promise(() => {}))
    const { openPortal } = await import('../src/services/stripe')

    void openPortal('org-a', ((key: string) => key) as never)

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(1)
    expect(mocks.openDialog).toHaveBeenCalledTimes(1)
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('shows the existing error toast when the portal request rejects', async () => {
    mocks.invokeCapgoApi.mockRejectedValue(new Error('portal unavailable'))
    const { openPortal } = await import('../src/services/stripe')

    await openPortal('org-a', ((key: string) => key) as never)
    await expect(confirmHandler(0)()).resolves.toBeUndefined()

    expect(mocks.toastError).toHaveBeenCalledWith('Cannot open your portal')
    expect(mocks.openWindow).not.toHaveBeenCalled()
  })

  it('reuses a successful URL for the same organization under three minutes', async () => {
    mocks.invokeCapgoApi.mockResolvedValue({ data: { url: 'https://portal.example/one' }, error: null })
    const { openPortal } = await import('../src/services/stripe')
    const t = ((key: string) => key) as never

    await openPortal('org-a', t)
    await confirmHandler(0)()
    vi.advanceTimersByTime(179_999)
    await openPortal('org-a', t)
    await confirmHandler(1)()

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(1)
    expect(mocks.openWindow).toHaveBeenNthCalledWith(1, 'https://portal.example/one', '_blank')
    expect(mocks.openWindow).toHaveBeenNthCalledWith(2, 'https://portal.example/one', '_blank')
  })

  it('fetches a fresh URL at three minutes', async () => {
    mocks.invokeCapgoApi
      .mockResolvedValueOnce({ data: { url: 'https://portal.example/one' }, error: null })
      .mockResolvedValueOnce({ data: { url: 'https://portal.example/two' }, error: null })
    const { openPortal } = await import('../src/services/stripe')
    const t = ((key: string) => key) as never

    await openPortal('org-a', t)
    await confirmHandler(0)()
    vi.advanceTimersByTime(180_000)
    await openPortal('org-a', t)
    await confirmHandler(1)()

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(2)
    expect(mocks.openWindow).toHaveBeenLastCalledWith('https://portal.example/two', '_blank')
  })

  it('fetches a fresh URL when the callback URL changes', async () => {
    mocks.invokeCapgoApi
      .mockResolvedValueOnce({ data: { url: 'https://portal.example/billing' }, error: null })
      .mockResolvedValueOnce({ data: { url: 'https://portal.example/settings' }, error: null })
    const { openPortal } = await import('../src/services/stripe')
    const t = ((key: string) => key) as never

    await openPortal('org-a', t)
    await confirmHandler(0)()
    globalThis.location.href = 'https://app.example/settings'
    await openPortal('org-a', t)
    await confirmHandler(1)()

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(2)
    expect(mocks.invokeCapgoApi).toHaveBeenLastCalledWith('private/stripe_portal', {
      body: JSON.stringify({ callbackUrl: 'https://app.example/settings', orgId: 'org-a' }),
    })
    expect(mocks.openWindow).toHaveBeenLastCalledWith('https://portal.example/settings', '_blank')
  })

  it('never reuses a cached URL for another organization', async () => {
    mocks.invokeCapgoApi
      .mockResolvedValueOnce({ data: { url: 'https://portal.example/org-a' }, error: null })
      .mockResolvedValueOnce({ data: { url: 'https://portal.example/org-b' }, error: null })
    const { openPortal } = await import('../src/services/stripe')
    const t = ((key: string) => key) as never

    await openPortal('org-a', t)
    await confirmHandler(0)()
    await openPortal('org-b', t)
    await confirmHandler(1)()
    await openPortal('org-a', t)
    await confirmHandler(2)()

    expect(mocks.invokeCapgoApi).toHaveBeenCalledTimes(2)
    expect(mocks.openWindow).toHaveBeenNthCalledWith(1, 'https://portal.example/org-a', '_blank')
    expect(mocks.openWindow).toHaveBeenNthCalledWith(2, 'https://portal.example/org-b', '_blank')
    expect(mocks.openWindow).toHaveBeenNthCalledWith(3, 'https://portal.example/org-a', '_blank')
  })
})

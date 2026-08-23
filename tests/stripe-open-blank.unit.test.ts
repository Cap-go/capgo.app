import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  onDialogDismiss: vi.fn(),
  openDialog: vi.fn(),
  openWindow: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.getPlatform },
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => {
      throw new SyntaxError('26')
    },
  }
})

vi.mock('vue-sonner', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: vi.fn(),
}))

vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => ({
    onDialogDismiss: mocks.onDialogDismiss,
    openDialog: mocks.openDialog,
  }),
}))

vi.mock('../src/services/supabase', () => ({
  useSupabase: () => ({ auth: { getSession: vi.fn() } }),
}))

interface TestDialogOptions {
  title: string
  description?: string
  buttons: Array<{
    text: string
    id?: string
    role?: string
    href?: string
    handler?: () => Promise<void>
  }>
}

describe('stripe openBlank i18n', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('open', mocks.openWindow)
    mocks.getPlatform.mockReturnValue('web')
    mocks.onDialogDismiss.mockResolvedValue(true)
    mocks.openWindow.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('translates popup-blocked fallback without useI18n in an async handler', async () => {
    const { openBlank } = await import('../src/services/stripe')

    const handler = async () => {
      return openBlank('https://checkout.stripe.com/session')
    }

    await expect(handler()).resolves.toBe(false)

    const dialog = mocks.openDialog.mock.calls[0]?.[0] as TestDialogOptions
    expect(dialog.title).toBe('Open in new tab')
    expect(dialog.description).toBe('Your browser blocked the new tab. Confirm to open it.')
    expect(dialog.buttons.map(button => button.text)).toEqual([
      'Cancel',
      'Confirm',
    ])
    expect(dialog.buttons[1]?.href).toBe('https://checkout.stripe.com/session')
  })

  it('translates ios action sheet fallback without useI18n in an async handler', async () => {
    mocks.getPlatform.mockReturnValue('ios')
    mocks.onDialogDismiss.mockResolvedValue(false)
    const { openBlank } = await import('../src/services/stripe')

    const handler = async () => {
      return openBlank('https://checkout.stripe.com/session')
    }

    await expect(handler()).resolves.toBe(true)

    const dialog = mocks.openDialog.mock.calls[0]?.[0] as TestDialogOptions
    expect(dialog.title).toBe('Open in new tab')
    expect(dialog.buttons.map(button => button.text)).toEqual([
      'Cancel',
      'Continue',
    ])
  })
})

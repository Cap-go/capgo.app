import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  changeLocale: vi.fn(),
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@formkit/vue', () => ({
  changeLocale: mocks.changeLocale,
}))

vi.mock('vue-sonner', () => ({
  toast: mocks.toast,
}))

describe('i18n remote message loading', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.changeLocale.mockReset()
    mocks.toast.error.mockReset()
    mocks.toast.info.mockReset()
    vi.stubGlobal('localStorage', {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        innerHTML: '',
      })),
      documentElement: {
        setAttribute: vi.fn(),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps the current locale and shows a pending toast when the backend is still preparing translations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 })))

    const { changeLanguage } = await import('../src/services/i18n.ts')
    const { i18n } = await import('../src/modules/i18n.ts')

    const selectedLanguage = await changeLanguage('fr')

    expect(selectedLanguage).toBe('en')
    expect(i18n.global.locale.value).toBe('en')
    expect(mocks.changeLocale).not.toHaveBeenCalled()
    expect(mocks.toast.info).toHaveBeenCalledWith('Translation is being prepared. Try again in a bit.')
  })

  it('keeps the current locale and shows an unavailable toast when the backend fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'translation_unavailable' }), { status: 503 })))

    const { changeLanguage } = await import('../src/services/i18n.ts')
    const { i18n } = await import('../src/modules/i18n.ts')

    const selectedLanguage = await changeLanguage('fr')

    expect(selectedLanguage).toBe('en')
    expect(i18n.global.locale.value).toBe('en')
    expect(mocks.changeLocale).not.toHaveBeenCalled()
    expect(mocks.toast.error).toHaveBeenCalledWith('This language is not available right now.')
  })

  it('keeps the stored startup locale when backend translation is pending', async () => {
    const stored = new Map<string, string>([['lang', 'fr']])
    const setItem = vi.fn((key: string, value: string) => stored.set(key, value))
    vi.stubGlobal('localStorage', {
      clear: vi.fn(() => stored.clear()),
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      removeItem: vi.fn((key: string) => stored.delete(key)),
      setItem,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 })))

    const { install, i18n } = await import('../src/modules/i18n.ts')

    install({ app: { use: vi.fn() } } as any)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(i18n.global.locale.value).toBe('en')
    expect(stored.get('lang')).toBe('fr')
    expect(setItem).not.toHaveBeenCalledWith('lang', 'en')
  })

  it('loads backend messages before switching locale', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: {
        'credits-flexibility-cta-description': 'Depassez les limites de votre plan en achetant des credits si besoin.',
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { changeLanguage } = await import('../src/services/i18n.ts')
    const { i18n } = await import('../src/modules/i18n.ts')

    const selectedLanguage = await changeLanguage('fr')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const request = JSON.parse(init.body as string) as { targetLanguage?: string }

    expect(selectedLanguage).toBe('fr')
    expect(i18n.global.locale.value).toBe('fr')
    expect(mocks.changeLocale).toHaveBeenCalledWith('fr')
    expect(request).toEqual({ targetLanguage: 'fr' })
    expect(i18n.global.t('credits-flexibility-cta-description')).toBe(
      'Depassez les limites de votre plan en achetant des credits si besoin.',
    )
  })
})

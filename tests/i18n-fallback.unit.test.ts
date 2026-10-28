import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('vue-sonner', () => ({
  toast: mocks.toast,
}))

describe('i18n remote message loading', () => {
  beforeEach(() => {
    vi.resetModules()
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
    expect(mocks.toast.info).toHaveBeenCalledWith('Translation is being prepared. Try again in a bit.')
  })

  it('keeps the current locale and shows an unavailable toast when the backend fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'translation_unavailable' }), { status: 503 })))

    const { changeLanguage } = await import('../src/services/i18n.ts')
    const { i18n } = await import('../src/modules/i18n.ts')

    const selectedLanguage = await changeLanguage('fr')

    expect(selectedLanguage).toBe('en')
    expect(i18n.global.locale.value).toBe('en')
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
    expect(request).toEqual({ targetLanguage: 'fr' })
    expect(i18n.global.t('credits-flexibility-cta-description')).toBe(
      'Depassez les limites de votre plan en achetant des credits si besoin.',
    )
  })

  it('caches the catalog by checksum and revalidates it on the next load', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      clear: vi.fn(() => stored.clear()),
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      removeItem: vi.fn((key: string) => stored.delete(key)),
      setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      checksum: 'abc',
      messages: { 'just-now': 'Tout de suite' },
      status: 'ready',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await import('../src/modules/i18n.ts')
    await first.loadLanguageAsync('fr')
    expect(first.readCachedCatalog('fr')?.checksum).toBe('abc')

    // Fresh page load: the catalog comes from localStorage, the worker only confirms the checksum.
    vi.resetModules()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ checksum: 'abc', status: 'not_modified' }), { status: 200 }))
    const second = await import('../src/modules/i18n.ts')
    await second.loadLanguageAsync('fr')

    expect(second.i18n.global.t('just-now')).toBe('Tout de suite')
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ targetLanguage: 'fr', checksum: 'abc' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(second.readCachedCatalog('fr')?.messages).toEqual({ 'just-now': 'Tout de suite' })
  })
  it('keeps the newly selected locale in the cache when an older revalidation lands late', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      clear: vi.fn(() => stored.clear()),
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      removeItem: vi.fn((key: string) => stored.delete(key)),
      setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
    })
    stored.set('capgo_i18n_catalog', JSON.stringify({ checksum: 'old', lang: 'fr', messages: { 'just-now': 'Tout de suite' } }))
    let releaseFrench: (response: Response) => void = () => {}
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { targetLanguage } = JSON.parse(init.body as string) as { targetLanguage: string }
      if (targetLanguage === 'fr')
        return new Promise<Response>((resolve) => { releaseFrench = resolve })
      return new Response(JSON.stringify({ checksum: 'de1', messages: { 'just-now': 'Gerade eben' }, status: 'ready' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { loadLanguageAsync, readCachedCatalog } = await import('../src/modules/i18n.ts')
    await loadLanguageAsync('fr')
    await loadLanguageAsync('de')
    releaseFrench(new Response(JSON.stringify({ checksum: 'new', messages: { 'just-now': 'Tout de suite' }, status: 'ready' }), { status: 200 }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(readCachedCatalog('de')?.checksum).toBe('de1')
    expect(readCachedCatalog('fr')).toBeNull()
  })
  it('keeps a newer language selection when a slower load finishes later', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      clear: vi.fn(() => stored.clear()),
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      removeItem: vi.fn((key: string) => stored.delete(key)),
      setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
    })
    let releaseFrench: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { targetLanguage } = JSON.parse(init.body as string) as { targetLanguage: string }
      if (targetLanguage === 'fr')
        return new Promise<Response>((resolve) => { releaseFrench = resolve })
      return new Response(JSON.stringify({ checksum: 'de1', messages: { 'just-now': 'Gerade eben' }, status: 'ready' }), { status: 200 })
    }))

    const { i18n, loadLanguageAsync } = await import('../src/modules/i18n.ts')
    const slowFrench = loadLanguageAsync('fr')
    await loadLanguageAsync('de')
    releaseFrench(new Response(JSON.stringify({ checksum: 'fr1', messages: { 'just-now': 'Tout de suite' }, status: 'ready' }), { status: 200 }))

    await expect(slowFrench).resolves.toBe('de')
    expect(i18n.global.locale.value).toBe('de')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('document navigation lifecycle', () => {
  let navigation: typeof import('../src/services/documentNavigation')
  let browserWindow: EventTarget
  const replace = vi.fn()

  beforeEach(async () => {
    vi.resetModules()
    replace.mockReset()
    browserWindow = Object.assign(new EventTarget(), { location: { replace } })
    vi.stubGlobal('window', browserWindow)
    navigation = await import('../src/services/documentNavigation')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('retains departure state through initial load and clears it on a cached-page restore', () => {
    navigation.replaceDocument('https://auth.example/verify')
    expect(replace).toHaveBeenCalledWith('https://auth.example/verify')
    expect(navigation.isDocumentNavigationPending()).toBe(true)
    browserWindow.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }))
    expect(navigation.isDocumentNavigationPending()).toBe(true)
    browserWindow.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    expect(navigation.isDocumentNavigationPending()).toBe(false)
  })

  it('allows recovery again if the browser rejects the navigation', () => {
    replace.mockImplementationOnce(() => {
      throw new Error('Navigation blocked')
    })
    expect(() => navigation.replaceDocument('https://auth.example/verify')).toThrow('Navigation blocked')
    expect(navigation.isDocumentNavigationPending()).toBe(false)
  })
})

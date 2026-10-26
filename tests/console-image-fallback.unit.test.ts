// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const mockGetSession = vi.fn()
const mockInvoke = vi.fn()

vi.mock('../src/services/console.ts', () => ({
  defaultApiHost: 'https://api.example.com',
  useConsole: () => ({
    auth: { getSession: mockGetSession },
    functions: { invoke: mockInvoke },
    storage: { from: vi.fn() },
  }),
}))

const RELAY = 'https://api.example.com/private/console/images/read'

function relayUrl(path: string, token: string) {
  const url = new URL(RELAY)
  url.searchParams.set('path', path)
  url.searchParams.set('t', token)
  return url.href
}

function fail(image: HTMLImageElement) {
  image.dispatchEvent(new Event('error'))
}

describe('console image fallback', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    document.body.innerHTML = ''
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: USER_ID } } }, error: null })
    mockInvoke.mockResolvedValue({ data: { data: { token: 'fresh', expiresAt: Math.floor(Date.now() / 1000) + 12 * 3600 }, error: null }, error: null })
    const { installConsoleImageFallback } = await import('../src/services/storage.ts')
    installConsoleImageFallback()
  })

  it('retries an expired relay URL once with a current token', async () => {
    const image = document.createElement('img')
    image.src = relayUrl('org/o/logo/a.png', 'expired')
    document.body.appendChild(image)

    fail(image)
    await vi.waitFor(() => expect(image.src).toBe(relayUrl('org/o/logo/a.png', 'fresh')))
    expect(image.style.visibility).toBe('')

    // The retried URL failing too means the image is really unavailable.
    fail(image)
    expect(image.style.visibility).toBe('hidden')
  })

  it('hides a missing image instead of looping when the token is already current', async () => {
    const image = document.createElement('img')
    image.src = relayUrl('org/o/logo/missing.png', 'fresh')
    document.body.appendChild(image)

    fail(image)
    await vi.waitFor(() => expect(image.style.visibility).toBe('hidden'))
    expect(image.src).toBe(relayUrl('org/o/logo/missing.png', 'fresh'))
  })

  it('shows a reused element again once it loads a working image', async () => {
    const image = document.createElement('img')
    image.src = relayUrl('org/o/logo/missing.png', 'fresh')
    document.body.appendChild(image)
    fail(image)
    await vi.waitFor(() => expect(image.style.visibility).toBe('hidden'))

    image.src = relayUrl('org/o/logo/present.png', 'fresh')
    image.dispatchEvent(new Event('load'))
    expect(image.style.visibility).toBe('')
  })

  it('ignores images that are not served by the console relay', async () => {
    const image = document.createElement('img')
    image.src = 'https://cdn.example.org/logo.png'
    document.body.appendChild(image)

    fail(image)
    await Promise.resolve()
    expect(image.style.visibility).toBe('')
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getEnvMock } = vi.hoisted(() => ({ getEnvMock: vi.fn() }))
const defaultEnv = (_c: unknown, key: string) => key === 'BUILDER_URL' ? 'https://builder.test' : 'builder-key'

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: getEnvMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn((error: unknown) => String(error)),
}))

const { getBuildVariants, toBuildVariantsResponse } = await import('../supabase/functions/_backend/public/build/variants.ts')

const builderBody = {
  defaultXcodeMajor: '26',
  variants: [
    { platform: 'ios', id: 'xcode-27.1-linux', xcodeVersion: '27.1', macosVersion: null, backend: 'linux', runners: 1, online: 1, default: false },
    { platform: 'ios', id: 'xcode-26.2-macos-26.1', xcodeVersion: '26.2', macosVersion: '26.1', backend: 'mac', runners: 3, online: 2, default: true },
  ],
}

function context() {
  return {
    get: vi.fn(() => 'test-request-id'),
    json: vi.fn((body: unknown, status = 200) => new Response(JSON.stringify(body), { status })),
  }
}

describe('toBuildVariantsResponse', () => {
  it('maps the builder body to snake_case and never exposes non-Mac machines', () => {
    expect(JSON.stringify(toBuildVariantsResponse(builderBody))).not.toMatch(/linux|backend/i)
    expect(toBuildVariantsResponse(builderBody)).toEqual({
      default_xcode_major: '26',
      variants: [
        { platform: 'ios', id: 'xcode-26.2-macos-26.1', xcode_version: '26.2', macos_version: '26.1', runners: 3, online: 2, default: true },
      ],
    })
  })

  it('rejects an unexpected builder body', () => {
    expect(() => toBuildVariantsResponse({ variants: 'nope' })).toThrow()
  })

  it.each([
    ['xcodeVersion', '26; rm -rf ~'],
    ['xcodeVersion', '26 && curl x'],
    ['macosVersion', '$(id)'],
  ])('rejects a %s that is not a dotted version (%s)', (field, value) => {
    const body = { ...builderBody, variants: [{ ...builderBody.variants[1], [field]: value }] }
    expect(() => toBuildVariantsResponse(body)).toThrow()
  })
})

describe('getBuildVariants', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    getEnvMock.mockImplementation(defaultEnv)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the variants from the builder with its API key', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(builderBody), { status: 200 }))
    const response = await getBuildVariants(context() as any, 'ios')
    expect(fetchMock).toHaveBeenCalledWith('https://builder.test/variants', expect.objectContaining({ headers: { 'x-api-key': 'builder-key' } }))
    const body = await response.json() as { variants: Array<{ xcode_version: string }> }
    expect(body.variants.map(v => v.xcode_version)).toEqual(['26.2'])
  })

  it('returns no variants for Android without calling the builder', async () => {
    const response = await getBuildVariants(context() as any, 'android')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ default_xcode_major: null, variants: [] })
  })

  it('rejects an unknown platform', async () => {
    await expect(getBuildVariants(context() as any, 'windows')).rejects.toMatchObject({ status: 400 })
  })

  it('answers 503 when the builder fails', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(getBuildVariants(context() as any, 'ios')).rejects.toMatchObject({ status: 503 })
  })

  it('answers 503 when the builder is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('network'))
    await expect(getBuildVariants(context() as any)).rejects.toMatchObject({ status: 503 })
  })

  it('answers 503 when the builder body is malformed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ variants: [{ xcodeVersion: '26; echo hacked' }] }), { status: 200 }))
    await expect(getBuildVariants(context() as any, 'ios')).rejects.toMatchObject({ status: 503 })
  })

  it.each(['BUILDER_URL', 'BUILDER_API_KEY'])('answers 503 without calling the builder when %s is missing', async (missing) => {
    getEnvMock.mockImplementation((c: unknown, key: string) => key === missing ? '' : defaultEnv(c, key))
    await expect(getBuildVariants(context() as any, 'ios')).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changelogDigest, getReleases } from '../supabase/functions/_backend/private/changelog.ts'
import { dependencySource, getDependency } from '../supabase/functions/_backend/utils/changelog_dependencies.ts'

const edge = new Map<string, { response: Response, expires: number }>()
const shared = new Map<string, { value: string, expires: number }>()
const kv = {
  get: vi.fn(async (key: string) => {
    const hit = shared.get(key)
    return hit && hit.expires > Date.now() ? JSON.parse(hit.value) : null
  }),
  put: vi.fn(async (key: string, value: string, options: { expirationTtl: number }) => {
    shared.set(key, { value, expires: Date.now() + options.expirationTtl * 1000 })
  }),
}
const ai = { run: vi.fn() }
const fetchMock = vi.fn()
let notes: string

const app = new Hono<MiddlewareKeyVariables>()
app.use('*', async (c, next) => {
  c.set('auth', { userId: c.req.header('X-Test-User') ?? '00000000-0000-4000-8000-000000000001', authType: 'jwt', apikey: null, jwt: null })
  c.set('requestId', 'changelog-test')
  await next()
})
app.post('/digest', async c => c.json(await changelogDigest(c, await c.req.json())))
app.get('/dependency', async c => c.json(await getDependency(c, c.req.query('name'))))
app.get('/releases', async c => c.json(await getReleases(c, { owner: 'ionic-team', repo: 'capacitor', tagPrefix: '' })))
app.get('/plugin-releases', async (c) => {
  const dependency = await getDependency(c, '@capacitor/camera')
  if (!dependency.source)
    throw new Error('Missing test repository')
  return c.json(await getReleases(c, dependency.source))
})

function digest(body: Record<string, unknown> = {}, env: Record<string, unknown> = {}, user?: string) {
  return app.request('https://api.example.com/digest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...user ? { 'X-Test-User': user } : {} },
    body: JSON.stringify({ product: 'capacitor', fromVersion: '8.0.0', toVersion: '8.1.0', ...body }),
  }, { AI: ai, CHANNEL_SELF_STORE: kv, ...env })
}

beforeEach(() => {
  edge.clear()
  shared.clear()
  vi.clearAllMocks()
  notes = '### Bug Fixes\n* **android:** fix startup crash'
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (key: Request) => {
        const hit = edge.get(key.url)
        return hit && hit.expires > Date.now() ? hit.response.clone() : undefined
      },
      put: async (key: Request, response: Response) => {
        const ttl = Number(/s-maxage=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')?.[1])
        edge.set(key.url, { response: response.clone(), expires: Date.now() + ttl * 1000 })
      },
    }),
  })
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('https://registry.npmjs.org/'))
      return Response.json({ name: '@capacitor/camera', version: '8.1.0', repository: { url: 'git+https://github.com/ionic-team/capacitor-camera.git' } })
    return Response.json([{ tag_name: '8.1.0', body: notes, html_url: 'https://github.com/ionic-team/capacitor/releases/tag/8.1.0' }])
  })
  vi.stubGlobal('fetch', fetchMock)
  ai.run.mockResolvedValue({ response: { headline: 'Android startup fixes.', highlights: [{ title: 'Startup crash', detail: 'Fixed on Android.', version: '8.1.0', type: 'fixed', impact: 'medium', relevant: false }], actionRequired: [] } })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('shared changelog caching', () => {
  it('shares concurrent release and AI misses, then reuses the summary for another user and colo', async () => {
    const responses = await Promise.all([digest(), digest(), digest()])
    for (const response of responses)
      expect(await response.json()).toMatchObject({ aiGenerated: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(ai.run).toHaveBeenCalledOnce()
    expect(kv.put).toHaveBeenCalledWith(expect.stringMatching(/^changelog:digest:/), expect.any(String), { expirationTtl: 604800 })
    edge.clear()
    expect(await (await digest({}, {}, '00000000-0000-4000-8000-000000000002')).json()).toMatchObject({ aiGenerated: true })
    expect(ai.run).toHaveBeenCalledOnce()
  })

  it('invalidates summaries for edited notes, models, locales and version bounds', async () => {
    await digest()
    notes = '### Bug Fixes\n* **android:** fix startup crash and preserve settings'
    edge.clear()
    await digest()
    vi.stubEnv('CHANGELOG_MODEL', 'test-model')
    await digest()
    vi.unstubAllEnvs()
    await digest({ locale: 'fr' })
    await digest({ fromVersion: '8.0.1' })
    expect(ai.run).toHaveBeenCalledTimes(5)
  })

  it('canonicalizes context order so equivalent requests reuse one AI summary', async () => {
    await digest({ context: { platforms: ['ios', 'android'], features: ['delta', 'encryption'] } })
    await digest({ context: { features: ['encryption', 'delta'], platforms: ['android', 'ios', 'android'] } })
    expect(ai.run).toHaveBeenCalledOnce()
  })

  it('backs off briefly after AI failure and recovers instead of caching a fallback for a week', async () => {
    ai.run.mockResolvedValueOnce({ response: '' })
    expect(await (await digest()).json()).toMatchObject({ aiGenerated: false })
    expect(await (await digest()).json()).toMatchObject({ aiGenerated: false })
    expect(ai.run).toHaveBeenCalledOnce()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    expect(await (await digest()).json()).toMatchObject({ aiGenerated: true })
    expect(ai.run).toHaveBeenCalledTimes(2)
  })
})

describe('public dependency sources', () => {
  it('summarizes third-party releases as their own dependency rather than a Capgo plugin', async () => {
    await digest({ product: 'dependency', repo: '@capacitor/camera' })
    expect(ai.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('a Capacitor dependency (ionic-team/capacitor-camera)') })]),
    }))
  })

  it('uses and caches CHANGELOG.md when a plugin has no GitHub Releases', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('registry.npmjs.org'))
        return Response.json({ name: '@capacitor/camera', version: '8.1.0', repository: { url: 'git+https://github.com/ionic-team/capacitor-camera.git' } })
      if (url.includes('/contents/'))
        return new Response('## [8.1.0] (2026-11-01)\n### Bug Fixes\n* Fix Android startup crash')
      return Response.json([])
    })
    const response = await app.request('https://api.example.com/plugin-releases')
    expect(await response.json()).toMatchObject({ releases: [{ version: '8.1.0', sections: [{ type: 'fixed', items: ['Fix Android startup crash'] }] }] })
    await app.request('https://api.example.com/plugin-releases')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(ai.run).not.toHaveBeenCalled()
  })

  it('accepts npm GitHub coordinates and rejects credentials, other hosts and traversals', () => {
    expect(dependencySource({ name: '@capacitor/camera', version: '8.0.0', repository: { url: 'git+https://github.com/ionic-team/capacitor-camera.git' } })).toMatchObject({ owner: 'ionic-team', repo: 'capacitor-camera' })
    for (const url of ['https://github.com.evil.example/a/b', 'https://user:password@github.com/a/b', 'https://github.com/a/../../b', 'https://example.com/a/b'])
      expect(dependencySource({ name: 'test-plugin', version: '1.0.0', repository: url })).toBeNull()
  })

  it('caches npm lookups and never forwards the GitHub token to external repositories', async () => {
    const url = 'https://api.example.com/dependency?name=%40capacitor%2Fcamera'
    await app.request(url)
    await app.request(url)
    expect(fetchMock).toHaveBeenCalledOnce()
    vi.stubEnv('GITHUB_TOKEN', 'fake-github-token')
    await app.request('https://api.example.com/releases')
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/ionic-team/capacitor/releases'), expect.objectContaining({ headers: expect.not.objectContaining({ Authorization: expect.anything() }) }))
  })

  it('rejects non-package input before making an outbound request', async () => {
    await app.request('https://api.example.com/dependency?name=..%2Fsecret')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

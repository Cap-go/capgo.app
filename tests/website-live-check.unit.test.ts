import { describe, expect, it } from 'vitest'
import { checkWebsiteLive, fetchPublicWebsite, isBlockedWebsiteHost } from '../supabase/functions/_backend/utils/website_live_check.ts'

const SPA = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#119eff">
<meta name="application-name" content="Acme &amp; Co">
<title>Acme dashboard</title>
<script type="module" src="/assets/index-abc.js"></script>
<link rel="stylesheet" href="/assets/index-abc.css">
</head><body><div id="app"></div></body></html>`

function site(pages: Record<string, { status?: number, body?: string, headers?: Record<string, string> }>) {
  const requested: string[] = []
  const fetchImpl = async (input: string) => {
    requested.push(input)
    const page = pages[input]
    if (!page)
      throw new TypeError(`getaddrinfo ENOTFOUND ${new URL(input).hostname}`)
    return new Response(page.body ?? '', { status: page.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...page.headers } })
  }
  return { fetchImpl, requested }
}

function statusOf(result: Awaited<ReturnType<typeof checkWebsiteLive>>, id: string) {
  return result.checks.find(check => check.id === id)?.status
}

describe('website live check', () => {
  it('accepts a static SPA and reads the listing details', async () => {
    const { fetchImpl } = site({ 'https://app.example.com/': { body: SPA } })
    const result = await checkWebsiteLive('https://app.example.com/', fetchImpl)
    expect(result.compatible).toBe(true)
    expect(result.rendering).toBe('Static SPA')
    expect(result.checks.every(check => check.status === 'pass')).toBe(true)
    expect(result.details).toEqual({ app_name: 'Acme & Co', theme_color: '#119EFF' })
  })

  it('shortens long page titles to a store name', async () => {
    const { fetchImpl } = site({ 'https://app.example.com/': { body: '<html><head><title>Acme Tasks | The fastest way to plan your week</title></head></html>' } })
    expect((await checkWebsiteLive('https://app.example.com/', fetchImpl)).details.app_name).toBe('Acme Tasks')
  })

  it('rejects server-rendered pages', async () => {
    const { fetchImpl } = site({
      'https://app.example.com/': {
        body: '<html><head><title>x</title></head><body><script>window.__NUXT__={}</script></body></html>',
        headers: { 'set-cookie': 'laravel_session=abc; Path=/' },
      },
    })
    const result = await checkWebsiteLive('https://app.example.com/', fetchImpl)
    expect(result.compatible).toBe(false)
    expect(result.rendering).toBe('server-rendered')
    const shell = result.checks.find(check => check.id === 'static_shell')!
    expect(shell.status).toBe('fail')
    expect(shell.detail).toContain('Nuxt')
    expect(shell.detail).toContain('laravel_session')
  })

  it('rejects per-user pages', async () => {
    const noStore = site({ 'https://app.example.com/': { body: SPA, headers: { 'cache-control': 'private, no-store' } } })
    expect(statusOf(await checkWebsiteLive('https://app.example.com/', noStore.fetchImpl), 'cacheable')).toBe('fail')
    const varyCookie = site({ 'https://app.example.com/': { body: SPA, headers: { vary: 'Accept-Encoding, Cookie' } } })
    expect(statusOf(await checkWebsiteLive('https://app.example.com/', varyCookie.fetchImpl), 'cacheable')).toBe('fail')
  })

  it('warns about external scripts, service workers, cookies and a missing viewport', async () => {
    const { fetchImpl } = site({
      'https://app.example.com/': {
        body: '<html><head><title>x</title><script src="https://cdn.example.net/app.js"></script><script>navigator.serviceWorker.register("/sw.js")</script></head><body></body></html>',
        headers: { 'set-cookie': 'theme=dark' },
      },
    })
    const result = await checkWebsiteLive('https://app.example.com/', fetchImpl)
    expect(result.compatible).toBe(true)
    expect(statusOf(result, 'same_origin_assets')).toBe('warning')
    expect(statusOf(result, 'service_worker')).toBe('warning')
    expect(statusOf(result, 'cookies')).toBe('warning')
    expect(statusOf(result, 'mobile_viewport')).toBe('warning')
  })

  it('follows redirects on the same origin and fails redirects to another origin', async () => {
    const same = site({
      'https://app.example.com/': { status: 302, headers: { location: '/index.html' } },
      'https://app.example.com/index.html': { body: SPA },
    })
    expect((await checkWebsiteLive('https://app.example.com/', same.fetchImpl)).compatible).toBe(true)

    const other = site({
      'https://app.example.com/': { status: 301, headers: { location: 'https://www.example.com/' } },
      'https://www.example.com/': { body: SPA },
    })
    const result = await checkWebsiteLive('https://app.example.com/', other.fetchImpl)
    expect(result.compatible).toBe(false)
    expect(statusOf(result, 'same_origin')).toBe('fail')
  })

  it('never follows redirects to private hosts or plain HTTP', async () => {
    for (const location of ['https://metadata.internal/', 'http://app.example.com/', 'https://localhost/']) {
      const { fetchImpl, requested } = site({ 'https://app.example.com/': { status: 302, headers: { location } } })
      const result = await checkWebsiteLive('https://app.example.com/', fetchImpl)
      expect(result.compatible).toBe(false)
      expect(requested).toEqual(['https://app.example.com/'])
    }
  })

  it('reports unreachable websites and error pages', async () => {
    const down = site({})
    const result = await checkWebsiteLive('https://down.example.com/', down.fetchImpl)
    expect(result.compatible).toBe(false)
    expect(result.checks).toEqual([expect.objectContaining({ id: 'public_html', status: 'fail' })])

    const notFound = site({ 'https://app.example.com/': { status: 404 } })
    expect((await checkWebsiteLive('https://app.example.com/', notFound.fetchImpl)).checks[0].detail).toContain('404')

    const json = site({ 'https://app.example.com/': { body: '{}', headers: { 'content-type': 'application/json' } } })
    expect((await checkWebsiteLive('https://app.example.com/', json.fetchImpl)).checks[0].detail).toContain('application/json')
  })

  it('stops after too many redirects', async () => {
    const { fetchImpl } = site({ 'https://app.example.com/': { status: 302, headers: { location: '/' } } })
    await expect(fetchPublicWebsite('https://app.example.com/', { accept: '*/*' }, fetchImpl)).rejects.toThrow('too many times')
  })

  it('blocks local and internal host names', () => {
    for (const host of ['localhost', 'api.localhost', 'printer.local', 'metadata.internal', 'nas.lan', 'router.home.arpa', 'LOCALHOST.'])
      expect(isBlockedWebsiteHost(host)).toBe(true)
    for (const host of ['app.example.com', 'localhost-app.com', 'internal.example.com'])
      expect(isBlockedWebsiteHost(host)).toBe(false)
  })

  it('blocks IP literals and single-label hosts', () => {
    for (const host of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '8.8.8.8', '[::1]', '[fd00:ec2::254]', '[::ffff:7f00:1]', 'metadata', ''])
      expect(isBlockedWebsiteHost(host), host).toBe(true)
  })

  it('never follows redirects to IP literals, including shorthand forms', async () => {
    for (const location of ['https://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/', 'https://metadata/', 'https://user:pass@app.example.com/']) {
      const { fetchImpl, requested } = site({ 'https://app.example.com/': { status: 301, headers: { location } } })
      await expect(fetchPublicWebsite('https://app.example.com/', { accept: '*/*' }, fetchImpl), location).rejects.toThrow('Refusing to fetch')
      expect(requested).toEqual(['https://app.example.com/'])
    }
  })

  it('validates every hop of a redirect chain', async () => {
    const { fetchImpl, requested } = site({
      'https://app.example.com/': { status: 302, headers: { location: 'https://www.example.com/' } },
      'https://www.example.com/': { status: 307, headers: { location: 'https://127.0.0.1/' } },
    })
    await expect(fetchPublicWebsite('https://app.example.com/', { accept: '*/*' }, fetchImpl)).rejects.toThrow('Refusing to fetch')
    expect(requested).toEqual(['https://app.example.com/', 'https://www.example.com/'])
  })

  it('ignores invalid numeric entities instead of crashing', async () => {
    const { fetchImpl } = site({ 'https://app.example.com/': { body: '<html><head><title>Acme &#99999999; &#xD800; &#x41;pp</title></head></html>' } })
    const result = await checkWebsiteLive('https://app.example.com/', fetchImpl)
    expect(result.details.app_name).toBe('Acme � � App')
  })

  it('accepts XHTML responses', async () => {
    const { fetchImpl } = site({ 'https://app.example.com/': { body: SPA, headers: { 'content-type': 'Application/XHTML+XML; charset=utf-8' } } })
    expect((await checkWebsiteLive('https://app.example.com/', fetchImpl)).compatible).toBe(true)
    const textPlain = site({ 'https://app.example.com/': { body: SPA, headers: { 'content-type': 'text/plain; x=text/html' } } })
    expect((await checkWebsiteLive('https://app.example.com/', textPlain.fetchImpl)).compatible).toBe(false)
  })

  it('treats plain session and sid cookies as server sessions', async () => {
    for (const cookie of ['session=abc; Path=/', 'sid=abc; Path=/']) {
      const { fetchImpl } = site({ 'https://app.example.com/': { body: SPA, headers: { 'set-cookie': cookie } } })
      const result = await checkWebsiteLive('https://app.example.com/', fetchImpl)
      expect(statusOf(result, 'static_shell'), cookie).toBe('fail')
    }
  })

  it('accepts statically generated Nuxt sites and rejects Nuxt SSR', async () => {
    const generated = site({ 'https://app.example.com/': { body: '<html><head><meta name="viewport" content="width=device-width"></head><body><div id="__nuxt" data-server-rendered="true"></div><script>window.__NUXT__={staticAssetsBase:"/_nuxt/static/1"}</script></body></html>' } })
    expect(statusOf(await checkWebsiteLive('https://app.example.com/', generated.fetchImpl), 'static_shell')).toBe('pass')
    // Include Nuxt SSR markers so the static exception (prerenderedAt) is what keeps this passing.
    const prerendered = site({ 'https://app.example.com/': { body: '<html><body><div id="__nuxt" data-server-rendered="true"></div><script>window.__NUXT__={}</script><script type="application/json" id="__NUXT_DATA__" data-ssr="true">[{"prerenderedAt":1}]</script></body></html>' } })
    expect(statusOf(await checkWebsiteLive('https://app.example.com/', prerendered.fetchImpl), 'static_shell')).toBe('pass')
    const ssr = site({ 'https://app.example.com/': { body: '<html><body><div id="__nuxt" data-server-rendered="true"></div><script>window.__NUXT__={serverRendered:true}</script></body></html>' } })
    expect(statusOf(await checkWebsiteLive('https://app.example.com/', ssr.fetchImpl), 'static_shell')).toBe('fail')
  })
})

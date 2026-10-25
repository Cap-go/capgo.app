/**
 * Web2App compatibility check. The app downloads the website root and its
 * same-origin assets and runs them offline, so the root must be the same static
 * app shell for every user. Rules come from the capacitor-website-updater CLI
 * check and standard website-to-app domain checks.
 */

export type WebsiteCheckStatus = 'pass' | 'warning' | 'fail'

export interface WebsiteCheckItem {
  id: string
  status: WebsiteCheckStatus
  essential: boolean
  detail: string
}

export interface WebsiteCheckResult {
  url: string
  final_url: string
  compatible: boolean
  rendering: string
  checks: WebsiteCheckItem[]
  /** Suggested store listing values read from the page. */
  details: {
    app_name: string | null
    theme_color: string | null
  }
  checked_at: string
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const TIMEOUT_MS = 15_000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/**
 * Hostnames the API must never fetch, even when they look like public domains.
 * IP literals are always refused: a Web2App website is a public domain with an
 * HTTPS certificate, and refusing every IP literal also covers loopback,
 * private, link-local, CGNAT and cloud metadata addresses (169.254.169.254,
 * fd00:ec2::254) without a range table. WHATWG URL parsing already normalizes
 * shorthand forms such as `https://2130706433/` or `https://0x7f.1/` to dotted
 * IPv4, so they are caught here too. Single-label hosts (`metadata`, `kubernetes`)
 * only resolve on internal networks and are refused as well.
 */
export function isBlockedWebsiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || !host.includes('.') || host.includes(':') || host.startsWith('['))
    return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host))
    return true
  return host === 'localhost' || BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/**
 * Fetch with a timeout and manual redirects. Every hop, including the first,
 * must be HTTPS to a non-blocked host name without credentials, and at most
 * MAX_REDIRECTS hops are followed.
 *
 * Limit: Workers and Supabase edge `fetch` resolve DNS themselves and do not
 * expose the resolved address, so a public name that resolves to a private
 * address (DNS rebinding) cannot be detected here. That case relies on the
 * runtime's egress isolation from internal networks.
 */
export async function fetchPublicWebsite(url: string, init: { accept: string, timeoutMs?: number }, fetchImpl: FetchLike = fetch) {
  const signal = AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS)
  let current = new URL(url)
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== 'https:' || isBlockedWebsiteHost(current.hostname) || current.username || current.password)
      throw new Error(`Refusing to fetch ${current.href}`)
    const response = await fetchImpl(current.href, {
      redirect: 'manual',
      signal,
      headers: { 'Accept': init.accept, 'User-Agent': 'Capgo-Website-Live/1.0' },
    })
    const location = response.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      return { response, finalUrl: current.href, redirects }
    await response.body?.cancel()
    if (redirects >= MAX_REDIRECTS)
      throw new Error('The website redirected too many times')
    current = new URL(location, current)
  }
}

async function readText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel()
    throw new Error('The HTML page is too large')
  }
  if (!response.body)
    return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error('The HTML page is too large')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function getAttribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
}

/** Invalid numeric entities (out of range or surrogates) decode to U+FFFD instead of throwing. */
function fromCodePoint(point: number): string {
  return Number.isInteger(point) && point >= 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF)
    ? String.fromCodePoint(point)
    : '\uFFFD'
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function metaContent(html: string, attribute: string, value: string): string {
  const tag = (html.match(/<meta\b[^>]*>/gi) ?? []).find(candidate => getAttribute(candidate, attribute).toLowerCase() === value)
  return tag ? decodeHtml(getAttribute(tag, 'content')) : ''
}

function getSetCookieNames(headers: Headers): string[] {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter((value): value is string => !!value)
  return values.map(value => value.split('=', 1)[0]?.trim() ?? '').filter(Boolean)
}

const SESSION_COOKIE = /^(?:phpsessid|jsessionid|asp\.net_sessionid|connect\.sid|sessionid|session|sid|rack\.session|.*_session)$/i

function detectServerRendering(html: string, headers: Headers): string[] {
  const lower = html.toLowerCase()
  const reasons: string[] = []
  if (headers.get('x-nextjs-cache'))
    reasons.push('Next.js server cache header (x-nextjs-cache)')
  if (/\b(?:rsc|next-router-state-tree|next-router-prefetch)\b/i.test(headers.get('vary') ?? ''))
    reasons.push('Next.js App Router server components (Vary: RSC)')
  const nextData = /<script\b[^>]*\sid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  if (nextData && /"(?:gssp|gip|appGip)"\s*:\s*true/.test(nextData))
    reasons.push('Next.js getServerSideProps data')
  // `nuxt generate` output carries the same markers, plus a prerender/static payload
  // flag; client-only Nuxt builds mark the payload as not server-rendered.
  const nuxtStatic = lower.includes('prerenderedat') || lower.includes('staticassetsbase')
    || /\bdata-ssr=["']false["']/.test(lower) || /\bserverrendered["']?\s*:\s*(?:false|!1)\b/.test(lower)
  if ((lower.includes('data-server-rendered') || lower.includes('__nuxt__')) && !nuxtStatic)
    reasons.push('Nuxt server-rendered payload')
  if (lower.includes('__remix_context'))
    reasons.push('Remix server context')
  if (lower.includes('$_tsr') && /\bssr\s*:\s*(?:!0|true)\b/.test(lower))
    reasons.push('TanStack Start SSR payload')
  if (/\bng-server-context\s*=\s*["']ssr["']/i.test(html))
    reasons.push('Angular SSR (ng-server-context="ssr")')
  if (lower.includes('data-page=') && lower.includes('&quot;component&quot;'))
    reasons.push('Inertia.js server-driven page')
  const sessionCookie = getSetCookieNames(headers).find(name => SESSION_COOKIE.test(name))
  if (sessionCookie)
    reasons.push(`server session cookie ${sessionCookie}`)
  return reasons
}

function detectRendering(lower: string): string {
  if (lower.includes('$_tsr'))
    return 'TanStack Start (static)'
  if (lower.includes('/_next/static/'))
    return 'Next.js static export'
  if (lower.includes('/_astro/') || lower.includes('astro-island'))
    return 'Astro (static)'
  if (lower.includes('ng-version') || lower.includes('<app-root'))
    return 'Angular SPA'
  if (lower.includes('type="module"') || lower.includes('/assets/'))
    return 'Static SPA'
  return 'Static HTML'
}

function externalBootAssets(html: string, origin: string): string[] {
  const external = new Set<string>()
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const isScript = /^<script/i.test(tag)
    if (!isScript && !getAttribute(tag, 'rel').toLowerCase().split(/\s+/).includes('stylesheet'))
      continue
    const reference = getAttribute(tag, isScript ? 'src' : 'href')
    if (!reference)
      continue
    try {
      const url = new URL(decodeHtml(reference), origin)
      if (!url.host)
        continue
      if (url.origin !== origin)
        external.add(url.host)
    }
    catch {}
  }
  return [...external]
}

/** Store names are at most 30 characters: keep the part before " - " or " | " when the title is longer. */
function shortAppName(name: string): string | null {
  const short = name.length > 30 ? name.split(/\s[-|\u2013\u2014:]\s/)[0]! : name
  return short.slice(0, 30).trim() || null
}

function item(id: string, status: WebsiteCheckStatus, essential: boolean, detail: string): WebsiteCheckItem {
  return { id, status, essential, detail }
}

function result(url: string, finalUrl: string, rendering: string, checks: WebsiteCheckItem[], details: WebsiteCheckResult['details'] = { app_name: null, theme_color: null }): WebsiteCheckResult {
  return {
    url,
    final_url: finalUrl,
    compatible: !checks.some(check => check.essential && check.status === 'fail'),
    rendering,
    checks,
    details,
    checked_at: new Date().toISOString(),
  }
}

/** Check that the website root can be cached and run as a Web2App app shell. */
export async function checkWebsiteLive(websiteUrl: string, fetchImpl: FetchLike = fetch): Promise<WebsiteCheckResult> {
  const root = new URL(websiteUrl)
  let response: Response
  let finalUrl: string
  let html: string
  try {
    const fetched = await fetchPublicWebsite(root.href, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }, fetchImpl)
    response = fetched.response
    finalUrl = fetched.finalUrl
    if (!response.ok) {
      await response.body?.cancel()
      return result(root.href, finalUrl, 'unknown', [item('public_html', 'fail', true, `The website answered HTTP ${response.status}.`)])
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^\s*(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i.test(contentType)) {
      await response.body?.cancel()
      return result(root.href, finalUrl, 'unknown', [item('public_html', 'fail', true, `The website did not return HTML (Content-Type: ${contentType || 'missing'}).`)])
    }
    html = await readText(response, MAX_HTML_BYTES)
  }
  catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const detail = timedOut ? 'The website did not answer within 15 seconds.' : `The website could not be reached: ${error instanceof Error ? error.message : String(error)}`
    return result(root.href, root.href, 'unknown', [item('public_html', 'fail', true, detail)])
  }

  const lower = html.toLowerCase()
  const finalOrigin = new URL(finalUrl).origin
  const headers = response.headers
  const checks: WebsiteCheckItem[] = [item('public_html', 'pass', true, `The website returned an HTML page (HTTP ${response.status}).`)]

  checks.push(finalOrigin === root.origin
    ? item('same_origin', 'pass', true, 'The page is served from the configured address.')
    : item('same_origin', 'fail', true, `The website redirects to ${finalOrigin}. Use that address instead.`))

  const serverRendering = detectServerRendering(html, headers)
  checks.push(serverRendering.length === 0
    ? item('static_shell', 'pass', true, `${detectRendering(lower)} detected. The same page can load for every user.`)
    : item('static_shell', 'fail', true, `Server-side rendering detected: ${serverRendering.join(', ')}. Deploy a static build (SPA or static export).`))

  const cacheControl = headers.get('cache-control') ?? ''
  const vary = headers.get('vary') ?? ''
  if (/\b(?:private|no-store)\b/i.test(cacheControl))
    checks.push(item('cacheable', 'fail', true, `The page uses Cache-Control "${cacheControl}". The app shell must be the same static file for every user.`))
  else if (/\b(?:cookie|authorization)\b/i.test(vary))
    checks.push(item('cacheable', 'fail', true, `The page varies by "${vary}". The app shell must be the same for every user.`))
  else
    checks.push(item('cacheable', 'pass', true, 'The page is the same for every user.'))

  const cookies = getSetCookieNames(headers)
  if (cookies.length > 0 && !cookies.some(name => SESSION_COOKIE.test(name)))
    checks.push(item('cookies', 'warning', false, `The page sets cookies (${cookies.join(', ')}). They are not sent when the app runs from its local copy.`))

  const external = externalBootAssets(html, finalOrigin)
  checks.push(external.length === 0
    ? item('same_origin_assets', 'pass', false, 'Scripts and stylesheets come from the website itself and work offline.')
    : item('same_origin_assets', 'warning', false, `Scripts or stylesheets load from ${external.join(', ')}. The app needs the network for them.`))

  if (/navigator\.serviceWorker\.register|serviceworkercontainer/i.test(html))
    checks.push(item('service_worker', 'warning', false, 'A service worker is registered. Test the app startup carefully, since the app keeps its own copy of the website.'))

  const viewport = metaContent(html, 'name', 'viewport')
  checks.push(/\bwidth\s*=\s*device-width\b/i.test(viewport)
    ? item('mobile_viewport', 'pass', false, 'The page declares a mobile viewport.')
    : item('mobile_viewport', 'warning', false, 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so the app fits phone screens.'))

  const title = decodeHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  const appName = metaContent(html, 'name', 'apple-mobile-web-app-title')
    || metaContent(html, 'name', 'application-name')
    || metaContent(html, 'property', 'og:site_name')
    || title
  const themeColor = metaContent(html, 'name', 'theme-color')
  return result(root.href, finalUrl, serverRendering.length > 0 ? 'server-rendered' : detectRendering(lower), checks, {
    app_name: shortAppName(appName),
    theme_color: /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor.toUpperCase() : null,
  })
}

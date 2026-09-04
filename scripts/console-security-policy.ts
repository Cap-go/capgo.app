/**
 * Single source of truth for the Capgo console Content-Security-Policy.
 *
 * Sync into `public/_headers` with:
 *   bun run security:sync-headers
 */

import configs from '../configs.json'

export interface ConsoleCspOptions {
  /** Local Vite dev server — allow http/ws to localhost. */
  dev?: boolean
}

function joinSources(sources: string[]) {
  return [...new Set(sources)].join(' ')
}

function addConnectOrigin(sources: Set<string>, raw: string) {
  if (!raw)
    return

  if (raw.includes('://')) {
    try {
      const url = new URL(raw)
      sources.add(url.origin)
      if (url.protocol === 'https:')
        sources.add(`wss://${url.host}`)
      else if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
        sources.add(`ws://${url.host}`)
    }
    catch {
      // Ignore invalid configured URLs.
    }
    return
  }

  const host = raw.split('/')[0]
  if (host.includes('localhost') || host.startsWith('127.')) {
    sources.add(`http://${host}`)
    sources.add(`ws://${host}`)
  }
  else {
    sources.add(`https://${host}`)
  }
}

function getConfiguredConnectSources(dev: boolean): string[] {
  const sources = new Set<string>()
  const envKeys = dev
    ? (['prod', 'preprod', 'development', 'local'] as const)
    : (['prod', 'preprod', 'development'] as const)

  for (const env of envKeys) {
    const supaUrl = configs.supa_url?.[env]
    if (typeof supaUrl === 'string')
      addConnectOrigin(sources, supaUrl)

    const apiDomain = configs.api_domain?.[env]
    if (typeof apiDomain === 'string')
      addConnectOrigin(sources, apiDomain)
  }

  return [...sources]
}

export function buildConsoleContentSecurityPolicy(options: ConsoleCspOptions = {}): string {
  const dev = options.dev === true

  const scriptSrc = joinSources([
    '\'self\'',
    'https://challenges.cloudflare.com', // Cloudflare Turnstile
    'https://static.cloudflareinsights.com', // Cloudflare Web Analytics (if enabled)
    'https://psthg.capgo.app', // first-party PostHog reverse proxy
  ])

  const styleSrc = joinSources([
    '\'self\'',
    '\'unsafe-inline\'', // Vue / Tailwind runtime styles
  ])

  const fontSrc = joinSources([
    '\'self\'',
    'data:',
  ])

  const imgSrc = joinSources([
    '\'self\'',
    'data:',
    'blob:',
    'https:', // org logos, avatars, store icons, signed storage URLs
  ])

  const mediaSrc = joinSources([
    '\'self\'',
    'data:',
    'blob:',
    'https:',
  ])

  const connectSrc = joinSources([
    '\'self\'',
    'blob:',
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://psthg.capgo.app',
    'https://eu.posthog.com',
    'https://eu.i.posthog.com',
    'https://challenges.cloudflare.com',
    'https://api.github.com',
    'https://registry.npmjs.org',
    ...getConfiguredConnectSources(dev),
    ...(dev
      ? [
          'http://localhost:*',
          'http://127.0.0.1:*',
          'ws://localhost:*',
          'ws://127.0.0.1:*',
        ]
      : []),
  ])

  const frameSrc = joinSources([
    '\'self\'',
    'https://challenges.cloudflare.com', // Turnstile widget
    'https://checkout.stripe.com',
    'https://billing.stripe.com',
    'https://js.stripe.com',
    'https://*.preview.capgo.app',
    'https://*.preview.preprod.capgo.app',
    'https://*.preview.dev.capgo.app',
    'https://*.preview.development.capgo.app',
  ])

  const directives = [
    'default-src \'self\'',
    'base-uri \'self\'',
    'object-src \'none\'',
    'frame-ancestors \'none\'',
    'form-action \'self\' https://checkout.stripe.com https://billing.stripe.com',
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `font-src ${fontSrc}`,
    `connect-src ${connectSrc}`,
    `media-src ${mediaSrc}`,
    `frame-src ${frameSrc}`,
    'worker-src \'self\' blob:',
    'manifest-src \'self\'',
  ]

  if (!dev)
    directives.push('upgrade-insecure-requests')

  return directives.join('; ')
}

export const CONSOLE_CONTENT_SECURITY_POLICY = buildConsoleContentSecurityPolicy()

/**
 * Single source of truth for the Capgo console Content-Security-Policy.
 *
 * Sync into `public/_headers` with:
 *   bun run security:sync-headers
 */

export interface ConsoleCspOptions {
  /** Local Vite dev server — allow http/ws to localhost. */
  dev?: boolean
}

function joinSources(sources: string[]) {
  return sources.join(' ')
}

export function buildConsoleContentSecurityPolicy(options: ConsoleCspOptions = {}): string {
  const dev = options.dev === true

  const scriptSrc = joinSources([
    '\'self\'',
    '\'unsafe-inline\'', // index.html bootstraps theme before the Vue bundle loads
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
    'https://sb.capgo.app',
    'https://*.supabase.co',
    'https://api.capgo.app',
    'https://api.preprod.capgo.app',
    'https://api.dev.capgo.app',
    'https://psthg.capgo.app',
    'https://eu.posthog.com',
    'https://eu.i.posthog.com',
    'https://challenges.cloudflare.com',
    'https://api.github.com',
    'https://registry.npmjs.org',
    'wss://sb.capgo.app',
    'wss://*.supabase.co',
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

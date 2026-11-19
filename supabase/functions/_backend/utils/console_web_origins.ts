import type { Context } from 'hono'
import { getEnv } from './utils.ts'

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin
  }
  catch {
    return ''
  }
}

export const PRODUCTION_CONSOLE_WEB_ORIGINS = [
  'https://console.capgo.app',
  'https://console.capgo.com.cn',
] as const

export const PREPROD_CONSOLE_WEB_ORIGIN = 'https://console.preprod.capgo.app' as const
export const DEVELOPMENT_CONSOLE_WEB_ORIGIN = 'https://console.development.capgo.app' as const

/** All Capgo-hosted console origins (reference only; use environment-scoped defaults at runtime). */
export const DEFAULT_CONSOLE_WEB_ORIGINS = [
  ...PRODUCTION_CONSOLE_WEB_ORIGINS,
  PREPROD_CONSOLE_WEB_ORIGIN,
  DEVELOPMENT_CONSOLE_WEB_ORIGIN,
] as const

function defaultConsoleOriginsForWebapp(rawWebappUrl: string): readonly string[] {
  const normalized = normalizeOrigin(rawWebappUrl)
  if (!normalized)
    return PRODUCTION_CONSOLE_WEB_ORIGINS
  try {
    const host = new URL(normalized).hostname
    if (host === 'console.capgo.app')
      return PRODUCTION_CONSOLE_WEB_ORIGINS
    if (host === 'console.capgo.com.cn')
      return ['https://console.capgo.com.cn']
    if (host === 'console.preprod.capgo.app')
      return [PREPROD_CONSOLE_WEB_ORIGIN]
    if (host === 'console.development.capgo.app')
      return [DEVELOPMENT_CONSOLE_WEB_ORIGIN]
  }
  catch {
    return PRODUCTION_CONSOLE_WEB_ORIGINS
  }
  return []
}

export function collectConsoleWebOrigins(c: Context, extraCommaSeparated = ''): Set<string> {
  const allowed = new Set<string>()
  const rawWebappUrl = getEnv(c, 'WEBAPP_URL') ?? ''
  const webappUrl = normalizeOrigin(rawWebappUrl)
  if (webappUrl)
    allowed.add(webappUrl)

  for (const origin of defaultConsoleOriginsForWebapp(rawWebappUrl))
    allowed.add(origin)

  for (const raw of extraCommaSeparated.split(',')) {
    const origin = normalizeOrigin(raw.trim())
    if (origin)
      allowed.add(origin)
  }

  return allowed
}

export function isAllowedConsoleWebOrigin(c: Context, origin: string, extraCommaSeparated = ''): boolean {
  const normalized = normalizeOrigin(origin)
  if (!normalized)
    return false
  return collectConsoleWebOrigins(c, extraCommaSeparated).has(normalized)
}

const CAPGO_HOSTED_CONSOLE_HOSTS = new Set([
  'console.capgo.app',
  'console.capgo.com.cn',
  'console.preprod.capgo.app',
  'console.development.capgo.app',
])

/** Stripe return URLs: self-host and local test APIs still accept Capgo production console origins. */
export function stripeRedirectOriginExtras(c: Context): string {
  const normalized = normalizeOrigin(getEnv(c, 'WEBAPP_URL') ?? '')
  if (!normalized)
    return PRODUCTION_CONSOLE_WEB_ORIGINS.join(',')
  try {
    const host = new URL(normalized).hostname
    if (CAPGO_HOSTED_CONSOLE_HOSTS.has(host))
      return ''
  }
  catch {
    return PRODUCTION_CONSOLE_WEB_ORIGINS.join(',')
  }
  return PRODUCTION_CONSOLE_WEB_ORIGINS.join(',')
}
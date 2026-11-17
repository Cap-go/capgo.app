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

/** Production and staging console origins served by Capgo (excluding per-tenant self-host). */
export const DEFAULT_CONSOLE_WEB_ORIGINS = [
  'https://console.capgo.app',
  'https://console.capgo.com.cn',
  'https://console.preprod.capgo.app',
  'https://console.development.capgo.app',
] as const

export function collectConsoleWebOrigins(c: Context, extraCommaSeparated = ''): Set<string> {
  const allowed = new Set<string>()
  const webappUrl = normalizeOrigin(getEnv(c, 'WEBAPP_URL'))
  if (webappUrl)
    allowed.add(webappUrl)

  for (const origin of DEFAULT_CONSOLE_WEB_ORIGINS)
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
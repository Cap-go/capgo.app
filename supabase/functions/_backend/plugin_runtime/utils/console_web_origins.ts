import type { Context } from 'hono'
import { getEnv } from './utils.ts'

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin
  } catch {
    return ''
  }
}

const PRODUCTION_CONSOLE_WEB_ORIGINS = [
  'https://console.capgo.app',
  'https://console.capgo.com.cn',
] as const

const PREPROD_CONSOLE_WEB_ORIGIN = 'https://console.preprod.capgo.app' as const
const DEVELOPMENT_CONSOLE_WEB_ORIGIN = 'https://console.development.capgo.app' as const

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

export function collectConsoleWebOrigins(c: Context): Set<string> {
  const allowed = new Set<string>()
  const rawWebappUrl = getEnv(c, 'WEBAPP_URL') ?? ''
  const webappUrl = normalizeOrigin(rawWebappUrl)
  if (webappUrl)
    allowed.add(webappUrl)

  for (const origin of defaultConsoleOriginsForWebapp(rawWebappUrl))
    allowed.add(origin)

  return allowed
}
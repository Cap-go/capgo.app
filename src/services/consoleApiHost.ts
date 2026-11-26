import { Capacitor } from '@capacitor/core'

export const CHINA_API_HOST = 'https://api.capgo.com.cn'
export const CHINA_CONSOLE_URL = 'https://console.capgo.com.cn'
export const GLOBAL_CONSOLE_WEB_HOST = 'console.capgo.app'
export const GLOBAL_API_HOST = 'https://api.capgo.app'

function normalizeConsoleHostname(hostname: string): string {
  return hostname.replace(/\.$/, '').toLowerCase()
}

export function isChinaCapgoConsoleHostname(hostname: string): boolean {
  const normalized = normalizeConsoleHostname(hostname)
  return normalized === 'capgo.com.cn' || normalized.endsWith('.capgo.com.cn')
}

export function getConsoleApiHost(): string {
  if (typeof window !== 'undefined' && isChinaCapgoConsoleHostname(window.location.hostname))
    return CHINA_API_HOST
  return import.meta.env.VITE_API_HOST as string
}

/** CLI `--api-host` is for the China console only, not preprod/dev/self-hosted API hosts. */
export function buildChinaConsoleCliApiHostArg(): string {
  if (getConsoleApiHost() === CHINA_API_HOST)
    return ` --api-host ${CHINA_API_HOST}`
  return ''
}

/** CLI `--api-host` for China consoles, or for local, preprod, and self-hosted API backends. */
export function buildConsoleCliApiHostArg(apiHost: string): string {
  const chinaArg = buildChinaConsoleCliApiHostArg()
  if (chinaArg)
    return chinaArg
  const normalized = apiHost.replace(/\/$/, '')
  if (normalized && normalized !== GLOBAL_API_HOST && normalized !== CHINA_API_HOST)
    return ` --api-host ${normalized}`
  return ''
}

export interface GlobalConsoleWebHostContext {
  hostname?: string
  isNativePlatform?: boolean
  devMode?: boolean
}

export function isOnGlobalConsoleWebHost(context: GlobalConsoleWebHostContext = {}): boolean {
  if (context.isNativePlatform ?? Capacitor.isNativePlatform())
    return false

  const hostname = context.hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '')
  if (!hostname)
    return false

  if (isChinaCapgoConsoleHostname(hostname))
    return false

  if (hostname === GLOBAL_CONSOLE_WEB_HOST)
    return true

  const devMode = context.devMode ?? import.meta.env.MODE === 'development'
  if (devMode && (hostname === 'localhost' || hostname === '127.0.0.1'))
    return true

  return false
}

export function getConsoleWebOrigin(): string {
  if (typeof window !== 'undefined')
    return window.location.origin
  return (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/$/, '') ?? ''
}

export function looksLikeChinaReachLocaleHint(): boolean {
  if (typeof navigator === 'undefined')
    return false
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (timeZone === 'Asia/Shanghai' || timeZone === 'Asia/Hong_Kong' || timeZone === 'Asia/Macau' || timeZone === 'Asia/Urumqi')
    return true
  const languages = [...(navigator.languages ?? []), navigator.language].filter(Boolean)
  return languages.some(lang => lang === 'zh' || lang.startsWith('zh-'))
}

export function shouldSuggestChinaConsole(options: {
  onGlobalConsole: boolean
  mainApiReachable: boolean
  chinaApiReachable: boolean
  localeHint?: boolean
}): boolean {
  if (!options.onGlobalConsole || options.mainApiReachable || !options.chinaApiReachable)
    return false
  const localeHint = options.localeHint ?? looksLikeChinaReachLocaleHint()
  return localeHint
}

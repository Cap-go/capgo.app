export const CHINA_API_HOST = 'https://api.capgo.com.cn'
export const CHINA_CONSOLE_URL = 'https://console.capgo.com.cn'

export function isChinaCapgoConsoleHostname(hostname: string): boolean {
  return hostname === 'capgo.com.cn' || hostname.endsWith('.capgo.com.cn')
}

export function getConsoleApiHost(): string {
  if (typeof window !== 'undefined' && isChinaCapgoConsoleHostname(window.location.hostname))
    return CHINA_API_HOST
  return import.meta.env.VITE_API_HOST as string
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

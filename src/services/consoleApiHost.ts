export const CHINA_API_HOST = 'https://api.capgo.com.cn'
export const CHINA_CONSOLE_URL = 'https://console.capgo.com.cn'

export function getConsoleApiHost(): string {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('capgo.com.cn'))
    return CHINA_API_HOST
  return import.meta.env.VITE_API_HOST as string
}

export function getConsoleWebOrigin(): string {
  if (typeof window !== 'undefined')
    return window.location.origin
  return (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/$/, '') ?? ''
}
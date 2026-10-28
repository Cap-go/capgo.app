const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const BEARER_PATTERN = /bearer\s+[a-zA-Z0-9._~+/=-]+/gi
const BASIC_AUTH_PATTERN = /basic\s+[a-zA-Z0-9+/=]+/gi
const APIKEY_PATTERN = /apikey[=:\s]+["']?[a-zA-Z0-9._~+/=-]+["']?/gi
const JWT_PATTERN = /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g
const AUTHORIZATION_HEADER_PATTERN = /authorization[=:\s]+[^\s"']+/gi

export function redactSensitiveText(text: string): string {
  return text
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(BASIC_AUTH_PATTERN, 'Basic [redacted]')
    .replace(APIKEY_PATTERN, 'apikey=[redacted]')
    .replace(JWT_PATTERN, '[redacted-jwt]')
    .replace(AUTHORIZATION_HEADER_PATTERN, 'authorization=[redacted]')
}

export function isAllowedAlertWebhookUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === 'https:'
  }
  catch {
    return false
  }
}

export function redactOptionalText(value: string | null): string | null {
  if (value === null)
    return null
  return redactSensitiveText(value)
}

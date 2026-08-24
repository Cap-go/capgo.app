const TRANSIENT_NODE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
])

const TRANSIENT_PG_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53400',
  '57014',
])

const TRANSIENT_ERROR_MESSAGE_RE = /connection (?:terminated|ended|closed|refused|reset)|timeout exceeded when trying to connect|connect(?:ion)? timed? ?out|canceling statement due to (?:statement|lock) timeout|network(?: |_)?error|socket hang up|hyperdrive|too many clients already/i

export function readPgErrorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object')
    return undefined
  return (error as Record<string, unknown>)[key]
}

export function readPgErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || depth > 6)
    return undefined

  const code = readPgErrorField(error, 'code')
  if (typeof code === 'string' && code.length > 0)
    return code

  const cause = readPgErrorField(error, 'cause')
  if (cause !== undefined)
    return readPgErrorCode(cause, depth + 1)

  return undefined
}

export function isTransientPgError(error: unknown, depth = 0): boolean {
  if (!error || depth > 6)
    return false

  if (typeof error === 'string')
    return TRANSIENT_ERROR_MESSAGE_RE.test(error)

  const code = readPgErrorField(error, 'code')
  if (typeof code === 'string') {
    if (TRANSIENT_NODE_ERROR_CODES.has(code) || TRANSIENT_PG_SQLSTATES.has(code))
      return true
  }

  const message = readPgErrorField(error, 'message')
  if (typeof message === 'string' && TRANSIENT_ERROR_MESSAGE_RE.test(message))
    return true

  const errno = readPgErrorField(error, 'errno')
  if (typeof errno === 'string' && TRANSIENT_NODE_ERROR_CODES.has(errno))
    return true

  const cause = readPgErrorField(error, 'cause')
  if (cause !== undefined && isTransientPgError(cause, depth + 1))
    return true

  const errors = readPgErrorField(error, 'errors')
  if (Array.isArray(errors))
    return errors.some(entry => isTransientPgError(entry, depth + 1))

  return false
}

function collectErrorMessages(error: unknown, depth = 0): string[] {
  if (!error || depth > 4)
    return []

  const messages: string[] = []
  const message = readPgErrorField(error, 'message')
  if (typeof message === 'string' && message.length > 0)
    messages.push(message)

  const cause = readPgErrorField(error, 'cause')
  if (cause !== undefined)
    messages.push(...collectErrorMessages(cause, depth + 1))

  return messages
}

function fingerprintPgCode(error: unknown): string | undefined {
  const code = readPgErrorCode(error)
  return code ? `pg:${code}` : undefined
}

export function drizzleErrorFingerprintSegment(error: unknown): string | undefined {
  const combined = collectErrorMessages(error).join('\n')
  if (!combined)
    return undefined

  const tableMatch = combined.match(/(?:FROM|INTO|UPDATE)\s+(?:(?:[a-z_][\w$]*|"[^"]+")\.)?["']?([a-z_][\w$]*)/i)
    ?? combined.match(/from\s+["']([a-z_][\w$]*)["']/i)
  if (tableMatch?.[1]) {
    const pgCode = fingerprintPgCode(error)
    return pgCode ? `${tableMatch[1]}:${pgCode}` : tableMatch[1]
  }

  return fingerprintPgCode(error) ?? combined.replace(/\s+/g, ' ').slice(0, 120)
}

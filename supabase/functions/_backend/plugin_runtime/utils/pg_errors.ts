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

const DRIZZLE_ERROR_NAMES = new Set(['DrizzleError', 'DrizzleQueryError', 'TransactionRollbackError'])

const DATABASE_MESSAGE_RE = /Failed query:|(?:FROM|INTO|UPDATE|SELECT|INSERT|DELETE)\s+(?:[\w"$]+\.)?[\w"$]+|relation\s+"[^"]+"\s+does not exist|Connection terminated unexpectedly|timeout exceeded when trying to connect|too many clients already|canceling statement due to/i

const PG_CONNECTION_MESSAGE_RE = /postgres(?:ql)?(?:\.|:|@|\/|\s|$|-)|hyperdrive|pgbouncer|supabase(?:\.co|abase)?|neon\.tech|\.pooler\.|aws-.*-pooler/i

const NON_DB_CONNECT_PORTS = new Set([80, 443, 8080, 8443, 3000, 5000, 6379])

const PG_SEVERITY_RE = /^(?:ERROR|FATAL|PANIC|WARNING|NOTICE|INFO|LOG|DEBUG)$/i

function isPostgresSqlStateCode(code: string): boolean {
  if (code.length !== 5 || TRANSIENT_NODE_ERROR_CODES.has(code))
    return false
  if (/^[0-9]{2}[0-9A-Z]{3}$/.test(code))
    return true
  if (/^P[0-9]{4}$/.test(code))
    return true
  return TRANSIENT_PG_SQLSTATES.has(code)
}

function hasPgProtocolMetadata(error: unknown): boolean {
  const severity = readPgErrorField(error, 'severity')
  if (typeof severity === 'string' && PG_SEVERITY_RE.test(severity))
    return true

  for (const field of ['routine', 'schema', 'table', 'column', 'detail', 'internalQuery', 'constraint']) {
    if (readPgErrorField(error, field) !== undefined)
      return true
  }

  return false
}

function readConnectPort(error: unknown): number | undefined {
  const port = readPgErrorField(error, 'port')
  if (typeof port === 'number' && Number.isFinite(port))
    return port

  const message = readPgErrorField(error, 'message')
  if (typeof message !== 'string')
    return undefined

  const portMatch = message.match(/:(\d{2,5})\b/)
  if (!portMatch)
    return undefined

  const parsedPort = Number(portMatch[1])
  return Number.isFinite(parsedPort) ? parsedPort : undefined
}

function isNodePgConnectError(error: unknown): boolean {
  const code = readPgErrorField(error, 'code')
  if (typeof code !== 'string' || !TRANSIENT_NODE_ERROR_CODES.has(code))
    return false

  const syscall = readPgErrorField(error, 'syscall')
  if (syscall === 'connect') {
    const port = readConnectPort(error)
    if (typeof port === 'number')
      return !NON_DB_CONNECT_PORTS.has(port)
  }

  const message = readPgErrorField(error, 'message')
  if (typeof message === 'string') {
    if (DATABASE_MESSAGE_RE.test(message) || PG_CONNECTION_MESSAGE_RE.test(message))
      return true
  }

  return false
}

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

export function isDatabaseOriginError(error: unknown, depth = 0): boolean {
  if (!error || depth > 6)
    return false

  if (typeof error === 'object') {
    const name = readPgErrorField(error, 'name')
    if (typeof name === 'string' && DRIZZLE_ERROR_NAMES.has(name))
      return true

    if (hasPgProtocolMetadata(error))
      return true

    const code = readPgErrorField(error, 'code')
    if (typeof code === 'string') {
      if (isPostgresSqlStateCode(code))
        return true
      if (isNodePgConnectError(error))
        return true
    }

    const message = readPgErrorField(error, 'message')
    if (typeof message === 'string') {
      if (DATABASE_MESSAGE_RE.test(message))
        return true
      if (PG_CONNECTION_MESSAGE_RE.test(message))
        return true
    }
  }

  const cause = readPgErrorField(error, 'cause')
  if (cause !== undefined && isDatabaseOriginError(cause, depth + 1))
    return true

  const errors = readPgErrorField(error, 'errors')
  if (Array.isArray(errors))
    return errors.some(entry => isDatabaseOriginError(entry, depth + 1))

  return false
}

export function isTransientDatabaseError(error: unknown): boolean {
  return isTransientPgError(error) && isDatabaseOriginError(error)
}

export function readQuickErrorOriginalCause(error: unknown): unknown {
  const cause = readPgErrorField(error, 'cause')
  if (!cause || typeof cause !== 'object')
    return undefined
  return readPgErrorField(cause, 'originalCause')
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

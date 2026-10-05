// Dependency-free so the API can reuse this without breaking plugin isolation.
const POSTGRES_ERROR_FIELDS = [
  // PostgreSQL server errors (node-postgres DatabaseError)
  'severity',
  'code',
  'detail',
  'hint',
  'position',
  'internalPosition',
  'internalQuery',
  'where',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'file',
  'line',
  'routine',

  // Network, socket, and TLS errors
  'errno',
  'syscall',
  'address',
  'port',
  'host',
  'hostname',
  'library',
  'function',
  'reason',
  'opensslErrorStack',

  // Driver/runtime errors
  'retryable',
  'status',
  'statusCode',
  'command',
  'query',
] as const

const MAX_POSTGRES_ERROR_CAUSE_DEPTH = 8
const MAX_POSTGRES_LOG_VALUE_DEPTH = 4
const MAX_POSTGRES_LOG_ARRAY_ITEMS = 50
const MAX_POSTGRES_LOG_OBJECT_KEYS = 50
const POSTGRES_LOG_REDACTED_KEYS = new Set(['bindings', 'parameters', 'params', 'values'])
const POSTGRES_LOG_UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function redactPostgresLogText(value: string): string {
  return value.replace(/(^|[\r\n])params:[^\r\n]*/gi, '$1params: [redacted]')
}

function describeThrownValue(value: unknown): string {
  if (typeof value === 'string')
    return redactPostgresLogText(value)
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol')
    return String(value)
  return 'object thrown'
}

function readErrorProperty(error: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    if (!descriptor)
      return undefined
    if ('value' in descriptor)
      return descriptor.value
    return '[accessor property omitted]'
  }
  catch (propertyError) {
    return `[unreadable property: ${describeThrownValue(propertyError)}]`
  }
}

function getObjectType(value: object): string {
  if (Array.isArray(value))
    return 'Array'
  if (value instanceof AggregateError)
    return 'AggregateError'
  if (value instanceof Error)
    return 'Error'
  if (typeof value === 'function')
    return 'Function'
  return 'Object'
}

function getLogArrayLength(value: unknown[]): number {
  const length = readErrorProperty(value, 'length')
  return typeof length === 'number' && Number.isSafeInteger(length) && length > 0
    ? length
    : 0
}

function serializePostgresLogArray(
  value: unknown[],
  seen: WeakSet<object>,
  depth: number,
): unknown[] {
  const totalLength = getLogArrayLength(value)
  const boundedLength = Math.min(totalLength, MAX_POSTGRES_LOG_ARRAY_ITEMS)
  const serialized: unknown[] = []
  for (let index = 0; index < boundedLength; index++)
    serialized.push(serializePostgresLogValue(readErrorProperty(value, index), seen, depth + 1))

  if (totalLength > boundedLength)
    serialized.push(`[truncated ${totalLength - boundedLength} items]`)
  return serialized
}

function serializePostgresLogObject(
  value: object,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  let keys: string[]
  try {
    keys = Object.keys(value)
  }
  catch (keyError) {
    return `[unreadable object: ${describeThrownValue(keyError)}]`
  }

  // A null-prototype record plus explicit unsafe-key filtering prevents
  // attacker-controlled diagnostic keys from invoking `__proto__` setters
  // here or in less defensive downstream log processors.
  const serialized: Record<string, unknown> = Object.create(null)
  const blockedKeys: string[] = []
  for (const key of keys.slice(0, MAX_POSTGRES_LOG_OBJECT_KEYS)) {
    if (POSTGRES_LOG_UNSAFE_KEYS.has(key.toLowerCase())) {
      blockedKeys.push(key)
      continue
    }
    // Structured query objects can carry bound values under these keys.
    // Keep the query text and shape, but never copy parameter values to logs.
    serialized[key] = POSTGRES_LOG_REDACTED_KEYS.has(key.toLowerCase())
      ? '[redacted]'
      : serializePostgresLogValue(readErrorProperty(value, key), seen, depth + 1)
  }

  if (keys.length > MAX_POSTGRES_LOG_OBJECT_KEYS)
    serialized.__truncatedKeys = keys.length - MAX_POSTGRES_LOG_OBJECT_KEYS
  if (blockedKeys.length)
    serialized.__blockedKeys = blockedKeys

  return serialized
}

export function serializePostgresLogValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === 'string')
    return redactPostgresLogText(value)
  if (typeof value === 'bigint')
    return value.toString()
  if (typeof value === 'symbol')
    return value.toString()
  if (typeof value === 'function') {
    const functionName = readErrorProperty(value, 'name')
    return `[function ${typeof functionName === 'string' && functionName ? functionName : 'anonymous'}]`
  }
  if (value === null || typeof value !== 'object')
    return value

  if (seen.has(value))
    return '[circular]'
  if (depth >= MAX_POSTGRES_LOG_VALUE_DEPTH)
    return `[truncated ${getObjectType(value)}]`

  seen.add(value)
  try {
    return Array.isArray(value)
      ? serializePostgresLogArray(value, seen, depth)
      : serializePostgresLogObject(value, seen, depth)
  }
  catch (serializationError) {
    return `[unserializable ${getObjectType(value)}: ${describeThrownValue(serializationError)}]`
  }
  finally {
    seen.delete(value)
  }
}

function serializePostgresAggregateErrors(
  aggregateErrors: unknown[],
  seen: WeakSet<object>,
  depth: number,
): Record<string, unknown>[] {
  const totalLength = getLogArrayLength(aggregateErrors)
  const boundedLength = Math.min(totalLength, MAX_POSTGRES_LOG_ARRAY_ITEMS)
  const errors: Record<string, unknown>[] = []
  for (let index = 0; index < boundedLength; index++) {
    errors.push(serializePostgresError(
      readErrorProperty(aggregateErrors, index),
      seen,
      depth + 1,
    ))
  }
  if (totalLength > boundedLength) {
    errors.push({
      type: 'truncated',
      omitted: totalLength - boundedLength,
    })
  }
  return errors
}

/**
 * Serialize the complete Drizzle/node-postgres cause chain for Cloudflare logs.
 *
 * Error fields such as `code`, `severity`, and `routine` are not reliably
 * enumerable, while Drizzle wraps the original driver error in `cause`. Read
 * both explicitly so transient database/Hyperdrive failures retain their
 * PostgreSQL SQLSTATE and network diagnostics.
 */
export function serializePostgresError(
  error: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): Record<string, unknown> {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return {
      type: error === null ? 'null' : typeof error,
      value: serializePostgresLogValue(error),
    }
  }

  if (seen.has(error))
    return { type: getObjectType(error), circular: true }

  if (depth >= MAX_POSTGRES_ERROR_CAUSE_DEPTH)
    return { type: getObjectType(error), truncated: true }

  seen.add(error)
  const serialized: Record<string, unknown> = {
    type: getObjectType(error),
  }
  try {
    const name = readErrorProperty(error, 'name')
    const message = readErrorProperty(error, 'message')
    const stack = readErrorProperty(error, 'stack')
    // Bound values can contain newlines. Remove the whole parameter suffix,
    // then replace that exact message in the stack to preserve its frames.
    const redactedMessage = typeof message === 'string'
      ? message.replace(/(^|[\r\n])params:[\s\S]*/gi, '$1params: [redacted]')
      : message

    serialized.name = name === undefined
      ? getObjectType(error)
      : serializePostgresLogValue(name)
    if (message !== undefined)
      serialized.message = serializePostgresLogValue(redactedMessage)
    if (stack !== undefined) {
      const redactedStack = typeof stack === 'string' && typeof message === 'string' && message && typeof redactedMessage === 'string'
        ? stack.replace(message, redactedMessage)
        : stack
      serialized.stack = serializePostgresLogValue(redactedStack)
    }

    for (const field of POSTGRES_ERROR_FIELDS) {
      const value = readErrorProperty(error, field)
      if (value !== undefined)
        serialized[field] = serializePostgresLogValue(value)
    }

    const params = readErrorProperty(error, 'params')
    if (Array.isArray(params)) {
      // Query parameters can contain credentials or other user-provided secrets.
      // The affected app is logged explicitly by the caller instead.
      serialized.parameterCount = params.length
    }

    const aggregateErrors = readErrorProperty(error, 'errors')
    if (Array.isArray(aggregateErrors))
      serialized.errors = serializePostgresAggregateErrors(aggregateErrors, seen, depth)

    const cause = readErrorProperty(error, 'cause')
    if (cause !== undefined)
      serialized.cause = serializePostgresError(cause, seen, depth + 1)

    return serialized
  }
  catch (serializationError) {
    serialized.serializationFailure = describeThrownValue(serializationError)
    return serialized
  }
  finally {
    seen.delete(error)
  }
}

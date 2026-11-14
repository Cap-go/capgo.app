import { readFileSync } from 'node:fs'
import type { ConnectionOptions } from 'node:tls'
import type { ClientConfig } from 'pg'

function skipTlsHostnameVerification(): ConnectionOptions['checkServerIdentity'] {
  return () => undefined
}

export type ParsedPostgresUrl = {
  scheme: 'postgres' | 'postgresql'
  credentials: string
  hostPort: string
  database: string
  query: string
  authInQuery: boolean
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function parseQueryParams(query: string): Map<string, string> {
  return new Map(query.split('&').filter(Boolean).map((pair) => {
    const equals = pair.indexOf('=')
    if (equals < 0)
      return [pair, ''] as const
    return [pair.slice(0, equals), decode(pair.slice(equals + 1))] as const
  }))
}

function serializeQueryParams(params: Map<string, string>): string {
  return [...params.entries()]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
}

export function parsePostgresConnectionUrl(url: string): ParsedPostgresUrl | undefined {
  const authority = /^postgres(?:ql)?:\/\/(.*)@([^@/]+)\/([^?]*)(?:\?(.*))?$/s.exec(url)
  if (authority) {
    return {
      scheme: url.startsWith('postgresql://') ? 'postgresql' : 'postgres',
      credentials: authority[1]!,
      hostPort: authority[2]!,
      database: authority[3]!,
      query: authority[4] ?? '',
      authInQuery: false,
    }
  }

  const queryAuth = /^postgres(?:ql)?:\/\/([^/?#]+)\/([^?]*)(\?(.*))?$/s.exec(url)
  if (!queryAuth)
    return undefined

  const params = parseQueryParams(queryAuth[4] ?? '')
  const user = params.get('user')
  if (!user)
    return undefined

  const password = params.get('password')
  params.delete('user')
  params.delete('password')

  return {
    scheme: url.startsWith('postgresql://') ? 'postgresql' : 'postgres',
    credentials: password != null && password !== '' ? `${user}:${password}` : user,
    hostPort: queryAuth[1]!,
    database: queryAuth[2]!,
    query: serializeQueryParams(params),
    authInQuery: true,
  }
}

function passwordNeedsUrlEncoding(password: string): boolean {
  return /[?#@\\]/.test(password) || password.includes('$')
}

export function buildPostgresUrl(parts: ParsedPostgresUrl): string {
  const querySuffix = parts.query ? `?${parts.query}` : ''
  if (parts.authInQuery) {
    const colon = parts.credentials.indexOf(':')
    const user = colon >= 0 ? parts.credentials.slice(0, colon) : parts.credentials
    const password = colon >= 0 ? parts.credentials.slice(colon + 1) : ''
    const params = parseQueryParams(parts.query)
    params.set('user', user)
    if (password)
      params.set('password', password)
    const serialized = serializeQueryParams(params)
    return `${parts.scheme}://${parts.hostPort}/${parts.database}${serialized ? `?${serialized}` : ''}`
  }

  return `${parts.scheme}://${parts.credentials}@${parts.hostPort}/${parts.database}${querySuffix}`
}

export function encodePostgresUrlPasswordIfNeeded(url: string): string {
  try {
    connectionConfig(url)
    return url
  }
  catch {
    // Re-encode only when the URL does not already parse for pg.
  }

  const parts = parsePostgresConnectionUrl(url)
  if (!parts)
    return url

  const colon = parts.credentials.indexOf(':')
  if (colon < 0)
    return url

  const user = parts.credentials.slice(0, colon)
  const password = parts.credentials.slice(colon + 1)
  if (!passwordNeedsUrlEncoding(password))
    return url

  const encoded = encodeURIComponent(password)
  return buildPostgresUrl({
    ...parts,
    credentials: `${user}:${encoded}`,
  })
}

export function buildPostgresSslOptions(
  sslmode: string,
  sslrootcert: string | undefined,
): Exclude<ClientConfig['ssl'], undefined> {
  if (sslmode === 'disable')
    return false

  const hasCustomCa = Boolean(sslrootcert && sslrootcert !== 'system')
  const verifyCertificate = sslmode === 'verify-full'
    || sslmode === 'verify-ca'
    || (sslmode === 'require' && hasCustomCa)

  if (hasCustomCa) {
    const ssl: ConnectionOptions = {
      rejectUnauthorized: verifyCertificate,
      ca: readFileSync(sslrootcert!),
    }
    if (sslmode === 'require' || sslmode === 'verify-ca')
      ssl.checkServerIdentity = skipTlsHostnameVerification()
    return ssl
  }

  return { rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca' }
}

// psql accepts URLs whose password holds unencoded characters such as "?";
// pg's URL parser does not. Split credentials at the last "@" instead.
export function connectionConfig(url: string): ClientConfig {
  const parts = parsePostgresConnectionUrl(url)
  if (!parts)
    throw new Error(
      'unsupported connection string (expected postgresql://user:password@host:port/db '
      + 'or postgresql://host:port/db?user=&password=)',
    )

  const colon = parts.credentials.indexOf(':')
  const portSeparator = parts.hostPort.lastIndexOf(':')
  const params = parseQueryParams(parts.query)
  const sslrootcert = params.get('sslrootcert')
  // libpq treats sslrootcert=system without sslmode as verify-full.
  const sslmode = params.get('sslmode') ?? (sslrootcert === 'system' ? 'verify-full' : 'prefer')

  return {
    user: decode(colon >= 0 ? parts.credentials.slice(0, colon) : parts.credentials),
    password: colon >= 0 ? decode(parts.credentials.slice(colon + 1)) : undefined,
    host: portSeparator >= 0 ? parts.hostPort.slice(0, portSeparator) : parts.hostPort,
    port: portSeparator >= 0 ? Number(parts.hostPort.slice(portSeparator + 1)) : 5432,
    database: decode(parts.database) || 'postgres',
    ssl: buildPostgresSslOptions(sslmode, sslrootcert),
    connectionTimeoutMillis: params.has('connect_timeout') ? Number(params.get('connect_timeout')) * 1000 : 15_000,
  }
}
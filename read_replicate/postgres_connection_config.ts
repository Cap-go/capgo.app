import type { ClientConfig } from 'pg'

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

// psql accepts URLs whose password holds unencoded characters such as "?";
// pg's URL parser does not. Split credentials at the last "@" instead.
export function connectionConfig(url: string): ClientConfig {
  const match = /^postgres(?:ql)?:\/\/(.*)@([^@/]+)\/([^?]*)(?:\?(.*))?$/s.exec(url)
  if (!match)
    throw new Error('unsupported connection string (expected postgresql://user:password@host:port/db)')
  const [, credentials, hostPort, database, query = ''] = match
  const colon = credentials.indexOf(':')
  const portSeparator = hostPort.lastIndexOf(':')
  const params = new Map(query.split('&').filter(Boolean).map((pair) => {
    const equals = pair.indexOf('=')
    return [pair.slice(0, equals), decode(pair.slice(equals + 1))] as const
  }))
  // libpq treats sslrootcert=system without sslmode as verify-full.
  const sslmode = params.get('sslmode') ?? (params.get('sslrootcert') === 'system' ? 'verify-full' : 'prefer')
  return {
    user: decode(colon >= 0 ? credentials.slice(0, colon) : credentials),
    password: colon >= 0 ? decode(credentials.slice(colon + 1)) : undefined,
    host: portSeparator >= 0 ? hostPort.slice(0, portSeparator) : hostPort,
    port: portSeparator >= 0 ? Number(hostPort.slice(portSeparator + 1)) : 5432,
    database: decode(database) || 'postgres',
    ssl: sslmode === 'disable' ? false : { rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca' },
    connectionTimeoutMillis: params.has('connect_timeout') ? Number(params.get('connect_timeout')) * 1000 : 15_000,
  }
}
import type { ClientConfig } from 'pg'
import { connectionConfig, encodePostgresUrlPasswordIfNeeded } from './postgres_connection_config.ts'

function splitPostgresUrl(url: string): { base: string, query: string } {
  const match = /^postgres(?:ql)?:\/\/(.*)@([^@/]+)\/([^?]*)(?:\?(.*))?$/s.exec(url)
  if (!match)
    return { base: url, query: '' }
  const scheme = url.startsWith('postgresql://') ? 'postgresql' : 'postgres'
  const [, credentials, hostPort, database, query = ''] = match
  return {
    base: `${scheme}://${credentials}@${hostPort}/${database}`,
    query,
  }
}

/** Google Cloud SQL subscriber: encrypt without implicit verify-full from sslrootcert=system. */
export function normalizeGoogleReplicaDatabaseUrl(url: string): string {
  const { base, query } = splitPostgresUrl(encodePostgresUrlPasswordIfNeeded(url))
  const params = new URLSearchParams(query)

  if (params.has('sslrootcert') && !params.has('sslmode')) {
    params.delete('sslrootcert')
  }

  if (!params.has('sslmode')) {
    params.set('sslmode', 'require')
    params.set('uselibpqcompat', 'true')
  }
  else if (params.get('sslmode') === 'require' && !params.has('uselibpqcompat')) {
    params.set('uselibpqcompat', 'true')
  }

  if (params.get('sslmode') === 'require' && params.get('sslrootcert') === 'system') {
    params.delete('sslrootcert')
  }

  const serialized = params.toString()
  return serialized ? `${base}?${serialized}` : base
}

export function googleReplicaPgClientConfig(url: string): ClientConfig {
  const connectionString = normalizeGoogleReplicaDatabaseUrl(url)
  const config = connectionConfig(connectionString)

  if (config.ssl === false) {
    return {
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      database: config.database,
      ssl: false,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    }
  }

  const rejectUnauthorized = typeof config.ssl === 'object'
    ? config.ssl.rejectUnauthorized
    : false

  return {
    user: config.user,
    password: config.password,
    host: config.host,
    port: config.port,
    database: config.database,
    ssl: { rejectUnauthorized },
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  }
}
import type { ClientConfig } from 'pg'
import {
  buildPostgresUrl,
  connectionConfig,
  encodePostgresUrlPasswordIfNeeded,
  parsePostgresConnectionUrl,
} from './postgres_connection_config.ts'

/** Google Cloud SQL subscriber: encrypt without implicit verify-full from sslrootcert=system. */
export function normalizeGoogleReplicaDatabaseUrl(url: string): string {
  const encoded = encodePostgresUrlPasswordIfNeeded(url)
  const parts = parsePostgresConnectionUrl(encoded)
  if (!parts)
    return encoded

  const params = new URLSearchParams(parts.query)

  if (!params.has('sslmode')) {
    if (params.get('sslrootcert') === 'system') {
      params.delete('sslrootcert')
    }
    params.set('sslmode', 'require')
    params.set('uselibpqcompat', 'true')
  }
  else if (params.get('sslmode') === 'require' && !params.has('uselibpqcompat')) {
    params.set('uselibpqcompat', 'true')
  }

  if (params.get('sslmode') === 'require' && params.get('sslrootcert') === 'system') {
    params.delete('sslrootcert')
  }

  return buildPostgresUrl({
    ...parts,
    query: params.toString(),
  })
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

  return {
    user: config.user,
    password: config.password,
    host: config.host,
    port: config.port,
    database: config.database,
    ssl: config.ssl,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
  }
}
import type { ClientConfig } from 'pg'
import { connectionConfig } from './postgres_connection_config.ts'

function splitPostgresUrl(url: string): { base: string, query: string } {
  const question = url.indexOf('?')
  if (question === -1)
    return { base: url, query: '' }
  return { base: url.slice(0, question), query: url.slice(question + 1) }
}

function parseQuery(query: string): URLSearchParams {
  return new URLSearchParams(query.replace(/&/gu, '&'))
}

function serializeQuery(params: URLSearchParams): string {
  const value = params.toString()
  return value ? `?${value}` : ''
}

/** Google Cloud SQL subscriber: encrypt without implicit verify-full from sslrootcert=system. */
export function normalizeGoogleReplicaDatabaseUrl(url: string): string {
  const { base, query } = splitPostgresUrl(url)
  const params = parseQuery(query)

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

  return `${base}${serializeQuery(params)}`
}

export function googleReplicaPgClientConfig(url: string): ClientConfig {
  const connectionString = normalizeGoogleReplicaDatabaseUrl(url)
  const config = connectionConfig(connectionString)

  if (config.ssl === false)
    return { ...config, connectionString }

  const rejectUnauthorized = typeof config.ssl === 'object'
    ? config.ssl.rejectUnauthorized
    : false

  return {
    ...config,
    connectionString,
    ssl: { rejectUnauthorized },
  }
}
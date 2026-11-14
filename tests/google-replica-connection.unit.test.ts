import { describe, expect, it } from 'vitest'
import {
  googleReplicaPgClientConfig,
  normalizeGoogleReplicaDatabaseUrl,
} from '../read_replicate/google_replica_connection.ts'

describe('google replica database connections', () => {
  it.concurrent('defaults missing sslmode to libpq-compatible require', () => {
    const raw = 'postgresql://replica:secret@34.12.34.56:5432/postgres'
    expect(normalizeGoogleReplicaDatabaseUrl(raw)).toBe(
      'postgresql://replica:secret@34.12.34.56:5432/postgres?sslmode=require&uselibpqcompat=true',
    )
    expect(googleReplicaPgClientConfig(raw).ssl).toEqual({ rejectUnauthorized: false })
  })

  it.concurrent('drops sslrootcert=system when it would imply verify-full', () => {
    const raw = 'postgresql://replica:secret@34.12.34.56:5432/postgres?sslrootcert=system'
    expect(normalizeGoogleReplicaDatabaseUrl(raw)).toBe(
      'postgresql://replica:secret@34.12.34.56:5432/postgres?sslmode=require&uselibpqcompat=true',
    )
    expect(googleReplicaPgClientConfig(raw).ssl).toEqual({ rejectUnauthorized: false })
  })

  it.concurrent('keeps explicit verify modes when callers set them', () => {
    const raw = 'postgresql://replica:secret@host:5432/postgres?sslmode=verify-full'
    const config = googleReplicaPgClientConfig(raw)
    expect(config.ssl).toEqual({ rejectUnauthorized: true })
  })
})
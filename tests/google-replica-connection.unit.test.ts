import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionOptions } from 'node:tls'
import { describe, expect, it } from 'vitest'
import {
  googleReplicaPgClientConfig,
  normalizeGoogleReplicaDatabaseUrl,
} from '../read_replicate/google_replica_connection.ts'

function replicaCaPath(): string {
  const caPath = join(tmpdir(), `replica-ca-${Date.now()}-${Math.random()}.pem`)
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n')
  return caPath
}

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

  it.concurrent('encodes passwords where ? would otherwise be parsed as query text', () => {
    const raw = 'postgresql://replica:123?word@10.0.0.1:5432/postgres'
    const config = googleReplicaPgClientConfig(raw)
    expect(config.port).toBe(5432)
    expect(config.password).toBe('123?word')
    expect(config.host).toBe('10.0.0.1')
  })

  it.concurrent('keeps passwords with unencoded ? when normalizing SSL params', () => {
    const raw = 'postgresql://replica:p?word@10.0.0.1:5432/postgres'
    expect(() => googleReplicaPgClientConfig(raw)).not.toThrow()
    expect(googleReplicaPgClientConfig(raw)).toMatchObject({
      password: 'p?word',
      ssl: { rejectUnauthorized: false },
    })
  })

  it.concurrent('keeps explicit verify modes when callers set them', () => {
    const raw = 'postgresql://replica:secret@host:5432/postgres?sslmode=verify-full'
    const config = googleReplicaPgClientConfig(raw)
    expect(config.ssl).toEqual({ rejectUnauthorized: true })
  })

  it.concurrent('verify-ca with a custom CA verifies the cert but not the hostname', () => {
    const caPath = replicaCaPath()
    const raw = `postgresql://replica:secret@10.0.0.1:5432/postgres?sslmode=verify-ca&sslrootcert=${encodeURIComponent(caPath)}`
    const ssl = googleReplicaPgClientConfig(raw).ssl as ConnectionOptions
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.ca).toBeInstanceOf(Buffer)
    expect(ssl.checkServerIdentity!('10.0.0.1', {} as never)).toBeUndefined()
  })

  it.concurrent('require with a custom CA matches libpq verify-ca (cert only, IP host)', () => {
    const caPath = replicaCaPath()
    const raw = `postgresql://replica:secret@10.0.0.1:5432/postgres?sslmode=require&sslrootcert=${encodeURIComponent(caPath)}`
    const ssl = googleReplicaPgClientConfig(raw).ssl as ConnectionOptions
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.ca).toBeInstanceOf(Buffer)
    expect(ssl.checkServerIdentity!('10.0.0.1', {} as never)).toBeUndefined()
  })

  it.concurrent('sslrootcert alone normalizes to require and verifies against the CA', () => {
    const caPath = replicaCaPath()
    const raw = `postgresql://replica:secret@10.0.0.1:5432/postgres?sslrootcert=${encodeURIComponent(caPath)}`
    expect(normalizeGoogleReplicaDatabaseUrl(raw)).toContain('sslmode=require')
    expect(normalizeGoogleReplicaDatabaseUrl(raw)).toContain(`sslrootcert=${encodeURIComponent(caPath)}`)
    const ssl = googleReplicaPgClientConfig(raw).ssl as ConnectionOptions
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.ca).toBeInstanceOf(Buffer)
    expect(ssl.checkServerIdentity!('10.0.0.1', {} as never)).toBeUndefined()
  })

  it.concurrent('parses user and password from query-string auth URLs', () => {
    const raw = 'postgresql://10.0.0.1:5432/postgres?user=replica&password=sec%24ret&sslmode=disable'
    const config = googleReplicaPgClientConfig(raw)
    expect(config).toMatchObject({
      user: 'replica',
      password: 'sec$ret',
      host: '10.0.0.1',
      port: 5432,
      database: 'postgres',
      ssl: false,
    })
  })

  it.concurrent('decodes query-string auth passwords only once', () => {
    const raw = 'postgresql://10.0.0.1:5432/postgres?user=replica&password=pa%25ss&sslmode=disable'
    expect(googleReplicaPgClientConfig(raw).password).toBe('pa%ss')
  })
})
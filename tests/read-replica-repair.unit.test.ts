import { describe, expect, it } from 'vitest'
import { connectionConfig } from '../read_replicate/replicate_repair.ts'

describe('connectionConfig', () => {
  it.concurrent('splits credentials at the last @ when the password holds unencoded ? and @', () => {
    const config = connectionConfig('postgresql://repl:a?b@c#d@10.0.0.5:5432/postgres?sslmode=require&connect_timeout=10')
    expect(config).toMatchObject({
      user: 'repl',
      password: 'a?b@c#d',
      host: '10.0.0.5',
      port: 5432,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10_000,
    })
  })

  it.concurrent('decodes percent-encoded credentials', () => {
    const config = connectionConfig('postgres://postgres:p%40ss%3Fword@db.example.com:6543/postgres')
    expect(config).toMatchObject({ user: 'postgres', password: 'p@ss?word', port: 6543 })
  })

  it.concurrent('verifies the certificate for sslrootcert=system without sslmode, like libpq', () => {
    expect(connectionConfig('postgresql://u:p@h:5432/db?sslrootcert=system').ssl).toEqual({ rejectUnauthorized: true })
    expect(connectionConfig('postgresql://u:p@h:5432/db?sslmode=disable').ssl).toBe(false)
  })

  it.concurrent('rejects strings that are not postgres URLs', () => {
    expect(() => connectionConfig('host=h user=u')).toThrow(/unsupported connection string/)
  })
})

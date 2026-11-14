import { describe, expect, it } from 'vitest'
import { encodePostgresUrlPasswordIfNeeded } from '../read_replicate/postgres_connection_config.ts'
import { parseReplicaEnvFile } from '../read_replicate/load_replica_env.ts'

describe('read-replica env loading', () => {
  it('parses env values literally without expanding $', () => {
    const parsed = parseReplicaEnvFile(
      'READ_REPLICATE_GOOGLE_EU1=postgresql://u:p$a$s?word\\tail@10.0.0.1:5432/postgres\n',
    )
    expect(parsed.READ_REPLICATE_GOOGLE_EU1).toBe(
      'postgresql://u:p$a$s?word\\tail@10.0.0.1:5432/postgres',
    )
  })

  it('keeps authority URLs that already parse for pg when password contains ?', () => {
    const raw = 'postgresql://replica:123?word@10.0.0.1:5432/postgres'
    expect(encodePostgresUrlPasswordIfNeeded(raw)).toBe(raw)
  })

  it('keeps authority URLs that already parse for pg when password contains $ and \\', () => {
    const raw = 'postgresql://replica_user:p$a$s?word\\tail@10.0.0.1:5432/postgres'
    expect(encodePostgresUrlPasswordIfNeeded(raw)).toBe(raw)
  })

  it('keeps already-parseable postgres URLs unchanged', () => {
    const raw = 'postgresql://replica_user:plain@10.0.0.1:5432/postgres'
    expect(encodePostgresUrlPasswordIfNeeded(raw)).toBe(raw)
  })

  it('does not double-encode passwords that are already percent-encoded', () => {
    const raw = 'postgresql://replica_user:p%24a%24s%3Fx@10.0.0.1:5432/postgres'
    expect(encodePostgresUrlPasswordIfNeeded(raw)).toBe(raw)
  })
})
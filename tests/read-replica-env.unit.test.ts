import { describe, expect, it } from 'vitest'
import {
  encodePostgresUrlPasswordIfNeeded,
  parseReplicaEnvFile,
} from '../read_replicate/load_replica_env.ts'

describe('read-replica env loading', () => {
  it('parses env values literally without expanding $', () => {
    const parsed = parseReplicaEnvFile(
      'READ_REPLICATE_GOOGLE_EU1=postgresql://u:p$a$s?word\\tail@10.0.0.1:5432/postgres\n',
    )
    expect(parsed.READ_REPLICATE_GOOGLE_EU1).toBe(
      'postgresql://u:p$a$s?word\\tail@10.0.0.1:5432/postgres',
    )
  })

  it('url-encodes the password when the URL fails to parse', () => {
    const raw = 'postgresql://replica_user:p$a$s?word\\tail@10.0.0.1:5432/postgres'
    const normalized = encodePostgresUrlPasswordIfNeeded(raw)
    expect(normalized).toBe(
      'postgresql://replica_user:p%24a%24s%3Fword%5Ctail@10.0.0.1:5432/postgres',
    )
    expect(() => new URL(normalized)).not.toThrow()
  })

  it('keeps already-parseable postgres URLs unchanged', () => {
    const raw = 'postgresql://replica_user:plain@10.0.0.1:5432/postgres'
    expect(encodePostgresUrlPasswordIfNeeded(raw)).toBe(raw)
  })
})
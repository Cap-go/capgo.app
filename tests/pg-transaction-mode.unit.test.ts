import type { Client, Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { getPgAccessMode, readOnlyStartupOptions, setPgAccessMode } from '../supabase/functions/_backend/plugin_runtime/utils/pg_transaction_mode.ts'

describe('pg access modes', () => {
  it.each(['HYPERDRIVE_CAPGO_DIRECT_EU', 'sb_pooler_main', 'direct', 'unknown'])('never sends a read-only startup default to shared %s connections', (source) => {
    expect(readOnlyStartupOptions(source, true)).toBeUndefined()
  })

  it('preserves dedicated replica startup protection', () => {
    expect(readOnlyStartupOptions('HYPERDRIVE_CAPGO_READ_EU', true)).toBe('-c default_transaction_read_only=on')
    expect(readOnlyStartupOptions('HYPERDRIVE_CAPGO_READ_EU', false)).toBeUndefined()
  })

  it('marks primary readers without checking out or querying a connection', () => {
    const pool = { connect: vi.fn(), query: vi.fn() } as unknown as Pool
    expect(setPgAccessMode(pool, true)).toBe(pool)
    expect(getPgAccessMode(pool)).toBe('read only')
    expect(pool.connect).not.toHaveBeenCalled()
    expect(pool.query).not.toHaveBeenCalled()

    const client = { query: vi.fn() } as unknown as Client
    expect(setPgAccessMode(client, false)).toBe(client)
    expect(getPgAccessMode(client)).toBe('read write')
    expect(client.query).not.toHaveBeenCalled()
  })
})

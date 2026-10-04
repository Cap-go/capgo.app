import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSupabaseClient, SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils.ts'

const bucket = `r2-schema-${randomUUID()}`
const admin = getSupabaseClient() as SupabaseClient
const anon = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const authenticated = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
let userId: string | undefined

beforeAll(async () => {
  const email = `r2-schema-${randomUUID()}@example.test`
  const password = `R2-schema-${randomUUID()}`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error)
    throw error
  userId = data.user.id
  const login = await authenticated.auth.signInWithPassword({ email, password })
  if (login.error)
    throw login.error
})

afterAll(async () => {
  await admin.from('r2_objects').delete().eq('bucket_name', bucket)
  await admin.from('r2_inventory_checkpoints').delete().eq('bucket_name', bucket)
  if (userId)
    await admin.auth.admin.deleteUser(userId)
})

async function insertRow(state = 'present', extra: Record<string, unknown> = {}) {
  const result = await admin.from('r2_objects').insert({
    bucket_name: bucket,
    r2_key: `objects/${randomUUID()}`,
    r2_state: state,
    ...extra,
  }).select().single()
  if (result.error)
    throw result.error
  return result.data
}

describe('internal R2 physical-key inventory', () => {
  it.concurrent.each(['to_be_uploaded', 'present', 'to_be_deleted', 'deleted'])('supports the %s lifecycle state', async (state) => {
    const row = await insertRow(state, state === 'deleted'
      ? { tombstone_expires_at: new Date(Date.now() + 86_400_000).toISOString() }
      : {})
    expect(row.r2_state).toBe(state)
    expect(row.revision).toBe(1)
    expect(row.size_bytes).toBeNull()
  })

  it.concurrent('records orphaned physical objects without any manifest/app relationship', async () => {
    const row = await insertRow('present', {
      r2_key: `unreferenced/${randomUUID()}/file.txt`,
      size_bytes: 42,
      etag: 'synthetic-etag',
    })
    expect(row.size_bytes).toBe(42)
    expect(row.etag).toBe('synthetic-etag')
  })

  it.concurrent('uses the exact bucket/key pair as unique identity', async () => {
    const row = await insertRow()
    const { error } = await admin.from('r2_objects').insert({
      bucket_name: bucket,
      r2_key: row.r2_key,
      r2_state: 'present',
    })
    expect(error?.code).toBe('23505')
    const other = await insertRow('present', { r2_key: `${row.r2_key}A` })
    expect(other.r2_key).not.toBe(row.r2_key)
  })

  it.concurrent('increments revision and preserves discovery time on updates', async () => {
    const row = await insertRow()
    const { data, error } = await admin.from('r2_objects').update({
      size_bytes: 123,
      revision: 999,
      first_seen_at: '2000-01-01T00:00:00Z',
    }).eq('bucket_name', bucket).eq('r2_key', row.r2_key).select().single()
    expect(error).toBeNull()
    expect(data.revision).toBe(2)
    expect(data.first_seen_at).toBe(row.first_seen_at)
    expect(Date.parse(data.updated_at)).toBeGreaterThanOrEqual(Date.parse(row.updated_at))
  })

  it.concurrent('prevents cancellation of committed deletion intent', async () => {
    const row = await insertRow('to_be_deleted')
    const cancelled = await admin.from('r2_objects').update({ r2_state: 'present' }).eq('bucket_name', bucket).eq('r2_key', row.r2_key)
    expect(cancelled.error?.code).toBe('23514')
    const deleted = await admin.from('r2_objects').update({
      r2_state: 'deleted',
      tombstone_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).eq('bucket_name', bucket).eq('r2_key', row.r2_key).select().single()
    expect(deleted.error).toBeNull()
    expect(deleted.data.r2_state).toBe('deleted')
  })

  it.concurrent('prevents changing the physical identity of an existing row', async () => {
    const row = await insertRow()
    const result = await admin.from('r2_objects').update({ r2_key: `renamed/${randomUUID()}` }).eq('bucket_name', bucket).eq('r2_key', row.r2_key)
    expect(result.error?.code).toBe('23514')
  })

  it.concurrent.each([
    { r2_state: 'deleted' },
    { r2_state: 'present', tombstone_expires_at: '2030-01-01T00:00:00Z' },
    { r2_state: 'present', size_bytes: -1 },
    { r2_state: 'present', r2_key: 'x'.repeat(1025) },
  ])('enforces bounded valid inventory data: %j', async (fields) => {
    const { error } = await admin.from('r2_objects').insert({
      bucket_name: bucket,
      r2_key: `invalid/${randomUUID()}`,
      ...fields,
    })
    expect(error?.code).toBe('23514')
  })

  it.concurrent('orders case-sensitive and Unicode keys by their UTF-8 bytes', async () => {
    const prefix = `ordering/${randomUUID()}/`
    const suffixes = ['é.txt', 'a.txt', 'Z.txt', 'A.txt']
    const insert = await admin.from('r2_objects').insert(suffixes.map(suffix => ({
      bucket_name: bucket,
      r2_key: prefix + suffix,
      r2_state: 'present',
    })))
    expect(insert.error).toBeNull()
    const { data, error } = await admin.from('r2_objects').select('r2_key').eq('bucket_name', bucket).like('r2_key', `${prefix}%`).order('r2_key')
    expect(error).toBeNull()
    expect(data?.map(row => row.r2_key.slice(prefix.length))).toEqual(['A.txt', 'Z.txt', 'a.txt', 'é.txt'])
  })

  it.concurrent.each(['anonymous', 'authenticated'])('denies %s inventory reads and writes', async (role) => {
    const client = role === 'anonymous' ? anon : authenticated
    for (const table of ['r2_objects', 'r2_inventory_checkpoints']) {
      const read = await client.from(table).select('*').limit(1)
      expect(read.error?.code).toBe('42501')
      const write = await client.from(table).insert(table === 'r2_objects'
        ? { bucket_name: bucket, r2_key: `denied/${randomUUID()}`, r2_state: 'present' }
        : { bucket_name: bucket, job_name: 'backfill', partition_key: randomUUID() })
      expect(write.error?.code).toBe('42501')
    }
  })

  it.concurrent('stores bounded checkpoint progress separately from runtime configuration', async () => {
    const { data, error } = await admin.from('r2_inventory_checkpoints').insert({
      bucket_name: bucket,
      job_name: 'backfill',
      partition_key: randomUUID(),
      checkpoint: { last_key: 'synthetic/file.txt', complete: false },
    }).select().single()
    expect(error).toBeNull()
    expect(data.checkpoint.last_key).toBe('synthetic/file.txt')
    const invalid = await admin.from('r2_inventory_checkpoints').insert({
      bucket_name: bucket,
      job_name: 'admission',
      accepted_event_floor: null,
    })
    expect(invalid.error?.code).toBe('23514')
  })
})

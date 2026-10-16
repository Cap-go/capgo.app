import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, describe, expect, it } from 'vitest'
import { SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils'

const admin = createClient(SUPABASE_BASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
const anon = createClient(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const subject = `apple-storage-${randomUUID()}`
const state = `state-${randomUUID()}`
afterAll(async () => {
  await admin.from('apple_auth_names').delete().eq('subject', subject)
  await admin.from('apple_auth_attempts').delete().eq('state_hash', state)
  await admin.from('apple_auth_token_uses').delete().eq('token_hash', state)
})
describe('apple auth server storage', () => {
  it('persists first-authorization names with bounded fields and rejects anonymous access', async () => {
    expect((await admin.from('apple_auth_names').insert({ subject, first_name: 'First', last_name: 'Authorization' })).error).toBeNull()
    expect((await admin.from('apple_auth_names').select('first_name').eq('subject', subject).single()).data?.first_name).toBe('First')
    expect((await anon.from('apple_auth_names').select('*').eq('subject', subject)).error?.code).toBe('42501')
    expect((await anon.from('apple_auth_names').insert({ subject: `${subject}-forged`, first_name: 'Forged' })).error?.code).toBe('42501')
    expect((await admin.from('apple_auth_names').update({ first_name: 'a'.repeat(101) }).eq('subject', subject)).error?.code).toBe('23514')
  })
  it('keeps attempts and replay records server-only, expiring and unique', async () => {
    const attempt = { state_hash: state, nonce: 'nonce', redirect_uri: 'https://console.example.com/login', code_challenge: 'challenge', client_state: 'state' }
    const inserted = await admin.from('apple_auth_attempts').insert(attempt).select('expires_at').single()
    expect(inserted.error).toBeNull()
    expect(Date.parse(inserted.data!.expires_at)).toBeGreaterThan(Date.now())
    expect((await admin.from('apple_auth_attempts').insert(attempt)).error?.code).toBe('23505')
    expect((await anon.from('apple_auth_attempts').select('*')).error?.code).toBe('42501')
    expect((await anon.from('apple_auth_attempts').insert({ ...attempt, state_hash: `${state}-forged` })).error?.code).toBe('42501')
    expect((await admin.from('apple_auth_token_uses').insert({ token_hash: state })).error).toBeNull()
    expect((await admin.from('apple_auth_token_uses').insert({ token_hash: state })).error?.code).toBe('23505')
    expect((await anon.from('apple_auth_token_uses').select('*')).error?.code).toBe('42501')
  })
})

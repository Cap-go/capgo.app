#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveOwnerOrgId } from '../src/analytics/org-resolver.ts'

console.log('🧪 Testing resolveOwnerOrgId...\n')

let calls = 0
const fakeCreate = async () => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { calls++; return { data: { owner_org: 'org-xyz' } } } }) }) }),
})

const a = await resolveOwnerOrgId('key-1', 'com.demo.app', { createClient: fakeCreate })
assert.equal(a, 'org-xyz')
const b = await resolveOwnerOrgId('key-1', 'com.demo.app', { createClient: fakeCreate })
assert.equal(b, 'org-xyz')
assert.equal(calls, 1, 'second lookup is served from the per-process cache')

const errCreate = async () => { throw new Error('no network') }
const c = await resolveOwnerOrgId('key-2', 'com.err.app', { createClient: errCreate })
assert.equal(c, undefined, 'errors resolve to undefined, never throw')

const clientOptions = []
const hostCreate = async (_apikey, supaHost, supaAnon) => {
  clientOptions.push({ supaAnon, supaHost })
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { owner_org: supaHost } }) }) }) }),
  }
}
const firstHost = await resolveOwnerOrgId('key-host', 'com.host.app', { createClient: hostCreate, supaHost: 'https://one.example', supaAnon: 'anon-one' })
const secondHost = await resolveOwnerOrgId('key-host', 'com.host.app', { createClient: hostCreate, supaHost: 'https://two.example', supaAnon: 'anon-two' })
assert.equal(firstHost, 'https://one.example')
assert.equal(secondHost, 'https://two.example')
assert.deepEqual(clientOptions, [
  { supaAnon: 'anon-one', supaHost: 'https://one.example' },
  { supaAnon: 'anon-two', supaHost: 'https://two.example' },
], 'custom hosts use separate cache entries and reach the client')

console.log('✅ resolveOwnerOrgId tests passed')

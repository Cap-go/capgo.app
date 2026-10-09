#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveOwnerOrgId } from '../src/analytics/org-resolver.ts'

console.log('🧪 Testing resolveOwnerOrgId...\n')

let calls = 0
const fakeFetch = async () => {
  calls++
  return 'org-xyz'
}

const a = await resolveOwnerOrgId('key-1', 'com.demo.app', { fetchOwnerOrg: fakeFetch })
assert.equal(a, 'org-xyz')
const b = await resolveOwnerOrgId('key-1', 'com.demo.app', { fetchOwnerOrg: fakeFetch })
assert.equal(b, 'org-xyz')
assert.equal(calls, 1, 'second lookup is served from the per-process cache')

const errFetch = async () => { throw new Error('no network') }
const c = await resolveOwnerOrgId('key-2', 'com.err.app', { fetchOwnerOrg: errFetch })
assert.equal(c, undefined, 'errors resolve to undefined, never throw')

let hostCalls = 0
const hostFetch = async () => `org-${++hostCalls}`
const firstHost = await resolveOwnerOrgId('key-host', 'com.host.app', { fetchOwnerOrg: hostFetch, apiHost: 'https://one.example' })
const secondHost = await resolveOwnerOrgId('key-host', 'com.host.app', { fetchOwnerOrg: hostFetch, apiHost: 'https://two.example' })
assert.equal(firstHost, 'org-1')
assert.equal(secondHost, 'org-2', 'custom hosts use separate cache entries')

console.log('✅ resolveOwnerOrgId tests passed')

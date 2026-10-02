#!/usr/bin/env bun
// getLoginState({ validate: true }) must classify a revoked/invalid key as logged out
// by HTTP status, not only by message text. Separate process: remote config is cached per process.
import process from 'node:process'

let pass = 0
let fail = 0
async function test(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, m) { if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const { getLoginState } = await import('../src/auth/session.ts')

for (const [label, status, body] of [
  ['identity endpoint 401', 401, { error: 'invalid_apikey', message: 'Invalid apikey' }],
  ['identity without a user', 200, { userId: null }],
]) {
  await test(`getLoginState({ validate: true }) reports a bad key as logged out (${label})`, async () => {
    const originalFetch = globalThis.fetch
    const originalToken = process.env.CAPGO_TOKEN
    process.env.CAPGO_TOKEN = 'revoked-key'
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/private/config'))
        return new Response(JSON.stringify({ supaHost: 'https://self-host.example.test', supaKey: 'anon' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/private/cli/identity'))
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    try {
      const state = await getLoginState({ validate: true })
      eq(state.loggedIn, false)
    }
    finally {
      globalThis.fetch = originalFetch
      if (originalToken === undefined)
        delete process.env.CAPGO_TOKEN
      else
        process.env.CAPGO_TOKEN = originalToken
    }
  })
}

console.log(`📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)

#!/usr/bin/env bun
/**
 * Unit tests for the shared auth core (src/auth/session.ts) — the single
 * validate/persist/introspect path behind `capgo login` and the MCP
 * capgo_login / capgo_whoami / capgo_logout tools.
 *
 * Covers the deterministic, offline surface: input guards, env-source detection,
 * local-key removal, and the pure user-facing message builders (which encode the
 * exact login / whoami / logout wording the tool handlers return — including the
 * honest "you are still signed in via …" logout branches).
 *
 * NOT covered here: the network validate+write success path of validateAndSaveKey,
 * which needs a live Capgo backend (resolveUserIdFromApiKey RPC). It is exercised
 * manually / via higher-level e2e, not by this unit suite.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

console.log('🧪 Testing auth/session...\n')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { console.log(`🔍 ${name}`); await fn(); console.log(`✅ ${name}\n`); pass++ }
  catch (e) { console.error(`❌ ${name}`); console.error(`   ${e.message}\n`); fail++ }
}
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy') }
function eq(a, b, m) { if (a !== b) throw new Error(m || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const {
  validateAndSaveKey,
  getLoginState,
  clearSavedKey,
  loginSuccessMessage,
  whoamiMessage,
  logoutMessage,
} = await import('../src/auth/session.ts')

await test('validateAndSaveKey rejects an empty key (no write, no network)', async () => {
  let threw = false
  try { await validateAndSaveKey('') }
  catch (e) { threw = true; ok(/Missing API key/.test(e.message), `unexpected message: ${e.message}`) }
  ok(threw, 'must throw on empty key')
})

await test('validateAndSaveKey(local) refuses outside a git repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-auth-nogit-'))
  const prev = process.cwd()
  process.chdir(dir)
  try {
    let threw = false
    // A non-empty key gets past the first guard, then the .git check fires
    // BEFORE any network call — so this stays offline and deterministic.
    try { await validateAndSaveKey('not-a-real-key', { local: true }) }
    catch (e) { threw = true; ok(/git repository/i.test(e.message), `unexpected message: ${e.message}`) }
    ok(threw, 'must refuse a local save without a .git directory')
  }
  finally { process.chdir(prev) }
})

await test('getLoginState detects the CAPGO_TOKEN env source without validating', async () => {
  const prev = process.env.CAPGO_TOKEN
  process.env.CAPGO_TOKEN = 'tok_unit_test_value'
  try {
    const state = await getLoginState()
    eq(state.loggedIn, true, 'an env token means logged in')
    eq(state.source, 'env', 'source should be env')
  }
  finally {
    if (prev === undefined) delete process.env.CAPGO_TOKEN
    else process.env.CAPGO_TOKEN = prev
  }
})

await test('clearSavedKey(local) removes ./.capgo and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgo-auth-clear-'))
  const prev = process.cwd()
  process.chdir(dir)
  try {
    eq((await clearSavedKey({ local: true })).cleared, false, 'nothing to clear yet')
    writeFileSync('.capgo', 'some-key\n')
    eq((await clearSavedKey({ local: true })).cleared, true, 'removes the existing local key')
    eq((await clearSavedKey({ local: true })).cleared, false, 'idempotent after removal')
  }
  finally { process.chdir(prev) }
})

await test('whoamiMessage covers signed-in / unverified / invalid / signed-out', () => {
  ok(/user u123/.test(whoamiMessage({ loggedIn: true, userId: 'u123', source: 'global', verified: true })), 'signed-in names the user')
  ok(/could not be reached/i.test(whoamiMessage({ loggedIn: true, source: 'env', verified: false })), 'unverified reported distinctly, not as logged-out')
  ok(/no longer valid/i.test(whoamiMessage({ loggedIn: false, source: 'local' })), 'present-but-invalid key is called out')
  ok(/not signed in\./i.test(whoamiMessage({ loggedIn: false })), 'no key → not signed in')
})

await test('logoutMessage is honest when a credential still remains', () => {
  const envRemains = logoutMessage(true, false, { loggedIn: true, source: 'env' })
  ok(/still signed in/i.test(envRemains) && /CAPGO_TOKEN/.test(envRemains), 'must warn the env token still authenticates')

  const localRemains = logoutMessage(true, false, { loggedIn: true, source: 'local' })
  ok(/still signed in/i.test(localRemains) && /scope "local"/.test(localRemains), 'must warn a cross-scope local key still authenticates')

  ok(/signed out/i.test(logoutMessage(true, false, { loggedIn: false })), 'clean sign-out when nothing remains')
  ok(/no .*to remove/i.test(logoutMessage(false, true, { loggedIn: false })), 'nothing-to-remove path')
})

await test('loginSuccessMessage names the user and the scope path', () => {
  const global = loginSuccessMessage('u9', false)
  ok(/user u9/.test(global) && global.includes('~/.capgo'), 'global path mentions user + ~/.capgo')
  ok(loginSuccessMessage('u9', true).includes('./.capgo'), 'local path mentions ./.capgo')
})

console.log(`📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)

#!/usr/bin/env node
/**
 * The MCP Google sign-in must never leave the user stuck. If the browser never
 * opened, was closed, or the flow stalled on "still waiting", next_step({ reopenSignIn:
 * true }) must drop the in-flight OAuth session and open a FRESH browser window.
 *
 * These tests drive the real android engine with a fake OAuth session (begin/poll/
 * clear with call counters) and assert that reopen clears the stale session and
 * begins a new flow — both directly (decideAndroid) and end-to-end (runAdvance, which
 * exercises the schema field + drive threading).
 */
import process from 'node:process'

console.log('🧪 Testing MCP Google sign-in reopen recovery...\n')

const { decideAndroid, runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
const { parseSchema } = await import('../src/schemas/schema_validation.ts')
const { onboardingNextStepSchema } = await import('../src/schemas/onboarding.ts')

let pass = 0
let fail = 0
async function test(name, fn) {
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }

// Fake OAuth session registry mirroring oauth-session.ts, with begin/clear counters.
// Fake broker-backed session mirroring broker-session.ts (begin/poll/clear), with begin/clear counters.
function makeOAuthSessionFake() {
  let entry = null
  const signInUrl = 'https://api.capgo.app/builder_auth_direct/google/start?s=PUB'
  return {
    beginCount: 0,
    clearCount: 0,
    begin(_appId) { this.beginCount++; entry = { status: 'pending', signInUrl }; return { signInUrl } },
    poll(_appId, _confirmCode) { return entry ? { status: entry.status, signInUrl: entry.signInUrl, accessToken: entry.accessToken, expiresAt: entry.expiresAt, error: entry.error } : { status: 'absent' } },
    clear(_appId) { this.clearCount++; entry = null },
  }
}

// Minimal android world whose resume step is google-sign-in (keystore done, generate
// path, no googleSignInComplete) — mirrors test-mcp-onboarding.mjs's gate world.
function googleSignInWorld() {
  const oauthSession = makeOAuthSessionFake()
  const progress = {
    platform: 'android', appId: 'com.acme.app', activePlatform: 'android', startedAt: new Date(2030, 0, 1).toISOString(),
    serviceAccountForkSeen: true, serviceAccountMethod: 'generate', keystoreMethod: 'generate',
    keystoreAlias: 'release', keystoreStorePassword: 'pw', keystoreKeyPassword: 'pw', _keystoreBase64: 'ks==',
    completedSteps: { keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true } },
  }
  const effectDeps = {
    saveAndroidProgress: async () => {},
    loadAndroidProgress: async () => progress,
    startOAuthFlow: async () => ({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', redirectUri: 'http://127.0.0.1/callback', result: new Promise(() => {}), close() {} }),
    fetchUserInfo: async () => ({ email: 'u@e.com', sub: 's' }),
    onStatus: undefined, onLog: undefined,
  }
  const deps = {
    cwd: '/tmp/app', hasSavedKey: () => true, getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['android'], isAppRegistered: async () => true,
    loadProgress: async () => null, loadAndroidProgress: async () => progress,
    registerApp: async () => ({ ok: true }), readBuildRecord: async () => null,
    buildRecordPath: (a, p) => `/tmp/rec-${a}-${p}.json`,
    androidEffectDeps: effectDeps, oauthSession,
    canLaunchTerminal: () => false, launchBuildInTerminal: async () => ({ ok: false, error: 'n/a' }),
  }
  const facts = { capacitorProject: true, appId: 'com.acme.app', platformsDetected: ['android'], authenticated: true, appRegistered: true, androidProgress: progress, iosProgress: null }
  return { deps, facts, oauthSession }
}

await test('schema keeps reopenSignIn (not stripped by the MCP SDK)', async () => {
  eq(parseSchema(onboardingNextStepSchema, { reopenSignIn: true }).reopenSignIn, true, 'reopenSignIn must survive schema parse')
})

await test('decideAndroid: reopen clears the stale session and begins a fresh OAuth flow', async () => {
  const { deps, facts, oauthSession } = googleSignInWorld()
  const first = await decideAndroid(facts, deps, { signInProceed: true })
  eq(first.state, 'google-sign-in')
  eq(oauthSession.beginCount, 1, 'first proceed must begin OAuth once')
  eq(oauthSession.poll().status, 'pending', 'session should be pending after begin')

  const reopened = await decideAndroid(facts, deps, { signInProceed: true, reopenSignIn: true })
  eq(reopened.state, 'google-sign-in')
  ok(oauthSession.clearCount >= 1, 'reopen must clear the stale session')
  eq(oauthSession.beginCount, 2, 'reopen must begin a FRESH OAuth flow (re-open the browser)')
})

await test('runAdvance({ reopenSignIn: true }) re-opens end-to-end (schema + drive threading)', async () => {
  const { deps, oauthSession } = googleSignInWorld()
  await runAdvance(deps, {}) // proceed → begin
  eq(oauthSession.beginCount, 1, 'plain continue begins OAuth')
  const r = await runAdvance(deps, { reopenSignIn: true }) // reopen
  eq(r.state, 'google-sign-in')
  eq(oauthSession.beginCount, 2, 'reopenSignIn must thread through drive and re-begin')
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)

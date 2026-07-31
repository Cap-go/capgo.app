#!/usr/bin/env node
/** Headless tests for the Appflow migration wiring in the MCP onboarding engine. */
import process from 'node:process'

console.log('🧪 Testing Appflow migration engine wiring...\n')

const { clearAllSessions, getAppflowProgress, setAppflowProgress } = await import('../src/build/onboarding/mcp/session-state.ts')
const { decideStart, decideAdvance } = await import('../src/build/onboarding/mcp/engine.ts')

let pass = 0
let fail = 0
async function test(name, fn) {
  clearAllSessions()
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }

const facts = (o = {}) => ({
  capacitorProject: true,
  appId: 'com.acme.app',
  platformsDetected: ['ios', 'android'],
  authenticated: true,
  appRegistered: true,
  androidProgress: null,
  iosProgress: null,
  ...o,
})

function fakeDeps(o = {}) {
  return {
    cwd: '/tmp/app',
    hasSavedKey: () => true,
    getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['ios', 'android'],
    isAppRegistered: async () => true,
    loadProgress: async () => null,
    loadAndroidProgress: async () => null,
    androidEffectDeps: { saveAndroidProgress: async () => {}, loadSavedCredentials: async () => null },
    ...o,
  }
}

await test('platform-select offers only iOS + Android (no Appflow card)', async () => {
  const r = await decideStart(facts(), null, fakeDeps())
  eq(r.state, 'platform-select')
  const values = r.options.map(o => o.value).sort()
  ok(JSON.stringify(values) === JSON.stringify(['android', 'ios']), `picker should offer only ios + android, got ${JSON.stringify(values)}`)
  ok(!r.options.some(o => o.value === 'appflow'), 'picker must NOT include an appflow option')
})

await test('the migration is reachable only via the per-platform gate (scope ios)', async () => {
  const r = await decideAdvance(facts({ platformsDetected: ['ios'] }), null, { platform: 'ios', migratingFromAppflow: 'yes' }, fakeDeps({ detectPlatforms: async () => ['ios'] }))
  eq(r.kind, 'human_gate')
  eq(r.state, 'appflow-explain')
  ok(/Appflow/i.test(r.summary), 'explain step mentions Appflow')
  ok(/support@capgo\.app/.test(r.human.instruction), 'explain step surfaces the support email')
  // The in-flight migration progress is parked process-local scoped to the platform.
  eq(getAppflowProgress('com.acme.app')?.scope, 'ios')
})

await test('a bare next_step resumes the in-flight Appflow migration (no platform needed)', async () => {
  const d = fakeDeps()
  // Pre-seed an in-flight migration parked at an INTERACTIVE step (so the bare
  // advance does not trigger the real browser auth effect). The no-signing
  // submenu is reached once signing has been fetched with no migratable platform.
  // Pre-seed an in-flight migration whose resume step is INTERACTIVE (so the
  // bare advance does not trigger the real browser-auth / network effects). With
  // signing + distribution + validate all done, resumeStep lands on the
  // handoff-build choice.
  setAppflowProgress('com.acme.app', {
    scope: 'ios',
    token: { access_token: 'ion_test', expires_in: 43200, capturedAtMs: Date.now() },
    orgSlug: 'org', appId: 'af-app',
    ios: { BUILD_CERTIFICATE_BASE64: 'x' },
    migratable: { ios: true, android: false },
    completedSteps: ['explain', 'authenticating', 'select-org', 'select-app', 'fetch-signing', 'fetch-distribution', 'validate'],
  })
  // A bare advance (no platform) must continue the migration, not bounce to the picker.
  const r = await decideAdvance(facts(), null, {}, d)
  ok(String(r.state).startsWith('appflow-'), `expected an appflow-* state, got ${r.state}`)
})

await test('migratingFromAppflow:yes on a single platform enters the migration scoped to it', async () => {
  const r = await decideAdvance(facts({ platformsDetected: ['ios'] }), null, { platform: 'ios', migratingFromAppflow: 'yes' }, fakeDeps({ detectPlatforms: async () => ['ios'] }))
  ok(String(r.state).startsWith('appflow-'), `expected an appflow-* state, got ${r.state}`)
  eq(getAppflowProgress('com.acme.app')?.scope, 'ios')
})

await test('a plain ios pick (no migration field) does NOT enter the migration', async () => {
  const r = await decideAdvance(facts(), null, { platform: 'ios' }, fakeDeps())
  ok(!String(r.state).startsWith('appflow-'), `a plain ios pick should not enter appflow, got ${r.state}`)
})

console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)

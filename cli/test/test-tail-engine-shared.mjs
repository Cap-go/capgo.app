#!/usr/bin/env node
/**
 * Plan — spec for the PLATFORM-NEUTRAL shared tail engine
 * (`src/build/onboarding/tail/flow.ts`).
 *
 * The post-save "tail" (CI-secrets → env-export → workflow-file → build-request)
 * was extracted out of `android/flow.ts` into a single platform-neutral module
 * so the iOS and Android tracks cannot drift. This test drives that shared
 * module DIRECTLY (not via the android adapter) acting as the headless driver:
 * it captures each `TailEffectResult.transient` and threads it back as
 * `deps.carried` on the next effect, exactly as the Ink TUI mirrors its React
 * state.
 *
 * It asserts the SAME routing the android tail engine test checks
 * (`test-android-tail-engine.mjs`), proving the extraction is behaviour-
 * preserving — but reached through the neutral surface with an injected
 * `platform`/`buildSavedCredentials`/`rebuildTailCredentials`/`resumeStep`. It
 * also exercises platform:'ios' through the neutral steps that do not need any
 * iOS-specific credential SHAPE (detect / upload / build-request / views).
 */
import process from 'node:process'

const {
  runTailEffect,
  tailViewForStep,
  applyTailInput,
} = await import('../src/build/onboarding/tail/flow.ts')

console.log('🧪 Shared platform-neutral TAIL engine — drives runTailEffect/tailViewForStep/applyTailInput\n')

let testsPassed = 0
let testsFailed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    testsPassed++
  }
  catch (err) {
    console.error(`❌ ${name}`)
    console.error(`   ${err instanceof Error ? err.message : String(err)}`)
    testsFailed++
  }
}

function assert(condition, message) {
  if (!condition)
    throw new Error(message || 'Assertion failed')
}

function assertEquals(actual, expected, message) {
  if (actual !== expected)
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const APP_ID = 'com.example.app'

// ─── Test fixtures ───────────────────────────────────────────────────────────

const GITHUB_TARGET = { provider: 'github', label: 'GitHub Actions repository secrets', cli: 'gh' }

const CI_ENTRIES = [
  { key: 'ANDROID_KEYSTORE_FILE', value: 'a2V5', masked: true },
  { key: 'KEYSTORE_KEY_ALIAS', value: 'release', masked: false },
  { key: 'CAPGO_TOKEN', value: 'tok', masked: true },
]

// The ANDROID saved-credential SHAPE the driver supplies to the neutral engine.
const ANDROID_CREDENTIALS = {
  ANDROID_KEYSTORE_FILE: 'a2V5',
  KEYSTORE_KEY_ALIAS: 'release',
  KEYSTORE_STORE_PASSWORD: 'pw',
  KEYSTORE_KEY_PASSWORD: 'pw',
  PLAY_CONFIG_JSON: 'eyJ9',
}

/** Progress mid-tail. Carries the same TailProgress fields the android fixture does. */
function tailProgress(overrides = {}) {
  return {
    platform: 'android',
    appId: APP_ID,
    startedAt: '2026-06-03T00:00:00.000Z',
    _keystoreBase64: 'a2V5',
    _serviceAccountKeyBase64: 'eyJ9',
    keystoreStorePassword: 'pw',
    keystoreKeyPassword: 'pw',
    keystoreAlias: 'release',
    ...overrides,
  }
}

/**
 * Android-shaped credential builder + lossy rebuild the driver injects. The
 * shared engine is platform-neutral — these mirror what `android/flow.ts`'s
 * `buildAndroidSavedCredentials` / `rebuildTailCredentials` supply.
 */
function buildAndroidSavedCredentials(progress) {
  if (!progress._keystoreBase64) throw new Error('keystore not ready')
  if (!progress._serviceAccountKeyBase64) throw new Error('service-account key not provisioned')
  if (!progress.keystoreStorePassword || !progress.keystoreAlias) throw new Error('keystore inputs missing')
  return {
    ANDROID_KEYSTORE_FILE: progress._keystoreBase64,
    KEYSTORE_KEY_ALIAS: progress.keystoreAlias,
    KEYSTORE_STORE_PASSWORD: progress.keystoreStorePassword,
    KEYSTORE_KEY_PASSWORD: progress.keystoreKeyPassword || progress.keystoreStorePassword,
    PLAY_CONFIG_JSON: progress._serviceAccountKeyBase64,
  }
}

function rebuildAndroidTailCredentials(progress) {
  if (!progress._keystoreBase64 || !progress._serviceAccountKeyBase64 || !progress.keystoreStorePassword || !progress.keystoreAlias)
    return {}
  return {
    ANDROID_KEYSTORE_FILE: progress._keystoreBase64,
    KEYSTORE_KEY_ALIAS: progress.keystoreAlias,
    KEYSTORE_STORE_PASSWORD: progress.keystoreStorePassword,
    KEYSTORE_KEY_PASSWORD: progress.keystoreKeyPassword || progress.keystoreStorePassword,
    PLAY_CONFIG_JSON: progress._serviceAccountKeyBase64,
  }
}

/**
 * Mocked TailEffectDeps. Every helper returns canned data — NO fs, NO network.
 * Records which helpers fired so the spec can assert the engine used the same
 * pure helper the android tail did.
 */
function makeDeps(overrides = {}) {
  const calls = []

  const deps = {
    platform: 'android',
    buildSavedCredentials: buildAndroidSavedCredentials,
    rebuildTailCredentials: rebuildAndroidTailCredentials,
    resumeStep: () => 'saving-credentials',

    updateSavedCredentials: async (...a) => { calls.push({ name: 'updateSavedCredentials', args: a }) },
    loadProgress: async () => null,
    saveProgress: async (...a) => { calls.push({ name: 'saveProgress', args: a }) },
    deleteProgress: async (...a) => { calls.push({ name: 'deleteProgress', args: a }) },

    createCiSecretEntries: (...a) => { calls.push({ name: 'createCiSecretEntries', args: a }); return CI_ENTRIES },
    detectCiSecretTargets: (...a) => {
      calls.push({ name: 'detectCiSecretTargets', args: a })
      return { targets: [GITHUB_TARGET], setup: [], notes: [] }
    },
    getCiSecretRepoLabelAsync: async (...a) => { calls.push({ name: 'getCiSecretRepoLabelAsync', args: a }); return 'octo/repo' },
    listExistingCiSecretKeysAsync: async (...a) => { calls.push({ name: 'listExistingCiSecretKeysAsync', args: a }); return [] },
    uploadCiSecretsAsync: async (...a) => { calls.push({ name: 'uploadCiSecretsAsync', args: a }) },
    exportCredentialsToEnv: (...a) => {
      calls.push({ name: 'exportCredentialsToEnv', args: a })
      return { kind: 'written', path: `/tmp/.env.capgo.${APP_ID}.android`, fieldCount: 5 }
    },
    defaultExportPath: (...a) => { calls.push({ name: 'defaultExportPath', args: a }); return `/tmp/.env.capgo.${APP_ID}.android` },
    generateWorkflow: (...a) => { calls.push({ name: 'generateWorkflow', args: a }); return { content: 'name: capgo-build\n' } },
    writeWorkflowFile: (...a) => {
      calls.push({ name: 'writeWorkflowFile', args: a })
      return { kind: 'written', absolutePath: '/repo/.github/workflows/capgo-build.yml' }
    },
    requestBuildInternal: async (...a) => { calls.push({ name: 'requestBuildInternal', args: a }); return { success: true } },

    onStatus: () => {},
    onLog: () => {},

    ...overrides,
  }
  deps.__calls = calls
  return deps
}

// ─── AUTO tail steps: drive through runTailEffect (android platform) ──────────

await test("saving-credentials → next 'ask-build' (uses createCiSecretEntries + buildSavedCredentials)", async () => {
  const deps = makeDeps()
  const res = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'ask-build', 'saving-credentials must route to ask-build')
  assert(deps.__calls.some(c => c.name === 'createCiSecretEntries'), 'must call createCiSecretEntries to stash CI entries')
  assert(deps.__calls.some(c => c.name === 'updateSavedCredentials'), 'must persist credentials')
  assert(deps.__calls.some(c => c.name === 'deleteProgress'), 'must delete progress on save')
  // The android credential SHAPE was supplied via buildSavedCredentials.
  const upd = deps.__calls.find(c => c.name === 'updateSavedCredentials')
  assertEquals(upd.args[1], 'android', 'updateSavedCredentials platform arg comes from deps.platform')
  assert(upd.args[2].ANDROID_KEYSTORE_FILE === 'a2V5', 'credential map is the android SHAPE')
})

await test("saving-credentials self-heal: resumeStep diverts when progress moved on", async () => {
  const deps = makeDeps({
    loadProgress: async () => tailProgress(),
    // Build-first contract: the divert only fires when the build genuinely fails.
    buildSavedCredentials: () => { throw new Error('required input missing (test)') },
    resumeStep: () => 'ask-build', // a fresh load that no longer wants saving-credentials
  })
  const res = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'ask-build', 'self-heal diverts to the resolved resume step')
  assert(!deps.__calls.some(c => c.name === 'updateSavedCredentials'), 'must NOT save when diverted')
})

await test("saving-credentials SAVES when the build succeeds even though the persisted resume points elsewhere (iOS-import ephemeral payload)", async () => {
  // The iOS IMPORT payload is transient-only: the persisted progress always
  // resumes at import-scanning. The old guard order diverted on that alone,
  // looping the import fork forever after a successful keychain export. The
  // build-first contract: a buildable credential map proves the inputs are
  // present — save, never divert.
  const logs = []
  const deps = makeDeps({
    onLog: (msg, color) => logs.push({ msg, color }),
    loadProgress: async () => tailProgress(),
    resumeStep: () => 'import-scanning', // persisted shape resumes elsewhere — must NOT divert
  })
  const res = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'ask-build', 'a buildable save proceeds to ask-build')
  assert(deps.__calls.some(c => c.name === 'updateSavedCredentials'), 'must save when the credential map builds')
  assert(!logs.some(l => /Some required input was missing/.test(l.msg)), 'no self-heal log on a successful build')
})

// ─── GAP 5: saving-credentials self-heal emits the 'missing input' log ──
//
// When the self-heal guard diverts (a fresh load resumes somewhere other than
// saving-credentials — input was missing), the bespoke android tail emits
// addLog('ℹ Some required input was missing — sending you back to fill it in.',
// 'yellow') BEFORE routing back (app.tsx ~L1331). The engine must emit the same
// via deps.onLog on the self-heal path.

await test('GAP5: saving-credentials self-heal emits the yellow missing-input log via onLog', async () => {
  const logs = []
  const deps = makeDeps({
    onLog: (msg, color) => logs.push({ msg, color }),
    loadProgress: async () => tailProgress(),
    buildSavedCredentials: () => { throw new Error('required input missing (test)') },
    resumeStep: () => 'gcp-projects-loading', // diverts somewhere earlier (input missing)
  })
  const res = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'gcp-projects-loading', 'self-heal diverts to the resolved resume step')
  const hit = logs.find(l => /Some required input was missing/.test(l.msg) && /sending you back to fill it in/.test(l.msg))
  assert(hit, 'must emit the missing-input guidance log on the self-heal path')
  assertEquals(hit.color, 'yellow', 'the missing-input log is yellow')
})

await test('GAP5: saving-credentials does NOT emit the missing-input log on the normal save path', async () => {
  const logs = []
  const deps = makeDeps({ onLog: (msg, color) => logs.push({ msg, color }) })
  const res = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'ask-build', 'a normal save routes to ask-build')
  assert(!logs.some(l => /Some required input was missing/.test(l.msg)), 'the missing-input log fires ONLY on the self-heal divert')
})

await test("requesting-build (success, entries present) → next 'detecting-ci-secrets' (uses requestBuildInternal)", async () => {
  const deps = makeDeps()
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'detecting-ci-secrets', 'a successful build with pending entries must route to detecting-ci-secrets')
  assert(deps.__calls.some(c => c.name === 'requestBuildInternal'), 'must call requestBuildInternal')
  const req = deps.__calls.find(c => c.name === 'requestBuildInternal')
  assertEquals(req.args[1].platform, 'android', 'requestBuildInternal platform comes from deps.platform')
})

// ─── CONCERN 1: requesting-build threads logger + driver-resolved apikey ───────

await test('requesting-build threads the injected logger AND a driver-RESOLVED apikey into requestBuildInternal', async () => {
  const logger = { info() {}, error() {}, warn() {}, success() {}, buildLog() {}, uploadProgress() {}, customMsg() {} }
  const deps = makeDeps({
    logger,
    resolveApikey: () => 'resolved-cli-key',
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'detecting-ci-secrets', 'a successful build with pending entries routes to detecting-ci-secrets')
  const req = deps.__calls.find(c => c.name === 'requestBuildInternal')
  assert(req, 'must call requestBuildInternal')
  assertEquals(req.args[1].apikey, 'resolved-cli-key', 'requestBuildInternal must receive the driver-resolved apikey (NOT hardcoded empty string)')
  assertEquals(req.args[1].aiAnalysisMode, 'caller-handled', 'caller-handled mode so the TUI owns the AI sub-flow')
  assertEquals(req.args[3], logger, 'requestBuildInternal must receive the injected BuildLogger as the 4th arg')
})

await test('requesting-build with no resolved apikey routes straight to build-complete (no build attempt)', async () => {
  const deps = makeDeps({
    resolveApikey: () => undefined,
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'no API key → skip the build attempt and finish')
  assert(!deps.__calls.some(c => c.name === 'requestBuildInternal'), 'must NOT call requestBuildInternal when no key is resolvable')
})

await test('requesting-build success (success, NO entries) → build-complete with buildUrl', async () => {
  const deps = makeDeps({ carried: { ciSecretEntries: [] } })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a successful build with no pending entries finishes the wizard')
  assert(res.transient && typeof res.transient.buildUrl === 'string', 'must surface the build URL in transient')
})

await test('requesting-build failure with AI job ready → next ai-analysis-prompt (TUI renders it; aiJobId in transient)', async () => {
  const deps = makeDeps({
    requestBuildInternal: async (...a) => {
      deps.__calls.push({ name: 'requestBuildInternal', args: a })
      return { success: false, error: 'boom', aiAnalysis: { jobId: 'JOB1', capturedLogPath: '/tmp/log', ready: true } }
    },
    resolveApikey: () => 'k',
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'ai-analysis-prompt', 'a failed build with a ready AI job routes to ai-analysis-prompt')
  assertEquals(res.transient && res.transient.aiJobId, 'JOB1', 'the AI job id must ride in transient for the TUI')
})

await test('requesting-build failure with NO AI job → build-complete', async () => {
  const deps = makeDeps({
    requestBuildInternal: async (...a) => {
      deps.__calls.push({ name: 'requestBuildInternal', args: a })
      return { success: false, error: 'boom' }
    },
    resolveApikey: () => 'k',
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a failed build with no AI job finishes the wizard')
})

// ─── GAP 1: requesting-build writes the build VIEWER lines via onBuildOutput ───
//
// The bespoke android tail (app.tsx ~L1654-1740) writes the build VIEWER lines
// (header / queued / error / no-key UX) via setBuildOutput — a sink DISTINCT
// from the side-log addLog. The shared engine must emit those via the OPTIONAL
// deps.onBuildOutput, and a thrown build request must route to build-complete
// (NOT throw) after emitting the 2 catch lines via onBuildOutput.

await test('GAP1: requesting-build emits header + blank + queued lines via onBuildOutput (success path)', async () => {
  const buildLines = []
  const deps = makeDeps({
    onBuildOutput: line => buildLines.push(line),
    resolveApikey: () => 'k',
    carried: { ciSecretEntries: [] },
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'success with no entries finishes at build-complete')
  assert(buildLines[0] === `Requesting build for ${APP_ID} (android)...`, 'first build-viewer line is the header (replaces, not the side-log)')
  assert(buildLines.includes(''), 'a blank line precedes the queued line (parity with setBuildOutput([..., \'\', queued]))')
  assert(buildLines.some(l => /^✔ Build queued — https:\/\/console\.capgo\.app\/app\//.test(l)), 'queued line goes to the build viewer')
})

await test('GAP1: requesting-build emits the no-key 2-line UX via onBuildOutput and finishes at build-complete', async () => {
  const buildLines = []
  const deps = makeDeps({
    onBuildOutput: line => buildLines.push(line),
    resolveApikey: () => undefined,
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'no key → finish at build-complete')
  assert(!deps.__calls.some(c => c.name === 'requestBuildInternal'), 'must NOT attempt a build with no key')
  assert(buildLines.some(l => /No Capgo API key found/.test(l)), 'no-key line 1 goes to the build viewer')
  assert(buildLines.some(l => /capgo login.*capgo build request --platform android/.test(l)), 'no-key line 2 goes to the build viewer')
})

await test('GAP1: requesting-build emits the failure ⚠ line via onBuildOutput', async () => {
  const buildLines = []
  const deps = makeDeps({
    onBuildOutput: line => buildLines.push(line),
    resolveApikey: () => 'k',
    requestBuildInternal: async (...a) => { deps.__calls.push({ name: 'requestBuildInternal', args: a }); return { success: false, error: 'boom' } },
  })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a failed build with no AI job finishes at build-complete')
  assert(buildLines.some(l => /^⚠ boom/.test(l)), 'the failure line goes to the build viewer')
})

await test('GAP1: requesting-build that THROWS routes to build-complete with transient.error + 2 catch lines via onBuildOutput (no throw)', async () => {
  const buildLines = []
  const deps = makeDeps({
    onBuildOutput: line => buildLines.push(line),
    resolveApikey: () => 'k',
    requestBuildInternal: async () => { throw new Error('network down') },
  })
  let threw = false
  let res
  try {
    res = await runTailEffect('requesting-build', tailProgress(), deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'requesting-build must NOT propagate a thrown build request')
  assertEquals(res.next, 'build-complete', 'a thrown build request still finishes at build-complete')
  assert(res.transient && /network down/.test(res.transient.error), 'the thrown error rides in transient.error')
  assert(buildLines.some(l => /^⚠ network down/.test(l)), 'catch line 1 (the error) goes to the build viewer')
  assert(buildLines.some(l => /Your credentials are saved.*capgo build request --platform android.*try again/.test(l)), 'catch line 2 (the retry hint) goes to the build viewer')
})

await test('GAP1: requesting-build degrades gracefully when onBuildOutput is ABSENT (iOS)', async () => {
  // No onBuildOutput injected — the build-viewer lines are simply dropped.
  const deps = makeDeps({ resolveApikey: () => undefined })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'routing is unaffected when onBuildOutput is absent')
})

await test("detecting-ci-secrets (single GitHub target) → next 'ask-github-actions-setup' (uses detectCiSecretTargets)", async () => {
  const deps = makeDeps()
  const res = await runTailEffect('detecting-ci-secrets', tailProgress(), deps)
  assertEquals(res.next, 'ask-github-actions-setup', 'a single GitHub target routes to the GitHub Actions setup prompt')
  assert(deps.__calls.some(c => c.name === 'detectCiSecretTargets'), 'must call detectCiSecretTargets')
})

await test("checking-ci-secrets (GitHub) → next 'confirm-secrets-push' (uses getCiSecretRepoLabelAsync + listExistingCiSecretKeysAsync)", async () => {
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('checking-ci-secrets', progress, deps)
  assertEquals(res.next, 'confirm-secrets-push', 'GitHub target routes to the confirm-secrets-push gate')
  assert(deps.__calls.some(c => c.name === 'getCiSecretRepoLabelAsync'), 'must resolve the repo label')
  assert(deps.__calls.some(c => c.name === 'listExistingCiSecretKeysAsync'), 'must list existing secret keys')
})

// ─── CONCERN 3: checking-ci-secrets surfaces the 2-phase status text ───────────

await test('checking-ci-secrets (GitHub) surfaces the 2-phase status via onCiSecretCheckPhase ONLY (not onStatus)', async () => {
  const statuses = []
  const phases = []
  const deps = makeDeps({
    onStatus: msg => statuses.push(msg),
    onCiSecretCheckPhase: phase => phases.push(phase),
    getCiSecretRepoLabelAsync: async (...a) => { deps.__calls.push({ name: 'getCiSecretRepoLabelAsync', args: a }); return 'octo/repo' },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('checking-ci-secrets', progress, deps)
  assertEquals(res.next, 'confirm-secrets-push', 'GitHub target routes to confirm-secrets-push')
  // GAP 2: the check phases fire on the DEDICATED onCiSecretCheckPhase hook only
  // (android: setCiSecretCheckPhase). They MUST NOT go through onStatus — the
  // driver routes onStatus to the oauth/gcp sinks, so reusing it here would
  // corrupt those panes.
  assert(phases.some(p => /Resolving GitHub repository/i.test(p)), 'phase 1 fires onCiSecretCheckPhase')
  assert(phases.some(p => /Checking existing env vars in octo\/repo/i.test(p)), 'phase 2 fires onCiSecretCheckPhase with the repo')
  assert(!statuses.some(s => /Resolving GitHub repository/i.test(s)), 'phase 1 must NOT go through onStatus')
  assert(!statuses.some(s => /Checking existing env vars/i.test(s)), 'phase 2 must NOT go through onStatus')
})

await test('checking-ci-secrets (GitLab) phase 2 names the target label via onCiSecretCheckPhase only (no repo resolution)', async () => {
  const GITLAB_TARGET = { provider: 'gitlab', label: 'GitLab CI/CD variables', cli: 'glab' }
  const statuses = []
  const phases = []
  const deps = makeDeps({ onStatus: msg => statuses.push(msg), onCiSecretCheckPhase: p => phases.push(p) })
  const progress = tailProgress({ ciSecretTarget: GITLAB_TARGET, setupMode: 'secrets-only' })
  const res = await runTailEffect('checking-ci-secrets', progress, deps)
  // GitLab with no existing keys → uploading-ci-secrets.
  assertEquals(res.next, 'uploading-ci-secrets', 'GitLab with no existing keys routes to upload')
  assert(phases.some(p => /Checking existing env vars in GitLab CI\/CD variables/i.test(p)), 'GitLab phase 2 names the target label via onCiSecretCheckPhase')
  assert(!statuses.some(s => /Checking existing env vars/i.test(s)), 'GitLab phase 2 must NOT go through onStatus')
  assert(!deps.__calls.some(c => c.name === 'getCiSecretRepoLabelAsync'), 'GitLab must not resolve a GitHub repo label')
})

// ─── GAP 2: checking-ci-secrets sets ciSecretError + routes to ci-secrets-failed ──
//
// The bespoke android tail (app.tsx ~L1421-1452) sets ciSecretError on the
// repo-null path and in its catch, then routes to ci-secrets-failed — it never
// throws (credentials are already saved). The shared engine surfaces the reason
// via transient.ciSecretError AND the OPTIONAL deps.onCiSecretError hook.

await test('GAP2: checking-ci-secrets repo-null sets transient.ciSecretError + onCiSecretError and routes to ci-secrets-failed', async () => {
  const errors = []
  const deps = makeDeps({
    onCiSecretError: msg => errors.push(msg),
    getCiSecretRepoLabelAsync: async (...a) => { deps.__calls.push({ name: 'getCiSecretRepoLabelAsync', args: a }); return null },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('checking-ci-secrets', progress, deps)
  assertEquals(res.next, 'ci-secrets-failed', 'an unresolvable GitHub repo routes to ci-secrets-failed')
  assert(res.transient && /Could not resolve the GitHub repository/.test(res.transient.ciSecretError), 'the repo-null reason rides in transient.ciSecretError')
  assert(res.transient.ciSecretRepoLabel === null, 'the repo label is surfaced as null')
  assert(errors.some(e => /Could not resolve the GitHub repository/.test(e)), 'onCiSecretError fires with the repo-null reason')
})

await test('GAP2: checking-ci-secrets that THROWS routes to ci-secrets-failed with transient.ciSecretError (no throw)', async () => {
  const errors = []
  const deps = makeDeps({
    onCiSecretError: msg => errors.push(msg),
    getCiSecretRepoLabelAsync: async () => { throw new Error('gh exploded') },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  let threw = false
  let res
  try {
    res = await runTailEffect('checking-ci-secrets', progress, deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'checking-ci-secrets must NOT propagate the throw')
  assertEquals(res.next, 'ci-secrets-failed', 'a thrown check routes to ci-secrets-failed')
  assert(res.transient && /gh exploded/.test(res.transient.ciSecretError), 'the thrown reason rides in transient.ciSecretError')
  assert(errors.some(e => /gh exploded/.test(e)), 'onCiSecretError fires with the thrown reason')
})

await test('GAP2: checking-ci-secrets with NO target routes to ci-secrets-failed (no throw)', async () => {
  const deps = makeDeps()
  let threw = false
  let res
  try {
    res = await runTailEffect('checking-ci-secrets', tailProgress(), deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'a missing target must NOT throw out of the engine')
  assertEquals(res.next, 'ci-secrets-failed', 'a missing target routes to ci-secrets-failed')
  assert(res.transient && typeof res.transient.ciSecretError === 'string', 'the missing-target reason rides in transient.ciSecretError')
})

await test('checking-ci-secrets degrades gracefully when onStatus/onCiSecretCheckPhase are absent (iOS)', async () => {
  // makeDeps provides a no-op onStatus; remove the check-phase hook entirely.
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('checking-ci-secrets', progress, deps)
  assertEquals(res.next, 'confirm-secrets-push', 'routing is unaffected when the status hooks are no-ops/absent')
})

await test("uploading-ci-secrets (setupMode=with-workflow) → next 'pick-package-manager' (uses uploadCiSecretsAsync)", async () => {
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow continues into the workflow-builder sub-flow')
  assert(deps.__calls.some(c => c.name === 'uploadCiSecretsAsync'), 'must call uploadCiSecretsAsync')
})

await test("uploading-ci-secrets (setupMode=secrets-only) → next 'build-complete'", async () => {
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'secrets-only' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'build-complete', 'secrets-only finishes after upload')
})

// ─── CONCERN 2: upload progress callback + workflow-builder script preload ─────

await test('uploading-ci-secrets forwards the injected onCiSecretUploadProgress as the 5th arg of uploadCiSecretsAsync', async () => {
  const progressEvents = []
  const deps = makeDeps({
    onCiSecretUploadProgress: (current, total, key) => progressEvents.push({ current, total, key }),
    uploadCiSecretsAsync: async (target, entries, existing, runner, onProgress) => {
      deps.__calls.push({ name: 'uploadCiSecretsAsync', args: [target, entries, existing, runner, onProgress] })
      // The engine must pass a callback through — simulate the helper invoking it.
      onProgress?.(1, 2, 'CAPGO_TOKEN')
    },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'secrets-only' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'build-complete', 'secrets-only finishes after upload')
  const upload = deps.__calls.find(c => c.name === 'uploadCiSecretsAsync')
  assert(upload, 'must call uploadCiSecretsAsync')
  assertEquals(typeof upload.args[4], 'function', 'uploadCiSecretsAsync must receive an onProgress callback as the 5th arg')
  assertEquals(progressEvents.length, 1, 'the injected onCiSecretUploadProgress must be invoked by the forwarded callback')
  assertEquals(progressEvents[0].key, 'CAPGO_TOKEN', 'progress event carries the key name')
})

await test('uploading-ci-secrets (with-workflow) preloads scripts + recommended script into transient BEFORE pick-package-manager', async () => {
  const deps = makeDeps({
    getPackageScripts: () => ({ build: 'vite build', dev: 'vite', test: 'vitest' }),
    findProjectType: async () => 'vue',
    findBuildCommandForProjectType: async () => 'build',
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow continues into the workflow-builder sub-flow')
  assert(res.transient && res.transient.availableScripts, 'preload must surface availableScripts in transient')
  assertEquals(res.transient.availableScripts.build, 'vite build', 'availableScripts carries the package.json scripts')
  assertEquals(res.transient.recommendedScript, 'build', 'recommendedScript is the build command for the detected project type')
})

await test('uploading-ci-secrets (with-workflow) recommendedScript stays null when the recommended command is not in scripts', async () => {
  const deps = makeDeps({
    getPackageScripts: () => ({ dev: 'vite' }),
    findProjectType: async () => 'nuxtjs',
    findBuildCommandForProjectType: async () => 'generate', // not present in scripts
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow still routes to pick-package-manager')
  assert(res.transient && res.transient.availableScripts, 'still surfaces the scripts map')
  assert(!res.transient.recommendedScript, 'recommendedScript must stay null/undefined when the command is not a known script')
})

await test('uploading-ci-secrets (with-workflow) degrades gracefully when the preload deps are ABSENT (iOS)', async () => {
  // No getPackageScripts/findProjectType/findBuildCommandForProjectType injected.
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow still routes to pick-package-manager without a preload')
  // No throw, and no scripts surfaced — pick-build-script will fall back to escape hatches.
  assert(!res.transient || !res.transient.availableScripts, 'no availableScripts surfaced when the preload deps are absent')
})

await test("exporting-env (written) → next 'build-complete' (uses exportCredentialsToEnv + defaultExportPath)", async () => {
  const deps = makeDeps()
  const res = await runTailEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a successful export finishes the wizard')
  assert(deps.__calls.some(c => c.name === 'exportCredentialsToEnv'), 'must call exportCredentialsToEnv')
  const ex = deps.__calls.find(c => c.name === 'exportCredentialsToEnv')
  assertEquals(ex.args[0].platform, 'android', 'exportCredentialsToEnv platform comes from deps.platform')
})

await test("writing-workflow-file (written) → next 'build-complete' (uses writeWorkflowFile)", async () => {
  const deps = makeDeps()
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runTailEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'after the workflow file is written the wizard finishes')
  assert(deps.__calls.some(c => c.name === 'writeWorkflowFile'), 'must call writeWorkflowFile')
  const wf = deps.__calls.find(c => c.name === 'writeWorkflowFile')
  assertEquals(wf.args[0].defaultPlatform, 'android', 'workflow defaultPlatform comes from deps.platform')
})

// ─── CONCERN 4: writing-workflow-file telemetry + log text ─────────────────────

await test('writing-workflow-file (written) calls trackWorkflowEvent("workflow-file-written") and logs the workflow path', async () => {
  const events = []
  const logs = []
  const deps = makeDeps({
    trackWorkflowEvent: (event, options) => events.push({ event, options }),
    onLog: (msg, color) => logs.push({ msg, color }),
  })
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runTailEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'after the workflow file is written the wizard finishes')
  assert(events.some(e => e.event === 'workflow-file-written'), 'must fire the workflow-file-written telemetry event')
  const written = events.find(e => e.event === 'workflow-file-written')
  assertEquals(written.options && written.options.decision, 'write', 'telemetry carries decision: write')
  assert(logs.some(l => /✔ (Wrote|Overwrote) .+capgo-build\.yml/.test(l.msg)), 'must log the written workflow path')
})

await test('writing-workflow-file degrades gracefully when trackWorkflowEvent is ABSENT (iOS)', async () => {
  const deps = makeDeps()
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'npm',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runTailEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'no telemetry hook → still finishes (no throw)')
})

// ─── GAP 3: writing-workflow-file logs Wrote vs Overwrote from carried.workflowIsNew ──
//
// The bespoke android tail (app.tsx ~L1572) logs `✔ ${previewIsNew ? 'Wrote'
// : 'Overwrote'} ${WORKFLOW_PATH}`. previewIsNew is resolved at the preview step
// (existsSync) — TUI/driver state — so the driver threads it back via
// deps.carried.workflowIsNew. Default (absent / undefined) is NEW ('Wrote'),
// matching the bespoke React useState(true) default.

function wfProgress() {
  return tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
}

await test('GAP3: writing-workflow-file logs ✔ Overwrote when carried.workflowIsNew === false', async () => {
  const logs = []
  const deps = makeDeps({ onLog: (msg, color) => logs.push({ msg, color }), carried: { workflowIsNew: false } })
  const res = await runTailEffect('writing-workflow-file', wfProgress(), deps)
  assertEquals(res.next, 'build-complete', 'still finishes the wizard')
  assert(logs.some(l => /^✔ Overwrote .+capgo-build\.yml/.test(l.msg)), 'an existing file logs Overwrote')
  assert(!logs.some(l => /^✔ Wrote /.test(l.msg)), 'must NOT log Wrote when the file already existed')
})

await test('GAP3: writing-workflow-file logs ✔ Wrote when carried.workflowIsNew === true', async () => {
  const logs = []
  const deps = makeDeps({ onLog: (msg, color) => logs.push({ msg, color }), carried: { workflowIsNew: true } })
  const res = await runTailEffect('writing-workflow-file', wfProgress(), deps)
  assertEquals(res.next, 'build-complete', 'still finishes the wizard')
  assert(logs.some(l => /^✔ Wrote .+capgo-build\.yml/.test(l.msg)), 'a new file logs Wrote')
})

await test('GAP3: writing-workflow-file defaults to ✔ Wrote when carried.workflowIsNew is absent (new-file default)', async () => {
  const logs = []
  const deps = makeDeps({ onLog: (msg, color) => logs.push({ msg, color }) })
  const res = await runTailEffect('writing-workflow-file', wfProgress(), deps)
  assertEquals(res.next, 'build-complete', 'still finishes the wizard')
  assert(logs.some(l => /^✔ Wrote .+capgo-build\.yml/.test(l.msg)), 'absent signal defaults to Wrote (parity with useState(true))')
})

// ─── CONCERN 5: env-export error routes to build-complete (never throws) ───────

await test('exporting-env (empty result) sets transient.envExportError and routes to build-complete (no throw)', async () => {
  const deps = makeDeps({
    exportCredentialsToEnv: (...a) => { deps.__calls.push({ name: 'exportCredentialsToEnv', args: a }); return { kind: 'empty' } },
  })
  const res = await runTailEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'an empty export must still finish at build-complete')
  assert(res.transient && typeof res.transient.envExportError === 'string', 'an empty export must surface envExportError in transient')
})

await test('exporting-env that THROWS routes to build-complete with envExportError (does not propagate)', async () => {
  const deps = makeDeps({
    exportCredentialsToEnv: () => { throw new Error('disk full') },
  })
  let threw = false
  let res
  try {
    res = await runTailEffect('exporting-env', tailProgress(), deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'exporting-env must NOT propagate the throw')
  assertEquals(res.next, 'build-complete', 'a thrown export still finishes at build-complete')
  assert(res.transient && /disk full/.test(res.transient.envExportError), 'the thrown error message rides in transient.envExportError')
})

await test('overwrite-and-export-env that THROWS routes to build-complete with envExportError (does not propagate)', async () => {
  const deps = makeDeps({
    exportCredentialsToEnv: () => { throw new Error('permission denied') },
  })
  const progress = tailProgress({ setupMode: 'declined', envExportTargetPath: `/tmp/.env.capgo.${APP_ID}.android` })
  let threw = false
  let res
  try {
    res = await runTailEffect('overwrite-and-export-env', progress, deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'overwrite-and-export-env must NOT propagate the throw')
  assertEquals(res.next, 'build-complete', 'a thrown overwrite-export still finishes at build-complete')
  assert(res.transient && /permission denied/.test(res.transient.envExportError), 'the thrown error message rides in transient.envExportError')
})

// ─── DRIVER threading: resolve credentials + CI entries ONCE, reuse downstream ──

const RESOLVED_ENTRIES = [
  { key: 'ANDROID_KEYSTORE_FILE', value: 'a2V5', masked: true },
  { key: 'KEYSTORE_KEY_ALIAS', value: 'release', masked: false },
  { key: 'CAPGO_TOKEN', value: 'resolved-capgo-key', masked: true },
]
const EXISTING_KEYS = ['CAPGO_TOKEN']

function makeDriverDeps(overrides = {}) {
  return makeDeps({
    createCiSecretEntries: (..._a) => {
      makeDriverDeps.__entryCalls = (makeDriverDeps.__entryCalls || 0) + 1
      return RESOLVED_ENTRIES
    },
    ...overrides,
  })
}

await test('DRIVER: createCiSecretEntries resolves ONCE at saving-credentials and is REUSED (not rebuilt) in checking', async () => {
  makeDriverDeps.__entryCalls = 0
  const deps = makeDriverDeps()

  // ── 1) saving-credentials: resolve entries + credentials ONCE ──
  const saved = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(saved.next, 'ask-build', 'saving-credentials routes to ask-build')
  assertEquals(makeDriverDeps.__entryCalls, 1, 'createCiSecretEntries must be called exactly once (at saving-credentials)')
  assert(saved.transient && saved.transient.ciSecretEntries, 'saving-credentials must return ciSecretEntries in transient')
  assert(saved.transient.savedCredentials, 'saving-credentials must return savedCredentials in transient')
  assert(
    saved.transient.ciSecretEntries.some(e => e.key === 'CAPGO_TOKEN'),
    'resolved entries must include the CAPGO_TOKEN folded in at saving-credentials',
  )

  // The driver captures the transient and threads it back as carried.
  const carried = {
    savedCredentials: saved.transient.savedCredentials,
    ciSecretEntries: saved.transient.ciSecretEntries,
  }

  // ── 2) checking-ci-secrets: REUSE carried entries — do NOT rebuild ──
  const checkDeps = makeDriverDeps({ carried })
  const checkProgress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const checked = await runTailEffect('checking-ci-secrets', checkProgress, checkDeps)
  assertEquals(checked.next, 'confirm-secrets-push', 'GitHub target routes to confirm-secrets-push')
  assertEquals(makeDriverDeps.__entryCalls, 1, 'checking-ci-secrets must REUSE carried entries, NOT rebuild them')
  assert(!checkDeps.__calls.some(c => c.name === 'createCiSecretEntries'), 'checking-ci-secrets must not call createCiSecretEntries')
  const listCall = checkDeps.__calls.find(c => c.name === 'listExistingCiSecretKeysAsync')
  assert(listCall, 'must list existing secret keys')
  assert(
    listCall.args[1].includes('CAPGO_TOKEN'),
    'listExistingCiSecretKeysAsync must receive the carried entries’ keys (incl. CAPGO_TOKEN)',
  )
  assert(checked.transient && Array.isArray(checked.transient.ciSecretExistingKeys), 'checking must return ciSecretExistingKeys in transient')
})

await test('DRIVER: uploading-ci-secrets passes the carried existing-keys list to uploadCiSecretsAsync (4th arg)', async () => {
  makeDriverDeps.__entryCalls = 0
  const carried = {
    ciSecretEntries: RESOLVED_ENTRIES,
    ciSecretExistingKeys: EXISTING_KEYS,
  }
  const deps = makeDriverDeps({ carried })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow continues into the workflow builder')
  const upload = deps.__calls.find(c => c.name === 'uploadCiSecretsAsync')
  assert(upload, 'must call uploadCiSecretsAsync')
  assertEquals(upload.args[0], GITHUB_TARGET, 'uploadCiSecretsAsync target arg')
  assertEquals(upload.args[1], RESOLVED_ENTRIES, 'uploadCiSecretsAsync must reuse the carried entries')
  assertEquals(upload.args[2], EXISTING_KEYS, 'uploadCiSecretsAsync must receive the carried existing-keys as the 4th (3rd positional) arg')
  assertEquals(makeDriverDeps.__entryCalls, 0, 'uploading must not call createCiSecretEntries when entries are carried')
})

await test('DRIVER: env-export writes the FULL carried savedCredentials (not a lossy rebuild)', async () => {
  const FULL_CREDS = { ...ANDROID_CREDENTIALS }
  const deps = makeDriverDeps({ carried: { savedCredentials: FULL_CREDS } })
  const res = await runTailEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a successful export finishes the wizard')
  const exportCall = deps.__calls.find(c => c.name === 'exportCredentialsToEnv')
  assert(exportCall, 'must call exportCredentialsToEnv')
  assertEquals(exportCall.args[0].credentials, FULL_CREDS, 'exportCredentialsToEnv must receive the full carried savedCredentials')
})

await test('DRIVER: overwrite-and-export-env also writes the FULL carried savedCredentials', async () => {
  const FULL_CREDS = { ...ANDROID_CREDENTIALS }
  const deps = makeDriverDeps({ carried: { savedCredentials: FULL_CREDS } })
  const progress = tailProgress({ setupMode: 'declined', envExportTargetPath: `/tmp/.env.capgo.${APP_ID}.android` })
  const res = await runTailEffect('overwrite-and-export-env', progress, deps)
  assertEquals(res.next, 'build-complete', 'overwrite export finishes the wizard')
  const exportCall = deps.__calls.find(c => c.name === 'exportCredentialsToEnv')
  assert(exportCall, 'must call exportCredentialsToEnv')
  assertEquals(exportCall.args[0].credentials, FULL_CREDS, 'overwrite export must receive the full carried savedCredentials')
  assertEquals(exportCall.args[0].overwrite, true, 'overwrite export must pass overwrite: true')
})

await test('DRIVER: saving-credentials logs the random-password backup hint when keystorePasswordGenerated is set', async () => {
  const logs = []
  const deps = makeDriverDeps({ onLog: (msg, color) => logs.push({ msg, color }) })
  await runTailEffect('saving-credentials', tailProgress({ keystorePasswordGenerated: true }), deps)
  assert(
    logs.some(l => /auto-generated keystore password/i.test(l.msg) && /back up that file/i.test(l.msg)),
    'must emit the random-password backup hint when keystorePasswordGenerated is true',
  )
})

await test('DRIVER: saving-credentials does NOT log the backup hint when keystorePasswordGenerated is unset', async () => {
  const logs = []
  const deps = makeDriverDeps({ onLog: (msg, color) => logs.push({ msg, color }) })
  await runTailEffect('saving-credentials', tailProgress(), deps)
  assert(
    !logs.some(l => /auto-generated keystore password/i.test(l.msg)),
    'must NOT emit the backup hint when the password was not auto-generated',
  )
})

// ─── GAP 6: the backup hint is gated on progress.keystorePasswordGenerated ──
//
// DRIVER CONTRACT: the engine reads keystorePasswordGenerated off PROGRESS — it
// has no dep/carried source. A driver delegating its keystore step MUST thread
// the flag onto progress (the bespoke held it only in React state). This test
// pins the read site: the hint fires from the progress flag alone, with no dep.

await test('GAP6: the backup hint is gated ONLY on progress.keystorePasswordGenerated (no dep/carried source)', async () => {
  const onLog = []
  // A driver that did NOT thread the flag onto progress — even though it stuffed a
  // bogus carried flag — gets NO hint (proving progress is the only source).
  const noFlag = makeDriverDeps({ onLog: (m, c) => onLog.push({ m, c }), carried: { keystorePasswordGenerated: true } })
  await runTailEffect('saving-credentials', tailProgress(), noFlag)
  assert(!onLog.some(l => /auto-generated keystore password/i.test(l.m)), 'a carried/dep flag must NOT trigger the hint — only the progress field does')

  // The same driver that DID thread it onto progress gets the hint.
  const onLog2 = []
  const withFlag = makeDriverDeps({ onLog: (m, c) => onLog2.push({ m, c }) })
  await runTailEffect('saving-credentials', tailProgress({ keystorePasswordGenerated: true }), withFlag)
  const hit = onLog2.find(l => /auto-generated keystore password/i.test(l.m) && /back up that file/i.test(l.m))
  assert(hit, 'the progress flag fires the hint')
  assertEquals(hit.c, 'yellow', 'the backup hint is yellow')
})

await test('DRIVER: writing-workflow-file reuses the carried entries’ keys (no rebuild)', async () => {
  makeDriverDeps.__entryCalls = 0
  const deps = makeDriverDeps({ carried: { ciSecretEntries: RESOLVED_ENTRIES } })
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runTailEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'after the workflow file is written the wizard finishes')
  const writeCall = deps.__calls.find(c => c.name === 'writeWorkflowFile')
  assert(writeCall, 'must call writeWorkflowFile')
  assert(
    writeCall.args[0].secretKeys.includes('CAPGO_TOKEN'),
    'workflow secretKeys must come from the carried entries (incl. CAPGO_TOKEN)',
  )
  assertEquals(makeDriverDeps.__entryCalls, 0, 'writing-workflow-file must not rebuild entries when they are carried')
})

await test('DRIVER: detecting-ci-secrets surfaces setup advice via transient on the single-target path', async () => {
  const deps = makeDriverDeps({
    detectCiSecretTargets: () => ({ targets: [GITHUB_TARGET], setup: [{ provider: 'github', steps: ['gh auth login'] }], notes: [] }),
  })
  const res = await runTailEffect('detecting-ci-secrets', tailProgress(), deps)
  assert(res.transient, 'detecting must return a transient')
  assert(Array.isArray(res.transient.ciSecretSetupAdvice), 'detecting must surface ciSecretSetupAdvice on every path')
  assertEquals(res.transient.ciSecretSetupAdvice.length, 1, 'setup advice must be carried through even when a target is reachable')
})

// ─── GAP 4: post-save tail steps must NOT re-create progress.json (no saveProgress) ──
//
// saving-credentials deletes progress.json; the post-save tail then runs purely
// from transient/carried (the bespoke android tail uses React state — it never
// persists). The engine previously called saveProgress at detecting (single
// target → ciSecretTarget) and exporting-env (exists → envExportTargetPath),
// RE-CREATING the deleted progress.json mid post-build flow. None of the post-
// save tail steps may persist. The chosen field still rides the RETURNED progress
// so the driver threads it forward (mirroring setCiSecretTarget / state), but it
// is never written to disk.

await test('GAP4: detecting-ci-secrets (single target) does NOT call saveProgress but still carries ciSecretTarget on returned progress', async () => {
  const deps = makeDeps()
  const res = await runTailEffect('detecting-ci-secrets', tailProgress(), deps)
  assertEquals(res.next, 'ask-github-actions-setup', 'a single GitHub target still routes to the GitHub Actions setup prompt')
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'detecting-ci-secrets must NOT re-create progress.json (no saveProgress in the post-save tail)')
  assertEquals(res.progress.ciSecretTarget, GITHUB_TARGET, 'the chosen target still rides the RETURNED progress so the driver threads it forward')
})

await test('GAP4: exporting-env (exists) does NOT call saveProgress but still carries envExportTargetPath on returned progress', async () => {
  const deps = makeDeps({
    exportCredentialsToEnv: (...a) => { deps.__calls.push({ name: 'exportCredentialsToEnv', args: a }); return { kind: 'exists', path: `/tmp/.env.capgo.${APP_ID}.android` } },
  })
  const res = await runTailEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'confirm-env-export-overwrite', 'an existing .env routes to the overwrite confirm gate')
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'exporting-env must NOT re-create progress.json (no saveProgress in the post-save tail)')
  assertEquals(res.progress.envExportTargetPath, `/tmp/.env.capgo.${APP_ID}.android`, 'the export path still rides the RETURNED progress so overwrite-and-export-env can read it')
})

await test('GAP4: a full post-save tail walk (detect → check → upload → export → write) never calls saveProgress', async () => {
  // The driver threads each result.transient back as carried and result.progress
  // forward as progress — exactly as the Ink TUI mirrors its React state — and
  // NOTHING along the way re-creates progress.json.
  const carried = { ciSecretEntries: CI_ENTRIES, savedCredentials: ANDROID_CREDENTIALS }
  for (const [step, progress] of [
    ['detecting-ci-secrets', tailProgress()],
    ['checking-ci-secrets', tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })],
    ['uploading-ci-secrets', tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })],
    ['exporting-env', tailProgress({ setupMode: 'declined' })],
    ['writing-workflow-file', tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow', selectedPackageManager: 'bun', buildScriptChoice: { type: 'npm-script', name: 'build' } })],
  ]) {
    const deps = makeDeps({ carried })
    await runTailEffect(step, progress, deps)
    assert(!deps.__calls.some(c => c.name === 'saveProgress'), `${step} must NOT call saveProgress in the post-save tail`)
  }
})

// ─── CROSS-PLATFORM: detection / upload / build-request are credential-agnostic ─
//
// platform:'ios' through the neutral steps. These do NOT need an iOS credential
// SHAPE — they only need the platform tag threaded into the helper calls and the
// same routing. The driver supplies an iOS platform tag + carried entries (so no
// re-build is needed) and a build-cred-agnostic buildSavedCredentials/rebuild.

function makeIosDeps(overrides = {}) {
  return makeDeps({
    platform: 'ios',
    buildSavedCredentials: () => ({ /* iOS shape — unused on these steps */ }),
    rebuildTailCredentials: () => ({}),
    carried: { ciSecretEntries: RESOLVED_ENTRIES },
    ...overrides,
  })
}

await test("ios: detecting-ci-secrets (single GitHub target) → 'ask-github-actions-setup'", async () => {
  const deps = makeIosDeps()
  const res = await runTailEffect('detecting-ci-secrets', tailProgress({ platform: 'ios' }), deps)
  assertEquals(res.next, 'ask-github-actions-setup', 'ios single GitHub target routes identically')
  assert(deps.__calls.some(c => c.name === 'detectCiSecretTargets'), 'must call detectCiSecretTargets')
})

await test("ios: uploading-ci-secrets (with-workflow) → 'pick-package-manager' (uses deps.platform=ios nowhere here)", async () => {
  const deps = makeIosDeps()
  const progress = tailProgress({ platform: 'ios', ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'ios with-workflow continues into the workflow builder')
  const upload = deps.__calls.find(c => c.name === 'uploadCiSecretsAsync')
  assertEquals(upload.args[1], RESOLVED_ENTRIES, 'ios upload reuses carried entries')
})

await test("ios: requesting-build (success, entries) → 'detecting-ci-secrets' with platform:ios in the request", async () => {
  const deps = makeIosDeps()
  const res = await runTailEffect('requesting-build', tailProgress({ platform: 'ios' }), deps)
  assertEquals(res.next, 'detecting-ci-secrets', 'ios success with entries routes to detecting-ci-secrets')
  const req = deps.__calls.find(c => c.name === 'requestBuildInternal')
  assertEquals(req.args[1].platform, 'ios', 'requestBuildInternal platform comes from deps.platform=ios')
})

await test("ios: writing-workflow-file sets defaultPlatform:ios", async () => {
  const deps = makeIosDeps()
  const progress = tailProgress({
    platform: 'ios',
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'npm',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runTailEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'ios workflow write finishes the wizard')
  const wf = deps.__calls.find(c => c.name === 'writeWorkflowFile')
  assertEquals(wf.args[0].defaultPlatform, 'ios', 'workflow defaultPlatform=ios comes from deps.platform')
})

await test("ios: exporting-env passes platform:ios to exportCredentialsToEnv", async () => {
  const deps = makeIosDeps({ carried: { savedCredentials: { ASC_KEY: 'x' } } })
  const res = await runTailEffect('exporting-env', tailProgress({ platform: 'ios' }), deps)
  assertEquals(res.next, 'build-complete', 'ios export finishes the wizard')
  const ex = deps.__calls.find(c => c.name === 'exportCredentialsToEnv')
  assertEquals(ex.args[0].platform, 'ios', 'exportCredentialsToEnv platform=ios comes from deps.platform')
  // No envExportTargetPath on progress → defaultExportPath fires with platform=ios.
  const def = deps.__calls.find(c => c.name === 'defaultExportPath')
  assert(def, 'defaultExportPath must be called when no envExportTargetPath is set')
  assertEquals(def.args[1], 'ios', 'defaultExportPath platform=ios comes from deps.platform')
})

// ─── CHOICE / INPUT tail VIEW steps: each exposes a usable (non-auto) view ────

const CHOICE_INPUT_STEPS = [
  'ask-github-actions-setup',
  'confirm-secrets-push',
  'ask-export-env',
  'ask-build',
  'pick-package-manager',
  'pick-build-script',
  'preview-workflow-file',
]

for (const step of CHOICE_INPUT_STEPS) {
  await test(`tailViewForStep('${step}') exposes a choice/input view`, async () => {
    const view = tailViewForStep(step, tailProgress(), { appId: APP_ID })
    assert(view, `view for ${step} must exist`)
    assertEquals(view.step, step, 'view.step must echo the requested step')
    assert(
      view.kind === 'choice' || view.kind === 'input',
      `${step} must be a choice/input step (got kind=${view.kind})`,
    )
  })
}

await test("tailViewForStep('build-complete') is a done view", async () => {
  const view = tailViewForStep('build-complete', tailProgress(), { appId: APP_ID })
  assertEquals(view.kind, 'done', 'build-complete must be a done view')
  assert(typeof view.message === 'string' && view.message.length > 0, 'build-complete must carry a message')
})

// ─── applyTailInput: the persisted-field reducers ────────────────────────────

await test('applyTailInput ci-secrets-target-select records ciSecretTarget', () => {
  const out = applyTailInput('ci-secrets-target-select', tailProgress(), { step: 'ci-secrets-target-select', ciSecretTarget: GITHUB_TARGET })
  assertEquals(out.ciSecretTarget, GITHUB_TARGET, 'records the chosen target')
})

await test('applyTailInput ask-github-actions-setup records setupMode', () => {
  const out = applyTailInput('ask-github-actions-setup', tailProgress(), { step: 'ask-github-actions-setup', value: 'with-workflow' })
  assertEquals(out.setupMode, 'with-workflow', 'records the setup mode')
})

await test('applyTailInput ask-export-env (yes) records envExportTargetPath; (no) unchanged', () => {
  const yes = applyTailInput('ask-export-env', tailProgress(), { step: 'ask-export-env', value: 'yes', envExportTargetPath: '/tmp/x.env' })
  assertEquals(yes.envExportTargetPath, '/tmp/x.env', 'yes records the path')
  const base = tailProgress()
  const no = applyTailInput('ask-export-env', base, { step: 'ask-export-env', value: 'no' })
  assertEquals(no, base, 'no returns progress unchanged')
})

await test('applyTailInput pick-package-manager records selectedPackageManager', () => {
  const out = applyTailInput('pick-package-manager', tailProgress(), { step: 'pick-package-manager', selectedPackageManager: 'bun' })
  assertEquals(out.selectedPackageManager, 'bun', 'records the chosen package manager')
})

await test('applyTailInput pick-build-script records buildScriptChoice; __custom__ is navigation-only', () => {
  const choice = { type: 'npm-script', name: 'build' }
  const out = applyTailInput('pick-build-script', tailProgress(), { step: 'pick-build-script', buildScriptChoice: choice })
  assertEquals(out.buildScriptChoice, choice, 'records the build-script choice')
  const base = tailProgress()
  const nav = applyTailInput('pick-build-script', base, { step: 'pick-build-script', value: '__custom__' })
  assertEquals(nav, base, '__custom__ is navigation-only (unchanged)')
})

await test('applyTailInput pick-build-script-custom trims + guards empty', () => {
  const out = applyTailInput('pick-build-script-custom', tailProgress(), { step: 'pick-build-script-custom', command: '  vite build  ' })
  assert(out.buildScriptChoice && out.buildScriptChoice.type === 'custom' && out.buildScriptChoice.command === 'vite build', 'records trimmed custom command')
  const base = tailProgress()
  const empty = applyTailInput('pick-build-script-custom', base, { step: 'pick-build-script-custom', command: '   ' })
  assertEquals(empty, base, 'empty custom command returns progress unchanged')
})

await test('applyTailInput navigation-only tail values fall through unchanged', () => {
  const base = tailProgress()
  for (const input of [
    { step: 'confirm-secrets-push', value: 'confirm' },
    { step: 'confirm-env-export-overwrite', value: 'skip' },
    { step: 'view-workflow-diff', value: 'close' },
    { step: 'ask-build', value: 'yes' },
    { step: 'ci-secrets-setup', value: 'retry' },
  ]) {
    assertEquals(applyTailInput(input.step, base, input), base, `${input.step}/${input.value} must be navigation-only`)
  }
})

// ─── HOSTILE-REVIEW MED: self-heal divert must surface the REAL builder error ──

await test('saving-credentials self-heal divert SURFACES the underlying builder error (onLog detail + onInternalLog)', async () => {
  const logs = []
  const internal = []
  const deps = makeDeps({
    onLog: (msg, color) => logs.push({ msg, color }),
    onInternalLog: line => internal.push(line),
    loadProgress: async () => tailProgress(),
    buildSavedCredentials: () => { throw new Error('service-account key not provisioned (detail-xyz)') },
    resumeStep: () => 'gcp-projects-loading',
  })
  const res = await runTailEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'gcp-projects-loading', 'still diverts to the resolved resume step')
  const hit = logs.find(l => /Some required input was missing/.test(l.msg))
  assert(hit, 'the guidance line still fires on the divert')
  assert(hit.msg.includes('service-account key not provisioned (detail-xyz)'), `the guidance line must carry the REAL builder error, not only the generic text (got: ${hit.msg})`)
  assert(internal.some(line => line.includes('service-account key not provisioned (detail-xyz)')), 'the builder error must reach onInternalLog for the support bundle')
})

// ─── HOSTILE-REVIEW MED: deps.signal must actually be consumed ─────────────────
//
// ABORT CONTRACT: BuildRequestOptions/requestBuildInternal expose no AbortSignal
// seam (request.ts owns its internal poll/WebSocket AbortControllers), so an
// abort cannot cancel in-flight work — the engine honours the signal at its own
// await boundaries instead: a pre-aborted signal must bail quietly WITHOUT
// firing a build request.

await test('requesting-build with a PRE-ABORTED deps.signal does NOT call requestBuildInternal (quiet bail)', async () => {
  const controller = new AbortController()
  controller.abort()
  const outputs = []
  const deps = makeDeps({ signal: controller.signal, onBuildOutput: line => outputs.push(line) })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assert(!deps.__calls.some(c => c.name === 'requestBuildInternal'), 'an aborted driver must not fire a build request')
  assertEquals(res.next, undefined, 'aborted: bail quietly without routing onward')
  assertEquals(outputs.length, 0, 'aborted: no viewer output either')
})

await test('requesting-build with a NON-aborted signal still requests the build normally', async () => {
  const controller = new AbortController()
  const deps = makeDeps({ signal: controller.signal })
  const res = await runTailEffect('requesting-build', tailProgress(), deps)
  assert(deps.__calls.some(c => c.name === 'requestBuildInternal'), 'a live signal must not block the request')
  assertEquals(res.next, 'detecting-ci-secrets', 'normal success routing (entries rebuilt from progress)')
})

// ─── HOSTILE-REVIEW LOW: preload .catch(() => null) dropped the reasons ────────

await test('preloadWorkflowScripts routes a findProjectType failure through onInternalLog (still best-effort)', async () => {
  const internal = []
  const deps = makeDeps({
    onInternalLog: line => internal.push(line),
    getPackageScripts: () => ({ build: 'vite build' }),
    findProjectType: async () => { throw new Error('detect-blew-up-xyz') },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'preload stays best-effort — routing unchanged')
  assert(res.transient && res.transient.availableScripts, 'scripts still surfaced')
  assert(!res.transient.recommendedScript, 'no recommendation without a project type')
  assert(internal.some(line => line.includes('detect-blew-up-xyz')), 'the swallowed findProjectType error must reach onInternalLog')
})

await test('preloadWorkflowScripts routes a findBuildCommandForProjectType failure through onInternalLog', async () => {
  const internal = []
  const deps = makeDeps({
    onInternalLog: line => internal.push(line),
    getPackageScripts: () => ({ build: 'vite build' }),
    findProjectType: async () => 'vue',
    findBuildCommandForProjectType: async () => { throw new Error('cmd-blew-up-xyz') },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runTailEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'routing unchanged')
  assert(internal.some(line => line.includes('cmd-blew-up-xyz')), 'the swallowed findBuildCommandForProjectType error must reach onInternalLog')
})

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)

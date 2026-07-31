#!/usr/bin/env node
/**
 * Plan — RED spec for the Android post-save "tail" engine.
 *
 * Phase 1 migrates the post-save tail (CI-secrets → env-export → workflow-file →
 * build-request) out of `android/ui/app.tsx`'s tail `useEffect` and into the
 * shared headless engine (`runAndroidEffect` + `androidViewForStep`). The TUI
 * keeps its own `useState` tail for now; this test is the EXECUTABLE SPEC the
 * engine cases must satisfy so a later phase can swap the TUI onto the engine.
 *
 * This file is RED on purpose: `runAndroidEffect`'s `default` branch currently
 * throws `Unhandled effect step: …` for every AUTO tail step below. Once Phase
 * 1 (A3/A4) lands the tail cases, every assertion here turns GREEN with no edit
 * to this file.
 *
 * The EXPECTED routing encoded below was derived step-by-step from the TUI tail
 * `useEffect` in `src/build/onboarding/android/ui/app.tsx` (the post-save block).
 * Each AUTO step's `{next}` mirrors exactly what `setStep(…)` the matching TUI
 * branch fires, and which pure helper it calls:
 *
 *   saving-credentials      uses createCiSecretEntries  → next 'ask-build'
 *                           (app.tsx: doSaveCredentials → createCiSecretEntries → setStep('ask-build'))
 *   requesting-build        uses requestBuildInternal   → next 'detecting-ci-secrets'
 *                           (app.tsx: success && ciSecretEntries.length > 0 → setStep('detecting-ci-secrets'))
 *   detecting-ci-secrets    uses detectCiSecretTargets  → next 'ask-github-actions-setup'
 *                           (app.tsx: single GitHub target → setStep('ask-github-actions-setup'))
 *   checking-ci-secrets     uses getCiSecretRepoLabelAsync + listExistingCiSecretKeysAsync
 *                           → next 'confirm-secrets-push'
 *                           (app.tsx: provider === 'github' → setStep('confirm-secrets-push'))
 *   uploading-ci-secrets    uses uploadCiSecretsAsync    → next 'pick-package-manager'
 *                           (app.tsx: setupMode === 'with-workflow' → setStep('pick-package-manager'))
 *   exporting-env           uses exportCredentialsToEnv + defaultExportPath
 *                           → next 'build-complete'
 *                           (app.tsx: result.kind === 'written' → setStep('build-complete'))
 *   writing-workflow-file   uses writeWorkflowFile (+ generateWorkflow at preview)
 *                           → next 'build-complete'
 *                           (app.tsx: result.kind === 'written' → setStep('build-complete'))
 *
 * The ai-analysis-* steps are intentionally OUT OF SCOPE — they stay TUI-only
 * (no AI-calling-AI in the headless engine), so they are not driven here.
 *
 * CHOICE/INPUT tail steps are not driven through the effect; they are asserted
 * to expose a non-auto view (kind + a way to advance) via `androidViewForStep`.
 */
import process from 'node:process'

const {
  runAndroidEffect,
  androidViewForStep,
  applyAndroidInput,
} = await import('../src/build/onboarding/android/flow.ts')

const { getAndroidResumeStep } = await import('../src/build/onboarding/android/progress.ts')

console.log('🧪 Android post-save TAIL engine — RED spec (drives runAndroidEffect through the tail)\n')

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

const SAVED_CREDENTIALS = {
  ANDROID_KEYSTORE_FILE: 'a2V5',
  KEYSTORE_KEY_ALIAS: 'release',
  KEYSTORE_STORE_PASSWORD: 'pw',
  KEYSTORE_KEY_PASSWORD: 'pw',
  PLAY_CONFIG_JSON: 'eyJ9',
}

/**
 * Build a progress object whose persisted tail state matches the point in the
 * TUI flow at which the AUTO step under test runs. `TailProgress` already
 * carries setupMode / ciSecretTarget / selectedPackageManager / buildScriptChoice
 * / envExportTargetPath, so the headless engine reads its inputs from progress
 * the same way the TUI reads them from useState.
 */
function tailProgress(overrides = {}) {
  return {
    platform: 'android',
    appId: APP_ID,
    startedAt: '2026-06-03T00:00:00.000Z',
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      androidPackageChosen: { packageName: APP_ID, source: 'gradle' },
    },
    _keystoreBase64: 'a2V5',
    _serviceAccountKeyBase64: 'eyJ9',
    keystoreStorePassword: 'pw',
    keystoreKeyPassword: 'pw',
    keystoreAlias: 'release',
    ...overrides,
  }
}

/**
 * Mocked AndroidEffectDeps. Every helper returns canned data — NO fs, NO
 * network, NO child processes. Records which helpers fired so the spec can
 * assert the engine used the SAME pure helper the TUI branch calls.
 *
 * The tail-specific dep fields (detectCiSecretTargets, getCiSecretRepoLabelAsync,
 * listExistingCiSecretKeysAsync, uploadCiSecretsAsync, createCiSecretEntries,
 * exportCredentialsToEnv, defaultExportPath, generateWorkflow, writeWorkflowFile,
 * requestBuildInternal) are ADDITIVE/OPTIONAL on AndroidEffectDeps and are added
 * in A3/A4 — referencing them here is what makes this the spec for those tasks.
 */
function makeDeps(overrides = {}) {
  const calls = []

  const deps = {
    // ── existing (provisioning) deps — unused by the tail, present as no-ops ──
    generateKeystore: () => { throw new Error('not used in tail') },
    listKeystoreAliases: () => { throw new Error('not used in tail') },
    tryUnlockPrivateKey: () => { throw new Error('not used in tail') },
    validateServiceAccountJson: async () => { throw new Error('not used in tail') },
    updateSavedCredentials: async (...a) => { calls.push({ name: 'updateSavedCredentials', args: a }) },
    loadSavedCredentials: async () => SAVED_CREDENTIALS,
    saveAndroidProgress: async (...a) => { calls.push({ name: 'saveAndroidProgress', args: a }) },
    loadAndroidProgress: async () => null,
    deleteAndroidProgress: async (...a) => { calls.push({ name: 'deleteAndroidProgress', args: a }) },
    readFile: async () => Buffer.from('key'),
    copyFile: async () => {},
    runOAuthFlow: async () => { throw new Error('not used in tail') },
    fetchUserInfo: async () => { throw new Error('not used in tail') },
    getAccessToken: async () => 'tok',
    revokeToken: async () => {},
    listProjects: async () => [],
    createProject: async () => { throw new Error('not used in tail') },
    enableService: async () => {},
    ensureServiceAccount: async () => { throw new Error('not used in tail') },
    createServiceAccountKey: async () => { throw new Error('not used in tail') },
    inviteServiceAccount: async () => {},
    findAndroidApplicationIds: async () => [APP_ID],

    // ── tail deps (additive — added in A3/A4) ──
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
    onAuthUrl: () => {},

    ...overrides,
  }
  deps.__calls = calls
  return deps
}

// ─── AUTO tail steps: drive through runAndroidEffect, assert {next} + helper ──
//
// Each of these CURRENTLY throws 'Unhandled effect step' (default branch) — RED.

await test("saving-credentials → next 'ask-build' (uses createCiSecretEntries)", async () => {
  const deps = makeDeps()
  const res = await runAndroidEffect('saving-credentials', tailProgress(), deps)
  assertEquals(res.next, 'ask-build', 'saving-credentials must route to ask-build')
  assert(deps.__calls.some(c => c.name === 'createCiSecretEntries'), 'must call createCiSecretEntries to stash CI entries')
})

await test("requesting-build (success, entries present) → next 'detecting-ci-secrets' (uses requestBuildInternal)", async () => {
  const deps = makeDeps()
  const res = await runAndroidEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'detecting-ci-secrets', 'a successful build with pending entries must route to detecting-ci-secrets')
  assert(deps.__calls.some(c => c.name === 'requestBuildInternal'), 'must call requestBuildInternal')
})

await test("detecting-ci-secrets (single GitHub target) → next 'ask-github-actions-setup' (uses detectCiSecretTargets)", async () => {
  const deps = makeDeps()
  const res = await runAndroidEffect('detecting-ci-secrets', tailProgress(), deps)
  assertEquals(res.next, 'ask-github-actions-setup', 'a single GitHub target routes to the GitHub Actions setup prompt')
  assert(deps.__calls.some(c => c.name === 'detectCiSecretTargets'), 'must call detectCiSecretTargets')
})

await test("checking-ci-secrets (GitHub) → next 'confirm-secrets-push' (uses getCiSecretRepoLabelAsync + listExistingCiSecretKeysAsync)", async () => {
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runAndroidEffect('checking-ci-secrets', progress, deps)
  assertEquals(res.next, 'confirm-secrets-push', 'GitHub target routes to the confirm-secrets-push gate')
  assert(deps.__calls.some(c => c.name === 'getCiSecretRepoLabelAsync'), 'must resolve the repo label')
  assert(deps.__calls.some(c => c.name === 'listExistingCiSecretKeysAsync'), 'must list existing secret keys')
})

await test("uploading-ci-secrets (setupMode=with-workflow) → next 'pick-package-manager' (uses uploadCiSecretsAsync)", async () => {
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runAndroidEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow continues into the workflow-builder sub-flow')
  assert(deps.__calls.some(c => c.name === 'uploadCiSecretsAsync'), 'must call uploadCiSecretsAsync')
})

await test("uploading-ci-secrets (setupMode=secrets-only) → next 'build-complete'", async () => {
  const deps = makeDeps()
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'secrets-only' })
  const res = await runAndroidEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'build-complete', 'secrets-only finishes after upload')
})

await test("exporting-env (written) → next 'build-complete' (uses exportCredentialsToEnv + defaultExportPath)", async () => {
  const deps = makeDeps()
  const res = await runAndroidEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a successful export finishes the wizard')
  assert(deps.__calls.some(c => c.name === 'exportCredentialsToEnv'), 'must call exportCredentialsToEnv')
})

await test("writing-workflow-file (written) → next 'build-complete' (uses writeWorkflowFile)", async () => {
  const deps = makeDeps()
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runAndroidEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'after the workflow file is written the wizard finishes')
  assert(deps.__calls.some(c => c.name === 'writeWorkflowFile'), 'must call writeWorkflowFile')
})

// ─── DRIVER threading: resolve credentials + CI entries ONCE, reuse downstream ──
//
// This block acts like the headless DRIVER (mirroring the Ink TUI's React
// state): it captures `AndroidEffectResult.transient` from each effect and
// threads it back into the NEXT effect as `deps.carried`. The parity contract
// (matching app.tsx's tail useEffect) is:
//   1. saving-credentials resolves the CI-secret entries + saved credentials
//      ONCE (createCiSecretEntries fires exactly once across the whole tail).
//   2. checking/uploading/exporting REUSE the carried values — they NEVER call
//      createCiSecretEntries again and NEVER re-resolve the Capgo API key.
//   3. uploading passes the carried existing-keys list to uploadCiSecretsAsync.
//   4. env-export writes the FULL carried savedCredentials (no lossy rebuild).
//
// Secrets/credentials/entries must stay in the driver's transient — never on
// progress.json — so the test fixtures carry them ONLY through deps.carried.

// The Capgo API key the driver pre-binds into createCiSecretEntries. We model
// that binding by having the mock fold CAPGO_TOKEN in, then assert the entries
// produced ONCE are the exact ones reused everywhere downstream.
const RESOLVED_ENTRIES = [
  { key: 'ANDROID_KEYSTORE_FILE', value: 'a2V5', masked: true },
  { key: 'KEYSTORE_KEY_ALIAS', value: 'release', masked: false },
  { key: 'CAPGO_TOKEN', value: 'resolved-capgo-key', masked: true },
]
const EXISTING_KEYS = ['CAPGO_TOKEN']

/** A driver-style deps whose createCiSecretEntries records each call (so we can
 *  prove it fires ONCE) and whose remote helpers return non-trivial data. */
function makeDriverDeps(overrides = {}) {
  return makeDeps({
    createCiSecretEntries: (..._a) => {
      // mirrors the TUI binding: only saving-credentials should hit this.
      makeDriverDeps.__entryCalls = (makeDriverDeps.__entryCalls || 0) + 1
      return RESOLVED_ENTRIES
    },
    // NB: listExistingCiSecretKeysAsync is intentionally NOT overridden — the
    // base makeDeps mock records the call onto deps.__calls (which the spec
    // asserts) and returns []. The existing-keys THREADING is exercised
    // separately by passing carried.ciSecretExistingKeys directly into the
    // uploading test, decoupled from this mock's return value.
    ...overrides,
  })
}

await test('DRIVER: createCiSecretEntries resolves ONCE at saving-credentials and is REUSED (not rebuilt) in checking', async () => {
  makeDriverDeps.__entryCalls = 0
  const deps = makeDriverDeps()

  // ── 1) saving-credentials: resolve entries + credentials ONCE ──
  const saved = await runAndroidEffect('saving-credentials', tailProgress(), deps)
  assertEquals(saved.next, 'ask-build', 'saving-credentials routes to ask-build')
  assertEquals(makeDriverDeps.__entryCalls, 1, 'createCiSecretEntries must be called exactly once (at saving-credentials)')
  assert(saved.transient && saved.transient.ciSecretEntries, 'saving-credentials must return ciSecretEntries in transient')
  assert(saved.transient.savedCredentials, 'saving-credentials must return savedCredentials in transient')
  // The resolved entries carry CAPGO_TOKEN (the driver-bound API key) — proving
  // the single resolution, not a progress-rebuild (which would omit the token).
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
  const checked = await runAndroidEffect('checking-ci-secrets', checkProgress, checkDeps)
  assertEquals(checked.next, 'confirm-secrets-push', 'GitHub target routes to confirm-secrets-push')
  // checking-ci-secrets must NOT have called createCiSecretEntries again — the
  // count is still 1 from saving-credentials (proving no rebuild, no second
  // API-key resolution).
  assertEquals(makeDriverDeps.__entryCalls, 1, 'checking-ci-secrets must REUSE carried entries, NOT rebuild them (createCiSecretEntries stays called once)')
  assert(!checkDeps.__calls.some(c => c.name === 'createCiSecretEntries'), 'checking-ci-secrets must not call createCiSecretEntries')
  // The keys listExistingCiSecretKeysAsync checked must be the carried entries' keys.
  const listCall = checkDeps.__calls.find(c => c.name === 'listExistingCiSecretKeysAsync')
  assert(listCall, 'must list existing secret keys')
  assert(
    listCall.args[1].includes('CAPGO_TOKEN'),
    'listExistingCiSecretKeysAsync must receive the carried entries’ keys (incl. CAPGO_TOKEN)',
  )
  // The check surfaces the existing keys back to the driver.
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
  const res = await runAndroidEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow continues into the workflow builder')
  const upload = deps.__calls.find(c => c.name === 'uploadCiSecretsAsync')
  assert(upload, 'must call uploadCiSecretsAsync')
  // args: (target, entries, existingKeys, runner?, onProgress?)
  assertEquals(upload.args[0], GITHUB_TARGET, 'uploadCiSecretsAsync target arg')
  assertEquals(upload.args[1], RESOLVED_ENTRIES, 'uploadCiSecretsAsync must reuse the carried entries')
  assertEquals(upload.args[2], EXISTING_KEYS, 'uploadCiSecretsAsync must receive the carried existing-keys as the 4th (3rd positional) arg')
  // No rebuild happened — the carried entries were used directly.
  assertEquals(makeDriverDeps.__entryCalls, 0, 'uploading must not call createCiSecretEntries when entries are carried')
})

await test('DRIVER: env-export writes the FULL carried savedCredentials (not a lossy rebuild)', async () => {
  const FULL_CREDS = {
    ANDROID_KEYSTORE_FILE: 'a2V5',
    KEYSTORE_KEY_ALIAS: 'release',
    KEYSTORE_STORE_PASSWORD: 'pw',
    KEYSTORE_KEY_PASSWORD: 'pw',
    PLAY_CONFIG_JSON: 'eyJ9',
  }
  const deps = makeDriverDeps({ carried: { savedCredentials: FULL_CREDS } })
  const res = await runAndroidEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'a successful export finishes the wizard')
  const exportCall = deps.__calls.find(c => c.name === 'exportCredentialsToEnv')
  assert(exportCall, 'must call exportCredentialsToEnv')
  assertEquals(exportCall.args[0].credentials, FULL_CREDS, 'exportCredentialsToEnv must receive the full carried savedCredentials')
})

await test('DRIVER: overwrite-and-export-env also writes the FULL carried savedCredentials', async () => {
  const FULL_CREDS = {
    ANDROID_KEYSTORE_FILE: 'a2V5',
    KEYSTORE_KEY_ALIAS: 'release',
    KEYSTORE_STORE_PASSWORD: 'pw',
    KEYSTORE_KEY_PASSWORD: 'pw',
    PLAY_CONFIG_JSON: 'eyJ9',
  }
  const deps = makeDriverDeps({ carried: { savedCredentials: FULL_CREDS } })
  const progress = tailProgress({ setupMode: 'declined', envExportTargetPath: `/tmp/.env.capgo.${APP_ID}.android` })
  const res = await runAndroidEffect('overwrite-and-export-env', progress, deps)
  assertEquals(res.next, 'build-complete', 'overwrite export finishes the wizard')
  const exportCall = deps.__calls.find(c => c.name === 'exportCredentialsToEnv')
  assert(exportCall, 'must call exportCredentialsToEnv')
  assertEquals(exportCall.args[0].credentials, FULL_CREDS, 'overwrite export must receive the full carried savedCredentials')
  assertEquals(exportCall.args[0].overwrite, true, 'overwrite export must pass overwrite: true')
})

await test('DRIVER: saving-credentials logs the random-password backup hint when keystorePasswordGenerated is set', async () => {
  const logs = []
  const deps = makeDriverDeps({ onLog: (msg, color) => logs.push({ msg, color }) })
  await runAndroidEffect('saving-credentials', tailProgress({ keystorePasswordGenerated: true }), deps)
  assert(
    logs.some(l => /auto-generated keystore password/i.test(l.msg) && /back up that file/i.test(l.msg)),
    'must emit the random-password backup hint when keystorePasswordGenerated is true',
  )
})

await test('DRIVER: saving-credentials does NOT log the backup hint when keystorePasswordGenerated is unset', async () => {
  const logs = []
  const deps = makeDriverDeps({ onLog: (msg, color) => logs.push({ msg, color }) })
  await runAndroidEffect('saving-credentials', tailProgress(), deps)
  assert(
    !logs.some(l => /auto-generated keystore password/i.test(l.msg)),
    'must NOT emit the backup hint when the password was not auto-generated',
  )
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
  const res = await runAndroidEffect('writing-workflow-file', progress, deps)
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
  const res = await runAndroidEffect('detecting-ci-secrets', tailProgress(), deps)
  assert(res.transient, 'detecting must return a transient')
  assert(Array.isArray(res.transient.ciSecretSetupAdvice), 'detecting must surface ciSecretSetupAdvice on every path (parity with setCiSecretSetupAdvice)')
  assertEquals(res.transient.ciSecretSetupAdvice.length, 1, 'setup advice must be carried through even when a target is reachable')
})

// ─── GAP 4 (ADAPTER): post-save tail steps must not re-create progress.json ──
//
// saving-credentials deletes android progress.json; the bespoke tail then runs
// from React state only. Through the adapter, detecting/exporting must NOT call
// saveAndroidProgress (which would resurrect the deleted file). The chosen field
// still rides the RETURNED progress so the driver threads it forward. The
// pre-delete resume markers (buildRequested / ciSecretsUploaded) keep crash-
// recovery resume routing intact — see the getAndroidResumeStep resume-routing
// tests below, which still pass.

await test('GAP4 ADAPTER: detecting-ci-secrets (single target) does NOT call saveAndroidProgress', async () => {
  const deps = makeDeps()
  const res = await runAndroidEffect('detecting-ci-secrets', tailProgress(), deps)
  assertEquals(res.next, 'ask-github-actions-setup', 'a single GitHub target still routes to the GitHub Actions setup prompt')
  assert(!deps.__calls.some(c => c.name === 'saveAndroidProgress'), 'detecting-ci-secrets must NOT re-create progress.json through the adapter')
  assertEquals(res.progress.ciSecretTarget, GITHUB_TARGET, 'the chosen target still rides the RETURNED progress')
})

await test('GAP4 ADAPTER: exporting-env (exists) does NOT call saveAndroidProgress', async () => {
  const deps = makeDeps({
    exportCredentialsToEnv: (...a) => { deps.__calls.push({ name: 'exportCredentialsToEnv', args: a }); return { kind: 'exists', path: `/tmp/.env.capgo.${APP_ID}.android` } },
  })
  const res = await runAndroidEffect('exporting-env', tailProgress(), deps)
  assertEquals(res.next, 'confirm-env-export-overwrite', 'an existing .env routes to the overwrite confirm gate')
  assert(!deps.__calls.some(c => c.name === 'saveAndroidProgress'), 'exporting-env must NOT re-create progress.json through the adapter')
  assertEquals(res.progress.envExportTargetPath, `/tmp/.env.capgo.${APP_ID}.android`, 'the export path still rides the RETURNED progress')
})

// ─── GAP 5 (ADAPTER): saving-credentials self-heal emits the missing-input log ──
//
// A fresh load whose getAndroidResumeStep is NOT saving-credentials (input went
// missing) must divert AND emit the yellow guidance via onLog before routing back
// (app.tsx ~L1331). tailProgress() has no googleSignInComplete/_oauthRefreshToken
// so getAndroidResumeStep resolves to 'google-sign-in' — a divert.

await test('GAP5 ADAPTER: saving-credentials self-heal forwards the yellow missing-input log + diverts', async () => {
  const logs = []
  const deps = makeDeps({
    onLog: (msg, color) => logs.push({ msg, color }),
    loadAndroidProgress: async () => tailProgress(),
  })
  // Build-first contract: the divert fires only when the credential build
  // genuinely fails — hand the effect a progress with NO buildable inputs.
  const res = await runAndroidEffect('saving-credentials', { ...tailProgress(), completedSteps: {}, keystoreStorePassword: undefined, keystoreKeyPassword: undefined }, deps)
  assert(res.next !== 'saving-credentials' && res.next !== 'ask-build', 'self-heal must divert to an earlier (input) step')
  assert(!deps.__calls.some(c => c.name === 'updateSavedCredentials'), 'must NOT save when diverted')
  const hit = logs.find(l => /Some required input was missing/.test(l.msg))
  assert(hit, 'must forward the missing-input guidance log through the adapter')
  assertEquals(hit.color, 'yellow', 'the missing-input log is yellow')
})

// ─── ADAPTER: streaming / telemetry / preload deps forwarded by toTailDeps ───
//
// A2 widened AndroidEffectDeps with the tail's streaming/telemetry/preload deps
// (logger, resolveApikey, onCiSecretUploadProgress, onCiSecretCheckPhase,
// getPackageScripts, findProjectType, findBuildCommandForProjectType,
// trackWorkflowEvent) and `toTailDeps` must FORWARD them verbatim into the shared
// TailEffectDeps so `runTailEffect` (driven here via `runAndroidEffect`) actually
// uses them. These tests inject each dep on AndroidEffectDeps and assert the
// shared tail consumed it — proving the adapter forwarding is wired.

await test('ADAPTER: onCiSecretUploadProgress is forwarded as the 5th arg of uploadCiSecretsAsync', async () => {
  const progressEvents = []
  const deps = makeDeps({
    // The real uploader reports per-key progress via its 5th callback arg; mirror
    // that so we can prove the forwarded hook actually fires through the adapter.
    uploadCiSecretsAsync: async (_target, _entries, _existingKeys, _runner, onProgress) => {
      onProgress?.(1, 1, 'CAPGO_TOKEN')
    },
    onCiSecretUploadProgress: (current, total, keyName) => {
      progressEvents.push({ current, total, keyName })
    },
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'secrets-only' })
  await runAndroidEffect('uploading-ci-secrets', progress, deps)
  assertEquals(progressEvents.length, 1, 'onCiSecretUploadProgress must fire once (forwarded as uploadCiSecretsAsync 5th arg)')
  assertEquals(progressEvents[0].keyName, 'CAPGO_TOKEN', 'the forwarded progress callback must receive the per-key payload')
})

await test('ADAPTER: onCiSecretCheckPhase is forwarded into the 2-phase checking-ci-secrets status', async () => {
  const phases = []
  const deps = makeDeps({ onCiSecretCheckPhase: phase => phases.push(phase) })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  await runAndroidEffect('checking-ci-secrets', progress, deps)
  assert(phases.length >= 2, 'onCiSecretCheckPhase must receive both check phases (resolve repo → list env vars)')
  assert(phases.some(p => /Resolving GitHub repository/i.test(p)), 'phase 1 (resolve repo) must be forwarded')
  assert(phases.some(p => /Checking existing env vars/i.test(p)), 'phase 2 (list env vars) must be forwarded')
})

// ─── GAP 2 (ADAPTER): onCiSecretError forwarded + ci-secrets-failed routing ──

await test('GAP2 ADAPTER: checking-ci-secrets repo-null forwards onCiSecretError + routes to ci-secrets-failed', async () => {
  const errors = []
  const deps = makeDeps({
    onCiSecretError: msg => errors.push(msg),
    getCiSecretRepoLabelAsync: async () => null,
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runAndroidEffect('checking-ci-secrets', progress, deps)
  assertEquals(res.next, 'ci-secrets-failed', 'an unresolvable GitHub repo routes to ci-secrets-failed')
  assert(res.transient && /Could not resolve the GitHub repository/.test(res.transient.ciSecretError), 'transient.ciSecretError carries the repo-null reason')
  assert(errors.some(e => /Could not resolve the GitHub repository/.test(e)), 'onCiSecretError forwarded with the repo-null reason')
})

await test('GAP2 ADAPTER: a thrown checking-ci-secrets routes to ci-secrets-failed (no throw)', async () => {
  const deps = makeDeps({ getCiSecretRepoLabelAsync: async () => { throw new Error('gh exploded') } })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  let threw = false
  let res
  try {
    res = await runAndroidEffect('checking-ci-secrets', progress, deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'a thrown check must NOT propagate through the adapter')
  assertEquals(res.next, 'ci-secrets-failed', 'a thrown check routes to ci-secrets-failed')
  assert(res.transient && /gh exploded/.test(res.transient.ciSecretError), 'transient.ciSecretError carries the thrown reason')
})

await test('ADAPTER: resolveApikey + logger reach requestBuildInternal', async () => {
  const RESOLVED_KEY = 'cli-flag-key'
  const LOGGER = { __isLogger: true }
  const deps = makeDeps({
    resolveApikey: () => RESOLVED_KEY,
    logger: LOGGER,
  })
  const res = await runAndroidEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'detecting-ci-secrets', 'a successful build with pending entries must route to detecting-ci-secrets')
  const buildCall = deps.__calls.find(c => c.name === 'requestBuildInternal')
  assert(buildCall, 'must call requestBuildInternal')
  // args: (appId, options, silent, logger)
  assertEquals(buildCall.args[1].apikey, RESOLVED_KEY, 'requestBuildInternal must receive the resolved CLI-flag apikey (forwarded resolveApikey)')
  assertEquals(buildCall.args[3], LOGGER, 'requestBuildInternal must receive the forwarded streaming logger as its 4th arg')
})

await test('ADAPTER: resolveApikey returning nothing finishes at build-complete WITHOUT requesting a build', async () => {
  const deps = makeDeps({ resolveApikey: () => undefined })
  const res = await runAndroidEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'no resolvable key must short-circuit to build-complete (android no-key UX)')
  assert(!deps.__calls.some(c => c.name === 'requestBuildInternal'), 'requestBuildInternal must NOT be called when no key is resolvable')
})

await test('ADAPTER: getPackageScripts/findProjectType/findBuildCommandForProjectType preload availableScripts + recommendedScript', async () => {
  const SCRIPTS = { build: 'vite build', dev: 'vite', lint: 'eslint .' }
  const deps = makeDeps({
    getPackageScripts: () => SCRIPTS,
    findProjectType: async () => 'vite',
    findBuildCommandForProjectType: async () => 'build',
  })
  const progress = tailProgress({ ciSecretTarget: GITHUB_TARGET, setupMode: 'with-workflow' })
  const res = await runAndroidEffect('uploading-ci-secrets', progress, deps)
  assertEquals(res.next, 'pick-package-manager', 'with-workflow continues into the workflow-builder sub-flow')
  assert(res.transient, 'uploading-ci-secrets (with-workflow) must return a transient')
  assertEquals(res.transient.availableScripts, SCRIPTS, 'forwarded getPackageScripts must populate transient.availableScripts')
  assertEquals(res.transient.recommendedScript, 'build', 'forwarded project-type deps must resolve the recommended build script')
})

await test('ADAPTER: trackWorkflowEvent fires when the workflow file is written', async () => {
  const events = []
  const deps = makeDeps({ trackWorkflowEvent: (event, options) => events.push({ event, options }) })
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  await runAndroidEffect('writing-workflow-file', progress, deps)
  assert(events.some(e => e.event === 'workflow-file-written'), 'trackWorkflowEvent must be forwarded and fire on workflow-file-written')
})

// ─── GAP 3 (ADAPTER): carried.workflowIsNew drives Wrote vs Overwrote ──

await test('GAP3 ADAPTER: writing-workflow-file logs ✔ Overwrote when carried.workflowIsNew === false', async () => {
  const logs = []
  const deps = makeDeps({ onLog: (msg, color) => logs.push({ msg, color }), carried: { workflowIsNew: false } })
  const progress = tailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
  })
  const res = await runAndroidEffect('writing-workflow-file', progress, deps)
  assertEquals(res.next, 'build-complete', 'still finishes the wizard')
  assert(logs.some(l => /^✔ Overwrote .+capgo-build\.yml/.test(l.msg)), 'an existing file logs Overwrote through the adapter')
})

// ─── GAP 1 (ADAPTER): onBuildOutput is forwarded into the requesting-build viewer ──

await test('GAP1 ADAPTER: requesting-build forwards the build-viewer lines into onBuildOutput (header + queued)', async () => {
  const buildLines = []
  const deps = makeDeps({
    onBuildOutput: line => buildLines.push(line),
    resolveApikey: () => 'k',
    carried: { ciSecretEntries: [] },
  })
  const res = await runAndroidEffect('requesting-build', tailProgress(), deps)
  assertEquals(res.next, 'build-complete', 'success with no entries finishes at build-complete')
  assertEquals(buildLines[0], `Requesting build for ${APP_ID} (android)...`, 'header line forwarded into onBuildOutput')
  assert(buildLines.some(l => /^✔ Build queued —/.test(l)), 'queued line forwarded into onBuildOutput')
})

await test('GAP1 ADAPTER: a thrown requesting-build routes to build-complete with the 2 catch lines via onBuildOutput (no throw)', async () => {
  const buildLines = []
  const deps = makeDeps({
    onBuildOutput: line => buildLines.push(line),
    resolveApikey: () => 'k',
    requestBuildInternal: async () => { throw new Error('network down') },
  })
  let threw = false
  let res
  try {
    res = await runAndroidEffect('requesting-build', tailProgress(), deps)
  }
  catch {
    threw = true
  }
  assert(!threw, 'a thrown build request must NOT propagate through the adapter')
  assertEquals(res.next, 'build-complete', 'a thrown build request still finishes at build-complete')
  assert(res.transient && /network down/.test(res.transient.error), 'the thrown error rides in transient.error')
  assert(buildLines.some(l => /^⚠ network down/.test(l)), 'catch line 1 forwarded into onBuildOutput')
  assert(buildLines.some(l => /Your credentials are saved.*try again/.test(l)), 'catch line 2 forwarded into onBuildOutput')
})

// ─── CHOICE / INPUT tail steps: assert each exposes a usable (non-auto) view ──
//
// These do not run through runAndroidEffect; the driver renders them and waits
// for input. The spec only requires androidViewForStep to return a view whose
// kind is a choice/input (so a driver can advance it).

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
  await test(`androidViewForStep('${step}') exposes a choice/input view`, async () => {
    const view = androidViewForStep(step, tailProgress(), { appId: APP_ID })
    assert(view, `view for ${step} must exist`)
    assertEquals(view.step, step, 'view.step must echo the requested step')
    assert(
      view.kind === 'choice' || view.kind === 'input',
      `${step} must be a choice/input step (got kind=${view.kind})`,
    )
  })
}

// ─── Terminal tail step views ────────────────────────────────────────────────

await test("androidViewForStep('build-complete') is a done view", async () => {
  const view = androidViewForStep('build-complete', tailProgress(), { appId: APP_ID })
  assertEquals(view.kind, 'done', 'build-complete must be a done view')
  assert(typeof view.message === 'string' && view.message.length > 0, 'build-complete must carry a message')
})

// ─── Resume routing THROUGH the tail (getAndroidResumeStep) ──────────────────
//
// A saved progress mid-tail must resume at the correct tail step using the
// persisted TailProgress fields + the post-save completedSteps markers
// (credentialsSaved / buildRequested / ciSecretsUploaded), WITHOUT re-firing a
// side-effect that already ran (no re-upload of secrets, no re-request of the
// build). `tailProgress()` already satisfies the keystore-validity gate, so
// adding the tail markers exercises only the new Phase-6 routing.

const CREDS_SAVED = { savedAt: '2026-06-03T01:00:00.000Z' }
const BUILD_REQUESTED = { buildUrl: `https://console.capgo.app/app/${APP_ID}/builds` }
const CI_UPLOADED_GH = { provider: 'github', count: 3 }

/**
 * A FULLY-provisioned OAuth progress — keystore valid + every provisioning
 * marker present + the ephemeral SA key — so `getAndroidResumeStep` reaches the
 * terminal `saving-credentials` when NO tail marker is set. The engine-effect
 * `tailProgress()` fixture above only carries the keystore + package markers
 * (enough to DRIVE a single tail step), so it would otherwise resume on the
 * OAuth path; this helper closes that gap for the resume-routing assertions.
 */
function provisionedProgress(overrides = {}) {
  const base = tailProgress()
  const { completedSteps: completedOverrides, ...rest } = overrides
  return {
    ...base,
    _oauthRefreshToken: 'refresh-token',
    ...rest,
    completedSteps: {
      ...base.completedSteps,
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub', scope: 'all' },
      playAccountChosen: { developerId: '123456789' },
      gcpProjectChosen: { projectId: 'capgo-test', displayName: 'Capgo', createdByOnboarding: false },
      serviceAccountProvisioned: { email: 'sa@capgo-test.iam.gserviceaccount.com', projectId: 'capgo-test' },
      playInviteProvisioned: { developerId: '123456789', serviceAccountEmail: 'sa@capgo-test.iam.gserviceaccount.com' },
      ...completedOverrides,
    },
  }
}

/** A post-save tail progress: fully provisioned + credentials already written. */
function savedTailProgress(overrides = {}) {
  const { completedSteps: completedOverrides, ...rest } = overrides
  return provisionedProgress({
    ...rest,
    completedSteps: {
      credentialsSaved: CREDS_SAVED,
      ...completedOverrides,
    },
  })
}

// Without ANY tail marker, resume is unchanged: a fully-provisioned progress
// still lands on saving-credentials (legacy / in-flight files untouched).
await test('no tail marker → resume stays saving-credentials (legacy parity)', async () => {
  assertEquals(getAndroidResumeStep(provisionedProgress()), 'saving-credentials')
})

// credentialsSaved but no build requested → the ask-build USER GATE, never the
// auto requesting-build step (this is the double-build guard).
await test('credentials saved, pre-build → ask-build (not requesting-build)', async () => {
  assertEquals(getAndroidResumeStep(savedTailProgress()), 'ask-build')
})

// Build queued, no CI work yet → detecting-ci-secrets (read-only, idempotent).
await test('after build, pre-CI-detection → detecting-ci-secrets', async () => {
  const p = savedTailProgress({ completedSteps: { buildRequested: BUILD_REQUESTED } })
  assertEquals(getAndroidResumeStep(p), 'detecting-ci-secrets')
})

// Build queued + a CI target already chosen, not uploaded → checking-ci-secrets
// (the read-only remote check before the confirm gate), NOT uploading.
await test('after build, target chosen, pre-upload → checking-ci-secrets (no re-upload)', async () => {
  const p = savedTailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    completedSteps: { buildRequested: BUILD_REQUESTED },
  })
  const next = getAndroidResumeStep(p)
  assertEquals(next, 'checking-ci-secrets')
  assert(next !== 'uploading-ci-secrets', 'must never resume directly onto the upload step')
})

// Declined GitHub Actions, no export path yet → the env-export prompt.
await test('after build, declined GH Actions, no export path → ask-export-env', async () => {
  const p = savedTailProgress({
    setupMode: 'declined',
    completedSteps: { buildRequested: BUILD_REQUESTED },
  })
  assertEquals(getAndroidResumeStep(p), 'ask-export-env')
})

// Declined GitHub Actions WITH an export path recorded → the (overwrite-safe)
// export write effect.
await test('after build, declined GH Actions, export path set → exporting-env', async () => {
  const p = savedTailProgress({
    setupMode: 'declined',
    envExportTargetPath: `/tmp/.env.capgo.${APP_ID}.android`,
    completedSteps: { buildRequested: BUILD_REQUESTED },
  })
  assertEquals(getAndroidResumeStep(p), 'exporting-env')
})

// Secrets uploaded + with-workflow, no package manager yet → pick-package-manager.
await test('after upload, with-workflow, no PM → pick-package-manager', async () => {
  const p = savedTailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    completedSteps: { buildRequested: BUILD_REQUESTED, ciSecretsUploaded: CI_UPLOADED_GH },
  })
  assertEquals(getAndroidResumeStep(p), 'pick-package-manager')
})

// Secrets uploaded + PM chosen, no build script yet → pick-build-script.
await test('after upload, with-workflow, PM set, no build script → pick-build-script', async () => {
  const p = savedTailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    completedSteps: { buildRequested: BUILD_REQUESTED, ciSecretsUploaded: CI_UPLOADED_GH },
  })
  assertEquals(getAndroidResumeStep(p), 'pick-build-script')
})

// Secrets uploaded + PM + build script chosen → writing-workflow-file (the
// overwrite=true write step; safe to re-run). This is the task's
// "after CI upload, pre-workflow → writing-workflow-file" case.
await test('after upload, with-workflow, PM + script set → writing-workflow-file', async () => {
  const p = savedTailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'with-workflow',
    selectedPackageManager: 'bun',
    buildScriptChoice: { type: 'npm-script', name: 'build' },
    completedSteps: { buildRequested: BUILD_REQUESTED, ciSecretsUploaded: CI_UPLOADED_GH },
  })
  assertEquals(getAndroidResumeStep(p), 'writing-workflow-file')
})

// Secrets uploaded + secrets-only (no workflow) → terminal build-complete.
await test('after upload, secrets-only → build-complete', async () => {
  const p = savedTailProgress({
    ciSecretTarget: GITHUB_TARGET,
    setupMode: 'secrets-only',
    completedSteps: { buildRequested: BUILD_REQUESTED, ciSecretsUploaded: CI_UPLOADED_GH },
  })
  assertEquals(getAndroidResumeStep(p), 'build-complete')
})

// The same tail routing must hold for the IMPORTED-SA path (serviceAccountMethod
// 'existing'): credentialsSaved short-circuits BEFORE the service-account fork,
// so an existing-SA tail progress resumes through the tail, not back to import.
await test('imported-SA tail progress resumes through the tail, not the import fork', async () => {
  const p = savedTailProgress({
    serviceAccountMethod: 'existing',
    completedSteps: { buildRequested: BUILD_REQUESTED },
  })
  assertEquals(getAndroidResumeStep(p), 'detecting-ci-secrets')
})

// `applyAndroidInput` is imported as part of the engine contract this spec
// drives; reference it so a regression that drops the export fails here too.
assert(typeof applyAndroidInput === 'function', 'applyAndroidInput must be exported from the engine')

// ─── HOSTILE-REVIEW MED: backing-up must not mislabel REAL copy failures ───────
//
// '(file may not exist yet)' is only true for ENOENT. A real failure (EACCES,
// disk full, …) must surface its actual reason — the flow still proceeds (the
// gate's promise was "backup attempted", not "backup must succeed") but the
// message must not lie.

await test('backing-up: a REAL copyFile failure (EACCES) logs a truthful warning, not "(file may not exist yet)" — flow still proceeds', async () => {
  const logs = []
  const internal = []
  const deps = {
    copyFile: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) },
    saveAndroidProgress: async () => {},
    onLog: (msg, color) => logs.push({ msg, color }),
    onInternalLog: line => internal.push(line),
  }
  const res = await runAndroidEffect('backing-up', tailProgress(), deps)
  assertEquals(res.next, 'keystore-method-select', 'the flow still proceeds (gate contract unchanged)')
  assertEquals(res.progress._credentialsExistGate, 'done', 'gate still flips to done')
  const warn = logs.find(l => /Could not back up credentials/.test(l.msg))
  assert(warn, `must log the truthful could-not-back-up warning (got: ${JSON.stringify(logs)})`)
  assert(warn.msg.includes('EACCES'), 'the warning must carry the real reason')
  assertEquals(warn.color, 'yellow', 'warning stays yellow')
  assert(!logs.some(l => /file may not exist yet/.test(l.msg)), 'must NOT claim the file may not exist on a permission failure')
  assert(internal.some(line => line.includes('EACCES')), 'the real reason still reaches onInternalLog')
})

await test('backing-up: a MISSING source file (ENOENT) keeps the benign message and proceeds', async () => {
  const logs = []
  const deps = {
    copyFile: async () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }) },
    saveAndroidProgress: async () => {},
    onLog: (msg, color) => logs.push({ msg, color }),
    onInternalLog: () => {},
  }
  const res = await runAndroidEffect('backing-up', tailProgress(), deps)
  assertEquals(res.next, 'keystore-method-select', 'missing source stays non-fatal')
  assert(logs.some(l => /file may not exist yet/.test(l.msg)), 'the benign message stays for the genuinely-missing-file case')
})

// ─── HOSTILE-REVIEW MED (CodeRabbit): revoked OAuth token must not linger ──────

await test('gcp-setup-running strips _oauthRefreshToken from the persisted progress after a successful revoke', async () => {
  const savedSnapshots = []
  const deps = {
    getAccessToken: async () => 'tok',
    enableService: async () => {},
    ensureServiceAccount: async () => ({ account: { email: 'sa@proj-1.iam.gserviceaccount.com', uniqueId: 'U1' }, created: true }),
    createServiceAccountKey: async () => ({ privateKeyDataBase64: 'eyJ9' }),
    inviteServiceAccount: async () => {},
    revokeToken: async () => {},
    saveAndroidProgress: async (appId, p) => { savedSnapshots.push(p) },
    onStatus: () => {},
    onLog: () => {},
  }
  const progress = tailProgress({
    _oauthRefreshToken: 'rt-secret',
    completedSteps: {
      gcpProjectChosen: { projectId: 'proj-1', displayName: 'Proj', createdByOnboarding: false },
      playAccountChosen: { developerId: 'dev-1' },
      androidPackageChosen: { packageName: APP_ID, source: 'gradle' },
    },
  })
  const res = await runAndroidEffect('gcp-setup-running', progress, deps)
  assertEquals(res.next, 'saving-credentials', 'the happy provisioning chain finishes into saving-credentials')
  assert(res.progress._oauthRefreshToken === undefined, 'the returned progress must not carry the revoked refresh token')
  const last = savedSnapshots[savedSnapshots.length - 1]
  assert(last, 'progress must be persisted after the revoke step')
  assert(last._oauthRefreshToken === undefined, 'the PERSISTED progress must not carry the revoked refresh token')
})

await test('gcp-setup-running keeps the chain alive when revokeToken FAILS (token expires on its own)', async () => {
  const statuses = []
  const deps = {
    getAccessToken: async () => 'tok',
    enableService: async () => {},
    ensureServiceAccount: async () => ({ account: { email: 'sa@proj-1.iam.gserviceaccount.com', uniqueId: 'U1' }, created: false }),
    createServiceAccountKey: async () => ({ privateKeyDataBase64: 'eyJ9' }),
    inviteServiceAccount: async () => {},
    revokeToken: async () => { throw new Error('revoke endpoint down') },
    saveAndroidProgress: async () => {},
    onStatus: msg => statuses.push(msg),
    onLog: () => {},
  }
  const progress = tailProgress({
    _oauthRefreshToken: 'rt-secret',
    completedSteps: {
      gcpProjectChosen: { projectId: 'proj-1', displayName: 'Proj', createdByOnboarding: false },
      playAccountChosen: { developerId: 'dev-1' },
      androidPackageChosen: { packageName: APP_ID, source: 'gradle' },
    },
  })
  const res = await runAndroidEffect('gcp-setup-running', progress, deps)
  assertEquals(res.next, 'saving-credentials', 'a failed revoke stays non-fatal')
  assert(statuses.some(s => /Revoke request failed/.test(s)), 'the failure is surfaced via onStatus')
})

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)

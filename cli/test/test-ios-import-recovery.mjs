#!/usr/bin/env node
/**
 * iOS BATCH 7a — import recovery spec (no-match hub / portal / provide-path /
 * create-profile-only).
 *
 * Drives `iosViewForStep` / `applyIosInput` / `runIosEffect` for the four
 * recovery-branch steps with MOCKED IosEffectDeps (no fs, no network, no child
 * processes):
 *
 *   import-no-match-recovery (choice + resolver, the 5-way HUB):
 *     view variant depends on noMatchReason + hasAscKey + importDistribution +
 *       canUseFilePicker.
 *     'back' / no pick      -> import-pick-identity
 *     'browser'             -> import-portal-explanation
 *     'provide-profile-path'-> import-provide-profile-path
 *     'create' + ASC key    -> import-create-profile-only
 *     'create' + no ASC key -> api-key-instructions (PERSIST
 *                             pendingRecoveryAction='import-create-profile-only')
 *     STICKY: noMatchReason is threaded back UNCHANGED, never recomputed.
 *
 *   import-portal-explanation (choice + resolver):
 *     'use-create'  -> import-create-profile-only
 *     'use-file'    -> import-provide-profile-path
 *     'open-anyway' -> opens the portal (best-effort) -> import-no-match-recovery
 *     'back'/other  -> import-no-match-recovery   (noMatchReason kept)
 *
 *   import-provide-profile-path (file-picker effect, IDEMPOTENT):
 *     already opened (guard) -> import-no-match-recovery  (noMatchReason kept)
 *     picker cancelled       -> import-no-match-recovery  (noMatchReason kept)
 *     parse error / bad file -> error
 *     valid file             -> carried.chosenProfile + injected importMatches +
 *                              import-pick-profile
 *
 *   import-create-profile-only (effect):
 *     no chosenIdentity      -> error
 *     ad_hoc distribution    -> error (apple-api only mints app_store)
 *     Apple has no cert      -> error
 *     DuplicateProfileError  -> PERSIST duplicateProfileOrigin=
 *                              'import-create-profile-only' -> duplicate-profile-prompt
 *     success                -> carried.chosenProfile + injected importMatches +
 *                              import-export-warning
 *
 *   BATCH 3 dual-origin round-trip:
 *     import-create-profile-only -> duplicate-profile-prompt ->
 *       deleting-duplicate-profiles -> import-create-profile-only (NOT the
 *       create-new creating-profile).
 *
 * Like test-ios-recovery.mjs / test-ios-import-pickers.mjs, this file is the
 * headless DRIVER: the choice steps are EPHEMERAL-branching, so the driver
 * records the user's pick into deps.carried (recoveryAction / portalAction /
 * chosenProfile / chosenIdentity / noMatchReason) and re-drives the step through
 * runIosEffect as a resolver — the SAME mechanism the Ink TUI uses to mirror its
 * React state/refs. The engine is IO-FREE: every Apple-API / keychain / file-
 * picker touch is an injected dep, and NOTHING ephemeral (the recovery selection,
 * the sticky noMatchReason, the synthesized profile, the certData/profileData) is
 * ever persisted to progress.json — only the duplicateProfileOrigin +
 * pendingRecoveryAction markers are.
 */
import { Buffer } from 'node:buffer'
import process from 'node:process'

const {
  runIosEffect,
  iosViewForStep,
  applyIosInput,
} = await import('../src/build/onboarding/ios/flow.ts')
const { DuplicateProfileError } = await import('../src/build/onboarding/apple-api.ts')

console.log('🧪 iOS BATCH 7a — import recovery (hub / portal / provide-path / create-profile-only)\n')

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

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const IDENTITY_A = { sha1: 'a'.repeat(40), name: 'Apple Distribution: Acme (TEAMAAA)', type: 'distribution', teamName: 'Acme', teamId: 'TEAMAAA' }

// import-scanning inventory: A has no on-disk profile (so recovery is reachable).
const MATCHES_A_NO_PROFILE = [{ identity: IDENTITY_A, profiles: [] }]

// A parsed .mobileprovision detail the picker dep yields (mobileprovision-parser
// MobileprovisionDetail shape). Valid for this app + app_store + IDENTITY_A.
function detail(overrides = {}) {
  return {
    name: 'Imported App Store',
    uuid: 'IMPORTED-UUID',
    applicationIdentifier: `TEAMAAA.${APP_ID}`,
    bundleId: APP_ID,
    teamId: 'TEAMAAA',
    expirationDate: '2027-01-01T00:00:00.000Z',
    profileType: 'app_store',
    certificateSha1s: [IDENTITY_A.sha1],
    ...overrides,
  }
}

/** Build an iOS OnboardingProgress for the import-existing path. */
function iosProgress(overrides = {}) {
  const { completedSteps: completedOverrides, ...rest } = overrides
  return {
    platform: 'ios',
    appId: APP_ID,
    startedAt: '2026-06-03T00:00:00.000Z',
    setupMethod: 'import-existing',
    importDistribution: 'app_store',
    ...rest,
    completedSteps: {
      ...completedOverrides,
    },
  }
}

/**
 * Mocked IosEffectDeps. Apple-API / keychain / file-picker / browser touches are
 * injected and record their calls so the spec can assert which helper fired and
 * with what argument. `carried` is the driver-held transient — the spec threads
 * the ephemeral recovery selection / chosen identity / chosen profile / sticky
 * noMatchReason through it.
 */
function makeDeps(overrides = {}) {
  const calls = []

  const deps = {
    appId: APP_ID,

    findCertIdBySha1: async (sha1) => { calls.push({ name: 'findCertIdBySha1', args: [sha1] }); return 'APPLE-CERT-ID' },
    ensureBundleId: async (bundleId) => { calls.push({ name: 'ensureBundleId', args: [bundleId] }) },
    createProfile: async (args) => {
      calls.push({ name: 'createProfile', args: [args] })
      return { profileId: 'NEW-PROFILE-ID', profileName: 'Capgo com.example.app AppStore', profileBase64: 'TkVXLVBST0ZJTEU=', expirationDate: '2027-01-01T00:00:00.000Z' }
    },
    deleteProfile: async (id) => { calls.push({ name: 'deleteProfile', args: [id] }) },

    openProfilePicker: async () => { calls.push({ name: 'openProfilePicker', args: [] }); return '/Users/me/Downloads/profile.mobileprovision' },
    readFile: async (p) => { calls.push({ name: 'readFile', args: [p] }); return Buffer.from('RAW-MOBILEPROVISION-BYTES') },
    parseMobileprovisionDetailed: (bytes) => { calls.push({ name: 'parseMobileprovisionDetailed', args: [bytes] }); return detail() },
    openExternal: async (url) => { calls.push({ name: 'openExternal', args: [url] }) },

    saveProgress: async (appId, progress) => { calls.push({ name: 'saveProgress', args: [appId, progress] }) },
    loadProgress: async () => null,

    onStatus: () => {},
    onLog: () => {},

    ...overrides,
  }
  deps.__calls = calls
  return deps
}

// ════════════════════════════════════════════════════════════════════════════════
// import-no-match-recovery — VIEW (menu variants)
// ════════════════════════════════════════════════════════════════════════════════

console.log('🧪 import-no-match-recovery VIEW (menu variants)\n')

await test("iosViewForStep('import-no-match-recovery') is a choice: create + provide-path + browser + back (app_store, ASC key, file picker)", async () => {
  // ASC key present := a persisted progress.p8Path (a TUI-honored signal — app.tsx:3530
  // uses p8PathRef, not completedSteps.apiKeyVerified, after the v1 hasAscKey refactor).
  const view = iosViewForStep('import-no-match-recovery', iosProgress({ p8Path: '/Users/me/AuthKey_K.p8' }), {
    chosenIdentity: IDENTITY_A,
    noMatchReason: 'apple-no-profiles-linked',
    canUseFilePicker: true,
  })
  assertEquals(view.step, 'import-no-match-recovery', 'view echoes the step')
  assertEquals(view.kind, 'choice', 'recovery hub is a choice')
  const values = (view.options ?? []).map(o => o.value)
  assert(values.includes('create'), 'offers create')
  assert(values.includes('provide-profile-path'), 'offers the file-picker path')
  assert(values.includes('browser'), 'offers the portal')
  assert(values.includes('back'), 'offers back-to-identity')
})

await test("import-no-match-recovery view title names the actual cause (sticky noMatchReason -> alert sentence)", async () => {
  const view = iosViewForStep('import-no-match-recovery', iosProgress(), {
    chosenIdentity: IDENTITY_A,
    noMatchReason: 'apple-no-cert-match',
  })
  assert((view.title ?? '').includes(IDENTITY_A.name), 'title names the identity')
  assert(/don't include the certificate|revoked|different team/.test(view.title ?? ''), 'apple-no-cert-match alert wording')
})

await test("import-no-match-recovery view 'create' label flips when no ASC key is present", async () => {
  // hasAscKey in the VIEW matches the TUI exactly (app.tsx:3530 — p8ContentRef OR
  // p8PathRef): only a carried ctx.p8Content or a PERSISTED progress.p8Path flips the
  // label to "create now". A persisted completedSteps.apiKeyVerified does NOT flip it
  // (TUI-parity / v1 behavior-preservation — see the iOS transition-graph audit's
  // divergence log), so the "with key" case here uses progress.p8Path.
  const withKey = iosViewForStep('import-no-match-recovery', iosProgress({ p8Path: '/Users/me/AuthKey_K.p8' }), { chosenIdentity: IDENTITY_A })
  const withoutKey = iosViewForStep('import-no-match-recovery', iosProgress(), { chosenIdentity: IDENTITY_A })
  const createWith = withKey.options.find(o => o.value === 'create')
  const createWithout = withoutKey.options.find(o => o.value === 'create')
  assert(createWith && !/Provide ASC API key/.test(createWith.label), 'with a key the create row just creates')
  assert(createWithout && /Provide ASC API key/.test(createWithout.label), 'without a key the create row asks for the key first')
})

await test("import-no-match-recovery view 'create' label does NOT flip on a persisted apiKeyVerified alone (TUI-parity: app.tsx:3530 omits apiKeyVerified)", async () => {
  // Regression guard for the v1 behavior-preserving refactor: the engine VIEW dropped
  // the apiKeyVerified component of hasAscKey to match the TUI ref expression. A user
  // who verified the ASC key but has no carried p8Content / persisted p8Path still sees
  // the "provide ASC key first" label. FLAGGED for maintainer — including apiKeyVerified
  // would be a post-v1 UX improvement (shared by TUI + engine once Phase 4 lands).
  const view = iosViewForStep('import-no-match-recovery', iosProgress({ completedSteps: { apiKeyVerified: { keyId: 'K', issuerId: 'I' } } }), { chosenIdentity: IDENTITY_A })
  const create = view.options.find(o => o.value === 'create')
  assert(create && /Provide ASC API key/.test(create.label), 'apiKeyVerified alone does NOT flip the create-row label (matches the TUI)')
})

await test("import-no-match-recovery view HIDES 'create' for ad_hoc (apple-api only mints app_store)", async () => {
  const view = iosViewForStep('import-no-match-recovery', iosProgress({ importDistribution: 'ad_hoc' }), { chosenIdentity: IDENTITY_A })
  const values = view.options.map(o => o.value)
  assert(!values.includes('create'), 'ad_hoc must not offer the app_store-only create option')
  assert(values.includes('browser'), 'ad_hoc still offers the portal')
})

await test("import-no-match-recovery view HIDES the file-picker option when canUseFilePicker is false", async () => {
  const view = iosViewForStep('import-no-match-recovery', iosProgress(), { chosenIdentity: IDENTITY_A, canUseFilePicker: false })
  const values = view.options.map(o => o.value)
  assert(!values.includes('provide-profile-path'), 'no file-picker option without a picker')
})

// ─── import-no-match-recovery REDUCER (ephemeral — persists nothing) ─────────────

await test('import-no-match-recovery reducer persists NOTHING (the pick is ephemeral)', async () => {
  const before = iosProgress({ noMatchReason: undefined })
  for (const value of ['create', 'provide-profile-path', 'browser', 'back']) {
    const after = applyIosInput('import-no-match-recovery', before, { step: 'import-no-match-recovery', value })
    assertEquals(JSON.stringify(after), JSON.stringify(before), `'${value}' writes nothing to progress`)
  }
})

// ════════════════════════════════════════════════════════════════════════════════
// import-no-match-recovery — RESOLVER (5-way routing + sticky reason)
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 import-no-match-recovery RESOLVER (5-way routing + sticky noMatchReason)\n')

await test("recovery resolver 'back' (or no pick) -> import-pick-identity; keeps noMatchReason", async () => {
  const noPick = await runIosEffect('import-no-match-recovery', iosProgress(), makeDeps({ carried: { noMatchReason: 'apple-other' } }))
  assertEquals(noPick.next, 'import-pick-identity', 'no pick bounces to identity selection')
  assertEquals(noPick.transient?.noMatchReason, 'apple-other', 'sticky reason threaded back unchanged')
  const back = await runIosEffect('import-no-match-recovery', iosProgress(), makeDeps({ carried: { recoveryAction: 'back', noMatchReason: 'apple-other' } }))
  assertEquals(back.next, 'import-pick-identity', "'back' bounces to identity selection")
})

await test("recovery resolver 'browser' -> import-portal-explanation; keeps noMatchReason", async () => {
  const res = await runIosEffect('import-no-match-recovery', iosProgress(), makeDeps({ carried: { recoveryAction: 'browser', noMatchReason: 'apple-bundle-mismatch' } }))
  assertEquals(res.next, 'import-portal-explanation', "'browser' opens the walkthrough")
  assertEquals(res.transient?.noMatchReason, 'apple-bundle-mismatch', 'STICKY: reason is NOT recomputed/overwritten on portal-open')
})

await test("recovery resolver 'provide-profile-path' -> import-provide-profile-path; keeps noMatchReason", async () => {
  const res = await runIosEffect('import-no-match-recovery', iosProgress(), makeDeps({ carried: { recoveryAction: 'provide-profile-path', noMatchReason: 'no-profile-on-disk' } }))
  assertEquals(res.next, 'import-provide-profile-path', "'provide-profile-path' opens the file picker step")
  assertEquals(res.transient?.noMatchReason, 'no-profile-on-disk', 'STICKY: reason threaded into the file picker step')
})

await test("recovery resolver 'create' + ASC key (carried.p8Content) -> import-create-profile-only; persists nothing", async () => {
  const deps = makeDeps({ carried: { recoveryAction: 'create', noMatchReason: 'apple-no-profiles-linked', p8Content: Buffer.from('P8') } })
  const res = await runIosEffect('import-no-match-recovery', iosProgress(), deps)
  assertEquals(res.next, 'import-create-profile-only', 'with a key, create goes straight to D2')
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'the ASC-key-present create branch persists nothing')
})

await test("recovery resolver 'create' + ASC key (persisted p8Path) -> import-create-profile-only", async () => {
  // A genuinely-reachable hasAscKey state: progress.p8Path is set (the TUI's p8PathRef
  // signal). apiKeyVerified rides alongside it in every reachable state, but the resolver
  // hasAscKey no longer reads apiKeyVerified — it matches the TUI's
  // !!(p8ContentRef.current || p8PathRef.current) (app.tsx:3601-3604).
  const res = await runIosEffect('import-no-match-recovery', iosProgress({ p8Path: '/Users/me/AuthKey_K.p8', completedSteps: { apiKeyVerified: { keyId: 'K', issuerId: 'I' } } }), makeDeps({ carried: { recoveryAction: 'create' } }))
  assertEquals(res.next, 'import-create-profile-only', 'a persisted p8Path counts as an available ASC key')
})

await test("recovery resolver 'create' + apiKeyVerified ALONE (no p8Content/p8Path) -> api-key-instructions (TUI-parity: app.tsx:3601-3604 omits apiKeyVerified)", async () => {
  // Defensive / unreachable-in-practice: a persisted apiKeyVerified with NO carried
  // p8Content and NO persisted p8Path. The resolver hasAscKey dropped apiKeyVerified to
  // match the TUI ref expression, so 'create' falls through to the .p8 chain.
  const res = await runIosEffect('import-no-match-recovery', iosProgress({ completedSteps: { apiKeyVerified: { keyId: 'K', issuerId: 'I' } } }), makeDeps({ carried: { recoveryAction: 'create' } }))
  assertEquals(res.next, 'api-key-instructions', 'apiKeyVerified alone is NOT an ASC key for routing (matches the TUI)')
  assertEquals(res.progress.pendingRecoveryAction, 'import-create-profile-only', 'remembers to resume D2 after key verification')
})

await test("recovery resolver 'create' + NO ASC key -> api-key-instructions; PERSISTS pendingRecoveryAction='import-create-profile-only'", async () => {
  const deps = makeDeps({ carried: { recoveryAction: 'create', noMatchReason: 'apple-no-profiles-linked' } })
  const res = await runIosEffect('import-no-match-recovery', iosProgress(), deps)
  assertEquals(res.next, 'api-key-instructions', 'no key -> start the .p8 chain')
  assertEquals(res.progress.pendingRecoveryAction, 'import-create-profile-only', 'remembers to resume D2 after key verification')
  const save = deps.__calls.find(c => c.name === 'saveProgress')
  assert(save, 'pendingRecoveryAction is PERSISTED')
  assertEquals(save.args[1].pendingRecoveryAction, 'import-create-profile-only', 'the persisted marker is the full step name')
  assertEquals(res.transient?.noMatchReason, 'apple-no-profiles-linked', 'sticky reason still threaded through the .p8 detour')
})

// ════════════════════════════════════════════════════════════════════════════════
// import-portal-explanation — VIEW + RESOLVER
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 import-portal-explanation VIEW + RESOLVER\n')

await test("iosViewForStep('import-portal-explanation') is a choice: use-create + open-anyway + use-file + back (app_store)", async () => {
  const view = iosViewForStep('import-portal-explanation', iosProgress(), { chosenIdentity: IDENTITY_A, canUseFilePicker: true })
  assertEquals(view.kind, 'choice', 'portal explanation is a choice')
  const values = (view.options ?? []).map(o => o.value)
  assert(values.includes('use-create'), 'app_store offers the auto-create nudge')
  assert(values.includes('open-anyway'), 'offers opening the portal')
  assert(values.includes('use-file'), 'offers the file picker')
  assert(values.includes('back'), 'offers back to the recovery menu')
})

await test("import-portal-explanation view HIDES 'use-create' for ad_hoc", async () => {
  const view = iosViewForStep('import-portal-explanation', iosProgress({ importDistribution: 'ad_hoc' }), { chosenIdentity: IDENTITY_A })
  const values = view.options.map(o => o.value)
  assert(!values.includes('use-create'), 'ad_hoc has no auto-create path to nudge toward')
  assert(values.includes('open-anyway'), 'ad_hoc still offers opening the portal')
})

await test('import-portal-explanation reducer persists NOTHING', async () => {
  const before = iosProgress()
  for (const value of ['use-create', 'use-file', 'open-anyway', 'back']) {
    const after = applyIosInput('import-portal-explanation', before, { step: 'import-portal-explanation', value })
    assertEquals(JSON.stringify(after), JSON.stringify(before), `'${value}' writes nothing`)
  }
})

await test("portal resolver 'use-create' -> import-create-profile-only", async () => {
  const res = await runIosEffect('import-portal-explanation', iosProgress(), makeDeps({ carried: { portalAction: 'use-create', noMatchReason: 'apple-other' } }))
  assertEquals(res.next, 'import-create-profile-only', 'the recommended auto path')
  assertEquals(res.transient?.noMatchReason, 'apple-other', 'reason still threaded')
})

await test("portal resolver 'use-file' -> import-provide-profile-path", async () => {
  const res = await runIosEffect('import-portal-explanation', iosProgress(), makeDeps({ carried: { portalAction: 'use-file', noMatchReason: 'apple-other' } }))
  assertEquals(res.next, 'import-provide-profile-path', 'jump straight to the file picker step')
})

await test("portal resolver 'open-anyway' -> opens the portal (best-effort) -> import-no-match-recovery; STICKY reason kept", async () => {
  const deps = makeDeps({ carried: { portalAction: 'open-anyway', noMatchReason: 'apple-distribution-mismatch' } })
  const res = await runIosEffect('import-portal-explanation', iosProgress(), deps)
  assertEquals(res.next, 'import-no-match-recovery', 'opening the portal bounces back to the recovery menu')
  const opened = deps.__calls.find(c => c.name === 'openExternal')
  assert(opened, 'the portal URL was opened')
  assert(/developer\.apple\.com/.test(opened.args[0]), 'opened the Apple profiles list')
  assertEquals(res.transient?.noMatchReason, 'apple-distribution-mismatch', 'STICKY: portal-open does NOT recompute/overwrite noMatchReason')
})

await test("portal resolver 'open-anyway' tolerates an openExternal failure (recovery is not aborted)", async () => {
  const deps = makeDeps({ carried: { portalAction: 'open-anyway', noMatchReason: 'apple-other' }, openExternal: async () => { throw new Error('no browser') } })
  const res = await runIosEffect('import-portal-explanation', iosProgress(), deps)
  assertEquals(res.next, 'import-no-match-recovery', 'a failed portal-open still bounces back, never errors')
})

await test("portal resolver 'back' -> import-no-match-recovery; STICKY reason kept", async () => {
  const res = await runIosEffect('import-portal-explanation', iosProgress(), makeDeps({ carried: { portalAction: 'back', noMatchReason: 'apple-bundle-mismatch' } }))
  assertEquals(res.next, 'import-no-match-recovery', "'back' returns to the recovery menu")
  assertEquals(res.transient?.noMatchReason, 'apple-bundle-mismatch', 'STICKY: back-nav keeps the reason')
})

// ════════════════════════════════════════════════════════════════════════════════
// import-provide-profile-path — FILE PICKER EFFECT (idempotent + validation)
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 import-provide-profile-path (file-picker effect, idempotent)\n')

await test('import-provide-profile-path (valid file) -> import-pick-profile; carries chosenProfile + injected importMatches', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, importMatches: MATCHES_A_NO_PROFILE, noMatchReason: 'no-profile-on-disk' } })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'import-pick-profile', 'a valid file feeds the picker')
  assert(res.transient?.profilePickerOpened === true, 'marks the picker as opened (idempotency guard)')
  assert(res.transient?.chosenProfile, 'the synthesized profile rides transient')
  assertEquals(res.transient.chosenProfile.uuid, 'IMPORTED-UUID', 'the parsed profile becomes the chosen profile')
  assertEquals(res.transient.chosenProfile.path, '/Users/me/Downloads/profile.mobileprovision', 'TUI path is preserved for later disk read at export')
  const inj = res.transient.importMatches.find(m => m.identity.sha1 === IDENTITY_A.sha1)
  assertEquals(inj.profiles.length, 1, 'the profile is injected into the chosen identity match')
  assert(deps.__calls.some(c => c.name === 'openProfilePicker'), 'opened the native picker')
  assert(deps.__calls.some(c => c.name === 'parseMobileprovisionDetailed'), 'parsed the chosen file')
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'nothing is persisted (the synthesized profile is transient)')
})

await test('import-provide-profile-path (MCP scoped read) stores profileBase64 and empty path (no export re-read)', async () => {
  const scopedBytes = Buffer.from('SCOPED-MANUAL-PROFILE-BYTES')
  const deps = makeDeps({
    carried: { chosenIdentity: IDENTITY_A, importMatches: MATCHES_A_NO_PROFILE, noMatchReason: 'no-profile-on-disk' },
    readMcpMobileprovision: async (p) => { deps.__calls.push({ name: 'readMcpMobileprovision', args: [p] }); return scopedBytes },
  })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'import-pick-profile')
  assertEquals(res.transient.chosenProfile.path, '', 'MCP path carries bytes on the profile, not a disk path')
  assertEquals(res.transient.chosenProfile.profileBase64, scopedBytes.toString('base64'))
  assert(deps.__calls.some(c => c.name === 'readMcpMobileprovision'), 'scoped reader is used for MCP manual path')
})

await test('import-provide-profile-path IDEMPOTENT: already-opened guard -> import-no-match-recovery WITHOUT re-opening; STICKY reason kept', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, profilePickerOpened: true, noMatchReason: 'apple-no-cert-match' } })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'import-no-match-recovery', 'a re-drive after opening bounces to recovery (no double-open)')
  assert(!deps.__calls.some(c => c.name === 'openProfilePicker'), 'the native picker is NOT re-opened')
  assertEquals(res.transient?.noMatchReason, 'apple-no-cert-match', 'STICKY: re-entry does NOT recompute noMatchReason')
})

await test('import-provide-profile-path (picker cancelled) -> import-no-match-recovery; STICKY reason kept', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, noMatchReason: 'apple-bundle-mismatch' }, openProfilePicker: async () => null })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'import-no-match-recovery', 'cancelling bounces back to the recovery menu')
  assertEquals(res.transient?.noMatchReason, 'apple-bundle-mismatch', 'STICKY: file-picker cancel does NOT recompute noMatchReason')
  assert(res.transient?.profilePickerOpened === true, 'still marks the picker as opened so a re-drive does not re-open')
})

await test('import-provide-profile-path (no chosen identity) -> error', async () => {
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), makeDeps({ carried: {} }))
  assertEquals(res.next, 'error', 'no identity is an internal error')
})

await test('import-provide-profile-path (parse failure) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, parseMobileprovisionDetailed: () => { throw new Error('bad plist') } })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'error', 'an unparseable file routes to error')
})

await test('import-provide-profile-path (wrong bundle id) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, parseMobileprovisionDetailed: () => detail({ bundleId: 'com.other.app' }) })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'error', 'a profile for the wrong app routes to error')
})

await test('import-provide-profile-path (wrong distribution) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, parseMobileprovisionDetailed: () => detail({ profileType: 'ad_hoc' }) })
  const res = await runIosEffect('import-provide-profile-path', iosProgress({ importDistribution: 'app_store' }), deps)
  assertEquals(res.next, 'error', 'a profile of the wrong distribution type routes to error')
})

await test("import-provide-profile-path (profile doesn't trust the chosen cert) -> error", async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, parseMobileprovisionDetailed: () => detail({ certificateSha1s: ['f'.repeat(40)] }) })
  const res = await runIosEffect('import-provide-profile-path', iosProgress(), deps)
  assertEquals(res.next, 'error', "a profile that doesn't list the chosen cert routes to error")
})

// ════════════════════════════════════════════════════════════════════════════════
// import-create-profile-only — EFFECT
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 import-create-profile-only (effect)\n')

await test('import-create-profile-only (success) -> import-export-warning; carries chosenProfile + injected importMatches; persists nothing', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, importMatches: MATCHES_A_NO_PROFILE } })
  const res = await runIosEffect('import-create-profile-only', iosProgress(), deps)
  assertEquals(res.next, 'import-export-warning', 'a freshly-created profile advances to the export warning')
  assert(res.transient?.chosenProfile, 'the new profile rides transient as the chosen profile')
  assertEquals(res.transient.chosenProfile.uuid, 'NEW-PROFILE-ID', 'the created profile id becomes the chosen profile uuid')
  assertEquals(res.transient.chosenProfile.profileBase64, 'TkVXLVBST0ZJTEU=', 'profileBase64 (the .mobileprovision bytes) rides transient')
  const inj = res.transient.importMatches.find(m => m.identity.sha1 === IDENTITY_A.sha1)
  assertEquals(inj.profiles.length, 1, 'the new profile is injected into the chosen identity match')
  assert(deps.__calls.some(c => c.name === 'findCertIdBySha1'), 'resolved the Apple cert id')
  assert(deps.__calls.some(c => c.name === 'ensureBundleId'), 'ensured the bundle id exists')
  assert(deps.__calls.some(c => c.name === 'createProfile'), 'created the profile via Apple')
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'success persists nothing (the export payload is transient)')
})

await test('import-create-profile-only passes the resolved app id (override) to ensureBundleId + createProfile', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A } })
  await runIosEffect('import-create-profile-only', iosProgress({ iosBundleIdOverride: 'com.example.override' }), deps)
  assertEquals(deps.__calls.find(c => c.name === 'ensureBundleId').args[0], 'com.example.override', 'ensureBundleId uses the confirmed override')
  assertEquals(deps.__calls.find(c => c.name === 'createProfile').args[0].bundleId, 'com.example.override', 'createProfile uses the confirmed override')
})

await test('import-create-profile-only (no chosen identity) -> error', async () => {
  const res = await runIosEffect('import-create-profile-only', iosProgress(), makeDeps({ carried: {} }))
  assertEquals(res.next, 'error', 'no identity is an internal error')
})

await test('import-create-profile-only REFUSES ad_hoc (apple-api only mints app_store) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A } })
  const res = await runIosEffect('import-create-profile-only', iosProgress({ importDistribution: 'ad_hoc' }), deps)
  assertEquals(res.next, 'error', 'ad_hoc create is refused')
  assert(!deps.__calls.some(c => c.name === 'createProfile'), 'no profile is created for ad_hoc')
})

await test('import-create-profile-only (Apple has no cert for the identity) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, findCertIdBySha1: async () => null })
  const res = await runIosEffect('import-create-profile-only', iosProgress(), deps)
  assertEquals(res.next, 'error', 'no Apple cert id -> cannot create a profile')
  assert(!deps.__calls.some(c => c.name === 'createProfile'), 'createProfile is not called without a cert id')
})

await test("import-create-profile-only (DuplicateProfileError) -> duplicate-profile-prompt; PERSISTS duplicateProfileOrigin='import-create-profile-only'", async () => {
  const dups = [{ id: 'DUP1', name: 'Capgo com.example.app AppStore', profileType: 'IOS_APP_STORE' }]
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, createProfile: async () => { throw new DuplicateProfileError(dups) } })
  const res = await runIosEffect('import-create-profile-only', iosProgress(), deps)
  assertEquals(res.next, 'duplicate-profile-prompt', 'a duplicate routes to the shared prompt')
  assertEquals(res.progress.duplicateProfileOrigin, 'import-create-profile-only', 'records the IMPORT origin (the dual-origin contract)')
  const save = deps.__calls.find(c => c.name === 'saveProgress')
  assert(save, 'duplicateProfileOrigin is PERSISTED')
  assertEquals(save.args[1].duplicateProfileOrigin, 'import-create-profile-only', 'the persisted origin is the import step')
  assert(res.transient?.duplicateProfiles && res.transient.duplicateProfiles.length === 1, 'the duplicates ride transient for the prompt')
})

await test('import-create-profile-only (other Apple error) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, createProfile: async () => { throw new Error('apple 500') } })
  const res = await runIosEffect('import-create-profile-only', iosProgress(), deps)
  assertEquals(res.next, 'error', 'a non-duplicate Apple failure routes to error')
})

// ════════════════════════════════════════════════════════════════════════════════
// BATCH 3 DUAL-ORIGIN ROUND-TRIP
//   import-create-profile-only -> duplicate-profile-prompt -> deleting-duplicate-
//   profiles -> import-create-profile-only (NOT the create-new creating-profile)
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 BATCH 3 dual-origin round-trip (import D2 <-> duplicate deletion)\n')

await test('DRIVER: D2 duplicate -> prompt -> delete -> import-create-profile-only (full import duplicate recovery)', async () => {
  const dups = [
    { id: 'DUP1', name: 'Capgo com.example.app AppStore', profileType: 'IOS_APP_STORE' },
    { id: 'DUP2', name: 'Capgo com.example.app AppStore', profileType: 'IOS_APP_STORE' },
  ]

  // 1) import-create-profile-only raises a DuplicateProfileError -> records the
  //    IMPORT origin + surfaces the duplicates transiently.
  const d2Deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A }, createProfile: async () => { throw new DuplicateProfileError(dups) } })
  const d2 = await runIosEffect('import-create-profile-only', iosProgress(), d2Deps)
  assertEquals(d2.next, 'duplicate-profile-prompt', 'D2 routes to the shared duplicate prompt')
  assertEquals(d2.progress.duplicateProfileOrigin, 'import-create-profile-only', 'origin persisted as the import step')
  // The driver carries the persisted origin + the transient duplicate list forward.
  const progressWithOrigin = d2.progress
  const duplicates = d2.transient.duplicateProfiles

  // 2) duplicate-profile-prompt resolver: user confirms the deletion.
  const promptDeps = makeDeps({ carried: { confirmDeleteDuplicates: true, duplicateProfiles: duplicates } })
  const prompt = await runIosEffect('duplicate-profile-prompt', progressWithOrigin, promptDeps)
  assertEquals(prompt.next, 'deleting-duplicate-profiles', 'confirm advances to deletion')

  // 3) deleting-duplicate-profiles deletes each dup then routes BACK to the import
  //    origin (NOT the create-new creating-profile).
  const delDeps = makeDeps({ carried: { duplicateProfiles: duplicates } })
  const deleted = await runIosEffect('deleting-duplicate-profiles', progressWithOrigin, delDeps)
  assertEquals(deleted.next, 'import-create-profile-only', 'import origin loops back to D2, closing the dual-origin round-trip')
  assert(deleted.next !== 'creating-profile', 'an import user must NEVER be routed into the create-new creating-profile')
  const deletes = delDeps.__calls.filter(c => c.name === 'deleteProfile')
  assertEquals(deletes.length, 2, 'every duplicate profile is deleted')
  assertEquals(deletes[0].args[0], 'DUP1', 'first duplicate deleted')
  assertEquals(deletes[1].args[0], 'DUP2', 'second duplicate deleted')
})

// ─── HOSTILE-REVIEW MED: 'open-anyway' must not fabricate success ──────────────
//
// The old breadcrumb logged '🌐 Opened Apple Developer Portal — …' UNCONDITIONALLY
// (even when openExternal threw) and never told the user the URL. Contract now
// mirrors the verify-app sibling (ios/flow.ts verify-app 'open' branch): on
// success the line INCLUDES the url; on failure log the could-not-open fallback
// with the url instead of claiming success. Routing is unchanged either way.

// Match via RegExp (not String.includes with a URL literal) so CodeQL's URL-substring
// sanitization rule does not flag these log-message assertions as URL-validation sinks.
const PORTAL_PROFILES_URL_RE = /https:\/\/developer\.apple\.com\/account\/resources\/profiles\/list/

await test("portal resolver 'open-anyway' SUCCESS log includes the opened portal URL", async () => {
  const logs = []
  const deps = makeDeps({
    carried: { portalAction: 'open-anyway', noMatchReason: 'apple-other' },
    onLog: (msg, color) => logs.push({ msg, color }),
  })
  const res = await runIosEffect('import-portal-explanation', iosProgress(), deps)
  assertEquals(res.next, 'import-no-match-recovery', 'still bounces back to the recovery menu')
  const opened = logs.find(l => /Opened Apple Developer Portal/.test(l.msg))
  assert(opened, 'the success breadcrumb still fires when openExternal succeeded')
  assert(PORTAL_PROFILES_URL_RE.test(opened.msg), `the success line must include the URL that was opened (got: ${opened.msg})`)
})

await test("portal resolver 'open-anyway' FAILURE logs the could-not-open fallback with the URL — never fabricates success", async () => {
  const logs = []
  const deps = makeDeps({
    carried: { portalAction: 'open-anyway', noMatchReason: 'apple-other' },
    openExternal: async () => { throw new Error('no browser') },
    onLog: (msg, color) => logs.push({ msg, color }),
  })
  const res = await runIosEffect('import-portal-explanation', iosProgress(), deps)
  assertEquals(res.next, 'import-no-match-recovery', 'a failed portal-open still bounces back (recovery contract unchanged)')
  assert(!logs.some(l => /Opened Apple Developer Portal/.test(l.msg)), 'must NOT claim the portal was opened when openExternal failed')
  const warn = logs.find(l => /Could not open your browser/.test(l.msg))
  assert(warn, 'must log the could-not-open warning (verify-app sibling pattern)')
  assert(PORTAL_PROFILES_URL_RE.test(warn.msg), `the warning must tell the user WHERE to go (got: ${warn.msg})`)
  assertEquals(warn.color, 'yellow', 'the warning is yellow')
})

// ─── Summary ─────────────────────────────────────────────────────────────────────

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)

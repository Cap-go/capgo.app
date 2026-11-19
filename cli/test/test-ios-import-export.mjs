#!/usr/bin/env node
/**
 * iOS BATCH 7b — import export sub-flow spec (warning / exporting) +
 * pendingRecoveryAction wiring.
 *
 * Drives `iosViewForStep` / `applyIosInput` / `runIosEffect` for the three
 * export-tail steps with MOCKED IosEffectDeps (no fs, no network, no child
 * processes):
 *
 *   import-export-warning (choice + resolver, EPHEMERAL):
 *     view: a choice whose 'go' row names the chosen identity, plus back + exit.
 *     'go'                       -> import-exporting (PR #2458 removed the swiftc
 *                                   compile detour — the precompiled signed helper
 *                                   is resolved + verified in the export step)
 *     'back'                     -> import-pick-profile
 *     'exit' / no pick           -> error (the engine has no 'exit' step)
 *     reducer persists NOTHING.
 *
 *   import-exporting (effect, EPHEMERAL-dep):
 *     missing chosenIdentity OR chosenProfile -> error (the guard)
 *     exportP12FromKeychain throws            -> error
 *     success (on-disk profile)  -> saving-credentials; transient certData /
 *                                   profileData / teamId / importedP12Password;
 *                                   reads the .mobileprovision bytes off disk
 *     success (synthesized D2 profile, path='') -> uses the carried profileBase64
 *     RISK #2 / D-iOS-3: the export payload (certData incl. the p12 base64,
 *     profileData, teamId, importedP12Password) rides TRANSIENT ONLY — the effect
 *     PERSISTS NOTHING (no saveProgress, nothing on progress.json).
 *
 *   pendingRecoveryAction round-trip (verifying-key wiring):
 *     verifying-key + pendingRecoveryAction='import-create-profile-only'
 *       -> import-create-profile-only (the marker is CLEARED, not creating-cert)
 *     verifying-key + no pendingRecoveryAction
 *       -> creating-certificate (the normal create-new path is unchanged)
 *
 *   FULL import happy path:
 *     import-export-warning('go') -> import-exporting -> saving-credentials,
 *       threading the export transient forward, and NEVER persisting the export
 *       payload anywhere.
 *
 * Like test-ios-import-recovery.mjs, this file is the headless DRIVER: the
 * export-warning choice is EPHEMERAL-branching, so the driver records the user's
 * pick into deps.carried.exportWarningAction (+ chosenIdentity / chosenProfile)
 * and re-drives each step
 * through runIosEffect — the SAME mechanism the Ink TUI uses to mirror its React
 * state/refs. The engine is IO-FREE: every keychain / file touch is an
 * injected dep, and the exported cert/profile/passphrase NEVER hit progress.json.
 */
import { Buffer } from 'node:buffer'
import process from 'node:process'

const {
  runIosEffect,
  iosViewForStep,
  applyIosInput,
} = await import('../src/build/onboarding/ios/flow.ts')

console.log('🧪 iOS BATCH 7b — import export (warning / exporting) + pendingRecoveryAction\n')

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

const P8_BYTES = Buffer.from('-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----')

const IDENTITY_A = { sha1: 'a'.repeat(40), name: 'Apple Distribution: Acme (TEAMAAA)', type: 'distribution', teamName: 'Acme', teamId: 'TEAMAAA' }

// An on-disk DiscoveredProfile (path set) — import-exporting reads its bytes from disk.
const PROFILE_ON_DISK = {
  path: '/Users/me/Library/MobileDevice/Provisioning Profiles/abc.mobileprovision',
  uuid: 'PROFILE-UUID',
  name: 'Acme App Store',
  applicationIdentifier: 'TEAMAAA.com.example.app',
  bundleId: APP_ID,
  teamId: 'TEAMAAA',
  expirationDate: '2027-01-01T00:00:00.000Z',
  profileType: 'app_store',
  certificateSha1s: [IDENTITY_A.sha1],
}

// A synthesized Apple-API profile (path='') — import-exporting reads profileBase64
// straight off the structural cast instead of touching the filesystem (D2 path).
const PROFILE_SYNTHESIZED = {
  ...PROFILE_ON_DISK,
  path: '',
  uuid: 'SYNTH-UUID',
  profileBase64: 'U1lOVEgtUFJPRklMRS1CWVRFUw==',
}

// What deps.exportP12FromKeychain resolves to (the REAL macos-signing ExportedP12 shape).
const EXPORTED = { base64: 'UDEyLUJBU0U2NA==', passphrase: 'auto-generated-passphrase-xyz' }

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
 * Mocked IosEffectDeps. Keychain / file / verify touches are injected and
 * record their calls so the spec can assert which helper fired and with what
 * argument. `carried` is the driver-held transient — the spec threads the ephemeral
 * export-warning pick / chosen identity / chosen profile / .p8
 * bytes through it. `saveProgress` records every persist so the spec can prove the
 * export payload is NEVER written.
 */
function makeDeps(overrides = {}) {
  const calls = []

  const deps = {
    appId: APP_ID,

    exportP12FromKeychain: async (sha1) => { calls.push({ name: 'exportP12FromKeychain', args: [sha1] }); return { ...EXPORTED } },

    verifyApiKey: async (...a) => { calls.push({ name: 'verifyApiKey', args: a }); return { teamId: 'TEAMAAA' } },

    readFile: async (p) => { calls.push({ name: 'readFile', args: [p] }); return Buffer.from('RAW-MOBILEPROVISION-BYTES') },

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
// import-export-warning — VIEW + REDUCER
// ════════════════════════════════════════════════════════════════════════════════

console.log('🧪 import-export-warning VIEW + REDUCER\n')

await test("iosViewForStep('import-export-warning') is a choice: go (names the identity) + back + exit", async () => {
  const view = iosViewForStep('import-export-warning', iosProgress(), { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK })
  assertEquals(view.step, 'import-export-warning', 'view echoes the step')
  assertEquals(view.kind, 'choice', 'export warning is a choice')
  const values = (view.options ?? []).map(o => o.value)
  assert(values.includes('go'), 'offers the export-now action')
  assert(values.includes('back'), 'offers back to profile selection')
  assert(values.includes('exit'), 'offers exit')
  const go = view.options.find(o => o.value === 'go')
  assert(go.label.includes(IDENTITY_A.name), "the 'go' row names the chosen identity (app.tsx:3767)")
})

await test("import-export-warning view title warns about the macOS Keychain permission dialog", async () => {
  const view = iosViewForStep('import-export-warning', iosProgress(), { chosenIdentity: IDENTITY_A })
  assert(/private key|Keychain|permission/i.test(view.title ?? ''), 'title heads-up names the Keychain permission prompt')
})

await test('import-export-warning reducer persists NOTHING (the pick is ephemeral)', async () => {
  const before = iosProgress()
  for (const value of ['go', 'back', 'exit']) {
    const after = applyIosInput('import-export-warning', before, { step: 'import-export-warning', value })
    assertEquals(JSON.stringify(after), JSON.stringify(before), `'${value}' writes nothing to progress`)
  }
})

// ════════════════════════════════════════════════════════════════════════════════
// import-export-warning — RESOLVER (go + back + exit)
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 import-export-warning RESOLVER (go, back, exit)\n')

// PR #2458 replaced the runtime swiftc compile with precompiled signed helper
// packages, removing the import-compiling-helper step: 'go' now routes straight
// to import-exporting unconditionally.
await test("export-warning resolver 'go' -> import-exporting", async () => {
  const deps = makeDeps({ carried: { exportWarningAction: 'go' } })
  const res = await runIosEffect('import-export-warning', iosProgress(), deps)
  assertEquals(res.next, 'import-exporting', "'go' goes straight to export (no compile detour)")
})

await test("export-warning resolver 'back' -> import-pick-profile", async () => {
  const res = await runIosEffect('import-export-warning', iosProgress(), makeDeps({ carried: { exportWarningAction: 'back' } }))
  assertEquals(res.next, 'import-pick-profile', "'back' returns to profile selection")
})

await test("export-warning resolver 'exit' -> error (no engine 'exit' step); no pick -> error", async () => {
  const exitRes = await runIosEffect('import-export-warning', iosProgress(), makeDeps({ carried: { exportWarningAction: 'exit' } }))
  assertEquals(exitRes.next, 'error', "'exit' routes to the error/exit sink")
  const noPick = await runIosEffect('import-export-warning', iosProgress(), makeDeps({ carried: {} }))
  assertEquals(noPick.next, 'error', 'no pick also routes to the error/exit sink')
})

await test('export-warning resolver persists NOTHING', async () => {
  const deps = makeDeps({ carried: { exportWarningAction: 'go' } })
  await runIosEffect('import-export-warning', iosProgress(), deps)
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'pure routing — nothing persisted')
})

// ════════════════════════════════════════════════════════════════════════════════
// import-exporting — EFFECT (guard + keychain export + transient-only payload)
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 import-exporting (effect, EPHEMERAL-dep, NO secrets on disk)\n')

await test('import-exporting (profile with carried profileBase64) does not re-read disk if the file is swapped', async () => {
  const atValidation = Buffer.from('BYTES-AT-VALIDATION-TIME')
  const depsPick = makeDeps({
    carried: { chosenIdentity: IDENTITY_A, importMatches: [{ identity: IDENTITY_A, profiles: [] }], noMatchReason: 'no-profile-on-disk' },
    readMcpMobileprovision: async () => atValidation,
    openProfilePicker: async () => './project/creds/profile.mobileprovision',
    parseMobileprovisionDetailed: () => ({
      uuid: 'IMPORTED-UUID',
      name: 'P',
      applicationIdentifier: 'TEAMAAA.com.example.app',
      bundleId: APP_ID,
      expirationDate: '2027-01-01T00:00:00.000Z',
      profileType: 'app_store',
      certificateSha1s: [IDENTITY_A.sha1],
      profileEntitlements: {},
    }),
  })
  const picked = await runIosEffect('import-provide-profile-path', iosProgress(), depsPick)
  const chosenProfile = picked.transient.chosenProfile
  const depsExport = makeDeps({
    carried: { chosenIdentity: IDENTITY_A, chosenProfile },
    readFile: async () => {
      throw new Error('import-exporting must not re-read a profile path when profileBase64 is carried')
    },
  })
  const res = await runIosEffect('import-exporting', iosProgress(), depsExport)
  assertEquals(res.transient.profileData.profileBase64, atValidation.toString('base64'), 'export uses bytes captured at validation, not a later disk read')
})

await test('import-exporting (on-disk profile) -> saving-credentials; transient certData/profileData/teamId/importedP12Password; reads bytes off disk', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK } })
  const res = await runIosEffect('import-exporting', iosProgress(), deps)
  assertEquals(res.next, 'saving-credentials', 'a successful export hands off to the shared saving-credentials tail')

  assert(res.transient?.certData, 'certData rides transient')
  assertEquals(res.transient.certData.p12Base64, EXPORTED.base64, 'the exported p12 base64 becomes certData.p12Base64')
  assertEquals(res.transient.certData.certificateId, '', 'an imported cert has no Apple-API certificate id')
  assertEquals(res.transient.certData.expirationDate, PROFILE_ON_DISK.expirationDate, 'cert expiry comes from the chosen profile')
  assertEquals(res.transient.certData.teamId, IDENTITY_A.teamId, 'cert teamId comes from the chosen identity')

  assert(res.transient?.profileData, 'profileData rides transient')
  assertEquals(res.transient.profileData.profileId, PROFILE_ON_DISK.uuid, 'profileData.profileId is the chosen profile uuid')
  assertEquals(res.transient.profileData.profileName, PROFILE_ON_DISK.name, 'profileData.profileName is the chosen profile name')
  // The on-disk path is read + base64-encoded (RAW-MOBILEPROVISION-BYTES -> base64).
  assertEquals(res.transient.profileData.profileBase64, Buffer.from('RAW-MOBILEPROVISION-BYTES').toString('base64'), 'on-disk profile bytes are read + base64-encoded')

  assertEquals(res.transient.teamId, IDENTITY_A.teamId, 'the resolved teamId rides transient')
  assertEquals(res.transient.importedP12Password, EXPORTED.passphrase, 'the keychain export passphrase rides transient as importedP12Password')

  assert(deps.__calls.some(c => c.name === 'exportP12FromKeychain'), 'exported the cert+key from the Keychain')
  assertEquals(deps.__calls.find(c => c.name === 'exportP12FromKeychain').args[0], IDENTITY_A.sha1, 'exportP12FromKeychain receives the chosen identity SHA-1')
  assert(deps.__calls.some(c => c.name === 'readFile'), 'read the on-disk .mobileprovision bytes')
})

await test('import-exporting (synthesized D2 profile, path empty) -> uses carried profileBase64, NO filesystem read', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_SYNTHESIZED } })
  const res = await runIosEffect('import-exporting', iosProgress(), deps)
  assertEquals(res.next, 'saving-credentials', 'a synthesized profile still exports + saves')
  assertEquals(res.transient.profileData.profileBase64, PROFILE_SYNTHESIZED.profileBase64, 'a synthesized profile reuses its carried profileBase64')
  assert(!deps.__calls.some(c => c.name === 'readFile'), 'a synthesized profile (path="") must NOT touch the filesystem')
})

await test('import-exporting GUARD: missing chosenIdentity -> error (no export)', async () => {
  const deps = makeDeps({ carried: { chosenProfile: PROFILE_ON_DISK } })
  const res = await runIosEffect('import-exporting', iosProgress(), deps)
  assertEquals(res.next, 'error', 'no identity is an internal error')
  assert(!deps.__calls.some(c => c.name === 'exportP12FromKeychain'), 'the Keychain is NOT touched without an identity')
})

await test('import-exporting GUARD: missing chosenProfile -> error (no export)', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A } })
  const res = await runIosEffect('import-exporting', iosProgress(), deps)
  assertEquals(res.next, 'error', 'no profile is an internal error')
  assert(!deps.__calls.some(c => c.name === 'exportP12FromKeychain'), 'the Keychain is NOT touched without a profile')
})

await test('import-exporting (exportP12FromKeychain throws) -> error', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK }, exportP12FromKeychain: async () => { throw new Error('keychain-export FAILED') } })
  const res = await runIosEffect('import-exporting', iosProgress(), deps)
  assertEquals(res.next, 'error', 'a keychain export failure routes to error')
})

await test('RISK #2 / D-iOS-3: import-exporting PERSISTS NOTHING (no saveProgress; no export payload on progress.json)', async () => {
  const deps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK } })
  const res = await runIosEffect('import-exporting', iosProgress(), deps)
  assert(!deps.__calls.some(c => c.name === 'saveProgress'), 'the export effect must NOT call saveProgress')
  // The returned progress must carry NONE of the export payload — it rides transient only.
  const persisted = JSON.stringify(res.progress)
  assert(!persisted.includes(EXPORTED.base64), 'the p12 base64 must NEVER be written to progress')
  assert(!persisted.includes(EXPORTED.passphrase), 'the keychain passphrase must NEVER be written to progress')
  assert(!persisted.includes('certificateCreated'), 'no certificateCreated marker is persisted on the import path')
  assert(!persisted.includes('profileCreated'), 'no profileCreated marker is persisted on the import path')
})

// ════════════════════════════════════════════════════════════════════════════════
// pendingRecoveryAction round-trip — verifying-key wiring
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 pendingRecoveryAction round-trip (verifying-key -> import-create-profile-only when set)\n')

await test("verifying-key + pendingRecoveryAction='import-create-profile-only' -> import-create-profile-only; CLEARS the marker", async () => {
  const deps = makeDeps({ carried: { p8Content: P8_BYTES } })
  const progress = iosProgress({ p8Path: '/Users/me/AuthKey_ABC123.p8', keyId: 'KEY1', issuerId: 'ISS1', pendingRecoveryAction: 'import-create-profile-only' })
  const res = await runIosEffect('verifying-key', progress, deps)
  assertEquals(res.next, 'import-create-profile-only', 'a pending recovery action resumes the deferred D2 step, NOT create-new cert')
  assert(res.next !== 'creating-certificate', 'an import recovery user must NEVER fall into the create-new cert path')
  assert(res.progress.pendingRecoveryAction === undefined, 'the pendingRecoveryAction marker is CLEARED after it fires (no re-fire)')
  assert(res.progress.completedSteps.apiKeyVerified, 'still persists the apiKeyVerified marker')
  // The CLEARED progress must be what was persisted.
  const save = deps.__calls.find(c => c.name === 'saveProgress')
  assert(save, 'persists the verified key')
  assert(save.args[1].pendingRecoveryAction === undefined, 'the PERSISTED progress also clears pendingRecoveryAction')
})

await test('verifying-key WITHOUT pendingRecoveryAction -> verify-app (the create-new path detours through the App Store gate, PR #2397)', async () => {
  const deps = makeDeps({ carried: { p8Content: P8_BYTES } })
  const progress = iosProgress({ setupMethod: 'create-new', p8Path: '/Users/me/AuthKey_ABC123.p8', keyId: 'KEY1', issuerId: 'ISS1' })
  const res = await runIosEffect('verifying-key', progress, deps)
  assertEquals(res.next, 'verify-app', 'no pending action -> the create-new backbone detours through verify-app (falls back to creating-certificate)')
  assert(res.progress.completedSteps.apiKeyVerified, 'still persists the apiKeyVerified marker')
})

await test("verifying-key ignores an UNKNOWN pendingRecoveryAction value -> verify-app (only the import D2 marker reroutes)", async () => {
  const deps = makeDeps({ carried: { p8Content: P8_BYTES } })
  const progress = iosProgress({ p8Path: '/Users/me/AuthKey_ABC123.p8', keyId: 'KEY1', issuerId: 'ISS1', pendingRecoveryAction: 'something-else' })
  const res = await runIosEffect('verifying-key', progress, deps)
  assertEquals(res.next, 'verify-app', 'an unrecognised marker does not reroute to D2 (import app_store continues into the verify-app gate)')
  assertEquals(res.transient.pendingVerifyNext, 'import-pick-identity', 'the import continuation rides transient for the gate to use')
})

// ════════════════════════════════════════════════════════════════════════════════
// FULL import happy path — warning -> exporting -> saving-credentials
// ════════════════════════════════════════════════════════════════════════════════

console.log('\n🧪 FULL import happy path (warning -> exporting -> saving-credentials)\n')

await test('DRIVER: warning(go) -> import-exporting -> saving-credentials; export rides transient, NOTHING persisted', async () => {
  const progress = iosProgress()

  // 1) export warning: user picks 'go' -> straight to export (PR #2458 removed
  //    the swiftc compile detour).
  const warnDeps = makeDeps({ carried: { exportWarningAction: 'go' } })
  const warn = await runIosEffect('import-export-warning', progress, warnDeps)
  assertEquals(warn.next, 'import-exporting', "'go' goes straight to export")

  // 2) import-exporting: exports + synthesizes the cert/profile records (transient only).
  const expDeps = makeDeps({ carried: { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK } })
  const exp = await runIosEffect('import-exporting', progress, expDeps)
  assertEquals(exp.next, 'saving-credentials', 'export hands off to the shared saving-credentials tail')
  assert(exp.transient.certData && exp.transient.profileData && exp.transient.importedP12Password, 'the full export payload rides transient into saving-credentials')

  // No persistence happened anywhere in the export sub-flow.
  assert(!warnDeps.__calls.some(c => c.name === 'saveProgress'), 'the warning step persists nothing')
  assert(!expDeps.__calls.some(c => c.name === 'saveProgress'), 'the export step persists nothing')
})

// ─── Summary ─────────────────────────────────────────────────────────────────────

console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)

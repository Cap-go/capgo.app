#!/usr/bin/env node
/**
 * iOS choice/input ROUTING PARITY baseline (the swap safety net).
 *
 * Sibling of test-android-tail-routing.mjs, extended to the iOS create-new + .p8
 * chain + the import fork. The bespoke iOS TUI (src/build/onboarding/ui/app.tsx)
 * currently renders each choice/input step with an explicit `setStep(next)`
 * decision in its onChoose/onChange/onSubmit. That duplicates the engine's
 * routing. The TUI-wiring swap (Slices B + C) moves the next-step decision onto
 * the engine, derived in one of TWO ways depending on the step's nature:
 *
 *   PERSISTED-DRIVEN steps — the input records a field; the next step is a pure
 *   function of persisted progress:
 *       applyIosInput(step, progress, input)  →  getIosResumeStep(newProgress)
 *
 *   EPHEMERAL-BRANCHING steps — the pick is NEVER persisted (it lives only in the
 *   driver's `carried` transient); the next step is derived by re-driving the step
 *   as a RESOLVER effect with the pick recorded into carried:
 *       carried.<action> = pick ; runIosEffect(step, progress, deps).next
 *
 * For EACH choice/input step + EACH of its options (including the escape hatches —
 * setup-method import fork, api-key picker/manual fork,
 * cert-limit __exit__, duplicate-profile exit, import-distribution __cancel__,
 * import-pick-identity __cancel__, import-pick-profile __back__, the 5-way
 * no-match-recovery hub, import-portal-explanation, import-export-warning exit)
 * this test drives that exact pipeline and records the engine-derived next-step
 * alongside the bespoke `setStep` target read VERBATIM from app.tsx (with a line
 * reference).
 *
 * Two classes of result are asserted, and the distinction IS the deliverable:
 *
 *   MATCH   — the engine-derived next step EQUALS the bespoke setStep target.
 *             Safe to swap to engine-derived routing as-is: the persisted fields
 *             the reducer writes (setupMethod / importDistribution / p8Path /
 *             keyId / issuerId) — or, for an
 *             ephemeral step, the carried pick threaded into the resolver — are
 *             enough to reproduce the in-session transition.
 *
 *   DIVERGE — the engine-derived next step does NOT equal the bespoke setStep.
 *             getIosResumeStep is a RESUME router that collapses onto the nearest
 *             persisted-state-derivable re-entry point (NEVER an ephemeral picker
 *             — those re-enter via a fresh import-scanning) and GUARDS against
 *             re-firing a side effect. The resolver effects route a non-pick / exit
 *             escape onto 'error' (the driver's exitOnboarding sink). For these the
 *             next-step is NOT derivable as the bespoke target — it is either:
 *               • navigation-only into a sub-screen / file-picker effect that
 *                 records no field (api-key picker/manual fork),
 *               • an ephemeral picker that resume re-reaches via a re-scan
 *                 (import-distribution ad_hoc → import-pick-identity), or
 *               • an exit escape the resolver maps to 'error' (cert-limit __exit__,
 *                 duplicate exit, export-warning exit).
 *             The routing swap MUST keep these driver-routed (navigation-only) OR
 *             resolve them via the resolver-effect pattern. They are recorded here
 *             with their precise reason so the swap can't silently regress them.
 *
 * No fs / network / child processes: applyIosInput + getIosResumeStep are pure;
 * the resolver effects exercised here are PURE routing (no real IO — any optional
 * IO dep like openExternal / saveProgress is harmlessly omitted or no-op'd).
 * Progress fixtures mirror the persisted markers present at the point in the live
 * flow where each choice/input is shown.
 */
import { Buffer } from 'node:buffer'
import process from 'node:process'

const { applyIosInput, runIosEffect } = await import('../src/build/onboarding/ios/flow.ts')
const { getIosResumeStep } = await import('../src/build/onboarding/ios/progress.ts')

console.log('🧪 iOS choice/input ROUTING PARITY (applyIosInput → getIosResumeStep / resolver effect)\n')

let testsPassed = 0
let testsFailed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    testsPassed++
  }
  catch (err) {
    console.error(`❌ ${name}`)
    console.error(`   ${err instanceof Error ? err.message : String(err)}`)
    testsFailed++
  }
}

async function testAsync(name, fn) {
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

function assertEquals(actual, expected, message) {
  if (actual !== expected)
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const APP_ID = 'com.example.app'

// ─── Fixtures (mirror test-ios-e2e.mjs shapes) ──────────────────────────────────

const P8_BYTES = Buffer.from('-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----')

const IDENTITY_A = { sha1: 'a'.repeat(40), name: 'Apple Distribution: Acme (TEAMAAA)', type: 'distribution', teamName: 'Acme', teamId: 'TEAMAAA' }

// On-disk ad_hoc profile that matches IDENTITY_A + this app.
const PROFILE_ON_DISK = {
  path: '/Users/me/Library/MobileDevice/Provisioning Profiles/A.mobileprovision',
  uuid: 'ONDISK-UUID',
  name: 'Acme Ad Hoc',
  applicationIdentifier: `TEAMAAA.${APP_ID}`,
  bundleId: APP_ID,
  teamId: 'TEAMAAA',
  expirationDate: '2027-01-01T00:00:00.000Z',
  profileType: 'ad_hoc',
  certificateSha1s: [IDENTITY_A.sha1],
}

const MATCH_A_WITH_PROFILE = { identity: IDENTITY_A, profiles: [PROFILE_ON_DISK] }
const MATCH_A_NO_PROFILE = { identity: IDENTITY_A, profiles: [] }

const CERT_TO_REVOKE = { id: 'APPLE-CERT-7', name: 'Apple Distribution: Acme', expirationDate: '2026-12-01T00:00:00.000Z' }
const DUPLICATE_PROFILES = [{ id: 'PROF-DUP-1', name: 'Capgo com.example.app AppStore', uuid: 'DUP-UUID' }]

// ─── progress factory ───────────────────────────────────────────────────────────

function iosProgress(overrides = {}) {
  const { completedSteps: completedOverrides, ...rest } = overrides
  return {
    platform: 'ios',
    appId: APP_ID,
    startedAt: '2026-06-03T00:00:00.000Z',
    ...rest,
    completedSteps: { ...completedOverrides },
  }
}

// ─── Persisted-driven parity harness ────────────────────────────────────────────
//
// applyIosInput records (or routes) state; getIosResumeStep re-derives the next
// step from persisted progress.
//
//   MATCH:   bespoke === engine  → the assertion proves they agree.
//   DIVERGE: bespoke !== engine  → the assertion pins the engine's ACTUAL resume
//            value AND verifies it really differs from the bespoke target, so a
//            future change that "fixes" routing to the bespoke value (without the
//            field/effect plumbing) trips this test.

function parity({ step, progress, input, bespoke, engine, klass }) {
  const next = getIosResumeStep(applyIosInput(step, progress, input))
  assertEquals(next, engine, `${step}: engine-derived next expected ${engine}, got ${next}`)
  if (klass === 'MATCH')
    assertEquals(next, bespoke, `${step}: MATCH case must equal bespoke setStep ${bespoke}, got ${next}`)
  else if (next === bespoke)
    throw new Error(`${step}: declared DIVERGE but engine (${next}) equals bespoke (${bespoke}) — reclassify as MATCH`)
}

// ─── Ephemeral-branching parity harness ─────────────────────────────────────────
//
// The pick is NEVER persisted; applyIosInput records nothing. The driver stashes
// the pick into carried.<action> and re-drives the step as a RESOLVER effect — the
// next step is runIosEffect(step, progress, deps).next. Same MATCH/DIVERGE split.

async function parityEffect({ step, progress, carried, deps: depsOverrides, bespoke, engine, klass }) {
  const deps = { appId: APP_ID, carried, onLog: () => {}, onStatus: () => {}, ...depsOverrides }
  // The reducer for an ephemeral step is a no-op — assert that so the swap can't
  // accidentally start persisting the ephemeral pick.
  const reduced = applyIosInput(step, progress, { step, value: 'noop' })
  assertEquals(JSON.stringify(reduced), JSON.stringify(progress), `${step}: ephemeral reducer must be a no-op (persisted nothing)`)
  const res = await runIosEffect(step, progress, deps)
  const next = res.next
  assertEquals(next, engine, `${step}: resolver-derived next expected ${engine}, got ${next}`)
  if (klass === 'MATCH')
    assertEquals(next, bespoke, `${step}: MATCH case must equal bespoke setStep ${bespoke}, got ${next}`)
  else if (next === bespoke)
    throw new Error(`${step}: declared DIVERGE but resolver (${next}) equals bespoke (${bespoke}) — reclassify as MATCH`)
}

// ════════════════════════════════════════════════════════════════════════════
// setup-method-select  (app.tsx L3081-3103) — the macOS create-vs-import fork
// ════════════════════════════════════════════════════════════════════════════
// Persists setupMethod. 'create' → getResumeStep (create-new, no .p8) lands on
// api-key-instructions (MATCH the bespoke). 'import' → the bespoke jumps STRAIGHT
// to import-scanning (the silent discovery); the engine resume, with no
// importDistribution yet, collapses onto the import-distribution-mode fork — the
// driver runs import-scanning as a navigation gate, NOT a resume target.
test("setup-method-select · create → bespoke 'api-key-instructions' [MATCH]", () => {
  parity({
    step: 'setup-method-select',
    progress: iosProgress(),
    input: { step: 'setup-method-select', value: 'create' },
    bespoke: 'api-key-instructions',
    engine: 'api-key-instructions',
    klass: 'MATCH',
  })
})
test("setup-method-select · import → bespoke 'import-scanning' [DIVERGE: bespoke jumps to silent scan; resume → distribution fork]", () => {
  parity({
    step: 'setup-method-select',
    progress: iosProgress(),
    input: { step: 'setup-method-select', value: 'import' },
    bespoke: 'import-scanning',
    engine: 'import-distribution-mode',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// api-key-instructions  (app.tsx L3850-3857) — the .p8-method navigation fork
// ════════════════════════════════════════════════════════════════════════════
// Navigation-only choice — applyIosInput records NOTHING. The driver routes on the
// value: 'picker' → the p8-method-select file-picker effect, 'manual' →
// input-p8-path. getIosResumeStep on the unchanged create-new progress re-lands on
// api-key-instructions itself (no .p8 inputs persisted), so BOTH forks DIVERGE: the
// next-step is a pure driver navigation, not a persisted-state derivation.
const createNewNoP8 = () => iosProgress({ setupMethod: 'create-new' })
test("api-key-instructions · picker → bespoke 'p8-method-select' [DIVERGE: navigation-only; resume re-shows the choice]", () => {
  parity({
    step: 'api-key-instructions',
    progress: createNewNoP8(),
    input: { step: 'api-key-instructions', value: 'picker' },
    bespoke: 'p8-method-select',
    engine: 'api-key-instructions',
    klass: 'DIVERGE',
  })
})
test("api-key-instructions · manual → bespoke 'input-p8-path' [DIVERGE: navigation-only; resume re-shows the choice]", () => {
  parity({
    step: 'api-key-instructions',
    progress: createNewNoP8(),
    input: { step: 'api-key-instructions', value: 'manual' },
    bespoke: 'input-p8-path',
    engine: 'api-key-instructions',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// input-p8-path  (app.tsx L3886-3904) — manual .p8 path entry
// ════════════════════════════════════════════════════════════════════════════
// Persists p8Path (the TUI ALSO reads/validates the file + extracts keyId — that's
// the effect boundary; the reducer only records the path). With p8Path set and no
// keyId, getResumeStep (create-new) lands on input-key-id (MATCH). An empty
// submission is a no-op (the reducer's `if (!p8Path) return progress` guard mirrors
// the TUI's catch/handleError), so resume re-lands on api-key-instructions (the
// create-new entry with no .p8) — the bespoke instead stays on input-p8-path.
test("input-p8-path · path → bespoke 'input-key-id' [MATCH]", () => {
  parity({
    step: 'input-p8-path',
    progress: createNewNoP8(),
    input: { step: 'input-p8-path', value: '/Users/me/AuthKey_ABC123.p8' },
    bespoke: 'input-key-id',
    engine: 'input-key-id',
    klass: 'MATCH',
  })
})
// REGRESSION GUARD (input-p8-path routing loads FULL progress): the TUI handlers
// route off `loadProgress(appId)` merged with {p8Path, keyId:undefined} so
// persisted fields survive into the routing base. Post-#2397 the confirm-app-id
// gate is GONE: a stale pendingAppIdNext (from an older CLI run) must be IGNORED
// by getIosResumeStep — routing lands on the .p8 chain's input-key-id, never on
// a step that no longer renders.
const createNewPendingAppId = () => iosProgress({ setupMethod: 'create-new', pendingAppIdNext: 'input-key-id' })
test("input-p8-path · path WITH stale pendingAppIdNext (!appIdConfirmed) → 'input-key-id' [MATCH: stale gate fields ignored]", () => {
  parity({
    step: 'input-p8-path',
    progress: createNewPendingAppId(),
    input: { step: 'input-p8-path', value: '/Users/me/AuthKey_ABC123.p8' },
    bespoke: 'input-key-id',
    engine: 'input-key-id',
    klass: 'MATCH',
  })
})
test("input-p8-path · path WITH stale pendingAppIdNext + appIdConfirmed → 'input-key-id' [MATCH]", () => {
  parity({
    step: 'input-p8-path',
    progress: iosProgress({ setupMethod: 'create-new', pendingAppIdNext: 'input-key-id', appIdConfirmed: true }),
    input: { step: 'input-p8-path', value: '/Users/me/AuthKey_ABC123.p8' },
    // Both stale fields are ignored post-#2397 — same routing as a clean file.
    bespoke: 'input-key-id',
    engine: 'input-key-id',
    klass: 'MATCH',
  })
})
test("input-p8-path · empty → bespoke stays 'input-p8-path' [DIVERGE: no-op input; resume → api-key-instructions]", () => {
  parity({
    step: 'input-p8-path',
    progress: createNewNoP8(),
    input: { step: 'input-p8-path', value: '   ' },
    bespoke: 'input-p8-path',
    engine: 'api-key-instructions',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// input-key-id  (app.tsx L3913-3924) — ASC Key ID entry
// ════════════════════════════════════════════════════════════════════════════
// Persists keyId. With p8Path + keyId set, getResumeStep lands on input-issuer-id
// (MATCH). The empty-submission-with-detected-default case ALSO matches: the
// AuthKey_<id>.p8 filename re-derives the default, so keyId is recorded and resume
// advances. An empty submission with NO detectable default is a no-op → resume
// re-lands on input-key-id (the p8Path-only resume target), matching the bespoke's
// `if (!finalKeyId) return` re-show.
const p8PathOnly = () => iosProgress({ setupMethod: 'create-new', p8Path: '/Users/me/AuthKey_ABC123.p8' })
const p8PathNoKeyHint = () => iosProgress({ setupMethod: 'create-new', p8Path: '/Users/me/key.p8' })
test("input-key-id · value → bespoke 'input-issuer-id' [MATCH]", () => {
  parity({
    step: 'input-key-id',
    progress: p8PathNoKeyHint(),
    input: { step: 'input-key-id', value: 'KEYID123' },
    bespoke: 'input-issuer-id',
    engine: 'input-issuer-id',
    klass: 'MATCH',
  })
})
test("input-key-id · empty (filename default) → bespoke 'input-issuer-id' [MATCH]", () => {
  parity({
    step: 'input-key-id',
    progress: p8PathOnly(),
    input: { step: 'input-key-id', value: '' },
    bespoke: 'input-issuer-id',
    engine: 'input-issuer-id',
    klass: 'MATCH',
  })
})
test("input-key-id · empty (no default) → bespoke stays 'input-key-id' [MATCH: no-op input; resume re-shows it]", () => {
  parity({
    step: 'input-key-id',
    progress: p8PathNoKeyHint(),
    input: { step: 'input-key-id', value: '' },
    bespoke: 'input-key-id',
    engine: 'input-key-id',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// input-issuer-id  (app.tsx L3932-3939) — ASC Issuer ID entry
// ════════════════════════════════════════════════════════════════════════════
// Persists issuerId. With p8Path + keyId + issuerId all set, getResumeStep lands on
// verifying-key (MATCH). An empty submission is a no-op → resume re-lands on
// input-issuer-id (the p8Path+keyId resume target), matching the bespoke re-show.
const p8AndKey = () => iosProgress({ setupMethod: 'create-new', p8Path: '/Users/me/key.p8', keyId: 'KEYID123' })
test("input-issuer-id · value → bespoke 'verifying-key' [MATCH]", () => {
  parity({
    step: 'input-issuer-id',
    progress: p8AndKey(),
    input: { step: 'input-issuer-id', value: 'ISSUER-UUID' },
    bespoke: 'verifying-key',
    engine: 'verifying-key',
    klass: 'MATCH',
  })
})
test("input-issuer-id · empty → bespoke stays 'input-issuer-id' [MATCH: no-op input; resume re-shows it]", () => {
  parity({
    step: 'input-issuer-id',
    progress: p8AndKey(),
    input: { step: 'input-issuer-id', value: '  ' },
    bespoke: 'input-issuer-id',
    engine: 'input-issuer-id',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// import-distribution-mode  (app.tsx L3229-3281) — the import sub-flow's 1st fork
// ════════════════════════════════════════════════════════════════════════════
// Persists setupMethod + importDistribution (or, on __cancel__, switches to
// create-new and CLEARS importDistribution). The bespoke routes via
// getImportEntryStep:
//   - app_store + no .p8 → api-key-instructions (MATCH: getResumeStep on the
//     persisted import-existing/app_store progress lands there too).
//   - ad_hoc → straight to the import-pick-identity picker; the engine resume
//     collapses onto import-scanning (the ephemeral picker is NEVER a resume
//     target — re-reached via a re-scan) → DIVERGE.
//   - __cancel__ → switch to create-new (importDistribution cleared) →
//     api-key-instructions (MATCH).
test("import-distribution-mode · app_store → bespoke 'api-key-instructions' [MATCH]", () => {
  parity({
    step: 'import-distribution-mode',
    progress: iosProgress({ setupMethod: 'import-existing' }),
    input: { step: 'import-distribution-mode', value: 'app_store' },
    bespoke: 'api-key-instructions',
    engine: 'api-key-instructions',
    klass: 'MATCH',
  })
})
test("import-distribution-mode · ad_hoc → bespoke 'import-pick-identity' [DIVERGE: ephemeral picker; resume → import-scanning re-scan]", () => {
  parity({
    step: 'import-distribution-mode',
    progress: iosProgress({ setupMethod: 'import-existing' }),
    input: { step: 'import-distribution-mode', value: 'ad_hoc' },
    bespoke: 'import-pick-identity',
    engine: 'import-scanning',
    klass: 'DIVERGE',
  })
})
test("import-distribution-mode · __cancel__ → bespoke 'api-key-instructions' (switch to create-new) [MATCH]", () => {
  parity({
    step: 'import-distribution-mode',
    // A stale ad_hoc choice must NOT leak back into the create-new routing —
    // the reducer drops importDistribution.
    progress: iosProgress({ setupMethod: 'import-existing', importDistribution: 'ad_hoc' }),
    input: { step: 'import-distribution-mode', value: '__cancel__' },
    bespoke: 'api-key-instructions',
    engine: 'api-key-instructions',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// cert-limit-prompt  (app.tsx L3967-3976) — pick a cert to revoke OR exit
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL-branching. The picked cert rides carried.certToRevoke; the resolver
// returns revoking-certificate (MATCH the bespoke). The '__exit__' escape records
// no cert → the resolver routes to 'error' (the driver's exitOnboarding sink) →
// DIVERGE (the bespoke calls exitOnboarding, which the engine models as 'error').
const certLimitProgress = () => iosProgress({ setupMethod: 'create-new', completedSteps: { apiKeyVerified: { keyId: 'K', issuerId: 'I' } } })
await testAsync("cert-limit-prompt · pick cert → bespoke 'revoking-certificate' [MATCH]", async () => {
  await parityEffect({
    step: 'cert-limit-prompt',
    progress: certLimitProgress(),
    carried: { certToRevoke: CERT_TO_REVOKE },
    bespoke: 'revoking-certificate',
    engine: 'revoking-certificate',
    klass: 'MATCH',
  })
})
await testAsync("cert-limit-prompt · __exit__ → bespoke exitOnboarding [DIVERGE: exit escape → resolver 'error']", async () => {
  await parityEffect({
    step: 'cert-limit-prompt',
    progress: certLimitProgress(),
    carried: {}, // no certToRevoke recorded → the user exited
    bespoke: 'exit',
    engine: 'error',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// duplicate-profile-prompt  (app.tsx L3991-3998) — delete duplicates OR exit
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL-branching. delete → carried.confirmDeleteDuplicates=true → the
// resolver returns deleting-duplicate-profiles (MATCH). exit → no confirm →
// 'error' (DIVERGE: the bespoke exitOnboarding).
const dupProgress = () => iosProgress({ setupMethod: 'create-new', duplicateProfileOrigin: 'creating-profile', completedSteps: { apiKeyVerified: { keyId: 'K', issuerId: 'I' }, certificateCreated: { certificateId: 'C', expirationDate: '2027-01-01', teamId: 'T', p12Base64: 'p' } } })
await testAsync("duplicate-profile-prompt · delete → bespoke 'deleting-duplicate-profiles' [MATCH]", async () => {
  await parityEffect({
    step: 'duplicate-profile-prompt',
    progress: dupProgress(),
    carried: { confirmDeleteDuplicates: true, duplicateProfiles: DUPLICATE_PROFILES },
    bespoke: 'deleting-duplicate-profiles',
    engine: 'deleting-duplicate-profiles',
    klass: 'MATCH',
  })
})
await testAsync("duplicate-profile-prompt · exit → bespoke exitOnboarding [DIVERGE: exit escape → resolver 'error']", async () => {
  await parityEffect({
    step: 'duplicate-profile-prompt',
    progress: dupProgress(),
    carried: { confirmDeleteDuplicates: false },
    bespoke: 'exit',
    engine: 'error',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// import-pick-identity  (app.tsx L3320-3355) — pick a signing identity (3-way + cancel)
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL-branching. The picked identity rides carried.chosenIdentity; the
// resolver reproduces the TUI's three-way routing (+ the __cancel__ escape). ALL
// four outcomes MATCH the bespoke (the engine resolver mirrors onPick exactly):
//   - usable on-disk profile for this app+distribution → import-pick-profile.
//   - no usable on-disk + an ASC key available → import-checking-apple-cert.
//   - no usable on-disk + no ASC key → import-no-match-recovery.
//   - __cancel__ (no chosenIdentity recorded) → api-key-instructions (switch to
//     create-new; the driver clears setupMethod/importDistribution before re-drive).
const adHocImport = () => iosProgress({ setupMethod: 'import-existing', importDistribution: 'ad_hoc' })
await testAsync("import-pick-identity · usable profile → bespoke 'import-pick-profile' [MATCH]", async () => {
  await parityEffect({
    step: 'import-pick-identity',
    progress: adHocImport(),
    carried: { chosenIdentity: IDENTITY_A, importMatches: [MATCH_A_WITH_PROFILE] },
    bespoke: 'import-pick-profile',
    engine: 'import-pick-profile',
    klass: 'MATCH',
  })
})
await testAsync("import-pick-identity · no on-disk + ASC key → bespoke 'import-checking-apple-cert' [MATCH]", async () => {
  await parityEffect({
    step: 'import-pick-identity',
    progress: adHocImport(),
    carried: { chosenIdentity: IDENTITY_A, importMatches: [MATCH_A_NO_PROFILE], p8Content: P8_BYTES },
    bespoke: 'import-checking-apple-cert',
    engine: 'import-checking-apple-cert',
    klass: 'MATCH',
  })
})
await testAsync("import-pick-identity · no on-disk + no ASC key → bespoke 'import-no-match-recovery' [MATCH]", async () => {
  await parityEffect({
    step: 'import-pick-identity',
    progress: adHocImport(),
    carried: { chosenIdentity: IDENTITY_A, importMatches: [MATCH_A_NO_PROFILE] },
    bespoke: 'import-no-match-recovery',
    engine: 'import-no-match-recovery',
    klass: 'MATCH',
  })
})
await testAsync("import-pick-identity · __cancel__ → bespoke 'api-key-instructions' (switch to create-new) [MATCH]", async () => {
  await parityEffect({
    step: 'import-pick-identity',
    progress: adHocImport(),
    carried: {}, // no chosenIdentity → the user picked __cancel__
    bespoke: 'api-key-instructions',
    engine: 'api-key-instructions',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// import-pick-profile  (app.tsx L3519-3573) — pick a provisioning profile OR back
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL-branching. The picked profile rides carried.chosenProfile; the resolver
// validates (bundle id / distribution / cert-trust) then routes to
// import-export-warning (MATCH). '__back__' (no chosenProfile) → import-pick-identity
// (MATCH).
await testAsync("import-pick-profile · valid profile → bespoke 'import-export-warning' [MATCH]", async () => {
  await parityEffect({
    step: 'import-pick-profile',
    progress: adHocImport(),
    carried: { chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK },
    bespoke: 'import-export-warning',
    engine: 'import-export-warning',
    klass: 'MATCH',
  })
})
await testAsync("import-pick-profile · __back__ → bespoke 'import-pick-identity' [MATCH]", async () => {
  await parityEffect({
    step: 'import-pick-profile',
    progress: adHocImport(),
    carried: { chosenIdentity: IDENTITY_A }, // no chosenProfile → __back__
    bespoke: 'import-pick-identity',
    engine: 'import-pick-identity',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// import-no-match-recovery  (app.tsx L3629-3659) — the 5-way recovery HUB
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL-branching. The pick rides carried.recoveryAction; the resolver mirrors
// the TUI onChange exactly. ALL options MATCH:
//   - 'create' + an ASC key (carried .p8 OR progress.p8Path) → import-create-profile-only.
//   - 'create' + NO ASC key → api-key-instructions (persisting pendingRecoveryAction).
//   - 'provide-profile-path' → import-provide-profile-path.
//   - 'browser' → import-portal-explanation.
//   - 'back' → import-pick-identity.
const recoveryProgressNoKey = () => iosProgress({ setupMethod: 'import-existing', importDistribution: 'app_store' })
const recoveryProgressWithKey = () => iosProgress({ setupMethod: 'import-existing', importDistribution: 'app_store', p8Path: '/Users/me/key.p8' })
await testAsync("import-no-match-recovery · create (ASC key) → bespoke 'import-create-profile-only' [MATCH]", async () => {
  await parityEffect({
    step: 'import-no-match-recovery',
    progress: recoveryProgressWithKey(),
    carried: { recoveryAction: 'create', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-create-profile-only',
    engine: 'import-create-profile-only',
    klass: 'MATCH',
  })
})
await testAsync("import-no-match-recovery · create (no ASC key) → bespoke 'api-key-instructions' [MATCH]", async () => {
  await parityEffect({
    step: 'import-no-match-recovery',
    progress: recoveryProgressNoKey(),
    carried: { recoveryAction: 'create', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    // The resolver persists pendingRecoveryAction via the (optional) saveProgress dep — omitted here is harmless.
    deps: { saveProgress: async () => {} },
    bespoke: 'api-key-instructions',
    engine: 'api-key-instructions',
    klass: 'MATCH',
  })
})
await testAsync("import-no-match-recovery · provide-profile-path → bespoke 'import-provide-profile-path' [MATCH]", async () => {
  await parityEffect({
    step: 'import-no-match-recovery',
    progress: recoveryProgressWithKey(),
    carried: { recoveryAction: 'provide-profile-path', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-provide-profile-path',
    engine: 'import-provide-profile-path',
    klass: 'MATCH',
  })
})
await testAsync("import-no-match-recovery · browser → bespoke 'import-portal-explanation' [MATCH]", async () => {
  await parityEffect({
    step: 'import-no-match-recovery',
    progress: recoveryProgressWithKey(),
    carried: { recoveryAction: 'browser', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-portal-explanation',
    engine: 'import-portal-explanation',
    klass: 'MATCH',
  })
})
await testAsync("import-no-match-recovery · back → bespoke 'import-pick-identity' [MATCH]", async () => {
  await parityEffect({
    step: 'import-no-match-recovery',
    progress: recoveryProgressWithKey(),
    carried: { recoveryAction: 'back', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-pick-identity',
    engine: 'import-pick-identity',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// import-portal-explanation  (app.tsx L3788-3805) — manual-portal walkthrough
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL navigation. The pick rides carried.portalAction; the resolver mirrors
// the TUI onChange. ALL options MATCH:
//   - 'use-create' → import-create-profile-only.
//   - 'use-file'   → import-provide-profile-path.
//   - 'open-anyway'→ opens the portal (best-effort) then BACK to import-no-match-recovery.
//   - 'back'       → import-no-match-recovery.
await testAsync("import-portal-explanation · use-create → bespoke 'import-create-profile-only' [MATCH]", async () => {
  await parityEffect({
    step: 'import-portal-explanation',
    progress: recoveryProgressWithKey(),
    carried: { portalAction: 'use-create', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-create-profile-only',
    engine: 'import-create-profile-only',
    klass: 'MATCH',
  })
})
await testAsync("import-portal-explanation · use-file → bespoke 'import-provide-profile-path' [MATCH]", async () => {
  await parityEffect({
    step: 'import-portal-explanation',
    progress: recoveryProgressWithKey(),
    carried: { portalAction: 'use-file', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-provide-profile-path',
    engine: 'import-provide-profile-path',
    klass: 'MATCH',
  })
})
await testAsync("import-portal-explanation · open-anyway → bespoke 'import-no-match-recovery' [MATCH]", async () => {
  await parityEffect({
    step: 'import-portal-explanation',
    progress: recoveryProgressWithKey(),
    carried: { portalAction: 'open-anyway', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    deps: { openExternal: async () => {} },
    bespoke: 'import-no-match-recovery',
    engine: 'import-no-match-recovery',
    klass: 'MATCH',
  })
})
await testAsync("import-portal-explanation · back → bespoke 'import-no-match-recovery' [MATCH]", async () => {
  await parityEffect({
    step: 'import-portal-explanation',
    progress: recoveryProgressWithKey(),
    carried: { portalAction: 'back', chosenIdentity: IDENTITY_A, noMatchReason: 'no-profile-on-disk' },
    bespoke: 'import-no-match-recovery',
    engine: 'import-no-match-recovery',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// import-export-warning  (app.tsx L3819-3835) — heads-up before the Keychain dialog
// ════════════════════════════════════════════════════════════════════════════
// EPHEMERAL navigation. The pick rides carried.exportWarningAction; the resolver
// mirrors the TUI onChange:
//   - 'go'                    → import-exporting (MATCH; PR #2458 removed the
//     swiftc compile detour — the precompiled signed helper is resolved inside
//     the export step, so 'go' routes straight to import-exporting).
//   - 'back'                  → import-pick-profile (MATCH).
//   - 'exit' / no pick        → exitOnboarding → resolver 'error' (DIVERGE).
await testAsync("import-export-warning · go → bespoke 'import-exporting' [MATCH]", async () => {
  await parityEffect({
    step: 'import-export-warning',
    progress: adHocImport(),
    carried: { exportWarningAction: 'go', chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK },
    bespoke: 'import-exporting',
    engine: 'import-exporting',
    klass: 'MATCH',
  })
})
await testAsync("import-export-warning · back → bespoke 'import-pick-profile' [MATCH]", async () => {
  await parityEffect({
    step: 'import-export-warning',
    progress: adHocImport(),
    carried: { exportWarningAction: 'back', chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK },
    bespoke: 'import-pick-profile',
    engine: 'import-pick-profile',
    klass: 'MATCH',
  })
})
await testAsync("import-export-warning · exit → bespoke exitOnboarding [DIVERGE: exit escape → resolver 'error']", async () => {
  await parityEffect({
    step: 'import-export-warning',
    progress: adHocImport(),
    carried: { exportWarningAction: 'exit', chosenIdentity: IDENTITY_A, chosenProfile: PROFILE_ON_DISK },
    bespoke: 'exit',
    engine: 'error',
    klass: 'DIVERGE',
  })
})

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)

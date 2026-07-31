#!/usr/bin/env node
/**
 * Android post-save TAIL — choice/input ROUTING PARITY baseline.
 *
 * This is the behavior baseline for the upcoming routing swap: the bespoke TUI
 * (`src/build/onboarding/android/ui/app.tsx`) currently renders each post-save
 * tail choice/input with an explicit `setStep(next)` decision in its
 * onChoose/onChange. That duplicates the engine's routing. The swap will move
 * the next-step decision onto the engine, derived from:
 *
 *     applyAndroidInput(step, progress, input)  →  getAndroidResumeStep(newProgress)
 *
 * For EACH tail choice/input step + EACH of its options (including the escape
 * hatches — pick-build-script __custom__/__skip__, ci-secrets-target-select
 * null/skip, ask-build no→build-complete) this test drives that exact pipeline
 * and records the engine-derived next-step alongside the bespoke `setStep`
 * target read from app.tsx.
 *
 * Two classes of result are asserted, and the distinction IS the deliverable:
 *
 *   MATCH   — the engine-derived resume step EQUALS the bespoke setStep target.
 *             These inputs are safe to swap to engine-derived routing as-is:
 *             the persisted markers (credentialsSaved / buildRequested /
 *             ciSecretsUploaded) + the tail fields the input writes are enough
 *             for getAndroidResumeStep to reproduce the in-session transition.
 *
 *   DIVERGE — the engine-derived resume step does NOT equal the bespoke setStep.
 *             getAndroidResumeStep is a RESUME router: it intentionally collapses
 *             onto the nearest idempotent re-entry point (a read-only AUTO step
 *             like detecting-/checking-ci-secrets or the overwrite-safe
 *             writing-workflow-file) and GUARDS against re-firing a side effect
 *             that already has its marker (no double build, no re-upload). The
 *             bespoke setStep is the IMMEDIATE in-session transition to the exact
 *             next screen. For these inputs the next-step is NOT derivable from
 *             persisted progress — it is either:
 *               • navigation-only (a spinner gate / sub-screen / escape hatch
 *                 that records no field), or
 *               • a confirmation gate whose "next" fires an AUTO effect, or
 *               • a transient viewer (view-workflow-diff / preview re-show).
 *             The routing swap MUST keep these driver-routed OR resolve them via
 *             the engine effect-resolver pattern (runAndroidEffect/runTailEffect
 *             returns `next` — e.g. detecting-ci-secrets fans out to
 *             ask-github-actions-setup / ask-ci-secrets / ci-secrets-target-select
 *             / ci-secrets-setup / build-complete). They are recorded here with
 *             their precise reason so the swap can't silently regress them.
 *
 * No fs / network / child processes: applyAndroidInput + getAndroidResumeStep
 * are pure. Progress fixtures mirror the persisted markers present at the point
 * in the live flow where each choice/input is shown.
 */
import process from 'node:process'

const { applyAndroidInput } = await import('../src/build/onboarding/android/flow.ts')
const { getAndroidResumeStep } = await import('../src/build/onboarding/android/progress.ts')

console.log('🧪 Android tail choice/input ROUTING PARITY (applyAndroidInput → getAndroidResumeStep)\n')

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

function assertEquals(actual, expected, message) {
  if (actual !== expected)
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const APP_ID = 'com.example.app'
const GITHUB_TARGET = { provider: 'github', label: 'GitHub Actions repository secrets', cli: 'gh' }
const GITLAB_TARGET = { provider: 'gitlab', label: 'GitLab CI/CD variables', cli: 'glab' }

const CREDS_SAVED = { savedAt: '2026-06-03T01:00:00.000Z' }
const BUILD_REQUESTED = { buildUrl: `https://console.capgo.app/app/${APP_ID}/builds` }
const CI_UPLOADED_GH = { provider: 'github', count: 3 }

// A FULLY-provisioned OAuth progress whose keystore + provisioning gates are all
// satisfied, so getAndroidResumeStep reaches Phase 6 (the tail). Mirrors the
// sibling fixture in test-android-tail-engine.mjs.
function provisionedProgress(overrides = {}) {
  const { completedSteps: completedOverrides, ...rest } = overrides
  return {
    platform: 'android',
    appId: APP_ID,
    startedAt: '2026-06-03T00:00:00.000Z',
    _keystoreBase64: 'a2V5',
    _serviceAccountKeyBase64: 'eyJ9',
    _oauthRefreshToken: 'refresh-token',
    keystoreStorePassword: 'pw',
    keystoreKeyPassword: 'pw',
    keystoreAlias: 'release',
    ...rest,
    completedSteps: {
      keystoreReady: { keystorePath: 'android/app/release.p12', alias: 'release', isGenerated: true },
      androidPackageChosen: { packageName: APP_ID, source: 'gradle' },
      googleSignInComplete: { email: 'user@example.com', googleSubject: 'sub', scope: 'all' },
      playAccountChosen: { developerId: '123456789' },
      gcpProjectChosen: { projectId: 'capgo-test', displayName: 'Capgo', createdByOnboarding: false },
      serviceAccountProvisioned: { email: 'sa@capgo-test.iam.gserviceaccount.com', projectId: 'capgo-test' },
      playInviteProvisioned: { developerId: '123456789', serviceAccountEmail: 'sa@capgo-test.iam.gserviceaccount.com' },
      ...completedOverrides,
    },
  }
}

/** Post-save tail progress: provisioned + credentials.json written. */
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

// ─── Parity harness ──────────────────────────────────────────────────────────
//
// Each case declares the step, the progress AT that point in the live flow, the
// AndroidInput, the bespoke setStep target (read verbatim from app.tsx with a
// line reference), the EXPECTED engine-derived resume step, and the class.
//
//   MATCH:   bespoke === engine  → the assertion proves they agree.
//   DIVERGE: bespoke !== engine  → the assertion pins the engine's ACTUAL
//            resume value AND verifies it really differs from the bespoke
//            target, so a future change that "fixes" routing to the bespoke
//            value (without the marker/effect plumbing) trips this test.

function parity({ step, progress, input, bespoke, engine, klass, why }) {
  const next = getAndroidResumeStep(applyAndroidInput(step, progress, input))
  assertEquals(next, engine, `${step}: engine-derived next expected ${engine}, got ${next}`)
  if (klass === 'MATCH') {
    assertEquals(next, bespoke, `${step}: MATCH case must equal bespoke setStep ${bespoke}, got ${next}`)
  }
  else {
    if (next === bespoke)
      throw new Error(`${step}: declared DIVERGE but engine (${next}) equals bespoke (${bespoke}) — reclassify as MATCH`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ask-build  (app.tsx L3200-3210) — credentialsSaved set, NOT yet buildRequested
// ════════════════════════════════════════════════════════════════════════════
// 'ask-build' is NOT in TAIL_INPUT_STEPS → applyAndroidInput returns progress
// unchanged. The resume router deliberately re-lands on the ask-build USER GATE
// (never the AUTO requesting-build) — that is the double-build guard.
test("ask-build · yes → bespoke 'requesting-build' [DIVERGE: navigation-only gate; resume guards double-build]", () => {
  parity({
    step: 'ask-build',
    progress: savedTailProgress(),
    input: { step: 'ask-build', value: 'yes' },
    bespoke: 'requesting-build',
    engine: 'ask-build',
    klass: 'DIVERGE',
  })
})
test("ask-build · no → bespoke 'build-complete' [DIVERGE: no 'build declined' marker; resume stays on the gate]", () => {
  parity({
    step: 'ask-build',
    progress: savedTailProgress(),
    input: { step: 'ask-build', value: 'no' },
    bespoke: 'build-complete',
    engine: 'ask-build',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ci-secrets-setup  (app.tsx L2822-2829) — after build, no targets/advice path
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. No target chosen, not declined →
// resume re-runs the read-only detection.
const afterBuildNoTarget = () => savedTailProgress({ completedSteps: { buildRequested: BUILD_REQUESTED } })
test("ci-secrets-setup · retry → bespoke 'detecting-ci-secrets' [MATCH]", () => {
  parity({
    step: 'ci-secrets-setup',
    progress: afterBuildNoTarget(),
    input: { step: 'ci-secrets-setup', value: 'retry' },
    bespoke: 'detecting-ci-secrets',
    engine: 'detecting-ci-secrets',
    klass: 'MATCH',
  })
})
test("ci-secrets-setup · skip → bespoke 'build-complete' [DIVERGE: navigation-only skip; resume re-detects]", () => {
  parity({
    step: 'ci-secrets-setup',
    progress: afterBuildNoTarget(),
    input: { step: 'ci-secrets-setup', value: 'skip' },
    bespoke: 'build-complete',
    engine: 'detecting-ci-secrets',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ci-secrets-target-select  (app.tsx L2832-2858) — multi-target, after build
// ════════════════════════════════════════════════════════════════════════════
// IN TAIL_INPUT_STEPS → writes ciSecretTarget. The bespoke routes per provider
// (ask-github-actions-setup / ask-ci-secrets) or build-complete on skip/no-target.
// The resume router collapses a GITLAB target (or a github target with a
// DECIDED setupMode) onto the read-only check, and a null target onto
// re-detection.
// CONTRACT CHANGE (S14): a GitHub target with NO persisted setupMode decision
// now resumes onto the UNANSWERED ask-github-actions-setup consent gate
// instead of collapsing onto checking-ci-secrets — the old route silently
// dropped the user's pending decision after an MCP server restart (the answer
// was then rejected off-step; found by the live MCP e2e). The unanswered
// consent gate must re-ask. The engine-derived next now EQUALS the bespoke
// provider fan-out, so the github case is reclassified DIVERGE → MATCH.
test("ci-secrets-target-select · github → bespoke 'ask-github-actions-setup' [MATCH: the unanswered consent gate is now resume-derivable (S14)]", () => {
  parity({
    step: 'ci-secrets-target-select',
    progress: afterBuildNoTarget(),
    input: { step: 'ci-secrets-target-select', ciSecretTarget: GITHUB_TARGET },
    bespoke: 'ask-github-actions-setup',
    engine: 'ask-github-actions-setup',
    klass: 'MATCH',
  })
})
test("ci-secrets-target-select · gitlab → bespoke 'ask-ci-secrets' [DIVERGE: provider fan-out is effect-routed; resume → check]", () => {
  parity({
    step: 'ci-secrets-target-select',
    progress: afterBuildNoTarget(),
    input: { step: 'ci-secrets-target-select', ciSecretTarget: GITLAB_TARGET },
    bespoke: 'ask-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})
test("ci-secrets-target-select · skip/null → bespoke 'build-complete' [DIVERGE: escape hatch; null target → re-detect]", () => {
  parity({
    step: 'ci-secrets-target-select',
    progress: afterBuildNoTarget(),
    input: { step: 'ci-secrets-target-select', ciSecretTarget: null },
    bespoke: 'build-complete',
    engine: 'detecting-ci-secrets',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ask-github-actions-setup  (app.tsx L2873-2908) — GitHub target chosen
// ════════════════════════════════════════════════════════════════════════════
// IN TAIL_INPUT_STEPS → writes setupMode. All three options are resume-derivable:
// with-workflow/secrets-only land on the read-only check (target set, not yet
// uploaded); declined lands on the env-export prompt (no path recorded yet).
const afterBuildGithub = () => savedTailProgress({
  ciSecretTarget: GITHUB_TARGET,
  completedSteps: { buildRequested: BUILD_REQUESTED },
})
// Post-gate github shape: confirm-secrets-push / ci-secrets-failed are only
// reachable AFTER ask-github-actions-setup was answered, so their fixtures
// carry the decided setupMode. (An UNDECIDED github target now resumes to the
// unanswered gate itself — the consent-gate re-ask contract; a persisted
// target with no setupMode is an MCP-slim-progress shape the resolver routes
// to 'ask-github-actions-setup' so a pending decision is never silently lost.)
const afterBuildGithubDecided = () => savedTailProgress({
  ciSecretTarget: GITHUB_TARGET,
  setupMode: 'secrets-only',
  completedSteps: { buildRequested: BUILD_REQUESTED },
})
test("ask-github-actions-setup · with-workflow → bespoke 'checking-ci-secrets' [MATCH]", () => {
  parity({
    step: 'ask-github-actions-setup',
    progress: afterBuildGithub(),
    input: { step: 'ask-github-actions-setup', value: 'with-workflow' },
    bespoke: 'checking-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'MATCH',
  })
})
test("ask-github-actions-setup · secrets-only → bespoke 'checking-ci-secrets' [MATCH]", () => {
  parity({
    step: 'ask-github-actions-setup',
    progress: afterBuildGithub(),
    input: { step: 'ask-github-actions-setup', value: 'secrets-only' },
    bespoke: 'checking-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'MATCH',
  })
})
test("ask-github-actions-setup · no/declined → bespoke 'ask-export-env' [MATCH]", () => {
  parity({
    step: 'ask-github-actions-setup',
    progress: afterBuildGithub(),
    input: { step: 'ask-github-actions-setup', value: 'declined' },
    bespoke: 'ask-export-env',
    engine: 'ask-export-env',
    klass: 'MATCH',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ask-ci-secrets  (app.tsx L2861-2871) — GitLab path, target already chosen
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. 'yes' → the read-only check
// (matches); 'no' → bespoke build-complete (navigation-only; resume still checks).
const afterBuildGitlab = () => savedTailProgress({
  ciSecretTarget: GITLAB_TARGET,
  completedSteps: { buildRequested: BUILD_REQUESTED },
})
test("ask-ci-secrets · yes → bespoke 'checking-ci-secrets' [MATCH]", () => {
  parity({
    step: 'ask-ci-secrets',
    progress: afterBuildGitlab(),
    input: { step: 'ask-ci-secrets', value: 'yes' },
    bespoke: 'checking-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'MATCH',
  })
})
test("ask-ci-secrets · no → bespoke 'build-complete' [DIVERGE: navigation-only decline; resume → check]", () => {
  parity({
    step: 'ask-ci-secrets',
    progress: afterBuildGitlab(),
    input: { step: 'ask-ci-secrets', value: 'no' },
    bespoke: 'build-complete',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// confirm-secrets-push  (app.tsx L3151-3168) — GitHub, post-check, pre-upload
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. 'confirm' fires the AUTO upload;
// resume re-runs the read-only check (never the upload — no re-upload guard).
test("confirm-secrets-push · confirm → bespoke 'uploading-ci-secrets' [DIVERGE: confirm fires AUTO upload; resume → check]", () => {
  parity({
    step: 'confirm-secrets-push',
    progress: afterBuildGithubDecided(),
    input: { step: 'confirm-secrets-push', value: 'confirm' },
    bespoke: 'uploading-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})
test("confirm-secrets-push · cancel → bespoke 'build-complete' [DIVERGE: navigation-only cancel; resume → check]", () => {
  parity({
    step: 'confirm-secrets-push',
    progress: afterBuildGithubDecided(),
    input: { step: 'confirm-secrets-push', value: 'cancel' },
    bespoke: 'build-complete',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// confirm-ci-secret-overwrite  (app.tsx L3170-3178) — GitLab, post-check
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. Same shape as confirm-secrets-push.
test("confirm-ci-secret-overwrite · replace → bespoke 'uploading-ci-secrets' [DIVERGE: replace fires AUTO upload; resume → check]", () => {
  parity({
    step: 'confirm-ci-secret-overwrite',
    progress: afterBuildGitlab(),
    input: { step: 'confirm-ci-secret-overwrite', value: 'replace' },
    bespoke: 'uploading-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})
test("confirm-ci-secret-overwrite · skip → bespoke 'build-complete' [DIVERGE: navigation-only skip; resume → check]", () => {
  parity({
    step: 'confirm-ci-secret-overwrite',
    progress: afterBuildGitlab(),
    input: { step: 'confirm-ci-secret-overwrite', value: 'skip' },
    bespoke: 'build-complete',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ci-secrets-failed  (app.tsx L3190-3198) — after build, error surfaced
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. The bespoke retry routing
// branches on whether a target is set — and the resume router branches the SAME
// way, so retry MATCHES in both shapes. 'continue' is navigation-only.
test("ci-secrets-failed · retry (target set) → bespoke 'checking-ci-secrets' [MATCH]", () => {
  parity({
    step: 'ci-secrets-failed',
    progress: afterBuildGithubDecided(),
    input: { step: 'ci-secrets-failed', value: 'retry' },
    bespoke: 'checking-ci-secrets',
    engine: 'checking-ci-secrets',
    klass: 'MATCH',
  })
})
test("ci-secrets-failed · retry (no target) → bespoke 'detecting-ci-secrets' [MATCH]", () => {
  parity({
    step: 'ci-secrets-failed',
    progress: afterBuildNoTarget(),
    input: { step: 'ci-secrets-failed', value: 'retry' },
    bespoke: 'detecting-ci-secrets',
    engine: 'detecting-ci-secrets',
    klass: 'MATCH',
  })
})
test("ci-secrets-failed · continue (target set) → bespoke 'build-complete' [DIVERGE: navigation-only; resume → check]", () => {
  parity({
    step: 'ci-secrets-failed',
    progress: afterBuildGithubDecided(),
    input: { step: 'ci-secrets-failed', value: 'continue' },
    bespoke: 'build-complete',
    engine: 'checking-ci-secrets',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ask-export-env  (app.tsx L2910-2940) — declined GH Actions, env-export leaf
// ════════════════════════════════════════════════════════════════════════════
// IN TAIL_INPUT_STEPS. 'yes' records envExportTargetPath → resume runs the write
// effect (matches). 'no' records nothing → resume re-shows the prompt (diverge).
const declinedNoPath = () => savedTailProgress({
  setupMode: 'declined',
  completedSteps: { buildRequested: BUILD_REQUESTED },
})
test("ask-export-env · yes → bespoke 'exporting-env' [MATCH]", () => {
  parity({
    step: 'ask-export-env',
    progress: declinedNoPath(),
    input: { step: 'ask-export-env', value: 'yes', envExportTargetPath: `/tmp/.env.capgo.${APP_ID}.android` },
    bespoke: 'exporting-env',
    engine: 'exporting-env',
    klass: 'MATCH',
  })
})
test("ask-export-env · no → bespoke 'build-complete' [DIVERGE: no 'export declined' marker; resume re-shows the prompt]", () => {
  parity({
    step: 'ask-export-env',
    progress: declinedNoPath(),
    input: { step: 'ask-export-env', value: 'no' },
    bespoke: 'build-complete',
    engine: 'ask-export-env',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// confirm-env-export-overwrite  (app.tsx L2948-2967) — declined, path set, file exists
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. The overwrite confirmation is a
// transient gate (the export-file-already-exists fork is detected by the AUTO
// exporting-env effect, not persisted). Resume re-runs exporting-env.
const declinedPathSet = () => savedTailProgress({
  setupMode: 'declined',
  envExportTargetPath: `/tmp/.env.capgo.${APP_ID}.android`,
  completedSteps: { buildRequested: BUILD_REQUESTED },
})
test("confirm-env-export-overwrite · replace → bespoke 'overwrite-and-export-env' [DIVERGE: transient overwrite gate; resume → exporting-env]", () => {
  parity({
    step: 'confirm-env-export-overwrite',
    progress: declinedPathSet(),
    input: { step: 'confirm-env-export-overwrite', value: 'replace' },
    bespoke: 'overwrite-and-export-env',
    engine: 'exporting-env',
    klass: 'DIVERGE',
  })
})
test("confirm-env-export-overwrite · skip → bespoke 'build-complete' [DIVERGE: navigation-only skip; resume → exporting-env]", () => {
  parity({
    step: 'confirm-env-export-overwrite',
    progress: declinedPathSet(),
    input: { step: 'confirm-env-export-overwrite', value: 'skip' },
    bespoke: 'build-complete',
    engine: 'exporting-env',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// pick-package-manager  (app.tsx L2969-2997) — post-upload, with-workflow
// ════════════════════════════════════════════════════════════════════════════
// IN TAIL_INPUT_STEPS → writes selectedPackageManager. Resume-derivable: PM set,
// build script still missing → pick-build-script. (All four PM options share the
// same single routing branch in the bespoke onChange.)
const afterUploadWithWorkflow = (overrides = {}) => savedTailProgress({
  ciSecretTarget: GITHUB_TARGET,
  setupMode: 'with-workflow',
  ...overrides,
  completedSteps: { buildRequested: BUILD_REQUESTED, ciSecretsUploaded: CI_UPLOADED_GH },
})
for (const pm of ['bun', 'npm', 'pnpm', 'yarn']) {
  test(`pick-package-manager · ${pm} → bespoke 'pick-build-script' [MATCH]`, () => {
    parity({
      step: 'pick-package-manager',
      progress: afterUploadWithWorkflow(),
      input: { step: 'pick-package-manager', selectedPackageManager: pm },
      bespoke: 'pick-build-script',
      engine: 'pick-build-script',
      klass: 'MATCH',
    })
  })
}

// ════════════════════════════════════════════════════════════════════════════
// pick-build-script  (app.tsx L2999-3027) — post-upload, with-workflow, PM set
// ════════════════════════════════════════════════════════════════════════════
// IN TAIL_INPUT_STEPS. Recording a build-script choice (npm-script OR the
// __skip__ escape hatch) makes the workflow file writable, so resume lands on
// the overwrite-safe writing-workflow-file — but the BESPOKE inserts a
// preview-workflow-file confirmation gate first → DIVERGE. The __custom__ escape
// hatch records nothing (navigation into the custom-command input) → resume
// re-shows pick-build-script → DIVERGE.
const afterUploadPmSet = () => afterUploadWithWorkflow({ selectedPackageManager: 'bun' })
test("pick-build-script · npm-script → bespoke 'preview-workflow-file' [DIVERGE: preview is a transient confirm gate; resume → write]", () => {
  parity({
    step: 'pick-build-script',
    progress: afterUploadPmSet(),
    input: { step: 'pick-build-script', buildScriptChoice: { type: 'npm-script', name: 'build' } },
    bespoke: 'preview-workflow-file',
    engine: 'writing-workflow-file',
    klass: 'DIVERGE',
  })
})
test("pick-build-script · __skip__ → bespoke 'preview-workflow-file' [DIVERGE: skip records a choice; resume → write past the preview gate]", () => {
  parity({
    step: 'pick-build-script',
    progress: afterUploadPmSet(),
    input: { step: 'pick-build-script', buildScriptChoice: { type: 'skip' } },
    bespoke: 'preview-workflow-file',
    engine: 'writing-workflow-file',
    klass: 'DIVERGE',
  })
})
test("pick-build-script · __custom__ → bespoke 'pick-build-script-custom' [DIVERGE: navigation-only into the custom input; no field written]", () => {
  parity({
    step: 'pick-build-script',
    progress: afterUploadPmSet(),
    input: { step: 'pick-build-script', value: '__custom__' },
    bespoke: 'pick-build-script-custom',
    engine: 'pick-build-script',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// pick-build-script-custom  (app.tsx L3029-3057) — custom-command input
// ════════════════════════════════════════════════════════════════════════════
// IN TAIL_INPUT_STEPS. A non-empty command records buildScriptChoice → resume
// reaches writing-workflow-file (bespoke previews first → DIVERGE). An empty
// command is a no-op in the bespoke (no transition) and writes nothing → resume
// re-shows pick-build-script → DIVERGE.
test("pick-build-script-custom · command → bespoke 'preview-workflow-file' [DIVERGE: preview gate; resume → write]", () => {
  parity({
    step: 'pick-build-script-custom',
    progress: afterUploadPmSet(),
    input: { step: 'pick-build-script-custom', command: 'make web' },
    bespoke: 'preview-workflow-file',
    engine: 'writing-workflow-file',
    klass: 'DIVERGE',
  })
})
test("pick-build-script-custom · empty command → bespoke stays 'pick-build-script-custom' [DIVERGE: no-op input; resume → pick-build-script]", () => {
  parity({
    step: 'pick-build-script-custom',
    progress: afterUploadPmSet(),
    input: { step: 'pick-build-script-custom', command: '   ' },
    bespoke: 'pick-build-script-custom',
    engine: 'pick-build-script',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// preview-workflow-file  (app.tsx L3060-3098) — post-upload, PM + script set
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. 'write' MATCHES (the write step
// is exactly where resume lands once a build-script choice is recorded). 'view'
// opens the transient diff viewer; 'cancel' is navigation-only.
const previewReady = () => afterUploadWithWorkflow({
  selectedPackageManager: 'bun',
  buildScriptChoice: { type: 'npm-script', name: 'build' },
})
test("preview-workflow-file · write → bespoke 'writing-workflow-file' [MATCH]", () => {
  parity({
    step: 'preview-workflow-file',
    progress: previewReady(),
    input: { step: 'preview-workflow-file', value: 'write' },
    bespoke: 'writing-workflow-file',
    engine: 'writing-workflow-file',
    klass: 'MATCH',
  })
})
test("preview-workflow-file · view → bespoke 'view-workflow-diff' [DIVERGE: transient diff viewer; resume → write]", () => {
  parity({
    step: 'preview-workflow-file',
    progress: previewReady(),
    input: { step: 'preview-workflow-file', value: 'view' },
    bespoke: 'view-workflow-diff',
    engine: 'writing-workflow-file',
    klass: 'DIVERGE',
  })
})
test("preview-workflow-file · cancel → bespoke 'build-complete' [DIVERGE: navigation-only cancel; resume → write]", () => {
  parity({
    step: 'preview-workflow-file',
    progress: previewReady(),
    input: { step: 'preview-workflow-file', value: 'cancel' },
    bespoke: 'build-complete',
    engine: 'writing-workflow-file',
    klass: 'DIVERGE',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// view-workflow-diff  (app.tsx L2067-2083 fullscreen onExit) — transient viewer
// ════════════════════════════════════════════════════════════════════════════
// NOT in TAIL_INPUT_STEPS → progress unchanged. 'close' returns to the preview
// in-session; resume (which never models the viewer) lands on the write step.
test("view-workflow-diff · close → bespoke 'preview-workflow-file' [DIVERGE: transient viewer; resume → write]", () => {
  parity({
    step: 'view-workflow-diff',
    progress: previewReady(),
    input: { step: 'view-workflow-diff', value: 'close' },
    bespoke: 'preview-workflow-file',
    engine: 'writing-workflow-file',
    klass: 'DIVERGE',
  })
})

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${testsPassed} passed, ${testsFailed} failed`)
if (testsFailed > 0)
  process.exit(1)

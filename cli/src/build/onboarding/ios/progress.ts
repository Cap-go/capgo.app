// src/build/onboarding/ios/progress.ts
//
// TOTAL iOS resume routing.
//
// `getIosResumeStep` extends the PARTIAL `getResumeStep` (in ../progress.ts)
// into a TOTAL resume over persisted state, exactly as `getAndroidResumeStep`
// did for android. It adds the FRONT gates that, on main, live only as
// `setStep` calls inside the ink TUI (and so are invisible to a stateless
// resume):
//
//   Phase 0 — data-safety gate (`_credentialsExistGate`)
//             'pending' → credentials-exist   (backup-or-cancel choice)
//             'backup'  → backing-up          (the backup effect must still run)
//   (The former Phase 1/1b confirm-app-id gates are gone: PR #2397 removed the
//   confirm-app-id step — the driver silently adopts the authoritative Release
//   bundle id and the remote verify-app step, routed by `getResumeStep` in
//   ../progress.ts, now owns the bundle-id invariant.)
//
// Everything AFTER the gates — the create-new / import `.p8`-chain / cert /
// profile → `saving-credentials` routing — is delegated VERBATIM to the
// existing `getResumeStep`, so:
//   - the intentional `verifying-key` round-trip on import app_store resume is
//     preserved (risk #4 in the audit): when all three .p8 inputs are present
//     `getResumeStep` returns `verifying-key`, never short-circuiting on
//     `completedSteps.apiKeyVerified`;
//   - the existing exported `getResumeStep` stays byte-for-byte unchanged (the
//     ink TUI still imports it), so its regression tests stay green.
//
// BATCH 0 deliberately does NOT route into the post-save tail — the terminal
// here stays `saving-credentials` exactly as `getResumeStep` returns it. The
// shared-tail routing (Phase 2 in the audit) is added in BATCH 1.
//
// CRITICAL — resume can ONLY land on persisted-state-derivable steps. The
// ephemeral import picker steps (`import-pick-identity` / `import-pick-profile`,
// `import-checking-apple-cert`, `import-validating-all-certs`,
// `import-no-match-recovery`, the recovery sub-steps) are NEVER resume targets:
// on resume the engine lands on `import-scanning` (or the .p8 chain), the scan
// effect re-populates the ephemeral inventory into transient, and the picker is
// re-rendered. This contract is inherited from `getResumeStep` (it returns
// `import-scanning`, not a picker) — the gates added here never introduce a
// picker target either.
//
// PURE / IO-FREE — this function only reads `progress`; it never performs an FS
// read (the bundle-id resolution is a SYNC FS read done by the DRIVER, which
// persists the result as `iosBundleIdOverride` / `iosBundleIdContextAppId`).

import type { OnboardingProgress, OnboardingStep } from '../types.js'
import { getResumeStep } from '../progress.js'

/**
 * Post-save "tail" resume routing (shared model with android's `tailResumeStep`).
 *
 * Once `saving-credentials` completes, the wizard runs the platform-neutral tail:
 *   ask-build → requesting-build → detecting-ci-secrets → (ci-secrets sub-flow)
 *   → uploading-ci-secrets → (with-workflow) pick-package-manager →
 *   pick-build-script → preview/writing-workflow-file → build-complete
 * with a parallel `.env`-export leaf (ask-export-env → exporting-env) taken when
 * the user declines the GitHub Actions setup. This is the SAME derivation the
 * android engine uses (`android/progress.ts`'s `tailResumeStep`) — the iOS engine
 * delegates the tail EFFECTS to the same shared module (`tail/flow.ts`), so the
 * resume routing into it must match android's step-for-step.
 *
 * Resume here is GUARDED by the three irreversible-side-effect markers
 * (`credentialsSaved`, `buildRequested`, `ciSecretsUploaded`). The router never
 * returns a step that would re-fire a side-effect that already has its marker:
 *   - no `buildRequested`  → land on the `ask-build` user gate (never auto-fire
 *                            `requesting-build`, so resume can't double-build)
 *   - `buildRequested` but no `ciSecretsUploaded` → land on the read-only
 *                            `detecting-ci-secrets` (or `checking-ci-secrets`
 *                            once a target is chosen) — never `uploading-ci-secrets`
 *   - `ciSecretsUploaded`  → only the (idempotent) workflow-builder choice/input
 *                            steps or the terminal `build-complete` remain
 *
 * Returns `null` when no tail marker is present, so `getIosResumeStep` keeps
 * returning whatever `getResumeStep` derives (the terminal `saving-credentials`)
 * exactly as before — legacy/in-flight progress files (which never carry these
 * markers) are completely unaffected.
 */
function tailResumeStep(progress: OnboardingProgress): OnboardingStep | null {
  const { completedSteps } = progress

  // Tail not entered yet — let the caller fall through to `getResumeStep`.
  if (!completedSteps.credentialsSaved)
    return null

  // Phase 6a — Build request. The post-save entry point is the `ask-build` user
  // gate; the build itself fires only after the user confirms. Resuming onto the
  // gate (not `requesting-build`) is what prevents a double build on resume.
  if (!completedSteps.buildRequested)
    return 'ask-build'

  // Phase 6b — CI-secrets push. Not yet uploaded: route forward toward the
  // upload without ever landing on the upload step itself.
  if (!completedSteps.ciSecretsUploaded) {
    // The user declined GitHub Actions → the `.env`-export leaf. Resume onto the
    // export prompt until a path is recorded, then onto the (overwrite-safe)
    // write effect.
    if (progress.setupMode === 'declined')
      return progress.envExportTargetPath ? 'exporting-env' : 'ask-export-env'

    // A destination is already chosen (single-target auto-pick, the
    // target-select screen, or a decided setupMode) → normally the remote
    // check is the next read-only step before the confirm gate + upload.
    if (progress.ciSecretTarget) {
      // EXCEPT: a GitHub target whose 3-way ask-github-actions-setup consent
      // gate is still UNANSWERED — no setupMode decision was ever persisted.
      // The MCP slim progress persists the auto-picked target at tail ENTRY
      // (before the user answers the gate), so a server restart parked on the
      // unanswered gate used to collapse onto 'checking-ci-secrets', routing
      // PAST the gate: the pending githubActionsSetup answer was then rejected
      // off-step and the with-workflow arm became unreachable — the user's
      // decision was silently lost (found by the live MCP e2e, S14). Re-ask
      // the unanswered gate instead — the same principle as the S9-S11
      // checkBuild re-poll park. Strictly `undefined`: the TUI's SYNTHETIC
      // in-memory progress carries setupMode 'undecided' pre-answer (its
      // in-session router must keep its routing), and the TUI never persists
      // ciSecretTarget — the undefined shape is MCP-slim-progress-only.
      // ASYMMETRY (GitLab, deliberate): its consent gate is ask-ci-secrets,
      // whose yes/no is purely navigational and never persisted — resume
      // cannot distinguish answered from unanswered, so 'checking-ci-secrets'
      // stays its correct idempotent re-entry (the confirm-ci-secret-overwrite
      // gate re-derives from the remote).
      if (progress.ciSecretTarget.provider === 'github' && progress.setupMode === undefined)
        return 'ask-github-actions-setup'
      return 'checking-ci-secrets'
    }

    // Credentials saved + build queued but no CI work started yet → re-run the
    // read-only detection. Idempotent: it only inspects the repo and routes.
    return 'detecting-ci-secrets'
  }

  // Phase 6c — Post-upload. Secrets are pushed; only the workflow-builder sub-
  // flow (with-workflow) or the terminal screen remain. None of these re-touch
  // the remote, so routing by which choice is still missing is side-effect-safe.
  if (progress.setupMode === 'with-workflow') {
    if (!progress.selectedPackageManager)
      return 'pick-package-manager'
    if (!progress.buildScriptChoice)
      return 'pick-build-script'
    // Package manager + build script chosen → ready to (over)write the workflow
    // file. `writing-workflow-file` writes with overwrite=true, so re-running it
    // is safe.
    return 'writing-workflow-file'
  }

  // secrets-only / declined-after-upload / GitLab → nothing left to do.
  return 'build-complete'
}

/** Steps where saved iOS credentials must trigger the data-safety gate before continuing. */
export const IOS_API_KEY_GATE_STEPS = new Set<OnboardingStep>([
  'welcome',
  'setup-method-select',
  'api-key-instructions',
  'p8-method-select',
  'input-p8-path',
  'input-key-id',
  'input-issuer-id',
])

export function getIosResumeStep(progress: OnboardingProgress | null, canAutomate = true): OnboardingStep {
  if (!progress)
    return 'welcome'

  // Phase 0 — Data-safety gate. When saved iOS credentials already exist for
  // this appId, the engine routes through `credentials-exist` (backup-or-cancel
  // choice) and, on backup, `backing-up` (the credentials.json → dated copy)
  // BEFORE entering the setup-method fork — mirroring main's ink TUI. The gate
  // lifecycle lives in `_credentialsExistGate`; only 'pending'/'backup' park the
  // user on a gate step. 'done'/'cancel'/undefined fall through to the normal
  // routing below (the driver handles 'cancel' as a hard stop).
  if (progress._credentialsExistGate === 'pending')
    return 'credentials-exist'
  if (progress._credentialsExistGate === 'backup')
    return 'backing-up'

  // Phase 2 — Post-save "tail" (shared with android, checked FIRST after the
  // front gates exactly as `getAndroidResumeStep` checks it before the cred
  // fork). `credentialsSaved` is the unambiguous "save already happened" marker:
  // it means the whole cert/profile sequence finished and credentials.json was
  // written, so we route THROUGH the tail (build-request → CI-secrets →
  // env/workflow) instead of past the create-new / import `.p8` routing below.
  // When the marker is absent (every legacy/in-flight progress file),
  // `tailResumeStep` returns null and we fall through to `getResumeStep`, which
  // still terminates at `saving-credentials` — so existing files are unaffected.
  const tailStep = tailResumeStep(progress)
  if (tailStep)
    return tailStep

  // Phases 3+ — create-new / import `.p8`-chain / cert / profile →
  // saving-credentials. Delegated VERBATIM to the existing partial resume so the
  // import app_store `verifying-key` round-trip (and every other already-tested
  // branch) is preserved unchanged.
  return getResumeStep(progress, canAutomate)
}

// src/build/onboarding/android/progress.ts
import type { AndroidOnboardingProgress, AndroidOnboardingStep } from './types.js'
import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureSecureDirectory, writeFileAtomic } from '../../../utils/safeWrites.js'

const CREDENTIALS_DIR = '.capgo-credentials'
const ONBOARDING_DIR = 'onboarding'
const ANDROID_PREFIX = 'android-'

function getOnboardingDir(baseDir?: string): string {
  const base = baseDir || join(homedir(), CREDENTIALS_DIR)
  return join(base, ONBOARDING_DIR)
}

function sanitizeAppId(appId: string): string {
  const sanitized = appId.replace(/[/\\]/g, '_').replace(/\.\./g, '_')
  if (!sanitized || sanitized === '.' || sanitized === '..')
    throw new Error(`Invalid appId for progress file: "${appId}"`)
  return sanitized
}

function getProgressPath(appId: string, baseDir?: string): string {
  return join(getOnboardingDir(baseDir), `${ANDROID_PREFIX}${sanitizeAppId(appId)}.json`)
}

export async function loadAndroidProgress(
  appId: string,
  baseDir?: string,
): Promise<AndroidOnboardingProgress | null> {
  const filePath = getProgressPath(appId, baseDir)
  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as AndroidOnboardingProgress
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

export async function saveAndroidProgress(
  appId: string,
  progress: AndroidOnboardingProgress,
  baseDir?: string,
): Promise<void> {
  const dir = getOnboardingDir(baseDir)
  await ensureSecureDirectory(dir, 0o700)
  const filePath = getProgressPath(appId, baseDir)
  await writeFileAtomic(filePath, JSON.stringify(progress, null, 2), { mode: 0o600 })
}

export async function deleteAndroidProgress(
  appId: string,
  baseDir?: string,
): Promise<void> {
  const filePath = getProgressPath(appId, baseDir)
  try {
    await unlink(filePath)
  }
  catch (err) {
    // ENOENT (file already absent) is the happy path — swallow only that.
    // EACCES / EPERM / EBUSY indicate a real problem the caller should see.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT')
      throw err
  }
}

/**
 * Validate that the keystore phase is genuinely complete.
 *
 * `completedSteps.keystoreReady` being set is necessary but not sufficient:
 * the ephemeral top-level fields (`keystoreStorePassword`, `keystoreAlias`,
 * `_keystoreBase64`) can race independently of the `completedSteps` write.
 * If any of these are missing, we treat the keystore phase as incomplete
 * and resume sends the user back to the matching input step instead of
 * letting `doSaveCredentials` crash with "keystore inputs missing".
 */
function keystoreFullyValid(progress: AndroidOnboardingProgress): boolean {
  if (!progress.completedSteps.keystoreReady)
    return false
  if (!progress.keystoreAlias)
    return false
  if (!progress.keystoreStorePassword)
    return false
  if (!progress._keystoreBase64)
    return false
  return true
}

/**
 * Routing into the keystore phase when validation fails. Called both for
 * never-completed-yet runs AND for partial-completion recovery (e.g. when a
 * race lost one of the top-level fields after `keystoreReady` was set).
 */
function keystoreResumeStep(progress: AndroidOnboardingProgress): AndroidOnboardingStep {
  if (progress.keystoreMethod === 'existing') {
    if (progress.keystoreAlias && progress.keystoreStorePassword && progress.keystoreExistingPath)
      return 'keystore-existing-key-password'
    if (progress.keystoreStorePassword && progress.keystoreExistingPath)
      return 'keystore-existing-detecting-alias'
    if (progress.keystoreExistingPath)
      return 'keystore-existing-store-password'
    return 'keystore-existing-path'
  }
  if (progress.keystoreMethod === 'generate') {
    if (progress.keystoreStorePassword && progress.keystoreAlias)
      return 'keystore-new-cn'
    if (progress.keystoreAlias) {
      // Once the user picks "manual", advance to the dedicated store-password
      // input so the step title changes and a stateless caller (the MCP) sees
      // clear forward progress. "random" auto-fills the password above, so it
      // never reaches this branch.
      if (progress.keystorePasswordManual)
        return 'keystore-new-store-password'
      return 'keystore-new-password-method'
    }
    return 'keystore-new-alias'
  }
  return 'keystore-method-select'
}

export function hasAnyOAuthProgress(progress: AndroidOnboardingProgress): boolean {
  return !!(
    progress.completedSteps.googleSignInComplete
    || progress.completedSteps.playAccountChosen
    || progress.completedSteps.gcpProjectChosen
    || progress.completedSteps.androidPackageChosen
    || progress._oauthRefreshToken
    || progress._oauthAccessToken
  )
}

/**
 * Post-save "tail" resume routing.
 *
 * Once `saving-credentials` completes, the wizard runs a shared tail:
 *   ask-build → requesting-build → detecting-ci-secrets → (ci-secrets sub-flow)
 *   → uploading-ci-secrets → (with-workflow) pick-package-manager →
 *   pick-build-script → preview/writing-workflow-file → build-complete
 * with a parallel `.env`-export leaf (ask-export-env → exporting-env) taken when
 * the user declines the GitHub Actions setup. This derivation mirrors the tail
 * `useEffect` + view handlers in `android/ui/app.tsx` step-for-step.
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
 * Returns `null` when no tail marker is present, so `getAndroidResumeStep` keeps
 * returning `saving-credentials` exactly as before — legacy/in-flight progress
 * files (which never carry these markers) are completely unaffected.
 */
function tailResumeStep(progress: AndroidOnboardingProgress): AndroidOnboardingStep | null {
  const { completedSteps } = progress

  // Tail not entered yet — let the caller fall through to `saving-credentials`.
  if (!completedSteps.credentialsSaved)
    return null

  // Phase 6a — Build request. The TUI's post-save entry point is the `ask-build`
  // user gate; the build itself fires only after the user confirms. Resuming
  // onto the gate (not `requesting-build`) is what prevents a double build on
  // resume.
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
      // in-memory progress (ui/app.tsx tailEngineNext) carries setupMode
      // 'undecided' pre-answer (its in-session router must keep its routing),
      // and the TUI never persists ciSecretTarget — the undefined shape is
      // MCP-slim-progress-only.
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

/**
 * Determine the first incomplete step for the Android flow.
 *
 * Each phase is validated by checking both:
 *   1. The `completedSteps.<phase>` marker (atomic write to a single field)
 *   2. The ephemeral fields the marker depends on (separate top-level writes
 *      that can race against each other and against the marker)
 *
 * If a marker is present but the ephemeral data is missing, the phase is
 * treated as incomplete — the user is routed back to the input step that
 * collects the missing field, never further forward.
 *
 * This is the contract that makes the state machine self-healing: any
 * inconsistent state on disk lands the user on a working input step instead
 * of crashing several phases later.
 */
export function getAndroidResumeStep(progress: AndroidOnboardingProgress | null): AndroidOnboardingStep {
  if (!progress)
    return 'welcome'

  const { completedSteps } = progress

  // Phase 0 — Data-safety gate (shared engine). When saved android credentials
  // already exist, the engine routes through `credentials-exist` (backup-or-
  // cancel choice) and, on backup, `backing-up` (the credentials.json → dated
  // copy) BEFORE entering the keystore phase — mirroring main's ink TUI. The
  // gate lifecycle lives in `_credentialsExistGate`; only 'pending'/'backup'
  // park the user on a gate step. 'done'/'cancel'/undefined fall through to the
  // normal keystore routing (the engine handles 'cancel' as a hard stop).
  if (progress._credentialsExistGate === 'pending')
    return 'credentials-exist'
  if (progress._credentialsExistGate === 'backup')
    return 'backing-up'

  // Phase 6 — Post-save "tail" (shared with iOS), checked BEFORE the keystore
  // phase. `credentialsSaved` is the unambiguous "save already happened"
  // marker: it means the whole provisioning sequence (OAuth or imported-SA)
  // finished and credentials.json was written, so we route THROUGH the tail
  // (build-request → CI-secrets → env/workflow). The MCP driver's post-save
  // progress is SLIM (markers + non-secret tail prefs ONLY — no keystore
  // fields; see mcp/tail-progress.ts), so the keystore validation below would
  // misroute it back to keystore-method-select (and re-trigger the
  // credentials-exist gate against the credentials the save itself just
  // wrote). Routing the marker first keeps the OAuth, import AND slim-MCP
  // paths converging on one tail router. When the marker is absent (every
  // legacy/in-flight progress file — the Ink TUI never persists post-save),
  // `tailResumeStep` returns null and the routing below is byte-for-byte
  // unchanged.
  const tailStep = tailResumeStep(progress)
  if (tailStep)
    return tailStep

  // Phase 1 — Keystore: marker + 3 ephemeral fields
  if (!keystoreFullyValid(progress))
    return keystoreResumeStep(progress)

  // Phase 2 — Service-account fork. Routes onto the import path or the OAuth
  // path. Legacy progress files don't have `serviceAccountMethod` — treat
  // those as OAuth (existing behavior) so in-flight onboardings continue
  // along the path they started on.
  if (progress.serviceAccountMethod === 'existing') {
    // Phase 2a — Import existing SA JSON.
    //
    // `_serviceAccountKeyBase64` is set once we accept the JSON (either
    // validation passed or the user picked "save anyway"). After that point
    // routing is identical to the OAuth path's tail: `saving-credentials`.
    if (progress._serviceAccountKeyBase64)
      return 'saving-credentials'

    // Package name confirmation is the first step inside the import path.
    if (!completedSteps.androidPackageChosen)
      return 'android-package-select'

    // We have a package but no accepted SA yet. If the user already picked a
    // file, jump back to validation; otherwise back to file selection.
    if (progress.serviceAccountJsonPath)
      return 'sa-json-validating'
    return 'sa-json-existing-path'
  }

  // Backward compatibility: legacy progress files (created before the
  // service-account fork existed) never set `serviceAccountMethod`. Per the
  // design contract those resume into the OAuth path they were already on.
  // Fresh progress files that reached the fork carry `serviceAccountForkSeen`,
  // so quitting before choosing can restore the method-select screen without
  // changing legacy behavior.
  if (
    progress.serviceAccountForkSeen
    && progress.serviceAccountMethod === undefined
    && !hasAnyOAuthProgress(progress)
  ) {
    return 'service-account-method-select'
  }

  // Phase 2b — Google sign-in: marker + a USABLE token. The MCP broker stores a short-lived access token
  // (re-sign-in on expiry); the TUI loopback stores a refresh token. A missing or expired token re-auths.
  const oauthTokenUsable = !!progress._oauthRefreshToken
    || (!!progress._oauthAccessToken && (!progress._oauthAccessTokenExpiresAt || progress._oauthAccessTokenExpiresAt > Date.now()))
  if (!completedSteps.googleSignInComplete || !oauthTokenUsable)
    return 'google-sign-in'

  // Phase 3 — Play developer account ID (paste).
  if (!completedSteps.playAccountChosen)
    return 'play-developer-id-input'

  // Phase 4 — GCP project pick or create.
  if (!completedSteps.gcpProjectChosen)
    return 'gcp-projects-loading'

  // Phase 4.5 — Android package (applicationId) to grant SA access to.
  if (!completedSteps.androidPackageChosen)
    return 'android-package-select'

  // Phase 4.6 — Verify the chosen package exists in Play Console before
  // provisioning (the per-package SA invite 400s on a non-existent package).
  // The verify effect always writes this marker (verified true OR false on a
  // degraded check) before advancing, so this never loops.
  //
  // Re-verify if the marker is for a DIFFERENT package than the one currently
  // chosen (the user changed the package after a prior verify/proceed) - a stale
  // marker must not skip the gate for the new package.
  //
  // Backward-compat guard: only gate FRESH flows. Legacy / in-flight progress
  // recorded before this step existed (or any resume that already provisioned)
  // has no playAppVerified marker but must NOT be re-routed into the new gate;
  // if any provisioning marker is present, fall through to the Phase 5 / tail
  // routing below instead.
  const verifiedMarker = completedSteps.playAppVerified
  const chosenPackage = completedSteps.androidPackageChosen?.packageName
  const verifyMatchesChosen = !!verifiedMarker && verifiedMarker.packageName === chosenPackage
  if (
    !verifyMatchesChosen
    && !completedSteps.serviceAccountProvisioned
    && !completedSteps.playInviteProvisioned
    && !progress._serviceAccountKeyBase64
  ) {
    return 'android-app-verify'
  }

  // Phase 5 — Provisioning: SA creation marker + the SA's JSON key that
  // gets saved as PLAY_CONFIG_JSON. Missing either means we must re-run
  // the provisioning sequence.
  if (
    !completedSteps.serviceAccountProvisioned
    || !completedSteps.playInviteProvisioned
    || !progress._serviceAccountKeyBase64
  ) {
    return 'gcp-setup-running'
  }

  return 'saving-credentials'
}

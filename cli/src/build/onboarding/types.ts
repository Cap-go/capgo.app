// src/build/onboarding/types.ts

import type { TailProgress } from './tail-types.js'

export type Platform = 'ios' | 'android' | 'appflow'

// The outcome a wizard app reports to the shell/command when Ink exits, so the
// caller can print an accurate post-exit message instead of always claiming
// success. The shell defaults to `cancelled`; an app flips it to `completed`
// (with a durable summary) only when it actually reaches the build-complete
// screen. This fixes the false "✔ onboarding complete" that printed on every
// exit path (missing-platform, user-cancel, etc.).
export interface OnboardingCompletionSummary {
  /** The Capgo dashboard build URL, when a build was kicked off. */
  buildUrl?: string
  /** One-line CI-secret upload summary, when secrets were pushed. */
  ciSecretUploadSummary?: string | null
  /** Path to the generated GitHub Actions workflow file, when written. */
  workflowFilePath?: string | null
  /** Path to the exported .env file, when the user chose the env-export fallback. */
  envExportPath?: string | null
  /** The "run anytime" build-request command shown on the final screen. */
  buildRequestCommand?: string
}

export interface OnboardingResult {
  // `update-requested` means the user accepted the self-update prompt (the
  // first wizard screen, when a newer @capgo/cli exists). The caller tears Ink
  // down, then installs + re-execs OUTSIDE the alt-screen — the spawn needs the
  // primary buffer + stdio inheritance, which it cannot get while Ink is mounted.
  outcome: 'completed' | 'cancelled' | 'update-requested'
  /** Present only when outcome === 'completed'. */
  summary?: OnboardingCompletionSummary
}

export type OnboardingStep
  = | 'welcome'
    | 'resume-prompt'
    | 'platform-select'
    | 'adding-platform'
    | 'credentials-exist'
    | 'backing-up'
    // ── Setup-method fork (macOS only) ──
    | 'setup-method-select'
    // ── Import-existing sub-flow (macOS only) ──
    | 'import-scanning'
    | 'import-distribution-mode'
    | 'import-pick-identity'
    | 'import-pick-profile'
    | 'import-validating-all-certs'
    | 'import-checking-apple-cert'
    | 'import-no-match-recovery'
    | 'import-portal-explanation'
    | 'import-provide-profile-path'
    | 'import-create-profile-only'
    | 'import-export-warning'
    | 'import-exporting'
    // ── Existing create-new sub-flow (and ASC API key step reused by import for app_store) ──
    // Do-you-have-a-.p8 fork: have one → existing import; none + macOS → create.
    | 'p8-source-select'
    | 'asc-key-generating'
    | 'asc-key-created'
    | 'api-key-instructions'
    | 'p8-method-select'
    | 'input-p8-path'
    | 'input-key-id'
    | 'input-issuer-id'
    | 'verifying-key'
    | 'verify-app'
    | 'creating-certificate'
    | 'cert-limit-prompt'
    | 'revoking-certificate'
    | 'creating-profile'
    | 'duplicate-profile-prompt'
    | 'deleting-duplicate-profiles'
    | 'saving-credentials'
    | 'detecting-ci-secrets'
    | 'ci-secrets-setup'
    | 'ci-secrets-target-select'
    | 'ask-ci-secrets'
    | 'checking-ci-secrets'
    | 'confirm-ci-secret-overwrite'
    | 'uploading-ci-secrets'
    | 'ci-secrets-failed'
    // GitHub Actions workflow + .env export sub-flow (post-secrets-upload)
    | 'ask-github-actions-setup'
    | 'confirm-secrets-push'
    | 'ask-export-env'
    | 'exporting-env'
    | 'confirm-env-export-overwrite'
    | 'overwrite-and-export-env'
    | 'pick-package-manager'
    | 'pick-build-script'
    | 'pick-build-script-custom'
    | 'preview-workflow-file'
    | 'view-workflow-diff'
    | 'writing-workflow-file'
    | 'ask-build'
    | 'requesting-build'
    // AI debug — only entered when the build fails and logs were captured
    | 'ai-analysis-prompt'
    | 'ai-analysis-running'
    | 'ai-analysis-result'
    | 'ai-analysis-result-scroll'
    | 'build-complete'
    | 'no-platform'
    | 'error'
    // Contact-support confirmation gate (shown before we save logs + open mail)
    | 'support-confirm'
    // Scrollable viewer of the exact bundle, reached from the confirm's "View logs first"
    | 'support-log-view'
    // Spinner while the bundle uploads to Capgo support
    | 'support-uploading'

export type OnboardingErrorCategory
  = | 'apple_api_unauthorized'
    | 'apple_api_forbidden'
    | 'apple_agreements_missing'
    | 'apple_api_rate_limited'
    | 'cert_limit_reached'
    | 'profile_creation_failed'
    | 'p8_invalid'
    // Import-existing flow (keychain / provisioning profile imports)
    | 'keychain_no_identities'
    | 'keychain_export_failed'
    | 'profile_no_match'
    | 'profile_read_failed'
    | 'unknown'

export interface ApiKeyData {
  keyId: string
  issuerId: string
}

/**
 * Per-identity result of the eager Apple-side validation run. Populated by
 * the `import-validating-all-certs` step useEffect, consumed by the two-
 * table picker in `import-pick-identity`. Kept here (alongside the Step
 * type) so the renderer and the validation logic share a single shape.
 */
export interface EnrichedIdentityAvailability {
  /** True when Apple's API returned a SHA1 match for this identity. */
  available: boolean
  /**
   * Stable reason code for unavailable identities. Drives the per-reason
   * detail rendering in the unavailable table (e.g. notice about the
   * Apple-managed signing constraint, or about private-key-missing).
   */
  reason?: 'expired' | 'managed' | 'not-visible' | 'check-failed' | 'no-private-key'
  /** One-line summary shown in the Reason column of the unavailable table. */
  reasonText?: string
  /** When available — Apple-side cert resource id, reused downstream. */
  appleCertId?: string
  /**
   * Apple-side cert name as returned by /v1/certificates. Useful when
   * the local Keychain name differs from the portal name (e.g. multiple
   * "iOS Distribution" certs in the same team — the portal column says
   * exactly which one).
   */
  appleCertName?: string
  /**
   * ISO timestamp from Apple's expiration field. Shown in the manual-
   * portal walkthrough so the user can tell which row to click when
   * multiple certs are listed.
   */
  appleCertExpirationDate?: string
  /**
   * Full serial number from Apple. The portal shows it in the cert
   * detail view; surfacing the last 8 chars here gives the user a
   * concrete disambiguator without leaking the full 40-byte serial
   * into the terminal.
   */
  appleCertSerialNumber?: string
}

export interface CertificateData {
  certificateId: string
  expirationDate: string
  teamId: string
  p12Base64: string
}

export interface ProfileData {
  profileId: string
  profileName: string
  profileBase64: string
}

// ─── Post-save "tail" milestones (shared with android) ───────────────────────
//
// Mirror the android `CredentialsSaved` / `BuildRequested` / `CiSecretsUploaded`
// markers so `getIosResumeStep` can route a saved progress THROUGH the shared
// post-save tail (CI-secrets → env-export → workflow-file → build-request)
// without re-running a side-effecting step. Each is a marker in the same
// self-healing style as the cert/profile markers: presence means "this
// irreversible step already happened — do NOT do it again". Absent on every
// legacy/in-flight progress file → `tailResumeStep` returns null and resume is
// unchanged (terminal stays `saving-credentials`).

export interface IosCredentialsSaved {
  /** ISO timestamp credentials.json was written — purely informational. */
  savedAt: string
}

export interface IosBuildRequested {
  /** The build dashboard URL surfaced after the queue request succeeded. */
  buildUrl: string
}

export interface IosCiSecretsUploaded {
  /** Provider the secrets were pushed to (matches the chosen ciSecretTarget). */
  provider: 'github' | 'gitlab'
  /** How many env vars were pushed — informational. */
  count: number
}

export interface OnboardingProgress extends TailProgress {
  platform: Platform
  appId: string
  startedAt: string
  /** Path to the .p8 file on disk (content is NOT stored, only the path) */
  p8Path?: string
  /** Partial input — saved incrementally so resume works mid-flow */
  keyId?: string
  issuerId?: string
  /**
   * Records which fork the user picked at `setup-method-select`. Crucial for
   * resume — without this, a partial import-flow run would resume at
   * `creating-certificate` (the create-new path) and immediately hit the
   * Apple cert-limit error.
   *
   * Absent on legacy progress files (created before this field existed) →
   * resume defaults to `create-new` for backward compatibility.
   */
  setupMethod?: 'create-new' | 'import-existing'
  /**
   * Records how the user chose to obtain the .p8 in the create-new flow's
   * source fork (`p8-source-select`):
   *   - `automated` — picked "No — create one for me": the guided macOS helper
   *                   creates + captures the key. (Its in-window intro screen
   *                   still lets the user switch to manual, which re-persists
   *                   `manual` from the asc-key-generating effect.)
   *   - `manual`    — the user has a .p8, or chose to create one by hand at App
   *                   Store Connect, and enters it via `api-key-instructions`.
   *
   * Persisted so a quit-and-resume lands the user back where they chose to be:
   * an `automated` user resumes on the helper (`asc-key-generating`), NOT the
   * manual .p8 picker. Absent on legacy files and on the import flow.
   * Only meaningful when `setupMethod === 'create-new'`.
   */
  p8CreateMethod?: 'automated' | 'manual'
  /**
   * Records the distribution mode picked at `import-distribution-mode`.
   *
   * Persisted (not derived from .p8 presence) because ad_hoc users can
   * legitimately enter a one-shot .p8 during no-match recovery, which would
   * otherwise make .p8-presence-implies-app_store an incorrect heuristic. On
   * resume the UI hydrates `importDistribution` from this field so the
   * `verifying-key` branch and `doSaveCredentials` route correctly.
   *
   * Only meaningful when `setupMethod === 'import-existing'`.
   */
  importDistribution?: 'app_store' | 'ad_hoc'
  /**
   * The resolved iOS bundle id (the authoritative Release
   * `PRODUCT_BUNDLE_IDENTIFIER`) when it differs from `capacitor.config.appId`.
   * Used for Apple-side operations (cert lookup, profile filtering,
   * `ensureBundleId`, `createProfile`) and as the key in the provisioning_map.
   * The progress-file key and Capgo SaaS API calls still use `appId` so existing
   * build commands keep finding these credentials without editing
   * `capacitor.config`.
   *
   * Persisted so verify-app / redirectIfMismatch don't re-resolve on resume —
   * once set, the override sticks unless the configuration context (see
   * `iosBundleIdContextAppId`) changes between CLI runs.
   */
  iosBundleIdOverride?: string
  /**
   * Snapshot of `config.appId` at the time the `iosBundleIdOverride` was
   * resolved. On the next run we compare this to the current `config.appId`;
   * if it changed (user renamed the app, added/removed a dev-tunnel suffix,
   * etc.) the saved override is stale and we re-resolve / re-verify via the
   * verify-app step. Without this we'd silently keep using a bundle id the
   * user already moved on from.
   */
  iosBundleIdContextAppId?: string
  /**
   * LEGACY (engine-era confirm-app-id gate, removed by PR #2397). Older CLI
   * versions persisted this when the user confirmed the bundle id at the
   * now-removed `confirm-app-id` step. No code reads it anymore — the driver
   * silently adopts the authoritative Release bundle id and the remote
   * `verify-app` step owns the bundle-id invariant (see `iosBundleIdOverride`).
   * Kept in the type only so older progress files keep parsing; resume IGNORES
   * it (see test-ios-confirm-app-id.mjs).
   */
  appIdConfirmed?: boolean
  /**
   * LEGACY (engine-era confirm-app-id gate, removed by PR #2397). The router
   * target the removed `confirm-app-id` step would have returned to. No code
   * reads it anymore; resume IGNORES it so a stale value can never park the
   * wizard on a step that no longer renders (see test-ios-confirm-app-id.mjs).
   */
  pendingAppIdNext?: OnboardingStep
  /**
   * Lifecycle of the iOS data-safety gate that runs BEFORE the setup-method
   * fork when saved iOS credentials already exist for this appId. Mirrors the
   * android `_credentialsExistGate` marker so the gate is resume-derivable
   * instead of living only in the TUI's `setStep` calls:
   *   - 'pending' → saved iOS credentials exist; awaiting the user's
   *                 backup-or-cancel choice (the `credentials-exist` step)
   *   - 'backup'  → user chose backup; the `backing-up` effect must still run
   *   - 'done'    → backup performed (or source absent); proceed to setup
   *   - 'cancel'  → user chose to stop; onboarding halts to protect the
   *                 existing credentials
   *
   * Absent on legacy/in-flight progress files → treated as "no gate", so the
   * resume routing is unchanged for every existing progress file.
   *
   * ADDITIVE (BATCH 0): only consumed by `getIosResumeStep`'s Phase-0 gate.
   */
  _credentialsExistGate?: 'pending' | 'backup' | 'done' | 'cancel'
  /**
   * Which step triggered the `duplicate-profile-prompt`, so the post-deletion
   * effect (`deleting-duplicate-profiles`) can route back to the right place on
   * resume. The prompt is dual-origin: `creating-profile` reaches it on the
   * create-new path, and `import-create-profile-only` reaches it on the import
   * path. Persisting the origin prevents an import user from being routed back
   * into the create-new `creating-profile` step (the exact class of resume bug
   * the `setupMethod` branch was added to prevent).
   *
   * ADDITIVE (BATCH 0): persisted now so the engine surface is total; the
   * effect that reads it is wired in a later batch.
   */
  duplicateProfileOrigin?: 'creating-profile' | 'import-create-profile-only'
  /**
   * Deferred recovery branch after the import `.p8` input chain. When the user
   * picks "create" in `import-no-match-recovery` but has no ASC API key yet, the
   * flow detours through `api-key-instructions` → `verifying-key` and must
   * return to `import-create-profile-only` afterwards. Persisting the pending
   * action (e.g. `'create-profile-only'`) lets resume restore that deferred
   * target instead of dropping the user at the picker.
   *
   * ADDITIVE (BATCH 0): persisted now so the engine surface is total; the
   * routing that reads it is wired in a later batch.
   */
  pendingRecoveryAction?: string
  completedSteps: {
    apiKeyVerified?: ApiKeyData
    certificateCreated?: CertificateData
    profileCreated?: ProfileData
    // ── Post-save "tail" milestones (shared with android) ──
    // Present only once the matching side-effecting tail step has finished, so
    // `getIosResumeStep` can route a saved progress THROUGH the tail without
    // re-running an irreversible step. Absent on every legacy/in-flight file →
    // resume falls through to `saving-credentials` exactly as before.
    /** Set once `saving-credentials` wrote credentials.json. Gates tail entry. */
    credentialsSaved?: IosCredentialsSaved
    /** Set once `requesting-build` queued a build. Guards a double build-request. */
    buildRequested?: IosBuildRequested
    /** Set once `uploading-ci-secrets` pushed the secrets. Guards a re-upload. */
    ciSecretsUploaded?: IosCiSecretsUploaded
  }
  /** Temporary — wiped after .p12 creation */
  _privateKeyPem?: string
}

/** Maps each step to a progress percentage (0-100) */
export const STEP_PROGRESS: Record<OnboardingStep, number> = {
  'welcome': 0,
  'resume-prompt': 2,
  'platform-select': 0,
  'adding-platform': 0,
  'credentials-exist': 0,
  'backing-up': 0,
  // Import-existing sub-flow (re-ordered: distribution-mode first)
  'setup-method-select': 5,
  'import-scanning': 10,
  'import-distribution-mode': 15,
  'import-pick-identity': 40,
  'import-pick-profile': 55,
  'import-validating-all-certs': 38,
  'import-checking-apple-cert': 50,
  'import-no-match-recovery': 55,
  'import-portal-explanation': 56,
  'import-provide-profile-path': 58,
  'import-create-profile-only': 60,
  'import-export-warning': 70,
  'import-exporting': 75,
  // Create-new sub-flow — must sit above setup-method-select (5) so the bar
  // doesn't move backwards entering the fork, and the two steps differ so it
  // advances between them.
  'p8-source-select': 6,
  'asc-key-generating': 22,
  'asc-key-created': 24,
  'api-key-instructions': 5,
  'p8-method-select': 8,
  'input-p8-path': 10,
  'input-key-id': 12,
  'input-issuer-id': 18,
  'verifying-key': 25,
  'verify-app': 30,
  'creating-certificate': 45,
  'cert-limit-prompt': 45,
  'revoking-certificate': 48,
  'creating-profile': 65,
  'duplicate-profile-prompt': 65,
  'deleting-duplicate-profiles': 68,
  'saving-credentials': 80,
  'detecting-ci-secrets': 82,
  'ci-secrets-setup': 82,
  'ci-secrets-target-select': 82,
  'ask-ci-secrets': 82,
  'checking-ci-secrets': 83,
  'confirm-ci-secret-overwrite': 83,
  'uploading-ci-secrets': 84,
  'ci-secrets-failed': 84,
  // GitHub Actions + .env export branch — all post-build, mid-90s progress
  'ask-github-actions-setup': 82,
  'confirm-secrets-push': 83,
  'ask-export-env': 95,
  'exporting-env': 96,
  'confirm-env-export-overwrite': 96,
  'overwrite-and-export-env': 96,
  'pick-package-manager': 95,
  'pick-build-script': 96,
  'pick-build-script-custom': 96,
  'preview-workflow-file': 97,
  'view-workflow-diff': 97,
  'writing-workflow-file': 98,
  'ask-build': 85,
  'requesting-build': 90,
  'ai-analysis-prompt': 92,
  'ai-analysis-running': 95,
  'ai-analysis-result-scroll': 97,
  'ai-analysis-result': 98,
  'build-complete': 100,
  'no-platform': 0,
  'error': 0,
  'support-confirm': 0,
  'support-log-view': 0,
  'support-uploading': 0,
}

export function getPhaseLabel(step: OnboardingStep): string {
  switch (step) {
    case 'welcome':
    case 'platform-select':
    case 'adding-platform':
    case 'credentials-exist':
    case 'backing-up':
      return ''
    case 'resume-prompt':
      return 'Resume or restart?'
    case 'setup-method-select':
      return 'Setup method'
    case 'verify-app':
      return 'Verify App Store app'
    case 'import-scanning':
      return 'Step 1 of 4 · Scanning your Mac'
    case 'import-distribution-mode':
      return 'Step 1 of 4 · Distribution mode'
    case 'import-pick-identity':
      return 'Step 2 of 4 · Choose certificate'
    case 'import-validating-all-certs':
      return 'Step 2 of 4 · Validating certificates with Apple'
    case 'import-pick-profile':
      return 'Step 3 of 4 · Choose provisioning profile'
    case 'import-checking-apple-cert':
      return 'Step 3 of 4 · Checking certificate on Apple'
    case 'import-no-match-recovery':
      return 'Step 3 of 4 · No matching profile — recover'
    case 'import-portal-explanation':
      return 'Step 3 of 4 · Manual portal walkthrough'
    case 'import-provide-profile-path':
      return 'Step 3 of 4 · Provide .mobileprovision file'
    case 'import-create-profile-only':
      return 'Step 3 of 4 · Creating profile via Apple'
    case 'import-export-warning':
    case 'import-exporting':
      return 'Step 4 of 4 · Export from Keychain'
    case 'p8-source-select':
    case 'asc-key-generating':
    case 'asc-key-created':
    case 'api-key-instructions':
    case 'p8-method-select':
    case 'input-p8-path':
    case 'input-key-id':
    case 'input-issuer-id':
    case 'verifying-key':
      return 'Step 1 of 4 · App Store Connect API Key'
    case 'creating-certificate':
    case 'cert-limit-prompt':
    case 'revoking-certificate':
      return 'Step 2 of 4 · Distribution Certificate'
    case 'creating-profile':
    case 'duplicate-profile-prompt':
    case 'deleting-duplicate-profiles':
      return 'Step 3 of 4 · Provisioning Profile'
    case 'saving-credentials':
    case 'detecting-ci-secrets':
    case 'ci-secrets-setup':
    case 'ci-secrets-target-select':
    case 'ask-ci-secrets':
    case 'ask-github-actions-setup':
    case 'confirm-secrets-push':
    case 'checking-ci-secrets':
    case 'confirm-ci-secret-overwrite':
    case 'uploading-ci-secrets':
    case 'ci-secrets-failed':
    case 'ask-export-env':
    case 'exporting-env':
    case 'confirm-env-export-overwrite':
    case 'overwrite-and-export-env':
    case 'pick-package-manager':
    case 'pick-build-script':
    case 'pick-build-script-custom':
    case 'preview-workflow-file':
    case 'view-workflow-diff':
    case 'writing-workflow-file':
    case 'ask-build':
    case 'requesting-build':
      return 'Step 4 of 4 · Save & Build'
    case 'ai-analysis-prompt':
    case 'ai-analysis-running':
    case 'ai-analysis-result':
    case 'ai-analysis-result-scroll':
      return 'AI debug'
    case 'build-complete':
      return 'Complete'
    case 'no-platform':
    case 'error':
    case 'support-confirm':
    case 'support-log-view':
    case 'support-uploading':
      return ''
  }
}

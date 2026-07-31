// src/build/onboarding/android/types.ts

import type { TailProgress } from '../tail-types.js'

export type AndroidOnboardingStep
  = | 'welcome'
    | 'resume-prompt'
    | 'credentials-exist'
    | 'backing-up'
    | 'no-platform'
  // Phase 1 — Keystore (automated)
    | 'keystore-method-select'
    | 'keystore-explainer'
    | 'keystore-existing-path'
    | 'keystore-existing-picker'
    | 'keystore-existing-store-password'
    | 'keystore-existing-detecting-alias'
    | 'keystore-existing-alias-select'
    | 'keystore-existing-alias'
    | 'keystore-existing-key-password'
    | 'keystore-new-alias'
    | 'keystore-new-password-method'
    | 'keystore-new-store-password'
    | 'keystore-new-key-password'
    | 'keystore-new-cn'
    | 'keystore-generating'
  // Phase 2 — Service account method fork: existing JSON vs. OAuth provisioning
    | 'service-account-method-select'
  // Phase 2a — Import existing service account JSON
    | 'sa-json-existing-path'
    | 'sa-json-existing-picker'
    | 'sa-json-validating'
    | 'sa-json-validation-failed'
  // Phase 2b — Google sign-in (OAuth)
    | 'google-sign-in'
    | 'google-sign-in-running'
  // Phase 3 — Play developer account ID (pasted by the user — Play Developer API
  // has no endpoint to enumerate accounts, so the user copies the ID from the
  // Play Console URL)
    | 'play-developer-id-input'
  // Phase 4 — GCP project pick or create
    | 'gcp-projects-loading'
    | 'gcp-projects-select'
    | 'gcp-project-create-name'
  // Phase 4.5 — Pick the Android package name to grant SA access to
    | 'android-package-select'
  // Phase 4.6 — Verify the chosen package actually exists in the user's Play
  // Console (apps:search). Generate path only; gates provisioning because the
  // per-package SA invite 400s on a package that doesn't exist yet.
    | 'android-app-verify'
  // Phase 5 — Automated provisioning (create project if needed, enable API, SA, key, invite)
    | 'gcp-setup-running'
  // Phase 6 — Save + build
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
    | 'error'
    // Contact-support confirmation gate (shown before we save logs + open mail)
    | 'support-confirm'
    // Scrollable viewer of the exact bundle, reached from the confirm's "View logs first"
    | 'support-log-view'
    // Spinner while the bundle uploads to Capgo support
    | 'support-uploading'

export type AndroidOnboardingErrorCategory
  = | 'keystore_invalid'
    | 'google_oauth_failed'
    | 'play_account_id_invalid'
    // Imported service-account JSON validation failures. Each value mirrors
    // the corresponding `ValidationResult.kind` from
    // `service-account-validation.ts` so PostHog funnel analysis can
    // distinguish "wrong file" from "SA not invited to app" from "transient
    // network/server issue" — each implies a different recovery for the user.
    | 'sa_json_shape_invalid'
    | 'sa_json_token_rejected'
    | 'sa_json_no_app_access'
    | 'sa_json_network_error'
    | 'unknown'

export type KeystoreMethod = 'existing' | 'generate'
export type ServiceAccountMethod = 'existing' | 'generate'

export interface KeystoreReady {
  keystorePath: string
  alias: string
  isGenerated: boolean
}

export interface GoogleSignInComplete {
  email: string
  googleSubject: string
  scope: string
}

export interface PlayDeveloperAccountChoice {
  developerId: string
  displayName?: string
}

export interface GcpProjectChoice {
  projectId: string
  projectNumber?: string
  displayName: string
  /** Whether this onboarding run created the project (vs. reusing an existing one). */
  createdByOnboarding: boolean
}

export interface ServiceAccountProvisioned {
  email: string
  projectId: string
  uniqueId?: string
}

export interface PlayInviteProvisioned {
  developerId: string
  serviceAccountEmail: string
}

export interface AndroidPackageChoice {
  /** The Android applicationId that Play Console uses for this app. */
  packageName: string
  /** How we picked it — useful for telemetry / resume clarity. */
  source: 'gradle' | 'capacitor-config' | 'user-input'
}

// ── Post-save "tail" completion markers ──────────────────────────────────────
// One marker per irreversible tail side-effect. They mirror the provisioning
// markers above (small, JSON-serializable proof-of-completion objects) so the
// resume router can skip past a step that already ran without re-firing it.

export interface CredentialsSaved {
  /** ISO timestamp credentials.json was written — purely informational. */
  savedAt: string
}

export interface BuildRequested {
  /** The build dashboard URL surfaced after the queue request succeeded. */
  buildUrl: string
}

export interface CiSecretsUploaded {
  /** Provider the secrets were pushed to (matches the chosen ciSecretTarget). */
  provider: 'github' | 'gitlab'
  /** How many env vars were pushed — informational. */
  count: number
}

export interface AndroidOnboardingProgress extends TailProgress {
  platform: 'android'
  appId: string
  startedAt: string

  // Keystore — partial input for resume
  keystoreMethod?: KeystoreMethod
  keystoreExistingPath?: string
  keystoreAlias?: string
  keystoreStorePassword?: string
  keystoreKeyPassword?: string
  keystoreCommonName?: string

  // Set when a fresh run completes keystore setup and becomes eligible to
  // show `service-account-method-select`. This lets resume return to the fork
  // if the user quits before choosing while still letting legacy progress
  // files (without the marker) default to OAuth.
  serviceAccountForkSeen?: true
  // Service account fork — set when the user chooses existing JSON or Google
  // OAuth provisioning. Absent on legacy progress files (pre-2026-05) → resume
  // defaults to `generate` so existing in-flight onboardings continue on the
  // OAuth path they started on.
  serviceAccountMethod?: ServiceAccountMethod
  // Import path — path the user picked at `sa-json-existing-path` /
  // `sa-json-existing-picker`. The file is read fresh at validation time so
  // we never persist its contents to disk before the user explicitly accepts.
  serviceAccountJsonPath?: string
  // Set when the user picks "Save anyway" at `sa-json-validation-failed`.
  // Read at `saving-credentials` to surface a yellow banner — does not affect
  // routing.
  serviceAccountValidationSkipped?: boolean

  // Chosen project name for a fresh create — remembered while the async op runs
  pendingNewProjectId?: string
  pendingNewProjectDisplayName?: string

  completedSteps: {
    keystoreReady?: KeystoreReady
    googleSignInComplete?: GoogleSignInComplete
    playAccountChosen?: PlayDeveloperAccountChoice
    gcpProjectChosen?: GcpProjectChoice
    androidPackageChosen?: AndroidPackageChoice
    /** Set once the chosen package was verified to exist in the user's Play
     *  Console (apps:search exact-match), or the user explicitly proceeded past
     *  a degraded/un-verifiable check. Gates `gcp-setup-running` so the
     *  per-package SA invite never 400s on a non-existent package. */
    playAppVerified?: { packageName: string, verified: boolean }
    serviceAccountProvisioned?: ServiceAccountProvisioned
    playInviteProvisioned?: PlayInviteProvisioned
    // ── Post-save "tail" milestones (additive — present only once the
    // matching side-effecting tail step has finished). They let
    // `getAndroidResumeStep` route a saved progress THROUGH the tail
    // (CI-secrets → env-export → workflow-file → build-request) without
    // re-running a side-effecting step. Each is a marker in the same
    // self-healing style as the provisioning markers above: presence means
    // "this irreversible step already happened — do NOT do it again".
    //
    // The headless engine deletes the on-disk progress file at
    // `saving-credentials` today, so these markers are written by whichever
    // driver chooses to persist the tail for resume (the Ink TUI migration in
    // a later phase). When absent, resume falls through to `saving-credentials`
    // exactly as before — so legacy/in-flight progress files are unaffected.

    /** Set once `saving-credentials` wrote credentials.json. Gates tail entry. */
    credentialsSaved?: CredentialsSaved
    /** Set once `requesting-build` queued a build. Guards a double build-request. */
    buildRequested?: BuildRequested
    /** Set once `uploading-ci-secrets` pushed the secrets. Guards a re-upload. */
    ciSecretsUploaded?: CiSecretsUploaded
  }

  // Ephemeral — wiped when onboarding finishes. Held on disk only so resume
  // across a crash doesn't force a full re-auth. NEVER written to credentials.
  _oauthRefreshToken?: string
  // MCP broker OAuth (access-token model). The MCP process can't refresh a token issued to the broker's
  // confidential Web client, so it stores the short-lived access token + its expiry and re-signs-in on expiry.
  _oauthAccessToken?: string
  _oauthAccessTokenExpiresAt?: number
  // In-flight broker sign-in handle — persisted so polling survives the MCP process restarting between calls.
  _brokerOAuth?: { pubId: string, pollSecret: string, signInUrl: string, expiresAt: number }
  _keystoreBase64?: string
  /** Base64 of the downloaded SA JSON key — saved as PLAY_CONFIG_JSON at end. */
  _serviceAccountKeyBase64?: string
  // ── MCP markers (added by the shared engine; harmless to the ink TUI) ──
  /** Platform whose onboarding is currently in-flight. */
  activePlatform?: 'android'
  /** True when the new-keystore password was auto-generated (random). Never logged. */
  keystorePasswordGenerated?: boolean
  /** True once the user chose the MANUAL password method (lets the stateless MCP advance). */
  keystorePasswordManual?: boolean
  /**
   * Data-safety gate state for the shared engine (mirrors main's ink TUI
   * `credentials-exist` → `backing-up` flow). The Ink driver does not read this
   * field — it gates the same situation via React state — so it is harmless to
   * the TUI. Lifecycle:
   *   - undefined → gate not yet evaluated (or no saved credentials exist)
   *   - 'pending' → saved android credentials exist; awaiting the user's
   *                 backup-or-cancel choice (the `credentials-exist` step)
   *   - 'backup'  → user chose backup; the `backing-up` effect must still run
   *   - 'done'    → backup performed (or source absent); proceed to keystore
   *   - 'cancel'  → user chose to stop; onboarding halts to protect the
   *                 existing credentials (mirrors main's exitOnboarding())
   */
  _credentialsExistGate?: 'pending' | 'backup' | 'done' | 'cancel'
}

export const ANDROID_STEP_PROGRESS: Record<AndroidOnboardingStep, number> = {
  'welcome': 0,
  'resume-prompt': 2,
  'credentials-exist': 0,
  'backing-up': 0,
  'no-platform': 0,

  'keystore-method-select': 5,
  'keystore-explainer': 5,
  'keystore-existing-path': 8,
  'keystore-existing-picker': 8,
  'keystore-existing-store-password': 10,
  'keystore-existing-detecting-alias': 12,
  'keystore-existing-alias-select': 13,
  'keystore-existing-alias': 13,
  'keystore-existing-key-password': 14,
  'keystore-new-alias': 8,
  'keystore-new-password-method': 10,
  'keystore-new-store-password': 12,
  'keystore-new-key-password': 14,
  'keystore-new-cn': 16,
  'keystore-generating': 20,

  'service-account-method-select': 22,

  // Import path keeps the bar moving without leaping past the OAuth path's
  // matching milestones (Google sign-in lands at 35, GCP setup at 70).
  'sa-json-existing-path': 28,
  'sa-json-existing-picker': 28,
  'sa-json-validating': 70,
  'sa-json-validation-failed': 70,

  'google-sign-in': 25,
  'google-sign-in-running': 35,

  'play-developer-id-input': 48,

  'gcp-projects-loading': 55,
  'gcp-projects-select': 58,
  'gcp-project-create-name': 60,

  'android-package-select': 65,
  'android-app-verify': 67,

  'gcp-setup-running': 70,

  'saving-credentials': 85,
  'detecting-ci-secrets': 86,
  'ci-secrets-setup': 86,
  'ci-secrets-target-select': 86,
  'ask-ci-secrets': 86,
  'checking-ci-secrets': 87,
  'confirm-ci-secret-overwrite': 87,
  'uploading-ci-secrets': 88,
  'ci-secrets-failed': 88,
  // GitHub Actions + .env export branch — post-build, ~96
  'ask-github-actions-setup': 86,
  'confirm-secrets-push': 87,
  'ask-export-env': 96,
  'exporting-env': 96,
  'confirm-env-export-overwrite': 96,
  'overwrite-and-export-env': 96,
  'pick-package-manager': 95,
  'pick-build-script': 96,
  'pick-build-script-custom': 96,
  'preview-workflow-file': 97,
  'view-workflow-diff': 97,
  'writing-workflow-file': 98,
  'ask-build': 90,
  'requesting-build': 95,
  'ai-analysis-prompt': 96,
  'ai-analysis-running': 98,
  'ai-analysis-result-scroll': 98,
  'ai-analysis-result': 99,
  'build-complete': 100,
  'error': 0,
  'support-confirm': 0,
  'support-log-view': 0,
  'support-uploading': 0,
}

export function getAndroidPhaseLabel(step: AndroidOnboardingStep): string {
  switch (step) {
    case 'welcome':
    case 'credentials-exist':
    case 'backing-up':
    case 'no-platform':
      return ''
    case 'resume-prompt':
      return 'Resume or restart?'
    case 'keystore-method-select':
    case 'keystore-explainer':
    case 'keystore-existing-path':
    case 'keystore-existing-picker':
    case 'keystore-existing-store-password':
    case 'keystore-existing-detecting-alias':
    case 'keystore-existing-alias-select':
    case 'keystore-existing-alias':
    case 'keystore-existing-key-password':
    case 'keystore-new-alias':
    case 'keystore-new-password-method':
    case 'keystore-new-store-password':
    case 'keystore-new-key-password':
    case 'keystore-new-cn':
    case 'keystore-generating':
      return 'Step 1 of 4 · Keystore'
    case 'service-account-method-select':
      return 'Step 2 of 4 · Service account'
    case 'sa-json-existing-path':
    case 'sa-json-existing-picker':
    case 'sa-json-validating':
    case 'sa-json-validation-failed':
      return 'Step 3 of 4 · Service account'
    case 'google-sign-in':
    case 'google-sign-in-running':
      return 'Step 2 of 4 · Sign in with Google'
    case 'play-developer-id-input':
      return 'Step 3 of 4 · Play Developer Account'
    case 'gcp-projects-loading':
    case 'gcp-projects-select':
    case 'gcp-project-create-name':
    case 'android-package-select':
    case 'android-app-verify':
    case 'gcp-setup-running':
      return 'Step 3 of 4 · Google Cloud Project'
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
    case 'error':
    case 'support-confirm':
    case 'support-log-view':
    case 'support-uploading':
      return ''
  }
}

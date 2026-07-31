// src/build/onboarding/android/flow.ts
//
// Headless, driver-agnostic Android onboarding core.
//
// Task 1: androidStepView — pure mapping from persisted progress to a
//         UI-framework-neutral step description.
//
// Task 2: applyAndroidInput / AndroidInput — pure state write for each
//         input/choice step. No IO.
//
// Task 3: runAndroidEffect / AndroidEffectDeps — LOCAL effects (keystore,
//         SA validation, saving credentials) with fully injected deps.
//
// Task 4: runAndroidEffect (continued) — CLOUD effects (OAuth, GCP, Play)
//         with fully injected deps.

import type { Buffer } from 'node:buffer'
import type { AndroidOnboardingProgress, AndroidOnboardingStep, KeystoreReady } from './types.js'
import type { KeystoreOptions, KeystoreResult, ListAliasesResult, ProbeKeyPasswordResult } from './keystore.js'
import type { ValidateOptions, ValidationResult } from './service-account-validation.js'
import type { GcpProject, GcpServiceAccount, GcpServiceAccountKey } from './gcp-api.js'
import type { GoogleOAuthTokens, GoogleUserInfo, PendingOAuthSession, RunOAuthFlowOptions } from './oauth-google.js'
// ── Post-save "tail" helper types (CI-secrets → env-export → workflow-file →
//    build-request). Imported as types only; the engine never imports the
//    concrete helpers — the driver injects them via the optional deps below so
//    the core stays IO-free and the MCP bridge can supply its own bindings.
import type { BuildCredentials } from '../../../schemas/build.js'
import type { BuildLogger, BuildRequestOptions, BuildRequestResult } from '../../request.js'
import type { AsyncCommandRunner, CiSecretDiscovery, CiSecretEntry, CiSecretSetupAdvice, CiSecretTarget, CommandRunner } from '../ci-secrets.js'
import type { EnvExportOpts, EnvExportResult } from '../env-export.js'
import type { BuildScriptChoice, GeneratedWorkflow, PackageManager, WorkflowGeneratorOpts } from '../workflow-generator.js'
import type { WorkflowWriteOptions, WorkflowWriteResult } from '../workflow-writer.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reconcileAndroidApp } from './app-verification-android.js'

// ─── applyGoogleSignIn ────────────────────────────────────────────────────────

/**
 * Pure helper: given persisted progress, validated OAuth tokens and the user's
 * profile, return a NEW progress object (immutable spread) with:
 *   - `_oauthRefreshToken` set to `tokens.refreshToken`
 *   - `completedSteps.googleSignInComplete` set to `{ email, googleSubject, scope }`
 *
 * This is the single canonical place where Google sign-in state is written to
 * progress — shared by the Ink core effect (`google-sign-in-running`) and the
 * MCP bridge so both produce identical progress objects.
 */
export function applyGoogleSignIn(
  progress: AndroidOnboardingProgress,
  tokens: GoogleOAuthTokens,
  info: GoogleUserInfo,
): AndroidOnboardingProgress {
  return {
    ...progress,
    _oauthRefreshToken: tokens.refreshToken,
    completedSteps: {
      ...progress.completedSteps,
      googleSignInComplete: {
        email: info.email,
        googleSubject: info.sub,
        scope: tokens.scope,
      },
    },
  }
}

/**
 * Apply a BROKER (access-token) Google sign-in. The MCP path receives a short-lived access token from the
 * Capgo OAuth broker and CANNOT refresh it (the token is issued to the broker's confidential Web client), so
 * it stores the access token + its expiry and re-signs-in on expiry — no `_oauthRefreshToken`. Mirrors
 * applyGoogleSignIn for the refresh-token (TUI loopback) path.
 */
export function applyGoogleSignInBroker(
  progress: AndroidOnboardingProgress,
  accessToken: string,
  expiresAt: number | null,
  info: GoogleUserInfo,
): AndroidOnboardingProgress {
  return {
    ...progress,
    _oauthAccessToken: accessToken,
    _oauthAccessTokenExpiresAt: expiresAt ?? undefined,
    completedSteps: {
      ...progress.completedSteps,
      googleSignInComplete: {
        email: info.email,
        googleSubject: info.sub,
        scope: '',
      },
    },
  }
}
import { getAndroidResumeStep, hasAnyOAuthProgress } from './progress.js'
import { extractDeveloperId } from './play-api.js'
import { generateProjectId, sanitizeGcpProjectDisplayName, ANDROIDPUBLISHER_API, DEFAULT_SERVICE_ACCOUNT_ID, DEFAULT_SERVICE_ACCOUNT_DISPLAY_NAME, DEFAULT_SERVICE_ACCOUNT_DESCRIPTION } from './gcp-api.js'
import { generateRandomPassword } from './keystore.js'
import { MissingScopesError } from './oauth-google.js'
import { CAPGO_SA_DEVELOPER_PERMISSIONS, CAPGO_SA_APP_PERMISSIONS } from './play-api.js'
// ── Platform-neutral post-save tail (CI-secrets → env-export → workflow-file →
//    build-request). The android engine delegates the tail steps to this shared
//    module and adapts its neutral view to AndroidStepView. EXCLUDES the
//    ai-analysis-* sub-flow (TUI-only).
import type { TailEffectDeps, TailInput, TailStep, TailStepCtx, TailStepView } from '../tail/flow.js'
import { applyTailInput, runTailEffect, tailViewForStep } from '../tail/flow.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AndroidStepKind = 'auto' | 'input' | 'choice' | 'done' | 'error'

export interface AndroidStepOption {
  value: string
  label?: string
  note?: string
}

export interface AndroidStepView {
  step: AndroidOnboardingStep
  kind: AndroidStepKind
  title?: string
  prompt?: string        // 'input' steps
  collect?: string[]     // field(s) an 'input' step gathers
  options?: AndroidStepOption[]  // 'choice' steps
  message?: string       // 'done' | 'error'
}

export interface AndroidStepCtx {
  appId: string
  detectedPackageIds?: string[]
  /**
   * android-app-verify transient: the user's real Play Store apps (apps:search)
   * + the reconcile outcome for the chosen package. Set in the effect's
   * transient ONLY when the chosen package is not an exact match (and the
   * fetch succeeded), so the view renders the create-app / re-check gate.
   * Absent → the step is still auto (run the fetch) or already advanced.
   */
  playVerifyApps?: { packageName: string, displayName: string }[]
  playVerifyOutcome?: 'no-app' | 'wrong-build-id' | 'multi-gradle'
  gcpProjects?: { projectId: string, name: string, projectNumber?: string }[]
  detectedAliases?: string[]
  saValidation?: { ok: false, kind: string, message: string } | { ok: true }
  /**
   * Task 3 — keystore-existing-key-password prompt boundary.
   * Set to true in AndroidEffectResult.transient when the auto-probe could not
   * resolve the key password and the driver should show the manual input.
   * After the user submits, applyAndroidInput records keystoreKeyPassword and
   * re-running the effect finds it set and completes the phase.
   */
  needsKeyPasswordPrompt?: boolean
  /**
   * Task 4 — fresh access token returned from google-sign-in-running so the
   * driver can seed its token cache and avoid an immediate refresh on the next
   * step. If the driver ignores it, deps.getAccessToken() will mint one —
   * behaviorally identical.
   */
  accessToken?: string
  /**
   * keystore-existing-detecting-alias wrong-password signal.
   * Set to true in AndroidEffectResult.transient when listKeystoreAliases returns
   * { ok: false, reason: 'wrong-password' }. The driver (app.tsx) maps this to
   * the original UX: setError + setRetryStep('keystore-existing-store-password')
   * + setStep('error') WITHOUT calling handleError (no retryCount bump).
   */
  wrongPassword?: boolean

  // ── Post-save "tail" transient (Phase 1 engine tail) ─────────────────────
  // Runtime data the tail effects surface to the driver but that is NOT
  // persisted to progress.json. The Ink TUI holds the same values in useState
  // (ciSecretEntries / ciSecretTargets / ciSecretRepoLabel / ciSecretExistingKeys
  // / ciSecretUploadSummary / envExportPath / workflowWrittenPath / buildUrl /
  // buildOutput). Every field is OPTIONAL so existing transient producers keep
  // type-checking unchanged.
  /** CI-secret entries built at saving-credentials (key/value/masked). */
  ciSecretEntries?: CiSecretEntry[]
  /**
   * Full saved-credential map written at saving-credentials (the 5 build-cred
   * fields, NO CAPGO_TOKEN). The Ink TUI holds the same in its `savedCredentials`
   * React state and the env-export effects write it verbatim. Transient only —
   * never persisted to progress.json (it carries the raw keystore/SA secrets).
   */
  savedCredentials?: Record<string, string>
  /** CI-secret destinations discovered at detecting-ci-secrets. */
  ciSecretTargets?: CiSecretTarget[]
  /** Per-destination setup advice surfaced when no target is reachable. */
  ciSecretSetupAdvice?: CiSecretSetupAdvice[]
  /** Resolved owner/repo (GitHub) the CLI will push secrets to. */
  ciSecretRepoLabel?: string | null
  /** Which secret keys already exist on the remote (checking-ci-secrets). */
  ciSecretExistingKeys?: string[]
  /** Human summary of the upload (uploading-ci-secrets). */
  ciSecretUploadSummary?: string
  /** Absolute path of the written .env file (exporting-env). */
  envExportPath?: string
  /** Set when env-export found nothing to write or threw — routed to build-complete, never thrown (exporting-env / overwrite-and-export-env). */
  envExportError?: string
  /** Absolute path of the written workflow file (writing-workflow-file). */
  workflowFilePath?: string
  /** The queued build URL (requesting-build). */
  buildUrl?: string
  /** Streamed build-request log lines (requesting-build). */
  buildOutput?: string[]
  /** Captured AI-analysis job id surfaced on a failed build (requesting-build). */
  aiJobId?: string

  // ── Workflow-builder sub-flow ctx (pick-package-manager / pick-build-script) ──
  // Optional runtime data the workflow-builder views surface. Every field is
  // OPTIONAL so a driver that only passes { appId } still gets a usable view
  // (the static option tables defined below already cover the menus).
  /** Detected package manager from the project's lockfile (pick-package-manager). */
  detectedPackageManager?: string
  /** All scripts from package.json (pick-build-script picker). */
  availableScripts?: Record<string, string>
  /** Project-type recommendation surfaced at the top of pick-build-script. */
  recommendedScript?: string | null
  /** Default `.env` export path shown at ask-export-env (defaultExportPath). */
  defaultEnvExportPath?: string
}

// ─── KIND_TABLE ───────────────────────────────────────────────────────────────
//
// Maps every AndroidOnboardingStep to its base kind. Steps outside the core
// provisioning machine (bootstrap, post-save tail) still need a sensible
// mapping so the Record is exhaustive and tsgo is happy.

export const KIND_TABLE: Record<AndroidOnboardingStep, AndroidStepKind> = {
  // ── Bootstrap (stays in Ink, not in the progress machine) ──
  'welcome': 'auto',
  // TUI-only states (main's ink TUI; the MCP engine never returns these) — present
  // only to satisfy the exhaustive Record<AndroidOnboardingStep, …>.
  'resume-prompt': 'auto',
  'ai-analysis-prompt': 'auto',
  'ai-analysis-running': 'auto',
  'ai-analysis-result': 'auto',
  'ai-analysis-result-scroll': 'auto',
  'support-confirm': 'choice',
  'support-log-view': 'auto',
  'support-uploading': 'auto',
  'credentials-exist': 'choice',
  'backing-up': 'auto',
  'no-platform': 'error',

  // ── Phase 1 — Keystore ──
  'keystore-method-select': 'choice',
  'keystore-explainer': 'choice',
  'keystore-existing-path': 'choice',   // chooser (picker vs manual) + manual input
  'keystore-existing-picker': 'auto',
  'keystore-existing-store-password': 'input',
  'keystore-existing-detecting-alias': 'auto',
  'keystore-existing-alias-select': 'choice',
  'keystore-existing-alias': 'input',
  'keystore-existing-key-password': 'input',
  'keystore-new-alias': 'input',
  'keystore-new-password-method': 'choice',
  'keystore-new-store-password': 'input',
  'keystore-new-key-password': 'input',
  'keystore-new-cn': 'input',
  'keystore-generating': 'auto',

  // ── Phase 2 — Service account method fork ──
  'service-account-method-select': 'choice',

  // ── Phase 2a — Import existing SA JSON ──
  'sa-json-existing-path': 'choice',    // chooser (picker vs manual) + manual input
  'sa-json-existing-picker': 'auto',
  'sa-json-validating': 'auto',
  'sa-json-validation-failed': 'choice',

  // ── Phase 2b — Google sign-in ──
  'google-sign-in': 'choice',
  'google-sign-in-running': 'auto',

  // ── Phase 3 — Play developer account ──
  'play-developer-id-input': 'choice',  // actions (open / tutorial / manual)

  // ── Phase 4 — GCP project ──
  'gcp-projects-loading': 'auto',
  'gcp-projects-select': 'choice',
  'gcp-project-create-name': 'input',

  // ── Phase 4.5 — Android package ──
  'android-package-select': 'auto',     // auto pre-loads; then choice/input

  // ── Phase 5 — Provisioning ──
  'gcp-setup-running': 'auto',

  // ── Phase 6 — Save & Build (post-save tail stays in Ink) ──
  'saving-credentials': 'auto',
  'detecting-ci-secrets': 'auto',
  'ci-secrets-setup': 'auto',
  'ci-secrets-target-select': 'choice',
  'ask-ci-secrets': 'choice',
  'checking-ci-secrets': 'auto',
  'confirm-ci-secret-overwrite': 'choice',
  'uploading-ci-secrets': 'auto',
  'ci-secrets-failed': 'error',
  'ask-github-actions-setup': 'choice',
  'confirm-secrets-push': 'choice',
  'ask-export-env': 'choice',
  'exporting-env': 'auto',
  'confirm-env-export-overwrite': 'choice',
  'overwrite-and-export-env': 'auto',
  'pick-package-manager': 'choice',
  'pick-build-script': 'choice',
  'pick-build-script-custom': 'input',
  'preview-workflow-file': 'choice',
  'view-workflow-diff': 'choice',
  'writing-workflow-file': 'auto',
  'ask-build': 'choice',
  'requesting-build': 'auto',
  'build-complete': 'done',
  'error': 'error',
  // Base kind 'auto' — the effect runs apps:search + reconcile on entry and
  // either advances (exact-match / degraded) or stashes a no-match result;
  // androidViewForStep then dynamically returns 'choice' when user action is
  // needed (create the app / re-check). Mirrors android-package-select.
  'android-app-verify': 'auto',
}

// ─── Static option tables ─────────────────────────────────────────────────────
//
// Faithful to the options shown in app.tsx. Navigation-only / sub-mode options
// (like 'learn', 'back') are included so the headless layer has the full menu.

const OPTIONS_KEYSTORE_METHOD: AndroidStepOption[] = [
  { value: 'existing', label: 'Yes, I have one' },
  { value: 'generate', label: 'No, create one for me' },
  { value: 'learn', label: 'What is a keystore?' },
]

// Data-safety gate shown when saved android credentials already exist for the
// app. Mirrors main's CredentialsExistStep (android-shared.tsx): backup the
// existing credentials.json first, or stop. 'backup' → backing-up effect →
// keystore-method-select; 'cancel' → halt onboarding (main's exitOnboarding()).
const OPTIONS_CREDENTIALS_EXIST: AndroidStepOption[] = [
  { value: 'backup', label: 'Start fresh (backup existing credentials first)' },
  { value: 'cancel', label: 'Exit onboarding' },
]

const OPTIONS_KEYSTORE_EXPLAINER: AndroidStepOption[] = [
  { value: 'back', label: 'Back' },
]

const OPTIONS_KEYSTORE_EXISTING_PATH: AndroidStepOption[] = [
  { value: 'picker', label: 'Open file picker' },
  { value: 'manual', label: 'Type the path' },
]

const OPTIONS_KEYSTORE_NEW_PASSWORD_METHOD: AndroidStepOption[] = [
  { value: 'random', label: 'Generate a random password (recommended)' },
  { value: 'manual', label: "I'll type my own password" },
]

const OPTIONS_SERVICE_ACCOUNT_METHOD: AndroidStepOption[] = [
  { value: 'generate', label: 'Set it up for me (recommended) — I sign in with Google once and Capgo configures Play access automatically' },
  { value: 'existing', label: 'I already have a Google Play service-account JSON file to use' },
]

const OPTIONS_SA_JSON_EXISTING_PATH: AndroidStepOption[] = [
  { value: 'picker', label: 'Open file picker' },
  { value: 'manual', label: 'Type the path' },
]

const OPTIONS_SA_JSON_VALIDATION_FAILED: AndroidStepOption[] = [
  { value: 'retry', label: 'Try a different service account JSON file' },
  { value: 'save-anyway', label: 'Save anyway (skip validation)' },
  { value: 'oauth', label: 'Set one up for me via Google instead' },
]

const OPTIONS_GOOGLE_SIGN_IN: AndroidStepOption[] = [
  { value: 'go', label: 'Continue to Google sign-in' },
  { value: 'learn', label: 'Learn why the onboarding via Google is secure' },
  { value: 'exit', label: "Exit (I'll do it later)" },
]

const OPTIONS_PLAY_DEVELOPER_ID: AndroidStepOption[] = [
  { value: 'open', label: 'Open Play Console in browser' },
  { value: 'tutorial', label: 'Show me how to find the developer ID' },
  { value: 'manual', label: "I'll type it now" },
]

const OPTIONS_GCP_PROJECT_NEW: AndroidStepOption = {
  value: '__new__',
  label: 'Create a new project',
}

// ─── androidViewForStep ───────────────────────────────────────────────────────

/**
 * Pure function: given an explicit step name, persisted progress (or null),
 * and the current runtime context, return a UI-framework-neutral description
 * of the step.
 *
 * This is the primary entry-point for drivers that already know the step
 * (e.g. the MCP bridge). `androidStepView` is a thin wrapper that resolves
 * the step from progress first.
 *
 * Dynamic kind for `android-package-select`:
 *   - ctx.detectedPackageIds === undefined  → 'auto'  (preload not yet done)
 *   - ctx.detectedPackageIds.length > 0     → 'choice' (options = the ids)
 *   - ctx.detectedPackageIds.length === 0   → 'input'  (user must type it)
 *
 * All other steps use KIND_TABLE[step] unchanged.
 *
 * No I/O; no mutation of progress.
 */
export function androidViewForStep(
  step: AndroidOnboardingStep,
  progress: AndroidOnboardingProgress | null,
  ctx: AndroidStepCtx,
): AndroidStepView {
  // Post-save tail: delegate to the shared platform-neutral view and adapt its
  // output back to AndroidStepView. AndroidStepCtx is a superset of TailStepCtx,
  // so it threads straight through.
  if (TAIL_VIEW_STEPS.has(step))
    return mapTailViewToAndroidStepView(tailViewForStep(step as TailStep, progress, ctx as TailStepCtx), step)

  // Dynamic kind for android-package-select; all others fall through to KIND_TABLE.
  const kind: AndroidStepView['kind'] = step === 'android-package-select'
    ? (ctx.detectedPackageIds === undefined
        ? 'auto'
        : ctx.detectedPackageIds.length > 0 ? 'choice' : 'input')
    : step === 'android-app-verify'
      // 'auto' until the effect stashes a no-match outcome → then 'choice'
      // (create-app / re-check gate). Mirrors android-package-select.
      ? (ctx.playVerifyOutcome === undefined ? 'auto' : 'choice')
      : KIND_TABLE[step]

  const base: AndroidStepView = { step, kind }

  switch (step) {
    // ── Bootstrap ──
    case 'no-platform':
      return { ...base, message: 'No Android platform found. Run `npx cap add android` first.' }

    // ── Data-safety gate (saved android credentials already exist) ──
    // Mirrors main's CredentialsExistStep: a backup-or-cancel choice. The
    // `backing-up` step is an auto effect (the credentials.json → dated copy),
    // so it carries only kind (no options/prompt).
    case 'credentials-exist':
      return { ...base, options: OPTIONS_CREDENTIALS_EXIST }

    // ── Phase 1 — Keystore ──
    case 'keystore-method-select':
      return { ...base, options: OPTIONS_KEYSTORE_METHOD }

    case 'keystore-explainer':
      return { ...base, options: OPTIONS_KEYSTORE_EXPLAINER }

    case 'keystore-existing-path':
      return { ...base, options: OPTIONS_KEYSTORE_EXISTING_PATH }

    case 'keystore-existing-store-password':
      return { ...base, prompt: 'Keystore store password', collect: ['keystoreStorePassword'] }

    case 'keystore-existing-alias-select': {
      const aliases = ctx.detectedAliases ?? []
      return {
        ...base,
        options: aliases.map(a => ({ value: a, label: a })),
      }
    }

    case 'keystore-existing-alias':
      return { ...base, prompt: 'Keystore alias', collect: ['keystoreAlias'] }

    case 'keystore-existing-key-password':
      return { ...base, prompt: 'Keystore key password', collect: ['keystoreKeyPassword'] }

    case 'keystore-new-alias':
      return { ...base, prompt: 'Key alias (e.g. release)', collect: ['keystoreAlias'] }

    case 'keystore-new-password-method':
      return { ...base, options: OPTIONS_KEYSTORE_NEW_PASSWORD_METHOD }

    case 'keystore-new-store-password':
      return { ...base, prompt: 'Store password (min 6 chars)', collect: ['keystoreStorePassword'] }

    case 'keystore-new-key-password':
      return { ...base, prompt: 'Key password', collect: ['keystoreKeyPassword'] }

    case 'keystore-new-cn':
      return { ...base, prompt: 'Common name (e.g. your app ID)', collect: ['keystoreCommonName'] }

    // ── Phase 2 — Service account fork ──
    case 'service-account-method-select':
      return { ...base, options: OPTIONS_SERVICE_ACCOUNT_METHOD }

    // ── Phase 2a — Import SA JSON ──
    case 'sa-json-existing-path':
      return { ...base, options: OPTIONS_SA_JSON_EXISTING_PATH }

    case 'sa-json-validation-failed': {
      const message = ctx.saValidation && !ctx.saValidation.ok
        ? ctx.saValidation.message
        : undefined
      return { ...base, options: OPTIONS_SA_JSON_VALIDATION_FAILED, message }
    }

    // ── Phase 2b — Google sign-in ──
    case 'google-sign-in':
      return { ...base, options: OPTIONS_GOOGLE_SIGN_IN }

    // ── Phase 3 — Play developer account ──
    case 'play-developer-id-input':
      return { ...base, options: OPTIONS_PLAY_DEVELOPER_ID }

    // ── Phase 4 — GCP project ──
    case 'gcp-projects-select': {
      const projectOptions: AndroidStepOption[] = (ctx.gcpProjects ?? []).map(p => ({
        value: p.projectId,
        label: p.name,
        note: p.projectNumber,
      }))
      return { ...base, options: [...projectOptions, OPTIONS_GCP_PROJECT_NEW] }
    }

    case 'gcp-project-create-name':
      return { ...base, prompt: 'New GCP project display name', collect: ['pendingNewProjectDisplayName'] }

    // ── Phase 4.5 — Android package ──
    // kind is already set dynamically above; only add options when choice.
    case 'android-package-select': {
      if (kind === 'choice' && ctx.detectedPackageIds && ctx.detectedPackageIds.length > 0) {
        // When the Play apps list was pre-loaded (generate path + reporting
        // scope), annotate each id with whether it already exists in Play, so
        // the user sees at pick time which ids clear the verify gate and which
        // hit the create-app step. Absent (degrade) leaves the plain picker.
        const detected = new Set(ctx.detectedPackageIds)
        const playPackages = ctx.playVerifyApps
          ? new Set(ctx.playVerifyApps.map(a => a.packageName))
          : null
        const packageOptions: AndroidStepOption[] = ctx.detectedPackageIds.map(id => ({
          value: id,
          label: id,
          ...(playPackages
            ? { note: playPackages.has(id) ? '✓ exists in Play Store' : '⚠ not in Play Store yet' }
            : {}),
        }))
        // Surface the user's other real Play apps (not auto-detected) as
        // selectable options, so they can pick a guaranteed-existing app
        // instead of typing one that may not exist. Picking one passes the
        // verify gate (it is in apps:search, so it exact-matches).
        const otherPlayApps: AndroidStepOption[] = (ctx.playVerifyApps ?? [])
          .filter(a => !detected.has(a.packageName))
          .map(a => ({
            value: a.packageName,
            label: a.displayName ? `${a.packageName} (${a.displayName})` : a.packageName,
            note: '✓ exists in Play Store',
          }))
        return { ...base, options: [...packageOptions, ...otherPlayApps] }
      }
      return base
    }

    // ── Phase 4.6 — verify the chosen package exists in Play ──
    case 'android-app-verify': {
      if (kind === 'choice') {
        const pkg = progress?.completedSteps.androidPackageChosen?.packageName ?? 'your package'
        // wrong-build-id: the account HAS Play apps but none match the chosen
        // package, so the fix is to pick the right package, not create a duplicate.
        // no-app: the account has no matching app, so creating it is the path.
        // Both offer "proceed anyway" because apps:search can lag behind a
        // just-created app that the provisioning invite would already accept.
        if (ctx.playVerifyOutcome === 'wrong-build-id') {
          return {
            ...base,
            message: `None of your Play Store apps match "${pkg}". Pick a different package (the applicationId your app is actually published under), or create "${pkg}" in Play Console (https://play.google.com/console). Capgo grants your build access to that exact package, so it must exist before provisioning.`,
            options: [
              { value: 'recheck', label: 'Re-check (I fixed the package / created the app)' },
              { value: 'proceed', label: 'The app exists, proceed anyway' },
              { value: 'open', label: 'Open Play Console' },
              { value: 'cancel', label: 'Cancel onboarding' },
            ],
          }
        }
        return {
          ...base,
          message: `No Play Store app exists yet for "${pkg}". Create it once in Play Console (https://play.google.com/console), then re-check. Capgo grants your build access to that exact package, so it must exist before provisioning.`,
          options: [
            { value: 'open', label: 'Open Play Console to create this app' },
            { value: 'recheck', label: 'I\'ve created it, re-check' },
            { value: 'proceed', label: 'I\'ve already created it, proceed anyway' },
            { value: 'cancel', label: 'Cancel onboarding' },
          ],
        }
      }
      return base
    }

    // ── Error ──
    case 'error':
      return { ...base, message: 'An error occurred. Check the details above.' }

    // All other steps (auto spinners, post-save tail) return kind only.
    default:
      return base
  }
}

// ─── RELEASE_ALIAS_DEFAULT ────────────────────────────────────────────────────
// Mirrors the constant in app.tsx so both use the same default.
const RELEASE_ALIAS_DEFAULT = 'release'

// ─── AndroidInput ─────────────────────────────────────────────────────────────
//
// Discriminated union — one variant per input/choice step that records state.
// Navigation-only choices (e.g. 'learn', 'back', 'picker', 'manual' sub-mode)
// are included so the headless layer has the full vocabulary, but they return
// progress unchanged in applyAndroidInput.

export type AndroidInput =
  // Phase 0 — Data-safety gate (saved android credentials already exist).
  // 'backup' → mark gate for backing-up; 'cancel' → halt onboarding.
  | { step: 'credentials-exist'; value: 'backup' | 'cancel' }

  // Phase 1 — Keystore method
  | { step: 'keystore-method-select'; value: 'existing' | 'generate' | 'learn' }

  // Phase 1 — Existing keystore path (manual text input; file-picker is handled
  // by runAndroidEffect as Ink-only TTY IO)
  | { step: 'keystore-existing-path'; path: string }

  // Phase 1 — Existing keystore store password
  | { step: 'keystore-existing-store-password'; password: string }

  // Phase 1 — Existing keystore alias select (multi-alias chooser)
  | { step: 'keystore-existing-alias-select'; alias: string }

  // Phase 1 — Existing keystore alias manual entry
  | { step: 'keystore-existing-alias'; alias: string }

  // Phase 1 — Existing keystore key password (prompt sub-mode).
  // NOTE: IO boundary — applyAndroidInput records keystoreKeyPassword only.
  // Reading the p12, computing _keystoreBase64, and writing keystoreReady +
  // serviceAccountForkSeen is IO handled by runAndroidEffect (Task 3).
  | { step: 'keystore-existing-key-password'; password: string }

  // Phase 1 — New keystore alias
  | { step: 'keystore-new-alias'; alias: string }

  // Phase 1 — New keystore password method
  // random: generates pw, writes keystoreStorePassword + keystoreKeyPassword;
  // manual: navigation-only (progress unchanged; component transitions to store-pw screen)
  | { step: 'keystore-new-password-method'; value: 'random' | 'manual' }

  // Phase 1 — New keystore store password (manual path)
  | { step: 'keystore-new-store-password'; password: string }

  // Phase 1 — New keystore key password (manual path; empty → store pw)
  | { step: 'keystore-new-key-password'; password: string }

  // Phase 1 — New keystore common name (empty → appId)
  | { step: 'keystore-new-cn'; cn: string }

  // Phase 2 — Service account method
  | { step: 'service-account-method-select'; value: 'generate' | 'existing' }

  // Phase 2a — SA JSON path (manual; file-picker is Ink-only)
  | { step: 'sa-json-existing-path'; path: string }

  // Phase 2a — SA JSON validation failed recovery.
  // 'save-anyway' IO boundary: the caller provides serviceAccountKeyBase64
  // (bytes already read by the driver) for the pure state write.
  | { step: 'sa-json-validation-failed'; value: 'retry' | 'oauth' }
  | { step: 'sa-json-validation-failed'; value: 'save-anyway'; serviceAccountKeyBase64: string }

  // Phase 3 — Play developer account ID (raw URL or numeric id)
  | { step: 'play-developer-id-input'; rawDeveloperIdOrUrl: string }

  // Phase 4 — GCP project select (existing)
  | { step: 'gcp-projects-select'; gcpProject: { projectId: string; name: string; projectNumber?: string } }

  // Phase 4 — GCP project create name (empty falls back to sanitized `Capgo ${appId}`)
  | { step: 'gcp-project-create-name'; displayName: string }

  // Phase 4.5 — Android package select.
  // serviceAccountMethod is required so the pure function can route correctly
  // (progress.serviceAccountMethod may already be set but is also passed
  // explicitly here to keep the function self-contained).
  | { step: 'android-package-select'; packageName: string; source: 'gradle' | 'capacitor-config' | 'user-input'; serviceAccountMethod: 'generate' | 'existing' }
  | { step: 'android-app-verify'; verifyAction: 'open' | 'recheck' | 'cancel' | 'proceed' }

  // ── Phase 6 — Post-save "tail" inputs ───────────────────────────────────────
  // One variant per tail choice/input step that records state on TailProgress.
  // Navigation-only / spinner-gate choices (the 'retry'/'skip'/'view'/'close'
  // routing values) carry no persisted field — applyAndroidInput returns
  // progress unchanged for them; the driver owns the visual transition.

  // ci-secrets-setup — retry the detection or skip the upload (navigation-only).
  | { step: 'ci-secrets-setup'; value: 'retry' | 'skip' }

  // ci-secrets-target-select — records the chosen destination (or skip).
  | { step: 'ci-secrets-target-select'; ciSecretTarget: CiSecretTarget | null }

  // ask-ci-secrets — confirm/skip the GitLab upload (navigation-only).
  | { step: 'ask-ci-secrets'; value: 'yes' | 'no' }

  // confirm-ci-secret-overwrite — replace existing or skip (navigation-only).
  | { step: 'confirm-ci-secret-overwrite'; value: 'replace' | 'skip' }

  // ci-secrets-failed — retry the upload or continue (navigation-only).
  | { step: 'ci-secrets-failed'; value: 'retry' | 'continue' }

  // ask-github-actions-setup — records the 3-way GitHub Actions setup mode.
  | { step: 'ask-github-actions-setup'; value: 'with-workflow' | 'secrets-only' | 'declined' }

  // confirm-secrets-push — confirm/cancel the push (navigation-only).
  | { step: 'confirm-secrets-push'; value: 'confirm' | 'cancel' }

  // ask-export-env — 'yes' records the resolved export path; 'no' exits.
  | { step: 'ask-export-env'; value: 'no' }
  | { step: 'ask-export-env'; value: 'yes'; envExportTargetPath: string }

  // confirm-env-export-overwrite — replace/skip (navigation-only).
  | { step: 'confirm-env-export-overwrite'; value: 'replace' | 'skip' }

  // pick-package-manager — records the chosen package manager.
  | { step: 'pick-package-manager'; selectedPackageManager: PackageManager }

  // pick-build-script — records the build-script choice; '__custom__' routes to
  // the custom-command input (navigation-only) and '__skip__' records a skip.
  | { step: 'pick-build-script'; value: '__custom__' }
  | { step: 'pick-build-script'; buildScriptChoice: BuildScriptChoice }

  // pick-build-script-custom — records the free-text custom command.
  | { step: 'pick-build-script-custom'; command: string }

  // preview-workflow-file — write / view diff / cancel (navigation-only).
  | { step: 'preview-workflow-file'; value: 'write' | 'view' | 'cancel' }

  // view-workflow-diff — close the diff (navigation-only).
  | { step: 'view-workflow-diff'; value: 'close' }

  // ask-build — request a build now or finish (navigation-only).
  | { step: 'ask-build'; value: 'yes' | 'no' }

// ─── applyAndroidInput ────────────────────────────────────────────────────────
//
// Pure function: given the current step, persisted progress, and user input,
// return a NEW progress object (spread — never mutate). Replicates each
// `persistAndStep` updater from app.tsx EXACTLY.
//
// Navigation-only inputs (e.g. 'learn', 'manual' sub-mode switch) return
// progress unchanged; the Ink component handles the visual transition.

export function applyAndroidInput(
  step: AndroidOnboardingStep,
  progress: AndroidOnboardingProgress,
  input: AndroidInput,
): AndroidOnboardingProgress {
  // Post-save tail: delegate the tail choice/input reducers to the shared
  // platform-neutral module. The android tail AndroidInput variants are
  // structurally identical to TailInput, so they thread straight through.
  if (TAIL_INPUT_STEPS.has(step))
    return applyTailInput(step as TailStep, progress, input as TailInput)

  switch (step) {
    // ── credentials-exist ─────────────────────────────────────────────────────
    // Data-safety gate. app.tsx routes 'backup' → setStep('backing-up') and
    // 'exit' → exitOnboarding(). The stateless engine encodes that choice in
    // `_credentialsExistGate`: 'backup' parks the resume step on `backing-up`
    // (the copy effect runs next); 'cancel' halts onboarding.
    case 'credentials-exist': {
      const i = input as Extract<AndroidInput, { step: 'credentials-exist' }>
      if (i.value === 'backup')
        return { ...progress, _credentialsExistGate: 'backup' }
      return { ...progress, _credentialsExistGate: 'cancel' }
    }

    // ── keystore-method-select ────────────────────────────────────────────────
    // app.tsx:1900, 1904
    case 'keystore-method-select': {
      const i = input as Extract<AndroidInput, { step: 'keystore-method-select' }>
      if (i.value === 'existing') {
        return { ...progress, keystoreMethod: 'existing' }
      }
      if (i.value === 'generate') {
        return { ...progress, keystoreMethod: 'generate' }
      }
      // 'learn' → navigation-only; progress unchanged
      return progress
    }

    // ── keystore-existing-path ────────────────────────────────────────────────
    // app.tsx:1971
    case 'keystore-existing-path': {
      const i = input as Extract<AndroidInput, { step: 'keystore-existing-path' }>
      return { ...progress, keystoreExistingPath: i.path }
    }

    // ── keystore-existing-store-password ──────────────────────────────────────
    // app.tsx:2001
    case 'keystore-existing-store-password': {
      const i = input as Extract<AndroidInput, { step: 'keystore-existing-store-password' }>
      return { ...progress, keystoreStorePassword: i.password }
    }

    // ── keystore-existing-alias-select ────────────────────────────────────────
    // app.tsx:2020
    case 'keystore-existing-alias-select': {
      const i = input as Extract<AndroidInput, { step: 'keystore-existing-alias-select' }>
      return { ...progress, keystoreAlias: i.alias }
    }

    // ── keystore-existing-alias ───────────────────────────────────────────────
    // app.tsx:2038 — trim/RELEASE_ALIAS_DEFAULT
    case 'keystore-existing-alias': {
      const i = input as Extract<AndroidInput, { step: 'keystore-existing-alias' }>
      const alias = i.alias.trim() || RELEASE_ALIAS_DEFAULT
      return { ...progress, keystoreAlias: alias }
    }

    // ── keystore-existing-key-password ────────────────────────────────────────
    // app.tsx:2073–2078 (IO boundary — only the pure state write here)
    // Records keystoreKeyPassword; the p12 read + _keystoreBase64 + keystoreReady
    // + serviceAccountForkSeen writes are IO handled by runAndroidEffect (Task 3).
    case 'keystore-existing-key-password': {
      const i = input as Extract<AndroidInput, { step: 'keystore-existing-key-password' }>
      const keyPw = i.password || progress.keystoreStorePassword || ''
      return { ...progress, keystoreKeyPassword: keyPw }
    }

    // ── keystore-new-alias ────────────────────────────────────────────────────
    // app.tsx:2112 — trim/RELEASE_ALIAS_DEFAULT
    case 'keystore-new-alias': {
      const i = input as Extract<AndroidInput, { step: 'keystore-new-alias' }>
      const alias = i.alias.trim() || RELEASE_ALIAS_DEFAULT
      return { ...progress, keystoreAlias: alias }
    }

    // ── keystore-new-password-method ──────────────────────────────────────────
    // app.tsx:2129–2134 (random) / 2137 (manual → navigation-only)
    case 'keystore-new-password-method': {
      const i = input as Extract<AndroidInput, { step: 'keystore-new-password-method' }>
      if (i.value === 'random') {
        const pw = generateRandomPassword()
        return { ...progress, keystoreStorePassword: pw, keystoreKeyPassword: pw, keystorePasswordGenerated: true }
      }
      // 'manual' → the user will type the password. The TUI tracks this in
      // component state; the stateless MCP persists a marker so the next call
      // resumes onto the dedicated keystore-new-store-password step.
      return { ...progress, keystorePasswordManual: true }
    }

    // ── keystore-new-store-password ───────────────────────────────────────────
    // app.tsx:2161
    case 'keystore-new-store-password': {
      const i = input as Extract<AndroidInput, { step: 'keystore-new-store-password' }>
      return { ...progress, keystoreStorePassword: i.password }
    }

    // ── keystore-new-key-password ─────────────────────────────────────────────
    // app.tsx:2176–2179 — empty falls back to keystoreStorePassword
    case 'keystore-new-key-password': {
      const i = input as Extract<AndroidInput, { step: 'keystore-new-key-password' }>
      const keyPw = i.password || progress.keystoreStorePassword || ''
      return { ...progress, keystoreKeyPassword: keyPw }
    }

    // ── keystore-new-cn ───────────────────────────────────────────────────────
    // app.tsx:2197 — trim/appId
    case 'keystore-new-cn': {
      const i = input as Extract<AndroidInput, { step: 'keystore-new-cn' }>
      const cn = i.cn.trim() || progress.appId
      return { ...progress, keystoreCommonName: cn }
    }

    // ── service-account-method-select ─────────────────────────────────────────
    // app.tsx:2234–2243
    case 'service-account-method-select': {
      const i = input as Extract<AndroidInput, { step: 'service-account-method-select' }>
      return { ...progress, serviceAccountMethod: i.value }
    }

    // ── sa-json-existing-path ─────────────────────────────────────────────────
    // app.tsx:2304–2307
    case 'sa-json-existing-path': {
      const i = input as Extract<AndroidInput, { step: 'sa-json-existing-path' }>
      return { ...progress, serviceAccountJsonPath: i.path }
    }

    // ── sa-json-validation-failed ─────────────────────────────────────────────
    // app.tsx:2365–2401
    case 'sa-json-validation-failed': {
      const i = input as Extract<AndroidInput, { step: 'sa-json-validation-failed' }>
      if (i.value === 'retry') {
        // Clear the saved path so the picker chooser shows fresh (app.tsx:2366)
        return { ...progress, serviceAccountJsonPath: undefined }
      }
      if (i.value === 'save-anyway') {
        // IO boundary: caller provides serviceAccountKeyBase64 from file read.
        // app.tsx:2382–2383: sets _serviceAccountKeyBase64 + serviceAccountValidationSkipped
        return {
          ...progress,
          _serviceAccountKeyBase64: i.serviceAccountKeyBase64,
          serviceAccountValidationSkipped: true,
        }
      }
      // 'oauth' → fall back to OAuth provisioning path (app.tsx:2398–2400)
      return { ...progress, serviceAccountMethod: 'generate' }
    }

    // ── play-developer-id-input ───────────────────────────────────────────────
    // app.tsx:2555–2563
    case 'play-developer-id-input': {
      const i = input as Extract<AndroidInput, { step: 'play-developer-id-input' }>
      const developerId = extractDeveloperId(i.rawDeveloperIdOrUrl)
      if (!developerId) {
        // Invalid input — return progress unchanged; caller should surface error
        return progress
      }
      const choice = { developerId }
      return {
        ...progress,
        completedSteps: { ...progress.completedSteps, playAccountChosen: choice },
      }
    }

    // ── gcp-projects-select ───────────────────────────────────────────────────
    // app.tsx:2607–2612 (existing project pick)
    // '__new__' is a navigation-only value handled by the component (→ create-name screen)
    case 'gcp-projects-select': {
      const i = input as Extract<AndroidInput, { step: 'gcp-projects-select' }>
      const choice = {
        projectId: i.gcpProject.projectId,
        projectNumber: i.gcpProject.projectNumber,
        displayName: i.gcpProject.name,
        createdByOnboarding: false as const,
      }
      return {
        ...progress,
        completedSteps: { ...progress.completedSteps, gcpProjectChosen: choice },
      }
    }

    // ── gcp-project-create-name ───────────────────────────────────────────────
    // app.tsx:2640–2647
    case 'gcp-project-create-name': {
      const i = input as Extract<AndroidInput, { step: 'gcp-project-create-name' }>
      const displayName = sanitizeGcpProjectDisplayName(
        i.displayName.trim() || `Capgo ${progress.appId}`,
      )
      const projectId = generateProjectId(progress.appId)
      const choice = {
        projectId,
        displayName,
        createdByOnboarding: true as const,
      }
      return {
        ...progress,
        pendingNewProjectId: projectId,
        pendingNewProjectDisplayName: displayName,
        completedSteps: { ...progress.completedSteps, gcpProjectChosen: choice },
      }
    }

    // ── android-package-select ────────────────────────────────────────────────
    // app.tsx:2694–2701 (gradle picker) / 2727–2734 (manual input)
    // The next step depends on serviceAccountMethod (passed in input since
    // progress.serviceAccountMethod is the canonical source but the caller
    // also has it in local React state — both should be in sync). Persist it
    // back into progress so a legacy/partial progress file (no method yet)
    // resumes onto the SAME route the caller decided on, instead of falling
    // back to the OAuth default.
    case 'android-package-select': {
      const i = input as Extract<AndroidInput, { step: 'android-package-select' }>
      const choice = {
        packageName: i.packageName,
        source: i.source,
      }
      return {
        ...progress,
        serviceAccountMethod: i.serviceAccountMethod,
        completedSteps: { ...progress.completedSteps, androidPackageChosen: choice },
      }
    }

    // ── android-app-verify ────────────────────────────────────────────────
    // The gate's action. 'proceed' = the user asserts the app exists despite the
    // apps:search check not matching (e.g. Play data propagation lag, which the
    // androidpublisher invite would still accept) → record the marker (unverified)
    // so resume advances to provisioning. 'recheck' / 'open' / 'cancel' carry NO
    // progress change here: recheck re-runs the effect, open is a browser
    // side-effect, and cancel is halted by the driver (TUI exitOnboarding / MCP
    // done-halt) before this reducer matters.
    case 'android-app-verify': {
      const i = input as Extract<AndroidInput, { step: 'android-app-verify' }>
      if (i.verifyAction === 'proceed') {
        const chosen = progress.completedSteps.androidPackageChosen?.packageName ?? ''
        return {
          ...progress,
          completedSteps: {
            ...progress.completedSteps,
            playAppVerified: { packageName: chosen, verified: false },
          },
        }
      }
      return progress
    }

    default:
      return progress
  }
}

// ─── AndroidEffectDeps ────────────────────────────────────────────────────────
//
// Full interface for the WHOLE effect surface (Task 3 LOCAL + Task 4 CLOUD).
// Task 3 only uses a subset — the cloud deps (getAccessToken, runOAuthFlow, …)
// are unused here and are wired up when Task 4 implements their branches.
// Defining the complete interface now means Task 4 reuses it unchanged.

export interface AndroidEffectDeps {
  // ── Keystore operations ──────────────────────────────────────────────────
  generateKeystore: (opts: KeystoreOptions) => KeystoreResult
  listKeystoreAliases: (bytes: Uint8Array, password: string) => ListAliasesResult
  tryUnlockPrivateKey: (bytes: Uint8Array, password: string) => ProbeKeyPasswordResult

  // ── Service account validation ───────────────────────────────────────────
  validateServiceAccountJson: (opts: ValidateOptions) => Promise<ValidationResult>

  // ── Build credentials persistence ────────────────────────────────────────
  updateSavedCredentials: (
    appId: string,
    platform: 'ios' | 'android',
    credentials: Record<string, string>,
  ) => Promise<void>
  loadSavedCredentials: (appId: string) => Promise<unknown>

  // ── Onboarding progress persistence ─────────────────────────────────────
  saveAndroidProgress: (appId: string, progress: AndroidOnboardingProgress) => Promise<void>
  loadAndroidProgress: (appId: string) => Promise<AndroidOnboardingProgress | null>
  deleteAndroidProgress: (appId: string) => Promise<void>

  // ── File system (injected so effects can be tested without real FS) ──────
  readFile: (path: string) => Promise<Buffer>
  copyFile: (src: string, dest: string) => Promise<void>

  // ── OAuth (Task 4) ───────────────────────────────────────────────────────
  /**
   * Run the full browser OAuth flow. The driver pre-binds OAuth client config
   * (clientId, clientSecret, scopes) so the core never sees credentials —
   * config/scope policy lives in the driver.
   *
   * Signature mirrors RunOAuthFlowOptions from oauth-google.ts (minus
   * timeoutMs/signal which the driver controls internally).
   */
  runOAuthFlow: (callbacks: Pick<RunOAuthFlowOptions, 'onAuthUrl' | 'onStatus'>) => Promise<GoogleOAuthTokens>

  /**
   * Non-blocking OAuth starter (MCP fire-and-poll). Opens the browser and
   * starts the loopback listener, then returns a PendingOAuthSession immediately
   * without waiting for sign-in to complete. The MCP bridge uses this to
   * avoid blocking a single tool call on the full OAuth round-trip.
   *
   * Optional — only provided by the MCP driver. The Ink driver uses the
   * blocking `runOAuthFlow` instead and does not need this dep.
   *
   * The driver pre-binds OAuth client config (clientId, clientSecret, scopes).
   */
  startOAuthFlow?: (callbacks?: Pick<RunOAuthFlowOptions, 'onAuthUrl' | 'onStatus'>) => Promise<PendingOAuthSession>

  /**
   * Open a URL in the user's default browser — used by the MCP broker sign-in to (optionally) open the
   * sign-in link for the user. Best-effort: the engine falls back to showing the link if this throws or is
   * absent. Optional (the Ink driver never uses it).
   */
  openBrowser?: (url: string) => Promise<void>

  /** Fetch the signed-in user's profile (email, sub). */
  fetchUserInfo: (accessToken: string) => Promise<GoogleUserInfo>

  /**
   * Mint a fresh access token from the stored refresh token. Called before
   * each cloud step that needs one. The driver owns the token cache and
   * handles expiry.
   */
  getAccessToken: () => Promise<string>

  /**
   * Revoke a Google OAuth refresh token. Best-effort — the core swallows
   * failures (non-fatal; the token expires on its own).
   */
  revokeToken: (refreshToken: string) => Promise<void>

  // ── GCP Cloud Resource Manager / Service Usage / IAM (Task 4) ────────────
  /**
   * List GCP projects the user has access to.
   * Mirrors gcp-api.ts: listProjects(accessToken).
   */
  listProjects: (accessToken: string) => Promise<GcpProject[]>

  /**
   * List the user's Play Store apps via the Play Developer Reporting API
   * (apps:search). OPTIONAL — present only when the optional
   * playdeveloperreporting scope was granted; absent → android-app-verify
   * degrades (advances without verifying, never blocks). Mirrors
   * reporting-api.ts: listPlayApps(accessToken).
   */
  listPlayApps?: (accessToken: string) => Promise<{ packageName: string, displayName: string }[]>

  /**
   * Create a GCP project and wait for the operation to finish.
   * Mirrors gcp-api.ts: createProject(accessToken, projectId, displayName).
   */
  createProject: (accessToken: string, projectId: string, displayName: string) => Promise<GcpProject>

  /**
   * Enable an API on a project (idempotent).
   * Mirrors gcp-api.ts: enableService(accessToken, projectId, serviceName).
   */
  enableService: (accessToken: string, projectId: string, serviceName: string) => Promise<void>

  /**
   * Find or create the Capgo service account in a project.
   * Mirrors gcp-api.ts: ensureServiceAccount(args).
   */
  ensureServiceAccount: (args: {
    accessToken: string
    projectId: string
    accountId: string
    displayName?: string
    description?: string
  }) => Promise<{ account: GcpServiceAccount; created: boolean }>

  /**
   * Create a JSON key for a service account.
   * Mirrors gcp-api.ts: createServiceAccountKey(args).
   */
  createServiceAccountKey: (args: {
    accessToken: string
    projectId: string
    serviceAccountEmail: string
  }) => Promise<GcpServiceAccountKey>

  // ── Google Play Developer API (Task 4) ────────────────────────────────────
  /**
   * Invite the service account into the Play Console developer account.
   * Mirrors play-api.ts: inviteServiceAccount(args).
   */
  inviteServiceAccount: (args: {
    accessToken: string
    developerId: string
    serviceAccountEmail: string
    developerAccountPermissions?: readonly string[]
    grants?: ReadonlyArray<{ packageName: string; permissions: readonly string[] }>
  }) => Promise<void>

  // ── Android project detection (Task 4) ───────────────────────────────────
  /**
   * Find applicationId values in the Android Gradle build files.
   * The driver pre-binds `androidDir` so this dep is argless from the core's
   * perspective. The driver calls findAndroidApplicationIds(androidDir) under
   * the hood.
   */
  findAndroidApplicationIds: () => Promise<string[]>

  // ── Post-save "tail" helpers (Phase 1 engine tail) ───────────────────────
  // The CI-secrets → env-export → workflow-file → build-request sub-flow that
  // runs after credentials are saved. Every field is OPTIONAL and ADDITIVE: the
  // driver injects the concrete helper (pre-binding any cwd/runner/config it
  // owns) so the core stays IO-free. Signatures mirror the matching helper
  // modules verbatim so a driver can pass the real function unchanged. Cases
  // that consume these are wired in later tasks (A3/A4) — A2 only widens the
  // surface; existing call sites and the MCP bridge keep type-checking because
  // none of these are required.

  /**
   * Build the CI-secret entries (key/value/masked) from the saved credentials.
   * Mirrors ci-secrets.ts: createCiSecretEntries(credentials, apiKey?).
   */
  createCiSecretEntries?: (credentials: Partial<BuildCredentials>, apiKey?: string) => CiSecretEntry[]

  /**
   * Detect which CI-secret destinations (GitHub/GitLab) are reachable.
   * Mirrors ci-secrets.ts: detectCiSecretTargets(runner?). The driver pre-binds
   * the command runner, so the core calls this with no args.
   */
  detectCiSecretTargets?: (runner?: CommandRunner) => CiSecretDiscovery

  /**
   * Resolve the concrete `owner/repo` (GitHub) or `group/project` (GitLab) the
   * CLI will target, so the user can confirm before any secret is overwritten.
   * Mirrors ci-secrets.ts: getCiSecretRepoLabelAsync(target, runner?).
   */
  getCiSecretRepoLabelAsync?: (target: CiSecretTarget, runner?: AsyncCommandRunner) => Promise<string | null>

  /**
   * List which of `keys` already exist as secrets/variables on the remote.
   * Mirrors ci-secrets.ts: listExistingCiSecretKeysAsync(target, keys, runner?).
   */
  listExistingCiSecretKeysAsync?: (target: CiSecretTarget, keys: string[], runner?: AsyncCommandRunner) => Promise<string[]>

  /**
   * Push the CI-secret entries to the target, reporting per-key progress.
   * Mirrors ci-secrets.ts: uploadCiSecretsAsync(target, entries, existingKeys?, runner?, onProgress?).
   */
  uploadCiSecretsAsync?: (
    target: CiSecretTarget,
    entries: CiSecretEntry[],
    existingKeys?: string[],
    runner?: AsyncCommandRunner,
    onProgress?: (current: number, total: number, keyName: string) => void,
  ) => Promise<void>

  /**
   * Write the credentials to a local 0o600 `.env` file (no git operation).
   * Mirrors env-export.ts: exportCredentialsToEnv(opts).
   */
  exportCredentialsToEnv?: (opts: EnvExportOpts) => EnvExportResult

  /**
   * Resolve the default `.env` export path for an app + platform (pure).
   * Mirrors env-export.ts: defaultExportPath(appId, platform).
   */
  defaultExportPath?: (appId: string, platform: 'ios' | 'android') => string

  /**
   * Lockfile-based package-manager detection (pure, read-only). Drives the
   * pick-package-manager 'recommended — matches your lockfile' note.
   * Mirrors @capgo/find-package-manager: findPackageManagerType(cwd, 'npm').
   */
  detectPackageManager?: () => string

  /**
   * Generate the GitHub Actions workflow YAML (pure).
   * Mirrors workflow-generator.ts: generateWorkflow(opts).
   */
  generateWorkflow?: (opts: WorkflowGeneratorOpts) => GeneratedWorkflow

  /**
   * Generate + write the workflow file to `.github/workflows/capgo-build.yml`.
   * Mirrors workflow-writer.ts: writeWorkflowFile(opts, writeOptions?).
   */
  writeWorkflowFile?: (opts: WorkflowGeneratorOpts, writeOptions?: WorkflowWriteOptions) => WorkflowWriteResult

  /**
   * Fire the actual `capgo build request`. The driver pre-binds the logger /
   * silent flag it owns; the core supplies appId + options.
   * Mirrors request.ts: requestBuildInternal(appId, options, silent?, logger?).
   */
  requestBuildInternal?: (appId: string, options: BuildRequestOptions, silent?: boolean, logger?: BuildLogger) => Promise<BuildRequestResult>

  // ── streaming / telemetry / preload deps (forwarded to the shared tail) ────
  // OPTIONAL/ADDITIVE — the android TUI resolves these and the engine adapter
  // forwards them straight through `toTailDeps` into the shared `TailEffectDeps`
  // so `runTailEffect` streams build output, reports CI-secret progress/phase,
  // preloads workflow-builder scripts and fires workflow telemetry. Signatures
  // mirror the matching `TailEffectDeps` fields verbatim. When absent the shared
  // tail degrades gracefully (legacy behaviour), so existing callers and the MCP
  // bridge keep type-checking.

  /**
   * The streaming BuildLogger the TUI threads into requestBuildInternal (the 4th
   * arg) so every build line streams into `setBuildOutput`. Forwarded verbatim.
   */
  logger?: BuildLogger

  /**
   * The build VIEWER sink — the android TUI feeds this into `setBuildOutput` (the
   * dedicated build output pane, DISTINCT from the `onLog` side-log). The shared
   * tail writes the build header / blank+queued / ⚠ failure / no-key UX / catch
   * lines here. Forwarded verbatim through `toTailDeps`. No-op when absent.
   */
  onBuildOutput?: (line: string) => void

  /**
   * Resolves the Capgo API key the build request should use, mirroring the
   * android tail's CLI-flag-over-saved precedence. Returns undefined when no key
   * is resolvable (the no-key UX finishes at build-complete). Forwarded verbatim.
   */
  resolveApikey?: () => string | undefined

  /**
   * Per-key CI-secret upload progress, forwarded as the 5th arg of
   * uploadCiSecretsAsync. The android tail feeds this into
   * `setCiSecretUploadProgress`. No-op when absent.
   */
  onCiSecretUploadProgress?: (current: number, total: number, keyName: string) => void

  /**
   * The 2-phase checking-ci-secrets status text. The android tail feeds this into
   * `setCiSecretCheckPhase`. No-op when absent.
   */
  onCiSecretCheckPhase?: (phase: string) => void

  /**
   * The ci-secrets-failed reason (repo-null / catch in checking-ci-secrets). The
   * android tail feeds this into `setCiSecretError` (rendered by the
   * CiSecretsFailedStep). Forwarded verbatim through `toTailDeps`. No-op when absent.
   */
  onCiSecretError?: (message: string) => void

  /** Reads the project's package.json scripts map (workflow-builder preload). */
  getPackageScripts?: () => Record<string, string>
  /** Detects the web-framework project type (best-effort; may resolve null). */
  findProjectType?: (options?: { quiet?: boolean }) => Promise<string | null>
  /** Maps a detected project type to its recommended build script name. */
  findBuildCommandForProjectType?: (projectType: string) => Promise<string | null>

  /**
   * Workflow-file telemetry hook (e.g. 'workflow-file-written'). The android tail
   * calls `trackWorkflowEvent`. No-op when absent.
   */
  trackWorkflowEvent?: (event: string, options?: { decision?: string }) => void

  /**
   * DRIVER-HELD transient tail state, threaded back into each post-save tail
   * effect. The Ink TUI resolves these ONCE (at `saving-credentials`) and keeps
   * them in React state (`savedCredentials` / `ciSecretEntries` /
   * `ciSecretExistingKeys`); a headless driver mirrors that by capturing the
   * matching `AndroidEffectResult.transient` from each effect and passing it
   * back here on the NEXT effect. The engine NEVER persists these to
   * progress.json — they are secrets/credentials/entries that must stay in
   * memory only. When a field is absent (e.g. a crash-recovery resume where the
   * driver lost its in-memory state) the effect falls back to a SINGLE lossy
   * re-derivation from progress (rebuildTailCredentials / createCiSecretEntries)
   * rather than resolving the Capgo API key a second time.
   */
  carried?: {
    /** Full saved credentials map written at saving-credentials (5 fields, no CAPGO_TOKEN). */
    savedCredentials?: Record<string, string>
    /** CI-secret entries resolved ONCE at saving-credentials (creds + Capgo API key → CAPGO_TOKEN). */
    ciSecretEntries?: CiSecretEntry[]
    /** Which secret keys already exist on the remote, resolved at checking-ci-secrets. */
    ciSecretExistingKeys?: string[]
    /** Whether the workflow file did NOT exist at preview (app.tsx's `previewIsNew`); drives 'Wrote' vs 'Overwrote'. Defaults to NEW when absent. */
    workflowIsNew?: boolean
  }

  // ── Callbacks (optional — callers that don't need streaming can omit) ────
  onStatus?: (message: string) => void
  onLog?: (message: string, color?: string) => void
  /** Internal-only diagnostic line → the support internal log (main PR #2406). Optional; no-op when absent. */
  onInternalLog?: (line: string) => void
  onAuthUrl?: (url: string) => void
  signal?: AbortSignal
}

// ─── AndroidStepCtx (extend with needsKeyPasswordPrompt) ─────────────────────
// Already exported above; this documents the Task 3 addition.
// AndroidStepCtx.needsKeyPasswordPrompt?: boolean — returned in transient when
// keystore-existing-key-password could not auto-resolve the key password so the
// driver shows the manual input prompt.
// (The field is declared inside AndroidStepCtx above; re-export not needed.)

// ─── AndroidEffectResult ─────────────────────────────────────────────────────

export interface AndroidEffectResult {
  /** Updated progress after the effect ran (matches what was persisted). */
  progress: AndroidOnboardingProgress
  /** Explicit next step when not derivable from progress alone (★ transitions). */
  next?: AndroidOnboardingStep
  /** Transient runtime data that lives in the driver but is NOT persisted. */
  transient?: Partial<AndroidStepCtx>
}

// ─── Tail credential threading (parity with the Ink TUI) ─────────────────────
//
// The post-save tail steps (checking-ci-secrets / uploading-ci-secrets /
// exporting-env / writing-workflow-file) need the same CI-secret entries +
// saved credentials the Ink TUI holds in `ciSecretEntries` / `savedCredentials`
// React state, resolved ONCE at `saving-credentials` (where the Capgo API key
// is folded into the entries so CAPGO_TOKEN rides along). A headless driver
// mirrors that by threading those values back through `deps.carried.*` on each
// subsequent effect — so the engine REUSES them rather than re-resolving the
// API key (which it cannot see) a second time. The `rebuildTailCredentials`
// fallback below is a SINGLE lossy re-derivation used only when the driver's
// carried state is absent (e.g. a crash-recovery resume that lost the
// in-memory React/driver state); it omits CAPGO_TOKEN, matching the worst-case
// the TUI would hit on the same path.
function rebuildTailCredentials(progress: AndroidOnboardingProgress): Record<string, string> {
  const keystoreBase64 = progress._keystoreBase64
  const serviceAccountKeyBase64 = progress._serviceAccountKeyBase64
  const keystoreStorePassword = progress.keystoreStorePassword
  const keystoreAlias = progress.keystoreAlias
  if (!keystoreBase64 || !serviceAccountKeyBase64 || !keystoreStorePassword || !keystoreAlias)
    return {}
  return {
    ANDROID_KEYSTORE_FILE: keystoreBase64,
    KEYSTORE_KEY_ALIAS: keystoreAlias,
    KEYSTORE_STORE_PASSWORD: keystoreStorePassword,
    KEYSTORE_KEY_PASSWORD: progress.keystoreKeyPassword || keystoreStorePassword,
    PLAY_CONFIG_JSON: serviceAccountKeyBase64,
  }
}

/**
 * Build the ANDROID saved-credential SHAPE written at `saving-credentials`.
 * Replicates the doSaveCredentials guards verbatim (app.tsx:704–709) so the
 * shared tail module stays platform-neutral while android owns its field set.
 */
function buildAndroidSavedCredentials(progress: AndroidOnboardingProgress): Record<string, string> {
  const keystoreBase64 = progress._keystoreBase64
  if (!keystoreBase64)
    throw new Error('keystore not ready')
  const serviceAccountKeyBase64 = progress._serviceAccountKeyBase64
  if (!serviceAccountKeyBase64)
    throw new Error('service-account key not provisioned')
  const keystoreStorePassword = progress.keystoreStorePassword
  const keystoreAlias = progress.keystoreAlias
  if (!keystoreStorePassword || !keystoreAlias)
    throw new Error('keystore inputs missing')

  return {
    ANDROID_KEYSTORE_FILE: keystoreBase64,
    KEYSTORE_KEY_ALIAS: keystoreAlias,
    KEYSTORE_STORE_PASSWORD: keystoreStorePassword,
    KEYSTORE_KEY_PASSWORD: progress.keystoreKeyPassword || keystoreStorePassword,
    PLAY_CONFIG_JSON: serviceAccountKeyBase64,
  }
}

/**
 * The set of post-save tail steps the android engine delegates to the shared
 * platform-neutral module (`../tail/flow.js`). EXCLUDES ai-analysis-* (TUI-only)
 * and the android-specific provisioning effects. Effect-bearing tail steps live
 * in TAIL_EFFECT_STEPS; the view/input delegation uses TAIL_STEPS.
 */
const TAIL_EFFECT_STEPS = new Set<AndroidOnboardingStep>([
  'saving-credentials',
  'detecting-ci-secrets',
  'checking-ci-secrets',
  'uploading-ci-secrets',
  'exporting-env',
  'overwrite-and-export-env',
  'writing-workflow-file',
  'requesting-build',
])

const TAIL_VIEW_STEPS = new Set<AndroidOnboardingStep>([
  'ci-secrets-setup',
  'ci-secrets-target-select',
  'ask-ci-secrets',
  'confirm-ci-secret-overwrite',
  'ci-secrets-failed',
  'ask-github-actions-setup',
  'confirm-secrets-push',
  'ask-export-env',
  'confirm-env-export-overwrite',
  'pick-package-manager',
  'pick-build-script',
  'pick-build-script-custom',
  'preview-workflow-file',
  'view-workflow-diff',
  'ask-build',
  'build-complete',
])

const TAIL_INPUT_STEPS = new Set<AndroidOnboardingStep>([
  'ci-secrets-target-select',
  'ask-github-actions-setup',
  'ask-export-env',
  'pick-package-manager',
  'pick-build-script',
  'pick-build-script-custom',
])

/**
 * Adapt the android effect deps to the platform-neutral TailEffectDeps. The
 * shared tail module owns the routing/branching; android supplies its platform
 * tag, credential SHAPE, lossy rebuild and resume resolver, plus the same
 * injected helpers (passed straight through).
 */
function toTailDeps(deps: AndroidEffectDeps): TailEffectDeps<AndroidOnboardingProgress> {
  return {
    platform: 'android',
    buildSavedCredentials: buildAndroidSavedCredentials,
    rebuildTailCredentials,
    resumeStep: getAndroidResumeStep,
    updateSavedCredentials: deps.updateSavedCredentials,
    loadProgress: deps.loadAndroidProgress,
    saveProgress: deps.saveAndroidProgress,
    deleteProgress: deps.deleteAndroidProgress,
    createCiSecretEntries: deps.createCiSecretEntries,
    detectCiSecretTargets: deps.detectCiSecretTargets,
    getCiSecretRepoLabelAsync: deps.getCiSecretRepoLabelAsync,
    listExistingCiSecretKeysAsync: deps.listExistingCiSecretKeysAsync,
    uploadCiSecretsAsync: deps.uploadCiSecretsAsync,
    exportCredentialsToEnv: deps.exportCredentialsToEnv,
    defaultExportPath: deps.defaultExportPath,
    generateWorkflow: deps.generateWorkflow,
    writeWorkflowFile: deps.writeWorkflowFile,
    requestBuildInternal: deps.requestBuildInternal,
    // ── streaming / telemetry / preload deps forwarded verbatim ──────────────
    logger: deps.logger,
    onBuildOutput: deps.onBuildOutput,
    resolveApikey: deps.resolveApikey,
    onCiSecretUploadProgress: deps.onCiSecretUploadProgress,
    onCiSecretCheckPhase: deps.onCiSecretCheckPhase,
    onCiSecretError: deps.onCiSecretError,
    getPackageScripts: deps.getPackageScripts,
    findProjectType: deps.findProjectType,
    findBuildCommandForProjectType: deps.findBuildCommandForProjectType,
    trackWorkflowEvent: deps.trackWorkflowEvent,
    carried: deps.carried,
    onStatus: deps.onStatus,
    onLog: deps.onLog,
    onInternalLog: deps.onInternalLog,
    signal: deps.signal,
  }
}

/** Map the shared TailStepView back onto AndroidStepView (same field shape). */
function mapTailViewToAndroidStepView(v: TailStepView, step: AndroidOnboardingStep): AndroidStepView {
  return {
    step,
    kind: v.kind,
    title: v.title,
    prompt: v.prompt,
    collect: v.collect,
    options: v.options,
    message: v.message,
  }
}

// ─── runAndroidEffect ─────────────────────────────────────────────────────────
//
// Dispatches to the right effect handler for auto steps that do IO.
// Throws `Error('Unhandled effect step: ${step}')` for steps not yet
// implemented in this task — the driver catches and surfaces the error.
//
// Persistence contract: the effect calls `deps.saveAndroidProgress` at the
// SAME points app.tsx's `persist()` calls fire (crash-recovery parity), AND
// returns the final progress in AndroidEffectResult.progress. The driver may
// also call saveAndroidProgress for steps where the effect's transient result
// implies a state change but the effect intentionally withholds (e.g.
// keystore-existing-detecting-alias persists alias; detecting fails → no persist).

export async function runAndroidEffect(
  step: AndroidOnboardingStep,
  progress: AndroidOnboardingProgress,
  deps: AndroidEffectDeps,
): Promise<AndroidEffectResult> {
  // Post-save tail: delegate to the platform-neutral shared module. The tail
  // routing/branching/transient-threading lives there once for ios + android;
  // android supplies its platform tag + credential SHAPE via toTailDeps. The
  // returned neutral result maps 1:1 onto AndroidEffectResult (next is a wider
  // AndroidOnboardingStep; transient is a subset of AndroidStepCtx).
  if (TAIL_EFFECT_STEPS.has(step)) {
    const result = await runTailEffect(step as TailStep, progress, toTailDeps(deps))
    return {
      progress: result.progress,
      next: result.next as AndroidOnboardingStep | undefined,
      transient: result.transient,
    }
  }

  switch (step) {
    // ── backing-up ────────────────────────────────────────────────────────
    // app.tsx:1017–1035. Copy the existing ~/.capgo-credentials/credentials.json
    // to a timestamped sibling before the keystore phase overwrites it, then
    // advance to keystore-method-select. A missing source file is non-fatal
    // (yellow warning) — the gate's promise was "backup first", not "must exist".
    // The gate transitions to 'done' so resume falls through to keystore.
    case 'backing-up': {
      const credPath = join(homedir(), '.capgo-credentials', 'credentials.json')
      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const backupPath = join(homedir(), '.capgo-credentials', `credentials-${date}.copy.json`)
      try {
        await deps.copyFile(credPath, backupPath)
        deps.onLog?.(`✔ Backup saved · ${backupPath}`)
      }
      catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        deps.onInternalLog?.(`credentials backup failed: ${reason}`)
        // Only ENOENT means "nothing to back up yet" — that stays benign. Any
        // OTHER failure (EACCES, disk full, …) keeps the proceed-anyway gate
        // contract but must report the REAL reason instead of pretending the
        // file may not exist (hostile-review, 2026-06-12).
        const missingSource = (err as { code?: string } | null)?.code === 'ENOENT' || /ENOENT/.test(reason)
        if (missingSource)
          deps.onLog?.('⚠ Could not backup credentials (file may not exist yet)', 'yellow')
        else
          deps.onLog?.(`⚠ Could not back up credentials: ${reason}`, 'yellow')
      }
      const nextProgress: AndroidOnboardingProgress = { ...progress, _credentialsExistGate: 'done' }
      await deps.saveAndroidProgress(progress.appId, nextProgress)
      return { progress: nextProgress, next: 'keystore-method-select' }
    }

    // ── keystore-existing-detecting-alias ─────────────────────────────────
    // app.tsx:903–942
    case 'keystore-existing-detecting-alias': {
      const bytes = await deps.readFile(progress.keystoreExistingPath!)
      const listed = deps.listKeystoreAliases(bytes, progress.keystoreStorePassword!)

      if (listed.ok && listed.aliases.length === 1) {
        const alias = listed.aliases[0]
        const nextProgress: AndroidOnboardingProgress = { ...progress, keystoreAlias: alias }
        await deps.saveAndroidProgress(progress.appId, nextProgress)
        deps.onLog?.(`✔ Detected alias · ${alias}`)
        return { progress: nextProgress, next: 'keystore-existing-key-password' }
      }

      if (listed.ok && listed.aliases.length > 1) {
        // Do NOT persist alias — user must choose from transient detectedAliases
        return {
          progress,
          next: 'keystore-existing-alias-select',
          transient: { detectedAliases: listed.aliases },
        }
      }

      if (!listed.ok && listed.reason === 'wrong-password') {
        // Do NOT throw — the driver owns the error UX for this case.
        // Return a transient signal so the driver can reproduce the original behavior:
        //   setError('Store password was rejected...')
        //   setRetryStep('keystore-existing-store-password')
        //   setStep('error')
        // without calling handleError (which would bump retryCount).
        return { progress, next: 'keystore-existing-store-password', transient: { wrongPassword: true } }
      }

      // unsupported-format (JKS etc.) or 0 aliases → ask manually
      // (app.tsx:931–935: unsupported→log+alias, ok+0→log+alias)
      if (!listed.ok && listed.reason === 'unsupported-format')
        deps.onLog?.('ℹ Couldn\'t auto-detect alias (JKS format or similar) — enter it manually.', 'yellow')
      else if (listed.ok)
        deps.onLog?.('ℹ Couldn\'t auto-detect alias from the keystore — enter it manually.', 'yellow')
      return { progress, next: 'keystore-existing-alias' }
    }

    // ── keystore-existing-key-password ────────────────────────────────────
    // app.tsx:951–1037 (auto probe) + 2058–2095 (prompt onSubmit completion)
    //
    // Unified handler: the effect is called twice on the prompt path —
    //   1st call: probe fails → returns { next: 'keystore-existing-key-password',
    //             transient: { needsKeyPasswordPrompt: true } } — driver shows prompt.
    //   2nd call: after applyAndroidInput has recorded keystoreKeyPassword,
    //             probe resolves from progress → continues to completion.
    case 'keystore-existing-key-password': {
      let resolvedKeyPw: string | null = null
      let resolution: 'progress' | 'probed-same' | null = null

      // Path 1: progress already has keystoreKeyPassword (from resume or prompt submission)
      if (progress.keystoreKeyPassword) {
        resolvedKeyPw = progress.keystoreKeyPassword
        resolution = 'progress'
      }
      // Path 2: attempt PKCS#12 probe with the store password
      else if (progress.keystoreStorePassword && progress.keystoreExistingPath) {
        try {
          const bytes = await deps.readFile(progress.keystoreExistingPath)
          const result = deps.tryUnlockPrivateKey(bytes, progress.keystoreStorePassword)
          if (result.ok) {
            resolvedKeyPw = progress.keystoreStorePassword
            resolution = 'probed-same'
          }
        }
        catch {
          // readFile failed — fall through to prompt
        }
      }

      if (!resolvedKeyPw) {
        // Prompt path: tell the driver to show the key-password input
        return {
          progress,
          next: 'keystore-existing-key-password',
          transient: { needsKeyPasswordPrompt: true },
        }
      }

      // Auto-resolved — complete the keystore phase (app.tsx:994–1031)
      if (resolution === 'probed-same')
        deps.onLog?.('ℹ Key password matches store password — using the same value')
      const keyPw = resolvedKeyPw
      deps.onLog?.('✔ Key password set')
      const bytes = await deps.readFile(progress.keystoreExistingPath!)
      const base64 = bytes.toString('base64')
      const ready: KeystoreReady = {
        keystorePath: progress.keystoreExistingPath!,
        alias: progress.keystoreAlias || RELEASE_ALIAS_DEFAULT,
        isGenerated: false,
      }
      const nextProgress: AndroidOnboardingProgress = {
        ...progress,
        keystoreKeyPassword: keyPw,
        _keystoreBase64: base64,
        serviceAccountForkSeen: true,
        completedSteps: { ...progress.completedSteps, keystoreReady: ready },
      }
      await deps.saveAndroidProgress(progress.appId, nextProgress)
      deps.onLog?.(`✔ Keystore loaded — ${progress.keystoreExistingPath!}`)

      // Smart-route: load fresh progress to check for prior OAuth progress.
      // app.tsx:1024–1031
      const fresh = await deps.loadAndroidProgress(progress.appId)
      const hasOAuthProgress = fresh ? hasAnyOAuthProgress(fresh) : false
      let nextStep: AndroidOnboardingStep
      if (hasOAuthProgress || fresh?.serviceAccountMethod !== undefined) {
        nextStep = fresh ? getAndroidResumeStep(fresh) : 'service-account-method-select'
      }
      else {
        nextStep = 'service-account-method-select'
      }

      return { progress: nextProgress, next: nextStep }
    }

    // ── keystore-generating ───────────────────────────────────────────────
    // app.tsx:1040–1093
    case 'keystore-generating': {
      const storePw = progress.keystoreStorePassword!
      const keyPw = progress.keystoreKeyPassword || storePw
      const cn = progress.keystoreCommonName || progress.appId
      const result = deps.generateKeystore({
        alias: progress.keystoreAlias || RELEASE_ALIAS_DEFAULT,
        storePassword: storePw,
        keyPassword: keyPw,
        dname: { commonName: cn, organizationName: 'Capgo' },
      })

      const defaultPath = `android/app/${result.alias}.p12`
      const ready: KeystoreReady = {
        keystorePath: defaultPath,
        alias: result.alias,
        isGenerated: true,
      }

      const nextProgress: AndroidOnboardingProgress = {
        ...progress,
        keystoreMethod: 'generate',
        keystoreAlias: result.alias,
        keystoreStorePassword: storePw,
        keystoreKeyPassword: keyPw,
        keystoreCommonName: cn,
        _keystoreBase64: result.p12Base64,
        serviceAccountForkSeen: true,
        completedSteps: { ...progress.completedSteps, keystoreReady: ready },
      }

      await deps.saveAndroidProgress(progress.appId, nextProgress)
      deps.onLog?.(`✔ Keystore generated — alias: ${result.alias}, valid until ${result.notAfter.getFullYear()}`)

      // After fresh keystore generation in this run, always land on the
      // new method-select fork — no prior SA choice exists yet.
      // app.tsx:1086
      return { progress: nextProgress, next: 'service-account-method-select' }
    }

    // ── sa-json-validating ────────────────────────────────────────────────
    // app.tsx:835–901
    case 'sa-json-validating': {
      const jsonBytes = await deps.readFile(progress.serviceAccountJsonPath!)
      const packageName = progress.completedSteps.androidPackageChosen!.packageName

      const result = await deps.validateServiceAccountJson({
        jsonBytes,
        packageName,
        signal: deps.signal,
      })

      if (result.ok) {
        const base64 = jsonBytes.toString('base64')
        const nextProgress: AndroidOnboardingProgress = {
          ...progress,
          _serviceAccountKeyBase64: base64,
          // Clear any stale "skipped" flag from a previous attempt (app.tsx:869)
          serviceAccountValidationSkipped: false,
        }
        await deps.saveAndroidProgress(progress.appId, nextProgress)
        deps.onLog?.(`✔ Service account verified — ${result.serviceAccountEmail}`)
        return { progress: nextProgress, next: 'saving-credentials' }
      }

      // Failure — do NOT persist the key (app.tsx never persists on failure)
      // shape-error: surface as a banner log (app.tsx:893)
      if (result.kind === 'shape-error')
        deps.onLog?.(`✖ ${result.message}`, 'red')
      return {
        progress,
        next: 'sa-json-validation-failed',
        transient: { saValidation: result },
      }
    }

    // ── google-sign-in-running ────────────────────────────────────────────
    // app.tsx:1095–1166
    //
    // The driver pre-binds OAuth client config + scopes into deps.runOAuthFlow,
    // keeping config/scope policy in the driver and out of the core.
    case 'google-sign-in-running': {
      let tokens: GoogleOAuthTokens
      try {
        tokens = await deps.runOAuthFlow({
          onAuthUrl: deps.onAuthUrl,
          onStatus: deps.onStatus,
        })
      }
      catch (err) {
        // User deselected one or more scopes on the consent screen.
        // Treat this as a recoverable input error: route back to the pre-consent
        // screen so the user can try again. Do NOT burn a retry strike.
        if (err instanceof MissingScopesError) {
          deps.onLog?.('✖ Sign-in did not grant all required permissions.', 'red')
          for (const scope of err.missing)
            deps.onLog?.(`  • Missing: ${scope}`, 'yellow')
          deps.onLog?.('Please retry sign-in and leave every requested permission checked.', 'yellow')
          return { progress, next: 'google-sign-in' }
        }
        throw err
      }

      if (!tokens.refreshToken) {
        throw new Error('Google did not return a refresh token — try again.')
      }

      const info = await deps.fetchUserInfo(tokens.accessToken)

      const nextProgress = applyGoogleSignIn(progress, tokens, info)

      await deps.saveAndroidProgress(progress.appId, nextProgress)
      deps.onLog?.(`✔ Signed in as ${info.email}`)

      // Return the fresh access token in transient so the driver can seed its
      // token cache and avoid an immediate refresh on the next GCP call.
      // If the driver ignores it, deps.getAccessToken() will mint one —
      // behaviorally identical.
      return {
        progress: nextProgress,
        next: 'play-developer-id-input',
        transient: { accessToken: tokens.accessToken },
      }
    }

    // ── gcp-projects-loading ──────────────────────────────────────────────
    // app.tsx:1183–1198
    //
    // Pure load: fetch GCP projects, return in transient, do NOT persist.
    case 'gcp-projects-loading': {
      const tok = await deps.getAccessToken()
      const projects = await deps.listProjects(tok)
      return {
        progress,
        next: 'gcp-projects-select',
        transient: {
          gcpProjects: projects.map(p => ({
            projectId: p.projectId,
            name: p.name,
            projectNumber: p.projectNumber,
          })),
        },
      }
    }

    // ── android-app-verify ────────────────────────────────────────────────
    //
    // Generate path only: list the user's real Play apps (apps:search) and
    // reconcile against the chosen package. Exact-match → mark verified + advance.
    // No-match → stash apps+outcome in transient and STAY (the view becomes the
    // create-app / re-check gate). Any failure (import path, no reporting scope,
    // 403, network) → degrade: mark verified:false + advance. NEVER blocks.
    case 'android-app-verify': {
      const chosen = progress.completedSteps.androidPackageChosen?.packageName
      // Persist the verification marker BEFORE advancing so a crash/resume between
      // here and saving-credentials does not re-enter verify (and re-provision).
      // Best-effort: a save failure must not throw out of the effect (that would
      // hang the Ink spinner, whose failedStep is undefined); resume just re-runs
      // the idempotent check.
      const markAndAdvance = async (verified: boolean): Promise<AndroidEffectResult> => {
        const nextProgress: AndroidOnboardingProgress = {
          ...progress,
          completedSteps: {
            ...progress.completedSteps,
            playAppVerified: { packageName: chosen ?? '', verified },
          },
        }
        try {
          await deps.saveAndroidProgress(progress.appId, nextProgress)
        }
        catch {
          // best-effort; resume re-runs the verify check if the marker didn't land.
        }
        return { progress: nextProgress, next: 'gcp-setup-running' }
      }
      if (!chosen || progress.serviceAccountMethod !== 'generate' || !deps.listPlayApps)
        return await markAndAdvance(false)
      try {
        const tok = await deps.getAccessToken()
        const apps = await deps.listPlayApps(tok)
        const result = reconcileAndroidApp({ gradleIds: [chosen], apps })
        if (result.kind === 'exact-match')
          return await markAndAdvance(true)
        // A single chosen id reconciles to only no-app or wrong-build-id here
        // (multi-gradle needs >1 gradle id). Stash apps + outcome; the view
        // becomes the create-app / pick-different gate.
        return {
          progress,
          next: 'android-app-verify',
          transient: {
            playVerifyApps: apps.map(a => ({ packageName: a.packageName, displayName: a.displayName })),
            playVerifyOutcome: result.kind === 'no-app' ? 'no-app' : 'wrong-build-id',
          },
        }
      }
      catch (err) {
        // scope-missing / 403 / network: degrade (never block onboarding), but
        // leave a breadcrumb so a genuine failure is not completely silent.
        deps.onInternalLog?.(`android-app-verify: apps:search failed, continuing unverified (${err instanceof Error ? err.message : String(err)})`)
        return await markAndAdvance(false)
      }
    }

    // ── android-package-select (pre-load) ─────────────────────────────────
    // app.tsx:1173–1181
    //
    // Pure load: detect Gradle applicationIds, return in transient.
    // Stays on android-package-select so the driver re-renders as a choice
    // once detectedPackageIds is populated. Do NOT persist here.
    case 'android-package-select': {
      const ids = await deps.findAndroidApplicationIds()
      // Enrich the picker with each id's Play Store status so the user sees, at
      // pick time, which Gradle applicationIds already exist in Play (and which
      // would hit the create-app gate). Best-effort: generate path only (the
      // import path has no user OAuth token / reporting scope) and any failure
      // (scope skipped, 403, network) degrades silently to the plain picker and
      // never blocks. Reuses the same apps:search the verify step reconciles.
      let playVerifyApps: { packageName: string, displayName: string }[] | undefined
      if (progress.serviceAccountMethod === 'generate' && deps.listPlayApps) {
        try {
          const tok = await deps.getAccessToken()
          playVerifyApps = await deps.listPlayApps(tok)
        }
        catch (err) {
          // Degrade to the plain picker (the verify step re-checks anyway), but
          // leave a breadcrumb so a real failure is not completely invisible.
          deps.onInternalLog?.(`android-package-select: Play apps preload failed, showing plain picker (${err instanceof Error ? err.message : String(err)})`)
        }
      }
      return {
        progress,
        next: 'android-package-select',
        transient: { detectedPackageIds: ids, ...(playVerifyApps ? { playVerifyApps } : {}) },
      }
    }

    // ── gcp-setup-running ─────────────────────────────────────────────────
    // app.tsx:1200–1342
    //
    // The full GCP + Play provisioning chain. Persists incrementally after
    // each major step for crash-recovery parity with app.tsx.
    case 'gcp-setup-running': {
      const tok = await deps.getAccessToken()

      // Use a mutable local reference so incremental persistence can build on
      // the latest persisted state (mirrors app.tsx's local `projectChoice`
      // mutation + `persist()` calls).
      let currentProgress: AndroidOnboardingProgress = progress

      // Read gcpProjectChosen from progress — may be updated locally below
      // (incremental persistence after project creation).
      let projectChoice = currentProgress.completedSteps.gcpProjectChosen

      // Step A: create project if the user chose "new" and it hasn't been
      // created yet (crash-resume: if projectNumber is already set, skip).
      if (projectChoice && projectChoice.createdByOnboarding && !projectChoice.projectNumber) {
        deps.onStatus?.(`Creating GCP project ${projectChoice.projectId}...`)
        const created = await deps.createProject(tok, projectChoice.projectId, projectChoice.displayName)
        projectChoice = { ...projectChoice, projectNumber: created.projectNumber }
        currentProgress = {
          ...currentProgress,
          completedSteps: { ...currentProgress.completedSteps, gcpProjectChosen: projectChoice },
        }
        await deps.saveAndroidProgress(currentProgress.appId, currentProgress)
        deps.onStatus?.(`✔ Project created (number ${created.projectNumber})`)
      }

      if (!projectChoice) {
        throw new Error('No GCP project selected')
      }

      const projectId = projectChoice.projectId

      // Step B: enable Android Publisher API (idempotent).
      deps.onStatus?.(`Enabling ${ANDROIDPUBLISHER_API}...`)
      await deps.enableService(tok, projectId, ANDROIDPUBLISHER_API)
      deps.onStatus?.('✔ API enabled')

      // Step C: create or find the capgo-native-build service account.
      deps.onStatus?.(`Ensuring service account "${DEFAULT_SERVICE_ACCOUNT_ID}"...`)
      const { account: sa, created: saCreated } = await deps.ensureServiceAccount({
        accessToken: tok,
        projectId,
        accountId: DEFAULT_SERVICE_ACCOUNT_ID,
        displayName: DEFAULT_SERVICE_ACCOUNT_DISPLAY_NAME,
        description: DEFAULT_SERVICE_ACCOUNT_DESCRIPTION,
      })
      const saProv = {
        email: sa.email,
        projectId,
        uniqueId: sa.uniqueId,
      }
      deps.onStatus?.(saCreated ? `✔ Service account created — ${sa.email}` : `✔ Service account exists — ${sa.email}`)

      // Step D: create a fresh JSON key for the SA.
      // Persist after this step so the key is safe even if later steps fail.
      deps.onStatus?.('Creating service-account JSON key...')
      const key = await deps.createServiceAccountKey({
        accessToken: tok,
        projectId,
        serviceAccountEmail: sa.email,
      })
      currentProgress = {
        ...currentProgress,
        _serviceAccountKeyBase64: key.privateKeyDataBase64,
        completedSteps: { ...currentProgress.completedSteps, serviceAccountProvisioned: saProv },
      }
      await deps.saveAndroidProgress(currentProgress.appId, currentProgress)
      deps.onStatus?.('✔ Key created')

      // Step E: invite the SA into the Play Developer account.
      const playAccountChoice = currentProgress.completedSteps.playAccountChosen
      if (!playAccountChoice) {
        throw new Error('No Play Developer account chosen')
      }
      const androidPackageChoice = currentProgress.completedSteps.androidPackageChosen
      deps.onStatus?.(`Inviting ${sa.email} to Play Console...`)
      try {
        if (!androidPackageChoice) {
          throw new Error('No Android package selected for the Play invite')
        }
        await deps.inviteServiceAccount({
          accessToken: tok,
          developerId: playAccountChoice.developerId,
          serviceAccountEmail: sa.email,
          developerAccountPermissions: CAPGO_SA_DEVELOPER_PERMISSIONS,
          grants: [{
            packageName: androidPackageChoice.packageName,
            permissions: CAPGO_SA_APP_PERMISSIONS,
          }],
        })
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Treat "already exists" style failures as success — the SA is already
        // a user on this developer account from a prior run.
        if (!/already|exists|duplicate/i.test(msg)) {
          throw err
        }
        deps.onStatus?.('ℹ Service account was already invited — continuing')
      }

      const invite = {
        developerId: playAccountChoice.developerId,
        serviceAccountEmail: sa.email,
      }
      currentProgress = {
        ...currentProgress,
        completedSteps: { ...currentProgress.completedSteps, playInviteProvisioned: invite },
      }
      await deps.saveAndroidProgress(currentProgress.appId, currentProgress)
      deps.onStatus?.('✔ Play Console invite confirmed')

      // Step F: revoke the OAuth token now that provisioning succeeded — from here Capgo uses the service
      // account JSON key. The TUI loopback stores a refresh token; the MCP broker stores a short-lived access
      // token. Revoke whichever is present (Google's revoke endpoint accepts either). Failure is non-fatal:
      // the token expires within ~1 hour regardless.
      const oauthTokenToRevoke = currentProgress._oauthRefreshToken ?? currentProgress._oauthAccessToken
      if (oauthTokenToRevoke) {
        deps.onStatus?.('Revoking OAuth token (we don\'t need it anymore)...')
        let revoked = false
        try {
          await deps.revokeToken(oauthTokenToRevoke)
          revoked = true
          deps.onStatus?.('✔ OAuth token revoked')
        }
        catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          deps.onStatus?.(`⚠ Revoke request failed (${msg}) — token will expire on its own`)
        }
        if (revoked) {
          // The token is now dead — strip both token fields from progress so a revoked credential doesn't
          // linger in progress.json (CodeRabbit, 2026-06-12). On a failed revoke they are KEPT: they expire
          // on their own and a crash-resume re-enters this step to retry.
          const { _oauthRefreshToken: _r, _oauthAccessToken: _a, _oauthAccessTokenExpiresAt: _e, ...withoutToken } = currentProgress
          currentProgress = withoutToken
          await deps.saveAndroidProgress(currentProgress.appId, currentProgress)
        }
      }

      deps.onLog?.('✔ Google Cloud + Play setup complete')
      return { progress: currentProgress, next: 'saving-credentials' }
    }

    // ── Not yet implemented (bootstrap / post-save tail / native-picker) ──
    default:
      throw new Error(`Unhandled effect step: ${step}`)
  }
}

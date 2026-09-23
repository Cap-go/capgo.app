// src/build/onboarding/mcp/engine.ts
import type { AndroidOnboardingProgress, AndroidOnboardingStep } from '../android/types.js'
import type { AndroidEffectDeps, AndroidStepCtx } from '../android/flow.js'
import type { IosEffectDeps, IosStepCtx, IosStepView } from '../ios/flow.js'
import type { OnboardingProgress, OnboardingStep } from '../types.js'
import type { ChoiceOption, NextStepResult, Platform, StepKind } from './contract.js'
import type { IosCarried, TailParkedState } from './session-state.js'
import type { BuildOutputRecord } from '../../output-record.js'
import type { TailEffectProgress, TailStep, TailStepCtx } from '../tail/flow.js'
import { consoleWebUrl } from '../../../utils.js'
import { buildAppIdConflictSuggestions } from '../../../init/app-conflict.js'
import { ONBOARDING_RULES } from './contract.js'
import { explainForState } from './explanations.js'
import { isSafeAppIdForCommand } from './app-id-validation.js'
import { ANDROID_STEP_PROGRESS } from '../android/types.js'
import { STEP_PROGRESS } from '../types.js'
import { getAndroidResumeStep } from '../android/progress.js'
import { extractDeveloperId } from '../android/play-api.js'
import { getIosResumeStep } from '../ios/progress.js'
import { TAIL_INPUT_KEYS, validateIosStepInput, validateStepInput, validateStorePassword, validateTailStepInput } from './step-input.js'
import { androidViewForStep, applyAndroidInput, applyGoogleSignInBroker, runAndroidEffect } from '../android/flow.js'
import { applyIosInput, iosViewForStep, runIosEffect } from '../ios/flow.js'
import { applyTailInput, tailViewForStep } from '../tail/flow.js'
import { clearSession, clearSessionCarried, dropIosCarried, getAppflowProgress, getResumeResolvedFor, getSession, getSessionPlatform, mergeIosCarried, mergeTailCarried, setAppflowGate, setAppflowProgress, setResumeResolvedFor, setSessionPlatform, setTailParked } from './session-state.js'
import { slimAndroidTailProgress, slimIosTailProgress } from './tail-progress.js'
import { brokerBegin, brokerClear, brokerPoll } from './broker-session.js'
import type { GoogleUserInfo } from '../android/oauth-google.js'
import { SUPPORT_EMAIL } from '../../../support/contact-support.js'
import { appflowFlow, platformsToBuild } from '../appflow/flow.js'
import type { AppflowEffectResult } from '../appflow/flow.js'
import type { AppflowProgress, AppflowStep } from '../appflow/types.js'
import type { StepView } from '../flow/contract.js'
import { buildAppflowEffectDeps, persistAppflowCredentials } from '../appflow/deps.js'

/** Facts gathered during preflight; the pure deciders branch only on these. */
export interface PreflightFacts {
  capacitorProject: boolean
  appId?: string
  platformsDetected: Platform[]
  authenticated: boolean
  appRegistered: boolean
  androidProgress: AndroidOnboardingProgress | null
  iosProgress: OnboardingProgress | null
}

const ROADMAP: string[] = [
  'Preflight — detect your project & account',
  'Register the app in Capgo',
  'Set up signing credentials',
  'Run your first cloud build',
]

const NEXT_STEP_TOOL = 'capgo_builder_onboarding_next_step'

/** User input carried into the flow via next_step. */
interface OnboardingInput {
  platform?: string
  serviceAccountJsonPath?: string
  runBuild?: boolean
  checkBuild?: boolean
  keyId?: string
  issuerId?: string
  p8Path?: string
  serviceAccountMethod?: 'generate' | 'existing'
  playDeveloperId?: string
  gcpProjectId?: string
  gcpProjectName?: string
  androidPackage?: string
  androidVerifyAction?: 'open' | 'recheck' | 'cancel' | 'proceed'
  saMethodChoice?: 'retry' | 'save-anyway' | 'oauth'
  /** Set true at google-sign-in to (re)open the browser for a fresh OAuth — recovery when the browser didn't open, was closed, or the sign-in stalled. */
  reopenSignIn?: boolean
  /** At google-sign-in: open the broker sign-in link in the user's browser (true) or let them open it (false/omit). */
  openSignInBrowser?: boolean
  /** The confirmation code the user reads off the broker success page — releases the token on poll. */
  confirmCode?: string
  /** Answer to the resume prompt: 'continue' resumes the saved step, 'restart' wipes this platform's saved progress and begins again. */
  resumeChoice?: 'continue' | 'restart'
  credentialsExistChoice?: 'backup' | 'cancel'
  keystoreMethod?: 'existing' | 'generate'
  keystorePath?: string
  keystoreStorePassword?: string
  keystoreAlias?: string
  keystoreKeyPassword?: string
  keystoreNewAlias?: string
  keystorePasswordMethod?: 'random' | 'manual'
  keystoreCommonName?: string
  /** Answer to the parked iOS verify-app gate (the TUI Select vocabulary). */
  verifyAction?: 'pick' | 'create-new' | 'autofix' | 'continue' | 'recheck' | 'open' | 'reopen' | 'back' | 'cancel'
  /** The picked App Store app's bundle id — only with verifyAction 'pick'. */
  verifyAppId?: string
  /**
   * Answer to the parked iOS cert-limit-prompt (S6b): the Apple resource id of
   * the Distribution certificate to revoke, or '__exit__' (the engine's
   * OPTION_CERT_LIMIT_EXIT sentinel) to stop.
   */
  certToRevoke?: string
  /** Answer to the parked iOS duplicate-profile-prompt (S6b). */
  duplicateProfileAction?: 'delete' | 'exit'
  /**
   * Answer to the parked iOS error recovery screen (S6b): 'retry' re-runs the
   * failing step (carried.retryStep), 'restart' wipes progress + session and
   * starts over, 'exit' stops, 'email-support' surfaces support instructions
   * (MCP-only arm — no host-side opens).
   */
  errorAction?: 'retry' | 'restart' | 'exit' | 'email-support'
  // ── Post-build tail answers (S9-S11) — one field per step family ───────────
  // The per-step value vocabulary + one-answer-per-call is enforced by the
  // strict tail gate (validateTailStepInput) against the parked/resume step.
  /** Answer to the CI-secrets choice steps (target-select / ask / overwrite / push-confirm / setup / failed). */
  ciSecretAction?: 'github' | 'gitlab' | 'skip' | 'yes' | 'no' | 'replace' | 'retry' | 'continue' | 'confirm' | 'cancel'
  /** Answer to ask-github-actions-setup ('no' maps to the persisted setupMode 'declined'). */
  githubActionsSetup?: 'with-workflow' | 'secrets-only' | 'no'
  /** Answer to ask-export-env (yes/no) and confirm-env-export-overwrite (replace/skip). */
  exportEnvAction?: 'yes' | 'no' | 'replace' | 'skip'
  /** Custom .env target path — only together with exportEnvAction 'yes'. */
  envExportPath?: string
  /** Answer to pick-package-manager. */
  packageManager?: 'bun' | 'npm' | 'pnpm' | 'yarn'
  /** Answer to pick-build-script: a script name, '__custom__', or '__skip__'. */
  buildScript?: string
  /** Answer to pick-build-script-custom: the exact custom build command. */
  buildScriptCustom?: string
  /** Answer to preview-workflow-file: write / view (returns the file text, re-asks) / cancel. */
  workflowFileAction?: 'write' | 'view' | 'cancel'
  // ── iOS import-existing fork answers (S12) — one field per step ─────────────
  // The per-step vocabulary + one-answer-per-call is enforced by the strict iOS
  // gate (validateIosStepInput) against the effective (parked/resume) step.
  /** Answer to the iOS setup-method fork: create fresh credentials via Apple, or import from this Mac's Keychain. */
  setupMethod?: 'create-new' | 'import-existing'
  /** Answer to import-distribution-mode ('__cancel__' switches to the create-new path). */
  importDistribution?: 'app_store' | 'ad_hoc' | '__cancel__'
  /** Answer to import-pick-identity: the chosen identity's SHA-1 (an option value), or '__cancel__' for create-new. */
  identityChoice?: string
  /** Answer to import-pick-profile: the chosen profile's UUID (an option value), or '__back__' to re-pick the identity. */
  profileChoice?: string
  /** Answer to the import-no-match-recovery hub. */
  importRecoveryAction?: 'create' | 'provide-profile-path' | 'browser' | 'back'
  /** Answer to import-portal-explanation (the manual Apple-portal walkthrough). */
  portalAction?: 'use-create' | 'open-anyway' | 'use-file' | 'back'
  /** Absolute path to a .mobileprovision file — answers import-provide-profile-path (the MCP's manual-path arm of the TUI's native picker). */
  profilePath?: string
  /** Answer to import-export-warning: 'go' exports from the Keychain (the one macOS permission dialog), 'back' re-picks the profile, 'exit' stops. */
  exportConfirm?: 'go' | 'back' | 'exit'
  // ── Appflow migration answers ───────────────────────────────────────────────
  /** Generic choice value for the Appflow migration flow's neutral steps (org/app/cert pick, submenu, gap-fill, p8-upgrade, handoff-build). */
  value?: string
  /** Answer to the one-time single-platform "Are you migrating from Ionic Appflow?" gate. */
  migratingFromAppflow?: 'yes' | 'no'
}

// decideStart

/** Decide the first/again step for a fresh or resumed session. */
export async function decideStart(
  facts: PreflightFacts,
  progress: OnboardingProgress | null,
  deps: EngineDeps,
): Promise<NextStepResult> {
  if (!facts.capacitorProject || !facts.appId) {
    return {
      onboarding: 'capgo-builder',
      phase: 'preflight',
      state: 'no-capacitor-project',
      progress: 0,
      kind: 'error',
      summary: 'This does not look like a Capacitor project (no capacitor.config with an app id). Run onboarding from your app directory.',
      rules: ONBOARDING_RULES,
    }
  }

  if (!facts.authenticated) {
    return {
      onboarding: 'capgo-builder',
      phase: 'preflight',
      state: 'login-required',
      progress: 5,
      kind: 'human_gate',
      summary: `Found your app "${facts.appId}". First, connect your Capgo account.`,
      roadmap: ROADMAP,
      context: { appId: facts.appId, platformsDetected: facts.platformsDetected },
      human: {
        instruction: 'Ask the user to generate an API key for their AI assistant at https://console.capgo.app/connect and paste it into the chat, then call the capgo_login tool with that key to sign in.',
      },
      next: {
        tool: 'capgo_login',
        instruction: `When the user provides their key, call capgo_login with it. Once signed in, call ${NEXT_STEP_TOOL} (no arguments) to continue.`,
        call: 'capgo_login({ apikey: "<the key the user pasted>" })',
      },
      rules: ONBOARDING_RULES,
    }
  }

  // App phase: ensure the app is registered in Capgo Cloud before signing.
  if (!facts.appRegistered) {
    return {
      onboarding: 'capgo-builder',
      phase: 'app',
      state: 'registering-app',
      progress: 8,
      kind: 'auto',
      summary: `Registering "${facts.appId}" in Capgo Cloud...`,
      context: { appId: facts.appId },
      rules: ONBOARDING_RULES,
    }
  }

  // Resume the platform this session is already setting up. Comes from PROCESS-LOCAL
  // session memory (set when the user picked / a single-platform project auto-routed /
  // an explicit `{ platform }` arrived), NEVER from disk — so two concurrent sessions
  // for the same app don't read each other's progress files, and a FRESH start (empty
  // session) falls through to the picker instead of silently resuming what's on disk.
  const active = facts.appId ? getSessionPlatform(facts.appId) : undefined
  if (active === 'android')
    return decideAndroid(facts, deps)
  if (active === 'ios')
    return decideIos(facts, deps)

  // Single android platform → commit to android (mirrors single-ios in decidePlatform).
  if (facts.appId && facts.platformsDetected.length === 1 && facts.platformsDetected[0] === 'android') {
    setSessionPlatform(facts.appId, 'android')
    return decideAndroid(facts, deps)
  }

  return decidePlatform(facts, progress, deps)
}

async function decidePlatform(facts: PreflightFacts, _progress: OnboardingProgress | null, deps: EngineDeps): Promise<NextStepResult> {
  const platforms = facts.platformsDetected

  if (platforms.length === 0) {
    return {
      onboarding: 'capgo-builder',
      phase: 'preflight',
      state: 'no-platform',
      progress: 5,
      kind: 'human_gate',
      summary: 'No native platform folder found (ios/ or android/).',
      human: {
        instruction: 'Add a native platform first (run `npx cap add ios` or `npx cap add android`), then continue.',
      },
      next: {
        tool: NEXT_STEP_TOOL,
        instruction: 'After the user has added a native platform, call next_step (no arguments).',
        call: `${NEXT_STEP_TOOL}({})`,
      },
      rules: ONBOARDING_RULES,
    }
  }

  if (platforms.length === 1) {
    // Single-platform (ios only): commit to ios and auto-route. Single android is
    // handled in decideStart (single-android commit + decideAndroid).
    if (facts.appId)
      setSessionPlatform(facts.appId, 'ios')
    return decideIos(facts, deps)
  }

  return {
    onboarding: 'capgo-builder',
    phase: 'preflight',
    state: 'platform-select',
    progress: 5,
    kind: 'choice',
    summary: `Found your app "${facts.appId}". Which platform do you want to set up first?`,
    roadmap: ROADMAP,
    context: { appId: facts.appId, appRegistered: facts.appRegistered },
    options: [
      { value: 'ios', label: 'iOS', note: 'you will create an App Store Connect API key' },
      { value: 'android', label: 'Android', note: 'mostly automatic; one Google sign-in' },
    ],
    next: {
      tool: NEXT_STEP_TOOL,
      with: { platform: '<ios|android>' },
      instruction: 'Ask the user which platform to set up first, then call next_step with their choice.',
      call: `${NEXT_STEP_TOOL}({ platform: "ios" })`,
    },
    rules: ONBOARDING_RULES,
  }
}
// ─── iOS (granular shared-engine path, S6a) ───────────────────────────────────
//
// decideIos is a thin driver over the SHARED iOS flow engine (ios/flow.ts),
// mirroring decideAndroid: state = getIosResumeStep(progress); auto steps run
// via runIosEffect inside the bounded loop (the same non-progress guard);
// choice/gate steps render via mapIosView. iOS engine step ids become the MCP
// state names VERBATIM — with one exception: the TUI-only .p8 input chain
// (api-key-instructions / p8-method-select / input-p8-path / input-key-id /
// input-issuer-id, plus welcome and the setup-method fork) renders as the
// SINGLE 'ios-api-key' human gate (the e2e tree pins that state name). The
// gate collects all three fields in one call; on receipt drive() applies them
// sequentially through applyIosInput so progress persists identically to the
// TUI (see persistIosApiKeyInput).
//
// Carried transients (certData / profileData / teamId / p8Content / the
// verify-app gate fields ...) live in the process-local session registry
// (session-state.ts): threaded into every effect as deps.carried and merged
// back from every IosEffectResult.transient — the headless mirror of the TUI's
// iosCarriedRef. A server restart loses them; the flow engine self-heals from
// persisted progress (resolveP8Content re-reads the .p8 from p8Path; the
// cert/profile markers rebuild the credential map), so nothing here may crash
// on a missing carried field. Secrets in carried (p8 bytes, p12 base64,
// passwords) must NEVER serialize into a NextStepResult — mapIosView builds
// results exclusively from view fields + whitelisted non-secret context.

/** The TUI-only .p8 input chain steps the MCP collapses into one 'ios-api-key' gate. */
const IOS_API_KEY_GATE_STEPS = new Set<OnboardingStep>([
  'welcome',
  'setup-method-select',
  'api-key-instructions',
  'p8-method-select',
  'input-p8-path',
  'input-key-id',
  'input-issuer-id',
])

/** The single ios-api-key human gate (collects keyId + issuerId + p8Path in one call). */
function iosApiKeyGateResult(facts: PreflightFacts): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'ios-api-key',
    platform: 'ios',
    progress: 25,
    kind: 'human_gate',
    summary: `Set up iOS signing for "${facts.appId}". I need an App Store Connect API key.`,
    human: {
      instruction: 'In App Store Connect go to Users and Access, Integrations, App Store Connect API, create a key with App Manager access and download the .p8 (you can only download it once). Then give me the Key ID, the Issuer ID, and the path to the .p8 file. The .p8 stays on your machine — do not paste its contents here.',
    },
    collect: [
      { field: 'keyId', desc: 'the Key ID shown next to the key' },
      { field: 'issuerId', desc: 'the Issuer ID at the top of the Keys page' },
      { field: 'p8Path', desc: 'absolute path to the downloaded .p8 file' },
    ],
    next: {
      tool: NEXT_STEP_TOOL,
      with: { keyId: '<keyId>', issuerId: '<issuerId>', p8Path: '<path>' },
      instruction: 'Collect all three from the user, then call next_step with keyId, issuerId, and p8Path.',
      call: `${NEXT_STEP_TOOL}({ keyId: "ABC123", issuerId: "1a2b-...", p8Path: "/path/to/AuthKey.p8" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

// ─── iOS import-existing fork (S12) ─────────────────────────────────────────────
//
// The TUI's import sub-flow (ios/flow.ts BATCH 5-7b) driven headless: the
// persisted forks (setup-method-select / import-distribution-mode) ride the
// SAME pure reducers the TUI uses (applyIosInput via persistIosImportForkInput);
// the EPHEMERAL prompts (pickers / recovery hub / portal walkthrough / export
// warning / manual profile path) park in the session registry between tool
// calls (carried.parkedImportStep — the headless mirror of the TUI's React
// `step` state) and re-drive as ONE-SHOT resolver effects, exactly the
// cert-limit/verify-app mechanism above. A server restart loses the park + the
// inventory; the flow self-heals via a fresh import-scanning (the audit's
// resume contract — pickers are NEVER resume targets).

/** The interactive import prompts the MCP parks between tool calls. */
const IOS_IMPORT_PARK_STEPS = new Set<OnboardingStep>([
  'import-pick-identity',
  'import-pick-profile',
  'import-no-match-recovery',
  'import-portal-explanation',
  'import-export-warning',
])

/**
 * Steps that need the carried import-scanning inventory before they can render
 * or route. Entering one without `carried.importMatches` (fresh entry / server
 * restart) re-runs the silent scan first — it routes back via
 * getImportEntryStep, mirroring BOTH the TUI's scan-before-questions order and
 * its crash-recovery resume.
 */
const IOS_IMPORT_INVENTORY_STEPS = new Set<OnboardingStep>([
  'import-distribution-mode',
  'import-pick-identity',
  'import-pick-profile',
])

/**
 * Whether the driver declares the import-existing capability: isMacOS() ===
 * true AND the Keychain scan dep is wired (a fork without
 * listSigningIdentities could never complete). Off-macOS — or for drivers
 * that don't wire the import deps (legacy fakes, the scenario e2e world) —
 * the fork stays hidden and the chain keeps rendering as the single
 * ios-api-key gate (the S6a forced create-new behavior).
 */
function iosImportCapable(ios?: IosEffectDeps): boolean {
  return ios?.isMacOS?.() === true && typeof ios?.listSigningIdentities === 'function'
}

/**
 * Map a .p8-chain gate step to the setup-method fork while the fork is still
 * undecided AND the driver is import-capable. A legacy mid-chain progress
 * (p8Path persisted, no setupMethod) is never re-asked. NOTE: when the step
 * is ALREADY 'setup-method-select' (backing-up routes there on macOS) but the
 * capability is absent, the step is returned UNCHANGED — callers must branch
 * on iosImportCapable, not on the returned name (the gate-set membership is
 * what collapses it back to the ios-api-key gate).
 */
function iosSetupForkStep(step: OnboardingStep, progress: OnboardingProgress | null, ios?: IosEffectDeps): OnboardingStep {
  if (
    IOS_API_KEY_GATE_STEPS.has(step)
    && !progress?.setupMethod
    && !progress?.p8Path
    && iosImportCapable(ios)
  ) {
    return 'setup-method-select'
  }
  return step
}

/**
 * The S12 setup-method fork — the FIRST iOS choice on a fresh macOS entry.
 * Option values are the PERSISTED setupMethod vocabulary (the TUI Select's
 * 'create'/'import' map onto these via applyIosInput in
 * persistIosImportForkInput, so progress.json stays byte-identical to a TUI run).
 */
function iosSetupMethodResult(facts: PreflightFacts): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'setup-method-select',
    platform: 'ios',
    progress: STEP_PROGRESS['setup-method-select'] ?? 20,
    kind: 'choice',
    summary: `How do you want to set up iOS signing credentials for "${facts.appId}"? Create new ones via the App Store Connect API, or import an existing distribution certificate + provisioning profile already on this Mac (Keychain + Xcode profiles).`,
    options: [
      { value: 'create-new', label: '🆕  Create new via App Store Connect API' },
      { value: 'import-existing', label: '📥  Import existing from this Mac (Keychain + Xcode profiles)' },
    ],
    next: {
      tool: NEXT_STEP_TOOL,
      with: { setupMethod: '<create-new|import-existing>' },
      instruction: 'Ask the user. "create-new" mints a fresh certificate + profile via Apple (needs an App Store Connect API key); "import-existing" reuses a signing identity already in this Mac\'s Keychain. Then call next_step with setupMethod set to their pick.',
      call: `${NEXT_STEP_TOOL}({ setupMethod: "create-new" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/**
 * The existing ios-credentials-failed re-collect gate. S6a maps EVERY iOS
 * engine 'error' here (the message carries the failing step's human text);
 * S6b replaces this with structured per-failure recovery.
 */
function iosCredentialsFailedResult(facts: PreflightFacts, message: string): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'ios-credentials-failed',
    platform: 'ios',
    progress: 25,
    kind: 'human_gate',
    summary: `iOS signing setup failed: ${message}`,
    human: { instruction: 'This often means the API key lacks access, the .p8 moved, or Apple\'s certificate limit was hit. Provide corrected Key ID / Issuer ID / .p8 path, then continue.' },
    collect: [
      { field: 'keyId', desc: 'the Key ID' },
      { field: 'issuerId', desc: 'the Issuer ID' },
      { field: 'p8Path', desc: 'absolute path to the .p8 file' },
    ],
    next: {
      tool: NEXT_STEP_TOOL,
      with: { keyId: '<keyId>', issuerId: '<issuerId>', p8Path: '<path>' },
      instruction: 'Collect corrected values from the user, then call next_step with keyId, issuerId, p8Path — or call next_step({}) to retry as-is.',
      call: `${NEXT_STEP_TOOL}({ keyId: "ABC123", issuerId: "1a2b-...", p8Path: "/path/to/AuthKey.p8" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/**
 * The iOS data-safety gate (a TUI run parked `_credentialsExistGate: 'pending'`).
 * Mirrors the android credentials-exist choice — answered via credentialsExistChoice.
 */
function iosCredentialsExistResult(facts: PreflightFacts): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'credentials-exist',
    platform: 'ios',
    progress: STEP_PROGRESS['credentials-exist'],
    kind: 'choice',
    summary: `iOS credentials already exist for "${facts.appId}". Continuing onboarding will create new credentials and replace the existing ones. Back them up first, or stop?`,
    options: [
      { value: 'backup', label: 'Start fresh (backup existing credentials first)' },
      { value: 'cancel', label: 'Stop — keep my existing credentials' },
    ],
    next: {
      tool: NEXT_STEP_TOOL,
      with: { credentialsExistChoice: '<backup|cancel>' },
      instruction: 'Tell the user their existing iOS credentials will be replaced. Ask whether to back them up first and continue, or stop. Then call next_step with credentialsExistChoice.',
      call: `${NEXT_STEP_TOOL}({ credentialsExistChoice: "backup" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/** A thrown (non-engine-routed) iOS effect failure → the same re-collect gate. */
function iosEffectError(step: OnboardingStep, err: unknown, facts: PreflightFacts): NextStepResult {
  const message = err instanceof Error ? err.message : String(err)
  return iosCredentialsFailedResult(facts, `at step "${step}": ${message}`)
}

/**
 * Map an interactive IosStepView into a NextStepResult — the iOS mirror of
 * mapAndroidView. State names reuse the engine step ids; option values mirror
 * the TUI Select values. Only NON-SECRET, view-derived data may appear here.
 */
export function mapIosView(
  view: IosStepView,
  facts: PreflightFacts,
  ctx?: IosStepCtx,
): NextStepResult {
  const base = {
    onboarding: 'capgo-builder' as const,
    phase: 'credentials' as const,
    platform: 'ios' as const,
    state: view.step,
    progress: STEP_PROGRESS[view.step] ?? 45,
    rules: ONBOARDING_RULES,
  }

  switch (view.step) {
    // ── verify-app (the parked App Store verification gate, PR #2397) ────────
    // Three variants, mirroring iosViewForStep: the PICKER (option values are
    // app bundle ids + the '__create_new__' escape — answered via
    // verifyAction 'pick' + verifyAppId, or verifyAction 'create-new'), and
    // the Path-A / Path-B gates (option values ARE verifyAction members).
    case 'verify-app': {
      const releaseId = ctx?.verifyReleaseBundleId ?? ''
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      const isPicker = !ctx?.verifyPath
      const isCreateApp = ctx?.verifyPath === 'create-app'
      const createAppUrl = 'https://appstoreconnect.apple.com/apps'
      const title = view.title ?? `Verifying the App Store app for ${releaseId}.`
      return {
        ...base,
        kind: 'choice',
        summary: isPicker
          ? `${title} Pick the App Store app this project should build for, or create a new one.`
          : title,
        context: {
          ...(releaseId ? { releaseBundleId: releaseId } : {}),
          ...(isCreateApp ? { createAppUrl } : {}),
          ...(ctx?.verifyAttempt ? { attempt: ctx.verifyAttempt } : {}),
        },
        options,
        next: isPicker
          ? {
              tool: NEXT_STEP_TOOL,
              with: { verifyAction: '<pick|create-new>', verifyAppId: '<bundle id when picking>' },
              instruction: 'Present the App Store apps to the user. To build for one of them, call next_step with verifyAction "pick" AND verifyAppId set to that option\'s bundle id. If none match and the build id is correct, call next_step with verifyAction "create-new" (no verifyAppId).',
              call: `${NEXT_STEP_TOOL}({ verifyAction: "pick", verifyAppId: "com.example.app" })`,
            }
          : {
              tool: NEXT_STEP_TOOL,
              with: { verifyAction: `<${options.map(o => o.value).join('|')}>` },
              instruction: isCreateApp
                ? `Tell the user to create the App Store app at ${createAppUrl} (I cannot open a browser for them). Then call next_step with verifyAction — "recheck" once they created it, or another listed action.`
                : 'Present the options to the user, then call next_step with verifyAction set to their pick.',
              call: `${NEXT_STEP_TOOL}({ verifyAction: "${options[0]?.value ?? 'recheck'}" })`,
            },
      }
    }

    // ── cert-limit-prompt (S6b — cert-limit recovery) ────────────────────────
    // Apple's per-team Distribution-cert limit was hit. One option per existing
    // cert (value = its Apple resource id; label carries name + expiry, with
    // the Capgo-created cert flagged) plus the engine's '__exit__' sentinel —
    // answered via certToRevoke. The list itself is the engine view's options
    // (built from ctx.existingCerts), so the MCP never re-derives it.
    case 'cert-limit-prompt': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'Apple\'s Distribution-certificate limit was reached.'} Revoking one frees a slot so a new certificate can be created.`,
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { certToRevoke: '<certificate id|__exit__>' },
          instruction: 'Present the certificates to the user (the one created by Capgo is flagged). WARNING: revoking a certificate invalidates anything still signing with it, so let the USER choose. Then call next_step with certToRevoke set to the chosen option\'s value, or "__exit__" to stop.',
          call: `${NEXT_STEP_TOOL}({ certToRevoke: "${options[0]?.value ?? '__exit__'}" })`,
        },
      }
    }

    // ── duplicate-profile-prompt (S6b — duplicate-profile recovery) ──────────
    // Apple already has Capgo provisioning profiles for this bundle id. The
    // options are the engine's static delete|exit pair — answered via
    // duplicateProfileAction. Origin routing (creating-profile vs
    // import-create-profile-only) is the engine's job, keyed off the persisted
    // duplicateProfileOrigin marker.
    case 'duplicate-profile-prompt': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'Apple already has Capgo provisioning profile(s) for this app.'} Delete them and create a fresh one, or stop here.`,
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { duplicateProfileAction: '<delete|exit>' },
          instruction: 'Ask the user. To delete the duplicate Capgo profile(s) and recreate a fresh one, call next_step with duplicateProfileAction "delete"; to stop, "exit".',
          call: `${NEXT_STEP_TOOL}({ duplicateProfileAction: "delete" })`,
        },
      }
    }

    // ── error (S6b — the structured recovery screen) ─────────────────────────
    // The engine error view's choices verbatim ('retry' only when a retryStep
    // is carried — exactly the TUI's showRetry gate), plus the MCP-only
    // 'email-support' arm (no host-side opens; instructions only). Corrected
    // ASC key details (keyId/issuerId/p8Path) are ALSO accepted while parked
    // here — the S6a re-collect arm folded into the recovery menu.
    case 'error': {
      const engineOptions = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      const options = [
        ...engineOptions,
        { value: 'email-support', label: '📧  Email Capgo support', note: undefined },
      ]
      const hasRetry = engineOptions.some(o => o.value === 'retry')
      return {
        ...base,
        kind: 'choice',
        summary: `iOS setup hit an error: ${view.message ?? 'unknown error.'}`,
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { errorAction: `<${options.map(o => o.value).join('|')}>` },
          instruction: `Show the error to the user and present the recovery options.${hasRetry ? ' "retry" re-runs the failing step.' : ''} "restart" wipes the onboarding progress and starts over; "exit" stops here; "email-support" returns instructions for contacting Capgo support. If the error looks like a wrong API key, you can instead send corrected keyId/issuerId/p8Path directly.`,
          call: `${NEXT_STEP_TOOL}({ errorAction: "${engineOptions[0]?.value ?? 'restart'}" })`,
        },
      }
    }

    // ── import-distribution-mode (S12 — the import sub-flow's first question) ──
    // Persisted fork: the answer rides applyIosInput('import-distribution-mode')
    // (persistIosImportForkInput), so resume == fresh-advance with no re-ask.
    case 'import-distribution-mode': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'How will Capgo distribute your build?'} ${view.prompt ?? ''}`.trim(),
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { importDistribution: '<app_store|ad_hoc|__cancel__>' },
          instruction: 'Ask the user how this build will be distributed. "app_store" uploads to TestFlight (needs an App Store Connect API key); "ad_hoc" signs for direct/QR install (no ASC key). Call next_step with importDistribution set to their pick, or "__cancel__" to switch to creating fresh credentials instead.',
          call: `${NEXT_STEP_TOOL}({ importDistribution: "app_store" })`,
        },
      }
    }

    // ── import-pick-identity (S12 — Keychain identity picker, EPHEMERAL) ──────
    // Option values are the identities' SHA-1s (+ the '__cancel__' escape) —
    // answered via identityChoice; the driver resolves the SHA-1 against the
    // carried inventory and re-drives the step as a resolver effect.
    case 'import-pick-identity': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'Pick a signing identity to import.'} ${view.prompt ?? ''}`.trim(),
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { identityChoice: '<identity SHA-1|__cancel__>' },
          instruction: 'Present the Keychain signing identities to the user (each option label names the certificate and how many of its profiles match this app). Call next_step with identityChoice set to the chosen option\'s value (the identity SHA-1), or "__cancel__" to switch to creating a fresh certificate instead.',
          call: `${NEXT_STEP_TOOL}({ identityChoice: "${options[0]?.value ?? '__cancel__'}" })`,
        },
      }
    }

    // ── import-pick-profile (S12 — provisioning-profile picker, EPHEMERAL) ────
    // Option values are the profile UUIDs (+ the '__back__' escape) — answered
    // via profileChoice.
    case 'import-pick-profile': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'Pick a provisioning profile to import.'} ${view.prompt ?? ''}`.trim(),
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { profileChoice: '<profile UUID|__back__>' },
          instruction: 'Present the matching provisioning profiles to the user. Call next_step with profileChoice set to the chosen option\'s value (the profile UUID), or "__back__" to return to identity selection.',
          call: `${NEXT_STEP_TOOL}({ profileChoice: "${options[0]?.value ?? '__back__'}" })`,
        },
      }
    }

    // ── import-no-match-recovery (S12 — the recovery hub, EPHEMERAL) ──────────
    // The menu VARIANT (title sentence + which rows show) is the engine view's
    // job (noMatchReason / distribution / ASC-key state); the MCP surfaces it
    // verbatim — answered via importRecoveryAction.
    case 'import-no-match-recovery': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'No usable provisioning profile matches this identity.'} ${view.prompt ?? ''}`.trim(),
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { importRecoveryAction: `<${options.map(o => o.value).join('|')}>` },
          instruction: 'Present the recovery options to the user. "create" makes a fresh App Store profile for this certificate via Apple; "provide-profile-path" lets the user supply a .mobileprovision file path; "browser" explains the manual Apple Developer Portal route; "back" returns to identity selection. Call next_step with importRecoveryAction set to their pick.',
          call: `${NEXT_STEP_TOOL}({ importRecoveryAction: "${options[0]?.value ?? 'back'}" })`,
        },
      }
    }

    // ── import-portal-explanation (S12 — manual-portal walkthrough, EPHEMERAL) ─
    // HEADLESS: the MCP never opens a browser — 'open-anyway' logs a breadcrumb
    // engine-side and bounces back to the recovery menu; the agent gives the
    // user the portal URL from context instead.
    case 'import-portal-explanation': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      const portalUrl = 'https://developer.apple.com/account/resources/profiles/list'
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'You can create the profile manually in the Apple Developer Portal.'} ${view.prompt ?? ''}`.trim(),
        context: { portalUrl },
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { portalAction: `<${options.map(o => o.value).join('|')}>` },
          instruction: `Present the options to the user. I cannot open a browser for them — if they want the manual route, give them the portal URL (${portalUrl}); once they have downloaded a .mobileprovision, "use-file" lets them provide its path. "use-create" (when offered) creates the profile automatically instead — recommended. "open-anyway"/"back" return to the recovery menu. Call next_step with portalAction set to their pick.`,
          call: `${NEXT_STEP_TOOL}({ portalAction: "${options[0]?.value ?? 'back'}" })`,
        },
      }
    }

    // ── import-provide-profile-path (S12 — the manual-path arm, INPUT) ────────
    // The TUI opens a native .mobileprovision picker; the headless MCP collects
    // the path as text (decideIos synthesizes this input view) and re-drives the
    // engine effect with a one-shot picker resolving the provided path.
    case 'import-provide-profile-path': {
      return {
        ...base,
        kind: 'human_gate',
        summary: view.title ?? 'Use a .mobileprovision file from disk.',
        human: {
          instruction: 'Locate (or download from the Apple Developer Portal) the .mobileprovision profile for this app, then give me its absolute path. The file stays on your machine.',
        },
        collect: [
          { field: 'profilePath', desc: 'absolute path to the .mobileprovision file' },
        ],
        next: {
          tool: NEXT_STEP_TOOL,
          with: { profilePath: '<path>' },
          instruction: 'Ask the user for the absolute path to their .mobileprovision file, then call next_step with profilePath.',
          call: `${NEXT_STEP_TOOL}({ profilePath: "/path/to/profile.mobileprovision" })`,
        },
      }
    }

    // ── import-export-warning (S12 — the Keychain-dialog heads-up, EPHEMERAL) ──
    // 'go' runs the export INSIDE the next tool call, which BLOCKS on the single
    // macOS Keychain permission dialog — the instruction makes the agent warn
    // the user to expect + approve it BEFORE confirming (the accepted design).
    case 'import-export-warning': {
      const options = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
      return {
        ...base,
        kind: 'choice',
        summary: `${view.title ?? 'macOS will now ask permission to access your private key.'} ${view.prompt ?? ''}`.trim(),
        options,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { exportConfirm: '<go|back|exit>' },
          instruction: 'IMPORTANT — tell the USER first: confirming with "go" exports the certificate from the macOS Keychain during the next call, and macOS will pop up a Keychain permission dialog on their Mac. They should click "Always Allow" (the call waits until they answer; "Always Allow" prevents re-prompts on retries). Once they are ready, call next_step with exportConfirm "go". "back" returns to profile selection; "exit" stops onboarding.',
          call: `${NEXT_STEP_TOOL}({ exportConfirm: "go" })`,
        },
      }
    }

    default: {
      // Generic mapping for views outside the S6a create-new scope (the
      // cert-limit / duplicate-profile recoveries land in S6b as structured
      // states). Mirrors mapAndroidView's default: surface the engine view
      // verbatim and allow a plain re-check.
      if (view.kind === 'choice') {
        return {
          ...base,
          kind: 'choice',
          summary: view.title ?? `iOS setup: ${view.step}`,
          options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
          next: {
            tool: NEXT_STEP_TOOL,
            instruction: 'Present the options to the user. Structured answers for this step arrive in a later milestone — call next_step({}) to re-check, or finish this step in the interactive wizard (`npx @capgo/cli build init`).',
            call: `${NEXT_STEP_TOOL}({})`,
          },
        }
      }
      return {
        ...base,
        kind: 'human_gate',
        summary: view.title ?? `iOS setup: ${view.step}`,
        human: { instruction: view.prompt ?? 'Continue when ready.' },
        next: { tool: NEXT_STEP_TOOL, instruction: 'Call next_step to continue.', call: `${NEXT_STEP_TOOL}({})` },
      }
    }
  }
}

/**
 * The session-parked iOS recovery step, if any (S6b). The cert-limit /
 * duplicate-profile prompts and the error screen are NOT resume targets
 * (their state is the TUI's React state — here the per-app session): the
 * presence of their carried markers is what parks them between tool calls.
 * Precedence mirrors causality: an error parked AFTER a recovery prompt
 * (e.g. a failed revoke) must win over the prompt's own marker. A server
 * restart loses the markers and the flow self-heals via a fresh resume —
 * re-deriving the inventory through the failing step, never crashing.
 */
function iosParkedStep(carried: IosCarried): OnboardingStep | null {
  if (carried.error !== undefined)
    return 'error'
  if (carried.existingCerts !== undefined)
    return 'cert-limit-prompt'
  if (carried.duplicateProfiles !== undefined)
    return 'duplicate-profile-prompt'
  // S12: the parked interactive import prompt (pickers / recovery hub / portal
  // walkthrough / export warning / manual profile path). LAST in precedence —
  // an error (or recovery prompt) raised while an import prompt was parked
  // must win, exactly like the TUI's React step moving off the picker.
  if (carried.parkedImportStep !== undefined)
    return carried.parkedImportStep
  return null
}

/**
 * The effective iOS step an incoming answer must address: the session-parked
 * recovery step when one is parked, else the persisted resume step — mapped
 * through the S12 setup-method fork (a fresh macOS entry's effective step is
 * 'setup-method-select', not the collapsed .p8 gate). This is what the strict
 * iOS input gate validates against.
 */
function effectiveIosStep(appId: string, progress: OnboardingProgress | null, ios?: IosEffectDeps): OnboardingStep {
  const step = iosParkedStep(getSession(appId).iosCarried) ?? getIosResumeStep(progress)
  return iosSetupForkStep(step, progress, ios)
}

/**
 * Phase-0 data-safety gate seeding (S7, mirrors the android gate at
 * decideAndroid): when saved iOS credentials already exist for this app AND
 * the user is entering the credential phase fresh (the resume step is still in
 * the .p8-chain entry set) AND the gate has not been evaluated, persist
 * `_credentialsExistGate: 'pending'` so getIosResumeStep parks on
 * 'credentials-exist' BEFORE any Apple traffic — matching the FROZEN TUI
 * journey semantics (ios-resume.journeys.mjs: the gate intercepts before the
 * verify-app/create pipeline). Only fires on a truly fresh entry, so an
 * in-flight onboarding is unaffected. Returns the (possibly updated) progress.
 */
async function seedIosCredentialsExistGate(
  appId: string,
  ios: IosEffectDeps | undefined,
  progress: OnboardingProgress | null,
): Promise<OnboardingProgress | null> {
  if (progress?._credentialsExistGate !== undefined)
    return progress
  if (!IOS_API_KEY_GATE_STEPS.has(getIosResumeStep(progress)))
    return progress
  let hasSavedIos = false
  try {
    const saved = await ios?.loadSavedCredentials?.(appId)
    hasSavedIos = !!(saved && typeof saved === 'object' && (saved as { ios?: unknown }).ios)
  }
  catch {
    // Treat a load failure as "no saved credentials" — never block onboarding
    // on a read error; the worst case is the pre-existing (no-gate) behavior.
    hasSavedIos = false
  }
  if (!hasSavedIos)
    return progress
  const seeded: OnboardingProgress = {
    ...(progress ?? { platform: 'ios', appId, startedAt: new Date().toISOString(), completedSteps: {} }),
    _credentialsExistGate: 'pending',
  }
  await ios?.saveProgress?.(appId, seeded)
  return seeded
}

/**
 * The 'email-support' arm of the parked error screen (S6b, MCP-only). NO
 * host-side opens — the MCP server never launches a mail client or browser;
 * it surfaces the support address + what to include and leaves the error
 * parked so the user can still retry/restart/exit afterwards.
 */
function iosEmailSupportResult(facts: PreflightFacts, message?: string): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'error',
    platform: 'ios',
    progress: STEP_PROGRESS.error ?? 45,
    kind: 'human_gate',
    summary: `To get help from Capgo support, email ${SUPPORT_EMAIL}.${message ? ` Include the error: "${message}"` : ''}`,
    human: {
      instruction: `Email ${SUPPORT_EMAIL} describing what you were doing (iOS build onboarding for "${facts.appId}") and paste the error message shown above. I cannot open your mail app from here. Running \`npx @capgo/cli@latest doctor\` and attaching its output speeds up support.`,
    },
    context: { supportEmail: SUPPORT_EMAIL },
    next: {
      tool: NEXT_STEP_TOOL,
      with: { errorAction: '<retry|restart|exit>' },
      instruction: 'After the user has emailed support (or decided not to), call next_step with errorAction: "retry" to re-run the failing step, "restart" to start onboarding over, or "exit" to stop.',
      call: `${NEXT_STEP_TOOL}({ errorAction: "retry" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/** The 'exit' arm of the parked error screen — a clean stop, progress kept. */
function iosErrorExitResult(facts: PreflightFacts, message?: string): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'error',
    platform: 'ios',
    progress: STEP_PROGRESS.error ?? 45,
    kind: 'done',
    summary: `Stopped iOS onboarding after an error${message ? ` ("${message}")` : ''}. Nothing else was changed — your saved progress is kept, so running onboarding again resumes from the failing step.`,
    rules: ONBOARDING_RULES,
  }
}

export async function decideIos(
  facts: PreflightFacts,
  deps: EngineDeps,
  opts?: {
    verifyAction?: OnboardingInput['verifyAction']
    verifyAppId?: string
    certToRevoke?: string
    duplicateProfileAction?: 'delete' | 'exit'
    errorAction?: 'retry' | 'restart' | 'exit' | 'email-support'
    // ── S12: iOS import-existing fork answers (ephemeral resolver picks) ──────
    /** import-pick-identity answer: an identity SHA-1 or '__cancel__'. */
    identityChoice?: string
    /** import-pick-profile answer: a profile UUID or '__back__'. */
    profileChoice?: string
    /** import-no-match-recovery answer. */
    importRecoveryAction?: 'create' | 'provide-profile-path' | 'browser' | 'back'
    /** import-portal-explanation answer. */
    portalAction?: 'use-create' | 'open-anyway' | 'use-file' | 'back'
    /** import-provide-profile-path answer: the .mobileprovision path. */
    profilePath?: string
    /** import-export-warning answer. */
    exportConfirm?: 'go' | 'back' | 'exit'
    /**
     * S9-S11: the explicit tail step a validated tail answer routed to
     * (drive() → applyMcpTailAnswer). Honored only while the slim tail
     * progress carries credentialsSaved — the same guard as the tail park.
     */
    tailNext?: OnboardingStep
  },
): Promise<NextStepResult> {
  const appId = facts.appId!
  const ios: IosEffectDeps = deps.iosEffectDeps ?? {}

  // Seed empty progress on first entry (mirrors decideAndroid's seeding): the
  // resume resolver then lands on the .p8 chain entry, not the TUI-only
  // 'welcome'. NOT persisted — the first persist happens when the gate's
  // three fields arrive (persistIosApiKeyInput).
  let progress: OnboardingProgress = facts.iosProgress ?? {
    platform: 'ios',
    appId,
    startedAt: new Date().toISOString(),
    completedSteps: {},
  }

  // ── Parked error screen actions (S6b) — validated by the strict gate ───────
  // (errorAction only reaches here while the session is parked on 'error').
  // 'retry' re-drives the engine's error RESOLVER (carried.retryStep routing);
  // the other arms are DRIVER-owned, mirroring the TUI: restart =
  // resetForFreshStart (wipe progress + session), exit = leave onboarding,
  // email-support = surface instructions (no host-side opens, stays parked).
  let errorRetry = false
  if (opts?.errorAction) {
    const carriedNow = getSession(appId).iosCarried
    const errorMessage = carriedNow.error
    if (opts.errorAction === 'email-support')
      return iosEmailSupportResult(facts, errorMessage)
    if (opts.errorAction === 'exit') {
      dropIosCarried(appId, ['error', 'retryStep', 'errorAction'])
      return iosErrorExitResult(facts, errorMessage)
    }
    if (opts.errorAction === 'retry') {
      if (!carriedNow.retryStep) {
        // No retry was offered (unrecoverable / user-initiated exit sink) —
        // the engine resolver would self-loop; treat as the exit arm.
        dropIosCarried(appId, ['error', 'retryStep', 'errorAction'])
        return iosErrorExitResult(facts, errorMessage)
      }
      mergeIosCarried(appId, { errorAction: 'retry' })
      errorRetry = true
    }
    if (opts.errorAction === 'restart') {
      // Wipe progress + session, back to the very start (the TUI's
      // resetForFreshStart + setStep('welcome')). The data-safety gate below
      // re-evaluates against the fresh progress, so saved credentials are
      // re-protected before any new Apple traffic.
      try {
        await ios.deleteProgress?.(appId)
      }
      catch {
        // Best-effort: a failed delete leaves the old progress; the resume
        // routing then simply continues from it instead of restarting.
      }
      clearSession(appId)
      progress = { platform: 'ios', appId, startedAt: new Date().toISOString(), completedSteps: {} }
    }
  }

  // ── Phase-0 data-safety gate (S7) ──────────────────────────────────────────
  progress = (await seedIosCredentialsExistGate(appId, ios, progress)) ?? progress

  // 'cancel' on the data-safety gate is a hard stop (mirrors the android gate):
  // the user declined to back up their existing iOS credentials.
  if (progress._credentialsExistGate === 'cancel') {
    return {
      onboarding: 'capgo-builder', phase: 'credentials', state: 'credentials-exist', platform: 'ios',
      progress: STEP_PROGRESS['credentials-exist'], kind: 'done',
      summary: `Onboarding stopped to protect the existing iOS credentials for "${appId}". Nothing was changed. Re-run onboarding and choose "Start fresh (backup existing credentials first)" when you're ready to replace them.`,
      rules: ONBOARDING_RULES,
    }
  }

  // Record the user's verify-app gate pick into the session BEFORE driving, so
  // the parked step re-runs as a RESOLVER effect (the same carried-driven
  // mechanism the TUI uses). 'pick' also resolves verifyAppId → the chosen
  // AscApp against the carried picker inventory; an unknown id resolves to
  // null and the resolver simply re-parks the picker.
  if (opts?.verifyAction) {
    const carriedNow = getSession(appId).iosCarried
    const chosen = opts.verifyAction === 'pick'
      ? ((carriedNow.verifyApps ?? []).find(a => a.bundleId === opts.verifyAppId) ?? null)
      : undefined
    mergeIosCarried(appId, {
      verifyAction: opts.verifyAction,
      ...(chosen !== undefined ? { verifyChosenApp: chosen } : {}),
    })
  }

  // ── Parked cert-limit-prompt answer (S6b) ──────────────────────────────────
  // Resolve the picked option value (a cert's Apple resource id) against the
  // carried inventory into carried.certToRevoke — the engine resolver then
  // routes pick → revoking-certificate / no-pick ('__exit__') → the error
  // sink, mirroring app.tsx:3917-3926. An unknown id re-renders the prompt
  // with a correction and applies NOTHING.
  let certLimitAnswered = false
  if (opts?.certToRevoke !== undefined) {
    const carriedNow = getSession(appId).iosCarried
    if (opts.certToRevoke === '__exit__') {
      // The engine resolver reads "no carried certToRevoke" as the exit pick.
      dropIosCarried(appId, ['certToRevoke'])
      certLimitAnswered = true
    }
    else {
      const chosenCert = (carriedNow.existingCerts ?? []).find(c => c.id === opts.certToRevoke)
      if (!chosenCert) {
        const ctx: IosStepCtx = { appId, ...(carriedNow as Partial<IosStepCtx>) }
        const rerender = mapIosView(iosViewForStep('cert-limit-prompt', progress, ctx), facts, ctx)
        return { ...rerender, summary: `Unknown certificate id "${opts.certToRevoke}" — call next_step with certToRevoke set to one of the listed option values, or "__exit__".\n\n${rerender.summary}` }
      }
      mergeIosCarried(appId, { certToRevoke: chosenCert })
      certLimitAnswered = true
    }
  }

  // ── Parked duplicate-profile-prompt answer (S6b) ───────────────────────────
  // 'delete' → carried.confirmDeleteDuplicates=true → the resolver routes to
  // deleting-duplicate-profiles (then back to the persisted
  // duplicateProfileOrigin); 'exit' → no confirm → the error sink. Mirrors
  // app.tsx:3941-3949.
  let dupAnswered = false
  if (opts?.duplicateProfileAction) {
    if (opts.duplicateProfileAction === 'delete')
      mergeIosCarried(appId, { confirmDeleteDuplicates: true })
    else
      dropIosCarried(appId, ['confirmDeleteDuplicates'])
    dupAnswered = true
  }

  // ── Parked import sub-flow answers (S12) — validated by the strict gate ────
  // Each ephemeral pick is recorded into the session (the MCP mirror of the
  // TUI's React state) and the parked prompt re-driven as a ONE-SHOT resolver
  // effect — the same mechanism as cert-limit / verify-app above. The PERSISTED
  // forks (setupMethod / importDistribution) never reach here: drive() applies
  // them through the pure reducers (persistIosImportForkInput) and the resume
  // routing takes over.
  let importAnswered: OnboardingStep | undefined
  let profilePathAnswer: string | undefined

  if (opts?.identityChoice !== undefined) {
    const carriedNow = getSession(appId).iosCarried
    if (opts.identityChoice === '__cancel__') {
      // The user bailed to create-new. The DRIVER owns the persistence (switch
      // setupMethod, drop the stale importDistribution — ui/app.tsx onPick) and
      // clears the carried identity so the resolver routes the cancel.
      dropIosCarried(appId, ['chosenIdentity'])
      const { importDistribution: _droppedDist, ...rest } = progress
      progress = { ...rest, setupMethod: 'create-new' }
      await ios.saveProgress?.(appId, progress)
    }
    else {
      const match = (carriedNow.importMatches ?? []).find(m => m.identity.sha1 === opts.identityChoice)
      if (!match) {
        const ctx: IosStepCtx = { appId, ...(carriedNow as Partial<IosStepCtx>) }
        const rerender = mapIosView(iosViewForStep('import-pick-identity', progress, ctx), facts, ctx)
        return { ...rerender, summary: `Unknown identity "${opts.identityChoice}" — call next_step with identityChoice set to one of the listed option values (the identity SHA-1), or "__cancel__".\n\n${rerender.summary}` }
      }
      // Stale per-identity state from a previous pick must not leak into the
      // new identity's routing (the TUI clears its appleCertId mirror + the
      // chosen profile when the identity changes).
      dropIosCarried(appId, ['_appleCertIdForChosen', 'chosenProfile'])
      mergeIosCarried(appId, { chosenIdentity: match.identity })
    }
    importAnswered = 'import-pick-identity'
  }

  if (opts?.profileChoice !== undefined) {
    const carriedNow = getSession(appId).iosCarried
    if (opts.profileChoice === '__back__') {
      // No carried profile = the resolver's '__back__' arm (import-pick-identity).
      dropIosCarried(appId, ['chosenProfile'])
    }
    else {
      const pool = (carriedNow.importMatches ?? [])
        .find(m => m.identity.sha1 === carriedNow.chosenIdentity?.sha1)?.profiles ?? []
      const picked = pool.find(p => p.uuid === opts.profileChoice)
      if (!picked) {
        const ctx: IosStepCtx = { appId, ...(carriedNow as Partial<IosStepCtx>) }
        const rerender = mapIosView(iosViewForStep('import-pick-profile', progress, ctx), facts, ctx)
        return { ...rerender, summary: `Unknown profile "${opts.profileChoice}" — call next_step with profileChoice set to one of the listed option values (the profile UUID), or "__back__".\n\n${rerender.summary}` }
      }
      mergeIosCarried(appId, { chosenProfile: picked })
    }
    importAnswered = 'import-pick-profile'
  }

  if (opts?.importRecoveryAction !== undefined) {
    mergeIosCarried(appId, { recoveryAction: opts.importRecoveryAction })
    // Re-entering the manual-path arm must re-ask for a file — the TUI clears
    // its picker-opened ref before routing (app.tsx:3593); same for the portal
    // 'use-file' arm below.
    if (opts.importRecoveryAction === 'provide-profile-path')
      dropIosCarried(appId, ['profilePickerOpened'])
    importAnswered = 'import-no-match-recovery'
  }

  if (opts?.portalAction !== undefined) {
    mergeIosCarried(appId, { portalAction: opts.portalAction })
    if (opts.portalAction === 'use-file')
      dropIosCarried(appId, ['profilePickerOpened'])
    importAnswered = 'import-portal-explanation'
  }

  if (opts?.exportConfirm !== undefined) {
    mergeIosCarried(appId, { exportWarningAction: opts.exportConfirm })
    importAnswered = 'import-export-warning'
  }

  if (opts?.profilePath !== undefined) {
    // The manual-path arm: the engine effect's openProfilePicker is injected as
    // a one-shot resolving this path (see the effect dispatch below).
    profilePathAnswer = opts.profilePath
    dropIosCarried(appId, ['profilePickerOpened'])
    importAnswered = 'import-provide-profile-path'
  }

  // S9-S11: a validated tail answer routes its explicit next step in (the same
  // guard as the tail park: only while the slim tail progress is in flight).
  let forcedNextStep: OnboardingStep | undefined
    = opts?.tailNext && progress.completedSteps?.credentialsSaved ? opts.tailNext : undefined

  for (let i = 0; i < MAX_AUTO_STEPS; i++) {
    // Session-parked recovery steps (error / cert-limit / duplicate-profile)
    // override the persisted resume step — they are the MCP's mirror of the
    // TUI's React `step` state, which resume routing can never reproduce.
    // The parked interactive TAIL step (S9-S11) sits between them and resume:
    // a re-render must re-ask the parked question, never drift forward through
    // the resume router (which collapses past the preview consent gate).
    let step = forcedNextStep
      ?? iosParkedStep(getSession(appId).iosCarried)
      ?? (mcpTailParkedStep(appId, progress) as OnboardingStep | null)
      ?? getIosResumeStep(progress)
    forcedNextStep = undefined

    // S12: the import park is one-shot per drive — consumed here and re-merged
    // only when an import prompt re-renders below, so it can never go stale
    // once the flow moves past the prompt (e.g. export → save → ask-build).
    if (getSession(appId).iosCarried.parkedImportStep !== undefined)
      dropIosCarried(appId, ['parkedImportStep'])

    // S12: inventory-dependent import steps re-run the silent scan first when
    // the carried inventory is absent (fresh fork entry / server restart) —
    // import-scanning routes back via getImportEntryStep, mirroring BOTH the
    // TUI's scan-before-questions order and its crash-recovery resume (the
    // ephemeral pickers are NEVER resume targets).
    if (IOS_IMPORT_INVENTORY_STEPS.has(step) && !getSession(appId).iosCarried.importMatches)
      step = 'import-scanning'

    // The TUI-only .p8 input chain renders as the single 'ios-api-key' gate —
    // or, on a fresh macOS entry with the import capability wired, the S12
    // setup-method fork (create-new vs import-existing). NOTE: branch on the
    // CAPABILITY, not on iosSetupForkStep's returned name — backing-up routes
    // next:'setup-method-select' on macOS, which must collapse back to the
    // api-key gate for import-incapable drivers (the S6a behavior).
    if (IOS_API_KEY_GATE_STEPS.has(step)) {
      if (!progress.setupMethod && !progress.p8Path && iosImportCapable(ios))
        return iosSetupMethodResult(facts)
      return iosApiKeyGateResult(facts)
    }
    // ask-build is the post-save entry point — map to the shared build-ready
    // choice exactly like the android driver (the unchanged C2/D2 contract).
    if (step === 'ask-build')
      return decideBuildPhase(facts, 'ios')

    // ── S8: post-save tail terminal ──────────────────────────────────────────
    // 'build-complete' ends the shared tail. The MCP run is over: drop the
    // slim tail progress (mirroring the TUI, which never keeps post-save state
    // on disk) and clear the session so a later onboarding starts fresh — the
    // credentials-exist gate re-protects the saved credentials. NEVER
    // decideBuildPhase here: the build already happened (buildRequested).
    if (step === 'build-complete') {
      // Harvest the outcome facts BEFORE the cleanup wipes the session.
      const outcomes = harvestTailOutcomes(appId, Boolean(progress?.completedSteps?.ciSecretsUploaded))
      try {
        await ios.deleteProgress?.(appId)
      }
      catch {
        // Best-effort cleanup — a stale slim file only re-renders this terminal.
      }
      clearSession(appId)
      return tailCompleteResult(appId, 'ios', outcomes)
    }

    // Data-safety gate (parked by a TUI run or seeded above) → the
    // backup-or-cancel choice.
    if (step === 'credentials-exist')
      return iosCredentialsExistResult(facts)

    const session = getSession(appId)
    const ctx: IosStepCtx = { appId, ...(session.iosCarried as Partial<IosStepCtx>) }

    // ── S9-S11: interactive tail steps render structurally (and park) ────────
    // Includes ci-secrets-setup, whose TAIL_KIND is 'auto' but which has NO
    // effect in runTailEffect — it is the retry/skip screen shown when no
    // git-hosting CLI is ready. The view context comes from the session's
    // iosCarried (where decideIos merges every tail transient) overlaid on the
    // previously parked inventories.
    if (MCP_TAIL_INTERACTIVE_STEPS.has(step)) {
      return renderTailStep('ios', appId, step, progress, ctx as unknown as Record<string, unknown>, {
        defaultExportPath: ios.defaultExportPath,
        generateWorkflow: ios.generateWorkflow,
        detectPackageManager: ios.detectPackageManager,
      })
    }

    // ── S12: import-provide-profile-path is a PATH INPUT over MCP ────────────
    // The TUI opens a native .mobileprovision picker inside the effect; the
    // headless MCP parks an input gate collecting profilePath instead, then
    // re-drives the effect with a one-shot picker resolving the provided path
    // (see the effect dispatch below). Without this park the 'auto' view would
    // dispatch the effect, see no picker, and bounce straight back to recovery.
    if (step === 'import-provide-profile-path' && profilePathAnswer === undefined) {
      mergeIosCarried(appId, { parkedImportStep: step })
      return mapIosView({
        step,
        kind: 'input',
        title: 'Use a .mobileprovision file from disk.',
        prompt: 'Absolute path to the .mobileprovision file:',
        collect: ['profilePath'],
      }, facts, ctx)
    }

    const view = iosViewForStep(step, progress, ctx)

    // A parked choice with a recorded answer re-drives as a RESOLVER effect
    // instead of re-rendering (mirrors the TUI onChange → runIosEffect with
    // the recorded carried state). Each is ONE-SHOT: consumed below so a
    // re-park in the same call renders the prompt instead of looping.
    const isVerifyResolver = step === 'verify-app' && Boolean(session.iosCarried.verifyAction)
    const isCertLimitResolver = step === 'cert-limit-prompt' && certLimitAnswered
    const isDupResolver = step === 'duplicate-profile-prompt' && dupAnswered
    const isErrorResolver = step === 'error' && errorRetry
    // S12: an import prompt whose answer arrived THIS call (one-shot).
    const isImportResolver = importAnswered !== undefined && importAnswered === step
    const isResolver = isVerifyResolver || isCertLimitResolver || isDupResolver || isErrorResolver || isImportResolver

    if (view.kind !== 'auto' && !isResolver) {
      if (view.kind === 'done')
        return decideBuildPhase(facts, 'ios')
      // S12: re-park the interactive import prompt the user is now looking at
      // (the headless mirror of the TUI's React `step`) so the next call's
      // strict gate validates the answer against THIS prompt.
      if (IOS_IMPORT_PARK_STEPS.has(step))
        mergeIosCarried(appId, { parkedImportStep: step })
      // 'error' (and the recovery prompts) map to structured states in
      // mapIosView — the S6a blanket ios-credentials-failed mapping is gone.
      return mapIosView(view, facts, ctx)
    }

    try {
      // saving-credentials needs the raw .p8 bytes for the APPLE_KEY_CONTENT
      // credential. They ride the process-local session (never persisted);
      // after a server restart re-read them from the persisted p8Path — the
      // same self-heal resolveP8Content performs for verifying-key.
      if (step === 'saving-credentials' && !session.iosCarried.p8Content && progress.p8Path && ios.readFile) {
        try {
          mergeIosCarried(appId, { p8Content: await ios.readFile(progress.p8Path) })
        }
        catch {
          // Degrade: credentials save without the APPLE_KEY_* fields.
        }
      }

      const isTailEffectStep = MCP_TAIL_EFFECT_STEPS.has(step)
      // S8 restart fallback: the tail carried (savedCredentials/ciSecretEntries
      // incl. CAPGO_TOKEN) is process-local; after a server restart re-derive
      // it from the saved credential store + the driver's pre-bound entry
      // builder BEFORE the effect consumes it. Never at saving-credentials
      // itself: there the store still holds the PREVIOUS credentials — the
      // save effect builds the fresh map from carried/progress.
      if (isTailEffectStep && step !== 'saving-credentials' && progress.completedSteps?.credentialsSaved)
        await rederiveTailCarried(appId, 'ios', ios)
      const liveSession = getSession(appId)
      // Tail effects read the TailEffectDeps carried shape; merge the tail
      // registry over the iOS one (saving-credentials still reads certData/
      // profileData/teamId/p8Content from the iOS carried).
      const carried = isTailEffectStep
        ? { ...liveSession.iosCarried, ...liveSession.tailCarried }
        : liveSession.iosCarried
      // S12: the manual-path arm re-drives the engine's import-provide-profile-
      // path effect with a ONE-SHOT picker resolving the user-provided path —
      // the engine's own read/parse/invariant pipeline then runs unchanged.
      const effectDeps: IosEffectDeps = { ...ios, appId, carried }
      if (step === 'import-provide-profile-path' && profilePathAnswer !== undefined) {
        const providedPath = profilePathAnswer
        profilePathAnswer = undefined
        effectDeps.openProfilePicker = async () => providedPath
      }
      const r = await runIosEffect(step, progress, effectDeps)
      progress = r.progress
      if (r.transient)
        mergeIosCarried(appId, r.transient as Partial<IosCarried>)

      // ── S8: MCP tail persistence (slim + secret-free) + carried registry ──
      // The shared tail NEVER persists post-save (the TUI keeps tail state in
      // memory); the MCP driver owns marker persistence (android/types.ts:
      // "markers are written by whichever driver chooses to persist the
      // tail"). The slim writers WHITELIST fields, so secrets can never reach
      // progress.json; the tail transients park in the session's tailCarried.
      if (isTailEffectStep) {
        mergeTailCarried(appId, {
          savedCredentials: r.transient?.savedCredentials,
          ciSecretEntries: r.transient?.ciSecretEntries,
          ciSecretExistingKeys: r.transient?.ciSecretExistingKeys,
          // NON-SECRET outcome facts (counts/labels/paths only) — parked so
          // harvestTailOutcomes can surface them on the terminal build-complete.
          ciSecretUploadSummary: r.transient?.ciSecretUploadSummary,
          workflowFilePath: r.transient?.workflowFilePath,
          envExportPath: r.transient?.envExportPath,
        })
        if (step === 'saving-credentials' && r.next === 'ask-build') {
          // The save succeeded (the self-heal path returns a different next):
          // write the credentialsSaved marker so resume routes THROUGH the
          // tail (ask-build first) instead of bouncing to platform-select or
          // re-seeding the credentials-exist gate against the credentials the
          // save itself just wrote.
          progress = slimIosTailProgress({
            ...progress,
            completedSteps: { ...progress.completedSteps, credentialsSaved: { savedAt: new Date().toISOString() } },
          })
          await ios.saveProgress?.(appId, progress)
        }
        else if (progress.completedSteps?.credentialsSaved) {
          if (step === 'uploading-ci-secrets') {
            // Marker immediately after the successful upload (the TUI's
            // pre-delete marker semantics): a resume must never re-fire the
            // already-completed upload.
            progress = {
              ...progress,
              completedSteps: {
                ...progress.completedSteps,
                ciSecretsUploaded: {
                  provider: progress.ciSecretTarget?.provider ?? 'github',
                  count: getSession(appId).tailCarried.ciSecretEntries?.length ?? 0,
                },
              },
            }
          }
          // Re-slim on every tail effect so the markers + non-secret prefs the
          // effect recorded on progress (e.g. the auto-picked ciSecretTarget)
          // survive a restart.
          progress = slimIosTailProgress(progress)
          await ios.saveProgress?.(appId, progress)
        }
      }
      // Each resolver consumed its recorded answer — drop/clear it so a later
      // re-entry renders the prompt (or re-runs the initial fetch) instead of
      // replaying a stale action.
      if (isVerifyResolver)
        dropIosCarried(appId, ['verifyAction'])
      if (isCertLimitResolver)
        certLimitAnswered = false
      if (isDupResolver)
        dupAnswered = false
      if (isErrorResolver) {
        errorRetry = false
        dropIosCarried(appId, ['errorAction'])
      }
      // S12: the import resolver + its one-shot menu picks are consumed so a
      // later re-entry renders the prompt instead of replaying a stale action
      // (chosenIdentity/chosenProfile stay carried — downstream effects need
      // them, and a re-pick simply overwrites).
      if (isImportResolver)
        importAnswered = undefined
      if (step === 'import-no-match-recovery')
        dropIosCarried(appId, ['recoveryAction'])
      if (step === 'import-portal-explanation')
        dropIosCarried(appId, ['portalAction'])
      if (step === 'import-export-warning')
        dropIosCarried(appId, ['exportWarningAction'])

      // Recovery-park cleanup — the MCP mirror of the TUI clearing its React
      // state once a recovery resolves:
      //  - a successful revoke clears the cert-limit inventory + pick (the TUI
      //    clears certToRevoke/existingCerts after the revoke);
      //  - a completed duplicate deletion clears the duplicate list + confirm;
      //  - leaving the error screen (retry routed) clears the error park so the
      //    next call resumes the flow instead of re-rendering the stale error.
      if (step === 'revoking-certificate' && r.next === 'creating-certificate')
        dropIosCarried(appId, ['certToRevoke', 'existingCerts'])
      if (step === 'deleting-duplicate-profiles' && r.next && r.next !== 'error')
        dropIosCarried(appId, ['duplicateProfiles', 'confirmDeleteDuplicates'])
      if (step === 'error' && r.next && r.next !== 'error')
        dropIosCarried(appId, ['error', 'retryStep'])

      if (r.next === 'ai-analysis-prompt') {
        // TUI-only AI-debug entry — reroute to the existing build-failed handling.
        return {
          onboarding: 'capgo-builder', phase: 'build', state: 'build-failed', platform: 'ios',
          progress: 92, kind: 'error',
          summary: 'The build did not succeed. Check the build logs in your Capgo dashboard, fix the cause, and retry.',
          rules: ONBOARDING_RULES,
        }
      }
      // NOTE: r.next === 'error' is NOT special-cased — the loop parks on the
      // 'error' step (transient.error/retryStep just merged into the session)
      // and the next iteration renders the structured recovery screen.
      if (r.next)
        forcedNextStep = r.next
    }
    catch (err) {
      return iosEffectError(step, err, facts)
    }
  }

  return {
    onboarding: 'capgo-builder', phase: 'credentials', state: 'ios-auto-loop-guard', platform: 'ios', progress: 0, kind: 'error',
    summary: 'iOS onboarding stalled (too many automatic steps without progress). Please retry or run `capgo doctor`.',
    rules: ONBOARDING_RULES,
  }
}

export function mapAndroidView(
  view: ReturnType<typeof androidViewForStep>,
  facts: PreflightFacts,
  opts?: { keystorePath?: string, keystorePassword?: string },
): NextStepResult {
  const base = {
    onboarding: 'capgo-builder' as const,
    phase: 'credentials' as const,
    platform: 'android' as const,
    state: view.step,
    progress: ANDROID_STEP_PROGRESS[view.step] ?? 45,
    rules: ONBOARDING_RULES,
  }

  switch (view.step) {
    case 'credentials-exist':
      // Data-safety gate. Mirrors main's CredentialsExistStep: warn that saved
      // android credentials already exist and offer to back them up (then
      // continue) or stop. The agent must collect the choice and call next_step
      // with credentialsExistChoice.
      return {
        ...base,
        kind: 'choice',
        summary: `Android credentials already exist for "${facts.appId}". Continuing onboarding will create new credentials and replace the existing ones. Back them up first, or stop?`,
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { credentialsExistChoice: '<backup|cancel>' },
          instruction: 'Tell the user their existing Android credentials will be replaced. Ask whether to back them up first and continue, or stop. Then call next_step with credentialsExistChoice.',
          call: `${NEXT_STEP_TOOL}({ credentialsExistChoice: "backup" })`,
        },
      }
    case 'service-account-method-select': {
      const savedLine = opts?.keystorePath
        ? `✓ Keystore created and saved to ${opts.keystorePath}${opts.keystorePassword ? ` (password: ${opts.keystorePassword})` : ''} — keep ${opts.keystorePassword ? 'both' : 'this file'} safe (you'll need ${opts.keystorePassword ? 'them' : 'it'} for every release). `
        : ''
      return {
        ...base,
        kind: 'choice',
        summary: `${savedLine}Now, connect Google Play so Capgo can upload your builds. A Google Play "service account" is the credential that lets Capgo publish on your behalf — how do you want to set it up?`,
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        ...(opts?.keystorePath ? { context: { keystorePath: opts.keystorePath, ...(opts.keystorePassword ? { keystorePassword: opts.keystorePassword } : {}) } } : {}),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { serviceAccountMethod: '<generate|existing>' },
          instruction: 'Present the two options to the user. As soon as the user picks one — INCLUDING when they say they already have a service-account JSON ("use my existing file") — call next_step with serviceAccountMethod ("existing" or "generate") to record the choice. Do NOT ask the user for the JSON file path yourself: choosing the method is its own step, and the flow will ask for the path next.',
          call: `${NEXT_STEP_TOOL}({ serviceAccountMethod: "generate" })`,
        },
      }
    }

    // NOTE: the 'google-sign-in' step is rendered by the broker sign-in flow in
    // decideAndroid (signInProceed) BEFORE mapAndroidView is consulted, so there is
    // no 'google-sign-in' case here — it would be dead and its old loopback copy
    // ("tokens never reach Capgo servers") is no longer true with the broker.
    case 'play-developer-id-input':
      return {
        ...base,
        kind: 'human_gate',
        summary: `Google sign-in complete. Now I need your Google Play Developer account ID.`,
        collect: [{ field: 'playDeveloperId', desc: 'Your Play Developer account ID (the number in the Play Console URL, e.g. 1234567890123456789)' }],
        human: {
          instruction: 'Open play.google.com/console, look at the URL the number after /developers/ is your account ID. Paste it here.',
        },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { playDeveloperId: '<developerId>' },
          instruction: 'Collect the Play Developer account ID from the user, then call next_step with playDeveloperId.',
          call: `${NEXT_STEP_TOOL}({ playDeveloperId: "1234567890123456789" })`,
        },
      }

    case 'gcp-projects-select':
      return {
        ...base,
        kind: 'choice',
        summary: `Pick the Google Cloud project to use for "${facts.appId}".`,
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          // Two routes (mirrors main's app.tsx onChange): pick an EXISTING
          // project by passing gcpProjectId, OR create a NEW project by passing
          // gcpProjectName (the "Create a new project" / __new__ option). Send
          // exactly one — the strict gate rejects both at once.
          with: { gcpProjectId: '<projectId>', gcpProjectName: '<new project name>' },
          instruction: 'Present the GCP project options to the user. To use an existing project call next_step with gcpProjectId. To create a new project (the "Create a new project" option), call next_step with gcpProjectName instead. Send exactly one.',
          call: `${NEXT_STEP_TOOL}({ gcpProjectId: "my-gcp-project" })  // or, to create a new one: ${NEXT_STEP_TOOL}({ gcpProjectName: "My App Capgo" })`,
        },
      }

    case 'gcp-project-create-name':
      return {
        ...base,
        kind: 'human_gate',
        summary: `Creating a new GCP project for "${facts.appId}". What should it be called?`,
        collect: [{ field: 'gcpProjectName', desc: 'Display name for the new GCP project (e.g. My App Capgo)' }],
        human: {
          instruction: 'Choose a display name for the new Google Cloud project (it can be changed later).',
        },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { gcpProjectName: '<name>' },
          instruction: 'Collect a project name from the user, then call next_step with gcpProjectName.',
          call: `${NEXT_STEP_TOOL}({ gcpProjectName: "My App Capgo" })`,
        },
      }

    case 'android-package-select': {
      if (view.kind === 'choice') {
        return {
          ...base,
          kind: 'choice',
          summary: `Which Android package (applicationId) should I grant access to?`,
          options: [
            ...(view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
            { value: '__manual__', label: 'Type a different package name' },
          ],
          next: {
            tool: NEXT_STEP_TOOL,
            with: { androidPackage: '<packageName>' },
            instruction: 'Present the detected package options to the user, then call next_step with androidPackage.',
            call: `${NEXT_STEP_TOOL}({ androidPackage: "com.example.app" })`,
          },
        }
      }
      return {
        ...base,
        kind: 'human_gate',
        summary: `I could not detect the Android package name. Please provide it manually.`,
        collect: [{ field: 'androidPackage', desc: 'The applicationId from your Android app (e.g. com.example.app)' }],
        human: {
          instruction: 'Find the applicationId in your android/app/build.gradle file and provide it here.',
        },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { androidPackage: '<packageName>' },
          instruction: 'Collect the Android package name from the user, then call next_step with androidPackage.',
          call: `${NEXT_STEP_TOOL}({ androidPackage: "com.example.app" })`,
        },
      }
    }

    case 'android-app-verify':
      // Only reached as a choice when the chosen package isn't a real Play app
      // (the effect auto-advances on exact-match or a degraded/un-verifiable
      // check). The view message + options differ by outcome (no-app vs
      // wrong-build-id); surface them verbatim and let the user choose.
      return {
        ...base,
        kind: 'choice',
        summary: view.message ?? 'Your build package does not match an app in Play Console yet.',
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { androidVerifyAction: '<open|recheck|cancel|proceed>' },
          instruction: 'Show the message verbatim and let the user choose. After they create the app, call next_step with androidVerifyAction: "recheck". If apps:search still does not list a just-created app, "proceed" advances anyway (the provisioning invite is the real check). If the package was simply wrong, call next_step again with a corrected androidPackage instead. "cancel" stops onboarding.',
          call: `${NEXT_STEP_TOOL}({ androidVerifyAction: "recheck" })`,
        },
      }

    case 'sa-json-existing-path':
      return {
        ...base,
        kind: 'human_gate',
        summary: `Provide the path to your existing Google Play service-account JSON file.`,
        collect: [{ field: 'serviceAccountJsonPath', desc: 'Absolute path to the Google Play service-account .json file' }],
        human: {
          instruction: 'Give me the path to your Google Play service-account .json key file. The file stays on your machine do not paste its contents here.',
        },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { serviceAccountJsonPath: '<path>' },
          instruction: 'Ask the user for the service-account .json file path, then call next_step with serviceAccountJsonPath.',
          call: `${NEXT_STEP_TOOL}({ serviceAccountJsonPath: "/path/to/service-account.json" })`,
        },
      }

    case 'sa-json-validation-failed':
      return {
        ...base,
        kind: 'choice',
        summary: `Service account validation failed${view.message ? `: ${view.message}` : '.'}`,
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { saMethodChoice: '<retry|save-anyway|oauth>' },
          instruction: 'Present the recovery options to the user, then call next_step with saMethodChoice.',
          call: `${NEXT_STEP_TOOL}({ saMethodChoice: "retry" })`,
        },
      }

    case 'keystore-method-select':
      return {
        ...base,
        kind: 'choice',
        summary: `Let's set up your Android signing keystore for "${facts.appId}". Do you already have one?\n\nThis choice matters: if you have EVER published this app to Google Play, you must reuse the SAME keystore you signed those releases with. Creating a new keystore changes the signing key, so Google Play will REJECT new uploads — unless you reset the upload key in the Google Play Console (App integrity → App signing → request an upload key reset). Creating a new keystore is only safe if this app has never been uploaded to Google Play (a first build).`,
        options: (view.options ?? [])
          .filter(o => o.value !== 'learn')
          .map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreMethod: '<existing|generate>' },
          instruction: 'First ask the user whether this app has ALREADY been published to Google Play. If yes (or they are unsure), steer them to "existing" and use the keystore they signed previous releases with — generating a new one will make Google Play reject their uploads unless they reset the upload key in the Play Console. Creating a new keystore is only safe if the app has NEVER been uploaded to Google Play. Then call next_step with keystoreMethod.',
          call: `${NEXT_STEP_TOOL}({ keystoreMethod: "generate" })`,
        },
      }

    case 'keystore-explainer':
      return {
        ...base,
        kind: 'human_gate',
        summary: 'A keystore signs your Android app — you need one to publish to Google Play. If you have ALREADY published this app, you must reuse the SAME keystore: a new one changes the signing key and Google Play will reject your uploads unless you reset the upload key in the Play Console.',
        human: { instruction: 'Explain what a keystore is, then warn: if the app has already been published to Google Play they MUST reuse the existing keystore — a new key is rejected by Google Play unless they reset the upload key in the Google Play Console (App integrity → App signing). Ask whether the app has ever been uploaded to Google Play: if yes, use the existing keystore; if never, creating a new one is fine.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreMethod: '<existing|generate>' },
          instruction: 'Ask whether they already have a keystore (and whether the app has been published to Google Play), then call next_step with keystoreMethod.',
          call: `${NEXT_STEP_TOOL}({ keystoreMethod: "generate" })`,
        },
      }

    case 'keystore-existing-path':
      return {
        ...base,
        kind: 'human_gate',
        summary: 'Point me to your existing Android keystore.',
        collect: [{ field: 'keystorePath', desc: 'Absolute path to your keystore (.jks/.keystore/.p12)' }],
        human: { instruction: 'Give me the absolute path to your keystore file. It stays on your machine.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystorePath: '<path>' },
          instruction: 'Ask for the keystore path, then call next_step with keystorePath.',
          call: `${NEXT_STEP_TOOL}({ keystorePath: "/path/to/release.jks" })`,
        },
      }

    case 'keystore-existing-store-password':
      return {
        ...base,
        kind: 'human_gate',
        summary: "What is the keystore's store password?",
        collect: [{ field: 'keystoreStorePassword', desc: 'The keystore store password — fine to paste it here in the chat' }],
        human: { instruction: 'Ask the user for the store password — it is 100% fine for them to paste it directly here in the chat — then pass it as keystoreStorePassword.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreStorePassword: '<password>' },
          instruction: 'Ask the user for the store password, then call next_step with keystoreStorePassword.',
          call: `${NEXT_STEP_TOOL}({ keystoreStorePassword: "..." })`,
        },
      }

    case 'keystore-existing-alias-select':
      return {
        ...base,
        kind: 'choice',
        summary: 'Which key alias should we use?',
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreAlias: '<alias>' },
          instruction: 'Present the alias options to the user, then call next_step with keystoreAlias.',
          call: `${NEXT_STEP_TOOL}({ keystoreAlias: "release" })`,
        },
      }

    case 'keystore-existing-alias':
      return {
        ...base,
        kind: 'human_gate',
        summary: 'Which key alias is in your keystore?',
        collect: [{ field: 'keystoreAlias', desc: 'The key alias' }],
        human: { instruction: 'Ask the user for the key alias inside the keystore, then pass it as keystoreAlias.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreAlias: '<alias>' },
          instruction: 'Ask the user for the key alias, then call next_step with keystoreAlias.',
          call: `${NEXT_STEP_TOOL}({ keystoreAlias: "release" })`,
        },
      }

    case 'keystore-existing-key-password':
      return {
        ...base,
        kind: 'human_gate',
        summary: 'What is the key password? (Leave blank if it is the same as the store password.)',
        collect: [{ field: 'keystoreKeyPassword', desc: 'The key password, or blank to match the store password' }],
        human: { instruction: 'Ask the user for the key password. If they leave it blank, it will use the store password. It is 100% fine for them to paste the password directly here in the chat.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreKeyPassword: '<password>' },
          instruction: 'Ask the user for the key password (blank means same as store password), then call next_step with keystoreKeyPassword.',
          call: `${NEXT_STEP_TOOL}({ keystoreKeyPassword: "..." })`,
        },
      }

    case 'keystore-new-alias':
      return {
        ...base,
        kind: 'human_gate',
        summary: `Since you don't have a keystore, I'll create one for you and save it as a file in your project (android/app/<alias>.p12) on your machine — it can't get lost and you keep full control of it. First, name the key: what alias? (default: release)`,
        collect: [{ field: 'keystoreNewAlias', desc: 'Alias for the new key (default release)' }],
        human: { instruction: 'Reassure the user that you will GENERATE a keystore file for them and save it into their project on disk (they do not need to create or find one — they will receive it, and it stays on their machine). Then ask for a key alias (suggest "release" as the default) and pass it as keystoreNewAlias.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreNewAlias: '<alias>' },
          instruction: 'Ask the user for the new key alias, then call next_step with keystoreNewAlias.',
          call: `${NEXT_STEP_TOOL}({ keystoreNewAlias: "release" })`,
        },
      }

    case 'keystore-new-password-method':
      return {
        ...base,
        kind: 'choice',
        summary: 'How should we set the keystore password?',
        options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystorePasswordMethod: '<random|manual>' },
          instruction: 'Present the password method options to the user, then call next_step with keystorePasswordMethod.',
          call: `${NEXT_STEP_TOOL}({ keystorePasswordMethod: "random" })`,
        },
      }

    case 'keystore-new-store-password':
      return {
        ...base,
        kind: 'human_gate',
        summary: 'Set a store password for the new keystore (min 6 chars).',
        collect: [{ field: 'keystoreStorePassword', desc: 'Store password for the new keystore (min 6 chars) — fine to type it here in the chat' }],
        human: { instruction: 'Ask the user to set a store password for the new keystore (at least 6 characters). It is 100% fine for them to paste/type the password directly here in the chat — do not discourage that.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreStorePassword: '<password>' },
          instruction: 'Ask the user for the store password, then call next_step with keystoreStorePassword.',
          call: `${NEXT_STEP_TOOL}({ keystoreStorePassword: "..." })`,
        },
      }

    case 'keystore-new-key-password':
      return {
        ...base,
        kind: 'human_gate',
        summary: 'Set a key password (leave blank to match the store password).',
        collect: [{ field: 'keystoreKeyPassword', desc: 'Key password, or blank to match the store password' }],
        human: { instruction: 'Ask the user for a key password (blank means same as store password). It is 100% fine for them to type the password directly here in the chat.' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreKeyPassword: '<password>' },
          instruction: 'Ask the user for the key password (blank means same as store password), then call next_step with keystoreKeyPassword.',
          call: `${NEXT_STEP_TOOL}({ keystoreKeyPassword: "..." })`,
        },
      }

    case 'keystore-new-cn': {
      // If the user picked "random", the password was already generated and is
      // sitting in progress — surface it RIGHT HERE (the very next screen), not
      // several steps later, so they receive it the moment they chose random.
      // Showing it in the chat is fine; they need it to use the keystore.
      const genPw = facts.androidProgress?.keystorePasswordGenerated ? facts.androidProgress?.keystoreStorePassword : undefined
      return {
        ...base,
        kind: 'human_gate',
        summary: genPw
          ? `Your keystore password has been generated (shown below — give it to the user and have them save it now; it's completely fine to show it here in the chat). Next, the certificate common name? (default: your app id "${facts.appId}")`
          : `Certificate common name? (default: your app id "${facts.appId}")`,
        collect: [{ field: 'keystoreCommonName', desc: 'Certificate Common Name (default: app id)' }],
        ...(genPw ? { context: { keystorePassword: genPw } } : {}),
        human: { instruction: genPw
          ? `First, give the user the generated keystore password shown above and tell them to save it now — it is 100% fine to show the password here in the chat, do not hide it. Then ask for the certificate common name (suggest "${facts.appId}" as the default) and pass it as keystoreCommonName.`
          : `Ask the user for the certificate common name (suggest "${facts.appId}" as the default), then pass it as keystoreCommonName.` },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { keystoreCommonName: '<name>' },
          instruction: 'Ask the user for the certificate common name, then call next_step with keystoreCommonName.',
          call: `${NEXT_STEP_TOOL}({ keystoreCommonName: "com.x" })`,
        },
      }
    }

    case 'error':
      return { ...base, kind: 'error', summary: view.message ?? 'Android setup error.' }

    default:
      // Generic mapping for views outside the structured cases (S8: the shared
      // post-save tail's interactive steps land here until the next slice maps
      // them structurally). Mirrors mapIosView's default: surface the engine
      // view verbatim (prompt/title + options) and allow a plain re-check.
      // Option-carrying views of any kind (choice, the ci-secrets-failed
      // 'error' view) render as a choice so the options are never dropped.
      if (view.kind === 'choice' || (view.options ?? []).length > 0) {
        return {
          ...base,
          kind: 'choice',
          summary: view.prompt ?? view.title ?? view.message ?? `Android setup: ${view.step}`,
          options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
          next: {
            tool: NEXT_STEP_TOOL,
            instruction: 'Present the options to the user. Structured answers for this step arrive in a later milestone — call next_step({}) to re-check, or finish this step in the interactive wizard (`npx @capgo/cli build init`).',
            call: `${NEXT_STEP_TOOL}({})`,
          },
        }
      }
      return {
        ...base,
        kind: 'human_gate',
        summary: view.prompt ?? view.title ?? `Android setup: ${view.step}`,
        human: { instruction: view.prompt ?? 'Continue when ready.' },
        next: { tool: NEXT_STEP_TOOL, instruction: 'Call next_step to continue.', call: `${NEXT_STEP_TOOL}({})` },
      }
  }
}

function androidEffectError(
  step: AndroidOnboardingStep,
  err: unknown,
  _facts: PreflightFacts,
): NextStepResult {
  const message = err instanceof Error ? err.message : String(err)
  const stepProg = ANDROID_STEP_PROGRESS[step] ?? 45

  if (step === 'gcp-projects-loading') {
    return {
      onboarding: 'capgo-builder', phase: 'credentials', platform: 'android', state: step,
      progress: stepProg, kind: 'human_gate',
      summary: `Failed to load GCP projects: ${message}`,
      human: { instruction: 'Check that your Google account has access to GCP, then tell me to continue to retry.' },
      next: { tool: NEXT_STEP_TOOL, instruction: 'After the user checks their GCP access, call next_step({}) to retry.', call: `${NEXT_STEP_TOOL}({})` },
      rules: ONBOARDING_RULES,
    }
  }
  if (step === 'gcp-setup-running') {
    return {
      onboarding: 'capgo-builder', phase: 'credentials', platform: 'android', state: step,
      progress: stepProg, kind: 'human_gate',
      summary: `GCP setup failed: ${message}`,
      human: { instruction: 'Check your GCP permissions and Play Console access. Tell me to continue to retry.' },
      next: { tool: NEXT_STEP_TOOL, instruction: 'After the user checks their access, call next_step({}) to retry.', call: `${NEXT_STEP_TOOL}({})` },
      rules: ONBOARDING_RULES,
    }
  }
  if (step === 'saving-credentials') {
    return {
      onboarding: 'capgo-builder', phase: 'credentials', platform: 'android', state: step,
      progress: stepProg, kind: 'human_gate',
      summary: `Saving credentials failed: ${message}`,
      human: { instruction: 'Tell me to continue to retry saving credentials.' },
      next: { tool: NEXT_STEP_TOOL, instruction: 'Call next_step({}) to retry.', call: `${NEXT_STEP_TOOL}({})` },
      rules: ONBOARDING_RULES,
    }
  }
  return {
    onboarding: 'capgo-builder', phase: 'credentials', platform: 'android', state: step,
    progress: stepProg, kind: 'error',
    summary: `Android setup error at step "${step}": ${message}`,
    rules: ONBOARDING_RULES,
  }
}

// ── Appflow migration (MCP) ───────────────────────────────────────────────────
//
// The Appflow migration is driven through the NEUTRAL PlatformFlow contract
// (appflowFlow) rather than a bespoke decider: decideAppflow resolves the
// resume step, runs auto effects in a bounded loop (the same MAX_AUTO_STEPS
// guard as ios/android), and maps the flow's neutral StepView into the MCP
// NextStepResult. Progress is process-local (session-state appflowProgress) —
// there is no on-disk appflow loader; a restart re-runs from explain and the
// flow self-heals via the cached token. On the build hand-off the collected
// per-platform Capgo creds are persisted into the REAL credential store, so the
// existing build/CI tail treats them like natively-set-up creds.
const APPFLOW_PHASE = 'credentials' as const

/** Map a neutral StepView.kind to the MCP StepKind. The neutral 'input' kind (the
 * step-8 provide chain: .p8 path / key id / issuer id) has no MCP equivalent, so
 * it renders as a 'human_gate' that collects one text field via next_step. */
function appflowKind(kind: StepView['kind']): StepKind {
  if (kind === 'choice' || kind === 'human_gate' || kind === 'info' || kind === 'done' || kind === 'error')
    return kind
  if (kind === 'input')
    return 'human_gate'
  // 'auto' renders as an auto step.
  return 'auto'
}

/** Coarse 0-100 progress for an appflow step (informational only). */
function appflowProgressFor(step: AppflowStep): number {
  const order: AppflowStep[] = [
    'explain', 'authenticating', 'select-org', 'select-app', 'fetch-signing',
    'select-ios-cert', 'select-android-cert', 'no-signing-submenu', 'fetch-distribution',
    'ios-dist-gapfill', 'android-dist-gapfill', 'ios-p8-generate', 'android-sa-generate',
    'validate', 'p8-upgrade-prompt', 'p8-source-select', 'input-p8-path', 'input-p8-key-id',
    'input-p8-issuer-id', 'load-provided-p8', 'handoff-build', 'done',
  ]
  const idx = order.indexOf(step)
  if (idx < 0)
    return 10
  return Math.min(95, 10 + Math.round((idx / (order.length - 1)) * 80))
}

// Cap + flatten an exception/message before weaving it into an MCP summary so a
// raw exception string (or a hostile API body fragment) cannot leak large/unsafe
// content to the caller. Single line, allow-listed-ish, bounded.
function sanitizeForSummary(message: string, max = 200): string {
  const flat = String(message ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * The no-signing submenu's 'email-support' arm: surface the Capgo support
 * contact and HOLD on the submenu (the agent re-presents it). We cannot open a
 * mail client over MCP, so we hand the caller the address + framing and a
 * next_step that returns to the same choice.
 */
function appflowEmailSupportResult(facts: PreflightFacts): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: APPFLOW_PHASE,
    state: 'appflow-no-signing-submenu',
    progress: appflowProgressFor('no-signing-submenu'),
    kind: 'human_gate',
    summary: `To get help migrating "${facts.appId}" from Appflow, email ${SUPPORT_EMAIL} (mention the app and that signing credentials appear missing). I cannot open your mail app from here.`,
    human: {
      instruction: `Email ${SUPPORT_EMAIL} describing your Appflow app ("${facts.appId}") and that the migration reported no signing configuration. After that, you can pick another option on the submenu.`,
    },
    context: { supportEmail: SUPPORT_EMAIL },
    next: {
      tool: NEXT_STEP_TOOL,
      with: { value: '<skip|abandon|go-back>' },
      instruction: 'After emailing support (or deciding not to), call next_step with the submenu choice you want: skip, abandon, or go-back.',
      call: `${NEXT_STEP_TOOL}({ value: "go-back" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/** Render a neutral appflow StepView (interactive — not 'auto') into an MCP NextStepResult. */
function renderAppflowView(step: AppflowStep, view: StepView): NextStepResult {
  const base = {
    onboarding: 'capgo-builder' as const,
    phase: APPFLOW_PHASE,
    state: `appflow-${step}`,
    progress: appflowProgressFor(step),
    kind: appflowKind(view.kind),
    summary: view.prompt,
    rules: ONBOARDING_RULES,
  }
  if (view.kind === 'choice') {
    return {
      ...base,
      options: (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note })),
      next: {
        tool: NEXT_STEP_TOOL,
        with: { value: '<one of the option values>' },
        instruction: 'Present the options and call next_step with the user\'s pick as { value }.',
        call: `${NEXT_STEP_TOOL}({ value: "${(view.options?.[0]?.value) ?? 'continue'}" })`,
      },
    }
  }
  if (view.kind === 'human_gate') {
    return {
      ...base,
      human: { instruction: view.prompt },
      next: {
        tool: NEXT_STEP_TOOL,
        instruction: 'Show the explanation, then call next_step({}) to continue.',
        call: `${NEXT_STEP_TOOL}({})`,
      },
    }
  }
  if (view.kind === 'info') {
    return {
      ...base,
      next: {
        tool: NEXT_STEP_TOOL,
        instruction: 'Show the information, then call next_step({}) to continue.',
        call: `${NEXT_STEP_TOOL}({})`,
      },
    }
  }
  if (view.kind === 'input') {
    // The step-8 provide chain collects ONE text field per step. Map the
    // collected field to the next_step input key decideAppflow threads back
    // (p8Path -> input.p8Path, p8KeyId -> input.keyId, p8IssuerId -> input.issuerId).
    const field = view.collect?.[0]?.field
    const inputKey = field === 'p8Path' ? 'p8Path' : field === 'p8KeyId' ? 'keyId' : field === 'p8IssuerId' ? 'issuerId' : undefined
    // An unknown/absent input field would otherwise be silently coerced to
    // 'issuerId' — surface it as an error instead of routing the value to the wrong field.
    if (!field || !inputKey) {
      return {
        ...base,
        kind: 'error',
        summary: `Unsupported Appflow input field for step "${step}".`,
      }
    }
    return {
      ...base,
      human: { instruction: view.prompt },
      // Expose the field metadata so an agent following the structured `collect`
      // contract knows what to gather (mirrors how other input steps surface it).
      collect: [{ field: inputKey, desc: view.collect?.[0]?.desc ?? field }],
      next: {
        tool: NEXT_STEP_TOOL,
        with: { [inputKey]: `<${field}>` },
        instruction: `Ask the user for the value, then call next_step with { ${inputKey} }.`,
        call: `${NEXT_STEP_TOOL}({ ${inputKey}: "..." })`,
      },
    }
  }
  return base
}

/**
 * Drive the Appflow migration flow.
 *
 * `scope` is the migration scope ('ios' | 'android'), from the single-platform
 * "migrating from Appflow?" gate.
 * `input` carries the user's last answer (a choice value, or {} to advance an
 * info / human_gate). The bounded loop runs auto effects until it lands on an
 * interactive step or the build hand-off.
 */
export async function decideAppflow(
  facts: PreflightFacts,
  deps: EngineDeps,
  scope: 'ios' | 'android',
  input?: OnboardingInput,
): Promise<NextStepResult> {
  const appId = facts.appId!
  // Seed (or resume) the process-local progress. A fresh entry starts at the
  // explain gate with the chosen scope.
  let progress: AppflowProgress = getAppflowProgress(appId)
    // Seed capgoAppId from the Capgo app id (facts.appId) the rest of the engine
    // builds against, so the handoff-build app-id swap (Appflow hex → Capgo id)
    // is NOT a no-op over MCP and the inline tail never targets the Appflow hex.
    ?? { scope, capgoAppId: appId, migratable: { ios: false, android: false }, completedSteps: [] }
  // Keep the scope in sync with the entry point on a truly fresh entry.
  if (progress.scope !== scope && progress.completedSteps.length === 0)
    progress = { ...progress, scope }
  // Backfill capgoAppId on any resumed progress that predates the seed, so the
  // handoff-build app-id swap (Appflow hex → Capgo id) is always live over MCP.
  if (!progress.capgoAppId)
    progress = { ...progress, capgoAppId: appId }

  const flowDeps = buildAppflowEffectDeps({ appId, packageName: facts.appId })

  // Carries the most-recent AUTO effect's `transient` (e.g. the org/app/cert/dist
  // option lists, or validation results) so the interactive step it transitions
  // INTO renders with real options instead of an empty picker. Mirrors the TUI's
  // setCtx(result.transient) threading.
  let ctx: Record<string, unknown> = {}

  // Apply the user's answer to the step the migration is parked on (the
  // interactive step the previous call returned), then advance.
  //
  // A FRESH entry into the migration (the single-platform gate
  // `migratingFromAppflow: 'yes'`) must RENDER the resume step, not advance past
  // it. Every other call is an advance of the parked interactive step: a bare
  // next_step({}) advances an info / human_gate, and a next_step({ value })
  // answers a choice.
  const isFreshEntry = input?.migratingFromAppflow === 'yes'
  let step = appflowFlow.resumeStep(progress)
  const parkedView = appflowFlow.viewForStep(step, progress)
  const isInteractive = parkedView.kind !== 'auto'
  if (input && !isFreshEntry && isInteractive) {
    // The no-signing submenu's 'email-support' surfaces the support contact and
    // HOLDS the step (does not advance into a credential-less migration tail).
    if (step === 'no-signing-submenu' && input.value === 'email-support') {
      setAppflowProgress(appId, progress)
      return appflowEmailSupportResult(facts)
    }
    // Thread any text answer (custom build command / .env export path) so a tail
    // text-input step answered over MCP is not silently dropped (C31).
    const inputText = input.buildScriptCustom ?? input.envExportPath ?? input.profilePath ?? input.p8Path ?? input.keyId ?? input.issuerId
    progress = appflowFlow.applyInput(step, progress, { value: input.value, text: inputText })
    // 'abandon' on the no-signing submenu leaves the migration and starts native
    // onboarding for the affected platform (the spec's "come back later" exit).
    if (step === 'no-signing-submenu' && input.value === 'abandon') {
      const native: Platform = progress.noSigningScope === 'android' ? 'android' : 'ios'
      setAppflowProgress(appId, undefined)
      setSessionPlatform(appId, native)
      return native === 'android' ? decideAndroid(facts, deps) : decideIos(facts, deps)
    }
    // 'go-back' rewinds (the reducer cleared appId/fetch-signing): just resume,
    // which routes back to the app picker. No special intercept needed.
    // The build hand-off choice is resolved separately (persist + route/finish).
    if (step === 'handoff-build')
      return appflowHandoff(facts, deps, progress, input)
    step = appflowFlow.resumeStep(progress)
  }

  for (let i = 0; i < MAX_AUTO_STEPS; i++) {
    const view = appflowFlow.viewForStep(step, progress, ctx)
    if (view.kind !== 'auto') {
      // The build hand-off choice is resolved by appflowHandoff (persist creds +
      // route to build / finish) when the user answers it; until then it renders
      // as an ordinary choice.
      if (step === 'handoff-build')
        return appflowHandoff(facts, deps, progress, input)
      setAppflowProgress(appId, progress)
      return renderAppflowView(step, view)
    }
    // Auto step → run the effect, persist, and continue the loop from `next`.
    let result: AppflowEffectResult
    try {
      result = (await appflowFlow.runEffect(step, progress, flowDeps)) as AppflowEffectResult
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAppflowProgress(appId, progress)
      return {
        onboarding: 'capgo-builder', phase: APPFLOW_PHASE, state: `appflow-${step}`, platform: undefined,
        progress: appflowProgressFor(step), kind: 'error',
        summary: `Appflow migration error at "${step}": ${sanitizeForSummary(message)}. If this persists, email ${SUPPORT_EMAIL}.`,
        rules: ONBOARDING_RULES,
      }
    }
    progress = result.progress
    // Thread this auto effect's transient (option lists / results) into the next
    // step's ctx so the interactive step it transitions to renders real options.
    ctx = result.transient ?? {}
    setAppflowProgress(appId, progress)
    if (!result.next)
      break
    step = result.next
  }

  // Landed on (or looped to) the build hand-off after the auto chain.
  if (step === 'handoff-build')
    return appflowHandoff(facts, deps, progress, input)
  // Fallback: render whatever interactive step we ended on (with the last auto
  // effect's transient as ctx so option lists survive).
  setAppflowProgress(appId, progress)
  return renderAppflowView(step, appflowFlow.viewForStep(step, progress, ctx))
}

/**
 * Resolve the build hand-off: when the user answers the handoff-build choice,
 * persist the migrated creds and either route into the build phase ('build') or
 * finish ('skip'). Without an answer yet, render the choice.
 */
async function appflowHandoff(
  facts: PreflightFacts,
  deps: EngineDeps,
  progress: AppflowProgress,
  input?: OnboardingInput,
): Promise<NextStepResult> {
  const appId = facts.appId!
  const targets = platformsToBuild(progress)
  if (!input || input.value === undefined) {
    setAppflowProgress(appId, progress)
    return renderAppflowView('handoff-build', appflowFlow.viewForStep('handoff-build', progress))
  }
  // Only 'build' or 'skip' are valid choices. Re-present the gate for any other
  // value rather than silently falling through to the build path (which would
  // persist credentials + advance as if the user picked 'build').
  if (input.value !== 'build' && input.value !== 'skip') {
    setAppflowProgress(appId, progress)
    return renderAppflowView('handoff-build', appflowFlow.viewForStep('handoff-build', progress))
  }
  // Persist the migrated per-platform creds into the real store before anything
  // downstream reads them (so a build / `build request` sees them). A persist
  // FAILURE is surfaced loudly — we must NOT report "migration complete" when the
  // credentials never reached the store.
  try {
    await persistAppflowCredentials(appId, progress)
  }
  catch (err) {
    setAppflowProgress(appId, progress)
    return {
      onboarding: 'capgo-builder', phase: APPFLOW_PHASE, state: 'appflow-handoff-build', platform: undefined,
      progress: appflowProgressFor('handoff-build'), kind: 'error',
      summary: `Appflow migration could not save the imported credentials for "${appId}": ${sanitizeForSummary(err instanceof Error ? err.message : String(err))}. Nothing was persisted — re-run the migration, or email ${SUPPORT_EMAIL}.`,
      rules: ONBOARDING_RULES,
    }
  }
  if (input.value === 'skip') {
    setAppflowProgress(appId, undefined)
    return {
      onboarding: 'capgo-builder', phase: 'done', state: 'appflow-done', progress: 100, kind: 'done',
      summary: `Appflow migration complete for "${appId}". Imported credentials for: ${targets.join(', ') || 'no platforms'}. Start your first cloud build anytime with \`capgo build request\`.`,
      rules: ONBOARDING_RULES,
    }
  }
  const first = targets[0]
  if (!first) {
    setAppflowProgress(appId, undefined)
    return {
      onboarding: 'capgo-builder', phase: 'done', state: 'appflow-done', progress: 100, kind: 'done',
      summary: `Appflow migration finished for "${appId}", but no platform credentials were imported. Re-run onboarding or email ${SUPPORT_EMAIL} if you expected credentials.`,
      rules: ONBOARDING_RULES,
    }
  }
  // Single-platform migration: commit the session to the migrated platform and
  // enter the build phase. The first build is run by start_capgo_build, exactly
  // like the native flows.
  setAppflowProgress(appId, undefined)
  setSessionPlatform(appId, first)
  return {
    onboarding: 'capgo-builder', phase: 'build', state: 'build-ready', platform: first, progress: 90, kind: 'choice',
    summary: `Credentials imported from Appflow for ${first}. Run the first cloud build for ${first} now?`,
    options: [
      { value: 'build', label: `Build ${first} now` },
      { value: 'skip', label: 'Skip (build later with `capgo build request`)' },
    ],
    next: {
      tool: 'start_capgo_build',
      with: { platform: first },
      instruction: `To build, call start_capgo_build({ platform: "${first}" }) and then poll capgo_build_wait. To skip, call ${NEXT_STEP_TOOL}({ runBuild: false, platform: "${first}" }).`,
      call: `start_capgo_build({ platform: "${first}" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

export async function decideAndroid(
  facts: PreflightFacts,
  deps: EngineDeps,
  opts?: {
    signInProceed?: boolean
    /** Drop any in-flight Google OAuth session and (re)open the browser for a fresh
     *  sign-in — recovery for "still waiting" when the browser never opened / was closed. */
    reopenSignIn?: boolean
    /** At google-sign-in: open the broker sign-in link in the user's browser (vs. letting them open it). */
    openSignInBrowser?: boolean
    /** The confirmation code the user reads off the broker success page — released the token on the next poll. */
    confirmCode?: string
    /**
     * S9-S11: the explicit tail step a validated tail answer routed to
     * (drive() → applyMcpTailAnswer). Honored only while the slim tail
     * progress carries credentialsSaved — the same guard as the tail park.
     */
    tailNext?: AndroidOnboardingStep
  },
): Promise<NextStepResult> {
  const appId = facts.appId!

  // Seed empty progress when the user first enters the Android flow (null progress
  // means no prior run). getAndroidResumeStep(null) returns 'welcome' which is a
  // bootstrap-only step that the loop cannot drive; seeding an empty progress object
  // makes getAndroidResumeStep return 'keystore-method-select' — the correct first
  // interactive step. This mirrors how the Ink wizard begins.
  let progress: import('../android/types.js').AndroidOnboardingProgress = facts.androidProgress ?? {
    platform: 'android' as const,
    appId,
    startedAt: new Date().toISOString(),
    completedSteps: {},
  }
  // Record that the android flow is now active so a subsequent next_step that
  // omits `platform` resumes android instead of bouncing to platform-select.
  // Persist immediately because the first interactive step returns before the
  // loop ever saves (so the NEXT call must already see the marker).
  if (!progress.activePlatform) {
    progress = { ...progress, activePlatform: 'android' }
    await deps.androidEffectDeps.saveAndroidProgress(appId, progress)
  }

  // ── Data-safety gate (mirrors main's welcome-effect L1005) ────────────────
  // When saved android credentials already exist for this app AND the user is
  // about to enter the keystore phase fresh (no keystore progress yet) AND the
  // gate has not been evaluated, route through `credentials-exist` (backup-or-
  // cancel) before anything can overwrite the saved credentials. Encode the
  // decision in `_credentialsExistGate` so the stateless engine reproduces it on
  // every subsequent call. Only fires on a truly fresh keystore entry, so an
  // in-flight onboarding (and the e2e happy path, which has no saved creds) is
  // unaffected.
  if (
    progress._credentialsExistGate === undefined
    && getAndroidResumeStep(progress) === 'keystore-method-select'
  ) {
    let hasSavedAndroid = false
    try {
      const saved = await deps.androidEffectDeps.loadSavedCredentials(appId)
      hasSavedAndroid = !!(saved && typeof saved === 'object' && (saved as { android?: unknown }).android)
    }
    catch {
      // Treat a load failure as "no saved credentials" — never block onboarding
      // on a read error; the worst case is the pre-existing (no-gate) behavior.
      hasSavedAndroid = false
    }
    if (hasSavedAndroid) {
      progress = { ...progress, _credentialsExistGate: 'pending' }
      await deps.androidEffectDeps.saveAndroidProgress(appId, progress)
    }
  }

  // 'cancel' is a hard stop: the user declined to back up existing credentials,
  // so onboarding halts to protect them (mirrors main's exitOnboarding()).
  if (progress._credentialsExistGate === 'cancel') {
    return {
      onboarding: 'capgo-builder', phase: 'credentials', state: 'credentials-exist', platform: 'android',
      progress: ANDROID_STEP_PROGRESS['credentials-exist'], kind: 'done',
      summary: `Onboarding stopped to protect the existing Android credentials for "${appId}". Nothing was changed. Re-run onboarding and choose "Start fresh (backup existing credentials first)" when you're ready to replace them.`,
      rules: ONBOARDING_RULES,
    }
  }

  let ctx: AndroidStepCtx = { appId }
  // When an effect signals an explicit next step (e.g. gcp-projects-loading → gcp-projects-select),
  // use that instead of re-deriving from progress on the next iteration.
  // S9-S11: a validated tail answer routes its explicit next step in (the same
  // guard as the tail park: only while the slim tail progress is in flight).
  let forcedNextStep: AndroidOnboardingStep | undefined
    = opts?.tailNext && progress.completedSteps?.credentialsSaved ? opts.tailNext : undefined
  // Track whether we've already written the .p12 file this invocation so we only write once.
  let keystoreFileWritten = false

  for (let i = 0; i < MAX_AUTO_STEPS; i++) {
    // The parked interactive TAIL step (S9-S11) overrides resume derivation —
    // a re-render must re-ask the parked question, never drift forward through
    // the resume router (which collapses past the preview consent gate).
    const step = forcedNextStep
      ?? (mcpTailParkedStep(appId, progress) as AndroidOnboardingStep | null)
      ?? getAndroidResumeStep(progress)
    forcedNextStep = undefined

    if (step === 'google-sign-in') {
      // ── Broker-backed Google sign-in (MCP-only) ─────────────────────────────
      // The MCP process dies between tool calls, so an in-flight loopback consent can't survive. The Capgo
      // OAuth broker holds the sign-in server-side: we create a session, show the user the sign-in link (and
      // can open it for them), then poll — the user reads back a confirmation code from the success page —
      // until a short-lived Google access token is handed off. The handle lives on disk, so polling resumes
      // across a restart. The interactive TUI keeps its own loopback flow (untouched).
      const session = deps.oauthSession ?? { begin: brokerBegin, poll: brokerPoll, clear: brokerClear }
      const baseGate = {
        onboarding: 'capgo-builder' as const, phase: 'credentials' as const, state: 'google-sign-in' as const,
        platform: 'android' as const, progress: ANDROID_STEP_PROGRESS['google-sign-in'], kind: 'human_gate' as const,
        rules: ONBOARDING_RULES,
      }

      // First gate — not yet proceeding: offer to start. No broker session/link exists until the user continues.
      if (!opts?.signInProceed) {
        return {
          ...baseGate,
          summary: `Next: connect your Google account so Capgo can set up Play Console publishing (Google Play + Google Cloud access). Tell me to continue and I'll create your sign-in link.`,
          human: { instruction: `We'll connect your Google account to provision Play Console access. When you tell me to continue I'll create a sign-in link — I can open it in your browser for you, or give you the link to open yourself.` },
          next: { tool: NEXT_STEP_TOOL, instruction: `STOP here and tell the user you'll connect their Google account for Play Console access. WAIT for their reply — do NOT call ${NEXT_STEP_TOOL} yet. Only once they tell you to continue, call ${NEXT_STEP_TOOL}({}) to create the sign-in link.`, call: `${NEXT_STEP_TOOL}({})` },
        }
      }

      if (opts?.reopenSignIn)
        await session.clear(appId)

      let poll = await session.poll(appId, opts?.confirmCode)
      let justBegan = false
      if (poll.status === 'absent') {
        try {
          const begun = await session.begin(appId)
          poll = { status: 'pending', signInUrl: begun.signInUrl }
          justBegan = true
        }
        catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          await session.clear(appId)
          return {
            ...baseGate,
            summary: `Google sign-in could not start (${reason}). Tell me to continue to try again.`,
            human: { instruction: `The Google sign-in could not start (${reason}). Tell me to continue and I'll try again.` },
            next: { tool: NEXT_STEP_TOOL, instruction: `Tell the user the sign-in could not start and STOP — do NOT call ${NEXT_STEP_TOOL} on your own. Only when they ask to try again, call ${NEXT_STEP_TOOL}({}).`, call: `${NEXT_STEP_TOOL}({})` },
          }
        }
      }

      const signInUrl = poll.signInUrl ?? ''

      // Open the link in the user's browser when asked (best effort — fall back to showing the link).
      let openedNow = false
      if (opts?.openSignInBrowser && signInUrl && deps.androidEffectDeps.openBrowser) {
        try {
          await deps.androidEffectDeps.openBrowser(signInUrl)
          openedNow = true
        }
        catch {
          openedNow = false
        }
      }

      if (poll.status === 'pending') {
        if (openedNow) {
          return {
            ...baseGate,
            summary: `I opened the Google sign-in page in your browser. Approve the permissions; you'll then see a confirmation code — read it back to me.`,
            human: { instruction: `Your browser should now show the Google sign-in. Approve every requested permission. When it finishes you'll see a confirmation code (like "ABCD-2345") — tell me that code. If the browser didn't open, the link is: ${signInUrl}` },
            next: { tool: NEXT_STEP_TOOL, instruction: `Tell the user you opened the sign-in page, then STOP and WAIT — do NOT call ${NEXT_STEP_TOOL} before they respond. When they read back the confirmation code, call ${NEXT_STEP_TOOL}({ confirmCode: "<code>" }). If they say they finished or cancelled but have no code, call ${NEXT_STEP_TOOL}({}) to check the status.`, call: `${NEXT_STEP_TOOL}({ confirmCode: "ABCD-2345" })` },
          }
        }
        if (justBegan) {
          return {
            ...baseGate,
            summary: `Open this link to sign in with Google: ${signInUrl} — or tell me to open it in your browser for you.`,
            human: { instruction: `Give the user this Google sign-in link so they can open it: ${signInUrl}\nYou can also open it for them. After they sign in they'll see a confirmation code (like "ABCD-2345") to read back to you.` },
            next: { tool: NEXT_STEP_TOOL, instruction: `Show the user the sign-in link, then STOP and WAIT for their reply — do NOT call ${NEXT_STEP_TOOL} before they respond. If they ask you to open it for them, call ${NEXT_STEP_TOOL}({ openSignInBrowser: true }). When they read back the confirmation code, call ${NEXT_STEP_TOOL}({ confirmCode: "<code>" }). If they say they finished or hit a problem signing in, call ${NEXT_STEP_TOOL}({}) to check the status.`, call: `${NEXT_STEP_TOOL}({ openSignInBrowser: true })` },
          }
        }
        return {
          ...baseGate,
          summary: `Still waiting on your Google sign-in. Finish it in the browser, then tell me the confirmation code shown. Sign-in link: ${signInUrl}`,
          human: { instruction: `The Google sign-in isn't complete yet. Open the link if you haven't (${signInUrl}), approve the permissions, and tell me the confirmation code you see. If you're stuck, tell me to reopen the sign-in.` },
          next: { tool: NEXT_STEP_TOOL, instruction: `STOP and WAIT for the user — do NOT call ${NEXT_STEP_TOOL} on your own. When the user reads back the confirmation code, call ${NEXT_STEP_TOOL}({ confirmCode: "<code>" }). If they ask to start over, call ${NEXT_STEP_TOOL}({ reopenSignIn: true }).`, call: `${NEXT_STEP_TOOL}({ confirmCode: "ABCD-2345" })` },
        }
      }

      if (poll.status === 'awaiting_code') {
        const wrong = poll.error ? ` That code didn't match (${poll.error}) — double-check it and try again.` : ''
        return {
          ...baseGate,
          summary: `You're signed in — now enter the confirmation code shown on the sign-in page.${wrong}`,
          human: { instruction: `Your browser shows a confirmation code (like "ABCD-2345"). Read it back to me to finish connecting your Google account.${wrong}` },
          next: { tool: NEXT_STEP_TOOL, instruction: `Ask the user for the confirmation code shown in their browser and WAIT — do NOT call ${NEXT_STEP_TOOL} on your own. Only when they give you the code, call ${NEXT_STEP_TOOL}({ confirmCode: "<the code>" }).`, call: `${NEXT_STEP_TOOL}({ confirmCode: "ABCD-2345" })` },
        }
      }

      if (poll.status === 'error') {
        const reason = poll.error ?? 'unknown error'
        await session.clear(appId)
        return {
          ...baseGate,
          summary: `Google sign-in did not complete (${reason}). Tell me to continue to try again.`,
          human: { instruction: `The Google sign-in did not complete (${reason}). Tell me to continue and I'll start a fresh sign-in.` },
          next: { tool: NEXT_STEP_TOOL, instruction: `Tell the user the sign-in did not complete and STOP — do NOT call ${NEXT_STEP_TOOL} on your own. Only when they ask to try again, call ${NEXT_STEP_TOOL}({}) to start a fresh sign-in.`, call: `${NEXT_STEP_TOOL}({})` },
        }
      }

      // done — a short-lived access token + its expiry. Persist it immediately: the broker hard-deletes the
      // session on handoff, so we can't re-poll. The account-info fetch is cosmetic (the token, not the email,
      // drives provisioning), so a transient failure there must NOT force a re-sign-in.
      const accessToken = poll.accessToken!
      let info: GoogleUserInfo = { sub: '', email: '', emailVerified: false }
      try {
        info = await deps.androidEffectDeps.fetchUserInfo(accessToken)
      }
      catch {
        // Non-fatal — keep the empty info; provisioning uses the access token, not the email.
      }
      progress = applyGoogleSignInBroker(progress, accessToken, poll.expiresAt ?? null, info)
      await deps.androidEffectDeps.saveAndroidProgress(appId, progress)
      await session.clear(appId)
      continue
    }

    // ask-build is the post-save entry point for the Ink driver's build-choice sub-flow.
    // The MCP bridge maps this to the shared build-ready choice (decideBuildPhase).
    if (step === 'ask-build')
      return decideBuildPhase(facts, 'android')

    // ── S8: post-save tail terminal ──────────────────────────────────────────
    // 'build-complete' ends the shared tail. Drop the slim tail progress
    // (mirroring the TUI, which never keeps post-save state on disk) and clear
    // the session so a later onboarding starts fresh — the credentials-exist
    // gate re-protects the saved credentials. NEVER decideBuildPhase here: the
    // build already happened (buildRequested).
    if (step === 'build-complete') {
      // Harvest the outcome facts BEFORE the cleanup wipes the session.
      const outcomes = harvestTailOutcomes(appId, Boolean(progress?.completedSteps?.ciSecretsUploaded))
      try {
        await deps.androidEffectDeps.deleteAndroidProgress(appId)
      }
      catch {
        // Best-effort cleanup — a stale slim file only re-renders this terminal.
      }
      clearSession(appId)
      return tailCompleteResult(appId, 'android', outcomes)
    }

    // ── S9-S11: interactive tail steps render structurally (and park) ────────
    // Includes ci-secrets-setup, whose TAIL_KIND is 'auto' but which has NO
    // effect in runTailEffect — it is the retry/skip screen shown when no
    // git-hosting CLI is ready. The view context is the invocation-local ctx
    // (the effect transients accumulated this call) overlaid on the previously
    // parked inventories.
    if (MCP_TAIL_INTERACTIVE_STEPS.has(step)) {
      return renderTailStep('android', appId, step, progress, ctx as unknown as Record<string, unknown>, {
        defaultExportPath: deps.androidEffectDeps.defaultExportPath,
        generateWorkflow: deps.androidEffectDeps.generateWorkflow,
        detectPackageManager: deps.androidEffectDeps.detectPackageManager,
      })
    }

    // keystore-new-cn: the Ink wizard advances to keystore-generating immediately
    // after the CN input is submitted (persistAndStep sets step:'keystore-generating'
    // directly). getAndroidResumeStep cannot detect this transition on its own
    // because there is no dedicated "cn collected" marker — CN is the last input
    // before the auto effect. When CN is already in progress, force the next step.
    if (step === 'keystore-new-cn' && progress.keystoreCommonName !== undefined) {
      forcedNextStep = 'keystore-generating'
      continue
    }

    const view = androidViewForStep(step, progress, ctx)

    // keystore-existing-key-password has kind:'input' in KIND_TABLE but it also has
    // an auto-probe component: the effect first tries to unlock the key with the store
    // password. Only if that fails does it return needsKeyPasswordPrompt:true and the
    // driver shows the manual input. Run it as auto here (same as the Ink driver's
    // useEffect probe) so the probe path works without requiring a redundant user turn.
    const isKeyPasswordProbeStep = step === 'keystore-existing-key-password' && !progress.keystoreKeyPassword

    if (view.kind !== 'auto' && !isKeyPasswordProbeStep) {
      if (view.kind === 'done')
        return decideBuildPhase(facts, 'android')

      // When we reach service-account-method-select (the first step after the keystore
      // phase), write the .p12 file exactly once so the user has a local copy.
      // Guard: only when keystoreReady + _keystoreBase64 are both present and the file
      // has not yet been written this invocation.
      if (
        step === 'service-account-method-select'
        && !keystoreFileWritten
        && progress.completedSteps?.keystoreReady
        && progress._keystoreBase64
        && deps.writeKeystoreFile
      ) {
        const alias = progress.keystoreAlias ?? progress.completedSteps.keystoreReady.alias ?? 'release'
        try {
          const writtenPath = await deps.writeKeystoreFile(appId, progress._keystoreBase64, alias)
          ctx = {
            ...ctx,
            _keystoreWrittenPath: writtenPath,
            // Surface the password ONLY when it was auto-generated (random method) —
            // the user has not seen it. Manual passwords are never echoed back.
            ...(progress.keystorePasswordGenerated && progress.keystoreStorePassword
              ? { _keystoreWrittenPassword: progress.keystoreStorePassword }
              : {}),
          } as AndroidStepCtx & { _keystoreWrittenPath: string, _keystoreWrittenPassword?: string }
          // Re-read the view with the path set so mapAndroidView gets it right below.
        }
        catch {
          // Non-fatal: keystore data is safe in progress.
        }
      }

      // Pass keystorePath through to service-account-method-select so the result
      // carries context.keystorePath when the keystore was just written to disk.
      const writeCtx = ctx as AndroidStepCtx & { _keystoreWrittenPath?: string, _keystoreWrittenPassword?: string }
      const keystorePath = writeCtx._keystoreWrittenPath
      const keystorePassword = writeCtx._keystoreWrittenPassword
      return mapAndroidView(view, facts, keystorePath ? { keystorePath, ...(keystorePassword ? { keystorePassword } : {}) } : undefined)
    }

    try {
      const isTailEffectStep = MCP_TAIL_EFFECT_STEPS.has(step)
      // S8 restart fallback: re-derive the process-local tail carried from the
      // saved credential store before a post-restart tail effect consumes it
      // (see the matching decideIos comment).
      if (isTailEffectStep && step !== 'saving-credentials' && progress.completedSteps?.credentialsSaved)
        await rederiveTailCarried(appId, 'android', deps.androidEffectDeps)
      // Tail effects read the driver-held carried transients; the MCP parks
      // them in the session registry between tool calls (the headless mirror
      // of the Ink TUI's React tail state).
      const effectDeps = isTailEffectStep
        ? { ...deps.androidEffectDeps, carried: { ...getSession(appId).tailCarried } }
        : deps.androidEffectDeps
      const r = await runAndroidEffect(step, progress, effectDeps)
      progress = r.progress
      const transient = r.transient ?? {}
      ctx = { ...ctx, ...transient }

      // ── S8: MCP tail persistence (slim + secret-free) + carried registry ──
      // Mirrors the decideIos block: the MCP driver owns marker persistence
      // (android/types.ts) via the WHITELISTING slim writer; tail transients
      // park in the session's tailCarried.
      if (isTailEffectStep) {
        mergeTailCarried(appId, {
          savedCredentials: transient.savedCredentials,
          ciSecretEntries: transient.ciSecretEntries,
          ciSecretExistingKeys: transient.ciSecretExistingKeys,
          // NON-SECRET outcome facts (counts/labels/paths only) — parked so
          // harvestTailOutcomes can surface them on the terminal build-complete.
          ciSecretUploadSummary: transient.ciSecretUploadSummary,
          workflowFilePath: transient.workflowFilePath,
          envExportPath: transient.envExportPath,
        })
        if (step === 'saving-credentials' && r.next === 'ask-build') {
          progress = slimAndroidTailProgress({
            ...progress,
            completedSteps: { ...progress.completedSteps, credentialsSaved: { savedAt: new Date().toISOString() } },
          })
          await deps.androidEffectDeps.saveAndroidProgress(appId, progress)
        }
        else if (progress.completedSteps?.credentialsSaved) {
          if (step === 'uploading-ci-secrets') {
            // Marker immediately after the successful upload — resume must
            // never re-fire the already-completed upload.
            progress = {
              ...progress,
              completedSteps: {
                ...progress.completedSteps,
                ciSecretsUploaded: {
                  provider: progress.ciSecretTarget?.provider ?? 'github',
                  count: getSession(appId).tailCarried.ciSecretEntries?.length ?? 0,
                },
              },
            }
          }
          progress = slimAndroidTailProgress(progress)
          await deps.androidEffectDeps.saveAndroidProgress(appId, progress)
        }
      }

      // ── Transient handling (mirrors the Ink driver's logic) ─────────────────
      //
      // keystore-existing-detecting-alias → wrongPassword:
      //   Re-prompt for the store password (do NOT advance).
      //   The progress already has keystoreExistingPath; clear the stale password so
      //   the next submission goes through detecting-alias fresh.
      if (transient.wrongPassword) {
        const view = androidViewForStep('keystore-existing-store-password', progress, ctx)
        return mapAndroidView(view, facts)
      }

      // keystore-existing-key-password (probe) → needsKeyPasswordPrompt:
      //   The effect could not auto-resolve the key password.
      //   Map the step as a human_gate so the user can supply it.
      if (transient.needsKeyPasswordPrompt) {
        const view = androidViewForStep('keystore-existing-key-password', progress, ctx)
        return mapAndroidView(view, facts)
      }

      // Respect explicit next from the effect (e.g. gcp-projects-loading → gcp-projects-select).
      if (r.next) {
        forcedNextStep = r.next
      }

      // ── Write .p12 once when the keystore phase just completed ──────────────
      // Detect transition: progress now has keystoreReady + _keystoreBase64 and we
      // haven't written the file yet. Write it and carry the path forward.
      if (
        !keystoreFileWritten
        && progress.completedSteps?.keystoreReady
        && progress._keystoreBase64
        && deps.writeKeystoreFile
      ) {
        keystoreFileWritten = true
        const alias = progress.keystoreAlias ?? progress.completedSteps.keystoreReady.alias ?? 'release'
        try {
          const writtenPath = await deps.writeKeystoreFile(appId, progress._keystoreBase64, alias)
          // Stash path (and the auto-generated password, if any) so the
          // service-account-method-select result can expose them.
          ctx = {
            ...ctx,
            _keystoreWrittenPath: writtenPath,
            ...(progress.keystorePasswordGenerated && progress.keystoreStorePassword
              ? { _keystoreWrittenPassword: progress.keystoreStorePassword }
              : {}),
          } as AndroidStepCtx & { _keystoreWrittenPath: string, _keystoreWrittenPassword?: string }
        }
        catch {
          // Non-fatal: the keystore data is safe in progress; the file write is best-effort.
        }
      }
    }
    catch (err) {
      return androidEffectError(step, err, facts)
    }
  }

  return {
    onboarding: 'capgo-builder', phase: 'credentials', state: 'android-auto-loop-guard', platform: 'android', progress: 0, kind: 'error',
    summary: 'Android onboarding stalled (too many automatic steps without progress). Please retry or run `capgo doctor`.',
    rules: ONBOARDING_RULES,
  }
}

function decideBuildPhase(facts: PreflightFacts, platform: Platform): NextStepResult {
  return {
    onboarding: 'capgo-builder', phase: 'build', state: 'build-ready', platform, progress: 90, kind: 'choice',
    summary: `Credentials for "${facts.appId}" (${platform}) are saved. Run your first cloud build now?`,
    options: [
      { value: 'build', label: 'Run the first build now' },
      { value: 'skip', label: 'Skip — I will build later' },
    ],
    next: {
      tool: 'start_capgo_build',
      with: { platform },
      instruction: `Ask the user. To build now: start_capgo_build({ platform: "${platform}" }). To skip (onboarding still completes): next_step({ runBuild: false, platform: "${platform}" }).`,
      call: `start_capgo_build({ platform: "${platform}" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

// ─── S8: MCP-driven post-save tail ────────────────────────────────────────────
//
// The step ids whose EFFECT both platform flows delegate to the shared tail
// (mirrors the private TAIL_EFFECT_STEPS sets in ios/flow.ts + android/flow.ts).
// For these the MCP driver: threads the session's tailCarried into the effect,
// captures the tail transients back into it, and persists the SLIM secret-free
// tail progress (markers + prefs — see mcp/tail-progress.ts). 'requesting-build'
// is listed for completeness but never runs here — the MCP build path is the
// unchanged C2/D2 handoff + checkBuild polling.
const MCP_TAIL_EFFECT_STEPS = new Set<string>([
  'saving-credentials',
  'detecting-ci-secrets',
  'checking-ci-secrets',
  'uploading-ci-secrets',
  'exporting-env',
  'overwrite-and-export-env',
  'writing-workflow-file',
  'requesting-build',
])

/**
 * The tail's terminal screen — onboarding is fully complete (post-build).
 * Mirrors the TUI's build-complete screen, which SURFACES what the tail did
 * (CI upload summary, workflow path, .env path) — without it the conducting
 * agent has no tool-result evidence for claims like "secrets uploaded" (the
 * live Codex judge correctly failed exactly that). Outcome strings carry
 * counts/labels/paths only — never secret values.
 */
function tailCompleteResult(
  appId: string,
  platform: Platform,
  outcomes: { uploadSummary?: string, workflowPath?: string, envExportPath?: string } = {},
): NextStepResult {
  const done: string[] = []
  if (outcomes.uploadSummary)
    done.push(outcomes.uploadSummary)
  if (outcomes.workflowPath)
    done.push(`GitHub Actions workflow written: ${outcomes.workflowPath}`)
  if (outcomes.envExportPath)
    done.push(`Build env vars exported to ${outcomes.envExportPath} (file mode 0600 — do not commit it).`)
  const outcomeText = done.length > 0 ? ` ${done.join(' ')}` : ''
  return {
    onboarding: 'capgo-builder', phase: 'done', state: 'build-complete', platform, progress: 100, kind: 'done',
    summary: `Capgo Builder onboarding for "${appId}" (${platform}) is complete — credentials are saved and your first cloud build went through.${outcomeText} Run \`npx @capgo/cli@latest build request --platform ${platform}\` anytime for new builds.`,
    rules: ONBOARDING_RULES,
  }
}

/**
 * Harvest the tail outcome facts for the terminal summary BEFORE the session
 * is cleared. Session transients (exact upload summary / written paths) win;
 * the durable ciSecretsUploaded marker provides a generic line when a server
 * restart lost the session.
 */
function harvestTailOutcomes(appId: string, ciSecretsUploaded: boolean): { uploadSummary?: string, workflowPath?: string, envExportPath?: string } {
  const tail = getSession(appId).tailCarried as Record<string, unknown>
  const uploadSummary = typeof tail.ciSecretUploadSummary === 'string'
    ? tail.ciSecretUploadSummary
    : (ciSecretsUploaded ? 'The build env vars were uploaded to your CI secrets.' : undefined)
  return {
    ...(uploadSummary ? { uploadSummary } : {}),
    ...(typeof tail.workflowFilePath === 'string' ? { workflowPath: tail.workflowFilePath } : {}),
    ...(typeof tail.envExportPath === 'string' ? { envExportPath: tail.envExportPath } : {}),
  }
}

/**
 * S8 restart fallback: rebuild the process-local tail carried
 * (savedCredentials + ciSecretEntries) after a server restart lost the session
 * registry. loadSavedCredentials() returns the exact platform map
 * saving-credentials wrote; the driver-pre-bound createCiSecretEntries folds
 * the resolved Capgo key back in (CAPGO_TOKEN). The rebuilt values live ONLY
 * in the session registry — never in progress.json or tool results. Degrades
 * silently on any read error (the shared tail then falls back to its own
 * lossy rebuildTailCredentials).
 */
async function rederiveTailCarried(
  appId: string,
  platform: Platform,
  deps: {
    loadSavedCredentials?: (appId: string) => Promise<unknown>
    createCiSecretEntries?: (credentials: Record<string, string>, apiKey?: string) => import('../ci-secrets.js').CiSecretEntry[]
  },
): Promise<void> {
  const tail = getSession(appId).tailCarried
  if (tail.savedCredentials && tail.ciSecretEntries)
    return
  let creds: Record<string, string> | undefined
  try {
    const saved = await deps.loadSavedCredentials?.(appId)
    const platformCreds = (saved as Record<string, unknown> | null | undefined)?.[platform]
    if (platformCreds && typeof platformCreds === 'object')
      creds = platformCreds as Record<string, string>
  }
  catch {
    // Treat a load failure as "nothing to re-derive" — never block the tail.
  }
  if (!creds)
    return
  mergeTailCarried(appId, {
    ...(tail.savedCredentials ? {} : { savedCredentials: creds }),
    ...(tail.ciSecretEntries || !deps.createCiSecretEntries ? {} : { ciSecretEntries: deps.createCiSecretEntries(creds) }),
  })
}

// ─── S9-S11: structured tail steps (CI secrets / GH Actions / env / workflow) ─
//
// Every INTERACTIVE tail step renders as a structured MCP state with its own
// answer field (the schema's tail family fields) instead of the S8 generic
// "later milestone" choice. The vocabulary is tail/flow.ts's — tailViewForStep
// builds the options, applyTailInput records the prefs, and the answer routing
// below mirrors the android TUI's onChange handlers step-for-step
// (android/ui/app.tsx ~L3062-3470), so the MCP and the TUI cannot drift.
//
// PARKING: the MCP mirrors the TUI's React `step` state in the session's
// tailParked (session-state.ts) — set on every interactive tail render,
// consumed by the strict tail gate + the decide loops, cleared when the answer
// is applied. Without it a re-render would drift forward through the resume
// router and collapse past consent gates (preview-workflow-file →
// writing-workflow-file). A server restart loses the park; the frozen
// tailResumeStep contract then takes over.

/** The interactive tail steps the MCP renders structurally (and parks on). */
const MCP_TAIL_INTERACTIVE_STEPS = new Set<string>([
  'ci-secrets-setup',
  'ci-secrets-target-select',
  'ask-ci-secrets',
  'confirm-ci-secret-overwrite',
  'confirm-secrets-push',
  'ci-secrets-failed',
  'ask-github-actions-setup',
  'ask-export-env',
  'confirm-env-export-overwrite',
  'pick-package-manager',
  'pick-build-script',
  'pick-build-script-custom',
  'preview-workflow-file',
])

/**
 * The session-parked interactive tail step, if any. Only honored while the
 * slim tail progress proves the tail is actually in flight (credentialsSaved)
 * — a stale park from an abandoned run can never hijack a fresh onboarding.
 */
function mcpTailParkedStep(appId: string, progress: { completedSteps?: { credentialsSaved?: unknown } } | null): string | null {
  if (!progress?.completedSteps?.credentialsSaved)
    return null
  const parked = getSession(appId).tailParked
  if (parked && MCP_TAIL_INTERACTIVE_STEPS.has(parked.step))
    return parked.step
  return null
}

/**
 * Apply a validated tail answer: record the pref via the shared applyTailInput
 * reducer (the exact TUI write) and resolve the explicit next step from the
 * android TUI's onChange routing (app.tsx ~L3062-3470 — the [DIVERGE]
 * driver-routed branches are reproduced verbatim; the engine-derived [MATCH]
 * branches land on the same step the resume router would pick). Returns the
 * (possibly) updated progress and the forced next step.
 */
function applyMcpTailAnswer<P extends TailEffectProgress>(
  step: string,
  input: OnboardingInput,
  progress: P,
  parked: TailParkedState | undefined,
): { progress: P, next: string } {
  switch (step) {
    // retry re-runs the read-only detection; skip ends the tail.
    case 'ci-secrets-setup':
      return { progress, next: input.ciSecretAction === 'retry' ? 'detecting-ci-secrets' : 'build-complete' }

    case 'ci-secrets-target-select': {
      if (input.ciSecretAction === 'skip')
        return { progress, next: 'build-complete' }
      const target = (parked?.ciSecretTargets ?? []).find(t => t.provider === input.ciSecretAction) ?? null
      if (!target) {
        // Park lost (restart) — self-heal through the idempotent re-detection
        // instead of fabricating a target the discovery never produced.
        return { progress, next: 'detecting-ci-secrets' }
      }
      const next = applyTailInput('ci-secrets-target-select', progress, { step: 'ci-secrets-target-select', ciSecretTarget: target })
      // TUI fan-out: github → the 3-option GH Actions prompt; gitlab → the
      // legacy 2-option ask-ci-secrets flow.
      return { progress: next, next: target.provider === 'github' ? 'ask-github-actions-setup' : 'ask-ci-secrets' }
    }

    case 'ask-ci-secrets':
      return { progress, next: input.ciSecretAction === 'yes' ? 'checking-ci-secrets' : 'build-complete' }

    case 'confirm-ci-secret-overwrite':
      return { progress, next: input.ciSecretAction === 'replace' ? 'uploading-ci-secrets' : 'build-complete' }

    case 'confirm-secrets-push':
      return { progress, next: input.ciSecretAction === 'confirm' ? 'uploading-ci-secrets' : 'build-complete' }

    case 'ci-secrets-failed': {
      if (input.ciSecretAction !== 'retry')
        return { progress, next: 'build-complete' }
      // Retry re-checks when a destination is already chosen, else re-detects.
      return { progress, next: progress.ciSecretTarget ? 'checking-ci-secrets' : 'detecting-ci-secrets' }
    }

    case 'ask-github-actions-setup': {
      // applyTailInput maps the user-facing 'no' to the persisted setupMode 'declined';
      // pass the raw answer and route on whether the user declined.
      const declined = input.githubActionsSetup === 'no'
      const next = applyTailInput('ask-github-actions-setup', progress, { step: 'ask-github-actions-setup', value: input.githubActionsSetup! })
      return { progress: next, next: declined ? 'ask-export-env' : 'checking-ci-secrets' }
    }

    case 'ask-export-env': {
      if (input.exportEnvAction !== 'yes')
        return { progress, next: 'build-complete' }
      // Record the custom path when given; otherwise leave it unset — the
      // exporting-env effect falls back to deps.defaultExportPath (the path
      // the prompt surfaced).
      const next = input.envExportPath
        ? applyTailInput('ask-export-env', progress, { step: 'ask-export-env', value: 'yes', envExportTargetPath: input.envExportPath })
        : progress
      return { progress: next, next: 'exporting-env' }
    }

    case 'confirm-env-export-overwrite':
      return { progress, next: input.exportEnvAction === 'replace' ? 'overwrite-and-export-env' : 'build-complete' }

    case 'pick-package-manager': {
      const next = applyTailInput('pick-package-manager', progress, { step: 'pick-package-manager', selectedPackageManager: input.packageManager! })
      return { progress: next, next: 'pick-build-script' }
    }

    case 'pick-build-script': {
      if (input.buildScript === '__custom__')
        return { progress, next: 'pick-build-script-custom' }
      const choice = input.buildScript === '__skip__'
        ? { type: 'skip' as const }
        : { type: 'npm-script' as const, name: input.buildScript! }
      const next = applyTailInput('pick-build-script', progress, { step: 'pick-build-script', buildScriptChoice: choice })
      // TUI parity: the preview CONFIRM gate comes before any file write.
      return { progress: next, next: 'preview-workflow-file' }
    }

    case 'pick-build-script-custom': {
      const next = applyTailInput('pick-build-script-custom', progress, { step: 'pick-build-script-custom', command: input.buildScriptCustom! })
      return { progress: next, next: 'preview-workflow-file' }
    }

    case 'preview-workflow-file': {
      if (input.workflowFileAction === 'write')
        return { progress, next: 'writing-workflow-file' }
      if (input.workflowFileAction === 'view') {
        // 'view' never advances: the preview re-parks with the proposed file
        // text in context (the MCP's flattening of the TUI's fullscreen
        // view-workflow-diff takeover).
        return { progress, next: 'preview-workflow-file' }
      }
      return { progress, next: 'build-complete' }
    }

    default:
      return { progress, next: step }
  }
}

/** The non-secret tail render deps a platform driver hands to renderTailStep. */
interface TailRenderDeps {
  defaultExportPath?: (appId: string, platform: 'ios' | 'android') => string
  generateWorkflow?: IosEffectDeps['generateWorkflow']
  /** Lockfile-based package-manager detection (pick-package-manager's 'recommended' note). */
  detectPackageManager?: () => string
}

/**
 * Map a neutral tail view to the structured MCP result for its step — the
 * tail's mirror of the bespoke cases in mapAndroidView/mapIosView. Options come
 * from tailViewForStep verbatim; `next.with` names the step's answer field;
 * `context` surfaces NAMES/labels only (secret key NAMES, repo label, advice
 * commands, the proposed workflow YAML — never credential values).
 */
function mapTailView(
  step: string,
  platform: Platform,
  appId: string,
  progress: TailEffectProgress,
  viewCtx: TailStepCtx & { ciSecretError?: string, ciSecretExistingKeys?: string[] },
  renderDeps: TailRenderDeps,
): NextStepResult {
  const view = tailViewForStep(step as TailStep, progress, viewCtx)
  const progressValue = (platform === 'android' ? ANDROID_STEP_PROGRESS[step as AndroidOnboardingStep] : STEP_PROGRESS[step as OnboardingStep]) ?? 85
  const options: ChoiceOption[] = (view.options ?? []).map(o => ({ value: o.value, label: o.label, note: o.note }))
  const base = {
    onboarding: 'capgo-builder' as const,
    phase: 'credentials' as const,
    platform,
    state: step,
    progress: progressValue,
    kind: 'choice' as const,
    options,
    rules: ONBOARDING_RULES,
  }
  const entries = getSession(appId).tailCarried.ciSecretEntries ?? []
  const secretKeyNames = entries.map(e => e.key)

  switch (step) {
    case 'ci-secrets-setup': {
      const advice = viewCtx.ciSecretSetupAdvice ?? []
      return {
        ...base,
        summary: `${view.title ?? 'Set up your git hosting CLI to upload env vars'} — the CLI was found but is not ready yet (see context.setupAdvice for the exact commands). Credentials are already saved; this only affects the CI secret upload.`,
        ...(advice.length > 0 ? { context: { setupAdvice: advice } } : {}),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { ciSecretAction: '<retry|skip>' },
          instruction: 'Show the user the setup commands from context.setupAdvice. After they installed/logged in, call next_step with ciSecretAction "retry" to re-detect; or "skip" to finish without uploading.',
          call: `${NEXT_STEP_TOOL}({ ciSecretAction: "retry" })`,
        },
      }
    }

    case 'ci-secrets-target-select':
      return {
        ...base,
        summary: view.prompt ?? 'Where should Capgo upload the build env vars?',
        next: {
          tool: NEXT_STEP_TOOL,
          with: { ciSecretAction: `<${options.map(o => o.value).join('|')}>` },
          instruction: 'Present the detected destinations to the user, then call next_step with ciSecretAction set to the chosen option\'s value ("skip" uploads nothing).',
          call: `${NEXT_STEP_TOOL}({ ciSecretAction: "${options[0]?.value ?? 'skip'}" })`,
        },
      }

    case 'ask-ci-secrets':
      return {
        ...base,
        summary: view.prompt ?? 'Upload the build env vars?',
        context: { secretKeys: secretKeyNames },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { ciSecretAction: '<yes|no>' },
          instruction: 'Ask the user whether to upload the listed env vars (context.secretKeys — names only), then call next_step with ciSecretAction.',
          call: `${NEXT_STEP_TOOL}({ ciSecretAction: "yes" })`,
        },
      }

    case 'confirm-ci-secret-overwrite': {
      const existing = viewCtx.ciSecretExistingKeys ?? []
      return {
        ...base,
        summary: view.prompt ?? 'These env vars already exist and will be replaced:',
        context: { existingKeys: existing },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { ciSecretAction: '<replace|skip>' },
          instruction: 'Show the user the existing env var NAMES (context.existingKeys). Replacing overwrites them irreversibly — ask before proceeding, then call next_step with ciSecretAction.',
          call: `${NEXT_STEP_TOOL}({ ciSecretAction: "replace" })`,
        },
      }
    }

    case 'confirm-secrets-push': {
      const existingSet = new Set(viewCtx.ciSecretExistingKeys ?? [])
      const repo = viewCtx.ciSecretRepoLabel ?? 'the repository'
      return {
        ...base,
        summary: view.prompt ?? `Confirm before pushing secrets to ${repo}`,
        context: {
          repository: repo,
          secretKeys: secretKeyNames.map(key => ({ name: key, status: existingSet.has(key) ? 'REPLACE' : 'NEW' })),
        },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { ciSecretAction: '<confirm|cancel>' },
          instruction: `Show the user the repository (${repo}) and the secret NAMES that will be pushed (context.secretKeys; REPLACE entries overwrite silently and cannot be recovered). Then call next_step with ciSecretAction "confirm" to push, or "cancel".`,
          call: `${NEXT_STEP_TOOL}({ ciSecretAction: "confirm" })`,
        },
      }
    }

    case 'ci-secrets-failed':
      return {
        ...base,
        summary: `Could not upload env vars${viewCtx.ciSecretError ? `: ${viewCtx.ciSecretError}` : '.'} Your credentials are already saved — only the CI upload failed.`,
        ...(viewCtx.ciSecretError ? { context: { error: viewCtx.ciSecretError } } : {}),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { ciSecretAction: '<retry|continue>' },
          instruction: 'Show the user the upload error, then call next_step with ciSecretAction "retry" to try again, or "continue" to finish without uploading.',
          call: `${NEXT_STEP_TOOL}({ ciSecretAction: "retry" })`,
        },
      }

    case 'ask-github-actions-setup':
      return {
        ...base,
        summary: `${view.prompt ?? 'Set up GitHub Actions for you?'} Capgo can push the ${secretKeyNames.length} build env var${secretKeyNames.length === 1 ? '' : 's'} as repository secrets and drop a ${WORKFLOW_FILE_PATH} you can dispatch manually.`,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { githubActionsSetup: '<with-workflow|secrets-only|no>' },
          instruction: 'Present the three options to the user, then call next_step with githubActionsSetup: "with-workflow" (secrets + workflow file), "secrets-only", or "no" (offers a local .env export instead).',
          call: `${NEXT_STEP_TOOL}({ githubActionsSetup: "with-workflow" })`,
        },
      }

    case 'ask-export-env': {
      const defaultPath = renderDeps.defaultExportPath?.(appId, platform) ?? viewCtx.defaultEnvExportPath
      return {
        ...base,
        summary: `${view.prompt ?? 'Export the credentials as a .env file instead?'}${defaultPath ? ` Default path: ${defaultPath}.` : ''} The file is written locally with 0600 permissions — never commit it.`,
        ...(defaultPath ? { context: { defaultPath } } : {}),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { exportEnvAction: '<yes|no>', envExportPath: '<optional custom path with "yes">' },
          instruction: `Ask the user. To write the .env file call next_step with exportEnvAction "yes"${defaultPath ? ` (defaults to ${defaultPath}; add envExportPath for a custom location)` : ' (add envExportPath for a custom location)'}; "no" finishes without exporting.`,
          call: `${NEXT_STEP_TOOL}({ exportEnvAction: "yes" })`,
        },
      }
    }

    case 'confirm-env-export-overwrite': {
      const path = progress.envExportTargetPath ?? viewCtx.defaultEnvExportPath ?? 'the file'
      return {
        ...base,
        summary: view.prompt ?? `${path} already exists. Replace it with a fresh export, or skip?`,
        context: { path },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { exportEnvAction: '<replace|skip>' },
          instruction: 'The target .env file already exists. Ask the user, then call next_step with exportEnvAction "replace" to overwrite it, or "skip" to keep the existing file.',
          call: `${NEXT_STEP_TOOL}({ exportEnvAction: "replace" })`,
        },
      }
    }

    case 'pick-package-manager':
      return {
        ...base,
        summary: `${view.prompt ?? 'Which package manager does this project use?'} It drives the install + build steps in the generated workflow.`,
        // Lockfile detection (when the driver wires the dep): the matching
        // option's label already carries the 'recommended — matches your
        // lockfile' note (tailViewForStep); surface the name in context too.
        ...(viewCtx.detectedPackageManager ? { context: { detectedPackageManager: viewCtx.detectedPackageManager } } : {}),
        next: {
          tool: NEXT_STEP_TOOL,
          with: { packageManager: '<bun|npm|pnpm|yarn>' },
          instruction: 'Ask the user which package manager the project uses, then call next_step with packageManager.',
          call: `${NEXT_STEP_TOOL}({ packageManager: "npm" })`,
        },
      }

    case 'pick-build-script': {
      const scriptValues = options.map(o => o.value)
      return {
        ...base,
        summary: `${view.prompt ?? 'Which script builds your web assets?'} The workflow runs it before \`capgo build request\`.`,
        next: {
          tool: NEXT_STEP_TOOL,
          with: { buildScript: `<${scriptValues.join('|')}>` },
          instruction: 'Present the script options to the user, then call next_step with buildScript set to the chosen value — a listed script name, "__custom__" to type a custom command, or "__skip__" when the app needs no build step.',
          call: `${NEXT_STEP_TOOL}({ buildScript: "${scriptValues.find(v => v !== '__custom__' && v !== '__skip__') ?? '__custom__'}" })`,
        },
      }
    }

    case 'pick-build-script-custom':
      return {
        ...base,
        kind: 'human_gate',
        options: undefined,
        summary: view.prompt ?? 'Custom build command',
        collect: [{ field: 'buildScriptCustom', desc: 'The exact command the workflow runs to build the web assets (e.g. "make web")' }],
        human: { instruction: 'Ask the user for the exact build command the workflow should run before `capgo build request` (e.g. "make web", "bash scripts/build.sh").' },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { buildScriptCustom: '<command>' },
          instruction: 'Collect the custom build command from the user, then call next_step with buildScriptCustom.',
          call: `${NEXT_STEP_TOOL}({ buildScriptCustom: "make web" })`,
        },
      }

    case 'preview-workflow-file': {
      // The proposed file content (non-secret: it references secret NAMES via
      // ${{ secrets.X }} only). Pure + best-effort: an absent dep or a thrown
      // generator just omits the preview text.
      let workflowContent: string | undefined
      let workflowPath = WORKFLOW_FILE_PATH
      if (renderDeps.generateWorkflow && progress.buildScriptChoice) {
        try {
          const generated = renderDeps.generateWorkflow({
            appId,
            defaultPlatform: platform,
            packageManager: progress.selectedPackageManager ?? 'npm',
            buildScript: progress.buildScriptChoice,
            secretKeys: secretKeyNames,
          })
          workflowContent = generated.content
          workflowPath = generated.path
        }
        catch {
          // Best-effort preview — the write step regenerates from the same opts.
        }
      }
      return {
        ...base,
        summary: view.prompt ?? `What should we do with ${workflowPath}?`,
        context: { workflowPath, ...(workflowContent ? { workflowContent } : {}) },
        next: {
          tool: NEXT_STEP_TOOL,
          with: { workflowFileAction: '<write|view|cancel>' },
          instruction: 'Show the user the proposed workflow file (context.workflowContent). Then call next_step with workflowFileAction: "write" to write it, "view" to get the file text again, or "cancel" to finish without writing.',
          call: `${NEXT_STEP_TOOL}({ workflowFileAction: "write" })`,
        },
      }
    }

    default:
      return {
        ...base,
        summary: view.prompt ?? view.title ?? view.message ?? `Capgo setup: ${step}`,
        next: {
          tool: NEXT_STEP_TOOL,
          instruction: 'Present the options to the user, then call next_step with the step\'s answer field.',
          call: `${NEXT_STEP_TOOL}({})`,
        },
      }
  }
}

/** The generated workflow's repo-relative path (workflow-generator's constant, inlined to avoid an import cycle risk). */
const WORKFLOW_FILE_PATH = '.github/workflows/capgo-build.yml'

/**
 * Render (and PARK) an interactive tail step. Merges the invocation's fresh
 * effect transients over the previously parked view context (so a corrective
 * re-render in a later call still has the option inventories), persists the
 * park, and returns the structured mapping. Secrets never enter the park:
 * every field is an option inventory / label / advice text.
 */
function renderTailStep(
  platform: Platform,
  appId: string,
  step: string,
  progress: TailEffectProgress,
  invocationCtx: Record<string, unknown>,
  renderDeps: TailRenderDeps,
): NextStepResult {
  const parked = getSession(appId).tailParked
  const carried = getSession(appId).tailCarried
  const pick = <T>(key: string): T | undefined =>
    (invocationCtx[key] !== undefined ? invocationCtx[key] : (parked as Record<string, unknown> | undefined)?.[key]) as T | undefined
  const viewCtx: TailStepCtx & { ciSecretError?: string, ciSecretExistingKeys?: string[] } = {
    ciSecretTargets: pick('ciSecretTargets'),
    ciSecretSetupAdvice: pick('ciSecretSetupAdvice'),
    ciSecretRepoLabel: pick('ciSecretRepoLabel'),
    ciSecretError: pick('ciSecretError'),
    availableScripts: pick('availableScripts'),
    recommendedScript: pick('recommendedScript'),
    ciSecretEntries: carried.ciSecretEntries,
    ciSecretExistingKeys: (invocationCtx.ciSecretExistingKeys as string[] | undefined) ?? carried.ciSecretExistingKeys,
    defaultEnvExportPath: renderDeps.defaultExportPath?.(appId, platform),
    // pick-package-manager only: lockfile detection runs per render (cheap,
    // read-only) — the engine view marks the matching option 'recommended'.
    detectedPackageManager: step === 'pick-package-manager' ? renderDeps.detectPackageManager?.() : undefined,
  }
  setTailParked(appId, {
    step,
    ...(viewCtx.ciSecretTargets ? { ciSecretTargets: viewCtx.ciSecretTargets } : {}),
    ...(viewCtx.ciSecretSetupAdvice ? { ciSecretSetupAdvice: viewCtx.ciSecretSetupAdvice } : {}),
    ...(viewCtx.ciSecretRepoLabel !== undefined ? { ciSecretRepoLabel: viewCtx.ciSecretRepoLabel } : {}),
    ...(viewCtx.ciSecretError ? { ciSecretError: viewCtx.ciSecretError } : {}),
    ...(viewCtx.availableScripts ? { availableScripts: viewCtx.availableScripts } : {}),
    ...(viewCtx.recommendedScript !== undefined ? { recommendedScript: viewCtx.recommendedScript } : {}),
  })
  return mapTailView(step, platform, appId, progress, viewCtx, renderDeps)
}

export async function decideAdvance(
  facts: PreflightFacts,
  progress: OnboardingProgress | null,
  input: OnboardingInput | undefined,
  deps: EngineDeps,
): Promise<NextStepResult> {
  // Thread a verify-app gate answer (or an S6b recovery answer — cert-limit /
  // duplicate-profile / error screen — or an S12 ephemeral import pick) into
  // the iOS driver. All validated upstream by the strict iOS step gate in
  // drive(). The PERSISTED import forks (setupMethod / importDistribution)
  // are applied in drive() via persistIosImportForkInput, not threaded here.
  const iosOpts = (input && (
    input.verifyAction !== undefined
    || input.certToRevoke !== undefined
    || input.duplicateProfileAction !== undefined
    || input.errorAction !== undefined
    || input.identityChoice !== undefined
    || input.profileChoice !== undefined
    || input.importRecoveryAction !== undefined
    || input.portalAction !== undefined
    || input.profilePath !== undefined
    || input.exportConfirm !== undefined
  ))
    ? {
        verifyAction: input.verifyAction,
        verifyAppId: input.verifyAppId,
        certToRevoke: input.certToRevoke,
        duplicateProfileAction: input.duplicateProfileAction,
        errorAction: input.errorAction,
        identityChoice: input.identityChoice,
        profileChoice: input.profileChoice,
        importRecoveryAction: input.importRecoveryAction,
        portalAction: input.portalAction,
        profilePath: input.profilePath,
        exportConfirm: input.exportConfirm,
      }
    : undefined
  if (input?.platform === 'ios' || input?.platform === 'android') {
    if (!facts.authenticated)
      return decideStart(facts, progress, deps)
    if (!facts.platformsDetected.includes(input.platform))
      return decideStart(facts, progress, deps)
    if (!facts.appRegistered)
      return decideStart(facts, progress, deps)
    // ── "Migrating from Appflow?" gate (single-platform entry, OPT-IN) ─────────
    // The single-platform migration question is surfaced in the TUI (build init).
    // Over MCP it is OPT-IN: a caller that already knows the user is migrating
    // passes { migratingFromAppflow: 'yes' } to run the migration scoped to this
    // platform; 'no' (or omitting the field) keeps the established direct-pick
    // contract and goes straight to native onboarding. The answer is persisted so
    // a resume never re-asks.
    if (input.migratingFromAppflow === 'yes') {
      if (facts.appId)
        setAppflowGate(facts.appId, 'asked-yes')
      return decideAppflow(facts, deps, input.platform, input)
    }
    if (input.migratingFromAppflow === 'no' && facts.appId)
      setAppflowGate(facts.appId, 'asked-no')
    // Commit this session to the chosen platform (the picker answer / explicit
    // pick). Subsequent bare next_step({}) calls resume THIS platform from session
    // memory — never from whichever platform happens to have progress on disk.
    if (facts.appId)
      setSessionPlatform(facts.appId, input.platform)
    if (input.platform === 'android')
      return decideAndroid(facts, deps)
    return decideIos(facts, deps, iosOpts)
  }
  // No platform supplied → resume the platform this session committed to (from
  // session memory, not disk), so a mid-flow next_step({}) continues the right flow.
  // With no committed platform (fresh start / post-restart) this falls to decideStart,
  // which offers the picker rather than guessing from disk.
  // An in-flight Appflow migration (process-local progress) takes precedence — a
  // bare next_step({ value }) answers the migration's current step.
  if (facts.appId) {
    const appflowInFlight = getAppflowProgress(facts.appId)
    if (appflowInFlight)
      return decideAppflow(facts, deps, appflowInFlight.scope, input)
  }
  const active = facts.appId ? getSessionPlatform(facts.appId) : undefined
  if (active === 'android')
    return decideAndroid(facts, deps)
  if (active === 'ios')
    return decideIos(facts, deps, iosOpts)
  return decideStart(facts, progress, deps)
}

export interface EngineDeps {
  cwd: string
  hasSavedKey: () => boolean
  getAppId: () => Promise<string | undefined>
  detectPlatforms: () => Promise<Platform[]>
  isAppRegistered: (appId: string) => Promise<boolean>
  loadProgress: (appId: string) => Promise<OnboardingProgress | null>
  registerApp: (appId: string) => Promise<{ ok: true } | { ok: false, alreadyExists: boolean, error: string }>
  loadAndroidProgress: (appId: string) => Promise<AndroidOnboardingProgress | null>
  readBuildRecord: (path: string) => Promise<BuildOutputRecord | null>
  buildRecordPath: (appId: string, platform: Platform) => string
  /**
   * Remove a build record (and its QR png) left behind by an earlier build.
   * Called by runBuild BEFORE the hand-off so checkBuild can never read a
   * stale record as the new build's result (hostile-review 2026-06-12).
   * Optional so legacy fixtures keep working; production wires
   * removeBuildOutputRecord.
   */
  clearBuildRecord?: (recordPath: string) => Promise<void>
  /**
   * The shared iOS flow engine's IO deps (Apple API / CSR / fs / persistence),
   * pre-bound by the driver (buildIosEffectDeps in onboarding-tools.ts for
   * production; canned fakes in tests). decideIos threads the per-app carried
   * session state in on every effect run. Optional so legacy fixtures that
   * never enter the iOS path keep working — a missing helper inside surfaces
   * as a caught effect error, never a crash.
   */
  iosEffectDeps?: IosEffectDeps
  androidEffectDeps: AndroidEffectDeps
  /**
   * Optional injectable broker OAuth session for testing. When provided, the engine uses these instead of the
   * disk-persisted broker-session.ts functions. Production omits this and relies on the broker session.
   */
  oauthSession?: {
    begin: typeof brokerBegin
    poll: typeof brokerPoll
    clear: typeof brokerClear
  }
  /**
   * Write the generated/loaded Android keystore (.p12) to a file on disk so the
   * user has a durable copy after onboarding. Called once when the keystore phase
   * completes. Returns the absolute path of the written file.
   *
   * Optional — when omitted the keystore is kept in progress only (no file written).
   * Omitting does not break the flow; the keystore data is always in _keystoreBase64.
   */
  writeKeystoreFile?: (appId: string, base64: string, alias: string) => Promise<string>
}

export async function gatherFacts(deps: EngineDeps): Promise<PreflightFacts> {
  const appId = await deps.getAppId()
  const authenticated = deps.hasSavedKey()

  if (!appId)
    return { capacitorProject: false, appId: undefined, platformsDetected: [], authenticated, appRegistered: false, androidProgress: null, iosProgress: null }

  const platformsDetected = await deps.detectPlatforms()
  const appRegistered = authenticated ? await deps.isAppRegistered(appId) : false
  const androidProgress = await deps.loadAndroidProgress(appId)
  const iosProgress = await deps.loadProgress(appId)
  return { capacitorProject: true, appId, platformsDetected, authenticated, appRegistered, androidProgress, iosProgress }
}

const MAX_AUTO_STEPS = 8

function appConflictResult(appId: string): NextStepResult {
  return {
    onboarding: 'capgo-builder', phase: 'app', state: 'app-id-conflict', progress: 8, kind: 'human_gate',
    summary: `The app id "${appId}" already exists and is not in your account. You will need a different app id.`,
    human: {
      instruction: `Choose a different app id (it must match your capacitor.config). Suggestions: ${buildAppIdConflictSuggestions(appId).slice(0, 4).join(', ')}. Update capacitor.config, then continue. (Automatic rename lands in a later milestone.)`,
    },
    next: {
      tool: 'capgo_builder_onboarding_next_step',
      instruction: 'After the user updates their app id in capacitor.config, call next_step (no arguments).',
      call: 'capgo_builder_onboarding_next_step({})',
    },
    rules: ONBOARDING_RULES,
  }
}

async function persistAndroidInput(deps: EngineDeps, appId: string, input: OnboardingInput): Promise<void> {
  // Seed an empty progress when there is none yet — the keystore inputs arrive
  // before any progress exists (the user is on the very first keystore step).
  const progressRaw = await deps.androidEffectDeps.loadAndroidProgress(appId)
    ?? {
      platform: 'android' as const,
      appId,
      activePlatform: 'android' as const,
      startedAt: new Date().toISOString(),
      completedSteps: {},
    }

  let updated = progressRaw

  // Data-safety gate answer (credentials-exist). 'backup' parks resume on
  // backing-up (the copy effect runs next); 'cancel' halts onboarding. Applied
  // first so it gates everything that follows.
  if (input.credentialsExistChoice) {
    updated = applyAndroidInput('credentials-exist', updated, {
      step: 'credentials-exist',
      value: input.credentialsExistChoice,
    })
  }
  if (input.serviceAccountMethod) {
    updated = applyAndroidInput('service-account-method-select', updated, {
      step: 'service-account-method-select',
      value: input.serviceAccountMethod,
    })
  }

  if (input.playDeveloperId) {
    updated = applyAndroidInput('play-developer-id-input', updated, {
      step: 'play-developer-id-input',
      rawDeveloperIdOrUrl: input.playDeveloperId,
    })
  }

  if (input.gcpProjectName) {
    updated = applyAndroidInput('gcp-project-create-name', updated, {
      step: 'gcp-project-create-name',
      displayName: input.gcpProjectName,
    })
  }

  if (input.gcpProjectId && input.gcpProjectId !== '__new__') {
    updated = applyAndroidInput('gcp-projects-select', updated, {
      step: 'gcp-projects-select',
      gcpProject: { projectId: input.gcpProjectId, name: input.gcpProjectId },
    })
  }

  if (input.androidPackage) {
    updated = applyAndroidInput('android-package-select', updated, {
      step: 'android-package-select',
      packageName: input.androidPackage,
      source: 'user-input',
      serviceAccountMethod: updated.serviceAccountMethod ?? 'generate',
    })
  }

  // android-app-verify gate answer. 'recheck'/'open' leave progress unchanged so
  // the next drive() re-runs the verify effect (transient isn't persisted → the
  // apps:search check runs again). 'cancel' is surfaced by the engine's halt path.
  if (input.androidVerifyAction) {
    updated = applyAndroidInput('android-app-verify', updated, {
      step: 'android-app-verify',
      verifyAction: input.androidVerifyAction,
    })
  }

  if (input.serviceAccountJsonPath) {
    updated = applyAndroidInput('sa-json-existing-path', updated, {
      step: 'sa-json-existing-path',
      path: input.serviceAccountJsonPath,
    })
  }

  if (input.saMethodChoice) {
    if (input.saMethodChoice === 'retry' || input.saMethodChoice === 'oauth') {
      updated = applyAndroidInput('sa-json-validation-failed', updated, {
        step: 'sa-json-validation-failed',
        value: input.saMethodChoice,
      })
    }
    else if (input.saMethodChoice === 'save-anyway') {
      const saPath = updated.serviceAccountJsonPath
      if (saPath) {
        const bytes = await deps.androidEffectDeps.readFile(saPath)
        const base64 = bytes.toString('base64')
        updated = applyAndroidInput('sa-json-validation-failed', updated, {
          step: 'sa-json-validation-failed',
          value: 'save-anyway',
          serviceAccountKeyBase64: base64,
        })
      }
    }
  }

  // ── Keystore inputs ──────────────────────────────────────────────────────

  if (input.keystoreMethod) {
    updated = applyAndroidInput('keystore-method-select', updated, {
      step: 'keystore-method-select',
      value: input.keystoreMethod,
    })
  }

  if (input.keystorePath) {
    updated = applyAndroidInput('keystore-existing-path', updated, {
      step: 'keystore-existing-path',
      path: input.keystorePath,
    })
  }

  if (input.keystoreNewAlias) {
    updated = applyAndroidInput('keystore-new-alias', updated, {
      step: 'keystore-new-alias',
      alias: input.keystoreNewAlias,
    })
  }

  if (input.keystorePasswordMethod) {
    updated = applyAndroidInput('keystore-new-password-method', updated, {
      step: 'keystore-new-password-method',
      value: input.keystorePasswordMethod,
    })
  }

  if (input.keystoreCommonName !== undefined && input.keystoreCommonName !== null) {
    updated = applyAndroidInput('keystore-new-cn', updated, {
      step: 'keystore-new-cn',
      cn: input.keystoreCommonName,
    })
  }

  if (input.keystoreAlias) {
    // Resolve which step to apply: alias-select if the current resume step is that, else alias input
    const currentStep = getAndroidResumeStep(updated)
    const aliasStep: 'keystore-existing-alias-select' | 'keystore-existing-alias' =
      currentStep === 'keystore-existing-alias-select'
        ? 'keystore-existing-alias-select'
        : 'keystore-existing-alias'
    updated = applyAndroidInput(aliasStep, updated, {
      step: aliasStep,
      alias: input.keystoreAlias,
    })
  }

  if (input.keystoreStorePassword !== undefined && input.keystoreStorePassword !== null) {
    // Route to existing or new sub-flow based on keystoreMethod
    const storePasswordStep: 'keystore-existing-store-password' | 'keystore-new-store-password' =
      updated.keystoreMethod === 'existing'
        ? 'keystore-existing-store-password'
        : 'keystore-new-store-password'
    updated = applyAndroidInput(storePasswordStep, updated, {
      step: storePasswordStep,
      password: input.keystoreStorePassword,
    })
  }

  if (input.keystoreKeyPassword !== undefined) {
    // Route to existing or new sub-flow based on keystoreMethod
    const keyPasswordStep: 'keystore-existing-key-password' | 'keystore-new-key-password' =
      updated.keystoreMethod === 'existing'
        ? 'keystore-existing-key-password'
        : 'keystore-new-key-password'
    updated = applyAndroidInput(keyPasswordStep, updated, {
      step: keyPasswordStep,
      password: input.keystoreKeyPassword,
    })
  }

  if (updated !== progressRaw) {
    await deps.androidEffectDeps.saveAndroidProgress(appId, updated)
  }
}

/**
 * Apply the ASC API key trio from the single 'ios-api-key' MCP gate (or the
 * ios-credentials-failed re-collect gate) to the persisted iOS progress.
 *
 * Routes each field through the SAME pure reducers the TUI input chain uses
 * (applyIosInput 'input-p8-path' / 'input-key-id' / 'input-issuer-id') so the
 * persisted progress is byte-identical to a TUI run — the resume routing
 * (getIosResumeStep) then lands on verifying-key exactly as it does for the
 * wizard. The create-new fork is persisted on first touch (the MCP only drives
 * create-new in this slice; the import fork is a later slice).
 *
 * Also buffers the .p8 bytes into the per-app session (the headless mirror of
 * the TUI's p8ContentRef) so verifying-key and the saving-credentials
 * APPLE_KEY_CONTENT write get them without a re-read. Best-effort: a missing/
 * unreadable file is NOT an error here — verifying-key's resolveP8Content
 * retries from p8Path and surfaces the failure with a clear message.
 */
async function persistIosApiKeyInput(deps: EngineDeps, appId: string, input: OnboardingInput): Promise<void> {
  const ios = deps.iosEffectDeps
  const loadIosProgress = ios?.loadProgress ?? deps.loadProgress
  const progressRaw: OnboardingProgress = (await loadIosProgress(appId)) ?? {
    platform: 'ios',
    appId,
    startedAt: new Date().toISOString(),
    completedSteps: {},
  }

  let updated = progressRaw
  if (!updated.setupMethod)
    updated = applyIosInput('setup-method-select', updated, { step: 'setup-method-select', value: 'create' })
  if (input.p8Path)
    updated = applyIosInput('input-p8-path', updated, { step: 'input-p8-path', value: input.p8Path })
  if (input.keyId)
    updated = applyIosInput('input-key-id', updated, { step: 'input-key-id', value: input.keyId })
  if (input.issuerId)
    updated = applyIosInput('input-issuer-id', updated, { step: 'input-issuer-id', value: input.issuerId })

  if (updated !== progressRaw)
    await ios?.saveProgress?.(appId, updated)

  if (input.p8Path && ios?.readFile) {
    try {
      mergeIosCarried(appId, { p8Content: await ios.readFile(input.p8Path) })
    }
    catch {
      // Unreadable .p8 — verifying-key re-reads from p8Path and reports.
    }
  }
}

/**
 * S12: apply the PERSISTED import-fork answers (setupMethod from the
 * setup-method-select choice; importDistribution — incl. the '__cancel__'
 * switch-to-create-new escape — from import-distribution-mode) through the
 * SAME pure reducers the TUI's onChange handlers use (applyIosInput), so the
 * persisted progress is byte-identical to a TUI run and the resume routing
 * (getIosResumeStep / getImportEntryStep) takes over from there. The MCP
 * setupMethod vocabulary IS the persisted one ('create-new'/'import-existing');
 * the reducer's input vocabulary is the TUI Select's ('create'/'import').
 */
async function persistIosImportForkInput(deps: EngineDeps, appId: string, input: OnboardingInput): Promise<void> {
  const ios = deps.iosEffectDeps
  const loadIosProgress = ios?.loadProgress ?? deps.loadProgress
  const progressRaw: OnboardingProgress = (await loadIosProgress(appId)) ?? {
    platform: 'ios',
    appId,
    startedAt: new Date().toISOString(),
    completedSteps: {},
  }

  let updated = progressRaw
  if (input.setupMethod !== undefined) {
    updated = applyIosInput('setup-method-select', updated, {
      step: 'setup-method-select',
      value: input.setupMethod === 'import-existing' ? 'import' : 'create',
    })
  }
  if (input.importDistribution !== undefined) {
    updated = applyIosInput('import-distribution-mode', updated, {
      step: 'import-distribution-mode',
      value: input.importDistribution,
    })
  }

  if (updated !== progressRaw)
    await ios?.saveProgress?.(appId, updated)
}

async function executeAuto(result: NextStepResult, facts: PreflightFacts, deps: EngineDeps): Promise<NextStepResult | null> {
  if (result.state === 'registering-app' && facts.appId) {
    const reg = await deps.registerApp(facts.appId)
    if (reg.ok)
      return null
    if (reg.alreadyExists)
      return appConflictResult(facts.appId)
    return {
      onboarding: 'capgo-builder', phase: 'app', state: 'register-app-failed', progress: 8, kind: 'error',
      summary: `Could not register "${facts.appId}" in Capgo: ${reg.error}`,
      rules: ONBOARDING_RULES,
    }
  }
  return result
}

function buildWaitingResult(platform: Platform): NextStepResult {
  return {
    onboarding: 'capgo-builder', phase: 'build', state: 'build-waiting', platform, progress: 95, kind: 'human_gate',
    summary: 'I don\'t see the build result yet.',
    human: {
      instruction: 'Has the build command finished? If you haven\'t run it yet, run it now; once it completes, tell me to continue.',
    },
    next: {
      tool: NEXT_STEP_TOOL,
      with: { checkBuild: true, platform },
      instruction: `When the build command has finished, call next_step({ checkBuild: true, platform: "${platform}" }).`,
      call: `${NEXT_STEP_TOOL}({ checkBuild: true, platform: "${platform}" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

function buildDoneResult(appId: string, platform: Platform, rec: BuildOutputRecord): NextStepResult {
  return {
    onboarding: 'capgo-builder', phase: 'done', state: 'build-complete', platform, progress: 100, kind: 'done',
    summary: `First cloud build for "${appId}" (${platform}) is ready: ${rec.outputUrl ?? 'see the build record'}. Onboarding complete!`,
    context: { appId, platform, jobId: rec.jobId, status: rec.status, outputUrl: rec.outputUrl, qrCodeAscii: rec.qrCodeAscii },
    rules: ONBOARDING_RULES,
  }
}

function buildFailedResult(appId: string, platform: Platform, rec: BuildOutputRecord, recordPath: string): NextStepResult {
  return {
    onboarding: 'capgo-builder', phase: 'build', state: 'build-failed', platform, progress: 92, kind: 'error',
    summary: `The build did not succeed (status: ${rec.status}). The full record is at ${recordPath}. The build is a required step — onboarding can't finish until a build succeeds.`,
    context: { appId, platform, jobId: rec.jobId, status: rec.status, recordPath },
    next: {
      tool: 'capgo_build_logs',
      with: { job_id: rec.jobId },
      instruction: 'Read the build logs with capgo_build_logs (pass the job_id), tell the user what failed, and PROPOSE a fix. Do NOT act on your own behalf: do not edit files or retry automatically. Ask the user to confirm before retrying, and retry ONLY via start_capgo_build once they agree. Never call start_capgo_builder_onboarding or next_step to move past or restart onboarding — the build is a required gate.',
      call: `capgo_build_logs({ job_id: "${rec.jobId}" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/**
 * S8: route a SUCCESSFUL checkBuild into the shared post-save tail instead of
 * the legacy terminal done. Three guards keep the C2/D2 contract intact for
 * every legacy caller:
 *  - the slim tail progress (completedSteps.credentialsSaved) must exist on
 *    disk — only the S8 MCP save writes it; TUI/legacy fixtures fall through
 *    to buildDoneResult verbatim;
 *  - the driver must have wired detectCiSecretTargets (the tail's first
 *    effect) — callers without tail deps keep the legacy terminal result;
 *  - any error falls back to the legacy terminal result, never breaking the
 *    polling protocol.
 * Persists completedSteps.buildRequested (the double-build guard) BEFORE
 * routing, so a resume can never re-offer the build. The tail then resumes at
 * 'detecting-ci-secrets' via the platform's tailResumeStep. Returns null when
 * the legacy terminal result should be used.
 */
async function enterTailAfterBuild(
  deps: EngineDeps,
  appId: string,
  platform: Platform,
  rec: BuildOutputRecord,
): Promise<NextStepResult | null> {
  try {
    const buildUrl = consoleWebUrl(`/app/${appId}/builds`)
    if (platform === 'ios') {
      if (!deps.iosEffectDeps?.detectCiSecretTargets || !deps.iosEffectDeps.saveProgress)
        return null
      const prog = await deps.loadProgress(appId)
      if (!prog?.completedSteps?.credentialsSaved)
        return null
      if (!prog.completedSteps.buildRequested) {
        const updated = slimIosTailProgress({
          ...prog,
          completedSteps: { ...prog.completedSteps, buildRequested: { buildUrl } },
        })
        await deps.iosEffectDeps.saveProgress(appId, updated)
      }
    }
    else {
      if (!deps.androidEffectDeps.detectCiSecretTargets)
        return null
      const prog = await deps.loadAndroidProgress(appId)
      if (!prog?.completedSteps?.credentialsSaved)
        return null
      if (!prog.completedSteps.buildRequested) {
        const updated = slimAndroidTailProgress({
          ...prog,
          completedSteps: { ...prog.completedSteps, buildRequested: { buildUrl } },
        })
        await deps.androidEffectDeps.saveAndroidProgress(appId, updated)
      }
    }
    const facts = await gatherFacts(deps)
    const result = platform === 'ios' ? await decideIos(facts, deps) : await decideAndroid(facts, deps)
    // Lead with the build success the user just confirmed, ahead of the
    // tail's first question. Only the public dashboard/output URL — nothing
    // from the carried state may serialize here.
    return {
      ...result,
      summary: `First cloud build for "${appId}" (${platform}) is ready: ${rec.outputUrl ?? 'see the build record'}. ${result.summary}`,
    }
  }
  catch {
    return null
  }
}

// ── Resume prompt (continue vs restart) ──────────────────────────────────────
//
// Mirrors the Ink TUI's `resume-prompt` fork (ui/app.tsx, android/ui/app.tsx):
// when a platform is committed for this session AND that platform has
// non-trivial saved progress on disk, the FIRST fresh entry asks the user
// whether to pick up where they left off or wipe and restart — instead of
// silently teleporting them into the middle of the wizard. The decision is
// SESSION-local (session-state's resumeResolvedFor), so a server restart
// re-asks and two concurrent sessions never read each other's choice.

/**
 * True when `input` is a "fresh entry" into a platform flow — a bare
 * next_step({}) or a lone { platform } pick — as opposed to a step answer
 * (keystoreMethod, p8Path, a tail/gate answer, runBuild/checkBuild, ...). Only
 * fresh entries are eligible for the resume prompt; a step answer must never be
 * intercepted by it (that would silently drop the answer). `resumeChoice` is the
 * answer to the prompt itself, handled separately, so it is NOT fresh here.
 */
function isFreshEntryInput(input: OnboardingInput | undefined): boolean {
  if (!input)
    return true
  const present = Object.keys(input).filter((k) => {
    const v = (input as Record<string, unknown>)[k]
    return v !== undefined && v !== null
  })
  return present.length === 0 || (present.length === 1 && present[0] === 'platform')
}

/**
 * Determine (and COMMIT) the platform a fresh-entry call will resume, mirroring
 * the branch selection of decideStart/decideAdvance/decidePlatform WITHOUT
 * running any effect: an explicit valid { platform } pick, else the
 * session-committed platform, else a single-platform auto-route. Returns null
 * when preflight isn't satisfied yet, or the project is multi-platform with no
 * pick — there the resume prompt stays out of the way and the normal decide loop
 * renders the login/registration/picker gate. Returns the gathered facts too so
 * the caller reuses the freshly loaded progress.
 */
async function resolveFreshEntryPlatform(
  deps: EngineDeps,
  input: OnboardingInput | undefined,
  appId: string,
): Promise<{ platform: Platform, facts: PreflightFacts } | null> {
  const facts = await gatherFacts(deps)
  if (!facts.capacitorProject || !facts.appId || !facts.authenticated || !facts.appRegistered)
    return null
  if (input?.platform === 'ios' || input?.platform === 'android') {
    if (!facts.platformsDetected.includes(input.platform))
      return null
    setSessionPlatform(appId, input.platform)
    return { platform: input.platform, facts }
  }
  const active = getSessionPlatform(appId)
  if (active)
    return { platform: active, facts }
  if (facts.platformsDetected.length === 1) {
    const only = facts.platformsDetected[0]
    setSessionPlatform(appId, only)
    return { platform: only, facts }
  }
  return null
}

/** Non-secret saved-progress breadcrumbs for the android resume prompt. */
function androidResumeMilestones(prog: AndroidOnboardingProgress): string[] {
  const c = prog.completedSteps ?? {}
  const out: string[] = []
  if (prog.keystoreMethod)
    out.push(`Keystore method: ${prog.keystoreMethod === 'existing' ? 'import existing' : 'generate new'}`)
  if (prog.serviceAccountMethod)
    out.push(`Play service account: ${prog.serviceAccountMethod === 'existing' ? 'import existing JSON' : 'create via Google'}`)
  if (c.keystoreReady)
    out.push('Keystore ready')
  const signIn = c.googleSignInComplete as { email?: string } | undefined
  if (signIn)
    out.push(`Signed in with Google${signIn.email ? ` (${signIn.email})` : ''}`)
  if (c.playAccountChosen)
    out.push('Play developer account set')
  if (c.gcpProjectChosen)
    out.push('Google Cloud project chosen')
  if (c.androidPackageChosen)
    out.push('Android package chosen')
  if (c.serviceAccountProvisioned)
    out.push('Service account provisioned')
  if (c.credentialsSaved)
    out.push('Credentials saved')
  return out
}

/** Non-secret saved-progress breadcrumbs for the iOS resume prompt. */
function iosResumeMilestones(prog: OnboardingProgress): string[] {
  const c = prog.completedSteps ?? {}
  const out: string[] = []
  if (prog.setupMethod)
    out.push(`Setup method: ${prog.setupMethod === 'import-existing' ? 'import existing credentials' : 'create new via Apple'}`)
  if (c.apiKeyVerified)
    out.push('App Store Connect API key verified')
  if (c.certificateCreated)
    out.push('Distribution certificate created')
  if (c.profileCreated)
    out.push('Provisioning profile created')
  if (c.credentialsSaved)
    out.push('Credentials saved')
  return out
}

/** Build the continue-vs-restart resume-prompt result for a platform with saved progress. */
function buildResumePromptResult(
  appId: string,
  platform: Platform,
  prog: AndroidOnboardingProgress | OnboardingProgress,
  resumeStep: string,
): NextStepResult {
  const progressPct = platform === 'android' ? ANDROID_STEP_PROGRESS['resume-prompt'] : STEP_PROGRESS['resume-prompt']
  const startedRaw = (prog as { startedAt?: string }).startedAt
  let startedLabel: string | undefined
  if (startedRaw) {
    const d = new Date(startedRaw)
    startedLabel = Number.isNaN(d.getTime()) ? startedRaw : d.toLocaleString()
  }
  const platformLabel = platform === 'android' ? 'Android' : 'iOS'
  const done = platform === 'android'
    ? androidResumeMilestones(prog as AndroidOnboardingProgress)
    : iosResumeMilestones(prog as OnboardingProgress)
  const summaryLines = [
    `You already have an in-progress ${platformLabel} setup for "${appId}". Do you want to continue where you left off, or start over from scratch (which wipes the saved ${platformLabel} onboarding progress)?`,
  ]
  if (startedLabel)
    summaryLines.push(`Started: ${startedLabel}`)
  if (done.length) {
    summaryLines.push('Already done:')
    for (const item of done)
      summaryLines.push(`  • ${item}`)
  }
  return {
    onboarding: 'capgo-builder',
    phase: 'credentials',
    state: 'resume-prompt',
    platform,
    progress: progressPct,
    kind: 'choice',
    summary: summaryLines.join('\n'),
    context: { appId, resumeTarget: resumeStep, startedAt: startedRaw },
    options: [
      { value: 'continue', label: 'Continue where I left off', note: `resumes at: ${resumeStep}` },
      { value: 'restart', label: 'Start over from scratch', note: `wipes the saved ${platformLabel} onboarding progress and begins again` },
    ],
    next: {
      tool: NEXT_STEP_TOOL,
      with: { resumeChoice: '<continue|restart>' },
      instruction: `Ask the user whether to continue the existing ${platformLabel} onboarding or restart it, then call ${NEXT_STEP_TOOL} with their choice.`,
      call: `${NEXT_STEP_TOOL}({ resumeChoice: "continue" })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/**
 * The resume-prompt gate. The ANSWER path (a continue/restart pick) runs in
 * either mode, so next_step can deliver it. The SHOW path (rendering the prompt)
 * runs only in 'start' mode — runStart, the start tool / "mount" analog — so
 * mid-flow next_step advances resume silently, exactly like advancing inside an
 * already-running TUI. Returns a result to RETURN, or null to fall through to
 * the normal flow.
 */
async function maybeResumePrompt(deps: EngineDeps, input: OnboardingInput | undefined, mode: 'start' | 'advance'): Promise<NextStepResult | null> {
  const appId = await deps.getAppId()
  if (!appId)
    return null

  // ── Answer path: the user picked continue or restart ──────────────────────
  if (input?.resumeChoice) {
    const platform = getSessionPlatform(appId)
    if (!platform)
      return null // stray answer with no committed platform — let the picker take over
    setResumeResolvedFor(appId, platform)
    if (input.resumeChoice === 'restart') {
      // Wipe THIS platform's saved progress and drop the old run's carried
      // transients, but keep the session committed to the platform (and the
      // just-recorded resolution, so the prompt isn't re-asked). The data-safety
      // gate inside decideAndroid/decideIos re-protects any saved credentials.
      try {
        if (platform === 'android')
          await deps.androidEffectDeps.deleteAndroidProgress?.(appId)
        else
          await deps.iosEffectDeps?.deleteProgress?.(appId)
      }
      catch {
        // Best-effort: a failed delete leaves the old progress; the flow then
        // simply resumes from it instead of restarting — never a crash.
      }
      try {
        await (deps.oauthSession ?? { clear: brokerClear }).clear(appId)
      }
      catch { /* best-effort: drop any in-flight OAuth session for the old run */ }
      clearSessionCarried(appId)
    }
    const facts = await gatherFacts(deps)
    return platform === 'android' ? decideAndroid(facts, deps) : decideIos(facts, deps)
  }

  // The PROMPT is shown only at a fresh START (the start tool / "mount" analog);
  // a mid-flow next_step advance resumes silently. The answer path above runs in
  // either mode so next_step can still deliver the continue/restart pick.
  if (mode !== 'start')
    return null

  // ── Show path: a fresh entry into a platform with resumable progress ────────
  if (!isFreshEntryInput(input))
    return null
  const resolved = await resolveFreshEntryPlatform(deps, input, appId)
  if (!resolved)
    return null
  const { platform, facts } = resolved
  if (getResumeResolvedFor(appId) === platform)
    return null
  if (platform === 'android') {
    const prog = facts.androidProgress
    if (prog !== null) {
      const step = getAndroidResumeStep(prog)
      if (step !== 'welcome')
        return buildResumePromptResult(appId, 'android', prog, step)
    }
  }
  else {
    const prog = facts.iosProgress
    if (prog !== null) {
      const step = getIosResumeStep(prog)
      if (step !== 'welcome')
        return buildResumePromptResult(appId, 'ios', prog, step)
    }
  }
  // Nothing resumable for this platform — mark resolved so the prompt is never
  // re-checked this session (e.g. once decideAndroid/decideIos persist a seed).
  setResumeResolvedFor(appId, platform)
  return null
}

async function drive(deps: EngineDeps, input?: OnboardingInput): Promise<NextStepResult> {
  if (input?.checkBuild) {
    const checkAppId = await deps.getAppId()
    const checkPlatform: Platform = (input.platform === 'ios' || input.platform === 'android')
      ? input.platform
      : ((checkAppId ? getSessionPlatform(checkAppId) : undefined) ?? 'android')
    if (checkAppId && !isSafeAppIdForCommand(checkAppId)) {
      return {
        onboarding: 'capgo-builder', phase: 'build', state: 'build-appid-unsafe', platform: checkPlatform,
        progress: 90, kind: 'error',
        summary: `Can't start the build: the app id isn't a valid package name (expected reverse-domain like com.example.app). Fix the appId in your capacitor config and try again.`,
        rules: ONBOARDING_RULES,
      }
    }
    if (checkAppId) {
      const recordPath = deps.buildRecordPath(checkAppId, checkPlatform)
      // A present-but-corrupt record THROWS (BuildRecordReadError) instead of
      // returning null — surface it as a failure with the path instead of
      // polling 'still waiting' forever over a file that will never parse
      // (CodeRabbit #2394). null still means 'no record yet'.
      let rec: Awaited<ReturnType<typeof deps.readBuildRecord>>
      try {
        rec = await deps.readBuildRecord(recordPath)
      }
      catch (err) {
        return {
          onboarding: 'capgo-builder', phase: 'build', state: 'build-failed', platform: checkPlatform,
          progress: 90, kind: 'error',
          summary: `The build output record at ${recordPath} exists but can't be read (${err instanceof Error ? err.message : String(err)}). The build process may have crashed mid-write. Delete the file and re-run the build command, then call ${NEXT_STEP_TOOL} with checkBuild: true again.`,
          context: { recordPath },
          rules: ONBOARDING_RULES,
        }
      }
      if (rec === null)
        return buildWaitingResult(checkPlatform)
      // Stale-record correlation (hostile-review 2026-06-12): a record left
      // behind by an earlier build of ANOTHER app/platform must never complete
      // (or fail) THIS onboarding. schemaVersion:1 records always carry
      // appId/platform (strict read shape); future schemas may not — correlate
      // only on present string fields.
      const recAppId: unknown = rec.appId
      const recPlatform: unknown = rec.platform
      if ((typeof recAppId === 'string' && recAppId !== checkAppId)
        || (typeof recPlatform === 'string' && recPlatform !== checkPlatform)) {
        return {
          onboarding: 'capgo-builder', phase: 'build', state: 'build-stale-record', platform: checkPlatform,
          progress: 92, kind: 'error',
          summary: `The build record at ${recordPath} is for "${String(recAppId)}" (${String(recPlatform)}), not "${checkAppId}" (${checkPlatform}) — it's stale. Delete the file, re-run the build command, then call ${NEXT_STEP_TOOL} with checkBuild: true.`,
          context: { recordPath },
          rules: ONBOARDING_RULES,
        }
      }
      if (rec.status === 'success' || Boolean(rec.outputUrl)) {
        // S8: a CONFIRMED first build enters the shared post-save tail
        // (CI-secrets → env/workflow) instead of ending the conversation —
        // but ONLY when the slim tail progress + tail deps exist (legacy
        // callers keep the terminal result; the C2/D2 polling protocol
        // itself is unchanged).
        const tailEntry = await enterTailAfterBuild(deps, checkAppId, checkPlatform, rec)
        if (tailEntry)
          return tailEntry
        return buildDoneResult(checkAppId, checkPlatform, rec)
      }
      return buildFailedResult(checkAppId, checkPlatform, rec, recordPath)
    }
  }
  if (input?.runBuild) {
    const buildAppId = await deps.getAppId()
    const buildPlatform = input.platform === 'ios' || input.platform === 'android' ? input.platform : undefined
    if (buildAppId && buildPlatform) {
      if (!isSafeAppIdForCommand(buildAppId)) {
        return {
          onboarding: 'capgo-builder', phase: 'build', state: 'build-appid-unsafe', platform: buildPlatform,
          progress: 90, kind: 'error',
          summary: `Can't start the build: the app id "${buildAppId}" isn't a valid package name (expected reverse-domain like com.example.app). Fix the appId in your capacitor config and try again.`,
          rules: ONBOARDING_RULES,
        }
      }
      // Precondition (hostile-review 2026-06-12): the build offer (decideBuildPhase)
      // only renders AFTER the save wrote completedSteps.credentialsSaved. Honor the
      // same contract here so a premature build can never run for an app whose
      // credentials were never saved.
      const buildProgress = buildPlatform === 'android'
        ? await deps.loadAndroidProgress(buildAppId)
        : await deps.loadProgress(buildAppId)
      if (!buildProgress?.completedSteps?.credentialsSaved) {
        return {
          onboarding: 'capgo-builder', phase: 'build', state: 'build-not-ready', platform: buildPlatform,
          progress: 90, kind: 'error',
          summary: `Can't start the first build for "${buildAppId}" (${buildPlatform}): credentials haven't been saved yet. Finish the onboarding steps first — call ${NEXT_STEP_TOOL}({}) to continue from the current step.`,
          rules: ONBOARDING_RULES,
        }
      }
      // The first cloud build is RUN by the start_capgo_build tool, not next_step.
      // A runBuild:true is a wrong-tool call — reject it and point the AI at
      // start_capgo_build. (next_step({ runBuild: false }) still SKIPS the build below.)
      return {
        onboarding: 'capgo-builder', phase: 'build', state: 'build-use-start-tool', platform: buildPlatform,
        progress: 90, kind: 'error',
        summary: 'The first cloud build is run with the start_capgo_build tool, not next_step. Call start_capgo_build to run it.',
        next: {
          tool: 'start_capgo_build',
          with: { platform: buildPlatform },
          instruction: `Call start_capgo_build({ platform: "${buildPlatform}" }) to run the build, then keep calling capgo_build_wait until it finishes. (next_step({ runBuild: false }) only SKIPS the build.)`,
          call: `start_capgo_build({ platform: "${buildPlatform}" })`,
        },
        rules: ONBOARDING_RULES,
      }
    }
  }
  if (input?.runBuild === false) {
    const skipAppId = await deps.getAppId()
    const skipPlatform = input.platform === 'ios' || input.platform === 'android' ? input.platform : undefined
    if (skipAppId && skipPlatform) {
      return {
        onboarding: 'capgo-builder', phase: 'done', state: 'build-skipped', platform: skipPlatform, progress: 100, kind: 'done',
        summary: `Credentials for "${skipAppId}" (${skipPlatform}) are saved. You can start your first cloud build anytime.`,
        rules: ONBOARDING_RULES,
      }
    }
  }

  // ── Resume prompt ANSWER (continue/restart pick, via next_step) ──────────────
  // The PROMPT itself is shown by runStart (the start tool / "mount" analog), so
  // a mid-flow next_step advance never re-asks. 'advance' mode runs only the
  // answer path (applying the user's pick when it arrives) and skips the show
  // path. Returns the resumed/restarted view; null falls through to the flow.
  const resumeResult = await maybeResumePrompt(deps, input, 'advance')
  if (resumeResult)
    return resumeResult

  // ── iOS data-safety gate routing ───────────────────────────────────────────
  // credentialsExistChoice is shared between the android and iOS gates. When
  // the IOS flow is the one parked on 'credentials-exist' (a TUI run set
  // `_credentialsExistGate: 'pending'`), the answer belongs to the iOS
  // progress — apply it there and keep it OUT of the android persist path
  // (which would otherwise seed a stray android progress file).
  let iosOwnsCredentialsGate = false
  if (input?.credentialsExistChoice) {
    const gAppId = await deps.getAppId()
    if (gAppId) {
      const iosProg = await deps.loadProgress(gAppId)
      const androidProg = await deps.loadAndroidProgress(gAppId)
      // Disambiguate the SHARED credentials-exist gate by the SESSION platform, not
      // disk: if this session is setting up iOS, the answer belongs to the iOS gate
      // even when a leftover ANDROID progress file exists on disk (otherwise the
      // answer misrouted into the android flow). Fall back to the disk shape only
      // when no platform is committed yet (e.g. a fresh process after a restart).
      const credGatePlatform = getSessionPlatform(gAppId)
      if (
        (credGatePlatform === 'ios' || (!credGatePlatform && !androidProg))
        && iosProg && getIosResumeStep(iosProg) === 'credentials-exist'
      ) {
        iosOwnsCredentialsGate = true
        const updated: OnboardingProgress = {
          ...iosProg,
          _credentialsExistGate: input.credentialsExistChoice === 'backup' ? 'backup' : 'cancel',
        }
        await deps.iosEffectDeps?.saveProgress?.(gAppId, updated)
        // Route the answered gate straight INTO the iOS driver, mirroring the
        // android persist path (whose seeded progress carries
        // activePlatform: 'android' and is picked up by the decide loop). The
        // iOS gate-seeded progress carries ONLY `_credentialsExistGate`, so
        // falling through to the decide loop on a DUAL-platform project
        // bounced BOTH gate arms back to platform-select — the backup never
        // ran and the cancel never halted (found by the live MCP e2e, S14).
        // decideIos runs the 'backup' arm's backing-up effect itself and
        // renders the 'cancel' arm's durable hard stop.
        const gateFacts = await gatherFacts(deps)
        return decideIos(gateFacts, deps)
      }
    }
  }

  const androidInputPresent = input && (
    input.serviceAccountMethod !== undefined
    || input.playDeveloperId !== undefined
    || input.gcpProjectId !== undefined
    || input.gcpProjectName !== undefined
    || input.androidPackage !== undefined
    || input.serviceAccountJsonPath !== undefined
    || input.saMethodChoice !== undefined
    || (input.credentialsExistChoice !== undefined && !iosOwnsCredentialsGate)
    || input.keystoreMethod !== undefined
    || input.keystorePath !== undefined
    || input.keystoreStorePassword !== undefined
    || input.keystoreAlias !== undefined
    || input.keystoreKeyPassword !== undefined
    || input.keystoreNewAlias !== undefined
    || input.keystorePasswordMethod !== undefined
    || input.keystoreCommonName !== undefined
    || input.androidVerifyAction !== undefined
  )
  // Strict step-by-step gate: only the CURRENT android step's single expected
  // field may be applied. Runs BEFORE persistAndroidInput so a mega-call
  // (multiple fields) / wrong-field / non-answer is rejected with a correction
  // and nothing is applied. Scoped to android-input steps only — the iOS
  // fields are governed by their own gate below, and the bare-{}
  // sign-in-proceed path never sets androidInputPresent, so both are unaffected.
  if (androidInputPresent) {
    const gateAppId = await deps.getAppId()
    if (gateAppId) {
      const gateProgress = await deps.loadAndroidProgress(gateAppId)
      // S9-S11: while parked on an interactive tail step, an android key must
      // be gated against THAT step (whose only allowed field is its tail
      // answer), not the resume-derived step.
      const currentStep = (mcpTailParkedStep(gateAppId, gateProgress) as AndroidOnboardingStep | null) ?? getAndroidResumeStep(gateProgress)
      const check = validateStepInput(currentStep, input as unknown as Record<string, unknown>)
      if (!check.ok) {
        const facts = await gatherFacts(deps)
        const corrective = await decideAndroid(facts, deps) // re-returns the current step; no input applied
        const allowed = check.allowedFields
        const correction = allowed && allowed.length > 0
          ? `This step accepts only one of: ${allowed.map(f => `{ ${f}: ... }`).join(' or ')}. Call ${NEXT_STEP_TOOL} with EXACTLY ONE of those fields and no others${check.extras.length ? ` — remove: ${check.extras.join(', ')}` : ''}. Do not batch multiple answers.`
          : `The current step (${currentStep}) takes none of the supplied fields${check.extras.length ? ` (${check.extras.join(', ')})` : ''}. Answer the current step instead — or call ${NEXT_STEP_TOOL}({}) to continue from it.`
        return { ...corrective, summary: `${correction}\n\n${corrective.summary}` }
      }
      // Content gate: enforce the store-password rules the ink TUI applies inline
      // (min 6 chars for a new keystore, non-empty for an existing one) BEFORE
      // persistAndroidInput, so a weak/empty password never reaches keystore-
      // generating. Re-renders the current step with the exact main wording.
      const pwCheck = validateStorePassword(currentStep, input.keystoreStorePassword)
      if (!pwCheck.ok) {
        const facts = await gatherFacts(deps)
        const corrective = await decideAndroid(facts, deps) // re-returns the current step; no input applied
        return { ...corrective, summary: `${pwCheck.message}\n\n${corrective.summary}` }
      }
    }
  }

  // The GCP picker's "Create a new project" row ('__new__') is navigation-only
  // (mirrors main's app.tsx onChange, which routes to the create-name screen
  // without persisting): render the gcp-project-create-name prompt so the agent
  // collects gcpProjectName next — the unchanged gcp-projects-select resume
  // step accepts it. Without this, a literal gcpProjectId: "__new__" pick
  // (the option row's value) silently re-rendered the same picker forever.
  if (androidInputPresent && input?.gcpProjectId === '__new__') {
    const facts = await gatherFacts(deps)
    if (facts.appId) {
      const view = androidViewForStep('gcp-project-create-name', facts.androidProgress, { appId: facts.appId })
      return mapAndroidView(view, facts)
    }
  }

  // The package picker's "Type a different package name" row ('__manual__') is
  // navigation-only too (mirrors main's app.tsx onChange, which switches to the
  // manual text input without persisting): render the manual-entry prompt so
  // the agent collects a REAL package name next. Without this, the literal
  // sentinel was persisted as the applicationId and service-account
  // provisioning ran against "__manual__" (hostile-review 2026-06-12).
  if (androidInputPresent && input?.androidPackage === '__manual__') {
    const facts = await gatherFacts(deps)
    if (facts.appId) {
      const view = androidViewForStep('android-package-select', facts.androidProgress, { appId: facts.appId })
      return mapAndroidView(view, facts)
    }
  }

  // Mirror the TUI's Play developer id submit guard (android/ui/app.tsx:2900):
  // an unparseable id/URL re-renders the prompt with the exact TUI corrective
  // and persists nothing — the shared reducer silently no-ops on invalid input
  // ("caller should surface error"), which over MCP looped the same prompt with
  // no explanation (hostile-review 2026-06-12).
  if (androidInputPresent && input?.playDeveloperId !== undefined && input.playDeveloperId !== null
    && !extractDeveloperId(String(input.playDeveloperId))) {
    const facts = await gatherFacts(deps)
    if (facts.appId) {
      const corrective = await decideAndroid(facts, deps) // re-renders the current step; nothing applied
      return { ...corrective, summary: `Could not extract a developer ID. Paste the full Play Console URL or just the numeric ID.\n\n${corrective.summary}` }
    }
  }

  // Android verify-app gate: 'cancel' halts onboarding (mirrors the TUI's
  // exitOnboarding at this gate). Runs BEFORE persist/decide so it does not fall
  // through to decideAndroid and silently re-render the same gate forever.
  if (androidInputPresent && input?.androidVerifyAction === 'cancel') {
    const cancelAppId = await deps.getAppId()
    return {
      onboarding: 'capgo-builder', phase: 'credentials', state: 'android-app-verify', platform: 'android',
      progress: ANDROID_STEP_PROGRESS['android-app-verify'], kind: 'done',
      summary: `Onboarding cancelled at the Play Store app check${cancelAppId ? ` for "${cancelAppId}"` : ''}. Nothing was provisioned. Re-run onboarding once the app exists in Play Console (or pick the package it is published under).`,
      rules: ONBOARDING_RULES,
    }
  }
  if (androidInputPresent) {
    const inputAppId = await deps.getAppId()
    if (inputAppId)
      await persistAndroidInput(deps, inputAppId, input!)
  }

  // ── iOS granular input path (S6a/S6b/S12) ──────────────────────────────────
  // The ASC API key trio (the single ios-api-key gate, all three in one call),
  // the verify-app gate answer, the S6b recovery answers (certToRevoke /
  // duplicateProfileAction / errorAction), and the S12 import-fork answers
  // (setupMethod / importDistribution / the ephemeral import picks). Validated
  // by the strict iOS gate against the EFFECTIVE current step (the
  // session-parked recovery/import step when one is parked, else the persisted
  // resume step, mapped through the setup-method fork) BEFORE anything is
  // applied — a stale/early answer or an off-step field is rejected with a
  // correction and nothing is applied.
  const iosInputPresent = input && (
    input.p8Path !== undefined
    || input.keyId !== undefined
    || input.issuerId !== undefined
    || input.verifyAction !== undefined
    || input.verifyAppId !== undefined
    || input.certToRevoke !== undefined
    || input.duplicateProfileAction !== undefined
    || input.errorAction !== undefined
    || input.setupMethod !== undefined
    || input.importDistribution !== undefined
    || input.identityChoice !== undefined
    || input.profileChoice !== undefined
    || input.importRecoveryAction !== undefined
    || input.portalAction !== undefined
    || input.profilePath !== undefined
    || input.exportConfirm !== undefined
  )
  if (iosInputPresent) {
    const gateAppId = await deps.getAppId()
    if (gateAppId) {
      // Seed the Phase-0 data-safety gate BEFORE validating, so an API-key
      // trio sent as the very first call cannot slip past the
      // credentials-exist gate (the FROZEN journey: the gate intercepts
      // BEFORE any Apple traffic). With the gate pending, the effective step
      // is 'credentials-exist', which takes none of the iOS keys — the trio
      // is rejected with a correction and the gate renders.
      const loaded = await deps.loadProgress(gateAppId)
      const gateProgress = await seedIosCredentialsExistGate(gateAppId, deps.iosEffectDeps, loaded)
      const currentStep = effectiveIosStep(gateAppId, gateProgress, deps.iosEffectDeps)
      const check = validateIosStepInput(currentStep, input as unknown as Record<string, unknown>)
      if (!check.ok) {
        const facts = await gatherFacts(deps)
        const corrective = await decideIos(facts, deps) // re-renders the current step; nothing applied
        return { ...corrective, summary: `${check.message}\n\n${corrective.summary}` }
      }
      // Apply the ASC key trio through the SAME reducers the TUI uses
      // (applyIosInput), so progress persists identically — the gate answers
      // (verifyAction / certToRevoke / duplicateProfileAction / errorAction)
      // ride through decideAdvance → decideIos instead (the resolver mechanism).
      if (input!.p8Path !== undefined || input!.keyId !== undefined || input!.issuerId !== undefined) {
        await persistIosApiKeyInput(deps, gateAppId, input!)
        // Corrected key details while parked on the error screen clear the
        // park (the re-collect arm): the flow resumes from the failing phase
        // with the new values instead of re-rendering the stale error.
        if (getSession(gateAppId).iosCarried.error !== undefined)
          dropIosCarried(gateAppId, ['error', 'retryStep', 'errorAction'])
      }
      // S12: the PERSISTED import-fork reducers (the TUI's setup-method /
      // distribution-mode onChange writes). The ephemeral import picks ride
      // through decideAdvance → decideIos instead (the resolver mechanism).
      if (input!.setupMethod !== undefined || input!.importDistribution !== undefined)
        await persistIosImportForkInput(deps, gateAppId, input!)
    }
  }
  // ── S9-S11: post-build tail answer path ─────────────────────────────────────
  // The tail family fields (ciSecretAction / githubActionsSetup /
  // exportEnvAction(+envExportPath) / packageManager / buildScript /
  // buildScriptCustom / workflowFileAction). Validated by the strict tail gate
  // against the EFFECTIVE tail step (the session-parked interactive step when
  // one is parked, else the platform resume step) BEFORE anything is applied —
  // an off-step / wrong-vocabulary / batched answer is rejected with a correction
  // and NOTHING is applied. A valid answer records its pref via the shared
  // applyTailInput reducer, persists the SLIM progress, clears the park and
  // re-drives the platform with the TUI-routed next step.
  const tailInputPresent = Boolean(input && TAIL_INPUT_KEYS.some(k => (input as unknown as Record<string, unknown>)[k] !== undefined && (input as unknown as Record<string, unknown>)[k] !== null))
  if (tailInputPresent) {
    const tailAppId = await deps.getAppId()
    if (tailAppId) {
      const androidProg = await deps.loadAndroidProgress(tailAppId)
      const iosProg = await deps.loadProgress(tailAppId)
      const androidReady = !!androidProg?.completedSteps?.credentialsSaved
      const iosReady = !!iosProg?.completedSteps?.credentialsSaved
      // Prefer the session's ACTIVE platform when BOTH platforms have saved
      // credentials (e.g. android build was skipped and the user is now completing
      // the iOS post-build tail) — a hard android-first precedence would misroute
      // the iOS tail answer into android progress. Fall back to android-then-ios
      // when the session platform is unknown (single-platform / fresh process).
      const sessionPlatform = getSessionPlatform(tailAppId)
      const tailPlatform: Platform | null
        = (sessionPlatform === 'ios' && iosReady)
          ? 'ios'
          : (sessionPlatform === 'android' && androidReady)
              ? 'android'
              : androidReady ? 'android' : iosReady ? 'ios' : null
      const facts = await gatherFacts(deps)
      if (!tailPlatform) {
        // No tail in flight — a tail answer here is always stale/early.
        const corrective = await decideAdvance(facts, iosProg, undefined, deps)
        return { ...corrective, summary: `Tail answer fields (ciSecretAction / githubActionsSetup / exportEnvAction / packageManager / buildScript / buildScriptCustom / workflowFileAction) only apply to the post-build CI/workflow steps — none is active right now. Answer the current step instead.\n\n${corrective.summary}` }
      }
      const tailProgress = (tailPlatform === 'android' ? androidProg! : iosProg!) as TailEffectProgress & { completedSteps: Record<string, unknown> }
      const parked = getSession(tailAppId).tailParked
      const effectiveStep = mcpTailParkedStep(tailAppId, tailProgress as { completedSteps?: { credentialsSaved?: unknown } })
        ?? (tailPlatform === 'android' ? getAndroidResumeStep(androidProg) : getIosResumeStep(iosProg))
      const check = validateTailStepInput(effectiveStep, input as unknown as Record<string, unknown>, {
        ciSecretTargets: parked?.ciSecretTargets,
        availableScripts: parked?.availableScripts,
      })
      if (!check.ok) {
        // Corrective re-render: the park keeps the decide loop on the SAME
        // question; nothing was applied.
        const corrective = tailPlatform === 'android' ? await decideAndroid(facts, deps) : await decideIos(facts, deps)
        return { ...corrective, summary: `${check.message}\n\n${corrective.summary}` }
      }
      const applied = applyMcpTailAnswer(effectiveStep, input!, tailProgress, parked)
      if (applied.progress !== tailProgress) {
        // A pref was recorded — persist it through the SLIM whitelist writer
        // so the answer survives a restart (resume mid-tail).
        if (tailPlatform === 'android')
          await deps.androidEffectDeps.saveAndroidProgress(tailAppId, slimAndroidTailProgress(applied.progress as AndroidOnboardingProgress))
        else
          await deps.iosEffectDeps?.saveProgress?.(tailAppId, slimIosTailProgress(applied.progress as OnboardingProgress))
      }
      // NOTE: the park is intentionally NOT cleared here — the next interactive
      // render REPLACES it (setTailParked), carrying the non-secret inventories
      // (detected targets / scripts / repo label) forward exactly like the
      // TUI's React state, and the terminal clears the whole session.
      const freshFacts = await gatherFacts(deps)
      return tailPlatform === 'android'
        ? decideAndroid(freshFacts, deps, { tailNext: applied.next as AndroidOnboardingStep })
        : decideIos(freshFacts, deps, { tailNext: applied.next as OnboardingStep })
    }
  }

  // Land straight on the sign-in link. Whenever we're at the google-sign-in step — the user just chose the
  // guided setup (serviceAccountMethod/saMethodChoice), switched to it, or sent a plain continue — proceed to
  // create + show the sign-in link (and poll on later continues) instead of parking on a separate
  // "tell me to continue" gate first. decideAndroid's signInProceed branch is the only side-effecting render
  // (begin/poll happen once per turn there); the non-signInProceed pass in decideAdvance stays side-effect-free.
  let signInProceed = false
  {
    const spAppId = await deps.getAppId()
    if (spAppId) {
      const spProgress = await deps.loadAndroidProgress(spAppId)
      if (spProgress && getAndroidResumeStep(spProgress) === 'google-sign-in')
        signInProceed = true
    }
  }

  for (let i = 0; i < MAX_AUTO_STEPS; i++) {
    const facts = await gatherFacts(deps)
    const progress = facts.appId ? await deps.loadProgress(facts.appId) : null
    const result = await decideAdvance(facts, progress, input, deps)

    if (signInProceed && result.platform === 'android' && result.state === 'google-sign-in')
      return decideAndroid(facts, deps, { signInProceed: true, reopenSignIn: Boolean(input?.reopenSignIn), openSignInBrowser: input?.openSignInBrowser, confirmCode: input?.confirmCode })

    if (result.kind !== 'auto')
      return result
    const afterExec = await executeAuto(result, facts, deps)
    if (afterExec !== null)
      return afterExec
  }
  return {
    onboarding: 'capgo-builder', phase: 'preflight', state: 'auto-loop-guard', progress: 0, kind: 'error',
    summary: 'Onboarding stalled (too many automatic steps without progress). Please retry or run `capgo doctor`.',
    rules: ONBOARDING_RULES,
  }
}

export async function runStart(deps: EngineDeps, platform?: Platform): Promise<NextStepResult> {
  // A fresh "start onboarding" re-evaluates the platform. An explicit `platform` (the
  // user already said which — "set up Capgo Builder for iOS" — or is switching after a
  // wrong pick) COMMITS to it and skips the picker; otherwise clear any committed
  // platform so the picker is re-offered (matching the TUI's `build init`). Either way
  // disk progress is untouched — it still resumes the STEP within the chosen platform.
  const appId = await deps.getAppId()
  if (appId) {
    setSessionPlatform(appId, platform)
    // A fresh start re-evaluates the resume prompt (mirrors a TUI re-launch):
    // clear the prior session's resolution so an in-progress platform re-asks
    // continue-vs-restart instead of silently resuming.
    setResumeResolvedFor(appId, undefined)
  }
  // Show the continue-vs-restart prompt when this start lands on a platform that
  // already has resumable on-disk progress (the TUI's mount-time resume-prompt).
  const startInput = platform ? { platform } : undefined
  const startResume = await maybeResumePrompt(deps, startInput, 'start')
  if (startResume)
    return startResume
  return drive(deps, startInput)
}

export async function runAdvance(deps: EngineDeps, input?: OnboardingInput): Promise<NextStepResult> {
  return drive(deps, input)
}

/**
 * Map an iOS resume step to its MCP state name: the TUI-only .p8 chain (and
 * the bootstrap 'welcome') collapses into the single 'ios-api-key' gate name;
 * 'ask-build' maps to the shared 'build-ready' choice (the deciders route it
 * through decideBuildPhase); every other engine step id is the state name
 * verbatim — mirroring decideIos.
 */
function resolveIosStateName(step: OnboardingStep): string {
  if (IOS_API_KEY_GATE_STEPS.has(step))
    return 'ios-api-key'
  if (step === 'ask-build')
    return 'build-ready'
  return step
}

/**
 * The android mirror: 'ask-build' renders as the shared 'build-ready' choice
 * (decideAndroid → decideBuildPhase); every other step id is verbatim.
 */
function resolveAndroidStateName(step: AndroidOnboardingStep): string {
  return step === 'ask-build' ? 'build-ready' : step
}

/**
 * Read-only: determine the onboarding state the user is currently on, WITHOUT
 * running any side effect. Mirrors the branch selection of decideStart/
 * decideAndroid/decideIos (preflight → platform → resume step, with the same
 * ask-build → build-ready / .p8-chain → ios-api-key name mapping) but never
 * calls effects.
 */
export function resolveCurrentState(facts: PreflightFacts): string {
  if (!facts.capacitorProject || !facts.appId)
    return 'no-capacitor-project'
  if (!facts.authenticated)
    return 'login-required'
  if (!facts.appRegistered)
    return 'registering-app'
  const appId = facts.appId
  // Seed an empty android progress the way decideAndroid does so the resume step
  // resolves to 'keystore-method-select' (not 'welcome') for a fresh android flow.
  const androidProgress = facts.androidProgress
    ?? { platform: 'android' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
  // An in-flight android credential flow (or a fresh android-only project) → resume step.
  if (facts.androidProgress)
    return resolveAndroidStateName(getAndroidResumeStep(facts.androidProgress))
  if (facts.iosProgress)
    return resolveIosStateName(getIosResumeStep(facts.iosProgress))
  if (facts.platformsDetected.length === 1 && facts.platformsDetected[0] === 'android')
    return resolveAndroidStateName(getAndroidResumeStep(androidProgress))
  if (facts.platformsDetected.length === 1 && facts.platformsDetected[0] === 'ios')
    return 'ios-api-key'
  return 'platform-select'
}

// ─── S15: EXPLAIN coverage inventory (spec §8 Phase 5) ─────────────────────────
//
// The hermetic explain-coverage gate (private test-mcp-explain-coverage.mjs)
// derives "every state name the MCP can emit" mechanically:
//
//   inventory = (STEP_PROGRESS keys ∪ ANDROID_STEP_PROGRESS keys)
//               − MCP_UNREACHABLE_STEPS
//               ∪ MCP_ONLY_STATES
//
// MCP_ONLY_STATES must list every state literal this file constructs that is
// NOT an engine step id (the gate scans this file's source for `state: '...'`
// literals, so a new constructor with an unlisted name fails the gate).
// MCP_UNREACHABLE_STEPS lists the engine step ids the MCP can NEVER emit as a
// result/explain state. Typing it against the step unions makes a step-id
// rename a compile error here — the rename-catch half of the gate.

/** State names the MCP constructs directly that are NOT engine step ids. */
export const MCP_ONLY_STATES: readonly string[] = [
  // Preflight / app phase (decideStart + executeAuto).
  'no-capacitor-project',
  'login-required',
  'registering-app',
  'app-id-conflict',
  'register-app-failed',
  // iOS: the collapsed .p8 gate + the S6a re-collect gate.
  'ios-api-key',
  'ios-credentials-failed',
  // Build phase (decideBuildPhase + start_capgo_build launch/polling + the runBuild corrective).
  'build-ready',
  'build-launched',
  'build-use-start-tool',
  'build-waiting',
  'build-failed',
  'build-skipped',
  'build-appid-unsafe',
  'build-not-ready',
  'build-stale-record',
  // Defensive stall guards (drive / decideIos / decideAndroid).
  'auto-loop-guard',
  'ios-auto-loop-guard',
  'android-auto-loop-guard',
]

/**
 * Engine step ids (present in the type tables) the MCP can NEVER emit as a
 * state name:
 *  - TUI bootstrap / TUI-only screens: welcome, adding-platform,
 *    the AI build-debug sub-flow (decideIos reroutes its entry to
 *    'build-failed'), the contact-support sub-flow (the MCP's error screen has
 *    the email-support arm instead), the native file pickers (the MCP collects
 *    paths as text), the google-sign-in-running spinner (the MCP parks on
 *    'google-sign-in' via its OAuth session), and view-workflow-diff (the MCP
 *    folds the diff into preview-workflow-file's context — 'view' re-parks);
 *  - the .p8 input chain, collapsed into the single 'ios-api-key' gate;
 *  - 'ask-build', mapped to the shared 'build-ready' choice (decideBuildPhase);
 *  - 'requesting-build', never run over MCP (the C2/D2 handoff + checkBuild
 *    polling replace it).
 */
export const MCP_UNREACHABLE_STEPS: ReadonlySet<string> = new Set<OnboardingStep | AndroidOnboardingStep>([
  'welcome',
  'adding-platform',
  'api-key-instructions',
  'p8-method-select',
  'input-p8-path',
  'input-key-id',
  'input-issuer-id',
  'ask-build',
  'requesting-build',
  'view-workflow-diff',
  'ai-analysis-prompt',
  'ai-analysis-running',
  'ai-analysis-result',
  'ai-analysis-result-scroll',
  'support-confirm',
  'support-log-view',
  'support-uploading',
  'keystore-existing-picker',
  'sa-json-existing-picker',
  'google-sign-in-running',
])

/**
 * Read-only "explain the current step" entry point backing the
 * capgo_builder_onboarding_explain tool. Gathers facts (read-only) and returns a
 * plain-language explanation string. Never advances the flow or runs effects.
 */
export async function explainOnboarding(deps: EngineDeps, input?: { state?: string }): Promise<string> {
  const facts = await gatherFacts(deps)
  const state = input?.state ?? resolveCurrentState(facts)
  return explainForState(state)
}

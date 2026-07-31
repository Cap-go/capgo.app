// src/build/onboarding/mcp/step-input.ts
// The interactive android steps and the input field(s) each one accepts. Used to
// enforce step-by-step input: a next_step must carry EXACTLY ONE of the current
// step's allowed fields (and no other android key), or the engine rejects with a
// correction. Each step accepts a single field per call. Store-password steps
// additionally enforce a content rule (matching the ink TUI in app.tsx): the
// new keystore store password must be at least 6 characters and the existing
// keystore store password must be non-empty — see validateStorePassword.
import type { AndroidOnboardingStep } from '../android/types.js'
import type { OnboardingStep } from '../types.js'

/** state → the set of input fields that legitimately answer it (in order). */
export const STEP_ALLOWED_FIELDS: Partial<Record<AndroidOnboardingStep, string[]>> = {
  // Data-safety gate shown when saved android credentials already exist. Accepts
  // only the backup-or-cancel choice (mirrors main's CredentialsExistStep).
  'credentials-exist': ['credentialsExistChoice'],
  'keystore-method-select': ['keystoreMethod'],
  'keystore-existing-path': ['keystorePath'],
  // The existing-keystore unlock collects ONLY the store password here. Once it
  // is applied the resume step auto-advances to keystore-existing-detecting-alias
  // — the store-password step never stays to collect a key password, so
  // keystoreKeyPassword is not a legitimate answer at this step (vestigial).
  'keystore-existing-store-password': ['keystoreStorePassword'],
  // Resume-step ALIASES (fail-closed gate, hostile-review 2026-06-12): these
  // auto steps are what getAndroidResumeStep derives while the user is parked
  // on the question the auto step's effect rendered — the answer legitimately
  // arrives "at" the auto step. Each lists exactly the rendered question's
  // fields.
  'keystore-existing-detecting-alias': ['keystoreAlias'], // renders the alias select/input
  'keystore-existing-alias-select': ['keystoreAlias'],
  'keystore-existing-alias': ['keystoreAlias'],
  'keystore-existing-key-password': ['keystoreKeyPassword'],
  'keystore-new-alias': ['keystoreNewAlias'],
  // The password-method screen accepts only the random|manual choice. After
  // "manual" the flow advances to keystore-new-store-password (its own step),
  // where the store password is collected — it is never batched here.
  'keystore-new-password-method': ['keystorePasswordMethod'],
  'keystore-new-store-password': ['keystoreStorePassword'],
  'keystore-new-key-password': ['keystoreKeyPassword'],
  'keystore-new-cn': ['keystoreCommonName'],
  'service-account-method-select': ['serviceAccountMethod'],
  'sa-json-existing-path': ['serviceAccountJsonPath'],
  'sa-json-validation-failed': ['saMethodChoice'],
  // Resume alias: validation runs as the sa-json-validating effect; on failure
  // the validation-failed choice renders while resume stays sa-json-validating.
  'sa-json-validating': ['saMethodChoice'],
  'play-developer-id-input': ['playDeveloperId'],
  // The GCP project picker accepts EITHER an existing project id OR a new
  // project name — mirroring main's app.tsx onChange, where selecting the
  // "Create a new project" (`__new__`) row routes to the create-name prompt.
  // The strict gate still requires EXACTLY ONE of these per call, so the agent
  // either picks an existing project (gcpProjectId) or creates one
  // (gcpProjectName), never both. persistAndroidInput routes a supplied
  // gcpProjectName through applyAndroidInput('gcp-project-create-name') so
  // gcpProjectChosen{createdByOnboarding:true} is written and gcp-setup-running
  // creates the project.
  'gcp-projects-select': ['gcpProjectId', 'gcpProjectName'],
  // Resume alias: the project list loads as the gcp-projects-loading effect and
  // renders the picker; resume stays gcp-projects-loading until a pick persists.
  'gcp-projects-loading': ['gcpProjectId', 'gcpProjectName'],
  'gcp-project-create-name': ['gcpProjectName'],
  'android-package-select': ['androidPackage'],
  // androidPackage is also allowed: at a wrong-build-id gate the user can supply a
  // corrected package to re-verify (mirrors the TUI "pick a different package").
  'android-app-verify': ['androidVerifyAction', 'androidPackage'],
  // ── Post-build tail steps (S9-S11) ─────────────────────────────────────────
  // Listed here so an ANDROID key sent while the user is parked on a tail step
  // is rejected with the tail field named (the tail fields themselves are
  // governed by validateTailStepInput, which owns the per-step vocabulary).
  'ci-secrets-setup': ['ciSecretAction'],
  'ci-secrets-target-select': ['ciSecretAction'],
  'ask-ci-secrets': ['ciSecretAction'],
  'confirm-ci-secret-overwrite': ['ciSecretAction'],
  'confirm-secrets-push': ['ciSecretAction'],
  'ci-secrets-failed': ['ciSecretAction'],
  'ask-github-actions-setup': ['githubActionsSetup'],
  'ask-export-env': ['exportEnvAction'],
  'confirm-env-export-overwrite': ['exportEnvAction'],
  'pick-package-manager': ['packageManager'],
  'pick-build-script': ['buildScript'],
  'pick-build-script-custom': ['buildScriptCustom'],
  'preview-workflow-file': ['workflowFileAction'],
}

/** The set of all android input keys we govern (for the extras check). */
export const ANDROID_INPUT_KEYS: string[] = [
  'keystoreMethod', 'keystorePath', 'keystoreStorePassword', 'keystoreAlias',
  'keystoreKeyPassword', 'keystoreNewAlias', 'keystorePasswordMethod', 'keystoreCommonName',
  'serviceAccountMethod', 'serviceAccountJsonPath', 'saMethodChoice', 'playDeveloperId',
  'gcpProjectId', 'gcpProjectName', 'androidPackage', 'androidVerifyAction', 'credentialsExistChoice',
]

/**
 * Validate an incoming next_step input against the step it answers.
 *
 * Returns { ok:true } when the input carries EXACTLY ONE of the step's allowed
 * fields and no other governed android key. Otherwise { ok:false } with the
 * allowed fields + the offending extra keys for a corrective message.
 *
 * Inputs with NO governed android key always pass (plain continue / other
 * vocabularies). Steps with no allowed-field entry FAIL CLOSED for governed
 * keys (hostile-review 2026-06-12): an android field sent at an auto step, at
 * the google-sign-in park, or before the android flow has rendered its first
 * step ('welcome', i.e. null progress) is never a legitimate answer — letting
 * it through allowed jumping the keystore phase past the credentials-exist
 * data-safety gate (which is seeded only when the flow renders
 * keystore-method-select).
 *
 * @param currentStep the resume step the user is currently on
 * @param input the next_step input object
 */
export function validateStepInput(
  currentStep: AndroidOnboardingStep,
  input: Record<string, unknown>,
): { ok: boolean, allowedFields?: string[], extras: string[] } {
  const allowed = STEP_ALLOWED_FIELDS[currentStep]
  const presentAndroidKeys = ANDROID_INPUT_KEYS.filter(k => input[k] !== undefined && input[k] !== null)
  if (presentAndroidKeys.length === 0)
    return { ok: true, extras: [] } // no governed key — nothing to gate
  if (!allowed)
    return { ok: false, extras: presentAndroidKeys } // fail closed — see doc above
  const presentAllowed = presentAndroidKeys.filter(k => allowed.includes(k))
  const extras = presentAndroidKeys.filter(k => !allowed.includes(k))
  // Exactly one allowed field, and no other governed key. (One field per call.)
  const ok = presentAllowed.length === 1 && extras.length === 0
  return { ok, allowedFields: allowed, extras }
}

/**
 * Content validation for the keystore store-password steps, mirroring the ink
 * TUI onSubmit guards in app.tsx so the stateless MCP path enforces the SAME
 * rule before a value is persisted (and before it can reach keystore-generating):
 *
 *   - keystore-new-store-password  → reject < 6 chars (app.tsx:2575,
 *     'Password must be at least 6 characters')
 *   - keystore-existing-store-password → reject empty (app.tsx:2455,
 *     'Store password cannot be empty')
 *
 * Returns { ok:true } when the value passes (or the step is not a store-password
 * step). On failure returns { ok:false, message } with the exact main wording so
 * the gate can re-render the current step with a corrective summary and persist
 * nothing.
 *
 * @param currentStep the resume step the user is currently on
 * @param storePassword the supplied keystoreStorePassword (or undefined/null)
 */
export function validateStorePassword(
  currentStep: AndroidOnboardingStep,
  storePassword: string | undefined | null,
): { ok: boolean, message?: string } {
  if (storePassword === undefined || storePassword === null)
    return { ok: true }
  if (currentStep === 'keystore-new-store-password') {
    if (storePassword.length < 6)
      return { ok: false, message: 'Password must be at least 6 characters' }
    return { ok: true }
  }
  if (currentStep === 'keystore-existing-store-password') {
    if (storePassword.length === 0)
      return { ok: false, message: 'Store password cannot be empty' }
    return { ok: true }
  }
  return { ok: true }
}

// ─── iOS strict step-input gate (S6a — the granular shared-engine path) ───────
//
// Mirrors the android gate above for the iOS input keys the MCP governs. Two
// vocabularies exist:
//
//   - The ASC API key trio (p8Path / keyId / issuerId). Unlike android, the MCP
//     deliberately collects ALL THREE in one 'ios-api-key' human gate (the
//     current UX, pinned by the e2e tree), so the rule here is "at least one of
//     the trio, and no other governed iOS key" — not exactly-one. The trio is
//     accepted on every step the single gate (or the ios-credentials-failed
//     re-collect gate) can park over: the TUI-only .p8 chain, verifying-key,
//     and the create-new auto steps whose failure routes to the re-collect gate
//     (verify-app / creating-certificate / creating-profile /
//     saving-credentials).
//
//   - The verify-app gate pick (verifyAction, plus verifyAppId ONLY together
//     with verifyAction='pick'). Accepted ONLY while the engine is parked on
//     'verify-app' — anywhere else a stale/early verifyAction is rejected so it
//     can never be silently merged into the session and replayed later.
//
// Unlike the android gate (which passes ungoverned steps), an iOS key sent at a
// step with no entry is REJECTED — every interactive iOS state the MCP renders
// has an entry here, so an off-step key is always an agent mistake.

const IOS_TRIO_FIELDS = ['p8Path', 'keyId', 'issuerId']
const IOS_VERIFY_FIELDS = ['verifyAction', 'verifyAppId']

/**
 * The S6b recovery vocabulary: each field answers EXACTLY ONE parked recovery
 * step (the session-derived park, not a resume-derivable step — see
 * engine.ts iosParkedStep). A recovery field anywhere else is always an agent
 * mistake (stale/early answer) and is rejected so it can never be silently
 * merged into the session and replayed later.
 */
const IOS_RECOVERY_FIELD_STEPS: Record<string, OnboardingStep> = {
  certToRevoke: 'cert-limit-prompt',
  duplicateProfileAction: 'duplicate-profile-prompt',
  errorAction: 'error',
}
const IOS_RECOVERY_FIELDS = Object.keys(IOS_RECOVERY_FIELD_STEPS)

/**
 * The S12 import-fork vocabulary: each field answers EXACTLY ONE step of the
 * iOS import-existing sub-flow — the setup-method fork + the persisted
 * distribution fork (resume-derivable) and the session-parked EPHEMERAL import
 * prompts (engine.ts parkedImportStep). Like the recovery fields, an import
 * field sent anywhere else is a stale/early answer and is rejected so it can
 * never be silently merged into the session and replayed later.
 */
const IOS_IMPORT_FIELD_STEPS: Record<string, OnboardingStep> = {
  setupMethod: 'setup-method-select',
  importDistribution: 'import-distribution-mode',
  identityChoice: 'import-pick-identity',
  profileChoice: 'import-pick-profile',
  importRecoveryAction: 'import-no-match-recovery',
  portalAction: 'import-portal-explanation',
  profilePath: 'import-provide-profile-path',
  exportConfirm: 'import-export-warning',
}
const IOS_IMPORT_FIELDS = Object.keys(IOS_IMPORT_FIELD_STEPS)

/** The set of all iOS input keys the MCP governs (for the extras check). */
export const IOS_INPUT_KEYS: string[] = [...IOS_TRIO_FIELDS, ...IOS_VERIFY_FIELDS, ...IOS_RECOVERY_FIELDS, ...IOS_IMPORT_FIELDS]

/** Steps that accept the ASC API key trio (the single ios-api-key gate + the re-collect gate). */
const IOS_TRIO_STEPS = new Set<OnboardingStep>([
  'welcome',
  'setup-method-select',
  'api-key-instructions',
  'p8-method-select',
  'input-p8-path',
  'input-key-id',
  'input-issuer-id',
  'verifying-key',
  // Post-verify auto steps: a failure there parks the user on the structured
  // 'error' recovery (or, for non-engine throws, the ios-credentials-failed
  // re-collect gate), whose persisted resume step is the failing auto step —
  // corrected key details must be accepted from it.
  'verify-app',
  'creating-certificate',
  'creating-profile',
  'saving-credentials',
  // The parked structured error screen ALSO accepts corrected key details (the
  // re-collect arm folded into the recovery menu): supplying the trio clears
  // the error park and resumes the failing phase with the new values.
  'error',
])

/**
 * Validate incoming iOS next_step input against the step it answers.
 *
 * Returns { ok:true } when the input is a legitimate answer for `currentStep`
 * (see the vocabulary rules above). Otherwise { ok:false, message } with a
 * corrective instruction for the agent. Inputs with NO governed iOS key always
 * pass — the android gate (and the rest of drive()) owns those.
 *
 * @param currentStep the iOS step the user is currently on (the session-parked
 *   recovery step when one is parked, else the resume step — see
 *   engine.ts effectiveIosStep)
 * @param input the next_step input object
 */
export function validateIosStepInput(
  currentStep: OnboardingStep,
  input: Record<string, unknown>,
): { ok: boolean, message?: string } {
  const present = IOS_INPUT_KEYS.filter(k => input[k] !== undefined && input[k] !== null)
  if (present.length === 0)
    return { ok: true }

  const trio = present.filter(k => IOS_TRIO_FIELDS.includes(k))
  const verify = present.filter(k => IOS_VERIFY_FIELDS.includes(k))
  const recovery = present.filter(k => IOS_RECOVERY_FIELDS.includes(k))
  const importPicks = present.filter(k => IOS_IMPORT_FIELDS.includes(k))

  // ── Recovery vocabulary (S6b) ──────────────────────────────────────────────
  if (recovery.length > 0) {
    // Never mix a recovery answer with anything else (one answer per call).
    if (recovery.length > 1 || trio.length > 0 || verify.length > 0 || importPicks.length > 0) {
      const keep = recovery[0]
      const remove = present.filter(k => k !== keep)
      return {
        ok: false,
        message: `Send ONE answer per call: either the App Store Connect key fields ({ ${IOS_TRIO_FIELDS.join(', ')} }), a verify-app action ({ verifyAction }), or a single recovery action ({ ${IOS_RECOVERY_FIELDS.join(' } / { ')} }) — never a mix. Remove: ${remove.join(', ')}.`,
      }
    }
    const field = recovery[0]
    const target = IOS_RECOVERY_FIELD_STEPS[field]
    if (currentStep !== target) {
      return {
        ok: false,
        message: `${field} answers only the ${target} step, which is not the current step. Answer the current step instead.`,
      }
    }
    return { ok: true }
  }

  // ── Import-fork vocabulary (S12) ───────────────────────────────────────────
  // One import answer per call, never mixed with the trio / verify-app
  // vocabularies, and only at the exact step the field answers.
  if (importPicks.length > 0) {
    if (importPicks.length > 1 || trio.length > 0 || verify.length > 0) {
      const keep = importPicks[0]
      const remove = present.filter(k => k !== keep)
      return {
        ok: false,
        message: `Send ONE answer per call: a single import-flow answer ({ ${IOS_IMPORT_FIELDS.join(' } / { ')} }) must not be mixed with other iOS fields. Remove: ${remove.join(', ')}.`,
      }
    }
    const field = importPicks[0]
    const target = IOS_IMPORT_FIELD_STEPS[field]
    if (currentStep !== target) {
      return {
        ok: false,
        message: `${field} answers only the ${target} step, which is not the current step. Answer the current step instead.`,
      }
    }
    return { ok: true }
  }

  // Never mix the two vocabularies in one call (the one-answer-per-call rule).
  if (trio.length > 0 && verify.length > 0) {
    return {
      ok: false,
      message: `Send ONE answer per call: either the App Store Connect key fields ({ ${IOS_TRIO_FIELDS.join(', ')} }) or a verify-app action ({ verifyAction }), never both — remove: ${(currentStep === 'verify-app' && verify.length > 0 ? trio : verify).join(', ')}.`,
    }
  }

  if (verify.length > 0) {
    if (currentStep !== 'verify-app') {
      return {
        ok: false,
        message: 'verifyAction answers only the verify-app step, which is not the current step. Answer the current step instead.',
      }
    }
    if (input.verifyAction === undefined || input.verifyAction === null) {
      return {
        ok: false,
        message: 'verifyAppId is only valid together with verifyAction: "pick". Call next_step with verifyAction (and verifyAppId only when picking an app).',
      }
    }
    if (input.verifyAppId !== undefined && input.verifyAppId !== null && input.verifyAction !== 'pick') {
      return {
        ok: false,
        message: 'verifyAppId is only valid together with verifyAction: "pick" — remove verifyAppId, or use verifyAction: "pick".',
      }
    }
    return { ok: true }
  }

  // ASC API key trio.
  if (!IOS_TRIO_STEPS.has(currentStep)) {
    return {
      ok: false,
      message: `The current step (${currentStep}) does not take App Store Connect key fields. Answer the current step instead.`,
    }
  }
  return { ok: true }
}

// ─── Tail strict step-input gate (S9-S11 — the post-build CI/workflow steps) ──
//
// Mirrors the android/iOS gates for the tail answer fields. One field per step
// FAMILY (ciSecretAction covers the six CI-secret choice steps; exportEnvAction
// covers the two .env steps; the rest are 1:1) — the gate enforces:
//
//   - one answer per call (exactly one tail family field; envExportPath is the
//     only companion, valid solely with exportEnvAction 'yes');
//   - off-step rejection (the field must answer the CURRENT parked/resume step);
//   - the per-step value vocabulary, copied from tail/flow.ts's TailInput +
//     option tables (e.g. confirm-secrets-push takes 'confirm'|'cancel' ONLY);
//   - dynamic vocabularies where the TUI options are inventory-derived:
//     ci-secrets-target-select accepts the DETECTED providers (+ 'skip'),
//     pick-build-script accepts the surfaced script names (+ escapes) — both
//     degrade to the static vocabulary when the park was lost (restart).

/** The tail family answer fields (one per step family; envExportPath is the ask-export-env companion). */
export const TAIL_FAMILY_FIELDS = ['ciSecretAction', 'githubActionsSetup', 'exportEnvAction', 'packageManager', 'buildScript', 'buildScriptCustom', 'workflowFileAction'] as const

/** Every tail input key the MCP governs (for presence/extras checks). */
export const TAIL_INPUT_KEYS: string[] = [...TAIL_FAMILY_FIELDS, 'envExportPath']

/** step → the single tail family field that answers it. */
const TAIL_STEP_FIELD: Record<string, string> = {
  'ci-secrets-setup': 'ciSecretAction',
  'ci-secrets-target-select': 'ciSecretAction',
  'ask-ci-secrets': 'ciSecretAction',
  'confirm-ci-secret-overwrite': 'ciSecretAction',
  'confirm-secrets-push': 'ciSecretAction',
  'ci-secrets-failed': 'ciSecretAction',
  'ask-github-actions-setup': 'githubActionsSetup',
  'ask-export-env': 'exportEnvAction',
  'confirm-env-export-overwrite': 'exportEnvAction',
  'pick-package-manager': 'packageManager',
  'pick-build-script': 'buildScript',
  'pick-build-script-custom': 'buildScriptCustom',
  'preview-workflow-file': 'workflowFileAction',
}

/** step → the static value vocabulary (tail/flow.ts option tables, verbatim). */
const TAIL_STEP_VALUES: Record<string, string[]> = {
  'ci-secrets-setup': ['retry', 'skip'],
  'ask-ci-secrets': ['yes', 'no'],
  'confirm-ci-secret-overwrite': ['replace', 'skip'],
  'confirm-secrets-push': ['confirm', 'cancel'],
  'ci-secrets-failed': ['retry', 'continue'],
  'ask-github-actions-setup': ['with-workflow', 'secrets-only', 'no'],
  'ask-export-env': ['yes', 'no'],
  'confirm-env-export-overwrite': ['replace', 'skip'],
  'pick-package-manager': ['bun', 'npm', 'pnpm', 'yarn'],
  'preview-workflow-file': ['write', 'view', 'cancel'],
}

/**
 * Validate an incoming tail next_step input against the step it answers.
 *
 * @param currentStep the EFFECTIVE tail step (the session-parked step when one
 *   is parked, else the platform resume step — see engine.ts)
 * @param input the next_step input object
 * @param ctx optional parked inventories for the dynamic vocabularies
 */
export function validateTailStepInput(
  currentStep: string,
  input: Record<string, unknown>,
  ctx?: { ciSecretTargets?: { provider: string }[], availableScripts?: Record<string, string> },
): { ok: boolean, message?: string } {
  const present = TAIL_FAMILY_FIELDS.filter(k => input[k] !== undefined && input[k] !== null)
  if (present.length === 0) {
    // envExportPath alone is never an answer.
    if (input.envExportPath !== undefined && input.envExportPath !== null)
      return { ok: false, message: 'envExportPath is only valid together with exportEnvAction: "yes". Call next_step with exportEnvAction (and envExportPath only when exporting).' }
    return { ok: true }
  }

  // One answer per call — never two tail family fields, never mixed with the
  // android/iOS vocabularies.
  if (present.length > 1)
    return { ok: false, message: `Send ONE answer per call — this step expects { ${TAIL_STEP_FIELD[currentStep] ?? present[0]}: ... }. Remove: ${present.filter(k => k !== (TAIL_STEP_FIELD[currentStep] ?? present[0])).join(', ')}.` }
  const foreign = [...ANDROID_INPUT_KEYS, ...IOS_INPUT_KEYS].filter(k => input[k] !== undefined && input[k] !== null)
  if (foreign.length > 0)
    return { ok: false, message: `Send ONE answer per call: a tail answer ({ ${present[0]}: ... }) must not be mixed with other onboarding fields — remove: ${foreign.join(', ')}.` }

  const field = present[0]
  const expected = TAIL_STEP_FIELD[currentStep]
  if (!expected)
    return { ok: false, message: `${field} answers a post-build CI/workflow step; the current step (${currentStep}) takes none of those fields. Answer the current step instead.` }
  if (field !== expected)
    return { ok: false, message: `${field} does not answer the current step (${currentStep}) — it expects { ${expected}: ... }.` }

  const value = String(input[field])

  // envExportPath companion rule.
  const pathPresent = input.envExportPath !== undefined && input.envExportPath !== null
  if (pathPresent && !(currentStep === 'ask-export-env' && value === 'yes'))
    return { ok: false, message: 'envExportPath is only valid together with exportEnvAction: "yes" at the ask-export-env step — remove envExportPath.' }

  // Dynamic vocabulary: the detected CI targets (+ skip).
  if (currentStep === 'ci-secrets-target-select') {
    const providers = (ctx?.ciSecretTargets ?? []).map(t => t.provider)
    const allowed = [...(providers.length > 0 ? providers : ['github', 'gitlab']), 'skip']
    if (!allowed.includes(value))
      return { ok: false, message: `ciSecretAction must be one of: ${allowed.join(', ')} (the detected destinations, or "skip").` }
    return { ok: true }
  }

  // Dynamic vocabulary: the surfaced package.json scripts (+ escapes).
  if (currentStep === 'pick-build-script') {
    if (value === '__custom__' || value === '__skip__')
      return { ok: true }
    if (value.trim().length === 0)
      return { ok: false, message: 'buildScript must be a script name from the options, "__custom__", or "__skip__".' }
    const scripts = ctx?.availableScripts
    if (scripts && !Object.hasOwn(scripts, value))
      return { ok: false, message: `buildScript "${value}" is not one of this project's scripts (${Object.keys(scripts).join(', ') || 'none found'}) — pick a listed option, "__custom__", or "__skip__".` }
    return { ok: true }
  }

  // Free-text custom build command: non-empty after trim.
  if (currentStep === 'pick-build-script-custom') {
    if (value.trim().length === 0)
      return { ok: false, message: 'buildScriptCustom must be a non-empty build command (e.g. "make web").' }
    return { ok: true }
  }

  const vocabulary = TAIL_STEP_VALUES[currentStep]
  if (vocabulary && !vocabulary.includes(value))
    return { ok: false, message: `${field} must be one of: ${vocabulary.join(', ')} at the ${currentStep} step.` }
  return { ok: true }
}

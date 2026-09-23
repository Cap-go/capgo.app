// src/build/onboarding/ios/flow.ts
//
// iOS onboarding engine skeleton. Mirrors the android engine shapes
// (android/flow.ts) so the platform-agnostic PlatformFlow adapter can wrap it
// the same way android-flow.ts wraps the android engine.
//
// BATCH 0 (scaffolding) widens the transient surface (IosStepCtx) and the
// injected-deps surface (IosEffectDeps) to the FULL driver-held shape the
// per-step logic will need — see docs/superpowers/audits/2026-06-03-ios-
// transition-graph.md "Ephemeral inventory". The actual per-step view-models,
// input mutations and async effects are still stubs, to be filled in by the
// later batches:
//   - iosViewForStep   → real per-step view-models      (BATCH 2/4/6 …)
//   - applyIosInput    → real progress mutations         (BATCH 2/4 …)
//   - runIosEffect     → real async side-effects         (BATCH 2/3/5/7 …)
//
// iOS reuses the EXISTING master types — OnboardingStep / OnboardingProgress —
// rather than inventing a parallel iOS step union.
//
// TYPING NOTE — the iOS Apple-API / CSR / macOS-signing / mobileprovision helper
// modules DO exist in this codebase (pure, injectable, with tests). The injected
// helper data types + ephemeral selections below import the REAL exported types
// from those modules directly:
//   - apple-api.ts            → AscDistributionCert / AscProfileSummary
//   - macos-signing.ts        → SigningIdentity / DiscoveredProfile / IdentityProfileMatch
//   - mobileprovision-parser  → MobileprovisionDetail
//   - csr.ts                  → CsrResult / P12Result
// Types the codebase also defines (CertificateData / ProfileData / ApiKeyData /
// EnrichedIdentityAvailability, the CI-secret + TailTransient shapes) are imported
// from types.ts / ci-secrets.ts / tail/flow.ts. The only structural type kept local
// is IosNoMatchReason — the recovery-menu reason enum has no helper-module export.

import type { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AscApp, AscDistributionCert, AscProfileSummary } from '../apple-api.js'
import type {
  ApiKeyData,
  CertificateData,
  EnrichedIdentityAvailability,
  OnboardingProgress,
  OnboardingStep,
  ProfileData,
} from '../types.js'
import type { AsyncCommandRunner, CiSecretDiscovery, CiSecretEntry, CiSecretTarget, CommandRunner } from '../ci-secrets.js'
import type { DiscoveredProfile, ExportedP12, IdentityProfileMatch, SigningIdentity } from '../macos-signing.js'
import type { MobileprovisionDetail } from '../../mobileprovision-parser.js'
// Real helper-module types the tail-aligned IosEffectDeps signatures reference —
// the SAME set tail/flow.ts imports, so `toTailDeps` maps the deps 1:1.
import type { BuildCredentials } from '../../../schemas/build.js'
import type { BuildLogger, BuildRequestOptions, BuildRequestResult } from '../../request.js'
import type { EnvExportOpts, EnvExportResult } from '../env-export.js'
import type { GeneratedWorkflow, WorkflowGeneratorOpts } from '../workflow-generator.js'
import type { WorkflowWriteOptions, WorkflowWriteResult } from '../workflow-writer.js'
// The post-save tail transient is shared with android — reuse it verbatim so the
// `saving-credentials → ask-build` handoff (BATCH 1) threads the same fields.
// BATCH 1 also delegates the WHOLE post-save tail (saving-credentials → ask-build
// → CI-secrets → env/workflow → build-complete) to the platform-neutral shared
// module via `toTailDeps` — exactly as android/flow.ts does — so the routing is
// implemented once for both platforms.
import type { TailEffectDeps, TailInput, TailStep, TailStepCtx, TailStepView, TailTransient } from '../tail/flow.js'
import { applyTailInput, runTailEffect, tailViewForStep } from '../tail/flow.js'
import { CertificateLimitError, DuplicateProfileError } from '../apple-api.js'
import { DEFAULT_P12_PASSWORD } from '../csr.js'
// classifyAppVerification / evaluateGate are PURE helpers (no IO) — importing
// them keeps the verify-app effect IO-free while reusing the exact invariant
// classification + gate-escalation logic the TUI's verify-app step uses
// (app-verification.ts, unit-tested via test-app-verification.mjs). The fetches
// (listApps / listBundleIds), the fresh pbxproj re-detect and the Path-A
// auto-fix write are injected deps; DetectedBundleIds is the TYPE-only shape of
// the injected fresh-detect dep (the real detectIosBundleIds does the FS reads
// in the driver).
import type { AppVerifyResult, AscAppLike, GatePath } from '../app-verification.js'
import { classifyAppVerification, evaluateGate } from '../app-verification.js'
import type { DetectedBundleIds } from '../bundle-id-detector.js'
// matchIdentitiesToProfiles is a PURE helper (no IO) — importing it keeps the
// import-scanning effect IO-free while reusing the exact identity↔profile pairing
// the TUI uses (app.tsx:1323). The actual scans are the injected listSigningIdentities
// / scanProvisioningProfiles deps. filterProfilesForApp / bundleIdMatches are the
// SAME pure profile-usability + wildcard-bundle-id matchers the TUI's pickers use
// (app.tsx:3296/3448/3485) — importing them keeps the BATCH 6 import-picker
// resolvers IO-free while staying byte-for-byte aligned with the TUI's branch keys.
import { bundleIdMatches, filterProfilesForApp, matchIdentitiesToProfiles } from '../macos-signing.js'
import { extractKeyIdFromP8Path, getImportEntryStep } from '../progress.js'
import { getIosResumeStep } from './progress.js'

// ─── Local structural helper types ───────────────────────────────────────────
//
// Almost every helper data type now comes from the REAL helper modules (imported
// above). The two types defined here have NO direct helper-module export:
//
//   - IosNoMatchReason   — the import-no-match-recovery menu's reason enum. It is
//     an engine-level concept, not produced by any helper module, so it stays local.
//   - IosDuplicateProfile — the duplicate-Capgo-profile shape surfaced by
//     apple-api's findCapgoProfiles() / DuplicateProfileError.profiles, which is the
//     inline `{ id, name, profileType }` triple. apple-api does not export a named
//     type for that triple, so we derive a minimal one from AscProfileSummary (the
//     richest exported profile shape) via Pick — keeping it tied to the real source.

/**
 * Stable reason an identity has no usable matching profile. Drives the
 * `import-no-match-recovery` menu variant. (Mirrors the `noMatchReason` enum.)
 */
export type IosNoMatchReason
  = | 'apple-no-cert-match'
    | 'apple-no-profiles-linked'
    | 'apple-bundle-mismatch'
    | 'apple-distribution-mismatch'
    | 'apple-other'
    | 'no-profile-on-disk'

/**
 * A duplicate Capgo provisioning profile (creating-profile / import-create).
 * Matches the `{ id, name, profileType }` triple returned by apple-api's
 * findCapgoProfiles() and carried on DuplicateProfileError.profiles. Derived
 * from the real AscProfileSummary so it tracks any future field additions.
 */
export type IosDuplicateProfile = Pick<AscProfileSummary, 'id' | 'name' | 'profileType'>

// ─── Types ────────────────────────────────────────────────────────────────────

export type IosStepKind = 'auto' | 'input' | 'choice' | 'done' | 'error'

export interface IosStepOption {
  value: string
  label?: string
  note?: string
}

export interface IosStepView {
  step: OnboardingStep
  kind: IosStepKind
  title?: string
  prompt?: string // 'input' steps
  collect?: string[] // field(s) an 'input' step gathers
  options?: IosStepOption[] // 'choice' steps
  message?: string // 'done' | 'error'
}

/**
 * Per-step runtime context the driver supplies to the view builder AND threads
 * back through `IosEffectResult.transient` between effects. EVERY field is
 * OPTIONAL so a caller that only passes `{ appId }` still gets a usable view.
 *
 * This is the iOS "ephemeral inventory" — driver-held transient state that is
 * NEVER persisted to progress.json (it carries Apple-side selections + raw
 * cert/profile/keychain payloads). The total resume function (getIosResumeStep)
 * NEVER produces a step that depends on these — on resume the driver re-runs the
 * silent inventory (import-scanning) and re-renders the picker. See the audit's
 * "Ephemeral inventory" section for the producer/consumer map.
 */
export interface IosStepCtx {
  appId?: string

  // ── Import-flow selections (the core ephemeral set) ──────────────────────
  /** Selected signing identity (import-pick-identity). REQUIRED by import-exporting. */
  chosenIdentity?: SigningIdentity
  /** Selected provisioning profile (import-pick-profile). REQUIRED by import-exporting. */
  chosenProfile?: DiscoveredProfile
  /** Discovery result list from import-scanning (identities + on-disk profiles). */
  importMatches?: IdentityProfileMatch[]
  /** Scanned on-disk profiles (paired with importMatches). */
  importProfiles?: DiscoveredProfile[]
  /** Per-identity Apple-side availability (import-validating-all-certs). */
  identityAvailability?: Record<string, EnrichedIdentityAvailability>
  /** Per-identity prefetched Apple profiles (parallel prefetch after validation). */
  profilePrefetch?: Record<string, DiscoveredProfile[]>
  /** Apple cert resource id for the chosen identity (import-checking-apple-cert). */
  _appleCertIdForChosen?: string
  /** Why the chosen identity has no usable profile — drives the recovery menu. */
  noMatchReason?: IosNoMatchReason

  // ── Cert-limit & duplicate-profile recovery (ephemeral) ──────────────────
  /** Duplicate Capgo profiles (creating-profile / import-create-profile-only). */
  duplicateProfiles?: IosDuplicateProfile[]
  /** Existing Apple certs offered for revocation when the cert limit is hit. */
  existingCerts?: AscDistributionCert[]
  /** The user's revoke selection (cert-limit-prompt → revoking-certificate). */
  certToRevoke?: AscDistributionCert

  // ── Import recovery menu gating (BATCH 7a) ───────────────────────────────
  /**
   * Whether the host can show a native file picker — gates the
   * import-no-match-recovery / import-portal-explanation "use a .mobileprovision
   * from disk" option (the TUI's canUseFilePicker(), app.tsx:3570/3733). The
   * DRIVER threads the host capability here; the view defaults it to true (the
   * macOS-first onboarding target) so a caller that only passes { appId } still
   * gets the file-picker recovery option.
   */
  canUseFilePicker?: boolean

  // ── Cert/profile export payloads (resolved once, carried to saving-credentials) ──
  /** Resolved certificate data (creating-profile create-new / import-exporting). */
  certData?: CertificateData
  /** Resolved profile data (creating-profile create-new / import-exporting). */
  profileData?: ProfileData
  /** Apple team id resolved alongside certData/profileData. */
  teamId?: string
  /** Keychain export password (import-exporting). Transient only. */
  importedP12Password?: string

  // ── .p8 validation buffer (ephemeral during input-p8-path) ───────────────
  /** Buffer of .p8 file content during validation (only the PATH is persisted). */
  p8Content?: Buffer
  /**
   * True once the p8-method-select file-picker effect has opened the native
   * dialog this drive — the engine returns it in transient and the driver
   * threads it back as `deps.carried.pickerOpened` so a re-render does NOT
   * re-open the picker. Mirrors the TUI's `pickerOpenedRef` guard.
   */
  pickerOpened?: boolean
  /**
   * True once the import-provide-profile-path .mobileprovision picker has opened
   * the native dialog this drive — returned in transient and threaded back as
   * `deps.carried.profilePickerOpened` so a re-render does NOT re-open the
   * picker. SEPARATE from `pickerOpened` (the .p8 picker). Mirrors the TUI's
   * `mobileprovisionPickerOpenedRef` guard (app.tsx:1689).
   */
  profilePickerOpened?: boolean

  // ── ASC API key data surfaced after verifying-key (ephemeral mirror) ─────
  /** Verified key id + issuer id (mirror of completedSteps.apiKeyVerified). */
  apiKey?: ApiKeyData

  // ── verify-app remote App Store verification (PR #2397 port — EPHEMERAL) ─
  /** ASC apps fetched by the verify-app effect (picker source + Path B re-poll). */
  verifyApps?: AscApp[]
  /** Registered Developer-portal bundle ids (diagnostic — sharpens Path B wording). */
  verifyRegisteredIds?: string[]
  /** The authoritative Release build id, re-detected FRESH from disk ('' = unresolved). */
  verifyReleaseBundleId?: string
  /** The Debug-config bundle id when it differs from Release (else ''). */
  verifyDebugBundleId?: string
  /** True when Debug + Release literal ids both exist AND differ (awareness note + telemetry). */
  verifyDebugReleaseDiffer?: boolean
  /**
   * The verify-app classification (the pure classifyAppVerification result),
   * widened with the two pass-through outcomes ('fetch-failed' /
   * 'no-release-config') so the driver's Result telemetry mirrors the TUI's.
   * Present once the initial fetch has run — its absence is what makes
   * iosViewForStep render verify-app as an AUTO effect instead of the gate.
   */
  verifyResult?: AppVerifyResult | 'fetch-failed' | 'no-release-config'
  /** Which gate path the user is on (null = the picker). */
  verifyPath?: GatePath | null
  /** The existing app picked in Path A (its bundleId is the target to match). */
  verifyChosenApp?: AscAppLike | null
  /** 1-based count of blocked Continue attempts (drives the escalating warning). */
  verifyAttempt?: number
  /** Path B: ask before re-opening the browser after a blocked re-poll. */
  verifyAskReopen?: boolean
  /** Where verify-app routes on pass/pass-through (set by verifying-key on import). */
  pendingVerifyNext?: OnboardingStep

  // ── Error step transient (BATCH 8 — EPHEMERAL, NEVER persisted) ──────────
  // The error screen's content. The failing effect sets transient.error (the
  // human message it surfaced via deps.onLog) and, when the failure is
  // recoverable, transient.retryStep (the step to re-run). The driver threads
  // both back as deps.carried so the error VIEW renders the message + a retry
  // action and the error RESOLVER (runIosEffect('error')) routes a retry to
  // carried.retryStep. Mirrors the Ink TUI's setError + setRetryStep + the
  // ErrorStep retry/restart/exit Select (ui/app.tsx:1087-1122 / 4454-4485).
  // RISK: these MUST stay off progress.json — an error is transient runtime
  // state, exactly like the android engine's wrongPassword signal. getIosResumeStep
  // never returns 'error', so a resume always re-enters the failing phase fresh.
  /** Human-readable error message the error view renders (failing step's message). */
  error?: string
  /** The step to re-run when the user picks "Try again" (absent = no retry offered). */
  retryStep?: OnboardingStep

  // ── Shared post-save tail transient (reused verbatim from android) ───────
  // The same fields the android engine threads after saving-credentials. Spread
  // in so the `saving-credentials → ask-build` handoff (BATCH 1) carries them.
  ciSecretEntries?: TailTransient['ciSecretEntries']
  savedCredentials?: TailTransient['savedCredentials']
  ciSecretTargets?: TailTransient['ciSecretTargets']
  ciSecretSetupAdvice?: TailTransient['ciSecretSetupAdvice']
  ciSecretRepoLabel?: TailTransient['ciSecretRepoLabel']
  ciSecretExistingKeys?: TailTransient['ciSecretExistingKeys']
  ciSecretUploadSummary?: TailTransient['ciSecretUploadSummary']
  envExportPath?: TailTransient['envExportPath']
  workflowFilePath?: TailTransient['workflowFilePath']
  buildUrl?: TailTransient['buildUrl']
  buildOutput?: TailTransient['buildOutput']
  aiJobId?: TailTransient['aiJobId']
  // The with-workflow script preload (uploading-ci-secrets) + env-export error +
  // ci-secrets-failed reason the post-save tail surfaces. Mirror the remaining
  // TailTransient fields so the iOS driver can read the full tail result.
  availableScripts?: TailTransient['availableScripts']
  recommendedScript?: TailTransient['recommendedScript']
  envExportError?: TailTransient['envExportError']
  ciSecretError?: TailTransient['ciSecretError']
}

/**
 * Async dependencies the iOS effects need (Apple API client, CSR + keychain
 * export, mobileprovision parsing, persistence, the shared tail helpers, and
 * status/log callbacks). EVERY helper is OPTIONAL and ADDITIVE so a driver can
 * inject only what the path it drives needs and the skeleton's stubs keep
 * type-checking. Data types are the REAL exports from apple-api / macos-signing /
 * mobileprovision-parser / csr; only the call-shape envelopes are engine-local.
 */
export interface IosEffectDeps {
  appId?: string

  // ── apple-api ────────────────────────────────────────────────────────────
  /** Verify an ASC API key (keyId + issuerId via the .p8). */
  verifyApiKey?: (args: { keyId: string, issuerId: string, p8Content: Buffer }) => Promise<{ teamId?: string }>
  /**
   * Create a distribution certificate from a CSR. Returns the RAW Apple cert
   * response (mirrors the real apple-api `createCertificate` helper): the cert
   * resource id, the base64 DER `certificateContent`, the expiry, and the team
   * id. The engine pairs `certificateContent` + the CSR private key via
   * `createP12` to produce the final .p12 — keeping the IO-free engine in charge
   * of assembling the CertificateData credential. Throws CertificateLimitError
   * (carrying the existing certs) when Apple's per-team cert limit is hit.
   */
  createCertificate?: (args: { csr: string, accessToken?: string }) => Promise<{
    certificateId: string
    certificateContent: string
    expirationDate: string
    teamId: string
  }>
  /** Revoke an existing certificate (cert-limit recovery). */
  revokeCertificate?: (certificateId: string) => Promise<void>
  /** Create a provisioning profile for a bundle id + cert. */
  createProfile?: (args: { bundleId: string, certificateId: string, distribution?: string }) => Promise<ProfileData>
  /** Delete a provisioning profile (duplicate-profile recovery). */
  deleteProfile?: (profileId: string) => Promise<void>
  /** Resolve the Apple cert resource id from a local cert SHA-1. */
  findCertIdBySha1?: (sha1: string) => Promise<string | null>
  /** Classify a cert's Apple-side availability (import-validating-all-certs). */
  classifyCertAvailability?: (identity: SigningIdentity) => Promise<EnrichedIdentityAvailability>
  /** List the team's distribution certificates (cert-limit prompt). */
  listCertificates?: () => Promise<AscDistributionCert[]>
  /** Check for duplicate Capgo profiles for a bundle id. */
  checkDuplicateProfiles?: (bundleId: string) => Promise<IosDuplicateProfile[]>
  /** Ensure the bundle id exists on Apple (import-create-profile-only). */
  ensureBundleId?: (bundleId: string) => Promise<void>
  /**
   * List the Apple profiles linked to a cert (import-checking-apple-cert).
   *
   * Returns the RAW Apple shape (AscProfileSummary[]) exactly as the real
   * apple-api `listProfilesForCert` helper does — id / name / profileType /
   * profileContent / expirationDate / bundleIdentifier. The engine itself
   * synthesizes each summary into a DiscoveredProfile (populating profileBase64
   * + certificateSha1s=[identity.sha1]) via `synthesizeProfileFromAscSummary`,
   * byte-for-byte mirroring the TUI's inline mapping at app.tsx:1556 / :1460.
   * Keeping the dep at the raw Apple shape means the driver pre-binds nothing
   * more than the real helper.
   */
  listProfilesForCert?: (certificateId: string) => Promise<AscProfileSummary[]>

  // ── verify-app (remote App Store Connect verification, PR #2397 port) ─────
  /** List every ASC app visible to the API key (verify-app fetch + Path B re-poll). */
  listApps?: () => Promise<AscApp[]>
  /** List every registered bundle-id identifier (verify-app diagnostics). */
  listBundleIds?: () => Promise<string[]>
  /**
   * FRESH bundle-id detection from disk (verify-app + the Path-A re-check). The
   * driver pre-binds the real `detectIosBundleIds({ cwd, iosDir, capacitorAppId })`
   * — the engine reads `releaseResolved`/`pbxproj` for the authoritative Release
   * id, `debug`/`debugReleaseDiffer` for the awareness note, and `capacitor` for
   * the persisted iosBundleIdContextAppId snapshot. Called PER CHECK so an edit
   * the user made since the wizard started is picked up (the TUI bypasses its
   * memo the same way, app.tsx:1522/3088).
   */
  detectBundleIds?: () => DetectedBundleIds
  /**
   * Rewrite the Release PRODUCT_BUNDLE_IDENTIFIER assignments equal to `fromId`
   * to `toId` in the Xcode project (the Path-A auto-fix). The driver pre-binds
   * the real `writeReleaseBundleId(cwd, iosDir, …)`; returns the number of
   * replaced assignments (0 = nothing matched). Throws only on an FS error.
   */
  writeReleaseBundleId?: (fromId: string, toId: string) => { changed: number }

  // ── csr ────────────────────────────────────────────────────────────────
  /** Generate a CSR + private key PEM. */
  generateCsr?: (args?: { commonName?: string }) => { csr: string, privateKeyPem: string }
  /** Build a .p12 from a cert + private key. Returns base64. */
  createP12?: (args: { certificatePem: string, privateKeyPem: string, password: string }) => string

  // ── macos-signing ────────────────────────────────────────────────────────
  /** List the Mac's code-signing identities (import-scanning). */
  listSigningIdentities?: () => Promise<SigningIdentity[]>
  /** Scan the Mac's on-disk provisioning profiles (import-scanning). */
  scanProvisioningProfiles?: () => Promise<DiscoveredProfile[]>
  /**
   * Export a .p12 (cert + key) from the Keychain for the chosen identity
   * (import-exporting). Signature mirrors the REAL macos-signing helper VERBATIM:
   * takes the identity's SHA-1 and resolves to { base64, passphrase } (the
   * auto-generated wrap passphrase becomes the transient importedP12Password the
   * saving-credentials handoff reads — NEVER persisted, risk #2 / D-iOS-3).
   */
  exportP12FromKeychain?: (targetSha1: string) => Promise<ExportedP12>

  // ── mobileprovision-parser ───────────────────────────────────────────────
  /** Parse a `.mobileprovision` file in detail (import-provide-profile-path). */
  parseMobileprovisionDetailed?: (bytes: Buffer) => MobileprovisionDetail

  // ── persistence (the iOS progress equivalents of the android deps) ───────
  loadProgress?: (appId: string) => Promise<OnboardingProgress | null>
  saveProgress?: (appId: string, progress: OnboardingProgress) => Promise<void>
  deleteProgress?: (appId: string) => Promise<void>
  /** Persist the saved build-credential map (saving-credentials). */
  updateSavedCredentials?: (appId: string, platform: 'ios' | 'android', credentials: Record<string, string>) => Promise<void>
  loadSavedCredentials?: (appId: string) => Promise<unknown>

  // ── file system (injected so effects can be tested without real FS) ──────
  readFile?: (path: string) => Promise<Buffer>
  copyFile?: (src: string, dest: string) => Promise<void>
  /**
   * Open the native .p8 file picker (p8-method-select). Resolves to the chosen
   * absolute path, or null when the user cancels. The driver pre-binds the real
   * `openFilePicker` here; tests inject a canned path/null. Mirrors the TUI's
   * `openFilePicker()` call inside the p8-method-select effect.
   */
  openP8FilePicker?: () => Promise<string | null>
  /**
   * Open the native .mobileprovision file picker (import-provide-profile-path).
   * Resolves to the chosen absolute path, or null when the user cancels. The
   * driver pre-binds the real `openMobileprovisionPicker` here; tests inject a
   * canned path/null. Mirrors the TUI's `openMobileprovisionPicker()` call
   * inside the import-provide-profile-path effect (app.tsx:1696). The bytes are
   * then read via `deps.readFile` and parsed via `deps.parseMobileprovisionDetailed`.
   */
  openProfilePicker?: () => Promise<string | null>
  /**
   * Whether the host can show a native file picker. Gates the
   * import-no-match-recovery / import-portal-explanation "use a .mobileprovision
   * from disk" option exactly as the TUI's `canUseFilePicker()` does
   * (app.tsx:3570/3733). Defaults to true when omitted (the macOS-first target).
   */
  canUseFilePicker?: () => boolean
  /**
   * Open a URL in the host's default browser (import-portal-explanation's
   * "open the portal anyway" branch). Best-effort — the driver pre-binds the
   * real `open` helper; tests inject a recorder/no-op. Mirrors the TUI's
   * `open(...)` call at app.tsx:3749. A failure must NOT abort recovery.
   */
  openExternal?: (url: string) => Promise<void> | void
  /**
   * Whether the host is macOS. Gates the post-backup fork: on macOS the user is
   * offered import-vs-create at `setup-method-select`; off-macOS the import
   * sub-flow is unavailable so backing-up routes straight to the create-new
   * `api-key-instructions`. Mirrors the TUI's `isMacOS()` branch. Defaults to
   * true when omitted (the macOS-first onboarding target).
   */
  isMacOS?: () => boolean

  // ── shared post-save tail helpers (wired through toTailDeps in BATCH 1) ──
  // Reused from the android surface so the iOS engine can delegate the post-save
  // tail to runTailEffect/tailViewForStep/applyTailInput. The signatures mirror
  // the real helper modules VERBATIM (the same shapes TailEffectDeps expects) so
  // `toTailDeps` maps them 1:1 with no coercion, exactly as android/flow.ts does.
  createCiSecretEntries?: (credentials: Partial<BuildCredentials>, apiKey?: string) => CiSecretEntry[]
  detectCiSecretTargets?: (runner?: CommandRunner) => CiSecretDiscovery
  getCiSecretRepoLabelAsync?: (target: CiSecretTarget, runner?: AsyncCommandRunner) => Promise<string | null>
  listExistingCiSecretKeysAsync?: (target: CiSecretTarget, keys: string[], runner?: AsyncCommandRunner) => Promise<string[]>
  uploadCiSecretsAsync?: (
    target: CiSecretTarget,
    entries: CiSecretEntry[],
    existingKeys?: string[],
    runner?: AsyncCommandRunner,
    onProgress?: (current: number, total: number, keyName: string) => void,
  ) => Promise<void>
  exportCredentialsToEnv?: (opts: EnvExportOpts) => EnvExportResult
  defaultExportPath?: (appId: string, platform: 'ios' | 'android') => string
  /** Lockfile-based package-manager detection (the pick-package-manager 'recommended' note). */
  detectPackageManager?: () => string
  generateWorkflow?: (opts: WorkflowGeneratorOpts) => GeneratedWorkflow
  writeWorkflowFile?: (opts: WorkflowGeneratorOpts, writeOptions?: WorkflowWriteOptions) => WorkflowWriteResult
  requestBuildInternal?: (appId: string, options: BuildRequestOptions, silent?: boolean, logger?: BuildLogger) => Promise<BuildRequestResult>

  // ── streaming / telemetry / preload sinks (forwarded into the shared tail) ──
  // The post-save tail's requesting-build / checking-ci-secrets / uploading-ci-
  // secrets / writing-workflow-file effects stream into DEDICATED TUI sinks
  // (distinct from the side-log onLog). These mirror the android surface VERBATIM
  // so `toTailDeps` forwards them 1:1 into the shared TailEffectDeps; all OPTIONAL
  // so a headless caller that omits them degrades gracefully (the engine no-ops).
  /** The streaming BuildLogger threaded into requestBuildInternal (4th arg). */
  logger?: BuildLogger
  /** The build VIEWER sink (FullscreenBuildOutput), distinct from onLog. */
  onBuildOutput?: (line: string) => void
  /** Resolves the Capgo API key for the build request (CLI-flag-over-saved). */
  resolveApikey?: () => string | undefined
  /** Per-key CI-secret upload progress (uploadCiSecretsAsync 5th arg). */
  onCiSecretUploadProgress?: (current: number, total: number, keyName: string) => void
  /** The 2-phase checking-ci-secrets status text. */
  onCiSecretCheckPhase?: (phase: string) => void
  /** The ci-secrets-failed reason. */
  onCiSecretError?: (message: string) => void
  /** Reads the project's package.json scripts map (with-workflow preload). */
  getPackageScripts?: () => Record<string, string>
  /** Detects the web-framework project type (best-effort; may resolve null). */
  findProjectType?: (options?: { quiet?: boolean }) => Promise<string | null>
  /** Maps a detected project type to its recommended build script name. */
  findBuildCommandForProjectType?: (projectType: string) => Promise<string | null>
  /** Workflow-file telemetry hook (e.g. 'workflow-file-written'). */
  trackWorkflowEvent?: (event: string, options?: { decision?: string }) => void

  /**
   * DRIVER-HELD transient tail state threaded back into each post-save effect.
   * The TUI resolves these ONCE (at saving-credentials) and keeps them in React
   * state; a headless driver mirrors that by capturing the matching
   * IosEffectResult.transient and passing it back here on the NEXT effect.
   * NEVER persisted to progress.json. When absent (crash-recovery resume) the
   * effect falls back to a single lossy re-derivation from progress.
   */
  carried?: {
    savedCredentials?: Record<string, string>
    ciSecretEntries?: CiSecretEntry[]
    ciSecretExistingKeys?: string[]
    /**
     * Whether the workflow file did NOT exist when previewed (the TUI's
     * `previewIsNew`, resolved at preview-workflow-file via existsSync). The
     * writing-workflow-file effect logs '✔ Wrote' vs '✔ Overwrote' from it.
     * Absent defaults to NEW ('Wrote'). EPHEMERAL — never persisted.
     */
    workflowIsNew?: boolean
    /** The chosen signing identity (lossy re-scan source on resume). */
    chosenIdentity?: SigningIdentity
    /** The chosen provisioning profile (lossy re-scan source on resume). */
    chosenProfile?: DiscoveredProfile
    /**
     * The import-scanning discovery inventory (identity↔on-disk-profile matches +
     * the raw scanned profiles), threaded forward so the NEXT import effect can
     * read it without a re-scan. Produced by import-scanning into transient; the
     * driver mirrors it back here for import-validating-all-certs (which batches
     * classifyCertAvailability over importMatches) and the pickers. EPHEMERAL —
     * never persisted; on a crash-recovery resume the engine re-lands on
     * import-scanning and re-populates it.
     */
    importMatches?: IdentityProfileMatch[]
    importProfiles?: DiscoveredProfile[]
    /** Resolved cert/profile/team export payloads carried into saving-credentials. */
    certData?: CertificateData
    profileData?: ProfileData
    teamId?: string
    /**
     * The validated .p8 file content (ASC private key) the driver carries
     * between the .p8 input chain and `verifying-key`. ONLY the p8Path is
     * persisted to progress.json — the raw key bytes ride this transient
     * channel, mirroring the TUI's `p8ContentRef`. The verifying-key effect
     * reads it from here; when absent (crash-recovery resume) it falls back to
     * re-reading the file at `progress.p8Path` via `deps.readFile`.
     */
    p8Content?: Buffer
    /**
     * Tracks that the p8-method-select file-picker effect already ran, so a
     * re-render does NOT re-open the native picker. Mirrors the TUI's
     * `pickerOpenedRef`. The driver threads the returned `pickerOpened: true`
     * transient back here on the next call.
     */
    pickerOpened?: boolean
    /**
     * Tracks that the import-provide-profile-path .mobileprovision file-picker
     * effect already ran this attempt, so a re-render / re-drive does NOT re-open
     * the native picker. SEPARATE from `pickerOpened` (the .p8 picker guard) so
     * the two file pickers never cross-suppress each other — mirrors the TUI's
     * distinct `mobileprovisionPickerOpenedRef` (app.tsx:1689). The driver threads
     * the returned `profilePickerOpened: true` transient back here; it RESETS the
     * flag (to false) before routing into import-provide-profile-path from the
     * recovery menu, exactly as the TUI clears the ref at app.tsx:3593.
     */
    profilePickerOpened?: boolean
    /**
     * Keychain export passphrase for the IMPORT path's .p12 (import-exporting).
     * Transient only — the import-exporting effect never persists it, so the
     * saving-credentials handoff reads it from carried. Absent on the create-new
     * path (which uses the well-known DEFAULT_P12_PASSWORD) and on a crash-recovery
     * resume that lost the in-memory state.
     */
    importedP12Password?: string
    /**
     * The existing Apple Distribution certs surfaced when the per-team cert
     * limit was hit (cert-limit recovery). Produced by `creating-certificate`
     * into transient.existingCerts; the driver threads the list back here so a
     * parked `cert-limit-prompt` re-renders (and resolves the user's pick by
     * cert id) WITHOUT re-hitting Apple. EPHEMERAL — never persisted (the TUI's
     * `existingCerts` React state); cleared together with `certToRevoke` after
     * a successful revoke. A restart that loses it re-enters via a fresh
     * creating-certificate attempt, which re-derives the list.
     */
    existingCerts?: AscDistributionCert[]
    /**
     * The cert the user picked at `cert-limit-prompt` (cert-limit recovery). The
     * choice is EPHEMERAL — `applyIosInput` persists nothing; the driver records
     * the picked AscDistributionCert here and re-drives the prompt as a resolver
     * effect, exactly as the TUI stashes `certToRevoke` in React state before
     * advancing to `revoking-certificate` (app.tsx:3923). The resolver returns
     * `revoking-certificate` when present, `error` when absent (the user exited).
     * Mirrors the BATCH 2 ephemeral-branching mechanism (`pickerOpened` /
     * `chosenIdentity`): the selection lives in carried, never in progress.json.
     */
    certToRevoke?: AscDistributionCert
    /**
     * The duplicate Capgo profiles surfaced at `duplicate-profile-prompt`
     * (duplicate-profile recovery). Produced by `creating-profile` /
     * `import-create-profile-only` into transient; the driver threads the list
     * back here so `deleting-duplicate-profiles` knows which profiles to delete.
     * NEVER persisted (only `duplicateProfileOrigin` is — see types.ts).
     */
    duplicateProfiles?: IosDuplicateProfile[]
    /**
     * The user's confirm/exit decision at `duplicate-profile-prompt`. EPHEMERAL —
     * `applyIosInput` persists nothing (per the audit's sequencing model); the
     * driver records the choice here and re-drives the prompt as a resolver
     * effect. `true` → `deleting-duplicate-profiles`; falsy (the user exited) →
     * `error` (mirroring app.tsx:3942's delete-vs-exitOnboarding branch).
     */
    confirmDeleteDuplicates?: boolean
    /**
     * The user's pick at `import-no-match-recovery` (the 5-way HUB). EPHEMERAL —
     * `applyIosInput` persists nothing; the driver records the choice here and
     * re-drives the prompt as a resolver effect. 'create' →
     * import-create-profile-only (with an ASC key) or api-key-instructions
     * (without); 'provide-profile-path' → import-provide-profile-path; 'browser'
     * → import-portal-explanation; 'back' → import-pick-identity. Mirrors the
     * TUI's recovery-menu onChange (app.tsx:3579).
     */
    recoveryAction?: 'create' | 'provide-profile-path' | 'browser' | 'back'
    /**
     * The user's pick at `import-portal-explanation` (the manual-portal
     * walkthrough). EPHEMERAL — the driver records the choice here and re-drives
     * the step as a resolver. 'use-create' → import-create-profile-only;
     * 'use-file' → import-provide-profile-path; 'open-anyway' / 'back' →
     * import-no-match-recovery. Mirrors app.tsx:3738.
     */
    portalAction?: 'use-create' | 'open-anyway' | 'use-file' | 'back'
    /**
     * The user's pick at `import-export-warning` (the heads-up before the one
     * Keychain dialog). EPHEMERAL — `applyIosInput` persists nothing; the driver
     * records the choice here and re-drives the step as a resolver. 'go' →
     * import-exporting (the precompiled signed helper is resolved + verified in
     * the export step itself — PR #2458 removed the swiftc compile step);
     * 'back' → import-pick-profile; 'exit'/absent → exit onboarding. Mirrors
     * app.tsx:3769 onChange.
     */
    exportWarningAction?: 'go' | 'back' | 'exit'
    /**
     * The STICKY no-match reason set by the step that ROUTED into recovery
     * (import-pick-identity / import-checking-apple-cert). The recovery resolver
     * + the import-provide-profile-path cancel branch thread it back so a
     * re-entry from a file-picker cancel / portal "open anyway" does NOT
     * recompute or overwrite it (risk #8) — the menu keeps showing the SAME
     * variant. Mirrors the TUI leaving `noMatchReason` untouched on back-nav.
     */
    noMatchReason?: IosNoMatchReason
    /**
     * The failing step's human error message — the error screen's content
     * (BATCH 8). EPHEMERAL — set by the failing effect into transient.error and
     * threaded back here by the driver so a parked 'error' view re-renders the
     * message (iosViewForStep('error') reads ctx.error). NEVER persisted —
     * mirrors the TUI's setError React state; a crash-recovery resume re-enters
     * the failing phase fresh.
     */
    error?: string
    /**
     * The step to re-run when the user picks "Try again" on the error screen
     * (BATCH 8). EPHEMERAL — set by the failing effect into transient.retryStep,
     * threaded back here by the driver, and read by the error RESOLVER
     * (runIosEffect('error')) to route a retry. NEVER persisted: an error is
     * transient runtime state, so a crash-recovery resume re-enters the failing
     * phase fresh (getIosResumeStep never returns 'error'). Mirrors the TUI's
     * setRetryStep + the ErrorStep 'retry' branch (app.tsx:1116 / 4468).
     */
    retryStep?: OnboardingStep
    /**
     * The user's pick on the error screen (BATCH 8). EPHEMERAL — `applyIosInput`
     * persists nothing; the driver records the choice here and re-drives the step
     * as a resolver. 'retry' → re-run carried.retryStep (the failing step);
     * 'restart' → welcome (a fresh reset); 'exit'/absent → stay on 'error' (the
     * terminal exit sink — the driver leaves onboarding, mirroring the TUI's
     * exitOnboarding at app.tsx:4482). NEVER persisted.
     */
    errorAction?: 'retry' | 'restart' | 'exit'
    // ── verify-app gate threading (PR #2397 port — ALL EPHEMERAL) ────────────
    /**
     * Where verify-app routes once the invariant holds (or on a pass-through
     * exit): the import continuation (import-validating-all-certs /
     * import-pick-identity) on the import app_store path, absent on create-new
     * (verify-app falls back to 'creating-certificate'). Produced by
     * verifying-key into transient.pendingVerifyNext; the driver threads it back
     * here. NEVER persisted — a fresh mount has none, so a resume re-entering
     * verify-app always falls back to creating-certificate (matching the TUI's
     * pendingVerifyNext React state + getResumeStep's verify-app comment).
     */
    pendingVerifyNext?: OnboardingStep
    /**
     * The user's pick on the PARKED verify-app step (the picker or one of the
     * two gates). EPHEMERAL — `applyIosInput` persists nothing; the driver
     * records the pick here and re-drives verify-app as a resolver effect:
     * 'pick' (+ verifyChosenApp) / 'create-new' route the picker; 'autofix' /
     * 'continue' drive the Path-A fix-build-id gate; 'recheck' / 'open' /
     * 'reopen' drive the Path-B create-app gate; 'back' resets to the picker;
     * 'cancel' exits via the error sink. Mirrors the TUI Select onChange values
     * (app.tsx:3246/3283/3323/3360). The driver MUST clear it after each
     * resolver run so a later re-entry runs the initial fetch.
     */
    verifyAction?: 'pick' | 'create-new' | 'autofix' | 'continue' | 'recheck' | 'open' | 'reopen' | 'back' | 'cancel'
    /** The existing ASC app picked in the verify-app picker (Path A target). */
    verifyChosenApp?: AscAppLike | null
    /** The ASC apps fetched by the initial verify-app effect (picker source + re-poll). */
    verifyApps?: AscApp[]
    /** Registered Developer-portal bundle ids (Path B wording sharpener). */
    verifyRegisteredIds?: string[]
    /** The authoritative Release build id resolved by the verify-app fresh detect. */
    verifyReleaseBundleId?: string
    /** The Debug-config bundle id when it differs from Release (else ''). */
    verifyDebugBundleId?: string
    /** Which gate path the user is on (null = the picker). */
    verifyPath?: GatePath | null
    /** 1-based count of blocked Continue attempts (the escalation driver). */
    verifyAttempt?: number
    /** Path B: ask before re-opening the browser after a blocked re-poll. */
    verifyAskReopen?: boolean
  }

  // ── callbacks (optional — callers that don't need streaming can omit) ────
  onStatus?: (message: string) => void
  onLog?: (message: string, color?: string) => void
  /** Internal-only diagnostic line → the support internal log (main PR #2406). Optional; no-op when absent. */
  onInternalLog?: (line: string) => void
  signal?: AbortSignal
}

export interface IosEffectResult {
  /** Updated progress after the effect ran (matches what was persisted). */
  progress: OnboardingProgress
  /** Explicit next step when not derivable from progress alone (★ transitions). */
  next?: OnboardingStep
  /** Transient runtime data that lives in the driver but is NOT persisted. */
  transient?: Partial<IosStepCtx>
}

// ─── Apple-side profile synthesis ───────────────────────────────────────────
//
// `deps.listProfilesForCert` returns the RAW Apple shape (AscProfileSummary) —
// id / name / profileType / profileContent / expirationDate / bundleIdentifier.
// Before the engine can treat those like on-disk profiles (filterProfilesForApp,
// the import-pick-profile picker, the import-exporting handoff), each summary has
// to be synthesized into a DiscoveredProfile. This is the SAME inline mapping the
// TUI does in two places:
//   - import-checking-apple-cert    → ui/app.tsx:1556–1567
//   - import-validating-all-certs   → ui/app.tsx:1460–1471 (prefetch)
// Both build the identical shape, so it lives here once and is reused at both
// engine call sites. The two TUI-critical fields the divergent code dropped:
//   - profileBase64    ← p.profileContent  (the .mobileprovision bytes the
//                        import-exporting → saving-credentials handoff persists)
//   - certificateSha1s ← [identity.sha1]   (so the import-pick-profile cert-trust
//                        validation + filterProfilesForApp accept the profile)
// teamId comes from the chosen identity (Apple's profile summary has no team
// field); profileType is mapped from Apple's enum to the DiscoveredProfile union.
// profileBase64 is NOT on the DiscoveredProfile type (it extends
// MobileprovisionDetail) — the TUI carries it via the same structural cast.
function synthesizeProfileFromAscSummary(
  summary: AscProfileSummary,
  identity: SigningIdentity,
): DiscoveredProfile {
  return {
    path: '',
    uuid: summary.id,
    name: summary.name,
    applicationIdentifier: '',
    bundleId: summary.bundleIdentifier,
    teamId: identity.teamId,
    expirationDate: summary.expirationDate,
    profileType: (summary.profileType === 'IOS_APP_STORE'
      ? 'app_store'
      : summary.profileType === 'IOS_APP_ADHOC'
        ? 'ad_hoc'
        : 'unknown') as DiscoveredProfile['profileType'],
    certificateSha1s: [identity.sha1],
    // No entitlements dict in an ASC profile summary — the field is required on
    // MobileprovisionDetail, so populate it with an empty map.
    profileEntitlements: {},
    profileBase64: summary.profileContent,
  } as DiscoveredProfile & { profileBase64: string }
}

// ─── Post-save tail delegation (BATCH 1) ────────────────────────────────────
//
// The post-save tail (saving-credentials → ask-build → CI-secrets → env/workflow
// → build-complete) is platform-NEUTRAL and already implemented once in
// `../tail/flow.js`. The iOS engine delegates to it exactly as android does:
//   - runIosEffect      → runTailEffect       for steps in TAIL_EFFECT_STEPS
//   - iosViewForStep    → tailViewForStep      for steps in TAIL_VIEW_STEPS
//   - applyIosInput     → applyTailInput       for steps in TAIL_INPUT_STEPS
// `toTailDeps(iosDeps)` adapts the iOS effect deps to the neutral TailEffectDeps,
// supplying the iOS credential SHAPE (cert/profile/teamId/p12) + the iOS resume
// resolver. The neutral view maps 1:1 back onto IosStepView. The step-id sets are
// the SAME ids android uses (the shared TailStep union), echoed as OnboardingStep.

/**
 * Post-save tail steps whose EFFECT the iOS engine delegates to the shared
 * module. INCLUDES saving-credentials (the convergence point) so the
 * saving-credentials → ask-build handoff (transient: ciSecretEntries,
 * savedCredentials) is owned by the shared tail. EXCLUDES ai-analysis-*
 * (TUI-only) and every iOS-specific provisioning effect.
 */
const TAIL_EFFECT_STEPS = new Set<OnboardingStep>([
  'saving-credentials',
  'detecting-ci-secrets',
  'checking-ci-secrets',
  'uploading-ci-secrets',
  'exporting-env',
  'overwrite-and-export-env',
  'writing-workflow-file',
  'requesting-build',
])

const TAIL_VIEW_STEPS = new Set<OnboardingStep>([
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

const TAIL_INPUT_STEPS = new Set<OnboardingStep>([
  'ci-secrets-target-select',
  'ask-github-actions-setup',
  'ask-export-env',
  'pick-package-manager',
  'pick-build-script',
  'pick-build-script-custom',
])

/**
 * Build the iOS saved-credential SHAPE written at `saving-credentials`.
 * Replicates the iOS TUI's `doSaveCredentials` map (ui/app.tsx) so the shared
 * tail stays platform-neutral while iOS owns its field set. Reads the resolved
 * cert/profile/team payloads from the driver's `carried` transient (the IMPORT
 * path synthesizes them transiently) and falls back to the persisted
 * create-new `completedSteps.certificateCreated/profileCreated` markers. Throws
 * on missing inputs — the same fail-fast guard the android builder uses.
 *
 * Emits the FULL credential map the TUI's `doSaveCredentials` produces — the 5
 * base fields PLUS the ASC API key fields (APPLE_KEY_ID / APPLE_ISSUER_ID /
 * APPLE_KEY_CONTENT) on the create-new (always) and import-app_store paths. The
 * secret .p8 bytes come from the transient `carried.p8Content` (NEVER persisted);
 * the non-secret key/issuer ids come from persisted progress.keyId/issuerId.
 */
async function buildIosSavedCredentials(progress: OnboardingProgress, deps: IosEffectDeps): Promise<Record<string, string>> {
  const carried = deps.carried
  const certData = carried?.certData ?? progress.completedSteps.certificateCreated
  const profileData = carried?.profileData ?? progress.completedSteps.profileCreated
  if (!certData)
    throw new Error('iOS certificate not provisioned')
  if (!profileData)
    throw new Error('iOS provisioning profile not created')

  const teamId = carried?.teamId ?? certData.teamId
  if (!teamId)
    throw new Error('iOS team id missing')

  // Import path uses the random keychain-export passphrase; create-new uses the
  // well-known DEFAULT_P12_PASSWORD that csr.ts's createP12 produces.
  const isImport = progress.setupMethod === 'import-existing'
  const p12Password = isImport && carried?.importedP12Password ? carried.importedP12Password : DEFAULT_P12_PASSWORD

  // The provisioning_map key is the resolved iOS bundle id (the verified
  // override, else the detected Release id, else appId — resolveIosBundleId),
  // matching what the build system looks up by PRODUCT_BUNDLE_IDENTIFIER at
  // sign time. progress.appId alone is WRONG when plugins.CapacitorUpdater.appId
  // splits the Capgo key from the Apple bundle id (hostile-review P1).
  const provisioningBundleId = resolveIosBundleId(progress, deps)
  const provisioningMap: Record<string, { profile: string, name: string }> = {
    [provisioningBundleId]: {
      profile: profileData.profileBase64,
      name: profileData.profileName,
    },
  }

  const distribution = isImport ? (progress.importDistribution || 'app_store') : 'app_store'

  const credentials: Record<string, string> = {
    BUILD_CERTIFICATE_BASE64: certData.p12Base64,
    P12_PASSWORD: p12Password,
    CAPGO_IOS_PROVISIONING_MAP: JSON.stringify(provisioningMap),
    APP_STORE_CONNECT_TEAM_ID: teamId,
    CAPGO_IOS_DISTRIBUTION: distribution,
  }

  // ASC API key fields (mirrors the TUI's doSaveCredentials APPLE_KEY_* writes,
  // app.tsx:1216–1219). The .p8/ASC key is needed on the create-new path always
  // and on the import path only for app_store distribution — `needsAscKey` is the
  // TUI's `!importMode || importDistribution === 'app_store'` guard. The raw .p8
  // bytes are the ONE secret here: they ride the transient `carried.p8Content`
  // channel (the IO-free engine never re-reads the file), mirroring the TUI's
  // p8ContentRef. APPLE_KEY_ID / APPLE_ISSUER_ID are non-secret Apple identifiers
  // read from persisted progress.keyId / progress.issuerId (with the
  // apiKeyVerified mirror as the resume-hydrated fallback, matching the TUI refs).
  const needsAscKey = !isImport || progress.importDistribution === 'app_store'
  let keyContent = carried?.p8Content
  // Crash recovery (hostile-review blocker, 2026-06-12): a resume that lost the
  // carried bytes (fresh mount) re-reads the .p8 from the persisted p8Path via
  // the INJECTED readFile — the same fallback resolveP8Content implements for
  // verifying-key, and what main's bespoke doSaveCredentials did. The engine
  // still performs no raw fs IO of its own.
  if (needsAscKey && !keyContent && progress.p8Path && deps.readFile) {
    try {
      keyContent = await deps.readFile(progress.p8Path)
    }
    catch {
      // Unreadable .p8 (moved/deleted) — fall through to the refuse guard below.
    }
  }
  if (needsAscKey && !keyContent) {
    // Restored main guard (the engine port had dropped it): NEVER silently save
    // an app_store credential map missing the ASC key — it cannot upload to
    // App Store Connect and the user would only find out at the first cloud
    // build. The throw rides the tail's build-first contract: the self-heal
    // catch diverts to the persisted resume step so the user re-provides the key.
    throw new Error('iOS ASC API key (.p8) unavailable — refusing to save credentials that cannot upload to App Store Connect. Re-provide the .p8 key file to continue.')
  }
  if (needsAscKey && keyContent) {
    const apiKeyVerified = progress.completedSteps.apiKeyVerified
    const keyId = progress.keyId ?? apiKeyVerified?.keyId
    const issuerId = progress.issuerId ?? apiKeyVerified?.issuerId
    if (keyId)
      credentials.APPLE_KEY_ID = keyId
    if (issuerId)
      credentials.APPLE_ISSUER_ID = issuerId
    credentials.APPLE_KEY_CONTENT = keyContent.toString('base64')
  }

  return credentials
}

/**
 * Lossy fallback used when the driver did not thread the saved-credential map
 * through `carried` (a crash-recovery resume that lost the in-memory state).
 * Rebuilds ONLY from the persisted create-new `completedSteps` markers; the
 * IMPORT path's exported cert/profile are synthesized-and-transient (never
 * persisted), so an imported export cannot be rebuilt here — those resumes
 * restart the import export sub-flow from import-scanning. Returns {} when not
 * rebuildable (matching the android lossy-rebuild contract).
 *
 * The non-secret ASC identifiers (APPLE_KEY_ID / APPLE_ISSUER_ID) ARE restored
 * from persisted progress (keyId/issuerId with the apiKeyVerified mirror — the
 * same precedence buildIosSavedCredentials uses). DOCUMENTED LIMITATION:
 * APPLE_KEY_CONTENT (the secret .p8 bytes) can NOT be rebuilt here — this
 * rebuild is synchronous and the bytes only exist behind the async injected
 * readFile / the transient carried.p8Content channel; a resume that needs the
 * full key re-enters the .p8 chain instead.
 */
function rebuildIosTailCredentials(progress: OnboardingProgress, deps?: Pick<IosEffectDeps, 'detectBundleIds'>): Record<string, string> {
  const certData = progress.completedSteps.certificateCreated
  const profileData = progress.completedSteps.profileCreated
  if (!certData || !profileData || !certData.teamId)
    return {}

  const provisioningBundleId = resolveIosBundleId(progress, deps)
  const provisioningMap: Record<string, { profile: string, name: string }> = {
    [provisioningBundleId]: {
      profile: profileData.profileBase64,
      name: profileData.profileName,
    },
  }
  const distribution = progress.setupMethod === 'import-existing' ? (progress.importDistribution || 'app_store') : 'app_store'

  const apiKeyVerified = progress.completedSteps.apiKeyVerified
  const keyId = progress.keyId ?? apiKeyVerified?.keyId
  const issuerId = progress.issuerId ?? apiKeyVerified?.issuerId

  return {
    BUILD_CERTIFICATE_BASE64: certData.p12Base64,
    P12_PASSWORD: DEFAULT_P12_PASSWORD,
    CAPGO_IOS_PROVISIONING_MAP: JSON.stringify(provisioningMap),
    APP_STORE_CONNECT_TEAM_ID: certData.teamId,
    CAPGO_IOS_DISTRIBUTION: distribution,
    ...(keyId ? { APPLE_KEY_ID: keyId } : {}),
    ...(issuerId ? { APPLE_ISSUER_ID: issuerId } : {}),
  }
}

/**
 * Adapt the iOS effect deps to the platform-neutral TailEffectDeps. The shared
 * tail module owns the routing/branching; iOS supplies its platform tag, its
 * credential SHAPE (closure-bound over `deps.carried` so the import path's
 * transient cert/profile/p12 reach the builder), its lossy rebuild, and its
 * resume resolver, plus the same injected helpers (passed straight through).
 * Mirrors android/flow.ts's toTailDeps 1:1.
 */
function toTailDeps(deps: IosEffectDeps): TailEffectDeps<OnboardingProgress> {
  return {
    platform: 'ios',
    buildSavedCredentials: progress => buildIosSavedCredentials(progress, deps),
    // Closure-bound over deps so the lossy rebuild resolves the bundle id the
    // SAME way the save path does (override → detected Release id → appId).
    rebuildTailCredentials: progress => rebuildIosTailCredentials(progress, deps),
    resumeStep: getIosResumeStep,
    updateSavedCredentials: deps.updateSavedCredentials!,
    loadProgress: deps.loadProgress!,
    saveProgress: deps.saveProgress!,
    deleteProgress: deps.deleteProgress!,
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
    // ── streaming / telemetry / preload sinks (forwarded 1:1, mirror android) ──
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

/** Map the shared TailStepView back onto IosStepView (same field shape). */
function mapTailViewToIosStepView(v: TailStepView, step: OnboardingStep): IosStepView {
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

// ─── Create-new choice/input vocabulary (BATCH 2b) ──────────────────────────────
//
// The create-new credential entry steps are pure choice/input screens — the .p8
// chain (api-key-instructions → input-p8-path → input-key-id → input-issuer-id)
// plus the setup-method fork. Their option labels MIRROR the TUI components
// (ui/steps/ios-credentials.tsx); the values MIRROR the TUI onChange handlers
// (ui/app.tsx). The per-step routing/persistence is split exactly as the TUI:
//   - setup-method-select → persists setupMethod; resume routes the fork
//   - api-key-instructions → navigation-only choice (picker | manual)
//   - input-p8-path/key-id/issuer-id → persist p8Path/keyId/issuerId incrementally
// File validation + keyId extraction are an IO boundary (the p8-method-select
// effect / the driver), NOT the pure reducer — so applyIosInput only records the
// path string. The detected Key ID default is re-derived from the filename here.

/** setup-method-select options (ui/steps/ios-credentials.tsx:105–108). */
const OPTIONS_SETUP_METHOD: IosStepOption[] = [
  { value: 'create', label: '🆕  Create new via App Store Connect API' },
  { value: 'import', label: '📥  Import existing from this Mac (Keychain + Xcode profiles)' },
]

/** api-key-instructions .p8-method options (ui/steps/ios-credentials.tsx:151–154). */
const OPTIONS_API_KEY_METHOD: IosStepOption[] = [
  { value: 'picker', label: '📂  Open file picker' },
  { value: 'manual', label: '📝  Type the path' },
]

/**
 * import-distribution-mode options (ui/steps/ios-import.tsx:130–134). The import
 * sub-flow's first visible fork: App Store (needs the ASC .p8 chain) vs Ad-hoc
 * (no ASC key) vs a '__cancel__' escape to the create-new path. The VALUES mirror
 * the TUI Select so applyIosInput can persist setupMethod/importDistribution and
 * the driver can route via getImportEntryStep.
 */
const OPTIONS_IMPORT_DISTRIBUTION: IosStepOption[] = [
  { value: 'app_store', label: '🛫  App Store / TestFlight' },
  { value: 'ad_hoc', label: '📦  Ad-hoc (no TestFlight upload)' },
  { value: '__cancel__', label: '↩️   Cancel and use Create new instead' },
]

// ─── Import picker choice vocabulary (BATCH 6) ──────────────────────────────────
//
// The import-pick-identity / import-pick-profile per-row options are DYNAMIC (built
// from ctx.importMatches in iosViewForStep); only the trailing escape options are
// constants. Their VALUES mirror the TUI sentinels so the resolver effects can route
// a non-pick: import-pick-identity '__cancel__' → api-key-instructions (switch to
// create-new, app.tsx:3271); import-pick-profile '__back__' → import-pick-identity
// (app.tsx:3470). A picked row carries the identity SHA-1 / profile UUID, which the
// driver resolves into carried.chosenIdentity / carried.chosenProfile.

/** import-pick-identity trailing "switch to create-new" escape (app.tsx:3324/3430). */
const OPTION_IMPORT_PICK_IDENTITY_CANCEL: IosStepOption = { value: '__cancel__', label: '↩️   Cancel and use Create new instead' }

/** import-pick-profile trailing "back to identity selection" escape (app.tsx:3467). */
const OPTION_IMPORT_PICK_PROFILE_BACK: IosStepOption = { value: '__back__', label: '↩️   Back to identity selection' }

// ─── Import recovery menu vocabulary (BATCH 7a) ─────────────────────────────────
//
// The import-no-match-recovery HUB options are DYNAMIC: the 'create' row is
// hidden for ad_hoc (apple-api createProfile only mints IOS_APP_STORE — app.tsx:3538),
// its label flips on whether an ASC key is already present (app.tsx:3564), and the
// 'provide-profile-path' row only shows when a file picker is available
// (canUseFilePicker, app.tsx:3570). The 'browser' + 'back' rows are constant. The
// import-portal-explanation options are likewise dynamic ('use-create' only for the
// app_store auto-path; 'use-file' only with a file picker). The VALUES mirror the
// TUI sentinels so the resolver effects route each pick (app.tsx:3579 / :3738).

/** import-no-match-recovery 'create' row — label flips on whether an ASC key exists (app.tsx:3564). */
function optionRecoveryCreate(hasAscKey: boolean): IosStepOption {
  return {
    value: 'create',
    label: hasAscKey
      ? '✨  Create a new App Store profile for this cert via Apple'
      : '✨  Provide ASC API key, then create a new App Store profile for this cert',
  }
}

/** import-no-match-recovery 'use a .mobileprovision from disk' row (app.tsx:3571). */
const OPTION_RECOVERY_PROVIDE_PATH: IosStepOption = { value: 'provide-profile-path', label: '📁  Use a .mobileprovision file from disk' }

/** import-no-match-recovery 'open the Apple Developer Portal' row (app.tsx:3574). */
const OPTION_RECOVERY_BROWSER: IosStepOption = { value: 'browser', label: '🌐  Open Apple Developer Portal (browse / create profiles manually)' }

/** import-no-match-recovery 'back to identity selection' row (app.tsx:3577). */
const OPTION_RECOVERY_BACK: IosStepOption = { value: 'back', label: '↩️   Back to identity selection' }

/** import-portal-explanation 'use Create new instead' row — app_store only (app.tsx:3725). */
const OPTION_PORTAL_USE_CREATE: IosStepOption = { value: 'use-create', label: '✨  Use "Create a new App Store profile" instead (recommended)' }

/** import-portal-explanation 'open the portal' row — label flips on the auto-path availability (app.tsx:3728). */
function optionPortalOpenAnyway(canAutoCreate: boolean): IosStepOption {
  return {
    value: 'open-anyway',
    label: canAutoCreate ? '🌐  Open the portal anyway (advanced)' : '🌐  Open Apple Developer Portal',
  }
}

/** import-portal-explanation 'I already have one on disk' row (app.tsx:3734). */
const OPTION_PORTAL_USE_FILE: IosStepOption = { value: 'use-file', label: '📁  I already have a .mobileprovision on disk — let me pick it' }

/** import-portal-explanation 'back to recovery menu' row (app.tsx:3736). */
const OPTION_PORTAL_BACK: IosStepOption = { value: 'back', label: '↩️   Back to recovery menu' }

// ─── Export-warning vocabulary (BATCH 7b) ───────────────────────────────────────
//
// import-export-warning is the heads-up shown right before the single Keychain
// permission dialog. Three static rows mirror the TUI's Select (app.tsx:3766 /
// ui/steps/ios-import.tsx:356): 'go' (export now — the label names the identity),
// 'back' (to profile selection), 'exit' (quit onboarding). The VALUES mirror the
// TUI sentinels so the resolver effect routes each pick (app.tsx:3769).

/** import-export-warning 'export now' row — label names the chosen identity (app.tsx:357). */
function optionExportWarningGo(identityName: string): IosStepOption {
  return { value: 'go', label: `🔓  Export "${identityName}" now` }
}

/** import-export-warning 'back to profile selection' row (app.tsx:358). */
const OPTION_EXPORT_WARNING_BACK: IosStepOption = { value: 'back', label: '↩️   Back' }

/** import-export-warning 'exit onboarding' row (app.tsx:359). */
const OPTION_EXPORT_WARNING_EXIT: IosStepOption = { value: 'exit', label: '✖  Exit onboarding' }

/**
 * The recovery-menu Alert sentence for a no-match reason. Mirrors the TUI's
 * `alertText` (ui/steps/ios-import.tsx:261) so the engine view's title names the
 * actual cause. The undefined / 'no-profile-on-disk' branch keeps the legacy
 * wording, exactly as the TUI's back-compat default does.
 */
function recoveryAlertText(
  reason: IosNoMatchReason | undefined,
  identityName: string,
  appId: string | undefined,
  distribution: 'app_store' | 'ad_hoc' | undefined,
): string {
  switch (reason) {
    case 'apple-no-cert-match':
      return `Apple's records don't include the certificate "${identityName}". It may have been revoked, never uploaded, or belong to a different team.`
    case 'apple-no-profiles-linked':
      return `Apple has the certificate "${identityName}" but no provisioning profiles are linked to it yet.`
    case 'apple-bundle-mismatch':
      return `Apple has profiles for "${identityName}" but none target "${appId ?? 'this app'}".`
    case 'apple-distribution-mismatch':
      return `Apple has profiles for "${appId ?? 'this app'}" under "${identityName}" but none are ${distribution ?? 'the requested distribution'}.`
    case 'apple-other':
      return `Apple returned profiles for "${identityName}" but none match this app.`
    case 'no-profile-on-disk':
    default:
      return `No provisioning profile on this Mac is linked to "${identityName}".`
  }
}

// ─── Recovery choice vocabulary (BATCH 3) ───────────────────────────────────────
//
// cert-limit-prompt's per-cert options are DYNAMIC (built from ctx.existingCerts
// in iosViewForStep); only the trailing exit option is a constant. The
// duplicate-profile-prompt options are fully static (delete | exit). The exit
// VALUES mirror the TUI sentinels (app.tsx:3915 '__exit__'; app.tsx:3941
// delete-vs-else) so the resolver effects can route a non-pick to 'error'.

/** cert-limit-prompt trailing exit option (app.tsx:3915). */
const OPTION_CERT_LIMIT_EXIT: IosStepOption = { value: '__exit__', label: '✖  Exit onboarding' }

/** duplicate-profile-prompt options (app.tsx:3936–3951). */
const OPTIONS_DUPLICATE_PROFILE: IosStepOption[] = [
  { value: 'delete', label: '🗑️   Delete the duplicate profile(s) and create a fresh one' },
  { value: 'exit', label: '✖  Exit onboarding' },
]

// ─── error step vocabulary (BATCH 8) ────────────────────────────────────────────
//
// The error screen's action menu. Mirrors the TUI's ErrorStep RETRY_OPTIONS
// (ui/steps/ios-shared.tsx:276) exactly: 'retry' (re-run the failing step),
// 'restart' (reset to a fresh welcome), 'exit' (leave onboarding). The 'retry'
// row is only offered when a retryStep is present — the TUI gates it on
// `showRetry={!!retryStep}` (app.tsx:4459). The driver re-drives the step as a
// resolver (runIosEffect('error')) reading deps.carried.retryStep.
const OPTION_ERROR_RETRY: IosStepOption = { value: 'retry', label: '🔄  Try again' }
const OPTION_ERROR_RESTART: IosStepOption = { value: 'restart', label: '↩️   Restart onboarding' }
const OPTION_ERROR_EXIT: IosStepOption = { value: 'exit', label: '❌  Exit' }

/**
 * The create-new choice/input vocabulary. Mirrors android's `AndroidInput`:
 * one variant per choice/input step that records (or routes) state. The iOS
 * `applyIosInput` signature still accepts `unknown`, so callers cast to this.
 * Navigation-only choices (api-key-instructions) are included for completeness
 * but return progress unchanged.
 */
export type IosInput =
  // setup-method fork — 'create' → create-new (.p8 chain); 'import' → import sub-flow.
  | { step: 'setup-method-select', value: 'create' | 'import' }
  // .p8-method choice — navigation only ('picker' → p8-method-select effect,
  // 'manual' → input-p8-path). Persists nothing.
  | { step: 'api-key-instructions', value: 'picker' | 'manual' }
  // .p8 file PATH (validation + keyId extraction happen at the effect boundary).
  | { step: 'input-p8-path', value: string }
  // ASC Key ID (empty submission reuses the filename-detected default).
  | { step: 'input-key-id', value: string }
  // ASC Issuer ID.
  | { step: 'input-issuer-id', value: string }
  // ── Cert-limit & duplicate-profile recovery (BATCH 3) ────────────────────
  // cert-limit-prompt — pick an existing cert to revoke (its Apple resource id)
  // OR exit. EPHEMERAL: the reducer persists nothing; the driver records the
  // picked AscDistributionCert in carried.certToRevoke and re-drives the prompt
  // as a resolver effect (mirrors app.tsx:3917 setCertToRevoke + setStep).
  | { step: 'cert-limit-prompt', value: string }
  // duplicate-profile-prompt — confirm deletion of the duplicate Capgo profiles
  // OR exit. EPHEMERAL: the reducer persists nothing; the driver records the
  // confirm/exit decision in carried.confirmDeleteDuplicates and re-drives the
  // prompt as a resolver effect (mirrors app.tsx:3941 delete-vs-exitOnboarding).
  | { step: 'duplicate-profile-prompt', value: 'delete' | 'exit' }
  // verify-app — the App Store verification gate/picker pick (an app's bundleId,
  // '__create_new__', or a gate action value: autofix / continue / recheck /
  // open / reopen / back / cancel). EPHEMERAL: the reducer persists nothing; the
  // driver records the pick into carried.verifyAction (+ carried.verifyChosenApp
  // for an app pick) and re-drives the step as a resolver effect (mirrors
  // app.tsx:3246/3283/3323/3360 onChange).
  | { step: 'verify-app', value: string }
  // ── import-distribution-mode (BATCH 5) ───────────────────────────────────
  // The import sub-flow's FIRST visible fork (app.tsx:3176–3232). Persists
  // setupMethod='import-existing' + importDistribution ('app_store' | 'ad_hoc');
  // the '__cancel__' escape hatch instead switches to create-new (setupMethod=
  // 'create-new', importDistribution cleared). The PERSISTED fields are what
  // route resume/advance — the driver computes the next step via getImportEntryStep
  // (ad_hoc → import-pick-identity; app_store → the .p8 chain entry / verifying-key;
  // __cancel__ → api-key-instructions), mirroring the TUI onChange exactly.
  | { step: 'import-distribution-mode', value: 'app_store' | 'ad_hoc' | '__cancel__' }
  // ── Import pickers (BATCH 6) ─────────────────────────────────────────────
  // import-pick-identity — pick a signing identity (its Keychain SHA-1) OR
  // '__cancel__' to switch to create-new. EPHEMERAL: the reducer persists
  // nothing; the driver resolves the SHA-1 to the picked SigningIdentity, records
  // it in carried.chosenIdentity, and re-drives the prompt as a resolver effect
  // (mirrors app.tsx:3270 setChosenIdentity + the three-way setStep).
  | { step: 'import-pick-identity', value: string }
  // import-pick-profile — pick a provisioning profile (its UUID) OR '__back__'
  // to return to identity selection. EPHEMERAL: the reducer persists nothing; the
  // driver resolves the UUID to the picked DiscoveredProfile, records it in
  // carried.chosenProfile, and re-drives the prompt as a resolver effect (mirrors
  // app.tsx:3469 onChange — '__back__' → import-pick-identity, valid →
  // import-export-warning, invalid → handleError).
  | { step: 'import-pick-profile', value: string }
  // ── Import recovery (BATCH 7a) ───────────────────────────────────────────
  // import-no-match-recovery — the 5-way recovery HUB shown when the chosen
  // identity has no usable matching profile. EPHEMERAL: the reducer persists
  // nothing; the driver records the user's pick in carried.recoveryAction and
  // re-drives the step as a resolver effect (mirrors app.tsx:3579 onChange —
  // 'create' → import-create-profile-only / api-key-instructions; 'provide-
  // profile-path' → import-provide-profile-path; 'browser' → import-portal-
  // explanation; 'back' → import-pick-identity). STICKY: noMatchReason is NOT
  // recomputed here — the carried reason set by the prior step is preserved.
  | { step: 'import-no-match-recovery', value: 'create' | 'provide-profile-path' | 'browser' | 'back' }
  // import-portal-explanation — the manual-portal walkthrough reached from the
  // recovery menu's 'browser' option. EPHEMERAL navigation choice: the driver
  // records the pick in carried.portalAction and re-drives the step as a
  // resolver (mirrors app.tsx:3738 onChange — 'use-create' → import-create-
  // profile-only; 'use-file' → import-provide-profile-path; 'open-anyway' /
  // 'back' → import-no-match-recovery). Persists nothing; noMatchReason rides
  // transient untouched so the recovery menu re-renders the SAME variant.
  | { step: 'import-portal-explanation', value: 'use-create' | 'open-anyway' | 'use-file' | 'back' }
  // import-export-warning — the heads-up before the single Keychain dialog
  // (BATCH 7b). EPHEMERAL navigation choice: the driver records the pick in
  // carried.exportWarningAction and re-drives the step as a resolver (mirrors
  // app.tsx:3769 onChange — 'go' → import-exporting; 'back' →
  // import-pick-profile; 'exit' → exit).
  // Persists nothing.
  | { step: 'import-export-warning', value: 'go' | 'back' | 'exit' }
// ─── Engine surface (tail-wired; non-tail steps remain stubs) ───────────────────

/**
 * Build the view-model for a given step. Post-save tail steps delegate to the
 * shared neutral view (adapted back to IosStepView). The create-new choice/input
 * steps (setup-method fork + .p8 chain) return real per-step views mirroring the
 * TUI prompts/options (ui/steps/ios-credentials.tsx). All other steps return a
 * minimal placeholder 'auto' view echoing the step (real per-step views land in
 * later batches).
 */
export function iosViewForStep(
  step: OnboardingStep,
  progress: OnboardingProgress,
  ctx?: IosStepCtx,
): IosStepView {
  // Post-save tail: delegate to the shared platform-neutral view. IosStepCtx is
  // a superset of TailStepCtx, so it threads straight through.
  if (TAIL_VIEW_STEPS.has(step))
    return mapTailViewToIosStepView(tailViewForStep(step as TailStep, progress, (ctx ?? {}) as TailStepCtx), step)

  switch (step) {
    // ── setup-method-select (choice) ──────────────────────────────────────────
    // ui/steps/ios-credentials.tsx:98–118. The create-vs-import fork.
    case 'setup-method-select':
      return {
        step,
        kind: 'choice',
        title: 'How do you want to set up iOS credentials?',
        options: OPTIONS_SETUP_METHOD,
      }

    // ── api-key-instructions (choice) ─────────────────────────────────────────
    // ui/steps/ios-credentials.tsx:139–207. Navigation-only .p8-method fork:
    // 'picker' → p8-method-select (native dialog effect), 'manual' → input-p8-path.
    case 'api-key-instructions':
      return {
        step,
        kind: 'choice',
        title: 'We need an App Store Connect API key to manage certificates and profiles for you.',
        prompt: 'How do you want to provide the .p8 file?',
        options: OPTIONS_API_KEY_METHOD,
      }

    // ── input-p8-path (input) ─────────────────────────────────────────────────
    // ui/steps/ios-credentials.tsx:240–250. The .p8 file path.
    case 'input-p8-path':
      return {
        step,
        kind: 'input',
        prompt: 'Path to your .p8 file:',
        collect: ['p8Path'],
      }

    // ── input-key-id (input) ──────────────────────────────────────────────────
    // ui/steps/ios-credentials.tsx:270–305. The ASC Key ID, pre-filled with the
    // value detected from the AuthKey_<id>.p8 filename (the picker effect persists
    // it; for the manual path it is re-derived here so the view can offer it).
    // An empty submission reuses this default (applyIosInput handles the reuse).
    case 'input-key-id': {
      const detected = progress.keyId || extractKeyIdFromP8Path(progress.p8Path ?? '')
      return {
        step,
        kind: 'input',
        prompt: detected
          ? `Key ID (detected from filename): ${detected} — press Enter to confirm, or type a different one`
          : 'Key ID (shown next to the key name in App Store Connect):',
        collect: ['keyId'],
      }
    }

    // ── input-issuer-id (input) ───────────────────────────────────────────────
    // ui/steps/ios-credentials.tsx:317–338. The ASC Issuer ID (UUID).
    case 'input-issuer-id':
      return {
        step,
        kind: 'input',
        prompt: 'Issuer ID (UUID at the very top of the API keys page, above the key list):',
        collect: ['issuerId'],
      }

    // ── cert-limit-prompt (choice, EPHEMERAL-dep) ─────────────────────────────
    // app.tsx:3900–3928. Apple's per-team distribution-cert limit (3) was hit, so
    // we offer each EXISTING cert (from ctx.existingCerts, surfaced transiently by
    // creating-certificate) for revocation, plus an exit option. The option VALUE
    // is the cert's Apple resource id — the driver records the picked cert into
    // carried.certToRevoke and re-drives this step as a resolver effect. The
    // selection is EPHEMERAL (never persisted); on resume the user re-enters via a
    // fresh creating-certificate, so this step is never a resume target.
    case 'cert-limit-prompt': {
      const certs = ctx?.existingCerts ?? []
      const ourCertId = ctx?.certData?.certificateId
        ?? progress.completedSteps.certificateCreated?.certificateId
      const options: IosStepOption[] = [
        ...certs.map((c) => {
          const created = ourCertId === c.id ? ' · 🔧 Created by Capgo' : ''
          return {
            value: c.id,
            label: `🗑️   ${c.name} · expires ${c.expirationDate.split('T')[0]}${created}`,
          }
        }),
        OPTION_CERT_LIMIT_EXIT,
      ]
      return {
        step,
        kind: 'choice',
        title: `Certificate limit reached — ${certs.length} existing Apple Distribution certificate(s).`,
        prompt: 'Pick a certificate to revoke (frees a slot to create a new one), or exit:',
        options,
      }
    }

    // ── duplicate-profile-prompt (choice, EPHEMERAL-dep) ──────────────────────
    // app.tsx:3936–3951. Apple already has Capgo provisioning profiles for this
    // bundle id. Offer to delete them (then recreate) or exit. The duplicate list
    // (ctx.duplicateProfiles) is EPHEMERAL — the reducer persists nothing; only
    // duplicateProfileOrigin was persisted upstream (creating-profile /
    // import-create-profile-only) so deleting-duplicate-profiles routes back to the
    // right origin. The driver records the confirm/exit choice into carried and
    // re-drives this step as a resolver effect.
    case 'duplicate-profile-prompt': {
      const count = (ctx?.duplicateProfiles ?? []).length
      return {
        step,
        kind: 'choice',
        title: count
          ? `Found ${count} existing Capgo provisioning profile(s) for this app.`
          : 'Found existing Capgo provisioning profile(s) for this app.',
        prompt: 'Delete them and create a fresh one, or exit:',
        options: OPTIONS_DUPLICATE_PROFILE,
      }
    }

    // ── import-distribution-mode (choice) ─────────────────────────────────────
    // app.tsx:3176–3232 / ui/steps/ios-import.tsx:114–138. The import sub-flow's
    // FIRST visible step: how Capgo will distribute the build (App Store /
    // TestFlight vs Ad-hoc), plus a '__cancel__' escape that bails to the
    // create-new path. applyIosInput persists setupMethod + importDistribution;
    // the driver routes via getImportEntryStep (NOT persisted in the view).
    case 'import-distribution-mode':
      return {
        step,
        kind: 'choice',
        title: 'How will Capgo distribute your build?',
        prompt: 'App Store uploads to TestFlight (needs an ASC API key); Ad-hoc is signed for direct/QR install (no ASC key).',
        options: OPTIONS_IMPORT_DISTRIBUTION,
      }

    // ── import-pick-identity (choice, EPHEMERAL-dep) ──────────────────────────
    // app.tsx:3254–3436. The signing-identity picker. The driver-held inventory
    // (ctx.importMatches from import-scanning) is partitioned by the Apple-side
    // availability map (ctx.identityAvailability from import-validating-all-certs):
    // when classification ran, ONLY identities Apple confirmed usable (available)
    // are offered; when it didn't (no .p8 yet — the ad_hoc-without-key entry) every
    // identity is offered (a fresh classification map is empty, so every row counts
    // as available, exactly like the TUI's `!haveClassification` flat-list fallback).
    // Each row is labelled with how many of THIS identity's on-disk profiles are
    // usable for this app + distribution (filterProfilesForApp), and the trailing
    // option is the create-new escape ('__cancel__'). The option VALUE is the
    // identity SHA-1 — the driver resolves it to the picked SigningIdentity, records
    // it into carried.chosenIdentity, and re-drives this step as a resolver effect
    // (the BATCH 3 ephemeral-branching mechanism). The selection is EPHEMERAL (never
    // persisted); on resume the user re-enters via a re-run import-scanning.
    case 'import-pick-identity': {
      const matches = ctx?.importMatches ?? []
      const availability = ctx?.identityAvailability ?? {}
      const haveClassification = Object.keys(availability).length > 0
      const appId = resolveIosBundleId(progress)
      const dist = progress.importDistribution
      const available = matches.filter((m) => {
        const a = availability[m.identity.sha1]
        return !haveClassification || a?.available
      })
      const options: IosStepOption[] = [
        ...available.map((m) => {
          const matchCount = filterProfilesForApp(m.profiles, appId, dist).length
          return {
            value: m.identity.sha1,
            label: matchCount > 0
              ? `🔑  ${m.identity.name} · ${matchCount} matching profile${matchCount === 1 ? '' : 's'}`
              : `🔑  ${m.identity.name} · ⚠ no matching profiles on this Mac (recovery available)`,
          }
        }),
        OPTION_IMPORT_PICK_IDENTITY_CANCEL,
      ]
      return {
        step,
        kind: 'choice',
        title: 'Pick a signing identity to import.',
        prompt: 'These are the iOS Distribution certificates in your Keychain. Pick one, or switch to creating a fresh cert + profile.',
        options,
      }
    }

    // ── import-pick-profile (choice, EPHEMERAL-dep) ───────────────────────────
    // app.tsx:3439–3526. The provisioning-profile picker for the chosen identity.
    // Lists only the profiles usable for THIS app + THIS distribution mode
    // (filterProfilesForApp over the chosen identity's profiles in ctx.importMatches —
    // which now ALSO includes any Apple-side profiles import-checking-apple-cert /
    // import-provide-profile-path synthesized into the match), keyed by UUID (unique
    // for both on-disk and synthesized profiles), plus a '__back__' option to return
    // to identity selection. The option VALUE is the profile UUID — the driver
    // resolves it to the picked DiscoveredProfile, records it into
    // carried.chosenProfile, and re-drives this step as a resolver effect. The
    // selection is EPHEMERAL (never persisted).
    case 'import-pick-profile': {
      const chosen = ctx?.chosenIdentity
      const matches = ctx?.importMatches ?? []
      const allMatchedProfiles = chosen
        ? matches.find(m => m.identity.sha1 === chosen.sha1)?.profiles ?? []
        : []
      const appId = resolveIosBundleId(progress)
      const dist = progress.importDistribution
      const matchedProfiles = filterProfilesForApp(allMatchedProfiles, appId, dist)
      const options: IosStepOption[] = [
        ...matchedProfiles.map(p => ({
          value: p.uuid,
          label: `📜  ${p.name} · bundle ${p.bundleId} · ${p.profileType} · expires ${p.expirationDate.split('T')[0]}`,
        })),
        OPTION_IMPORT_PICK_PROFILE_BACK,
      ]
      return {
        step,
        kind: 'choice',
        title: 'Pick a provisioning profile to import.',
        prompt: 'These profiles are linked to your chosen certificate and match this app. Pick one, or go back to change the identity.',
        options,
      }
    }

    // ── import-no-match-recovery (choice, EPHEMERAL-dep) ──────────────────────
    // app.tsx:3529–3612. The 5-way recovery HUB shown when the chosen identity
    // has no usable matching profile. The menu VARIANT depends on three ephemeral
    // / persisted inputs:
    //   - ctx.noMatchReason → the Alert title sentence (recoveryAlertText). STICKY:
    //     the reason was set by the step that ROUTED here (import-pick-identity /
    //     import-checking-apple-cert); re-entries from a file-picker cancel / portal
    //     "open anyway" thread it back UNCHANGED so the menu keeps the same variant.
    //   - hasAscKey (ctx.p8Content OR a persisted progress.p8Path) → the 'create' row
    //     label flips between "create now" and "provide ASC key first" (app.tsx:3564).
    //     MATCHES the TUI exactly (p8ContentRef OR p8PathRef, app.tsx:3530): a
    //     persisted completedSteps.apiKeyVerified does NOT flip the label — see the
    //     v1 behavior-preservation divergence note in the iOS transition-graph audit.
    //   - importDistribution → 'create' is HIDDEN for ad_hoc (apple-api createProfile
    //     only mints app_store profiles — app.tsx:3538), so an ad_hoc user can't end
    //     up with an app_store profile saved under CAPGO_IOS_DISTRIBUTION='ad_hoc'.
    //   - ctx.canUseFilePicker (default true) → the 'provide-profile-path' row only
    //     shows when a native picker is available (app.tsx:3570).
    // The option VALUE is the recovery action — the driver records it into
    // carried.recoveryAction and re-drives this step as a resolver effect. EPHEMERAL
    // (never persisted); on resume the user re-enters via a re-run import-scanning.
    case 'import-no-match-recovery': {
      const reason = ctx?.noMatchReason
      const identityName = ctx?.chosenIdentity?.name ?? 'your certificate'
      const appId = resolveIosBundleId(progress)
      const dist = progress.importDistribution
      const hasAscKey = !!(ctx?.p8Content || progress.p8Path)
      const canCreateProfile = dist !== 'ad_hoc'
      const canUseFilePicker = ctx?.canUseFilePicker ?? true
      const options: IosStepOption[] = [
        ...(canCreateProfile ? [optionRecoveryCreate(hasAscKey)] : []),
        ...(canUseFilePicker ? [OPTION_RECOVERY_PROVIDE_PATH] : []),
        OPTION_RECOVERY_BROWSER,
        OPTION_RECOVERY_BACK,
      ]
      return {
        step,
        kind: 'choice',
        title: recoveryAlertText(reason, identityName, appId, dist),
        prompt: 'Pick a recovery path:',
        options,
      }
    }

    // ── import-portal-explanation (choice, EPHEMERAL-dep) ─────────────────────
    // app.tsx:3626–3759. The manual-portal walkthrough reached from the recovery
    // menu's 'browser' option. Informational: it explains the manual portal steps
    // and steers toward the automatic "Create new" path. Two flavours keyed off the
    // distribution mode (app.tsx:3627): app_store offers the auto-create nudge
    // ('use-create'); ad_hoc omits it (apple-api can't mint ad_hoc profiles). The
    // 'use-file' row only shows when a native picker is available. 'open-anyway' and
    // 'back' both route back to the recovery menu WITHOUT clearing noMatchReason —
    // the resolver opens the portal for 'open-anyway'. The VALUE is the pick — the
    // driver records it into carried.portalAction and re-drives as a resolver.
    case 'import-portal-explanation': {
      const canAutoCreate = progress.importDistribution !== 'ad_hoc'
      const canUseFilePicker = ctx?.canUseFilePicker ?? true
      const options: IosStepOption[] = [
        ...(canAutoCreate ? [OPTION_PORTAL_USE_CREATE] : []),
        optionPortalOpenAnyway(canAutoCreate),
        ...(canUseFilePicker ? [OPTION_PORTAL_USE_FILE] : []),
        OPTION_PORTAL_BACK,
      ]
      return {
        step,
        kind: 'choice',
        title: canAutoCreate
          ? 'You can do this manually in the Apple Developer Portal — but the automatic path is much easier.'
          : 'Ad-hoc distribution is genuinely fiddly (you also need to register every target device on Apple\'s side). Here\'s what\'s involved — and how to get help if you\'re stuck.',
        prompt: 'Create the profile manually in the portal, or let Capgo do it automatically:',
        options,
      }
    }

    // ── import-export-warning (choice, EPHEMERAL-dep) ─────────────────────────
    // app.tsx:3765–3787 / ui/steps/ios-import.tsx:353. The heads-up shown right
    // before the single Keychain permission dialog: a warning Alert ("macOS will
    // now ask permission to access your private key") plus a 3-row Select. The
    // 'go' row names the chosen identity so the user recognises the cert they're
    // exporting (app.tsx:3767 passes chosenIdentity.name). The pick is EPHEMERAL —
    // the driver records it into carried.exportWarningAction and re-drives this
    // step as a resolver ('go' → import-exporting). The TUI only renders
    // this step when chosenIdentity is present (app.tsx:3765 `&& chosenIdentity`);
    // mirror that by falling back to a neutral identity label when ctx omits it.
    case 'import-export-warning': {
      const identityName = ctx?.chosenIdentity?.name ?? 'your signing identity'
      return {
        step,
        kind: 'choice',
        title: 'macOS will now ask permission to access your private key.',
        prompt: 'A Keychain dialog will pop up — click "Always Allow" so retries don\'t re-prompt. That\'s the only prompt; the export is otherwise non-interactive.',
        options: [
          optionExportWarningGo(identityName),
          OPTION_EXPORT_WARNING_BACK,
          OPTION_EXPORT_WARNING_EXIT,
        ],
      }
    }

    // ── verify-app (auto effect OR parked choice — PR #2397 port) ──────────────
    // app.tsx:3043–3391. Until the initial ASC fetch has classified the invariant
    // (no ctx.verifyResult yet), the step is an AUTO effect (the parallel fetch +
    // classification + the pass-through exits). Once PARKED (the effect returned
    // next:'verify-app' with the classification in transient), it renders as a
    // CHOICE:
    //   - picker (verifyPath null/absent): one option per ASC app (value = its
    //     bundleId) + the '__create_new__' escape — app.tsx:3352-3388.
    //   - Path A fix-build-id gate: autofix / continue (re-check) / back / cancel
    //     — app.tsx:3238-3257.
    //   - Path B create-app gate: open / recheck / (back when apps exist) /
    //     cancel — app.tsx:3315-3334 — or, after a blocked re-poll
    //     (verifyAskReopen), recheck / reopen / cancel — app.tsx:3276-3292.
    // The option VALUES mirror the TUI Select values; the driver records the pick
    // into carried (verifyAction + verifyChosenApp for an app pick) and re-drives
    // this step as a resolver effect.
    case 'verify-app': {
      if (!ctx?.verifyResult)
        return { step, kind: 'auto', title: 'Checking App Store Connect for your app...' }
      const releaseId = ctx.verifyReleaseBundleId ?? ''
      if (ctx.verifyPath === 'fix-build-id' && ctx.verifyChosenApp) {
        return {
          step,
          kind: 'choice',
          title: `Build ID doesn't match "${ctx.verifyChosenApp.name}"`,
          options: [
            { value: 'autofix', label: '🔧 Update PRODUCT_BUNDLE_IDENTIFIER for me' },
            { value: 'continue', label: '✅ I\'ve edited it myself — re-check' },
            { value: 'back', label: '↩  Back — pick a different app' },
            { value: 'cancel', label: '❌ Cancel onboarding' },
          ],
        }
      }
      if (ctx.verifyPath === 'create-app') {
        if (ctx.verifyAskReopen) {
          return {
            step,
            kind: 'choice',
            title: `Still no App Store app for ${releaseId}`,
            options: [
              { value: 'recheck', label: '🔁 I\'ve created it — re-check' },
              { value: 'reopen', label: '🌐 Re-open the create-app page' },
              { value: 'cancel', label: '❌ Cancel onboarding' },
            ],
          }
        }
        return {
          step,
          kind: 'choice',
          title: `No App Store app exists for ${releaseId}`,
          options: [
            { value: 'open', label: '🌐 Open App Store Connect to create the app' },
            { value: 'recheck', label: '🔁 I\'ve already created it — re-check' },
            ...((ctx.verifyApps?.length ?? 0) > 0 ? [{ value: 'back', label: '↩  Back — pick an existing app' }] : []),
            { value: 'cancel', label: '❌ Cancel onboarding' },
          ],
        }
      }
      // Picker (wrong-build-id): the account has apps, none match the build id.
      return {
        step,
        kind: 'choice',
        title: `No App Store app matches the bundle ID your project builds (${releaseId}).`,
        options: [
          ...(ctx.verifyApps ?? []).map(a => ({ value: a.bundleId, label: `${a.name} — ${a.bundleId}` })),
          { value: '__create_new__', label: '➕ None of these — my build ID is correct, create a new app' },
        ],
      }
    }

    // ── error (kind 'error' — the recovery screen) ────────────────────────────
    // app.tsx:4454-4485 + ui/steps/ios-shared.tsx (ErrorStep). Renders the
    // failing step's message (ctx.error — set by the effect into transient.error
    // and threaded back via deps.carried) and offers Try again / Restart / Exit.
    // The 'retry' row is gated on a retryStep being present (the TUI's
    // `showRetry={!!retryStep}`, app.tsx:4459): a recoverable failure carries a
    // retryStep, an unrecoverable one (e.g. an EXIT sink from an export-warning
    // 'exit' pick) carries none, so only Restart / Exit are offered. The message
    // + options are ALL ephemeral (ctx), never derived from persisted progress —
    // mirroring the TUI holding error/retryStep in React state, not progress.json.
    case 'error': {
      const message = ctx?.error ?? 'An error occurred.'
      const options: IosStepOption[] = [
        ...(ctx?.retryStep ? [OPTION_ERROR_RETRY] : []),
        OPTION_ERROR_RESTART,
        OPTION_ERROR_EXIT,
      ]
      return {
        step,
        kind: 'error',
        title: 'Something went wrong',
        message,
        options,
      }
    }
    default:
      return { step, kind: 'auto', title: step }
  }
}

/**
 * Apply a user input to progress. Post-save tail choice/input steps delegate
 * the reducer to the shared neutral module. The create-new choice/input steps
 * persist their field(s) exactly as the TUI's onSubmit/onChange handlers do
 * (ui/app.tsx). All other steps return progress unchanged (real per-step
 * mutations land in later batches).
 *
 * PURE — no IO. The .p8 file read + keyId extraction + Apple verification are
 * effect-boundary concerns (p8-method-select / verifying-key); the reducers here
 * only record the raw user input into progress.
 */
export function applyIosInput(
  step: OnboardingStep,
  progress: OnboardingProgress,
  input: unknown,
): OnboardingProgress {
  // Post-save tail: delegate the tail choice/input reducers to the shared
  // platform-neutral module. The iOS tail input variants are structurally
  // identical to TailInput, so they thread straight through.
  if (TAIL_INPUT_STEPS.has(step))
    return applyTailInput(step as TailStep, progress, input as TailInput)

  switch (step) {
    // ── setup-method-select ───────────────────────────────────────────────────
    // ui/app.tsx:3042 — `value === 'import' ? 'import-existing' : 'create-new'`.
    // Persisting the fork is what lets resume route the right path (create-new
    // .p8 chain vs the import sub-flow) instead of re-asking.
    case 'setup-method-select': {
      const i = input as Extract<IosInput, { step: 'setup-method-select' }>
      return { ...progress, setupMethod: i.value === 'import' ? 'import-existing' : 'create-new' }
    }

    // ── api-key-instructions ──────────────────────────────────────────────────
    // ui/app.tsx:3800–3806 — navigation-only choice. 'picker' opens the native
    // dialog (the p8-method-select effect), 'manual' goes to input-p8-path. The
    // driver routes on the choice value; the pure reducer records nothing.
    case 'api-key-instructions':
      return progress

    // ── input-p8-path ─────────────────────────────────────────────────────────
    // ui/app.tsx:3836–3849 — the TUI reads/validates the file (IO) then persists
    // the path. Here we ONLY persist the path string (file validation + keyId
    // extraction are the effect boundary). Persisting just p8Path keeps the
    // resume routing landing on input-key-id (getResumeStep: p8Path set, no keyId).
    case 'input-p8-path': {
      const i = input as Extract<IosInput, { step: 'input-p8-path' }>
      const p8Path = i.value.trim()
      if (!p8Path)
        return progress
      return { ...progress, p8Path }
    }

    // ── input-key-id ──────────────────────────────────────────────────────────
    // ui/app.tsx:3863–3872 — `(value || keyId).trim()` reuses the detected key
    // ID when the user just presses Enter. The detected default is the value the
    // picker effect persisted (progress.keyId) or, on the manual path, the value
    // re-derived from the AuthKey_<id>.p8 filename. An empty submission with no
    // detectable default is a no-op (stays on the step) — mirroring the TUI guard.
    case 'input-key-id': {
      const i = input as Extract<IosInput, { step: 'input-key-id' }>
      const detected = progress.keyId || extractKeyIdFromP8Path(progress.p8Path ?? '')
      const keyId = (i.value || detected).trim()
      if (!keyId)
        return progress
      return { ...progress, keyId }
    }

    // ── input-issuer-id ───────────────────────────────────────────────────────
    // ui/app.tsx:3882–3888 — trim + reject empty, then persist. With p8Path +
    // keyId + issuerId all present, resume routes to verifying-key.
    case 'input-issuer-id': {
      const i = input as Extract<IosInput, { step: 'input-issuer-id' }>
      const issuerId = i.value.trim()
      if (!issuerId)
        return progress
      return { ...progress, issuerId }
    }

    // ── cert-limit-prompt (EPHEMERAL choice — persists NOTHING) ────────────────
    // app.tsx:3917–3926 — the picked cert id (or '__exit__') is EPHEMERAL; the TUI
    // stashes it in setCertToRevoke (React state), never in progress.json. The
    // pure reducer records nothing — the driver resolves the picked
    // AscDistributionCert into deps.carried.certToRevoke and re-drives the step
    // through runIosEffect, which returns revoking-certificate (pick) or error
    // (exit). Keeping this a no-op means a resume never re-derives the ephemeral
    // revoke selection (it re-enters via a fresh creating-certificate).
    case 'cert-limit-prompt':
      return progress

    // ── duplicate-profile-prompt (EPHEMERAL choice — persists NOTHING) ─────────
    // app.tsx:3941–3949 — the delete/exit decision is EPHEMERAL. Per the audit's
    // sequencing model the reducer persists nothing: duplicateProfileOrigin was
    // already persisted upstream (creating-profile / import-create-profile-only),
    // which is the ONLY persisted state the post-deletion routing needs. The
    // driver records the choice into deps.carried.confirmDeleteDuplicates and
    // re-drives the step through runIosEffect (delete → deleting-duplicate-profiles;
    // exit → error).
    case 'duplicate-profile-prompt':
      return progress

    // ── verify-app (EPHEMERAL choice — persists NOTHING) ───────────────────────
    // app.tsx:3043–3391 — the gate/picker actions (pick an app / autofix /
    // re-check / open the create-app page / back / cancel) are EPHEMERAL; the TUI
    // routes them via the resolver effect, never persisting the pick. The pure
    // reducer records nothing — the driver records the pick into
    // deps.carried.verifyAction (+ verifyChosenApp for an app pick) and re-drives
    // the step through runIosEffect. The ONLY persisted write on this step — the
    // verified iosBundleIdOverride on a gate PASS — happens in the effect, not here.
    case 'verify-app':
      return progress

    // ── import-distribution-mode ──────────────────────────────────────────────
    // app.tsx:3179–3231. The import sub-flow's first fork. Two persisted shapes:
    //   - 'app_store' | 'ad_hoc' → persist setupMethod='import-existing' AND the
    //     chosen importDistribution. These two fields are exactly what
    //     getImportEntryStep reads to route the next step (ad_hoc →
    //     import-pick-identity; app_store → the .p8 chain entry / verifying-key),
    //     and what getIosResumeStep reads on a later restart — so resume ==
    //     fresh-advance with no re-ask of the fork.
    //   - '__cancel__' → the user bails to the create-new path: persist
    //     setupMethod='create-new' and CLEAR any previously-saved
    //     importDistribution (immutably — build a copy without the key) so a
    //     stale ad_hoc/app_store choice can't leak back into the create-new
    //     routing. Mirrors app.tsx:3186–3188 (existing.setupMethod='create-new';
    //     delete existing.importDistribution). The driver then routes to
    //     api-key-instructions (getImportEntryStep on a cleared progress).
    case 'import-distribution-mode': {
      const i = input as Extract<IosInput, { step: 'import-distribution-mode' }>
      if (i.value === '__cancel__') {
        const { importDistribution: _dropped, ...rest } = progress
        return { ...rest, setupMethod: 'create-new' }
      }
      return { ...progress, setupMethod: 'import-existing', importDistribution: i.value }
    }

    // ── import-pick-identity (EPHEMERAL choice — persists NOTHING) ─────────────
    // app.tsx:3270–3305 — the picked identity SHA-1 (or '__cancel__') is EPHEMERAL;
    // the TUI stashes the identity in setChosenIdentity (React state), never in
    // progress.json. The pure reducer records nothing — the driver resolves the
    // SHA-1 to the picked SigningIdentity against the carried importMatches, records
    // it in deps.carried.chosenIdentity, and re-drives the step through runIosEffect
    // (the BATCH 3 ephemeral-branching mechanism). Keeping this a no-op means a
    // resume never re-derives the ephemeral identity (it re-enters via a re-run
    // import-scanning + re-rendered picker, per the audit's resume contract).
    case 'import-pick-identity':
      return progress

    // ── import-pick-profile (EPHEMERAL choice — persists NOTHING) ──────────────
    // app.tsx:3469–3522 — the picked profile UUID (or '__back__') is EPHEMERAL; the
    // TUI stashes the profile in setChosenProfile, never in progress.json. The pure
    // reducer records nothing — the driver resolves the UUID to the picked
    // DiscoveredProfile, records it in deps.carried.chosenProfile, and re-drives the
    // step through runIosEffect (valid → import-export-warning; '__back__' →
    // import-pick-identity; invalid → error). Ephemeral, so resume re-renders.
    case 'import-pick-profile':
      return progress

    // ── import-no-match-recovery (EPHEMERAL choice — persists NOTHING) ─────────
    // app.tsx:3579–3609 — the recovery-menu pick (create / provide-profile-path /
    // browser / back) is EPHEMERAL; the TUI routes via setStep, never persisting
    // the choice. The pure reducer records nothing — the driver records the pick
    // into deps.carried.recoveryAction and re-drives the step through runIosEffect.
    // CRITICAL (risk #8): the reducer must NOT touch noMatchReason; the resolver
    // threads the carried reason back unchanged so a re-entry keeps the SAME menu
    // variant. The ONLY persisted write on this branch — pendingRecoveryAction for
    // the no-ASC-key 'create' path — happens in the resolver (it routes through the
    // .p8 chain), NOT here, mirroring app.tsx:3605 setPendingRecoveryAction.
    case 'import-no-match-recovery':
      return progress

    // ── import-portal-explanation (EPHEMERAL choice — persists NOTHING) ────────
    // app.tsx:3738–3755 — the portal-walkthrough pick (use-create / use-file /
    // open-anyway / back) is EPHEMERAL navigation; the TUI routes via setStep. The
    // pure reducer records nothing — the driver records the pick into
    // deps.carried.portalAction and re-drives as a resolver. noMatchReason is left
    // untouched so the 'open-anyway' / 'back' bounce keeps the recovery variant.
    case 'import-portal-explanation':
      return progress

    // ── import-export-warning (EPHEMERAL choice — persists NOTHING) ────────────
    // app.tsx:3769–3784 — the export-warning pick (go / back / exit) is EPHEMERAL
    // navigation; the TUI routes via setStep / exitOnboarding, never persisting the
    // choice. The pure reducer records nothing — the driver records the pick into
    // deps.carried.exportWarningAction and re-drives the step through runIosEffect
    // ('go' → import-exporting; 'back' → import-pick-profile; 'exit' → exit).
    // Ephemeral, so resume re-renders.
    case 'import-export-warning':
      return progress

    default:
      return progress
  }
}

// ─── error-step result helper (BATCH 8) ─────────────────────────────────────────
//
// Build the `next: 'error'` IosEffectResult, threading the failing step's MESSAGE
// (so the error VIEW has content — iosViewForStep('error') reads ctx.error) and,
// when the failure is recoverable, the step to re-run (so the view offers "Try
// again" and the resolver routes a retry there). This mirrors the TUI's
// handleError(err, failedStep) → setError(message) + setRetryStep(failedStep)
// (app.tsx:1115-1116). Both ride transient ONLY — never persisted (error/retryStep
// are EPHEMERAL runtime state; getIosResumeStep never returns 'error'). Effects
// keep their existing deps.onLog('✖ …') call (the streaming log line); this just
// ALSO surfaces the message to the error screen. `retryStep` is omitted for the
// EXIT-sink branches (cert-limit / duplicate-profile / export-warning 'exit'),
// which are user-initiated exits, not recoverable failures — so the error view
// offers only Restart / Exit, exactly as the TUI shows no retry without a retryStep.
function iosError(
  progress: OnboardingProgress,
  message: string,
  retryStep?: OnboardingStep,
  extraTransient?: Partial<IosStepCtx>,
): IosEffectResult {
  return {
    progress,
    next: 'error',
    transient: { error: message, ...(retryStep ? { retryStep } : {}), ...extraTransient },
  }
}


/**
 * Run the async side-effect for a step. Post-save tail steps (incl.
 * saving-credentials) delegate to the shared neutral module via toTailDeps; the
 * neutral result maps 1:1 onto IosEffectResult (next is a wider OnboardingStep;
 * transient is a subset of IosStepCtx). All other steps are not implemented yet
 * — the real Apple-API / keychain / build effects land in later batches.
 */
export async function runIosEffect(
  step: OnboardingStep,
  progress: OnboardingProgress,
  deps: IosEffectDeps,
): Promise<IosEffectResult> {
  // Post-save tail: delegate to the platform-neutral shared module. The tail
  // routing/branching/transient-threading lives there once for ios + android;
  // iOS supplies its platform tag + credential SHAPE via toTailDeps.
  if (TAIL_EFFECT_STEPS.has(step)) {
    const result = await runTailEffect(step as TailStep, progress, toTailDeps(deps))
    return {
      progress: result.progress,
      next: result.next as OnboardingStep | undefined,
      transient: result.transient,
    }
  }

  switch (step) {
    // ── backing-up ──────────────────────────────────────────────────────────
    // app.tsx:1230–1255. Copy the existing ~/.capgo-credentials/credentials.json
    // to a timestamped sibling (via the injected backup dep) BEFORE the cert/
    // profile phase can overwrite it, then advance to the setup-method fork.
    // A missing source file is non-fatal (yellow warning) — the gate's promise
    // was "backup first", not "must exist". The gate flips to 'done' so a resume
    // falls THROUGH to the setup routing instead of re-parking on backing-up.
    //
    // Routing mirrors the TUI: macOS offers the import-vs-create fork at
    // setup-method-select; off-macOS the import sub-flow is unavailable, so the
    // user goes straight to the create-new api-key-instructions. isMacOS defaults
    // to true (the macOS-first target) when the dep is omitted.
    case 'backing-up': {
      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const backupPath = credentialsBackupDestPath(date)
      try {
        await deps.copyFile?.(
          credentialsBackupSourcePath(),
          backupPath,
        )
        // Parity with the bespoke TUI (main app.tsx:1473): the log line carries
        // the destination path so the user can find the backup.
        deps.onLog?.(`✔ Backup saved · ${backupPath}`)
      }
      catch (err) {
        deps.onInternalLog?.(`credentials backup failed: ${err instanceof Error ? err.message : String(err)}`)
        deps.onLog?.('⚠ Could not backup credentials (file may not exist yet)', 'yellow')
      }
      const nextProgress: OnboardingProgress = { ...progress, _credentialsExistGate: 'done' }
      await deps.saveProgress?.(progress.appId, nextProgress)
      const onMac = deps.isMacOS ? deps.isMacOS() : true
      return { progress: nextProgress, next: onMac ? 'setup-method-select' : 'api-key-instructions' }
    }

    // ── p8-method-select (file-picker effect) ─────────────────────────────────
    // app.tsx:1862–1895. Open the native .p8 picker EXACTLY ONCE (idempotent —
    // the TUI guards with pickerOpenedRef; the engine guards with the carried
    // `pickerOpened` flag so a re-render/redrive does NOT re-open the dialog).
    //   - file chosen → read it, persist {p8Path, extracted keyId}, return the
    //     raw bytes in transient.p8Content, advance to input-key-id.
    //   - cancelled   → fall back to manual entry at input-p8-path.
    // Persisting the extracted keyId here means a quit-before-the-Key-ID-step
    // resume restores it instead of showing the empty placeholder (app.tsx:1879).
    case 'p8-method-select': {
      // Idempotency guard: if the picker already ran this drive, do not re-open.
      if (deps.carried?.pickerOpened)
        return { progress, next: 'input-p8-path', transient: { pickerOpened: true } }

      const selected = await deps.openP8FilePicker?.()
      if (!selected) {
        // User cancelled the picker — fall back to manual path entry.
        return { progress, next: 'input-p8-path', transient: { pickerOpened: true } }
      }

      const bytes = await deps.readFile!(selected)
      const extracted = extractKeyIdFromP8Path(selected)
      const nextProgress: OnboardingProgress = {
        ...progress,
        p8Path: selected,
        ...(extracted ? { keyId: extracted } : {}),
      }
      await deps.saveProgress?.(progress.appId, nextProgress)
      deps.onLog?.(`✔ Key file selected · ${selected}`)
      return {
        progress: nextProgress,
        next: 'input-key-id',
        transient: { pickerOpened: true, p8Content: bytes },
      }
    }

    // ── verifying-key ─────────────────────────────────────────────────────────
    // app.tsx:1897–1976. Verify the ASC API key with Apple, then route into the
    // remote App Store verification gate (verify-app, the PR #2397 detour) before
    // any cert/profile work. The .p8 BYTES are transient: the driver carries them
    // from the .p8 input chain via deps.carried.p8Content; on a crash-recovery
    // resume that lost them, re-read the file at p8Path.
    //
    // On success persist completedSteps.apiKeyVerified (keyId + issuerId), MERGING
    // into existing progress so setupMethod / importDistribution are preserved
    // (app.tsx:1907–1928 — a fresh-object save here once wiped the import context
    // and resumed into create-new). The verified team id (if any) rides transient
    // so the downstream cert/profile effects can reuse it without a re-fetch.
    //
    // Routing after a successful verify (mirrors the TUI's verifying-key fork):
    //   - pendingRecoveryAction → import-create-profile-only (UNCHANGED — the
    //     deferred import recovery action resumes; it never detours via verify-app).
    //   - import-existing + app_store → 'verify-app', with the import continuation
    //     (carried.importMatches > 0 ? import-validating-all-certs :
    //     import-pick-identity — the same matches>0 fork the TUI computes) returned
    //     in transient.pendingVerifyNext. The driver threads it back as
    //     deps.carried.pendingVerifyNext — EPHEMERAL, never persisted: a fresh
    //     mount has none, so every verify-app exit falls back to
    //     creating-certificate (documented at getResumeStep's verify-app branch).
    //   - import-existing + ad_hoc → straight to the import continuation
    //     (ad_hoc never uploads to TestFlight, so verify-app is skipped entirely).
    //   - create-new → 'verify-app' (was creating-certificate); no pendingVerifyNext
    //     is set — the verify-app exits fall back to creating-certificate.
    case 'verifying-key': {
      const keyId = progress.keyId
      const issuerId = progress.issuerId
      if (!keyId || !issuerId)
        throw new Error('verifying-key: keyId/issuerId not yet collected')

      const p8Content = await resolveP8Content(progress, deps)

      try {
        deps.onInternalLog?.(`apple key verify: keyId=${keyId}, issuerId=${issuerId}`)
        const { teamId } = await deps.verifyApiKey!({ keyId, issuerId, p8Content })
        const apiKey: ApiKeyData = { keyId, issuerId }
        // pendingRecoveryAction (BATCH 7b): when the import no-ASC-key 'create'
        // branch routed through the .p8 chain, it persisted
        // pendingRecoveryAction='import-create-profile-only'. After a SUCCESSFUL
        // verify we RESUME that deferred action (clearing the marker immutably so
        // it can't re-fire) INSTEAD of the create-new verify-app detour, exactly
        // as the TUI does (app.tsx importMode && pendingRecoveryAction →
        // setStep(res.next)).
        const resumeAction = progress.pendingRecoveryAction === 'import-create-profile-only'
        const { pendingRecoveryAction: _cleared, ...withoutPending } = progress
        const nextProgress: OnboardingProgress = {
          ...(resumeAction ? withoutPending : progress),
          completedSteps: { ...progress.completedSteps, apiKeyVerified: apiKey },
        }
        await deps.saveProgress?.(progress.appId, nextProgress)
        deps.onLog?.(`✔ API Key verified — Key: ${keyId}`)
        const isImport = progress.setupMethod === 'import-existing'
        const importTarget: OnboardingStep = (deps.carried?.importMatches?.length ?? 0) > 0
          ? 'import-validating-all-certs'
          : 'import-pick-identity'
        const next: OnboardingStep = resumeAction
          ? 'import-create-profile-only'
          : isImport
            ? (progress.importDistribution === 'app_store' ? 'verify-app' : importTarget)
            : 'verify-app'
        const pendingVerifyNext = next === 'verify-app' && isImport ? importTarget : undefined
        return {
          progress: nextProgress,
          next,
          transient: { apiKey, ...(teamId ? { teamId } : {}), ...(pendingVerifyNext ? { pendingVerifyNext } : {}) },
        }
      }
      catch (err) {
        deps.onInternalLog?.(`apple key verify failed: ${err instanceof Error ? err.message : String(err)}`)
        // NO onLog echo — the bespoke TUI (main) routes this to handleError only;
        // the error screen renders the message, so a log echo would paint the
        // multi-line advice twice on the same frame (live e2e catch 2026-06-11).
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── verify-app (effect + carried-driven gate resolver, PR #2397 port) ──────
    // app.tsx:1504–1619 (the initial fetch) + 3043–3391 (the gate actions). The
    // remote App Store Connect verification: an app_store build must upload to an
    // ASC app whose bundleId equals the project's Release
    // PRODUCT_BUNDLE_IDENTIFIER. The classification + gate escalation are the
    // PURE helpers (classifyAppVerification / evaluateGate from
    // app-verification.ts); the IO — the parallel /v1/apps + /v1/bundleIds
    // fetches, the FRESH pbxproj re-detect, and the Path-A auto-fix write — is
    // the injected deps (listApps / listBundleIds / detectBundleIds /
    // writeReleaseBundleId).
    //
    // TWO MODES, keyed off deps.carried.verifyAction (the same carried-driven
    // resolver mechanism as cert-limit-prompt / import-no-match-recovery):
    //
    //   INITIAL (no verifyAction) — re-detect the Release build id FRESH from
    //   disk (never a memoized detection), fetch apps+bundleIds in parallel, and
    //   classify. Exits:
    //     - exact-match       → log ✓, PERSIST the verified Release id as
    //       iosBundleIdOverride (+ iosBundleIdContextAppId = the capacitor appId,
    //       so a later run detects context drift) via the returned progress, then
    //       advance to carried.pendingVerifyNext ?? 'creating-certificate'.
    //     - no Release config → warn + pass through (we never gate on a Debug or
    //       plist fallback).
    //     - ASC fetch failure → warn + pass through (we can't verify a transient
    //       failure, and blocking on it would trap the user).
    //     - otherwise         → PARK (next: 'verify-app') with the classification
    //       + picker/gate state in transient (verifyApps / verifyRegisteredIds /
    //       verifyReleaseBundleId / verifyResult, pre-seeding verifyPath
    //       'create-app' for the no-apps cases) for the driver to render.
    //
    //   RESOLVER (verifyAction recorded) — the driver re-drives the parked step
    //   with the user's gate pick in carried:
    //     - 'pick'      → Path A (fix-build-id) with the chosen app, or a
    //       defensive straight pass when the chosen app already matches.
    //     - 'create-new'→ Path B (the picker's "my build ID is correct" escape).
    //     - 'autofix'   → rewrite PRODUCT_BUNDLE_IDENTIFIER → the chosen app's id
    //       (writeReleaseBundleId), then fall into the 'continue' re-check.
    //     - 'continue'  → re-detect FRESH from disk + evaluateGate; pass →
    //       persist + advance; blocked → bump verifyAttempt (the escalation).
    //     - 'recheck'   → Path B re-poll /v1/apps + evaluateGate; blocked →
    //       bump verifyAttempt + verifyAskReopen (ask before re-opening).
    //     - 'open'/'reopen' → register the id (ensureBundleId, best-effort) +
    //       open the ASC create-app page (openExternal, best-effort).
    //     - 'back'      → reset to the picker (verifyPath/chosen/attempt/askReopen).
    //     - 'cancel'    → the error exit sink (no retryStep), mirroring the
    //       cert-limit-prompt exit convention; the TUI's cancelGate exits directly.
    //
    // EPHEMERAL: every verify* field + pendingVerifyNext rides transient/carried
    // only — the SINGLE persisted write is the verified iosBundleIdOverride
    // (+ context appId) on a gate PASS, exactly what persistVerifyOverride wrote.
    case 'verify-app': {
      const pendingNext: OnboardingStep = deps.carried?.pendingVerifyNext ?? 'creating-certificate'

      // Persist the verified Release build id as the iosBundleIdOverride (the
      // TUI's persistVerifyOverride): after the gate passes the wired-in value is
      // a build id the project produces AND the App Store has. Also snapshots the
      // current capacitor appId so a later run can detect context drift and
      // re-verify. A disk error saving is NON-fatal (warn + continue) — the user
      // may just be re-prompted on the next run.
      const persistOverride = async (releaseBundleId: string, saveFailLog: string): Promise<OnboardingProgress> => {
        const contextAppId = deps.detectBundleIds?.().capacitor.value
        const nextProgress: OnboardingProgress = {
          ...progress,
          iosBundleIdOverride: releaseBundleId,
          ...(contextAppId !== undefined ? { iosBundleIdContextAppId: contextAppId } : {}),
        }
        try {
          await deps.saveProgress?.(progress.appId, nextProgress)
        }
        catch (err) {
          deps.onInternalLog?.(`failed to persist verify override (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
          deps.onLog?.(saveFailLog, 'yellow')
        }
        return nextProgress
      }

      const action = deps.carried?.verifyAction
      if (action) {
        const releaseId = deps.carried?.verifyReleaseBundleId ?? ''
        const attemptSoFar = deps.carried?.verifyAttempt ?? 0
        const chosen = deps.carried?.verifyChosenApp ?? null

        // ── 'cancel' — the gate's exit escape (app.tsx:3188-3192) ──────────────
        if (action === 'cancel')
          return iosError(progress, 'Onboarding cancelled at the App Store verification gate. Re-run `build init` to resume.')

        // ── 'back' — return to the app picker, resetting the per-attempt gate
        // state so the re-picked target starts fresh (app.tsx:3197-3202) ────────
        if (action === 'back')
          return { progress, next: 'verify-app', transient: { verifyPath: null, verifyChosenApp: null, verifyAttempt: 0, verifyAskReopen: false } }

        // ── 'create-new' — the picker's "none of these, my build ID is correct"
        // escape → Path B (app.tsx:3361-3365) ───────────────────────────────────
        if (action === 'create-new')
          return { progress, next: 'verify-app', transient: { verifyPath: 'create-app' as GatePath } }

        // ── 'pick' — an existing app chosen in the picker (app.tsx:3366-3386) ──
        if (action === 'pick') {
          if (!chosen)
            return { progress, next: 'verify-app', transient: {} }
          if (chosen.bundleId === releaseId) {
            // Already matches — pass straight through (defensive; the exact-match
            // case is normally handled by the initial fetch).
            deps.onLog?.(`✓ Building "${chosen.name}" (${releaseId}) — matches your App Store app.`)
            const nextProgress = await persistOverride(releaseId, '⚠ Could not save the verified bundle ID; you may be re-prompted next run.')
            return { progress: nextProgress, next: pendingNext, transient: { verifyChosenApp: chosen } }
          }
          return { progress, next: 'verify-app', transient: { verifyPath: 'fix-build-id' as GatePath, verifyChosenApp: chosen } }
        }

        // ── 'autofix' / 'continue' — Path A. autofix first rewrites the Release
        // PRODUCT_BUNDLE_IDENTIFIER to the chosen app's bundle id (only
        // assignments equal to the current build id are touched; capacitor.config
        // is never modified — app.tsx:3108-3127); BOTH then re-read pbxproj FRESH
        // from disk and re-check against the chosen app (app.tsx:3087-3101). ────
        if (action === 'autofix' || action === 'continue') {
          if (action === 'autofix' && chosen) {
            try {
              const { changed } = deps.writeReleaseBundleId!(releaseId, chosen.bundleId)
              if (changed > 0)
                deps.onLog?.(`🔧 Updated PRODUCT_BUNDLE_IDENTIFIER → "${chosen.bundleId}" in your Xcode project.`)
              else
                deps.onLog?.(`⚠ Couldn't find PRODUCT_BUNDLE_IDENTIFIER "${releaseId}" to update — edit it in Xcode, then re-check.`, 'yellow')
            }
            catch {
              deps.onLog?.('⚠ Could not write to your Xcode project — edit PRODUCT_BUNDLE_IDENTIFIER manually, then re-check.', 'yellow')
            }
          }
          const fresh = deps.detectBundleIds?.()
          const newRelease = fresh?.releaseResolved && fresh.pbxproj ? fresh.pbxproj.value : ''
          const satisfied = chosen !== null && newRelease === chosen.bundleId
          const attempt = attemptSoFar + 1
          if (evaluateGate({ satisfied, attempt }).proceed) {
            deps.onLog?.(`✓ Building "${chosen!.name}" (${newRelease}) — matches your App Store app.`)
            const nextProgress = await persistOverride(newRelease, '⚠ Verified the App Store app but could not save the bundle ID override to disk — you may be re-prompted next run.')
            return { progress: nextProgress, next: pendingNext, transient: { verifyReleaseBundleId: newRelease } }
          }
          return { progress, next: 'verify-app', transient: { verifyReleaseBundleId: newRelease, verifyAttempt: attempt } }
        }

        // ── 'recheck' — Path B re-poll: re-fetch /v1/apps live and check for an
        // app matching the Release build id. Never re-opens the browser
        // automatically (app.tsx:3131-3165). ────────────────────────────────────
        if (action === 'recheck') {
          const attempt = attemptSoFar + 1
          try {
            const apps = await deps.listApps!()
            const satisfied = apps.some(a => a.bundleId === releaseId)
            if (evaluateGate({ satisfied, attempt }).proceed) {
              const matched = apps.find(a => a.bundleId === releaseId)
              deps.onLog?.(`✓ Building "${matched?.name ?? releaseId}" (${releaseId}) — matches your App Store app.`)
              const nextProgress = await persistOverride(releaseId, '⚠ Verified the App Store app but could not save the bundle ID override to disk — you may be re-prompted next run.')
              return { progress: nextProgress, next: pendingNext, transient: { verifyApps: apps } }
            }
            // Still not found — count the attempt so the escalating box visibly
            // advances, then ask before re-opening the browser.
            return { progress, next: 'verify-app', transient: { verifyApps: apps, verifyAttempt: attempt, verifyAskReopen: true } }
          }
          catch {
            // Couldn't reach ASC — still count the attempt so the user sees the
            // re-check happened (not a silent no-op).
            deps.onLog?.('⚠ Couldn\'t reach App Store Connect to re-check — check your connection and try again.', 'yellow')
            return { progress, next: 'verify-app', transient: { verifyAttempt: attempt, verifyAskReopen: true } }
          }
        }

        // ── 'open' / 'reopen' — open the ASC new-app page. Registers the
        // identifier first (idempotent, best-effort) so it is selectable in the
        // form. Opens ONLY on explicit choice (app.tsx:3169-3186). ──────────────
        try {
          await deps.ensureBundleId?.(releaseId)
        }
        catch {
          // Registration is best-effort — the user can still create the app and
          // pick/register the id in the web form.
        }
        try {
          await deps.openExternal?.('https://appstoreconnect.apple.com/apps')
        }
        catch {
          deps.onLog?.('⚠ Could not open your browser. Visit https://appstoreconnect.apple.com/apps to create the app.', 'yellow')
        }
        return { progress, next: 'verify-app', transient: { verifyAskReopen: false } }
      }

      // ── INITIAL fetch (app.tsx:1516-1618) ────────────────────────────────────
      // Re-detect FRESH from disk so the Release build id reflects any edit the
      // user made since the wizard started (and bypasses any driver memo).
      const detected = deps.detectBundleIds?.()
      const releaseBundleId = detected?.releaseResolved && detected.pbxproj ? detected.pbxproj.value : ''
      const debugReleaseDiffer = detected?.debugReleaseDiffer ?? false
      // Debug ≠ Release awareness note — informational only, never gates.
      let verifyDebugBundleId = ''
      if (debugReleaseDiffer && detected?.debug && detected.pbxproj) {
        verifyDebugBundleId = detected.debug.value
        deps.onLog?.(
          `⚠ Debug builds "${detected.debug.value}" but Release builds "${detected.pbxproj.value}" — Capgo Builder signs the RELEASE ID "${detected.pbxproj.value}".`,
          'yellow',
        )
      }
      const baseTransient: Partial<IosStepCtx> = {
        verifyReleaseBundleId: releaseBundleId,
        verifyDebugBundleId,
        verifyDebugReleaseDiffer: debugReleaseDiffer,
      }

      try {
        const [apps, registeredBundleIds] = await Promise.all([deps.listApps!(), deps.listBundleIds!()])

        // No Release config resolvable → warn, skip gating. We never gate on a
        // Debug or plist fallback (spec: Release is authoritative).
        if (!releaseBundleId) {
          deps.onLog?.('⚠ Could not resolve a Release PRODUCT_BUNDLE_IDENTIFIER from your Xcode project — skipping remote App Store verification.', 'yellow')
          return {
            progress,
            next: pendingNext,
            transient: { ...baseTransient, verifyApps: apps, verifyRegisteredIds: registeredBundleIds, verifyResult: 'no-release-config' },
          }
        }

        const { result, matchedApp } = classifyAppVerification({ releaseBundleId, apps, registeredBundleIds })

        if (result === 'exact-match' && matchedApp) {
          deps.onLog?.(`✓ Building "${matchedApp.name}" (${releaseBundleId}) — matches your App Store app.`)
          const nextProgress = await persistOverride(releaseBundleId, '⚠ Verified the App Store app but could not save the bundle ID override to disk — you may be re-prompted next run.')
          return {
            progress: nextProgress,
            next: pendingNext,
            transient: { ...baseTransient, verifyApps: apps, verifyRegisteredIds: registeredBundleIds, verifyResult: result },
          }
        }

        // Not satisfied → PARK on verify-app; the driver renders the picker +
        // gate. Pre-seed Path B for the no-apps cases (no picker needed).
        return {
          progress,
          next: 'verify-app',
          transient: {
            ...baseTransient,
            verifyApps: apps,
            verifyRegisteredIds: registeredBundleIds,
            verifyResult: result,
            ...(result !== 'wrong-build-id' ? { verifyPath: 'create-app' as GatePath } : {}),
          },
        }
      }
      catch (err) {
        // ASC fetch failure (auth / rate-limit / network): we can't verify a
        // transient failure, and blocking on it would trap the user. Warn
        // visibly and proceed — the local bundle-id resolution already ran.
        deps.onInternalLog?.(`verify-app: could not reach App Store Connect, skipping verification: ${err instanceof Error ? err.message : String(err)}`)
        deps.onLog?.('⚠ Couldn\'t reach App Store Connect to verify your app; continuing without remote verification.', 'yellow')
        return {
          progress,
          next: pendingNext,
          transient: { ...baseTransient, verifyApps: [], verifyRegisteredIds: [], verifyResult: 'fetch-failed' },
        }
      }
    }

    // ── creating-certificate ──────────────────────────────────────────────────
    // app.tsx:1978–2025. Generate a CSR + private key, ask Apple to mint a
    // distribution certificate from the CSR, then build the .p12 locally from
    // Apple's cert content + the private key. The cert id / expiry / teamId /
    // p12 base64 are persisted to completedSteps.certificateCreated (a MARKER —
    // the p12 base64 IS the credential, written here so resume can rebuild the
    // saved-credential map without re-minting). The private key PEM is NEVER
    // persisted (the TUI stashes it on `_privateKeyPem` only across the await and
    // deletes it after .p12 creation; the IO-free engine keeps it in a local).
    //
    // Cert-limit branch: Apple rejects a 4th cert → CertificateLimitError. Surface
    // the existing certs in transient.existingCerts (fetched via listCertificates)
    // and route to cert-limit-prompt (its view lands in BATCH 3). Other failures
    // route to 'error'.
    case 'creating-certificate': {
      const { csr, privateKeyPem } = deps.generateCsr!()
      try {
        const cert = await deps.createCertificate!({ csr })
        const p12Base64 = deps.createP12!({
          certificatePem: cert.certificateContent,
          privateKeyPem,
          password: DEFAULT_P12_PASSWORD,
        })
        const certData: CertificateData = {
          certificateId: cert.certificateId,
          expirationDate: cert.expirationDate,
          teamId: cert.teamId,
          p12Base64,
        }
        const nextProgress: OnboardingProgress = {
          ...progress,
          completedSteps: { ...progress.completedSteps, certificateCreated: certData },
        }
        await deps.saveProgress?.(progress.appId, nextProgress)
        deps.onLog?.(`✔ Distribution certificate created — Expires ${cert.expirationDate}`)
        return {
          progress: nextProgress,
          next: 'creating-profile',
          transient: { certData, ...(certData.teamId ? { teamId: certData.teamId } : {}) },
        }
      }
      catch (err) {
        if (err instanceof CertificateLimitError) {
          // Offer the existing certs for revocation. Prefer the certs carried on
          // the error; fall back to a fresh list via listCertificates.
          const existingCerts = err.certificates?.length
            ? err.certificates
            : (await deps.listCertificates?.()) ?? []
          return { progress, next: 'cert-limit-prompt', transient: { existingCerts } }
        }
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── creating-profile ──────────────────────────────────────────────────────
    // app.tsx:2049–2088. Register/find the bundle id on Apple and create the App
    // Store provisioning profile linking the cert. The resolved bundle id is the
    // confirmed override (iosBundleIdOverride) or config.appId — the SAME value
    // the provisioning_map is keyed by at saving-credentials. On success persist
    // completedSteps.profileCreated and thread cert/profile/teamId through
    // transient so the saving-credentials handoff reuses them without a re-fetch.
    //
    // Duplicate branch: Apple already has Capgo profiles for this bundle id →
    // DuplicateProfileError. Record duplicateProfileOrigin='creating-profile' so
    // the post-deletion effect retries the create-new path (not the import D2),
    // surface the duplicates in transient, and route to duplicate-profile-prompt
    // (its view lands in BATCH 3). Other failures route to 'error'.
    case 'creating-profile': {
      const bundleId = resolveIosBundleId(progress, deps)
      const certificateId = deps.carried?.certData?.certificateId
        ?? progress.completedSteps.certificateCreated?.certificateId
      if (!certificateId)
        throw new Error('creating-profile: certificate not yet created')

      try {
        const profile = await deps.createProfile!({ bundleId, certificateId })
        // Detect duplicates AFTER a successful create as well — the TUI surfaces
        // them via the createProfile DuplicateProfileError, but the injected dep
        // may also expose a separate checkDuplicateProfiles probe. When it does
        // and finds duplicates, route to the prompt instead of advancing.
        const duplicates = (await deps.checkDuplicateProfiles?.(bundleId)) ?? []
        if (duplicates.length > 0) {
          const nextProgress: OnboardingProgress = {
            ...progress,
            duplicateProfileOrigin: 'creating-profile',
          }
          await deps.saveProgress?.(progress.appId, nextProgress)
          return {
            progress: nextProgress,
            next: 'duplicate-profile-prompt',
            transient: { duplicateProfiles: duplicates },
          }
        }

        const profileData: ProfileData = {
          profileId: profile.profileId,
          profileName: profile.profileName,
          profileBase64: profile.profileBase64,
        }
        const teamId = deps.carried?.teamId
          ?? progress.completedSteps.certificateCreated?.teamId
        const certData = deps.carried?.certData ?? progress.completedSteps.certificateCreated
        const nextProgress: OnboardingProgress = {
          ...progress,
          completedSteps: { ...progress.completedSteps, profileCreated: profileData },
        }
        await deps.saveProgress?.(progress.appId, nextProgress)
        deps.onLog?.(`✔ Provisioning profile created — "${profile.profileName}"`)
        return {
          progress: nextProgress,
          next: 'saving-credentials',
          transient: {
            profileData,
            ...(certData ? { certData } : {}),
            ...(teamId ? { teamId } : {}),
          },
        }
      }
      catch (err) {
        if (err instanceof DuplicateProfileError) {
          const nextProgress: OnboardingProgress = {
            ...progress,
            duplicateProfileOrigin: 'creating-profile',
          }
          await deps.saveProgress?.(progress.appId, nextProgress)
          return {
            progress: nextProgress,
            next: 'duplicate-profile-prompt',
            transient: { duplicateProfiles: err.profiles },
          }
        }
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── cert-limit-prompt (resolver effect) ───────────────────────────────────
    // app.tsx:3917–3926. cert-limit-prompt is an EPHEMERAL-branching choice: the
    // user's pick is NEVER persisted, so getIosResumeStep cannot reproduce the
    // target. The driver applies the picked AscDistributionCert into
    // deps.carried.certToRevoke (resolving it from the option id against the
    // carried existingCerts) and re-drives this step as a resolver — exactly the
    // BATCH 2 ephemeral-branching mechanism. A picked cert → revoking-certificate
    // (threaded forward in transient.certToRevoke so the revoke effect has it);
    // no pick (the user chose '__exit__') → error, mirroring the TUI's
    // exitOnboarding branch. PURE routing — no IO, no persistence.
    case 'cert-limit-prompt': {
      const certToRevoke = deps.carried?.certToRevoke
      if (!certToRevoke)
        return iosError(progress, 'Onboarding cancelled at the certificate-limit prompt. Re-run `build init` to resume.')
      return { progress, next: 'revoking-certificate', transient: { certToRevoke } }
    }

    // ── revoking-certificate (effect) ─────────────────────────────────────────
    // app.tsx:2027–2047. Revoke the cert the user picked at cert-limit-prompt,
    // freeing a slot, then RETRY certificate creation. The picked cert rides the
    // transient channel (deps.carried.certToRevoke — its Apple resource id); the
    // driver pre-binds the ASC token into deps.revokeCertificate. On success route
    // back to creating-certificate (the retry); on failure route to error. Nothing
    // is persisted — the cert id is transient only, matching the TUI which clears
    // certToRevoke/existingCerts after the revoke.
    case 'revoking-certificate': {
      const certToRevoke = deps.carried?.certToRevoke
      if (!certToRevoke)
        throw new Error('revoking-certificate: no certToRevoke carried')
      try {
        await deps.revokeCertificate!(certToRevoke.id)
        deps.onLog?.('✔ Old certificate revoked')
        return { progress, next: 'creating-certificate' }
      }
      catch (err) {
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── duplicate-profile-prompt (resolver effect) ────────────────────────────
    // app.tsx:3941–3949. Another EPHEMERAL-branching choice: the delete/exit
    // decision is never persisted. The driver records it into
    // deps.carried.confirmDeleteDuplicates and re-drives this step as a resolver.
    // confirm → deleting-duplicate-profiles; exit → error (the TUI's
    // exitOnboarding branch). The reducer already persisted nothing; the ONLY
    // persisted state is the upstream duplicateProfileOrigin (set by
    // creating-profile / import-create-profile-only), which the deletion effect
    // reads to route back to the right origin. PURE routing — no IO.
    case 'duplicate-profile-prompt': {
      if (!deps.carried?.confirmDeleteDuplicates)
        return iosError(progress, 'Onboarding cancelled at the duplicate-profile prompt. Re-run `build init` to resume.')
      return { progress, next: 'deleting-duplicate-profiles' }
    }

    // ── deleting-duplicate-profiles (effect, EPHEMERAL-dep) ───────────────────
    // app.tsx:2090–2112. Delete EACH duplicate Capgo profile (the driver pre-binds
    // the ASC token into deps.deleteProfile), then route back to the step that
    // raised the duplicate. That origin is the PERSISTED duplicateProfileOrigin —
    // 'creating-profile' on the create-new path, 'import-create-profile-only' on
    // the import path — so an import user is NOT routed back into the create-new
    // creating-profile (the dual-origin resume bug the audit calls out). The
    // duplicate list is EPHEMERAL (deps.carried.duplicateProfiles, surfaced
    // transiently upstream). On any delete failure route to error. Nothing new is
    // persisted (the origin was persisted upstream; the list is transient only).
    case 'deleting-duplicate-profiles': {
      const duplicates = deps.carried?.duplicateProfiles ?? []
      try {
        for (const profile of duplicates)
          await deps.deleteProfile!(profile.id)
        deps.onLog?.(`✔ Removed ${duplicates.length} old profile(s)`)
        // Route back to the persisted origin so the right path retries. Default to
        // creating-profile (the create-new origin) when the marker is absent — the
        // same fallback the TUI's setStep(duplicateProfileOrigin) relies on.
        const origin: OnboardingStep = progress.duplicateProfileOrigin ?? 'creating-profile'
        return { progress, next: origin }
      }
      catch (err) {
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── import-scanning (effect) ──────────────────────────────────────────────
    // app.tsx:1304–1338. The IMPORT branch's silent discovery pass. Run the two
    // Mac scans in parallel (Keychain signing identities + on-disk .mobileprovision
    // files), keep only the DISTRIBUTION identities (the import flow can't sign a
    // release build with a development cert), and pair each identity with the
    // on-disk profiles whose embedded cert SHA-1s include it (matchIdentitiesToProfiles
    // — a PURE helper, so the engine stays IO-free; the IO is the two injected
    // scan deps). The match list + the raw scanned profiles ride transient
    // (importMatches / importProfiles) — NEVER persisted, exactly the android
    // "ephemeral inventory, re-run on resume" contract.
    //
    // ZERO distribution identities → error (the TUI surfaces a support-bundle
    // hint; the engine routes to 'error' and lets the driver render it). Any scan
    // throwing also routes to 'error'.
    //
    // On success the next step is getImportEntryStep(progress): it reads the
    // PERSISTED importDistribution (+ for app_store the .p8/apiKeyVerified chain)
    // to skip questions the user already answered — ad_hoc → import-pick-identity,
    // app_store → the furthest partial .p8 step / verifying-key, unset → back to
    // import-distribution-mode. The TUI additionally wraps this in
    // redirectIfMismatch (a SYNC FS bundle-id read that silently adopts the
    // authoritative Release bundle id); in the IO-free engine that resolution
    // is the DRIVER's job — so the effect returns the un-redirected
    // import-entry target.
    case 'import-scanning': {
      try {
        const [identities, profiles] = await Promise.all([
          deps.listSigningIdentities!(),
          deps.scanProvisioningProfiles!(),
        ])
        const distOnly = identities.filter(i => i.type === 'distribution')
        if (distOnly.length === 0) {
          const msg = 'No iOS Distribution identities found in your default Keychain.'
          deps.onLog?.(`✖ ${msg}`, 'red')
          return iosError(progress, msg, 'import-scanning')
        }
        const importMatches = matchIdentitiesToProfiles(distOnly, profiles)
        deps.onLog?.(`✔ Found ${distOnly.length} distribution identit${distOnly.length === 1 ? 'y' : 'ies'} and ${profiles.length} profile${profiles.length === 1 ? '' : 's'} on this Mac`)
        return {
          progress,
          next: getImportEntryStep(progress),
          transient: { importMatches, importProfiles: profiles },
        }
      }
      catch (err) {
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── import-validating-all-certs (effect) ──────────────────────────────────
    // app.tsx:1351–1510. The eager batch pass that runs BEFORE the import-pick-identity
    // picker renders (only when import-scanning found ≥1 match). For each scanned
    // identity it asks Apple "is this cert still usable?" via the injected
    // deps.classifyCertAvailability (the driver pre-binds the single team-wide cert
    // fetch + SHA-1 index behind it, so the engine just maps identity → availability)
    // and, in PARALLEL, prefetches the Apple profiles for every identity that came
    // back available (deps.listProfilesForCert keyed by the resolved appleCertId).
    // Both results ride transient (identityAvailability / profilePrefetch) — NEVER
    // persisted; the picker reads them to split identities into Available /
    // Unavailable tables. The next step is always import-pick-identity on success
    // (the per-identity failures are sandboxed into the map, not the whole effect);
    // a failure of the batch availability fetch routes to 'error'.
    case 'import-validating-all-certs': {
      const matches = deps.carried?.importMatches ?? []
      try {
        // Batch availability — one classify call per scanned identity. The driver
        // pre-binds the single ASC cert fetch + SHA-1 index inside the dep, so a
        // throw here is the batch fetch failing uniformly → route to error.
        const identityAvailability: Record<string, EnrichedIdentityAvailability> = {}
        for (const m of matches)
          identityAvailability[m.identity.sha1] = await deps.classifyCertAvailability!(m.identity)

        const availableCount = Object.values(identityAvailability).filter(a => a.available).length
        deps.onLog?.(`✔ Apple validation complete — ${availableCount} available, ${matches.length - availableCount} unavailable`)

        // Parallel profile prefetch for every identity Apple confirmed usable
        // (available + a resolved appleCertId). Each fetch is independently
        // sandboxed: one cert's failure leaves the others' results intact and the
        // identity simply renders without a prefetched profile list.
        const toPrefetch = matches.filter((m) => {
          const a = identityAvailability[m.identity.sha1]
          return a?.available && a?.appleCertId
        })
        const profilePrefetch: Record<string, DiscoveredProfile[]> = {}
        await Promise.all(toPrefetch.map(async (m) => {
          const certId = identityAvailability[m.identity.sha1].appleCertId!
          try {
            // listProfilesForCert returns RAW AscProfileSummary[] — synthesize
            // each into a DiscoveredProfile (TUI app.tsx:1460–1471) so the picker
            // + filterProfilesForApp consume them like on-disk profiles. teamId /
            // certificateSha1s come from THIS identity (m.identity).
            const summaries = await deps.listProfilesForCert!(certId)
            profilePrefetch[m.identity.sha1] = summaries.map(s => synthesizeProfileFromAscSummary(s, m.identity))
          }
          catch (err) {
            // Per-fetch error sandbox — leave this identity out of the prefetch map.
            deps.onInternalLog?.(`profile prefetch failed (background): ${err instanceof Error ? err.message : String(err)}`)
          }
        }))

        return {
          progress,
          next: 'import-pick-identity',
          transient: { identityAvailability, profilePrefetch },
        }
      }
      catch (err) {
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }
    // ── import-pick-identity (resolver effect, EPHEMERAL-dep) ─────────────────
    // app.tsx:3270–3305. import-pick-identity is an EPHEMERAL-branching choice: the
    // picked identity is NEVER persisted, so getIosResumeStep cannot reproduce the
    // target. The driver records the picked SigningIdentity into
    // deps.carried.chosenIdentity (resolving it from the option SHA-1 against the
    // carried importMatches) and re-drives this step as a resolver — exactly the
    // BATCH 3 ephemeral-branching mechanism. The routing mirrors the TUI onPick
    // three-way (plus the '__cancel__' escape):
    //   - no chosenIdentity recorded → the user chose '__cancel__' → switch to
    //     create-new at api-key-instructions (app.tsx:3271–3280; the driver clears
    //     setupMethod/importDistribution before re-driving, so this is pure routing).
    //   - usable on-disk profiles for this app+distribution (filterProfilesForApp
    //     over the chosen identity's match.profiles) → import-pick-profile.
    //   - no usable on-disk + an ASC key available (carried .p8 bytes OR a persisted
    //     apiKeyVerified marker) → import-checking-apple-cert (auto-fetch from Apple).
    //   - no usable on-disk + no ASC key → import-no-match-recovery with
    //     noMatchReason='no-profile-on-disk' (app.tsx:3302–3304).
    // PURE routing — no IO, no persistence (the selection lives in carried).
    case 'import-pick-identity': {
      const chosenIdentity = deps.carried?.chosenIdentity
      if (!chosenIdentity)
        return { progress, next: 'api-key-instructions' }

      const matches = deps.carried?.importMatches ?? []
      const match = matches.find(m => m.identity.sha1 === chosenIdentity.sha1)
      const appId = resolveIosBundleId(progress, deps)
      const dist = progress.importDistribution
      const usable = filterProfilesForApp(match?.profiles ?? [], appId, dist)
      if (usable.length > 0)
        return { progress, next: 'import-pick-profile' }

      const apiKeyAvailable = !!(deps.carried?.p8Content || progress.completedSteps.apiKeyVerified)
      if (apiKeyAvailable)
        return { progress, next: 'import-checking-apple-cert' }
      return { progress, next: 'import-no-match-recovery', transient: { noMatchReason: 'no-profile-on-disk' } }
    }

    // ── import-checking-apple-cert (effect, EPHEMERAL-dep) ────────────────────
    // app.tsx:1518–1609. The per-identity Apple-side cert+profile auto-fetch the
    // identity picker routes into when an identity has no usable on-disk profile but
    // an ASC key is available. Resolve the chosen identity's Apple cert resource id
    // (findCertIdBySha1; the driver pre-binds the ASC token), then list the profiles
    // linked to that cert (listProfilesForCert returns RAW AscProfileSummary[]; the
    // engine synthesizes each into a DiscoveredProfile via
    // synthesizeProfileFromAscSummary — the SAME inline mapping the TUI does at
    // app.tsx:1556, populating profileBase64 + certificateSha1s=[chosenIdentity.sha1]).
    // Four outcomes set noMatchReason + route to recovery, the
    // happy path injects the synthesized profiles into the chosen identity's match
    // (so import-pick-profile lists them like on-disk ones) and routes to the picker:
    //   - findCertIdBySha1 null → 'apple-no-cert-match' → import-no-match-recovery.
    //   - listProfilesForCert empty → 'apple-no-profiles-linked' → recovery.
    //   - profiles exist but none usable → classify the cause (bundle mismatch /
    //     distribution mismatch / other) → recovery with the matching reason.
    //   - usable profiles found → import-pick-profile (transient: updated
    //     importMatches + _appleCertIdForChosen).
    // Any thrown Apple-API error routes to 'error'. The cert id, the reason, and the
    // injected profiles are ALL transient (carried) — nothing is persisted.
    case 'import-checking-apple-cert': {
      const chosenIdentity = deps.carried?.chosenIdentity
      if (!chosenIdentity)
        return iosError(progress, 'Internal error: no identity chosen for the Apple cert check.', 'import-scanning')

      const appId = resolveIosBundleId(progress, deps)
      const dist = progress.importDistribution
      const matches = deps.carried?.importMatches ?? []

      try {
        const certId = await deps.findCertIdBySha1!(chosenIdentity.sha1)
        if (!certId) {
          deps.onLog?.(`⚠ Apple lookup returned no match for "${chosenIdentity.name}".`, 'yellow')
          return { progress, next: 'import-no-match-recovery', transient: { noMatchReason: 'apple-no-cert-match' } }
        }
        deps.onLog?.(`✔ Apple recognizes this certificate (ASC id ${certId.slice(0, 8)}…)`)

        // listProfilesForCert returns RAW AscProfileSummary[] — synthesize each
        // into a DiscoveredProfile here, exactly as the TUI does inline at
        // app.tsx:1556–1567 (populating profileBase64 ← profileContent and
        // certificateSha1s ← [chosenIdentity.sha1], teamId ← chosenIdentity.teamId).
        // The synthesized list is what gets filtered + injected below, so the
        // import-pick-profile picker / cert-trust validation see ready profiles.
        const summaries = await deps.listProfilesForCert!(certId)
        const synthesized = summaries.map(s => synthesizeProfileFromAscSummary(s, chosenIdentity))
        if (synthesized.length === 0) {
          deps.onLog?.('ℹ️  Apple has the cert but no profiles linked to it yet.', 'yellow')
          return {
            progress,
            next: 'import-no-match-recovery',
            transient: { noMatchReason: 'apple-no-profiles-linked', _appleCertIdForChosen: certId },
          }
        }

        // Inject the synthesized Apple-side profiles into the chosen identity's
        // match so the import-pick-profile picker lists them like on-disk profiles
        // (app.tsx:1568–1571). Immutable update — a fresh matches array.
        const injectedMatches = matches.map(m => m.identity.sha1 === chosenIdentity.sha1
          ? { ...m, profiles: [...m.profiles, ...synthesized] }
          : m)

        const usableHere = filterProfilesForApp(synthesized, appId, dist)
        if (usableHere.length === 0) {
          // Classify the no-match cause exactly as the TUI (app.tsx:1573–1599):
          // a profile for a DIFFERENT bundle id → bundle mismatch; the right bundle
          // but the wrong distribution → distribution mismatch; otherwise → other.
          const otherBundleIds = synthesized.filter(p => p.bundleId && p.bundleId !== appId)
          const sameBundleWrongDist = synthesized.filter(p => p.bundleId === appId)
          let noMatchReason: IosNoMatchReason
          if (otherBundleIds.length > 0)
            noMatchReason = 'apple-bundle-mismatch'
          else if (sameBundleWrongDist.length > 0)
            noMatchReason = 'apple-distribution-mismatch'
          else
            noMatchReason = 'apple-other'
          deps.onLog?.(`⚠ Apple returned ${synthesized.length} profile${synthesized.length === 1 ? '' : 's'} for this cert but none match this app.`, 'yellow')
          return {
            progress,
            next: 'import-no-match-recovery',
            transient: { noMatchReason, _appleCertIdForChosen: certId, importMatches: injectedMatches },
          }
        }

        deps.onLog?.(`✔ Apple has ${usableHere.length} matching profile${usableHere.length === 1 ? '' : 's'} for "${appId}" — opening the picker`)
        return {
          progress,
          next: 'import-pick-profile',
          transient: { _appleCertIdForChosen: certId, importMatches: injectedMatches },
        }
      }
      catch (err) {
        deps.onLog?.(`✖ ${err instanceof Error ? err.message : String(err)}`, 'red')
        return iosError(progress, err instanceof Error ? err.message : String(err), step)
      }
    }

    // ── import-pick-profile (resolver effect, EPHEMERAL-dep) ──────────────────
    // app.tsx:3469–3522. Another EPHEMERAL-branching choice: the picked profile is
    // never persisted. The driver records the picked DiscoveredProfile into
    // deps.carried.chosenProfile (resolving it from the option UUID against the
    // chosen identity's match profiles) and re-drives this step as a resolver. The
    // routing mirrors the TUI onChange:
    //   - no chosenProfile recorded → the user chose '__back__' → import-pick-identity.
    //   - a profile that passes ALL three validations (bundle id via bundleIdMatches,
    //     distribution type, and the chosen cert's SHA-1 in the profile's allowed-
    //     certs list) → import-export-warning.
    //   - a profile that fails any validation → error (the TUI's handleError; the
    //     filter should make this unreachable, but defense-in-depth catches a
    //     regressed filter / a hand-imported .mobileprovision with the wrong cert).
    // PURE routing — no IO, no persistence (the selection lives in carried).
    case 'import-pick-profile': {
      const chosenProfile = deps.carried?.chosenProfile
      if (!chosenProfile)
        return { progress, next: 'import-pick-identity' }

      const appId = resolveIosBundleId(progress, deps)
      const dist = progress.importDistribution
      const chosenIdentity = deps.carried?.chosenIdentity
      // Defense-in-depth validation mirroring the TUI's onChange guards
      // (app.tsx:3485–3519). Two separate checks emit DISTINCT, detailed log lines
      // with the actual expected-vs-found values — not one generic "doesn't match"
      // line — so a regressed filter / hand-imported .mobileprovision surfaces the
      // real cause. Routing is identical (any failure → error).
      const bundleOk = bundleIdMatches(chosenProfile.bundleId, appId)
      const distOk = !dist || chosenProfile.profileType === dist
      if (!bundleOk || !distOk) {
        const msg = `Profile "${chosenProfile.name}" doesn't match this app: `
          + `bundle ${chosenProfile.bundleId} (expected ${appId}), `
          + `type ${chosenProfile.profileType} (expected ${dist ?? 'any'}).`
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg, 'import-pick-identity')
      }
      // Cert-trust check: the profile's allowed-certs list must include the chosen
      // identity's SHA-1 (app.tsx:3508–3519). Surface the entry count + truncated
      // SHA-1s so the user can see WHY the profile won't sign with their cert.
      if (chosenIdentity && !chosenProfile.certificateSha1s.includes(chosenIdentity.sha1)) {
        const shownSha1s = chosenProfile.certificateSha1s.map(s => `${s.slice(0, 8)}…`).join(', ') || '(none listed)'
        const msg = `Profile "${chosenProfile.name}" doesn't trust your chosen certificate "${chosenIdentity.name}". `
          + `The profile's allowed-certs list contains ${chosenProfile.certificateSha1s.length} entr${chosenProfile.certificateSha1s.length === 1 ? 'y' : 'ies'} (SHA1: ${shownSha1s}); your cert's SHA1 starts with ${chosenIdentity.sha1.slice(0, 8)}…. `
          + `Either pick a different profile, or re-create this profile in the Apple Developer Portal and tick the right cert.`
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg, 'import-pick-identity')
      }
      deps.onLog?.(`✔ Profile · ${chosenProfile.name}`)
      return { progress, next: 'import-export-warning' }
    }

    // ── import-no-match-recovery (resolver effect, EPHEMERAL-dep) ─────────────
    // app.tsx:3579–3609. The 5-way recovery HUB is an EPHEMERAL-branching choice:
    // the pick is never persisted, so the driver records it into
    // deps.carried.recoveryAction and re-drives this step as a resolver. The
    // routing mirrors the TUI onChange exactly:
    //   - no recoveryAction recorded OR 'back' → import-pick-identity (the user
    //     bailed back to identity selection; app.tsx:3597).
    //   - 'browser' → import-portal-explanation (the manual walkthrough; :3589).
    //   - 'provide-profile-path' → import-provide-profile-path (the file picker;
    //     :3592 — the driver RESETS carried.profilePickerOpened before re-driving).
    //   - 'create' + an ASC key available → import-create-profile-only (:3603).
    //   - 'create' + NO ASC key → start the .p8 chain at api-key-instructions,
    //     PERSISTING pendingRecoveryAction='import-create-profile-only' so a later
    //     verifying-key returns here (:3605 setPendingRecoveryAction). This is the
    //     ONLY persisted write on this step.
    // STICKY (risk #8): noMatchReason is NEVER recomputed here — the carried reason
    // (set by the step that ROUTED into recovery) is threaded back UNCHANGED on the
    // bounce branches so the menu keeps the SAME variant. PURE routing otherwise.
    case 'import-no-match-recovery': {
      const action = deps.carried?.recoveryAction
      // The sticky reason rides transient untouched on every bounce branch.
      const noMatchReason = deps.carried?.noMatchReason
      const stickyTransient = noMatchReason ? { noMatchReason } : {}

      if (!action || action === 'back')
        return { progress, next: 'import-pick-identity', transient: stickyTransient }
      if (action === 'browser')
        return { progress, next: 'import-portal-explanation', transient: stickyTransient }
      if (action === 'provide-profile-path')
        return { progress, next: 'import-provide-profile-path', transient: stickyTransient }

      // action === 'create'
      const hasAscKey = !!(deps.carried?.p8Content || progress.p8Path)
      if (hasAscKey)
        return { progress, next: 'import-create-profile-only', transient: stickyTransient }

      // No ASC key yet — start the .p8 chain and remember to return to the
      // profile-creation action once the key is verified. The task stores the
      // FULL target step name (not the TUI's bare 'create-profile-only') so a
      // stateless verifying-key can route to it directly.
      const nextProgress: OnboardingProgress = { ...progress, pendingRecoveryAction: 'import-create-profile-only' }
      await deps.saveProgress?.(progress.appId, nextProgress)
      return { progress: nextProgress, next: 'api-key-instructions', transient: stickyTransient }
    }

    // ── import-portal-explanation (resolver effect, EPHEMERAL-dep) ────────────
    // app.tsx:3738–3755. The manual-portal walkthrough is an EPHEMERAL navigation
    // choice: the pick rides deps.carried.portalAction and the driver re-drives
    // this step as a resolver. The routing mirrors the TUI onChange:
    //   - 'use-create' → import-create-profile-only (the recommended auto path).
    //   - 'use-file'   → import-provide-profile-path (driver resets profilePickerOpened).
    //   - 'open-anyway'→ open the portal (deps.openExternal, best-effort) + a yellow
    //     breadcrumb, then BACK to import-no-match-recovery (:3748).
    //   - 'back' / default → import-no-match-recovery (:3754).
    // STICKY: noMatchReason is threaded back UNCHANGED on the back/open-anyway bounce
    // so the recovery menu re-renders the SAME variant. PURE routing (open-external
    // is fire-and-forget). No persistence.
    case 'import-portal-explanation': {
      const action = deps.carried?.portalAction
      const noMatchReason = deps.carried?.noMatchReason
      const stickyTransient = noMatchReason ? { noMatchReason } : {}

      if (action === 'use-create')
        return { progress, next: 'import-create-profile-only', transient: stickyTransient }
      if (action === 'use-file')
        return { progress, next: 'import-provide-profile-path', transient: stickyTransient }
      if (action === 'open-anyway') {
        const portalUrl = 'https://developer.apple.com/account/resources/profiles/list'
        const followUp = 'once you have downloaded the .mobileprovision file, come back and pick "📁 Use a .mobileprovision file from disk".'
        try {
          await deps.openExternal?.(portalUrl)
          deps.onLog?.(`🌐 Opened Apple Developer Portal (${portalUrl}) — ${followUp}`, 'yellow')
        }
        catch {
          // Opening the portal is best-effort — a failure must not abort
          // recovery, but it must not be reported as success either: tell the
          // user WHERE to go instead (the verify-app 'open' sibling pattern).
          deps.onLog?.(`⚠ Could not open your browser. Visit ${portalUrl} — ${followUp}`, 'yellow')
        }
        return { progress, next: 'import-no-match-recovery', transient: stickyTransient }
      }
      // 'back' or an unrecognized value bounces to the recovery menu.
      return { progress, next: 'import-no-match-recovery', transient: stickyTransient }
    }

    // ── import-provide-profile-path (file-picker effect, idempotent) ──────────
    // app.tsx:1688–1781. Open the native .mobileprovision picker EXACTLY ONCE
    // (idempotent — the TUI guards with mobileprovisionPickerOpenedRef; the engine
    // guards with the carried profilePickerOpened flag so a re-render / re-drive
    // does NOT re-open the dialog). Then read + parse the file and run the THREE
    // invariant checks (bundle id, distribution, cert SHA-1) before synthesizing a
    // DiscoveredProfile and routing to the picker. Outcomes:
    //   - already opened this attempt (guard) → bounce back to import-no-match-
    //     recovery WITHOUT recomputing noMatchReason (risk #8 sticky).
    //   - picker cancelled (null) → import-no-match-recovery, noMatchReason kept.
    //   - parse error / any failed invariant → error (the TUI's handleError).
    //   - all checks pass → set carried.chosenProfile + inject the synthesized
    //     profile into importMatches → import-pick-profile.
    // The chosen identity is REQUIRED (guarded). noMatchReason rides transient on
    // every bounce so the recovery menu keeps its variant. The synthesized profile
    // is transient only — nothing is persisted (the import export payload is
    // re-derived later, risk #2).
    case 'import-provide-profile-path': {
      const chosenIdentity = deps.carried?.chosenIdentity
      if (!chosenIdentity) {
        const msg = 'Internal error: no identity chosen for .mobileprovision import.'
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg)
      }
      const noMatchReason = deps.carried?.noMatchReason
      const stickyTransient = noMatchReason ? { noMatchReason } : {}

      // Idempotency guard: the picker already ran this attempt — do NOT re-open.
      // Bounce back to the recovery menu, keeping the sticky reason (risk #8).
      if (deps.carried?.profilePickerOpened)
        return { progress, next: 'import-no-match-recovery', transient: { ...stickyTransient, profilePickerOpened: true } }

      const appId = resolveIosBundleId(progress, deps)
      const dist = progress.importDistribution

      try {
        const filePath = await deps.openProfilePicker?.()
        if (!filePath) {
          // Cancelled — bounce back to the recovery menu (keep noMatchReason).
          return { progress, next: 'import-no-match-recovery', transient: { ...stickyTransient, profilePickerOpened: true } }
        }

        // Read + parse. A parse failure routes to error (the TUI's handleError).
        const bytes = await deps.readFile!(filePath)
        let detail: MobileprovisionDetail
        try {
          detail = deps.parseMobileprovisionDetailed!(bytes)
        }
        catch (err) {
          const msg = `Couldn't parse "${filePath}": ${err instanceof Error ? err.message : String(err)}`
          deps.onLog?.(`✖ ${msg}`, 'red')
          return iosError(progress, msg, 'import-provide-profile-path', { profilePickerOpened: true })
        }

        // Invariant 1 — bundle id (wildcard-aware via bundleIdMatches).
        if (!bundleIdMatches(detail.bundleId, appId)) {
          const msg = `This .mobileprovision is for bundle ID "${detail.bundleId}" but the current app is "${appId}". `
            + 'Pick a profile that targets the right app (wildcard profiles like "com.example.*" are accepted), or use "Create a new App Store profile" in the recovery menu.'
          deps.onLog?.(`✖ ${msg}`, 'red')
          return iosError(progress, msg, 'import-provide-profile-path', { profilePickerOpened: true })
        }
        // Invariant 2 — distribution mode.
        if (dist && detail.profileType !== dist) {
          const msg = `This .mobileprovision is a ${detail.profileType} profile but you picked ${dist} distribution. `
            + 'Pick a profile that matches, or restart and pick the matching distribution mode.'
          deps.onLog?.(`✖ ${msg}`, 'red')
          return iosError(progress, msg, 'import-provide-profile-path', { profilePickerOpened: true })
        }
        // Invariant 3 — cert trust (the profile must list the chosen cert's SHA-1).
        if (!detail.certificateSha1s.includes(chosenIdentity.sha1)) {
          const shownSha1s = detail.certificateSha1s.map(c => `${c.slice(0, 8)}…`).join(', ') || '(none listed)'
          const msg = `This .mobileprovision doesn't trust your chosen certificate "${chosenIdentity.name}". `
            + `Allowed certs in the profile (SHA1): ${shownSha1s}; your cert starts with ${chosenIdentity.sha1.slice(0, 8)}…. `
            + 'Either pick a different cert at the identity step, or re-create this profile in the Apple Developer Portal and tick the right one.'
          deps.onLog?.(`✖ ${msg}`, 'red')
          return iosError(progress, msg, 'import-provide-profile-path', { profilePickerOpened: true })
        }

        // All checks pass — synthesize a DiscoveredProfile (preserving the on-disk
        // path so import-exporting reads the bytes directly) and inject it into the
        // chosen identity's match so import-pick-profile lists it (app.tsx:1758–1772).
        const synthesized: DiscoveredProfile = {
          path: filePath,
          uuid: detail.uuid,
          name: detail.name,
          applicationIdentifier: detail.applicationIdentifier,
          bundleId: detail.bundleId,
          teamId: chosenIdentity.teamId,
          expirationDate: detail.expirationDate,
          profileType: detail.profileType as DiscoveredProfile['profileType'],
          certificateSha1s: detail.certificateSha1s,
          profileEntitlements: detail.profileEntitlements,
        }
        const matches = deps.carried?.importMatches ?? []
        const injectedMatches = matches.map(m => m.identity.sha1 === chosenIdentity.sha1
          ? { ...m, profiles: [...m.profiles, synthesized] }
          : m)
        deps.onLog?.(`✔ Loaded profile from file · ${detail.name}`)
        return {
          progress,
          next: 'import-pick-profile',
          transient: { profilePickerOpened: true, chosenProfile: synthesized, importMatches: injectedMatches },
        }
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg, 'import-provide-profile-path', { profilePickerOpened: true })
      }
    }

    // ── import-create-profile-only (effect, EPHEMERAL-dep) ────────────────────
    // app.tsx:1783–1860. The recovery path that creates a fresh App Store profile
    // via Apple for the cert ALREADY in the Keychain (cert creation is skipped).
    // Resolve the chosen identity's Apple cert id (findCertIdBySha1), ensure the
    // bundle id exists (ensureBundleId), then create the profile (createProfile).
    // Outcomes:
    //   - chosenIdentity missing → error (guarded).
    //   - ad_hoc distribution → error: apple-api createProfile only mints
    //     IOS_APP_STORE, so refuse rather than save a mismatched distribution pair
    //     (app.tsx:1794 — the menu already hides 'create' for ad_hoc).
    //   - Apple has no cert matching the identity → error (app.tsx:1804).
    //   - DuplicateProfileError → PERSIST duplicateProfileOrigin=
    //     'import-create-profile-only' (so deleting-duplicate-profiles routes back
    //     HERE, not the create-new creating-profile — the dual-origin contract) and
    //     surface the duplicates transiently → duplicate-profile-prompt (:1845).
    //   - success → synthesize the new profile as chosenProfile + inject it into the
    //     chosen identity's match → import-export-warning (:1840).
    // The synthesized cert/profile ride transient only (risk #2 — nothing persisted
    // beyond the duplicateProfileOrigin marker).
    case 'import-create-profile-only': {
      const chosenIdentity = deps.carried?.chosenIdentity
      if (!chosenIdentity) {
        const msg = 'Internal error: no identity chosen for profile creation.'
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg)
      }
      // Defensive: D2 only synthesizes app_store profiles (apple-api createProfile
      // hardcodes IOS_APP_STORE). Refuse ad_hoc here as the TUI does (app.tsx:1794).
      if (progress.importDistribution === 'ad_hoc') {
        const msg = 'Creating a new profile via Apple is not implemented for ad_hoc distribution yet. '
          + 'Use "Open Apple Developer Portal" instead.'
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg)
      }

      const appId = resolveIosBundleId(progress, deps)
      try {
        const certId = await deps.findCertIdBySha1!(chosenIdentity.sha1)
        if (!certId) {
          const msg = `Apple does not have a certificate matching "${chosenIdentity.name}". `
            + 'Cannot create a profile without an Apple-side cert ID. Use the "Create new" path instead.'
          deps.onLog?.(`✖ ${msg}`, 'red')
          return iosError(progress, msg)
        }
        await deps.ensureBundleId!(appId)
        const profile = await deps.createProfile!({ bundleId: appId, certificateId: certId, distribution: 'app_store' })

        // Use the freshly-created profile directly as the chosen profile. Carry
        // profileBase64 (the .mobileprovision bytes) via the same structural cast
        // the TUI uses (app.tsx:1817–1828) so import-exporting → saving-credentials
        // has the profile content without a re-fetch.
        const synthesized = {
          path: '',
          uuid: profile.profileId,
          name: profile.profileName,
          applicationIdentifier: '',
          bundleId: appId,
          teamId: chosenIdentity.teamId,
          expirationDate: (profile as ProfileData & { expirationDate?: string }).expirationDate ?? '',
          profileType: 'app_store' as const,
          certificateSha1s: [chosenIdentity.sha1],
          profileBase64: profile.profileBase64,
        } as DiscoveredProfile & { profileBase64: string }
        const matches = deps.carried?.importMatches ?? []
        const injectedMatches = matches.map(m => m.identity.sha1 === chosenIdentity.sha1
          ? { ...m, profiles: [...m.profiles, synthesized] }
          : m)
        deps.onLog?.(`✔ Created new profile "${profile.profileName}" on Apple, linked to your existing cert`)
        return {
          progress,
          next: 'import-export-warning',
          transient: { chosenProfile: synthesized, importMatches: injectedMatches },
        }
      }
      catch (err) {
        if (err instanceof DuplicateProfileError) {
          // Route to the shared duplicate-profile-prompt, persisting the IMPORT
          // origin so the post-deletion retry runs THIS step again (not the
          // create-new creating-profile, which can't succeed in import mode).
          const nextProgress: OnboardingProgress = {
            ...progress,
            duplicateProfileOrigin: 'import-create-profile-only',
          }
          await deps.saveProgress?.(progress.appId, nextProgress)
          return {
            progress: nextProgress,
            next: 'duplicate-profile-prompt',
            transient: { duplicateProfiles: err.profiles },
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg, 'import-create-profile-only')
      }
    }

    // ── import-export-warning (resolver effect, EPHEMERAL-dep) ────────────────
    // app.tsx:3769–3784. The heads-up before the single Keychain dialog is an
    // EPHEMERAL-branching choice: the pick rides deps.carried.exportWarningAction
    // and the driver re-drives this step as a resolver. The routing mirrors the
    // TUI onChange exactly:
    //   - 'go'   → import-exporting. The precompiled signed helper is resolved
    //     and signature-verified inside the export step itself (PR #2458 replaced
    //     the runtime swiftc compile with prebuilt notarized helper packages, so
    //     the old import-compiling-helper step no longer exists).
    //   - 'back' → import-pick-profile (distribution mode is upstream now;
    //     app.tsx:3780).
    //   - 'exit' / absent → exit onboarding (app.tsx:3783).
    // PURE routing — persists nothing (chosenIdentity/chosenProfile ride transient).
    case 'import-export-warning': {
      const action = deps.carried?.exportWarningAction
      if (action === 'back')
        return { progress, next: 'import-pick-profile' }
      if (action === 'go')
        return { progress, next: 'import-exporting' }
      // 'exit' or no pick → leave onboarding. The engine has no 'exit' step, so
      // (like cert-limit-prompt / duplicate-profile-prompt's exit branches) this
      // routes to 'error', the driver's exitOnboarding equivalent (app.tsx:3783).
      return iosError(progress, `Onboarding cancelled. Re-run \`build init\` to resume.`)
    }

    // ── import-exporting (effect, EPHEMERAL-dep) ──────────────────────────────
    // app.tsx:1629–1671. Export the chosen identity's cert + private key from the
    // Keychain to a .p12 (the ONE Keychain permission prompt happens here), then
    // synthesize the CertificateData + ProfileData records the shared
    // saving-credentials tail (doSaveCredentials) consumes.
    //
    // GUARD (app.tsx:1632): chosenIdentity AND chosenProfile must both be present
    // — they ride transient from the import pickers / D2, never progress.json. On a
    // crash-recovery resume that lost them the driver re-lands on import-scanning
    // and re-derives the selections; reaching here without them is an internal
    // error → error/restart.
    //
    // RISK #2 / D-iOS-3 (NO SECRETS ON DISK): certData (incl. the p12 base64),
    // profileData, teamId, and importedP12Password ride transient ONLY — this
    // effect PERSISTS NOTHING. A crash before saving-credentials resumes from
    // import-scanning and re-exports; the saving-credentials tail rebuilds the
    // saved-credential map from these carried values.
    //
    // profileBase64 source (app.tsx:1648): an on-disk profile (chosenProfile.path
    // set) is read + base64-encoded via deps.readFile; a synthesized Apple-API
    // profile (D2 / Apple-fetch, path='') already carries profileBase64 on the
    // structural cast.
    case 'import-exporting': {
      const chosenIdentity = deps.carried?.chosenIdentity
      const chosenProfile = deps.carried?.chosenProfile
      if (!chosenIdentity || !chosenProfile) {
        const msg = 'Internal error: no identity or profile chosen for export.'
        deps.onLog?.(`✖ ${msg}`, 'red')
        // Lost ephemeral selection (crash-recovery) — re-running the export
        // can't help; only Restart/Exit are offered (no retryStep).
        return iosError(progress, msg)
      }
      try {
        const exported = await deps.exportP12FromKeychain!(chosenIdentity.sha1)
        // Synthesize a CertificateData record. Apple-API-only fields (certificateId)
        // stay empty for an imported cert (app.tsx:1639); expiry comes from the
        // chosen profile, team id from the identity.
        const certData: CertificateData = {
          certificateId: '',
          expirationDate: chosenProfile.expirationDate,
          teamId: chosenIdentity.teamId,
          p12Base64: exported.base64,
        }
        // chosenProfile.path empty ⇒ synthesized Apple-API profile carries the
        // .mobileprovision bytes on the structural cast; otherwise read from disk.
        // deps.readFile resolves to a Buffer (matching macos-signing's readFile),
        // so encode it directly — no `Buffer.from` value needed (the module imports
        // Buffer as a TYPE only, keeping the engine value-import-free).
        const profileBase64 = chosenProfile.path
          ? (await deps.readFile!(chosenProfile.path)).toString('base64')
          : (chosenProfile as DiscoveredProfile & { profileBase64?: string }).profileBase64 || ''
        const profileData: ProfileData = {
          profileId: chosenProfile.uuid,
          profileName: chosenProfile.name,
          profileBase64,
        }
        deps.onLog?.(`✔ Exported "${chosenIdentity.name}" from Keychain`)
        // The export payload rides transient ONLY (risk #2) — never persisted.
        // The shared saving-credentials tail runs next and reads it from carried.
        return {
          progress,
          next: 'saving-credentials',
          transient: {
            certData,
            profileData,
            importedP12Password: exported.passphrase,
            ...(chosenIdentity.teamId ? { teamId: chosenIdentity.teamId } : {}),
          },
        }
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.onLog?.(`✖ ${msg}`, 'red')
        return iosError(progress, msg, 'import-exporting')
      }
    }

    // ── error (resolver effect, EPHEMERAL — the recovery screen) ──────────────
    // app.tsx:4462-4484 (ErrorStep onChange). The error screen is an EPHEMERAL-
    // branching choice: the user's pick is NEVER persisted, so the driver records
    // it into deps.carried.errorAction and re-drives this step as a resolver. The
    // routing mirrors the TUI onChange exactly:
    //   - 'retry'   → re-run the failing step (deps.carried.retryStep). When the
    //     failure was unrecoverable (no retryStep carried) a 'retry' is impossible
    //     — the view never offered it — so this falls through to the exit sink.
    //   - 'restart' → welcome (resetForFreshStart + setStep('welcome'),
    //     app.tsx:4476-4478). The driver owns the actual reset side-effects; the
    //     engine just routes there.
    //   - 'exit' / absent → stay on 'error' (the terminal exit sink). The engine
    //     has no 'exit' step; the driver interprets a self-loop on 'error' as
    //     leave-onboarding, mirroring app.tsx:4482's exitOnboarding(). This is the
    //     SAME convention the cert-limit-prompt / import-export-warning exit
    //     branches use (they route to 'error').
    // PURE routing — no IO, no persistence (error/retryStep ride transient only).
    case 'error': {
      const action = deps.carried?.errorAction
      if (action === 'retry' && deps.carried?.retryStep)
        return { progress, next: deps.carried.retryStep }
      if (action === 'restart')
        return { progress, next: 'welcome' }
      // 'exit' (or no/invalid pick) → terminal exit sink.
      return { progress, next: 'error' }
    }

    default:
      throw new Error(`runIosEffect: not implemented for step '${step}'`)
  }
}

// ─── Create-new effect helpers ─────────────────────────────────────────────────

/** ~/.capgo-credentials/credentials.json — the backing-up source (app.tsx:1232). */
function credentialsBackupSourcePath(): string {
  return join(homedir(), '.capgo-credentials', 'credentials.json')
}

/** The timestamped sibling backup destination (app.tsx:1234). */
function credentialsBackupDestPath(date: string): string {
  return join(homedir(), '.capgo-credentials', `credentials-${date}.copy.json`)
}

/**
 * Resolve the Apple-side iOS bundle id used for ensureBundleId / createProfile,
 * profile filtering and as the provisioning_map key. progress.appId is the
 * CAPGO app key — when plugins.CapacitorUpdater.appId is configured it is NOT
 * the Apple bundle id (hostile-review P1, 2026-06-12). Priority:
 *   1. progress.iosBundleIdOverride — the verified/adopted override persisted
 *      by verify-app / redirectIfMismatch (the TUI's `iosBundleId`).
 *   2. The FRESH-detected Release PRODUCT_BUNDLE_IDENTIFIER via the injected
 *      deps.detectBundleIds — the same authoritative source verify-app gates on.
 *   3. progress.appId — last resort for drivers that wire no detector (the
 *      pre-fix behaviour; correct whenever the Capgo key == the bundle id).
 */
function resolveIosBundleId(progress: OnboardingProgress, deps?: Pick<IosEffectDeps, 'detectBundleIds'>): string {
  if (progress.iosBundleIdOverride)
    return progress.iosBundleIdOverride
  try {
    const detected = deps?.detectBundleIds?.()
    if (detected?.releaseResolved && detected.pbxproj)
      return detected.pbxproj.value
  }
  catch {
    // The detector reads the Xcode project from disk (driver-bound IO) — a
    // read failure must not break credential building; fall back to appId.
  }
  return progress.appId
}

/**
 * Resolve the validated .p8 bytes for verifying-key. The driver carries them in
 * deps.carried.p8Content (the transient channel mirroring the TUI's
 * p8ContentRef); on a crash-recovery resume that lost them, fall back to
 * re-reading the file at progress.p8Path via the injected readFile. Throws a
 * NeedP8-style error when neither is available — the same fail-fast the TUI's
 * getFreshToken does so the driver can re-prompt for the .p8.
 *
 * A STALE p8Path (file moved/deleted/unreadable since the last run) must throw
 * the SAME NeedP8-style error, not the raw fs error: the driver's re-prompt
 * matcher keys on the '.p8' message, and a raw ENOENT would bypass it and land
 * on the support-bundle error screen (the TUI converts the identical failure to
 * NeedP8Error in getFreshToken, app.tsx:1333–1340). The real fs reason goes to
 * the internal log only.
 */
async function resolveP8Content(progress: OnboardingProgress, deps: IosEffectDeps): Promise<Buffer> {
  if (deps.carried?.p8Content)
    return deps.carried.p8Content
  if (progress.p8Path && deps.readFile) {
    try {
      return await deps.readFile(progress.p8Path)
    }
    catch (err) {
      deps.onInternalLog?.(`saved .p8 no longer readable, re-prompting: ${err instanceof Error ? err.message : String(err)}`)
      throw new Error('verifying-key: .p8 content unavailable (the saved .p8 path is no longer readable — re-provide the .p8 key file)')
    }
  }
  throw new Error('verifying-key: .p8 content unavailable (no carried bytes and no readable p8Path)')
}

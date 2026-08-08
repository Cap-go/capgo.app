import type { DOMElement } from 'ink'
import type { FC } from 'react'
import type { BuildCredentials } from '../../../schemas/build.js'
import type { BuildOnboardingWorkflowDecision, BuildOnboardingWorkflowEvent, WorkflowDiffTelemetry } from '../analytics.js'
import type { AscAppLike, GatePath } from '../app-verification.js'
import type { AscApp, AscDistributionCert } from '../apple-api.js'
import type { CiSecretEntry, CiSecretSetupAdvice, CiSecretTarget } from '../ci-secrets.js'
import type { DiffLine } from '../diff-utils.js'
import type { DiscoveredProfile, IdentityProfileMatch, SigningIdentity } from '../macos-signing.js'
import type { BuilderOnboardingAction } from '../telemetry.js'
import type { CertificateData, EnrichedIdentityAvailability, OnboardingErrorCategory, OnboardingProgress, OnboardingResult, OnboardingStep, ProfileData } from '../types.js'
import type { BuildScriptChoice, PackageManager } from '../workflow-generator.js'
import type { AiResultKind } from './components.js'
import type { NoMatchReason } from './steps/ios-import.js'
import type { OnboardingBeforeExit } from './exit.js'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { Alert, ProgressBar, Select } from '@inkjs/ui'
import { Box, measureElement, Newline, Text, useApp, useInput, useStdout } from 'ink'
import open from 'open'
// src/build/onboarding/ui/app.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { releaseCapturedLogs, runCapgoAiAnalysis } from '../../../ai/analyze.js'
import { renderMarkdown } from '../../../ai/render-markdown.js'
import { createStreamingMarkdownRenderer } from '../../../ai/stream-markdown.js'
import { aiAnalysisResultFromPostAnalyze, trackAiAnalysisChoice, trackAiAnalysisResult } from '../../../ai/telemetry.js'
import { trackEvent } from '../../../analytics/track.js'
import { writeOnboardingSupportBundle, writeSupportBundleFiles } from '../../../onboarding-support.js'
import { formatRunnerCommand, splitRunnerCommand } from '../../../runner-command.js'
import { copyToClipboard, revealInFinder } from '../../../support/clipboard.js'
import { contactSupport } from '../../../support/contact-support.js'
import { appendInternalLog, getInternalLogPath } from '../../../support/internal-log.js'
import { redactSecrets } from '../../../support/redact.js'
import { uploadSupportLogs } from '../../../support/support-upload.js'
import { offerSupportUploadBeforeAi } from '../../../support/support-upload-prompt.js'
import { findBuildCommandForProjectType, findProjectType, findSavedKeySilent, getOrganizationId, getPackageScripts, getPMAndCommand } from '../../../utils.js'
import { loadSavedCredentials, updateSavedCredentials } from '../../credentials.js'
import { writeReleaseBundleId } from '../../pbxproj-parser.js'
import { handleCustomMsg } from '../../qr.js'
import { requestBuildInternal } from '../../request.js'
import { isAiAnalysisTooTall, resolveAiResultRoute } from '../ai-fit.js'
import { getWorkflowDiffTelemetry, trackBuildOnboardingWorkflowEvent } from '../analytics.js'
import { evaluateGate } from '../app-verification.js'
import { exitAfterOnboardingBeforeExit } from './exit.js'
import { classifyCertAvailability, computeCertSha1, createCertificate, createProfile, deleteProfile, ensureBundleId, findCertIdBySha1, generateJwt, listApps, listBundleIds, listDistributionCerts, listProfilesForCert, revokeCertificate, verifyApiKey } from '../apple-api.js'
import { runAscKeyHelper } from '../asc-key/helper.js'
import { sanitizeBuildLogLines } from '../build-log.js'
import { detectIosBundleIds } from '../bundle-id-detector.js'
import { createCiSecretEntries, detectCiSecretTargets, getCiSecretRepoLabelAsync, getCiSecretTargetLabel, listExistingCiSecretKeysAsync, uploadCiSecretsAsync } from '../ci-secrets.js'
import { createP12, generateCsr } from '../csr.js'
import { diffLines } from '../diff-utils.js'
import { defaultExportPath, exportCredentialsToEnv } from '../env-export.js'
import { mapIosOnboardingError } from '../error-categories.js'
import { canUseFilePicker, openFilePicker, openMobileprovisionPicker } from '../file-picker.js'
import { parseMobileprovisionBufferDetailed } from '../../mobileprovision-parser.js'
import { exportP12FromKeychain, filterProfilesForApp, isMacOS, listSigningIdentities, scanProvisioningProfiles } from '../macos-signing.js'
import { IOS_MIN_ROWS, terminalFitsOnboarding } from '../min-terminal-size.js'
import { deleteProgress, extractKeyIdFromP8Path, getImportEntryStep, loadProgress, saveProgress } from '../progress.js'
import { getBuildOnboardingRecoveryAdvice } from '../recovery.js'
import { trackBuilderOnboardingAction, trackBuilderOnboardingStep } from '../telemetry.js'
import {
  getPhaseLabel,

  STEP_PROGRESS,
} from '../types.js'
import { generateWorkflow, WORKFLOW_PATH as WORKFLOW_GEN_PATH } from '../workflow-generator.js'
import { buildScriptPickerOptions, normalizePackageManager } from '../workflow-ui-helpers.js'
import { WORKFLOW_PATH, writeWorkflowFile } from '../workflow-writer.js'
import { CompletedStepsLog } from './completed-steps-log.js'
import { BOX_HEADER_ROWS, COMPACT_HEADER_ROWS, DiffSummary, Divider, FilteredTextInput, FullscreenAiViewer, FullscreenBuildOutput, FullscreenDiffViewer, Header, isBuildCompleteDismissKey, SecretsTable, SpinnerLine, SuccessLine, Table, WIZARD_PADDING_ROWS } from './components.js'
import { logBudgetRows } from './frame-fit.js'
import { TerminalTooSmallPrompt } from './min-size-gate.js'
import {
  AskBuildStep,
  AskCiSecretsStep,
  CiSecretsFailedStep,
  CiSecretsSetupStep,
  CiSecretsTargetSelectStep,
  ConfirmCiSecretOverwriteStep,
  DetectingCiSecretsStep,
} from './steps/ios-ci.js'
import {
  ApiKeyInstructionsStep,
  AscKeyCreatedStep,
  AscKeyGeneratingStep,
  BackingUpStep,
  CertLimitPromptStep,
  CreatingCertificateStep,
  CreatingProfileStep,
  CredentialsExistStep,
  DeletingDuplicateProfilesStep,
  DuplicateProfilePromptStep,
  InputIssuerIdStep,
  InputKeyIdStep,
  InputP8PathStep,
  P8MethodSelectStep,
  P8SourceSelectStep,
  RevokingCertificateStep,
  SavingCredentialsStep,
  SetupMethodSelectStep,
  VerifyingKeyStep,
} from './steps/ios-credentials.js'
import {
  ImportCreateProfileOnlyStep,
  ImportDistributionModeStep,
  ImportExportingStep,
  ImportExportWarningStep,
  ImportNoMatchRecoveryStep,
  ImportPickIdentityStep,
  ImportPickProfileStep,
  ImportScanningStep,
} from './steps/ios-import.js'
import {
  AddingPlatformStep,
  AiAnalysisPromptStep,
  AiAnalysisResultStep,
  AiAnalysisRunningStep,
  BuildCompleteStep,
  ErrorStep,
  estimateErrorBodyRows,
  formatErrorViewerLines,
  NoPlatformStep,
  PlatformSelectStep,
  WelcomeStep,
} from './steps/ios-shared.js'
import type { IosEffectDeps, IosStepCtx } from '../ios/flow.js'
import { applyIosInput, runIosEffect } from '../ios/flow.js'
import { getIosResumeStep } from '../ios/progress.js'
import { classifyP8SubmitError } from './p8-error.js'

// Braille spinner frames for the per-row "Profile" cell during prefetch.
// Module-scoped so the array reference is stable and never triggers
// re-renders by accident.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

// Upper bound on "I fixed it, retry build" attempts after an AI diagnosis.
// Three total attempts (initial + two retries) caps the AI cost when a model
// suggestion doesn't actually fix the failure mode while still giving the user
// a couple of in-wizard chances to iterate.
const MAX_AI_RETRIES = 2

const OUTPUT_LINE_SPLIT_RE = /\r?\n/
const CARRIAGE_RETURN_RE = /\r/g

/**
 * Special error to signal the UI should redirect to .p8 input.
 */
class NeedP8Error extends Error {
  constructor() {
    super('Need .p8 file')
    this.name = 'NeedP8Error'
  }
}

/**
 * The tail engine's `carried.savedCredentials` is a `Record<string, string>`
 * (tail/flow.ts), while the React mirror is `Partial<BuildCredentials>` whose
 * values may be `undefined`. Convert explicitly — dropping undefined entries —
 * instead of casting the Partial to a Record it doesn't satisfy.
 */
function toCarriedSavedCredentials(creds: Partial<BuildCredentials> | null): Record<string, string> | undefined {
  if (!creds)
    return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(creds)) {
    if (typeof value === 'string')
      out[key] = value
  }
  return out
}

// The create-new credential PROVISIONING effect steps the iOS engine-driver
// (below) routes through the shared engine's `runIosEffect`. The CHOICE / INPUT
// steps and the import-side effects keep their bespoke bodies for now (Stage 3
// swaps the choice/input routing). verifying-key is fully engine-routed (BOTH
// the create-new and import paths — the engine expresses the import app_store
// continuation itself via transient.pendingVerifyNext), and verify-app (the
// remote App Store verification gate, PR #2397) runs its fetch +
// classification + gate resolver in the engine too.
const IOS_ENGINE_CREATE_EFFECT_STEPS = new Set<OnboardingStep>([
  'backing-up',
  'p8-method-select',
  'verifying-key',
  'verify-app',
  'creating-certificate',
  'revoking-certificate',
  'creating-profile',
  'deleting-duplicate-profiles',
])

// The IMPORT credential EFFECT steps the iOS engine-driver routes through the
// shared engine's `runIosEffect` (Stage 3 slice C). These run the Mac scans /
// Apple-side lookups / Keychain export the bespoke import effect bodies used to
// run inline. The CHOICE steps (import-distribution-mode, the pickers, the
// recovery hub, portal-explanation, export-warning) stay on the inline onChange
// resolvers (which stash the ephemeral pick into iosCarriedRef + re-drive the
// step as a pure resolver effect, exactly like cert-limit-prompt /
// duplicate-profile-prompt). import-mode verifying-key is NOT in this set — it
// shares the create-new verifying-key effect but needs the import-branch `next`
// routing, handled in the create-new effect driver's verifying-key arm.
const IOS_ENGINE_IMPORT_EFFECT_STEPS = new Set<OnboardingStep>([
  'import-scanning',
  'import-validating-all-certs',
  'import-checking-apple-cert',
  'import-provide-profile-path',
  'import-create-profile-only',
  'import-exporting',
])

// ─── IOS_TAIL_DRIVER_STEPS (ink-thin-wrapper, Stage 3 slice A) ─────────────────
//
// The post-save "tail" AUTO/EFFECT steps the TUI delegates to the shared engine's
// `runIosEffect`, which routes them into the platform-neutral tail module
// (TAIL_EFFECT_STEPS in ios/flow.ts). Mirrors the android TAIL_DRIVER_STEPS. These
// run AT or AFTER saving-credentials — which deletes progress.json — so the driver
// feeds the engine a SYNTHETIC progress carrying the in-memory React tail state
// (setupMode / ciSecretTarget / selectedPackageManager / buildScriptChoice /
// envExportTargetPath) plus the resolved create-new/import cert/profile payloads via
// deps.carried, and threads the engine transient (savedCredentials / ciSecretEntries
// / ciSecretExistingKeys / workflowIsNew) back. The engine NEVER re-creates
// progress.json here.
//
// ai-analysis-* + the build-log viewer stay ink-only (no AI-calling-AI in the
// headless engine); the requesting-build → ai-analysis-prompt handoff still reaches
// the AI UI because the engine returns next: 'ai-analysis-prompt'. preview-workflow-
// file stays bespoke (a VIEW prep, not a TAIL_EFFECT_STEP).
const IOS_TAIL_DRIVER_STEPS = new Set<OnboardingStep>([
  'saving-credentials',
  'detecting-ci-secrets',
  'checking-ci-secrets',
  'uploading-ci-secrets',
  'exporting-env',
  'overwrite-and-export-env',
  'writing-workflow-file',
  'requesting-build',
])

interface LogEntry { text: string, color?: string }

interface AppProps {
  /**
   * Capgo lookup key (progress files, saved credentials, Capgo SaaS build
   * API). Resolved by `getAppId()`, which prefers
   * `config.plugins.CapacitorUpdater.appId` over `config.appId` so dev-tunnel
   * sandboxes can override the Capgo-side identifier without renaming the
   * iOS bundle. Do NOT use for Apple-side operations — see
   * `iosBundleIdInitial`.
   */
  appId: string
  /**
   * Default value for the iOS bundle ID used for Apple-side operations
   * (cert lookup, profile filtering, ensureBundleId, createProfile, and the
   * provisioning_map key). Sourced from `config.appId` directly — what
   * `cap sync` writes into project.pbxproj's PRODUCT_BUNDLE_IDENTIFIER.
   * When pbxproj's Release id and config.appId disagree, the wizard adopts the
   * authoritative Release id (verify-app confirms it remotely). command.ts
   * falls back to `appId` if config.appId is missing, so this prop is always a
   * valid string.
   */
  iosBundleIdInitial: string
  initialProgress: OnboardingProgress | null
  /** Resolved iOS directory from capacitor.config (defaults to 'ios') */
  iosDir: string
  /**
   * Whether guided ASC-key creation may be offered: macOS + the signed helper
   * installed + its Developer-ID signature/team verified (computed once in
   * command.ts via probeGuidedHelper). Gates every "create one for me" / "do
   * you already have a .p8?" branch — when false (not installed, wrong
   * signature, wrong team, or non-macOS) the user goes straight to the manual
   * .p8 instructions, exactly as before the helper existed and as on Linux.
   */
  guidedHelperUsable: boolean
  /** Optional Capgo API key passed via -a/--apikey flag; takes precedence over saved key */
  apikey?: string
  // Capgo API gateway override (--supa-host); prod when omitted.
  supaHost?: string
  /** Correlation id for this onboarding run; emitted as `journey_id` on every analytics event. */
  journeyId: string
  /** Reports the current step to the shell on every transition, so the caller can
   *  record where the user dropped off for the quit event. */
  onStep?: (step: string) => void
  /**
   * Reports the wizard outcome to the shell when it reaches build-complete, so
   *  the caller prints an accurate post-exit message + durable summary instead of
   *  always claiming success. Never fires on cancel/missing-platform exits.
   */
  onResult?: (result: OnboardingResult) => void
  /** Awaited immediately before Ink exits so replay can capture the alt-screen frame. */
  onBeforeExit?: OnboardingBeforeExit
}

async function runRunnerCommand(runner: string, args: string[]): Promise<{ success: boolean, output: string[] }> {
  let command = runner
  let runnerArgs: string[] = []
  try {
    ({ command, args: runnerArgs } = splitRunnerCommand(runner))
  }
  catch (error) {
    return { success: false, output: [error instanceof Error ? error.message : String(error)] }
  }

  return new Promise((resolve) => {
    const child = spawn(command, [...runnerArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output: string[] = []

    const append = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const rawLine of text.split(OUTPUT_LINE_SPLIT_RE)) {
        const line = rawLine.replaceAll(CARRIAGE_RETURN_RE, '').trim()
        if (line)
          output.push(line)
      }
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.once('error', (error) => {
      output.push(error.message)
      resolve({ success: false, output })
    })
    child.once('close', (code) => {
      resolve({ success: code === 0, output })
    })
  })
}

const OnboardingApp: FC<AppProps> = ({ appId, iosBundleIdInitial, initialProgress, iosDir, guidedHelperUsable, apikey, supaHost, journeyId, onStep, onResult, onBeforeExit }) => {
  const { exit } = useApp()
  const exitAfterBeforeExit = useCallback(() => {
    exitAfterOnboardingBeforeExit(onBeforeExit, exit)
  }, [exit, onBeforeExit])
  // Pass helper availability so an automated-path resume only targets
  // asc-key-generating when the helper can actually run (else manual instructions).
  // guidedHelperUsable already folds in macOS + signed-helper-installed +
  // signature/team verification (see command.ts), so an installed-but-untrusted
  // helper resumes to the manual path just like no helper at all.
  const startStep = getIosResumeStep(initialProgress, guidedHelperUsable)

  // When there's saved progress AND the resume target isn't trivially 'welcome',
  // land on the resume-prompt fork so the user can see what's saved and decide
  // whether to continue or restart from scratch — instead of being silently
  // teleported to the middle of the wizard with no chance to bail out cleanly.
  // The trivial case (no progress, or resume target is welcome) keeps the
  // existing zero-friction path.
  const [step, setStep] = useState<OnboardingStep>(
    initialProgress !== null && startStep !== 'welcome'
      ? 'resume-prompt'
      : startStep === 'welcome' ? 'welcome' : startStep,
  )

  // ─── iOS bundle id ─────────────────────────────────────────────────────
  //
  // `appId` (prop) is the Capgo lookup key — what `getAppId()` resolves to,
  // which prefers `config.plugins.CapacitorUpdater.appId` over `config.appId`
  // for dev-tunnel sandboxes. It owns the progress-file key, credentials
  // store key, and `capgo build request` command path.
  //
  // `iosBundleId` is what we send to Apple — sourced from `config.appId`
  // directly because `cap sync` only ever writes the top-level value into
  // `PRODUCT_BUNDLE_IDENTIFIER`. They diverge in real-world dev-tunnel
  // setups where capacitor.config carries a suffixed appId; using the
  // resolved key for Apple ops causes "No profile targets X" errors.
  //
  // Trust the saved override only when it was confirmed for the SAME
  // `config.appId` we're seeing this run. If the user renamed the app
  // between CLI runs the previously-saved override is stale relative to
  // the new files — fall back to `iosBundleIdInitial` so redirectIfMismatch /
  // verify-app re-resolve the bundle id instead of silently using the old value.
  const savedOverrideIsFresh = initialProgress?.iosBundleIdOverride !== undefined
    && initialProgress.iosBundleIdContextAppId === iosBundleIdInitial
  const [iosBundleId, setIosBundleId] = useState<string>(
    savedOverrideIsFresh && initialProgress?.iosBundleIdOverride
      ? initialProgress.iosBundleIdOverride
      : iosBundleIdInitial,
  )
  // Distinct from `iosBundleId !== iosBundleIdInitial` because the user is
  // allowed to pick the capacitor value at the confirm step — we still want
  // to suppress the question for the rest of the session in that case.
  // Stale overrides (context drift between runs) don't count as confirmed.
  const [appIdConfirmed, setAppIdConfirmed] = useState<boolean>(savedOverrideIsFresh)

  // ─── verify-app (remote App Store Connect verification) ────────────────
  //
  // Runs after verifying-key succeeds, app_store mode only (create-new is
  // always app_store). Confirms — via the ASC API — that an App Store app
  // exists whose bundleId == the project's Release PRODUCT_BUNDLE_IDENTIFIER
  // before we commit to that bundle id for cert/profile creation. See
  // app-verification.ts for the pure classify/gate logic.
  //
  // Where to go once verify-app passes (e.g. creating-certificate on the
  // create-new path, or the identity/profile picker on import) is now
  // ENGINE-OWNED: verifying-key returns it in transient.pendingVerifyNext and
  // the driver threads it back via iosCarriedRef (EPHEMERAL — never persisted;
  // a fresh mount has none, so verify-app falls back to creating-certificate).
  // True while the initial parallel apps+bundleIds fetch is in flight.
  const [verifyAppLoading, setVerifyAppLoading] = useState(false)
  // The authoritative Release build id resolved fresh from pbxproj for this
  // verification. Empty string when no Release config could be resolved.
  const [verifyReleaseBundleId, setVerifyReleaseBundleId] = useState('')
  // The Debug-config bundle id when it differs from Release (else ''). Drives a
  // persistent, bordered warning box on the verify-app step so the user always
  // sees which id Capgo Builder actually signs — a scrolling gray log line was
  // being missed.
  const [verifyDebugBundleId, setVerifyDebugBundleId] = useState('')
  // Apps that exist in the user's App Store Connect account (picker source +
  // Path B re-poll). Refreshed live on each Path B Continue.
  const [verifyApps, setVerifyApps] = useState<AscApp[]>([])
  // Registered Developer-portal bundle ids (diagnostic only — sharpens Path B
  // wording: "identifier already exists" vs "will be registered").
  const [verifyRegisteredIds, setVerifyRegisteredIds] = useState<string[]>([])
  // Which resolution path the gate is enforcing once the user has chosen
  // (Path A fix-build-id, Path B create-app). null = still showing the picker.
  const [verifyPath, setVerifyPath] = useState<GatePath | null>(null)
  // The existing app the user picked in Path A (its bundleId is the target the
  // user must make PRODUCT_BUNDLE_IDENTIFIER match).
  const [verifyChosenApp, setVerifyChosenApp] = useState<AscAppLike | null>(null)
  // 1-based count of blocked Continue attempts — drives the escalating warning
  // box so a repeatedly-blocked gate never looks frozen.
  const [verifyAttempt, setVerifyAttempt] = useState(0)
  // Path B only: when a Continue re-poll still finds no app, we flip this so
  // the next render asks before re-opening the browser (never auto-reopen).
  const [verifyAskReopen, setVerifyAskReopen] = useState(false)
  // Bumped on every gate Select action so the gate Select remounts with a fresh
  // key. @inkjs/ui's Select re-fires onChange on EVERY render once it stays
  // mounted after a selection (its internal onChange effect deps include the
  // inline options/onChange identities, and previousValue !== value stays true)
  // — which otherwise loops the gate (e.g. "attempt 3427"). Every other Select in
  // the wizard dodges this by navigating away on select; the gate stays on-step,
  // so we force a remount to reset the Select's internal value.
  const [gateActionSeq, setGateActionSeq] = useState(0)
  // Guards the one-shot Shown telemetry event from re-firing on every
  // re-render while we're parked on verify-app (the initial fetch itself is
  // now the engine-driver effect, keyed on the step transition).
  const verifyShownRef = useRef(false)
  // Detection is synchronous (small files, no network); useMemo captures the
  // result for the lifetime of the component. redirectIfMismatch reads this to
  // decide whether to adopt the Release id (on mismatch). verify-app re-detects
  // FRESH from disk on each Continue, bypassing this memo.
  const detectedIds = useMemo(
    () => detectIosBundleIds({ cwd: process.cwd(), iosDir, capacitorAppId: iosBundleIdInitial }),
    [iosDir, iosBundleIdInitial],
  )
  // Shared sites that fan out into Apple-side work (end of import-scanning,
  // end of verifying-key) wrap their setStep call with this.
  //
  // The Release-config PRODUCT_BUNDLE_IDENTIFIER is authoritative for Apple
  // signing, and a differing capacitor.config.appId (the Capgo app key) is
  // EXPECTED — not an error — so we no longer interrupt with the confirm-app-id
  // prompt (which fired even before the .p8 was provided). Instead we silently
  // adopt the detected Release id for cert/profile/provisioning work and
  // continue. For app_store the authoritative check is verify-app (remote App
  // Store Connect verification); for ad_hoc the Release id is simply the build
  // id, used as-is.
  const redirectIfMismatch = (target: OnboardingStep): OnboardingStep => {
    if (appIdConfirmed)
      return target
    if (!detectedIds.mismatch)
      return target
    setIosBundleId(detectedIds.recommended.value)
    setAppIdConfirmed(true)
    if (detectedIds.recommended.value !== iosBundleIdInitial) {
      addLog(`ℹ Using "${detectedIds.recommended.value}" (your Xcode Release bundle ID) for Apple operations. capacitor.config.appId ("${iosBundleIdInitial}") is the Capgo app key and is left unchanged.`)
    }
    return target
  }

  // Telemetry: resolve org id once + emit per-step events
  const stepTimingRef = useRef<{ step: OnboardingStep | null, startedAt: number }>({
    step: null,
    startedAt: Date.now(),
  })
  // Buffer of telemetry events that occurred before `resolvedOrgId` landed.
  // Drained in order when the org id becomes available. Without this buffer,
  // any step transitions during the async org-id resolution (which involves
  // two HTTP round-trips: createSupabaseClient + getOrganizationId) would be
  // dropped from the funnel.
  const pendingTelemetryRef = useRef<Array<{
    step: OnboardingStep
    durationMs?: number
    durationStep?: OnboardingStep
    errorCategory?: OnboardingErrorCategory
  }>>([])
  const pendingActionTelemetryRef = useRef<Array<{
    step: OnboardingStep
    action: BuilderOnboardingAction
    tags?: Record<string, boolean | number | string>
  }>>([])
  const [resolvedOrgId, setResolvedOrgId] = useState<string | null>(null)
  const resolvedApiKeyRef = useRef<string | null>(apikey ?? null)
  const orgIdResolvedRef = useRef(false)
  // Captures the mapped error category at handleError time so the telemetry
  // useEffect can pass it through without re-mapping a reconstructed Error
  // (which would have lost the .status / .phase / instanceof discriminators).
  const errorCategoryRef = useRef<OnboardingErrorCategory | undefined>(undefined)

  useEffect(() => {
    if (resolvedApiKeyRef.current)
      return
    const saved = findSavedKeySilent()
    if (saved)
      resolvedApiKeyRef.current = saved
  }, [])

  useEffect(() => {
    if (orgIdResolvedRef.current || !resolvedApiKeyRef.current)
      return
    orgIdResolvedRef.current = true

    let cancelled = false
    void (async () => {
      const orgId = await getOrganizationId(resolvedApiKeyRef.current!, appId).catch(() => null)
      if (orgId && !cancelled)
        setResolvedOrgId(orgId)
    })()

    return () => {
      cancelled = true
    }
  }, [appId])

  const [log, setLog] = useState<LogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const [retryStep, setRetryStep] = useState<OnboardingStep | null>(null)
  // True when the error screen should offer "✨ Create a new key for me (guided)"
  // — set when an ASC key fails to validate on macOS where the helper is available
  // (e.g. the user pasted a stale/wrong .p8). Lets them fall back to the guided
  // flow instead of only retrying the manual entry.
  const [offerGuidedKeyFallback, setOfferGuidedKeyFallback] = useState(false)
  // askOverwrite removed — credential check happens at start now
  const [duplicateProfiles, setDuplicateProfiles] = useState<Array<{ id: string, name: string, profileType: string }>>([])
  const [existingCerts, setExistingCerts] = useState<Array<{ id: string, name: string, serialNumber: string, expirationDate: string }>>([])
  const [certToRevoke, setCertToRevoke] = useState<string | null>(null)
  const pickerOpenedRef = useRef(false)
  const exitRequestedRef = useRef(false)
  // overwriteConfirmedRef removed — credential check happens at start now

  // Collected data — restore p8Path from progress if resuming
  const [p8Path, setP8Path] = useState(initialProgress?.p8Path || '')
  const [p8Content, _setP8Content] = useState('')
  // Resume order: verified key → explicitly saved keyId → re-derive from the saved
  // .p8 filename. The last fallback fixes the case where a previous session picked
  // the .p8 (saving only p8Path) and quit before confirming the Key ID step — the
  // field used to come back empty (showing the placeholder) instead of the real id.
  const [keyId, setKeyId] = useState(
    initialProgress?.completedSteps.apiKeyVerified?.keyId
    || initialProgress?.keyId
    || extractKeyIdFromP8Path(initialProgress?.p8Path || '')
    || '',
  )
  const [issuerId, setIssuerId] = useState(initialProgress?.completedSteps.apiKeyVerified?.issuerId || initialProgress?.issuerId || '')

  // Terminal dimensions, tracked in state so the wizard RE-RENDERS on resize.
  // This matters for the AI-analysis fit check: if the analysis fit inline
  // when the terminal was large and the user then shrinks it, we must
  // re-evaluate and route into the scrollable viewer — otherwise the
  // overflowing content is clipped by the alt buffer with no way to scroll.
  const { stdout } = useStdout()
  const [termSize, setTermSize] = useState<{ rows: number, cols: number }>({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  })
  useEffect(() => {
    if (!stdout)
      return
    const handler = (): void => setTermSize({ rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 })
    stdout.on('resize', handler)
    return () => {
      stdout.off('resize', handler)
    }
  }, [stdout])
  const terminalRows = termSize.rows
  const terminalCols = termSize.cols

  // Measured height of the wizard body (everything below the Header). Drives
  // every fit decision from the LIVE rendered height — no hardcoded row
  // thresholds. The measurement is tagged with the step it was taken for, so
  // a stale measurement from a previous (taller) step can never wedge a new
  // (shorter) step into the too-small state: when the step changes the tagged
  // measurement no longer matches and `bodyHeight` falls back to null until
  // the new body is measured. `measureElement` only reports after a render,
  // so on the first frame of a step `bodyHeight` is null and we optimistically
  // render the box header; the next frame corrects if it doesn't fit
  // (one-frame flash, only on small terminals).
  const bodyRef = useRef<DOMElement | null>(null)
  // Body heights cached per (step, cols). A body's height in ROWS depends on
  // the step, its content, and the terminal WIDTH (wrapping) — but NOT on the
  // terminal HEIGHT. So once a step's comfortable height is measured at the
  // current width, a VERTICAL resize reuses it and the dense / header /
  // too-small decisions are made SYNCHRONOUSLY on the first frame. That kills
  // the measure-then-correct "flash" that used to fire on every resize: the
  // old code keyed `dense` off the live row count, so each resize reset to
  // comfortable, rendered (often overflowing), measured, then flipped back to
  // dense — a visible round-trip per resize tick. We cache the comfortable and
  // dense forms separately (each has its own height).
  const [bodyHeights, setBodyHeights] = useState<{ key: string, comfortable: number | null, dense: number | null }>(
    { key: '', comfortable: null, dense: null },
  )
  const fitKey = `${step}|${terminalCols}`
  const heights = bodyHeights.key === fitKey ? bodyHeights : { key: fitKey, comfortable: null, dense: null }

  // Collapse to the dense (compact-spacing) form only when the comfortable body
  // can't fit even with the one-line header. Derived synchronously from the
  // cached comfortable height; null (first frame of a step, or just after a
  // width change) renders comfortable so we can measure it.
  // Always render the comfortable form. The startup size gate (MinSizeGate)
  // guarantees the terminal is large enough, so the adaptive dense fallback is
  // unreachable — forcing it false removes the fragile measure→decide coupling
  // and the degraded small-terminal UX. (The dense branches in the step
  // components + the measure machinery are now dead code, cleaned up next.)
  const dense = false

  // Measure whichever form is on screen and cache it (only when missing or
  // changed — so this settles and doesn't re-render in a loop).
  useEffect(() => {
    if (!bodyRef.current)
      return
    const { height } = measureElement(bodyRef.current)
    if (height <= 0)
      return
    const form = dense ? 'dense' : 'comfortable'
    setBodyHeights((prev) => {
      const base = prev.key === fitKey ? prev : { key: fitKey, comfortable: null, dense: null }
      if (base[form] === height)
        return prev
      return { ...base, [form]: height }
    })
  })

  // Header degrades box → one-line from the COMFORTABLE height (the upper
  // bound), so the choice is synchronous and never overflows. When dense is
  // active the comfortable body already didn't fit the one-line header, so this
  // is always true then — dense always pairs with the one-line header.
  const headerCompact = heights.comfortable != null
    && (heights.comfortable + BOX_HEADER_ROWS + WIZARD_PADDING_ROWS > terminalRows)
  const bodyHeight = dense ? heights.dense : heights.comfortable

  // Rows available for the completed-steps log. The log renders OUTSIDE the
  // measured body (so its growth never inflates the dense/fit decision) and
  // fills only what the current step leaves: terminal minus header, padding,
  // the measured step body, and the log's own top margin. capLogRows then packs
  // the most recent entries and summarizes the rest — so a long history never
  // pushes the current step off-screen or trips the resize prompt. Before the
  // body is measured (bodyHeight null) we show all entries and let the next
  // frame settle (same one-frame entry behaviour as the fit decision).
  const logHeaderRows = headerCompact ? COMPACT_HEADER_ROWS : BOX_HEADER_ROWS
  const logMaxRows = bodyHeight != null
    ? logBudgetRows(terminalRows, logHeaderRows, bodyHeight)
    : Number.POSITIVE_INFINITY

  // Refs to avoid stale closures in useEffect async handlers
  const p8ContentRef = useRef(p8Content)
  const p8PathRef = useRef(p8Path)
  const keyIdRef = useRef(keyId)
  const issuerIdRef = useRef(issuerId)
  // Lets the asc-key-generating effect's cleanup kill the guided helper child
  // when the user quits the TUI (otherwise the helper's pipes hang the CLI).
  const ascHelperAbortRef = useRef<AbortController | null>(null)
  // Dismisses the guided helper window once the flow has advanced past the key
  // step. The helper resolves on its result line (so the terminal proceeds) but
  // keeps its window open on a success screen; we close it when verifying-key
  // succeeds — otherwise it stays open (e.g. if verification fails).
  const ascHelperCloseRef = useRef<(() => void) | null>(null)

  // Wrapper that keeps both state and ref in sync
  const setP8Content = useCallback((val: string) => {
    p8ContentRef.current = val
    _setP8Content(val)
  }, [])

  // Keep refs in sync when state changes (for state set directly)
  useEffect(() => {
    p8PathRef.current = p8Path
  }, [p8Path])
  useEffect(() => {
    keyIdRef.current = keyId
  }, [keyId])
  useEffect(() => {
    issuerIdRef.current = issuerId
  }, [issuerId])

  // Emit telemetry on every step transition (including initial mount).
  // Sequencing:
  //   1. If `resolvedOrgId` just became available, drain the backlog first.
  //   2. Skip same-step re-renders (orgId-lands triggers a re-fire — we don't
  //      want to re-emit the current step, only drain the backlog).
  //   3. Otherwise compute the new event, then either emit immediately (orgId
  //      available) or queue it (orgId still loading).
  useEffect(() => {
    if (!resolvedApiKeyRef.current)
      return

    const previous = stepTimingRef.current
    const isDuplicateStep = previous.step !== null && previous.step === step && step !== 'error'

    // (1) Drain the backlog if org id is now available, even when the current
    // step is a duplicate (e.g., this effect fired because resolvedOrgId moved
    // from null to a real value, not because step changed).
    if (resolvedOrgId && pendingTelemetryRef.current.length > 0) {
      for (const queued of pendingTelemetryRef.current) {
        void trackBuilderOnboardingStep({
          apikey: resolvedApiKeyRef.current,
          appId,
          journeyId,
          orgId: resolvedOrgId,
          platform: 'ios',
          ...queued,
        })
      }
      pendingTelemetryRef.current = []
    }
    if (resolvedOrgId && pendingActionTelemetryRef.current.length > 0) {
      for (const queued of pendingActionTelemetryRef.current) {
        void trackBuilderOnboardingAction({
          apikey: resolvedApiKeyRef.current,
          appId,
          journeyId,
          orgId: resolvedOrgId,
          platform: 'ios',
          ...queued,
        })
      }
      pendingActionTelemetryRef.current = []
    }

    // (2) Now safely skip the duplicate-step path.
    if (isDuplicateStep)
      return

    const now = Date.now()
    // Initial step (previous.step === null) and same-step error re-entries have
    // no meaningful previous-step duration.
    const durationStep = previous.step === null || previous.step === step
      ? undefined
      : previous.step
    const durationMs = durationStep === undefined
      ? undefined
      : now - previous.startedAt

    const eventPayload = {
      step,
      durationMs,
      durationStep,
      errorCategory: step === 'error' ? errorCategoryRef.current : undefined,
    }

    stepTimingRef.current = { step, startedAt: now }

    // (3) Either fire immediately or buffer.
    if (resolvedOrgId) {
      void trackBuilderOnboardingStep({
        apikey: resolvedApiKeyRef.current,
        appId,
        journeyId,
        orgId: resolvedOrgId,
        platform: 'ios',
        ...eventPayload,
      })
    }
    else {
      pendingTelemetryRef.current.push(eventPayload)
    }
  }, [step, appId, resolvedOrgId, error, journeyId])

  // Report each step up to the shell/command so the quit event can name where
  // the user dropped off. Deliberately separate from the analytics effect above
  // (which is gated on a resolved api key) — drop-off location must be captured
  // for the quit event even when no telemetry key is present.
  useEffect(() => {
    onStep?.(step)
  }, [step, onStep])

  // Emit a named "Builder Onboarding Action" event (distinct from the per-step
  // funnel). Mirrors the Android helper: fires immediately once the org id is
  // resolved, otherwise buffers until the resolver lands (drained in the
  // telemetry effect above). Never throws — telemetry must not break the wizard.
  const trackAction = useCallback(
    (
      action: BuilderOnboardingAction,
      tags?: Record<string, boolean | number | string>,
      actionStep: OnboardingStep = step,
    ): void => {
      if (!resolvedApiKeyRef.current)
        return

      const payload = { step: actionStep, action, tags }
      if (resolvedOrgId) {
        void trackBuilderOnboardingAction({
          apikey: resolvedApiKeyRef.current,
          appId,
          journeyId,
          orgId: resolvedOrgId,
          platform: 'ios',
          ...payload,
        })
      }
      else {
        pendingActionTelemetryRef.current.push(payload)
      }
    },
    [appId, resolvedOrgId, step, journeyId],
  )
  const [teamId, setTeamId] = useState(initialProgress?.completedSteps.certificateCreated?.teamId || '')
  const [certData, setCertData] = useState<CertificateData | null>(initialProgress?.completedSteps.certificateCreated || null)
  const [profileData, setProfileData] = useState<ProfileData | null>(initialProgress?.completedSteps.profileCreated || null)
  const [buildUrl, setBuildUrl] = useState('')
  const [buildOutput, setBuildOutput] = useState<string[]>([])
  const [supportBundlePath, setSupportBundlePath] = useState<string | null>(null)
  // ── Contact-support confirmation gate. `supportConfirmMessage` holds the
  // platform-aware copy passed up by contactSupport(); the Select resolves
  // `supportConfirmResolveRef` with the user's yes/no choice. `support-confirm`
  // always returns to the 'error' step afterwards so the failure menu stays
  // reachable whether the user proceeds or cancels.
  const [supportConfirmMessage, setSupportConfirmMessage] = useState<string>('')
  const supportConfirmResolveRef = useRef<((proceed: boolean) => void) | null>(null)
  // The 'support-confirm' gate is reused for two questions: the full email-support
  // flow ('email' — yes / view logs / cancel) and the additive AI-upload gate
  // ('ai-upload' — a plain yes / no asking whether to ALSO upload logs to support
  // before AI analysis runs). The mode switches the title + options + semantics.
  const [supportConfirmMode, setSupportConfirmMode] = useState<'email' | 'ai-upload'>('email')
  // The exact bundle that will be sent — shown in a scrollable viewer when the
  // user picks "View logs first" from the confirm step.
  const [supportLogLines, setSupportLogLines] = useState<string[]>([])
  const supportLogPathRef = useRef<string>('')
  // Message for the support spinner step — reused for both "preparing the bundle"
  // (gzip/trim can take a moment on a large build) and the network upload.
  const [supportBusyText, setSupportBusyText] = useState('Uploading your logs to Capgo support…')
  // ── AI-analysis sub-flow (entered only when the build fails and logs were
  // captured). `aiJobId` is set when entering 'ai-analysis-prompt'; the running
  // step reads it to call runCapgoAiAnalysis; the result step renders one of
  // these two state strings depending on the PostAnalyzeResult kind.
  // `aiRetryCount` tracks how many "I fixed it, retry" attempts the user has
  // used so we can cap them at MAX_AI_RETRIES.
  // `aiViewedFull` flips true once the user has dismissed the scrollable
  // FullscreenAiViewer for the current analysis — prevents 'ai-analysis-result'
  // from immediately re-routing back into the scroll step on every render.
  const [aiJobId, setAiJobId] = useState<string | null>(null)
  const [aiAnalysisText, setAiAnalysisText] = useState<string | null>(null)
  // Live ANSI preview of the streaming analysis, shown in the running step.
  // Throttled (~250ms) so per-token updates don't re-render the whole tree.
  const [aiStreamPreview, setAiStreamPreview] = useState('')
  // Non-success outcome (already_analyzed / too_big / error) rendered as a
  // prominent coloured banner. Mutually exclusive with `aiAnalysisText` — a
  // successful analysis sets the text and clears this; every other outcome
  // clears the text and sets this. Kept as one object so kind + message can
  // never drift out of sync.
  const [aiResult, setAiResult] = useState<{ kind: AiResultKind, message: string } | null>(null)
  const [aiRetryCount, setAiRetryCount] = useState(0)
  const [aiViewedFull, setAiViewedFull] = useState(false)
  const [errorViewedFull, setErrorViewedFull] = useState(false)
  const [ciSecretEntries, setCiSecretEntries] = useState<CiSecretEntry[]>([])
  const [ciSecretTargets, setCiSecretTargets] = useState<CiSecretTarget[]>([])
  const [ciSecretTarget, setCiSecretTarget] = useState<CiSecretTarget | null>(null)
  const [ciSecretSetupAdvice, setCiSecretSetupAdvice] = useState<CiSecretSetupAdvice[]>([])
  const [ciSecretExistingKeys, setCiSecretExistingKeys] = useState<string[]>([])
  // Concrete `owner/repo` for GitHub (or group/project for GitLab). Resolved
  // in checking-ci-secrets via `gh repo view`. Shown in confirm-secrets-push
  // so the user knows EXACTLY which repo they're about to mutate — never let
  // `gh secret set` run without an explicit "yes, push to <repo>" gate.
  const [ciSecretRepoLabel, setCiSecretRepoLabel] = useState<string | null>(null)
  // Sub-phase text rendered next to the spinner during `checking-ci-secrets`
  // and `uploading-ci-secrets`. Updated as each gh command starts so the user
  // sees actual progress instead of a single static "Checking…" line that
  // freezes for several seconds while gh works.
  const [ciSecretCheckPhase, setCiSecretCheckPhase] = useState<string>('Resolving GitHub repository…')
  const [ciSecretUploadProgress, setCiSecretUploadProgress] = useState<{ current: number, total: number, key: string } | null>(null)
  // Package manager chosen by the user at pick-package-manager. We DETECT via
  // getPMAndCommand() but the user gets the final say — they may have multiple
  // lockfiles, prefer a different runner, or be on an exotic setup.
  const [selectedPackageManager, setSelectedPackageManager] = useState<PackageManager | null>(null)
  // preview-workflow-file viewer state. The large diff is only shown in the
  // bounded `view-workflow-diff` live Ink screen.
  const [previewDiff, setPreviewDiff] = useState<DiffLine[]>([])
  const [previewExistingPath, setPreviewExistingPath] = useState<string | null>(null)
  const [previewIsNew, setPreviewIsNew] = useState(true)
  const [previewTelemetry, setPreviewTelemetry] = useState<WorkflowDiffTelemetry | null>(null)
  const [ciSecretError, setCiSecretError] = useState<string | null>(null)
  const [ciSecretUploadSummary, setCiSecretUploadSummary] = useState<string | null>(null)
  // GitHub Actions workflow setup state. setupMode tracks the 3-way choice at
  // ask-github-actions-setup. After a successful secrets upload, with-workflow
  // continues into pick-build-script + writing-workflow-file; secrets-only
  // exits via build-complete; declined branches to ask-export-env.
  const [setupMode, setSetupMode] = useState<'undecided' | 'with-workflow' | 'secrets-only' | 'declined'>('undecided')
  const [availableScripts, setAvailableScripts] = useState<Record<string, string>>({})
  const [recommendedScript, setRecommendedScript] = useState<string | null>(null)
  const [buildScriptChoice, setBuildScriptChoice] = useState<BuildScriptChoice | null>(null)
  const [workflowWrittenPath, setWorkflowWrittenPath] = useState<string | null>(null)
  const [envExportPath, setEnvExportPath] = useState<string | null>(null)
  const [envExportError, setEnvExportError] = useState<string | null>(null)
  const [envExportTargetPath, setEnvExportTargetPath] = useState<string>('')
  // The raw saved credentials, retained in memory so the .env export can read
  // the same field set that doSaveCredentials wrote to disk — without CAPGO_TOKEN
  // (which only belongs in the CI-secrets push, not in a .env meant for the
  // developer's local reference).
  const [savedCredentials, setSavedCredentials] = useState<Partial<BuildCredentials> | null>(null)

  // Import-existing sub-flow state (macOS only)
  const [importMatches, setImportMatches] = useState<IdentityProfileMatch[]>([])
  // Setter only — the value isn't read in render (we use importMatches for
  // display) but we keep the state hook so future refs stay stable and any
  // pending update calls in import-scanning useEffect remain valid.
  const [, setImportProfiles] = useState<DiscoveredProfile[]>([])
  const [chosenIdentity, setChosenIdentity] = useState<SigningIdentity | null>(null)
  const [chosenProfile, setChosenProfile] = useState<DiscoveredProfile | null>(null)
  // Hydrate importDistribution from progress so resumed sessions don't lose
  // the user's earlier choice. Without this, `doSaveCredentials`'s
  // `needsAscKey = !importMode || importDistribution === 'app_store'` would
  // take the wrong branch (e.g. saving ad_hoc credentials with APPLE_KEY_*
  // fields).
  const [importDistribution, setImportDistribution] = useState<'app_store' | 'ad_hoc' | null>(
    initialProgress?.importDistribution ?? null,
  )
  const [importedP12Password, setImportedP12Password] = useState<string>('')
  /**
   * Tracks whether we're in the import flow so saving-credentials knows which
   * writer to use AND so `verifying-key` routes back to import-pick-identity
   * instead of creating-certificate.
   *
   * MUST be hydrated from progress — without this, a CLI restart mid-import-flow
   * lands the user back at `verifying-key` (or wherever getResumeStep chose)
   * with importMode=false, which silently re-routes them into the create-new
   * path. That's the exact failure mode Codex caught: a resumed app_store
   * import would re-verify .p8, then try to CREATE a new distribution cert
   * via Apple — exactly the cert-limit blow-up users hit before this fix.
   */
  const [importMode, setImportMode] = useState(initialProgress?.setupMethod === 'import-existing')
  /**
   * When the user hits no-match recovery in ad_hoc mode and needs to provide a
   * .p8 inline for an action, this records the action to resume *after* the
   * .p8 → verifying-key chain completes. `null` means there's no pending action
   * (i.e. .p8 was the entry point for app_store, not a recovery side-trip).
   */
  // The 'fetching-profile' variant was removed alongside the Rescan
  // recovery option (commit 36a7c282) — the file picker covers that path.
  const [_pendingRecoveryAction, setPendingRecoveryAction] = useState<'create-profile-only' | null>(null)
  // Why the wizard ended up at `import-no-match-recovery`. Set right before
  // each setStep call that routes there so the step can render an Alert
  // sentence that names the actual cause (Apple-no-cert, bundle mismatch,
  // distribution mismatch, …) instead of the legacy "no profile on disk"
  // wording that contradicted the yellow log line for the Apple-side
  // routes. Back-nav into the recovery menu (file picker cancel, "open
  // portal anyway", explainer back) intentionally does NOT overwrite this
  // — the user is bouncing through, not changing the underlying cause.
  // `null` falls back to the legacy wording so the back-compat default
  // matches every untracked call site.
  const [noMatchReason, setNoMatchReason] = useState<NoMatchReason | null>(null)
  // Guard against re-opening the native picker on every re-render. Reset
  // whenever we leave the import-provide-profile-path step.
  const mobileprovisionPickerOpenedRef = useRef(false)
  // Per-identity Apple-side availability — keyed by Keychain SHA1. Populated
  // by the `import-validating-all-certs` step useEffect when we have a
  // verified API key. Empty map = no eager check performed (e.g. ad_hoc
  // users without .p8); the picker falls back to a single-list layout.
  const [identityAvailability, setIdentityAvailability] = useState<Record<string, EnrichedIdentityAvailability>>({})
  // Per-identity Apple-side PROFILE prefetch state. Fires in parallel right
  // after the eager batch cert validation completes — see the trigger at the
  // tail of `import-validating-all-certs` below. Discriminated union (not
  // `any`) so the cell-render branch narrows via `state.kind` without casts.
  // The `available` variant carries no payload because the profiles get
  // injected directly into `importMatches` (the existing `matchCount > 0`
  // check then naturally renders the cell as green AVAILABLE — see the
  // table-row builder near line ~3066).
  const [profilePrefetch, setProfilePrefetch] = useState<Record<string, { kind: 'pending' | 'available' | 'unavailable' | 'timeout' | 'error' }>>({})
  // Braille-spinner frame counter for the per-row "checking…" cell. Ticks
  // only while at least one prefetch is still pending — gated by the
  // dedicated useEffect below — so the interval is cleaned up the instant
  // every cell has resolved.
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  // Guard against the prefetch trigger re-firing on every re-render of the
  // `import-validating-all-certs` effect. The effect re-runs on `step`
  // changes, but we want fetches to fire exactly once per eager-batch pass.
  // Cleared by `resetForFreshStart` so a Restart can re-trigger cleanly.
  const prefetchTriggeredRef = useRef(false)
  // Generation counter for in-flight prefetches. Captured per fetch closure
  // at fire time; checked before any setState. Bumped by resetForFreshStart
  // to invalidate prior in-flight work without setStating into a fresh
  // wizard. We CANNOT reuse the step-useEffect's `cancelled` flag here —
  // that flag is tripped the instant we `setStep('import-pick-identity')`
  // because React runs the previous effect's cleanup BEFORE the next
  // effect's body. Tying prefetch lifetime to the cleanup would mean every
  // fetch resolves after the cleanup has already cancelled it, so the
  // spinner would spin forever. The generation counter only changes on
  // explicit resets, so prefetches outlive step transitions.
  const prefetchGenerationRef = useRef(0)
  // Result of the per-identity Apple-side cert lookup for the currently
  // chosen identity. `undefined` = not yet checked; `null` = Apple has no
  // matching cert; `string` = Apple's resource id (reused downstream).
  // Set by the import-checking-apple-cert handler; cleared on each pick.
  // The value isn't currently read elsewhere — the underscore-prefixed
  // declaration is kept so future code paths (e.g. an enhanced recovery
  // menu that gates "Create new" on whether Apple actually has the cert)
  // can wire in without re-introducing state.
  const [_appleCertIdForChosen, setAppleCertIdForChosen] = useState<string | null | undefined>(undefined)
  /**
   * Records which step triggered the shared `duplicate-profile-prompt` so the
   * `deleting-duplicate-profiles` handler routes the retry correctly. Without
   * this, an import-flow duplicate (raised from `import-create-profile-only`)
   * would retry `creating-profile` — the create-new path — which can't
   * succeed in import mode because `certData.certificateId` is never set.
   */
  const [_duplicateProfileOrigin, setDuplicateProfileOrigin] = useState<'creating-profile' | 'import-create-profile-only'>('creating-profile')

  // ─── Engine-driven create-new effect carried transient (ink-thin-wrapper) ───
  // Driver-held transient threaded between the create-new provisioning effects
  // (verifying-key → creating-certificate → creating-profile, plus the cert-limit
  // / duplicate recovery branches). Mirrors the e2e driver's `carried` and the
  // android driver's deps.carried: the engine's IosEffectResult.transient is
  // merged in here after each effect and passed back as deps.carried on the next.
  // NEVER persisted — these are the ephemeral cert/profile/p12 payloads + the
  // .p8 bytes + the cert-limit / duplicate selections. Held in a ref (not state)
  // so a re-render between effects doesn't lose it and reads see the freshest
  // value synchronously, exactly like p8ContentRef.
  const iosCarriedRef = useRef<NonNullable<IosEffectDeps['carried']>>({})

  const addLog = useCallback((text: string, color = 'green') => {
    // Mirror every activity-log line into the support bundle's internal log.
    appendInternalLog(text)
    setLog((prev) => {
      // Drop a consecutive duplicate: completed-step breadcrumbs are idempotent,
      // so the same line twice in a row is always spam, never information. Guards
      // against the log filling with repeats if a hydration replay / re-render
      // fires it more than once. (Mirrors the Android sibling.)
      const last = prev[prev.length - 1]
      if (last && last.text === text && last.color === color)
        return prev
      return [...prev, { text, color }]
    })
  }, [])

  // Persist every step transition so the support bundle carries the full onboarding
  // trace, not just whatever screen the user was on when they hit Email support.
  useEffect(() => {
    appendInternalLog(`step → ${step}`)
  }, [step])

  /**
   * Field-update breadcrumb: write/replace a single log entry identified by a
   * stable prefix, so navigating back and re-picking the same field doesn't
   * stack duplicate lines. Unlike `addLog`'s consecutive-dedupe, this scans
   * the WHOLE log for any entry starting with `prefix` — so even when other
   * lines have been emitted between picks, only one "Distribution · …" /
   * "Key ID · …" / "Issuer ID · …" entry survives.
   *
   * Pre-merge our PR shipped this for Key ID / Issuer ID edits; the rewrite
   * dropped it. Restored here to fix the "Distribution · ad_hoc twice"
   * report after the user back-navigates the import flow.
   */
  const upsertLog = useCallback((prefix: string, text: string, color = 'green') => {
    setLog((prev) => {
      const idx = prev.findIndex(e => e.text.startsWith(prefix))
      if (idx >= 0) {
        if (prev[idx].text === text && prev[idx].color === color)
          return prev
        const next = [...prev]
        next[idx] = { text, color }
        return next
      }
      // No existing entry — append, with the same consecutive-dedupe guard.
      const last = prev[prev.length - 1]
      if (last && last.text === text && last.color === color)
        return prev
      return [...prev, { text, color }]
    })
  }, [])

  // Best-effort PostHog telemetry for the verify-app step. Mirrors
  // builder-cta.ts's trackEvent usage (channel 'bundle') and ALWAYS sets
  // `step` (the Builder dashboard filters null steps out of funnels via
  // JSONExtractString — an unset step silently drops the event). Never
  // blocks or throws into the wizard.
  const trackVerifyEvent = useCallback((
    event: string,
    icon: string,
    tags: Record<string, string | number | boolean> = {},
  ) => {
    void trackEvent({
      channel: 'bundle',
      event,
      icon,
      apikey: resolvedApiKeyRef.current ?? apikey ?? undefined,
      appId,
      orgId: resolvedOrgId ?? undefined,
      tags: { step: 'ios-app-verify', platform: 'ios', mode: 'app_store', ...tags },
    })
  }, [appId, apikey, resolvedOrgId])

  // ── verify-app gate resolver (engine-driven, PR #2397 port) ──────────────
  // The PARKED gate's actions (pick an app / autofix / re-check / re-poll /
  // open the create-app page / back) are EPHEMERAL: record the pick into
  // iosCarriedRef.verifyAction (+ the chosen app) and re-drive the engine's
  // verify-app step as a RESOLVER effect — the same carried-driven mechanism
  // as cert-limit-prompt. The ENGINE does the IO (fresh pbxproj re-detect /
  // writeReleaseBundleId auto-fix / ASC re-poll / the persistVerifyOverride
  // write) + the evaluateGate escalation; this driver mirrors the returned
  // transient back into the React render state, fires the PostHog telemetry
  // (kept driver-side), and advances when the gate passes. verifyAction is
  // CLEARED after every run so a later re-entry into verify-app re-runs the
  // engine's initial fetch. Cancel stays a bespoke driver exit (cancelGate →
  // exitOnboarding); the engine's error-sink 'cancel' is for headless drivers.
  const runVerifyGateAction = async (
    action: 'pick' | 'create-new' | 'autofix' | 'continue' | 'recheck' | 'open' | 'reopen' | 'back',
    chosenApp?: AscAppLike | null,
  ) => {
    iosCarriedRef.current = {
      ...iosCarriedRef.current,
      verifyAction: action,
      ...(chosenApp !== undefined ? { verifyChosenApp: chosenApp } : {}),
    }
    const preAttempt = iosCarriedRef.current.verifyAttempt ?? 0
    const gatePath: GatePath = action === 'recheck' || action === 'open' || action === 'reopen' || action === 'create-new'
      ? 'create-app'
      : 'fix-build-id'
    // Capture the auto-fix write result so the driver can fire the Auto Fixed
    // telemetry exactly when the bespoke handler did (changed > 0).
    let autoFixChanged = 0
    // The Path B re-poll is a network round-trip — show the step loader so the
    // re-check doesn't feel like a silent no-op.
    if (action === 'recheck')
      setVerifyAppLoading(true)
    try {
      const current = (await loadProgress(appId)) ?? {
        platform: 'ios' as const,
        appId,
        startedAt: new Date().toISOString(),
        completedSteps: {},
      }
      const result = await runIosEffect('verify-app', current, {
        appId,
        listApps: async () => listApps(await getFreshToken()),
        listBundleIds: async () => listBundleIds(await getFreshToken()),
        detectBundleIds: () => detectIosBundleIds({ cwd: process.cwd(), iosDir, capacitorAppId: iosBundleIdInitial }),
        writeReleaseBundleId: (fromId, toId) => {
          const r = writeReleaseBundleId(process.cwd(), iosDir, fromId, toId)
          autoFixChanged = r.changed
          return r
        },
        ensureBundleId: async (bundleId) => { await ensureBundleId(await getFreshToken(), bundleId) },
        openExternal: async (url) => { await open(url) },
        loadProgress,
        saveProgress,
        carried: iosCarriedRef.current,
        onLog: (message, color) => addLog(message, color),
      })
      const t = result.transient
      // Merge the resolver transient back + CLEAR the consumed action so a
      // later verify-app re-entry runs the initial fetch.
      iosCarriedRef.current = { ...iosCarriedRef.current, ...(t ?? {}), verifyAction: undefined }
      if (t) {
        if (t.verifyApps !== undefined)
          setVerifyApps(t.verifyApps)
        if (t.verifyReleaseBundleId !== undefined)
          setVerifyReleaseBundleId(t.verifyReleaseBundleId)
        if (t.verifyPath !== undefined)
          setVerifyPath(t.verifyPath)
        if (t.verifyChosenApp !== undefined)
          setVerifyChosenApp(t.verifyChosenApp)
        if (t.verifyAttempt !== undefined)
          setVerifyAttempt(t.verifyAttempt)
        if (t.verifyAskReopen !== undefined)
          setVerifyAskReopen(t.verifyAskReopen)
      }
      // A gate PASS persisted the verified override — mirror the
      // persistVerifyOverride React effects (wire the id into Apple-side work
      // and stop redirectIfMismatch re-adopting later).
      if (result.progress.iosBundleIdOverride && result.progress.iosBundleIdOverride !== current.iosBundleIdOverride) {
        setIosBundleId(result.progress.iosBundleIdOverride)
        setAppIdConfirmed(true)
      }
      // Telemetry (driver-side): the same events + tags the bespoke handlers
      // fired — Auto Fixed (changed > 0), Create App Opened, Gate Blocked (the
      // attempt counter advanced while staying parked), Passed (advanced).
      if (action === 'autofix' && autoFixChanged > 0)
        trackVerifyEvent('iOS App Verify Auto Fixed', '🔧', { attempt: preAttempt, path: 'fix-build-id' })
      if (action === 'open' || action === 'reopen')
        trackVerifyEvent('iOS App Verify Create App Opened', '🌐', { attempt: preAttempt })
      const attemptAfter = t?.verifyAttempt ?? preAttempt
      if (result.next === 'verify-app' && attemptAfter > preAttempt)
        trackVerifyEvent('iOS App Verify Gate Blocked', '🚧', { attempt: attemptAfter, path: gatePath })
      if (result.next && result.next !== 'verify-app' && result.next !== 'error') {
        trackVerifyEvent('iOS App Verify Passed', '✅', { attempts: preAttempt, path: gatePath })
        setStep(result.next)
      }
    }
    catch (err) {
      handleError(err, 'verify-app')
    }
    finally {
      if (action === 'recheck')
        setVerifyAppLoading(false)
    }
  }

  const pm = getPMAndCommand()
  const addIosCommand = formatRunnerCommand(pm.runner, ['cap', 'add', 'ios'])
  const syncIosCommand = formatRunnerCommand(pm.runner, ['cap', 'sync', 'ios'])
  const doctorCommand = formatRunnerCommand(pm.runner, ['@capgo/cli@latest', 'doctor'])
  const buildInitCommand = formatRunnerCommand(pm.runner, ['@capgo/cli@latest', 'build', 'init'])
  const buildRequestCommand = formatRunnerCommand(pm.runner, ['@capgo/cli@latest', 'build', 'request', appId, '--platform', 'ios'])

  const trackWorkflowEvent = (
    event: BuildOnboardingWorkflowEvent,
    options: { decision?: BuildOnboardingWorkflowDecision, diff?: DiffLine[], isNew?: boolean } = {},
  ) => {
    const telemetry = options.diff
      ? getWorkflowDiffTelemetry(options.diff, options.isNew ?? previewIsNew)
      : (previewTelemetry ?? getWorkflowDiffTelemetry(previewDiff, options.isNew ?? previewIsNew))

    trackBuildOnboardingWorkflowEvent({
      event,
      appId,
      platform: 'ios',
      apikey,
      journeyId,
      packageManager: selectedPackageManager ?? normalizePackageManager(pm.pm),
      buildScriptType: buildScriptChoice?.type,
      decision: options.decision,
      ...telemetry,
    })
  }

  const exitOnboarding = useCallback((message?: string) => {
    if (exitRequestedRef.current)
      return
    exitRequestedRef.current = true
    if (message)
      addLog(message, 'yellow')
    setTimeout(exitAfterBeforeExit, 50)
  }, [addLog, exitAfterBeforeExit])

  // Open browser on Ctrl+O (FilteredTextInput ignores ctrl keys, so no conflict)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      process.kill(process.pid, 'SIGINT')
      return
    }

    // build-complete is the terminal success screen; it deliberately does not
    // auto-exit (that would wipe the frame on the alt-screen before it can be
    // read). Dismiss on Enter/Esc/q so it lasts until the user is ready.
    if (step === 'build-complete' && isBuildCompleteDismissKey(input, key)) {
      exitAfterBeforeExit()
      return
    }

    if (key.ctrl && input === 'o' && (step === 'api-key-instructions' || step === 'input-issuer-id')) {
      open('https://appstoreconnect.apple.com/access/integrations/api')
    }

    // preview-workflow-file: Esc skips without writing. Arrows/Enter are
    // handled by the Ink Select below the diff.
    if (step === 'preview-workflow-file' && key.escape) {
      trackWorkflowEvent('workflow-preview-action', { decision: 'escape' })
      setPreviewDiff([])
      setStep('build-complete')
    }
  })

  /** Save partial progress so the user can resume mid-flow */
  const savePartialProgress = useCallback(async (updates: { p8Path?: string, keyId?: string, issuerId?: string }) => {
    const existing = await loadProgress(appId) || {
      platform: 'ios' as const,
      appId,
      startedAt: new Date().toISOString(),
      completedSteps: {},
    }
    // Build a new object rather than mutating the loaded one (immutability).
    const next = { ...existing }
    if (updates.p8Path !== undefined)
      next.p8Path = updates.p8Path
    if (updates.keyId !== undefined)
      next.keyId = updates.keyId
    if (updates.issuerId !== undefined)
      next.issuerId = updates.issuerId
    await saveProgress(appId, next)
  }, [appId])

  // Persist which .p8 source the user picked in the create-new fork so a
  // quit-and-resume routes back to the same path (see getResumeStep): an
  // `automated` user resumes on the guided helper, a `manual` user on the .p8
  // instructions. Best-effort — a missing progress file just means a fresh run.
  const persistP8CreateMethod = useCallback(async (method: 'automated' | 'manual') => {
    const existing = await loadProgress(appId)
    if (!existing)
      return
    await saveProgress(appId, { ...existing, p8CreateMethod: method })
  }, [appId])

  /**
   * Reset everything for a fresh-start onboarding pass. Called from:
   *   • the ErrorStep restart handler (existing user-facing "Restart" option),
   *   • the resume-prompt restart handler (new mount-time "start over" branch).
   *
   * Wipes the on-disk progress file AND every piece of in-memory state that
   * could otherwise leak across into the next attempt (chosen identity/profile,
   * import distribution, ASC key inputs' cert/profile outputs, the eager
   * per-cert availability map, file-picker guards, error/retry plumbing, and
   * the iOS bundle id confirmation gate). Does NOT addLog or setStep — the
   * caller picks the user-facing message and the next step so each call site
   * can phrase its breadcrumb differently.
   */
  const resetForFreshStart = useCallback(async () => {
    await deleteProgress(appId).catch((err) => {
      // Best-effort: a failed wipe must not block the restart, but leave a
      // trace in the internal log so support bundles can explain a "restart
      // that still resumed" report.
      appendInternalLog(`restart: deleteProgress failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    // Import-flow state
    setImportMode(false)
    setImportMatches([])
    setImportProfiles([])
    setChosenIdentity(null)
    setChosenProfile(null)
    setImportDistribution(null)
    setImportedP12Password('')
    setPendingRecoveryAction(null)
    // ASC API key inputs (state + their refs). Without this a Restart
    // that follows a partial .p8 flow would carry the previous run's
    // p8 path / Key ID / Issuer ID into the next pass. The state
    // setters trigger the existing useEffect([state]) sync to the
    // refs on the next render — but resetForFreshStart is called
    // immediately before setStep('welcome') which fires the React
    // render that triggers them. We also set the refs directly here
    // so any sync code between this call and the next render (e.g.
    // a subsequent setStep on an alternate restart path) sees clean
    // values rather than stale.
    setP8Path('')
    setP8Content('') // wrapper updates p8ContentRef too
    setKeyId('')
    setIssuerId('')
    setTeamId('')
    p8PathRef.current = ''
    keyIdRef.current = ''
    issuerIdRef.current = ''
    // Eager per-identity Apple-side availability cache. The previous restart
    // handler missed this — after restart the picker would still see the prior
    // run's per-cert reasons. Reset so the next batch validation starts clean.
    setIdentityAvailability({})
    // Per-identity PROFILE prefetch state + its one-shot guard. Without the
    // ref reset, a Restart followed by a re-enter would early-out of the
    // prefetch trigger and leave every AVAILABLE row stuck rendering as
    // UNAVAILABLE (no prefetch fires, no profiles injected).
    setProfilePrefetch({})
    prefetchTriggeredRef.current = false
    // Bump the generation so any prefetch fetches still in flight from a
    // pre-restart pass invalidate themselves before they hit setState —
    // otherwise they'd write stale 'available'/'unavailable' entries into
    // the freshly-emptied prefetch map AFTER the user has already restarted.
    prefetchGenerationRef.current += 1
    // Credential outputs
    setCertData(null)
    setProfileData(null)
    // Error / retry plumbing
    setError(null)
    errorCategoryRef.current = undefined
    setRetryCount(0)
    setSupportBundlePath(null)
    // File-picker re-open guards
    pickerOpenedRef.current = false
    mobileprovisionPickerOpenedRef.current = false
    // iOS bundle id resolution — reset so a restart re-resolves the authoritative
    // Release bundle id from scratch (redirectIfMismatch / verify-app set these
    // again) rather than keeping a stale override from the aborted run.
    setIosBundleId(iosBundleIdInitial)
    setAppIdConfirmed(false)
    // No-match recovery context — without this a restart would carry the
    // previous run's reason into the next pass and surface the wrong
    // bundle/distribution/profile-source wording in the recovery alert.
    setNoMatchReason(null)
    // After a Restart, if the user re-enters the import flow and picks
    // Ad Hoc again, they should see the support hint fresh — otherwise
    // the previous session's emission would mute a hint that's now
    // newly relevant.
    adHocHintShownRef.current = false
    // verify-app (remote App Store verification) — reset the one-shot Shown
    // guard, all step render state AND the carried gate threading so a Restart
    // that re-enters verify-app re-runs the engine's initial fetch with no
    // stale gate state (pendingVerifyNext is EPHEMERAL: a fresh pass falls
    // back to creating-certificate).
    verifyShownRef.current = false
    iosCarriedRef.current = {
      ...iosCarriedRef.current,
      pendingVerifyNext: undefined,
      verifyAction: undefined,
      verifyChosenApp: undefined,
      verifyApps: undefined,
      verifyRegisteredIds: undefined,
      verifyReleaseBundleId: undefined,
      verifyDebugBundleId: undefined,
      verifyPath: undefined,
      verifyAttempt: undefined,
      verifyAskReopen: undefined,
    }
    setVerifyAppLoading(false)
    setVerifyReleaseBundleId('')
    setVerifyDebugBundleId('')
    setVerifyApps([])
    setVerifyRegisteredIds([])
    setVerifyPath(null)
    setVerifyChosenApp(null)
    setVerifyAttempt(0)
    setVerifyAskReopen(false)
    setGateActionSeq(0)
  }, [appId, iosBundleIdInitial])

  // Extract Key ID from .p8 filename — delegates to the module-level helper so
  // the resume initializer and the live-pick handlers share one implementation.
  const extractKeyIdFromPath = extractKeyIdFromP8Path

  /**
   * Get a fresh JWT token, re-reading the .p8 file if needed.
   * Uses refs to avoid stale closure issues.
   * (NeedP8Error — the redirect-to-.p8-input signal — lives at module scope.)
   */
  async function getFreshToken(): Promise<string> {
    let content = p8ContentRef.current
    if (!content && p8PathRef.current) {
      try {
        content = await readFile(p8PathRef.current, 'utf-8')
        setP8Content(content)
      }
      catch (err) {
        appendInternalLog(`saved .p8 no longer readable, re-prompting: ${err instanceof Error ? err.message : String(err)}`)
        // Saved p8Path was moved, deleted, or is no longer readable since
        // the previous run. Convert to NeedP8Error so handleError routes
        // the user back to api-key-instructions for a clean re-prompt
        // rather than surfacing a raw ENOENT support-bundle screen.
        throw new NeedP8Error()
      }
    }
    if (!content) {
      throw new NeedP8Error()
    }
    return generateJwt(keyIdRef.current, issuerIdRef.current, content)
  }

  // Has the ad-hoc support hint been logged this session? Both the
  // hydration replay (used when resuming a saved ad_hoc run via the
  // Continue button) AND the distribution-mode onChange (used when the
  // user picks Ad Hoc fresh) want to surface it — but addLog's dedupe
  // only suppresses CONSECUTIVE duplicates, so an interleaved log line
  // (e.g. `✔ Distribution · ad_hoc` between the two emissions) breaks
  // the dedupe and the hint prints twice. A session-scoped ref handles
  // both call sites uniformly.
  const adHocHintShownRef = useRef(false)
  const logAdHocSupportHint = useCallback(() => {
    if (adHocHintShownRef.current)
      return
    adHocHintShownRef.current = true
    addLog('ℹ️  Ad-hoc is more involved than App Store — you also need to register every device on Apple.', 'yellow')
    addLog('   Want hands-on help? Email support@capgo.app and we\'ll walk you through it.', 'yellow')
  }, [addLog])

  // Re-emit the breadcrumb entries the user "earned" before this session
  // — partial inputs (p8 path, key id, issuer id), completed steps
  // (apiKeyVerified, certificateCreated, profileCreated), and the
  // ad-hoc-needs-help hint when applicable. Wrapped in a useCallback so
  // both the mount-time path AND the resume-prompt "Continue" handler can
  // call it. We DON'T want this firing while the user is still on the
  // resume-prompt screen — the side log would fill with stale entries
  // BEFORE the user has chosen Continue vs Restart, and picking Restart
  // would leave those entries dangling next to a fresh wizard. addLog's
  // consecutive-dedupe protects against accidental double calls.
  const hydrateCompletedLog = useCallback(() => {
    if (!initialProgress)
      return
    // Distribution mode is the upstream-most import-flow field — surface it
    // first so the resumed breadcrumb mirrors the order a user would see on
    // a fresh run (Distribution → Key file → Key ID → Issuer ID → …).
    // Without this the hydration replay was emitting the ad-hoc support hint
    // (which is gated on importDistribution === 'ad_hoc') WITHOUT first
    // emitting the "✔ Distribution · ad_hoc" line that explains why the
    // hint exists — surprising the user with the support breadcrumb out
    // of context.
    if (initialProgress.importDistribution)
      upsertLog('✔ Distribution · ', `✔ Distribution · ${initialProgress.importDistribution}`)
    if (initialProgress.p8Path)
      upsertLog('✔ Key file selected · ', `✔ Key file selected · ${initialProgress.p8Path}`)
    if (initialProgress.keyId && !initialProgress.completedSteps.apiKeyVerified)
      upsertLog('✔ Key ID · ', `✔ Key ID · ${initialProgress.keyId}`)
    if (initialProgress.issuerId && !initialProgress.completedSteps.apiKeyVerified)
      upsertLog('✔ Issuer ID · ', `✔ Issuer ID · ${initialProgress.issuerId}`)
    const { completedSteps } = initialProgress
    if (completedSteps.apiKeyVerified)
      addLog(`✔ API Key verified — Key: ${completedSteps.apiKeyVerified.keyId}`)
    if (completedSteps.certificateCreated)
      addLog(`✔ Distribution certificate created — Expires ${completedSteps.certificateCreated.expirationDate}`)
    if (completedSteps.profileCreated)
      addLog(`✔ Provisioning profile created — "${completedSteps.profileCreated.profileName}"`)
    if (initialProgress.importDistribution === 'ad_hoc' && !completedSteps.profileCreated)
      logAdHocSupportHint()
  }, [initialProgress, addLog, logAdHocSupportHint])

  // Mount-time hydration. Suppressed when the initial step is the
  // resume-prompt fork — that path defers hydration to the user's
  // explicit Continue choice (see the resume-prompt onChange below).
  // The trivial-progress paths (welcome / no progress) still hydrate
  // here so any partial input the user had keeps its breadcrumb.
  const skipMountHydrationRef = useRef(step === 'resume-prompt')
  useEffect(() => {
    if (skipMountHydrationRef.current)
      return
    hydrateCompletedLog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleError = useCallback((err: unknown, failedStep: OnboardingStep) => {
    // If we need the .p8 file, redirect to the input step
    if (err instanceof NeedP8Error) {
      addLog('ℹ️  We need your .p8 key file to continue.', 'yellow')
      setStep('api-key-instructions')
      return
    }
    // Capture the mapped category BEFORE we collapse err to a string.
    // The telemetry useEffect will read this ref instead of re-mapping a
    // reconstructed `new Error(message)` (which has no discriminators).
    errorCategoryRef.current = mapIosOnboardingError(err, failedStep)
    const message = err instanceof Error ? err.message : String(err)
    const nextRetryCount = retryCount + 1
    const bundlePath = writeOnboardingSupportBundle({
      kind: 'build-init',
      appId,
      currentStep: failedStep,
      packageManager: pm.pm,
      cwd: process.cwd(),
      error: message,
      commands: [buildInitCommand, doctorCommand],
      docs: ['https://capgo.app/docs/cli/cloud-build/ios/'],
      logs: [
        ...log.slice(-12).map(entry => entry.text),
        ...buildOutput.slice(-12),
      ],
    })
    setSupportBundlePath(bundlePath)
    setError(message)
    setRetryStep(failedStep)
    // A key that won't validate on macOS-with-helper → offer the guided creation
    // as the lead recovery option (e.g. the user pasted a stale/wrong .p8). But NOT
    // when the key is valid and Apple is blocking on an unsigned/expired agreement —
    // creating a new key cannot resolve that, so don't lead the user down it.
    setOfferGuidedKeyFallback(
      failedStep === 'verifying-key'
      && guidedHelperUsable
      && errorCategoryRef.current !== 'apple_agreements_missing',
    )
    setRetryCount(nextRetryCount)
    if (nextRetryCount > 1) {
      addLog(`⚠ Attempt ${nextRetryCount} failed. Recovery steps and a support bundle are available below.`, 'yellow')
    }
    setStep('error')
  }, [retryCount, addLog, appId, buildInitCommand, buildOutput, doctorCommand, log, pm.pm])

  // The three [step]-keyed engine drivers (create-new / import / tail) run
  // long async effects that must report failures through the LATEST
  // handleError — but handleError is re-created on every retryCount/log/
  // buildOutput tick, so the [step]-keyed closures would otherwise call a
  // STALE copy (old retry counter, old log tail in the support bundle).
  // Port the android driver's pattern (android/ui/app.tsx handleErrorRef):
  // a ref updated every render; the drivers call ref.current at error time.
  const handleErrorRef = useRef(handleError)
  useEffect(() => {
    handleErrorRef.current = handleError
  }, [handleError])

  // @inkjs/ui Select re-fires onChange on every re-render while it stays
  // mounted after a selection (known upstream bug). The cert-limit-prompt and
  // duplicate-profile-prompt resolvers are ASYNC — they await loadProgress +
  // runIosEffect before setStep unmounts the Select — so a re-fire in that
  // window would double-run the resolver. One-shot refs (set BEFORE the first
  // await, reset on step change) make them idempotent.
  const certLimitPickHandledRef = useRef(false)
  const duplicateProfilePickHandledRef = useRef(false)
  useEffect(() => {
    certLimitPickHandledRef.current = false
    duplicateProfilePickHandledRef.current = false
  }, [step])

  // Show the contact-support confirmation gate as an Ink step and resolve once
  // the user picks Yes/Cancel. Returns a promise so contactSupport() can await
  // the user's decision before doing anything (writing logs / opening mail).
  const askSupportConfirm = useCallback((message: string, logPath: string): Promise<boolean> => {
    setSupportConfirmMode('email')
    setSupportConfirmMessage(message)
    supportLogPathRef.current = logPath
    setStep('support-confirm')
    return new Promise<boolean>((resolve) => {
      supportConfirmResolveRef.current = resolve
    })
  }, [])

  // The additive AI-upload gate: a plain yes/no reusing the 'support-confirm'
  // step (in 'ai-upload' mode). Resolves true/false so offerSupportUploadBeforeAi
  // can decide whether to upload the logs before the AI analysis runs.
  const askAiUploadConfirm = useCallback((message: string): Promise<boolean> => {
    setSupportConfirmMode('ai-upload')
    setSupportConfirmMessage(message)
    setStep('support-confirm')
    return new Promise<boolean>((resolve) => {
      supportConfirmResolveRef.current = resolve
    })
  }, [])

  // Read the verbose internal log (raw provider/API errors, secret-redacted) so
  // it can be folded into the support bundle's "Internal log" section.
  const readInternalLogLines = useCallback((): string[] => {
    const internalLogPath = getInternalLogPath()
    if (!internalLogPath)
      return []
    try {
      return readFileSync(internalLogPath, 'utf8').split('\n')
    }
    catch {
      return []
    }
  }, [])

  // Drive the contact-support flow: confirm gate → write bundle → copy the
  // .log.gz path → reveal in Finder (macOS) → open a pre-filled mailto. Every
  // step but "write the bundle" is best-effort; failures degrade gracefully and
  // we return to the step we came from (error menu / AI prompt / AI result).
  const handleSupport = useCallback(async (returnTo: 'error' | 'ai-analysis-prompt' | 'ai-analysis-result' = 'error') => {
    // Redact the error before it goes into the pre-filled email body — the body
    // is plain outbound text (unlike the attached bundle, which is redacted on
    // write), so an un-sanitized error could leak tokens/identifiers.
    const sanitizedError = redactSecrets(error ?? 'unknown error')
    await contactSupport({
      subject: `Capgo Builder support — ${appId} (ios)`,
      body: `Hi Capgo team,\n\nMy build failed and I'd like help.\n\nApp: ${appId}\nPlatform: ios\nError: ${sanitizedError}`,
      confirm: async (msg, logPath) => askSupportConfirm(msg, logPath),
      buildFiles: async () => {
        // Show a spinner while we render + gzip (and, for a huge build, trim to fit
        // the 10 MB upload cap) — that work is synchronous, so yield once first to
        // let Ink paint the message before it runs.
        setSupportBusyText('Preparing your logs to send…')
        setStep('support-uploading')
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        return writeSupportBundleFiles({
          kind: 'build-init',
          appId,
          error: error ?? 'unknown error',
          // Full activity trail + the COMPLETE build log (buildOutput holds every
          // line streamed from the remote builder — never truncate it, or support
          // gets a useless 12-line snippet and can't diagnose the failure).
          logs: log.map(entry => entry.text),
          sections: [
            { title: 'Build output (full)', lines: buildOutput },
            { title: 'Internal log', lines: readInternalLogLines() },
            // When the user escalates after running AI, fold the analysis into the
            // bundle so support sees what the AI already concluded (spec §2).
            ...(aiAnalysisText ? [{ title: 'AI analysis', lines: aiAnalysisText.split('\n') }] : []),
          ],
        })
      },
      copyPath: p => copyToClipboard(p).ok,
      reveal: p => revealInFinder(p),
      openUrl: u => open(u),
      print: msg => addLog(msg, 'cyan'),
      upload: (gzPath) => {
        setSupportBusyText('Uploading your logs to Capgo support…')
        setStep('support-uploading') // show a spinner while the (network) upload runs
        return uploadSupportLogs({
          apiHost: supaHost ?? 'https://api.capgo.app',
          apikey: resolvedApiKeyRef.current ?? apikey ?? '',
          appId,
          jobId: aiJobId ?? undefined,
          gzPath,
        })
      },
    })
    setStep(returnTo)
  }, [appId, apikey, aiJobId, error, log, buildOutput, aiAnalysisText, askSupportConfirm, readInternalLogLines, addLog])

  // Additive support-log upload offered right after the user picks "Debug with
  // AI" and BEFORE the analysis runs. Upload-only — no mailto: we just push the
  // bundle to Capgo support and tell the user they'll be contacted by email.
  // Best-effort; whatever happens, the caller proceeds to ai-analysis-running.
  const offerAiSupportUpload = useCallback(async (): Promise<void> => {
    await offerSupportUploadBeforeAi({
      confirm: msg => askAiUploadConfirm(msg),
      buildFiles: async () => {
        setSupportBusyText('Preparing your logs to send…')
        setStep('support-uploading')
        await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
        return writeSupportBundleFiles({
          kind: 'build-init',
          appId,
          error: error ?? 'unknown error',
          logs: log.map(entry => entry.text),
          sections: [
            { title: 'Build output (full)', lines: buildOutput },
            { title: 'Internal log', lines: readInternalLogLines() },
          ],
        })
      },
      upload: (gzPath) => {
        setSupportBusyText('Uploading your logs to Capgo support…')
        setStep('support-uploading')
        return uploadSupportLogs({
          apiHost: supaHost ?? 'https://api.capgo.app',
          apikey: resolvedApiKeyRef.current ?? apikey ?? '',
          appId,
          jobId: aiJobId ?? undefined,
          gzPath,
        })
      },
      print: msg => addLog(msg, 'cyan'),
    })
  }, [appId, apikey, aiJobId, error, log, buildOutput, askAiUploadConfirm, readInternalLogLines, addLog, supaHost])
  // ── Async step handlers ──

  useEffect(() => {
    let cancelled = false

    if (step === 'welcome') {
      // Platform was already chosen in command.ts before this Ink app rendered.
      // Skip the legacy platform-select Select and go straight to the iOS-specific
      // checks that platform-select used to gatekeep:
      //   1. If ios/ doesn't exist → no-platform recovery flow
      //   2. If iOS credentials already exist → credentials-exist confirmation
      //   3. Otherwise → api-key-instructions
      setTimeout(() => {
        if (cancelled)
          return
        if (!existsSync(join(process.cwd(), iosDir))) {
          setStep('no-platform')
          return
        }
        ;(async () => {
          const existing = await loadSavedCredentials(appId)
          if (cancelled)
            return
          if (existing?.ios)
            setStep('credentials-exist')
          else if (isMacOS())
            // Fresh iOS, no creds: offer the import-vs-create fork (create-new →
            // the guided .p8 helper). Only macOS can drive the helper; other
            // hosts go straight to the manual .p8 instructions.
            setStep('setup-method-select')
          else
            setStep('api-key-instructions')
        })()
      }, 800)
    }

    // backing-up is now engine-driven (IOS_ENGINE_CREATE_EFFECT_STEPS) —
    // see the create-new effect driver below. The engine copies the credentials
    // backup, persists the _credentialsExistGate='done' marker, and routes to
    // setup-method-select (macOS) / api-key-instructions (off-macOS).

    if (step === 'platform-select') {
      // Check if ios/ exists — if not, skip Select and go straight to error
      if (!existsSync(join(process.cwd(), iosDir))) {
        setStep('no-platform')
      }
    }

    if (step === 'no-platform') {
      pickerOpenedRef.current = false
    }

    if (step === 'adding-platform') {
      ;(async () => {
        const result = await runRunnerCommand(pm.runner, ['cap', 'add', 'ios'])
        if (cancelled)
          return

        if (result.success && existsSync(join(process.cwd(), iosDir))) {
          addLog(`✔ Native iOS platform created with ${addIosCommand}`)
          setError(null)
          errorCategoryRef.current = undefined
          setRetryCount(0)
          // Re-run the welcome → platform check inline rather than detouring
          // through the legacy platform-select step.
          ;(async () => {
            const existing = await loadSavedCredentials(appId)
            if (cancelled)
              return
            if (existing?.ios)
              setStep('credentials-exist')
            else if (isMacOS())
              // Fresh iOS, no creds: route through the import-vs-create fork
              // (create-new → the guided .p8 helper) on macOS.
              setStep('setup-method-select')
            else
              setStep('api-key-instructions')
          })()
          return
        }

        const detail = result.output.length > 0
          ? `\n${result.output.slice(-6).join('\n')}`
          : ''
        handleError(new Error(`Could not add the iOS platform automatically.${detail}`), 'adding-platform')
      })()
    }

    // ── Import-existing sub-flow (macOS only) ──
    // ── Guided ASC key creation (macOS only) ──
    // The import + create-new EFFECT steps (import-scanning, p8-method-select,
    // verifying-key, verify-app, creating-certificate, etc.) are now
    // engine-driven (see the ios/flow.js engine + the effect drivers below).
    // The guided App Store Connect API-key helper is the one create-new effect
    // that stays inline here: it launches the precompiled macOS helper window,
    // captures the minted credentials, writes the .p8 to disk, and parks on the
    // asc-key-created success screen.
    if (step === 'asc-key-generating') {
      ;(async () => {
        try {
          // Launch the guided macOS helper; it streams stats to PostHog and
          // returns the captured credentials on its terminal result line. The
          // abort controller (aborted in this effect's cleanup) terminates the
          // helper window if the user quits the TUI, so the CLI doesn't hang.
          const abort = new AbortController()
          ascHelperAbortRef.current = abort
          const outcome = await runAscKeyHelper({ apikey, signal: abort.signal })
          if (cancelled)
            return
          if (!outcome.ok) {
            // The user picked "I'll create it manually" on the helper's intro
            // screen — not an error. Persist the choice (so resume doesn't
            // re-launch the helper) and route straight to the manual .p8
            // instructions.
            if (outcome.errorCode === 'USER_CHOSE_MANUAL') {
              await persistP8CreateMethod('manual')
              addLog('You chose to create the .p8 key manually.')
              setStep('api-key-instructions')
              return
            }
            const reason = outcome.errorCode === 'USER_CANCELLED'
              ? 'Guided key creation was cancelled.'
              : `Guided key creation failed (${outcome.errorCode}): ${outcome.message}`
            // Back to the fork so the user can retry, say "I have a .p8", or
            // create it by hand.
            handleError(new Error(reason), 'p8-source-select')
            return
          }
          const { credentials } = outcome
          // The helper window is still open on its success screen — hold its
          // close handle and dismiss it once verifying-key confirms the key (or
          // on unmount). Until then the user sees the "you're done, return to the
          // terminal" screen while the terminal advances here.
          ascHelperCloseRef.current = outcome.close
          // The helper also saved the .p8 to the fastlane/ASC conventional path.
          const helperP8Path = join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${credentials.keyId}.p8`)
          // Apple never re-issues the key, so don't rely solely on the helper's
          // best-effort copy: write the captured key to disk ourselves (0600) if
          // it isn't already there. This makes quit-and-resume safe — verifying-key
          // reads p8Path and always finds the file.
          try {
            if (!existsSync(helperP8Path)) {
              await mkdir(dirname(helperP8Path), { recursive: true })
              await writeFile(helperP8Path, credentials.privateKey, { mode: 0o600 })
            }
          }
          catch (err) {
            appendInternalLog(`could not write captured .p8 to ${helperP8Path}: ${err instanceof Error ? err.message : String(err)}`)
          }
          setP8Content(credentials.privateKey) // wrapper also updates p8ContentRef
          setKeyId(credentials.keyId)
          setIssuerId(credentials.issuerId)
          setP8Path(helperP8Path)
          // Persist all three (incl. p8Path) so a resume AFTER the key was
          // captured lands on verifying-key — not back on the helper re-run.
          await savePartialProgress({ keyId: credentials.keyId, issuerId: credentials.issuerId, p8Path: helperP8Path })
          if (cancelled)
            return
          addLog('✔ App Store Connect API key created via guided helper')
          // Show the big CLI success screen and WAIT there. The helper window
          // stays open (we hold its close handle); pressing Enter on the success
          // screen closes it and continues to verifying-key. We deliberately do
          // NOT auto-advance — the user controls the handoff.
          setStep('asc-key-created')
        }
        catch (err) {
          if (!cancelled)
            handleError(err, 'p8-source-select')
        }
        finally {
          // The run settled — drop our controller so the unmount-only cleanup
          // can't abort a stale, already-resolved controller.
          ascHelperAbortRef.current = null
        }
      })()
    }
    //
    // The import EFFECT steps (import-scanning, import-validating-all-certs,
    // import-checking-apple-cert, import-provide-profile-path,
    // import-create-profile-only, import-exporting) are
    // now engine-driven (IOS_ENGINE_IMPORT_EFFECT_STEPS) — see the import effect
    // driver below. The engine runs the Mac scans / Apple-side cert+profile
    // lookups / .mobileprovision parse / Keychain export the bespoke bodies used
    // to run inline here; the driver threads the ephemeral selections (chosen
    // identity/profile) from iosCarriedRef + mirrors importMatches /
    // importProfiles / identityAvailability / profilePrefetch / noMatchReason /
    // certData / profileData / importedP12Password back into React state, applies
    // redirectIfMismatch after import-scanning, and advances.

    // p8-method-select is now engine-driven (IOS_ENGINE_CREATE_EFFECT_STEPS) —
    // the engine opens the native .p8 picker (idempotent via carried.pickerOpened),
    // reads the bytes, persists {p8Path, extracted keyId}, threads the raw bytes
    // back in transient.p8Content, and routes to input-key-id (or input-p8-path on
    // cancel). The driver below mirrors p8Path/keyId/p8Content into React state.

    // verifying-key (BOTH the create-new and import paths) and verify-app (the
    // remote App Store Connect verification gate, PR #2397) are now
    // engine-driven (IOS_ENGINE_CREATE_EFFECT_STEPS) — see the create-new
    // effect driver below. The engine routes verifying-key → verify-app
    // (create-new + import app_store, with the import continuation
    // import-validating-all-certs / import-pick-identity riding
    // transient.pendingVerifyNext) / the import continuation directly (ad_hoc)
    // / import-create-profile-only (pendingRecoveryAction), then runs the
    // verify-app fetch (parallel listApps+listBundleIds), the FRESH bundle-id
    // re-detect, the classification and the persistVerifyOverride write. The
    // driver mirrors the verify* transient into the React render state, fires
    // the PostHog telemetry, and drives the PARKED gate's actions via
    // iosCarriedRef.verifyAction + the runVerifyGateAction resolver re-drive.

    // creating-certificate / revoking-certificate / creating-profile /
    // deleting-duplicate-profiles are now engine-driven
    // (IOS_ENGINE_CREATE_EFFECT_STEPS) — see the create-new effect driver below.
    // The engine generates the CSR + .p12, mints the cert (routing to
    // cert-limit-prompt on CertificateLimitError), registers the bundle id +
    // creates the profile (routing to duplicate-profile-prompt on
    // DuplicateProfileError, persisting duplicateProfileOrigin), revokes the
    // user-picked cert and retries, and deletes the duplicate profiles then
    // routes back to the persisted origin. The driver mirrors certData /
    // profileData / teamId / existingCerts / duplicateProfiles into React state.

    // saving-credentials / detecting-ci-secrets / checking-ci-secrets /
    // uploading-ci-secrets are now engine-driven (IOS_TAIL_DRIVER_STEPS) — see the
    // post-save TAIL driver below. saving-credentials builds + writes the iOS
    // credential map (reading the create-new payloads from iosCarriedRef + the
    // import payloads from React state), deletes progress.json, stashes the
    // CI-secret entries + raw credentials, and routes to ask-build. The CI-secret
    // detection / repo-resolution / upload + the with-workflow script preload all
    // run in the shared tail; the driver mirrors ciSecretEntries / ciSecretTargets /
    // ciSecretSetupAdvice / ciSecretRepoLabel / ciSecretExistingKeys /
    // ciSecretUploadSummary / availableScripts / recommendedScript + the chosen
    // target into React state.

    if (step === 'preview-workflow-file') {
      ;(() => {
        try {
          if (!buildScriptChoice)
            throw new Error('Internal error: no build script choice recorded.')
          // Generate proposed content for the diff. Pure function — calling
          // it twice (once here, once in writing-workflow-file) is fine.
          const proposed = generateWorkflow({
            appId,
            defaultPlatform: 'ios',
            packageManager: selectedPackageManager ?? normalizePackageManager(pm.pm),
            buildScript: buildScriptChoice,
            secretKeys: ciSecretEntries.map(entry => entry.key),
          })
          const absolutePath = resolve(process.cwd(), WORKFLOW_GEN_PATH)
          let existing = ''
          let isNew = true
          if (existsSync(absolutePath)) {
            try {
              existing = readFileSync(absolutePath, 'utf8')
              isNew = false
            }
            catch (err) {
              appendInternalLog(`workflow file not readable, treating as new: ${err instanceof Error ? err.message : String(err)}`)
              // Treat unreadable file as "new" — the writing step will surface
              // any real failure to the user.
            }
          }
          if (cancelled)
            return
          const diff = diffLines(existing, proposed.content)
          const telemetry = getWorkflowDiffTelemetry(diff, isNew)
          setPreviewExistingPath(absolutePath)
          setPreviewIsNew(isNew)
          setPreviewTelemetry(telemetry)
          setPreviewDiff(diff)
          trackWorkflowEvent('workflow-preview-prepared', { diff, isNew })
        }
        catch (err) {
          if (!cancelled) {
            addLog(`⚠ Failed to build workflow preview: ${err instanceof Error ? err.message : String(err)}`, 'yellow')
            setStep('build-complete')
          }
        }
      })()
    }

    // writing-workflow-file / exporting-env / overwrite-and-export-env /
    // requesting-build are now engine-driven (IOS_TAIL_DRIVER_STEPS) — see the
    // post-save TAIL driver below. The engine writes the workflow file (logging
    // Wrote/Overwrote + workflow-file-written telemetry), exports the .env
    // (routing the 'exists' branch to confirm-env-export-overwrite), and fires the
    // build request (streaming every line into the FullscreenBuildOutput pane via
    // the BuildLogger, routing a failed build with captured logs to
    // ai-analysis-prompt). The driver mirrors workflowFilePath / envExportPath /
    // envExportError / buildUrl / aiJobId into React state + applies the 150ms
    // writing-workflow-file settle.

    // AI analysis — entered only when requestBuildInternal returned with
    // aiAnalysis.ready=true. The captured log file is on disk; we call the
    // edge function, then transition to 'ai-analysis-result' which renders the
    // diagnosis (or a friendly fallback message) and waits for Enter.
    if (step === 'ai-analysis-running' && aiJobId) {
      ;(async () => {
        // Fire the Choice telemetry here (not in 'ai-analysis-prompt'): we only
        // know the user picked "Debug with AI" because we landed in `running`.
        await trackAiAnalysisChoice({
          apikey: resolvedApiKeyRef.current ?? apikey ?? '',
          orgId: resolvedOrgId ?? '',
          appId,
          platform: 'ios',
          jobId: aiJobId,
          choice: 'capgo_ai',
          triggeredBy: 'onboarding',
        }).catch(() => { /* telemetry never breaks the wizard */ })

        // Reset any stale preview from a previous attempt BEFORE streaming
        // starts — retries re-enter this step and must not flash old content.
        setAiStreamPreview('')
        // Stream the analysis into a throttled ANSI preview: each completed
        // markdown line is rendered (same renderer as the plain CLI) and the
        // accumulated text is flushed to state at most every 250ms.
        let streamedAnsi = ''
        let previewFlushTimer: ReturnType<typeof setTimeout> | null = null
        const mdStream = createStreamingMarkdownRenderer((t) => {
          streamedAnsi += t
          previewFlushTimer ??= setTimeout(() => {
            previewFlushTimer = null
            if (!cancelled)
              setAiStreamPreview(streamedAnsi)
          }, 250)
        }, true)

        const result = await runCapgoAiAnalysis({
          apiHost: supaHost ?? 'https://api.capgo.app',
          apikey: resolvedApiKeyRef.current ?? apikey ?? '',
          jobId: aiJobId,
          appId,
          onChunk: t => mdStream.feed(t),
        })

        // Publish the complete preview: flush renders the trailing partial
        // line (it may re-arm the publish timer via the write callback, so
        // flush FIRST, then cancel the timer, then set state once). The
        // result step replaces this in the same React batch; the reset at
        // the top of this block keeps retries clean.
        mdStream.flush()
        if (previewFlushTimer) {
          clearTimeout(previewFlushTimer)
          previewFlushTimer = null
        }
        if (!cancelled)
          setAiStreamPreview(streamedAnsi)

        if (cancelled)
          return

        const resultTag = aiAnalysisResultFromPostAnalyze(result)

        await trackAiAnalysisResult({
          apikey: resolvedApiKeyRef.current ?? apikey ?? '',
          orgId: resolvedOrgId ?? '',
          appId,
          platform: 'ios',
          jobId: aiJobId,
          result: resultTag,
          errorStatus: result.kind === 'error' ? result.status : undefined,
        }).catch(() => { /* telemetry never breaks the wizard */ })

        if (result.kind === 'ok') {
          // Render markdown to ANSI escapes; Ink <Text> passes them through.
          // Fall back to raw text if a future Ink version stops doing so.
          setAiAnalysisText(renderMarkdown(result.analysis, true))
          setAiResult(null)
        }
        else if (result.kind === 'already_analyzed') {
          setAiAnalysisText(null)
          setAiResult({ kind: 'already_analyzed', message: 'AI analysis was already requested for this build (only one per job).' })
        }
        else if (result.kind === 'too_big') {
          setAiAnalysisText(null)
          setAiResult({ kind: 'too_big', message: 'Build log is too large for Capgo AI (>10 MB). Try a local AI tool with the captured log.' })
        }
        else if (result.kind === 'upgrade_required') {
          setAiAnalysisText(null)
          setAiResult({ kind: 'error', message: result.message ?? 'AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest' })
        }
        else {
          setAiAnalysisText(null)
          const detail = [
            result.status ? `(status ${result.status})` : null,
            result.message,
          ].filter(Boolean).join(' ')
          setAiResult({
            kind: 'error',
            message: result.partial
              ? `AI analysis was interrupted${detail ? `: ${detail}` : ''}. The captured log is saved for local AI.`
              : `AI analysis failed${detail ? `: ${detail}` : ''}.`,
          })
        }
        setStep('ai-analysis-result')
      })()
    }

    if (step === 'build-complete') {
      setBuildOutput([])
      // Report a successful outcome + the durable summary to the shell/caller, so
      // it can reprint the build URL + generated file paths to the PRIMARY buffer
      // (the alt-screen final frame is wiped on exit). This is the ONLY place that
      // fires 'completed'; every other exit stays 'cancelled' by default.
      onResult?.({
        outcome: 'completed',
        summary: {
          buildUrl: buildUrl || undefined,
          ciSecretUploadSummary,
          workflowFilePath: workflowWrittenPath,
          envExportPath,
          buildRequestCommand,
        },
      })
      // Best-effort cleanup of any leftover captured log file. Safe to call
      // even if we never entered the AI flow (operates only on jobs we know).
      if (aiJobId) {
        void releaseCapturedLogs(aiJobId).catch(() => { /* best-effort */ })
      }
      // Do NOT auto-exit here. On the alt-screen, exit() restores the primary
      // buffer and wipes this success frame instantly — the user never gets to
      // read it. Stay rendered; a keypress (handled in useInput) exits, after
      // which command.ts reprints the durable summary to the primary buffer.
      return () => {
        cancelled = true
      }
    }

    return () => {
      cancelled = true
    }
  }, [step])

  // Kill the guided helper child ONLY when the whole onboarding unmounts (the
  // user quit / Ctrl+C) — NOT on every step transition. Aborting per-step could
  // tear down a still-running helper if the step ever churned; an unmount-scoped
  // cleanup fires once, at real exit, and otherwise leaves a live run alone.
  useEffect(() => {
    return () => {
      // Abort an in-flight run, AND close a helper window still open on its
      // success screen (resolved on the result line but not yet dismissed by
      // verifying-key). Either way the helper's pipes are released so the CLI
      // can exit instead of hanging.
      ascHelperAbortRef.current?.abort()
      ascHelperCloseRef.current?.()
    }
  }, [])

  // ─── Engine-driven create-new effect driver (ink-thin-wrapper, Stage 2) ─────
  // Route the create-new credential PROVISIONING effects through the shared iOS
  // engine's `runIosEffect` instead of the hand-rolled per-step bodies in the
  // useEffect above. The FLOW lives in the engine (ios/flow.ts, e2e-tested via
  // test/test-ios-e2e.mjs); the RENDERING stays ink (the same ios-* step
  // components). This mirrors the android engine-driver (android/ui/app.tsx) and
  // the headless e2e driver: build a single iosDeps wiring the REAL apple-api /
  // csr helpers (adapted from their JWT-token call shape to the engine's
  // abstracted dep shapes via getFreshToken), run the effect against the freshest
  // persisted progress, thread the returned transient into iosCarriedRef +
  // mirror it into the React render state, and advance to result.next.
  //
  // SCOPE (Stage 2 create-new fork): backing-up, p8-method-select, verifying-key
  // (create-new path only), creating-certificate, revoking-certificate,
  // creating-profile, deleting-duplicate-profiles. The CHOICE steps
  // (setup-method-select, cert-limit-prompt, duplicate-profile-prompt, the input
  // steps) stay on the bespoke setStep handlers (Stage 3 swaps the choice/input
  // routing). saving-credentials + the post-save tail are NOT routed here: the
  // shared tail's buildIosSavedCredentials omits the APPLE_KEY_* fields the
  // create-new app_store path writes via doSaveCredentials, so routing it would
  // drop credentials — that needs an engine change (see the report).
  //
  // The IMPORT effects (import-scanning, import-validating-all-certs,
  // import-checking-apple-cert, import-provide-profile-path,
  // import-create-profile-only, import-exporting) and
  // the import-mode verifying-key routing keep their bespoke bodies for now.
  useEffect(() => {
    // verifying-key is now FULLY engine-routed: the engine's `next` expresses
    // create-new + import app_store (→ verify-app, threading the import
    // continuation via transient.pendingVerifyNext), import ad_hoc (→ the
    // continuation directly) and pendingRecoveryAction (→
    // import-create-profile-only) — no import-side bespoke body remains.
    if (!IOS_ENGINE_CREATE_EFFECT_STEPS.has(step))
      return

    let cancelled = false

    void (async () => {
      // getFreshToken (the component's existing ASC JWT builder) adapts the raw
      // apple-api helpers — which take a JWT `token` — to the engine's abstracted
      // dep shapes. A NeedP8Error thrown here routes the user back to
      // api-key-instructions via handleError, exactly as the bespoke effects did.
      const deps: IosEffectDeps = {
        appId,
        onInternalLog: line => appendInternalLog(line),

        // ── apple-api (token-adapted) ──
        verifyApiKey: async () => {
          const r = await verifyApiKey(await getFreshToken())
          return { teamId: r.teamId }
        },
        createCertificate: async ({ csr }) => createCertificate(await getFreshToken(), csr),
        revokeCertificate: async (certificateId) => {
          await revokeCertificate(await getFreshToken(), certificateId)
        },
        createProfile: async ({ bundleId, certificateId }) => {
          const token = await getFreshToken()
          const { bundleIdResourceId } = await ensureBundleId(token, bundleId)
          const p = await createProfile(token, bundleIdResourceId, certificateId, bundleId)
          return {
            profileId: p.profileId,
            profileName: p.profileName,
            profileBase64: p.profileContent,
          }
        },
        deleteProfile: async (profileId) => {
          await deleteProfile(await getFreshToken(), profileId)
        },
        // Scoped to the DISTRIBUTION pool — same reasoning as createCertificate's
        // limit recovery: only same-type revocations free a slot.
        listCertificates: async () => listDistributionCerts(await getFreshToken(), { types: ['DISTRIBUTION'] }),

        // ── verify-app (remote App Store verification, PR #2397) ──
        listApps: async () => listApps(await getFreshToken()),
        listBundleIds: async () => listBundleIds(await getFreshToken()),
        // FRESH detection per check — bypasses the component-level `detectedIds`
        // memo so the Release id reflects any edit since the wizard started.
        detectBundleIds: () => detectIosBundleIds({ cwd: process.cwd(), iosDir, capacitorAppId: iosBundleIdInitial }),
        writeReleaseBundleId: (fromId, toId) => writeReleaseBundleId(process.cwd(), iosDir, fromId, toId),
        ensureBundleId: async (bundleId) => { await ensureBundleId(await getFreshToken(), bundleId) },
        openExternal: async (url) => { await open(url) },

        // ── csr (shape-adapted) ──
        generateCsr: () => {
          const r = generateCsr()
          return { csr: r.csrPem, privateKeyPem: r.privateKeyPem }
        },
        createP12: ({ certificatePem, privateKeyPem, password }) =>
          createP12(certificatePem, privateKeyPem, password).p12Base64,

        // ── file system + pickers ──
        readFile: async path => Buffer.from(await readFile(path)),
        copyFile,
        openP8FilePicker: openFilePicker,
        isMacOS,

        // ── persistence ──
        loadProgress,
        saveProgress,

        // ── carried transient (driver-held) — merged with the cert-limit /
        // duplicate-profile selections the bespoke choice handlers stash in React
        // state so the revoke / delete effects find their (ephemeral) inputs.
        carried: {
          ...iosCarriedRef.current,
          // verifying-key reads the raw .p8 bytes from carried — fall back to
          // the p8ContentRef mirror when the input chain collected them outside
          // the engine (the import path), exactly as the bespoke body did.
          ...(step === 'verifying-key' && !iosCarriedRef.current.p8Content && p8ContentRef.current
            ? { p8Content: Buffer.from(p8ContentRef.current) }
            : {}),
          // cert-limit-prompt's choice handler stores the picked cert id in
          // `certToRevoke` (React) against the `existingCerts` list; the revoke
          // effect only reads `.id`, so reconstruct the minimal cert object.
          ...(step === 'revoking-certificate' && certToRevoke
            ? { certToRevoke: existingCerts.find(c => c.id === certToRevoke) ?? { id: certToRevoke, name: '', serialNumber: '', expirationDate: '' } }
            : {}),
          // duplicate-profile-prompt's choice handler keeps the duplicate list in
          // React `duplicateProfiles`; thread it so the delete effect knows what
          // to delete.
          ...(step === 'deleting-duplicate-profiles' ? { duplicateProfiles } : {}),
        },

        onLog: (message, color) => {
          if (!cancelled)
            addLog(message, color)
        },
      }

      try {
        // Run against the freshest persisted progress — the prior input steps
        // persisted p8Path / keyId / issuerId before these auto steps run, so the
        // loaded progress carries the same values the bespoke effects read from
        // refs. Falls back to a fresh-progress skeleton when nothing is on disk.
        const current = (await loadProgress(appId)) ?? {
          platform: 'ios' as const,
          appId,
          startedAt: new Date().toISOString(),
          completedSteps: {},
        }
        if (cancelled)
          return
        // verify-app: surface the step loader while the initial ASC fetch runs.
        if (step === 'verify-app')
          setVerifyAppLoading(true)
        const result = await runIosEffect(step, current, deps)
        if (cancelled)
          return

        const t: Partial<IosStepCtx> | undefined = result.transient
        const np = result.progress

        // ── error route: surface through the TUI's handleError so the support
        // bundle + retryCount + telemetry UX is identical to the bespoke catch ──
        if (result.next === 'error') {
          handleErrorRef.current(new Error(t?.error ?? 'Onboarding failed.'), (t?.retryStep as OnboardingStep) ?? step)
          return
        }

        // ── merge engine transient into the carried ref (threaded into the next
        // effect) AND mirror it into the React render state downstream code reads ──
        if (t) {
          iosCarriedRef.current = { ...iosCarriedRef.current, ...t }
          if (t.certData !== undefined)
            setCertData(t.certData)
          if (t.profileData !== undefined)
            setProfileData(t.profileData)
          if (t.teamId !== undefined)
            setTeamId(t.teamId)
          if (t.p8Content !== undefined)
            setP8Content(t.p8Content.toString('utf-8'))
          // cert-limit branch: creating-certificate surfaces the existing certs to
          // offer for revocation (React `existingCerts` drives the prompt's list).
          if (t.existingCerts !== undefined)
            setExistingCerts(t.existingCerts)
          // duplicate branch: creating-profile surfaces the duplicate Capgo
          // profiles (React `duplicateProfiles` drives the prompt + delete count).
          if (t.duplicateProfiles !== undefined)
            setDuplicateProfiles(t.duplicateProfiles)
          // verify-app: mirror the engine's gate/picker transient into the
          // React render state (the verify-app render below reads these).
          if (t.verifyApps !== undefined)
            setVerifyApps(t.verifyApps)
          if (t.verifyRegisteredIds !== undefined)
            setVerifyRegisteredIds(t.verifyRegisteredIds)
          if (t.verifyReleaseBundleId !== undefined)
            setVerifyReleaseBundleId(t.verifyReleaseBundleId)
          if (t.verifyDebugBundleId !== undefined)
            setVerifyDebugBundleId(t.verifyDebugBundleId)
          if (t.verifyPath !== undefined)
            setVerifyPath(t.verifyPath)
          if (t.verifyChosenApp !== undefined)
            setVerifyChosenApp(t.verifyChosenApp)
          if (t.verifyAttempt !== undefined)
            setVerifyAttempt(t.verifyAttempt)
          if (t.verifyAskReopen !== undefined)
            setVerifyAskReopen(t.verifyAskReopen)
        }

        // ── p8-method-select picker effect: mirror the persisted p8Path/keyId so
        // the input steps + getFreshToken see them, exactly as the bespoke body did.
        if (step === 'p8-method-select') {
          if (np.p8Path)
            setP8Path(np.p8Path)
          if (np.keyId)
            setKeyId(np.keyId)
        }

        // creating-profile (engine) persists duplicateProfileOrigin='creating-profile'
        // when it routes to the duplicate prompt; mirror it so the React render +
        // the deleting-duplicate-profiles route agree.
        if (np.duplicateProfileOrigin)
          setDuplicateProfileOrigin(np.duplicateProfileOrigin)

        // revoking-certificate success clears the cert-limit selection, matching
        // the bespoke body (setCertToRevoke(null) + setExistingCerts([])).
        if (step === 'revoking-certificate') {
          setCertToRevoke(null)
          setExistingCerts([])
        }
        // deleting-duplicate-profiles success clears the duplicate list, matching
        // the bespoke body (setDuplicateProfiles([])).
        if (step === 'deleting-duplicate-profiles')
          setDuplicateProfiles([])

        // A successful provisioning step resets the retry counter, mirroring the
        // bespoke setRetryCount(0) at each create-new success point.
        if (step === 'verifying-key' || step === 'creating-certificate' || step === 'creating-profile')
          setRetryCount(0)

        // verify-app (initial fetch): clear the loader; an exact-match pass
        // persisted the verified Release id — mirror persistVerifyOverride's
        // React effects (wire it into Apple-side work + stop redirectIfMismatch
        // re-adopting) — and the classification drives the one-shot Shown +
        // Result (+ exact-match Passed) telemetry the bespoke effect fired.
        if (step === 'verify-app') {
          setVerifyAppLoading(false)
          if (np.iosBundleIdOverride && np.iosBundleIdOverride !== current.iosBundleIdOverride) {
            setIosBundleId(np.iosBundleIdOverride)
            setAppIdConfirmed(true)
          }
          if (t?.verifyResult) {
            const appCount = t.verifyApps?.length ?? 0
            const bundleIdCount = t.verifyRegisteredIds?.length ?? 0
            if (!verifyShownRef.current) {
              verifyShownRef.current = true
              trackVerifyEvent('iOS App Verify Shown', '🔍', {
                app_count: appCount,
                bundle_id_count: bundleIdCount,
                debug_release_differ: t.verifyDebugReleaseDiffer ?? false,
              })
            }
            trackVerifyEvent('iOS App Verify Result', '🔎', { result: t.verifyResult, app_count: appCount, bundle_id_count: bundleIdCount })
            if (t.verifyResult === 'exact-match')
              trackVerifyEvent('iOS App Verify Passed', '✅', { attempts: 0, path: 'exact-match' })
          }
        }

        // ── advance ──────────────────────────────────────────────────────────
        // The engine returns an explicit `next` for every effect step — including
        // verifying-key's verify-app detour (PR #2397), which the engine now
        // expresses itself (create-new + import app_store → 'verify-app' with
        // the import continuation riding transient.pendingVerifyNext into
        // iosCarriedRef; import ad_hoc → the continuation; pendingRecoveryAction
        // → import-create-profile-only, whose React mirror we clear here exactly
        // as the bespoke body did). redirectIfMismatch wraps the verifying-key
        // advance only to silently adopt the authoritative Release bundle id
        // when it differs from capacitor.config.appId (a SYNC FS read the
        // IO-free engine can't do) — never on the recovery resume, matching the
        // bespoke routing. verify-app returning next === 'verify-app' (the
        // PARKED gate) intentionally falls through the `advanceTo !== step`
        // guard so the render below drives the picker/gate. Every other step's
        // next is used verbatim.
        const next = result.next ?? getIosResumeStep(np)
        if (!next)
          return
        let advanceTo = next
        if (step === 'verifying-key') {
          // The key is confirmed and the flow is moving on — NOW dismiss the
          // guided helper window (if it's still open on its success screen).
          // No-op when the key didn't come from the helper (manual / resume).
          ascHelperCloseRef.current?.()
          ascHelperCloseRef.current = null
          if (next === 'import-create-profile-only')
            setPendingRecoveryAction(null)
          else
            advanceTo = redirectIfMismatch(next)
        }
        if (advanceTo !== step)
          setStep(advanceTo)
      }
      catch (err) {
        if (!cancelled)
          handleErrorRef.current(err, step)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ─── Engine-driven IMPORT effect driver (ink-thin-wrapper, Stage 3 slice C) ──
  // Route the IMPORT credential EFFECT steps (IOS_ENGINE_IMPORT_EFFECT_STEPS)
  // through the shared engine's `runIosEffect` instead of the hand-rolled per-step
  // bodies that used to live in the big bespoke effect above. The FLOW lives in
  // the engine (ios/flow.ts, e2e-tested via test/test-ios-import-*.mjs +
  // test-ios-e2e.mjs); the RENDERING stays ink (the same ImportScanningStep /
  // ImportPickIdentityStep / … components). Mirrors the create-new effect driver:
  // build the import deps wiring the REAL macos-signing / apple-api helpers
  // (token-adapted via getFreshToken; the classify pre-binds the single team-wide
  // cert fetch + SHA-1 index so the engine just maps identity → availability), run
  // the effect against the freshest persisted progress + the ephemeral selections
  // the choice handlers stash in iosCarriedRef, thread the engine transient back
  // into iosCarriedRef + mirror it into the React render state, and advance.
  useEffect(() => {
    if (!IOS_ENGINE_IMPORT_EFFECT_STEPS.has(step))
      return

    let cancelled = false

    void (async () => {
      // classifyCertAvailability pre-binds the single team-wide cert fetch + SHA-1
      // index (the bespoke import-validating-all-certs optimisation, app.tsx old
      // L1391): one /certificates download, M SHA-1 hashes, then N O(1) lookups —
      // NOT N re-downloads. Memoised so the engine's per-identity loop shares it.
      let certIndexPromise: Promise<Map<string, AscDistributionCert>> | null = null
      const getCertIndex = () => {
        if (!certIndexPromise) {
          certIndexPromise = (async () => {
            const token = await getFreshToken()
            const allCerts = await listDistributionCerts(token, { includeContent: true })
            const bySha1 = new Map<string, AscDistributionCert>()
            for (const cert of allCerts) {
              if (!cert.certificateContent)
                continue
              bySha1.set(computeCertSha1(cert.certificateContent), cert)
            }
            return bySha1
          })()
        }
        return certIndexPromise
      }

      const deps: IosEffectDeps = {
        appId,
        onInternalLog: line => appendInternalLog(line),

        // ── macos-signing (import-scanning + export) ──
        listSigningIdentities,
        scanProvisioningProfiles,
        exportP12FromKeychain,

        // ── apple-api (token-adapted, mirroring the bespoke import effects) ──
        // classifyCertAvailability resolves the identity's cert from the pre-built
        // SHA-1 index, then enriches via the apple-api classifier — byte-for-byte
        // the bespoke map[r.sha1] entry (old app.tsx L1417-1444).
        classifyCertAvailability: async (identity) => {
          const bySha1 = await getCertIndex()
          const cert = bySha1.get(identity.sha1.toLowerCase()) ?? null
          const classified = classifyCertAvailability({
            appleCertId: cert ? cert.id : null,
            lookupError: null,
          })
          return {
            available: classified.available,
            reason: classified.reason,
            reasonText: classified.reasonText,
            appleCertId: classified.appleCertId,
            ...(cert && classified.available
              ? {
                  appleCertName: cert.name,
                  appleCertExpirationDate: cert.expirationDate,
                  appleCertSerialNumber: cert.serialNumber,
                }
              : {}),
          }
        },
        listProfilesForCert: async certId => listProfilesForCert(await getFreshToken(), certId),
        findCertIdBySha1: async sha1 => findCertIdBySha1(await getFreshToken(), sha1),
        ensureBundleId: async (bundleId) => {
          await ensureBundleId(await getFreshToken(), bundleId)
        },
        createProfile: async ({ bundleId, certificateId }) => {
          const token = await getFreshToken()
          const { bundleIdResourceId } = await ensureBundleId(token, bundleId)
          const p = await createProfile(token, bundleIdResourceId, certificateId, bundleId)
          return {
            profileId: p.profileId,
            profileName: p.profileName,
            profileBase64: p.profileContent,
            expirationDate: p.expirationDate,
          } as ProfileData & { expirationDate?: string }
        },

        // ── mobileprovision-parser + file pickers ──
        // The engine reads the .mobileprovision bytes via deps.readFile then parses
        // them here — so wire the BUFFER variant (the path-based
        // parseMobileprovisionDetailed reads the file itself, which the engine has
        // already done at its IO boundary).
        parseMobileprovisionDetailed: bytes => parseMobileprovisionBufferDetailed(bytes),
        openProfilePicker: openMobileprovisionPicker,
        readFile: async path => Buffer.from(await readFile(path)),

        // ── persistence ──
        loadProgress,
        saveProgress,

        // ── carried transient (driver-held) — the choice handlers stash the
        // ephemeral picks (chosenIdentity / chosenProfile / noMatchReason /
        // profilePickerOpened) here so the import effects find
        // their inputs, exactly as the engine resolver contract expects.
        carried: {
          ...iosCarriedRef.current,
          // The import effects read chosenIdentity / chosenProfile from carried;
          // bridge the React mirrors in case a choice handler set the React state
          // but the carried ref hasn't been threaded yet (slice-C bridge).
          ...(chosenIdentity ? { chosenIdentity } : {}),
          ...(chosenProfile ? { chosenProfile } : {}),
          ...(importMatches.length > 0 ? { importMatches } : {}),
          ...(noMatchReason ? { noMatchReason } : {}),
          p8Content: iosCarriedRef.current.p8Content ?? (p8ContentRef.current ? Buffer.from(p8ContentRef.current) : undefined),
        },

        onLog: (message, color) => {
          if (!cancelled)
            addLog(message, color)
        },
      }

      try {
        const current = (await loadProgress(appId)) ?? {
          platform: 'ios' as const,
          appId,
          startedAt: new Date().toISOString(),
          completedSteps: {},
        }
        if (cancelled)
          return
        const result = await runIosEffect(step, current, deps)
        if (cancelled)
          return

        const t: Partial<IosStepCtx> | undefined = result.transient
        const np = result.progress

        // ── error route: surface through handleError so the support bundle +
        // retryCount + telemetry UX is identical to the bespoke catch ──
        if (result.next === 'error') {
          handleErrorRef.current(new Error(t?.error ?? 'Onboarding failed.'), (t?.retryStep as OnboardingStep) ?? step)
          return
        }

        // ── merge engine transient into iosCarriedRef + mirror into React state ──
        if (t) {
          iosCarriedRef.current = { ...iosCarriedRef.current, ...t }
          if (t.chosenProfile !== undefined)
            setChosenProfile(t.chosenProfile)
          if (t.certData !== undefined)
            setCertData(t.certData)
          if (t.profileData !== undefined)
            setProfileData(t.profileData)
          if (t.teamId !== undefined)
            setTeamId(t.teamId)
          if (t.importedP12Password !== undefined)
            setImportedP12Password(t.importedP12Password)
          // import-scanning surfaces the scanned matches + profiles; the picker +
          // the validating pass read the React mirrors.
          if (t.importProfiles !== undefined)
            setImportProfiles(t.importProfiles)
          // identityAvailability rides transient verbatim from validating-all-certs.
          if (t.identityAvailability !== undefined)
            setIdentityAvailability(t.identityAvailability)
          // noMatchReason rides transient from the pick / apple-cert-check / file-
          // picker steps; the recovery menu reads the React mirror.
          if (t.noMatchReason !== undefined)
            setNoMatchReason(t.noMatchReason as NoMatchReason)
          // The per-identity Apple cert id surfaced by import-checking-apple-cert.
          if (t._appleCertIdForChosen !== undefined)
            setAppleCertIdForChosen(t._appleCertIdForChosen)
          // import-create-profile-only routes to duplicate-profile-prompt with the
          // duplicate list; mirror it + the persisted origin so the shared prompt +
          // the deleting-duplicate-profiles route agree.
          if (t.duplicateProfiles !== undefined)
            setDuplicateProfiles(t.duplicateProfiles)
        }

        // ── importMatches mirror ──────────────────────────────────────────────
        // import-scanning (raw scan) + the apple-cert-check / file-picker / D2
        // steps (which INJECT synthesized profiles into the chosen identity's
        // match) emit the updated match list via transient.importMatches; mirror
        // it so the pickers render the freshest profiles.
        if (t?.importMatches !== undefined)
          setImportMatches(t.importMatches)

        // ── profilePrefetch mirror (validating-all-certs) ─────────────────────
        // The engine emits transient.profilePrefetch as Record<sha1, profiles[]>
        // (the synthesized Apple-side profiles per available identity). The React
        // picker reads TWO derived signals: (1) the per-identity status map
        // (profilePrefetch state) the Available table colours, and (2) the
        // injected profiles in importMatches that light the cell green. Reproduce
        // the bespoke parallel-prefetch outcome (old app.tsx L1508-1524): filter
        // each identity's profiles for THIS app+distribution; usable → inject +
        // 'available', none usable → 'unavailable'.
        if (t?.profilePrefetch !== undefined) {
          const prefetch = t.profilePrefetch
          const statusMap: Record<string, { kind: 'pending' | 'available' | 'unavailable' | 'timeout' | 'error' }> = {}
          const injections: Record<string, DiscoveredProfile[]> = {}
          for (const [sha1, profiles] of Object.entries(prefetch)) {
            const usableHere = filterProfilesForApp(profiles, iosBundleId, importDistribution)
            if (usableHere.length === 0) {
              statusMap[sha1] = { kind: 'unavailable' }
            }
            else {
              injections[sha1] = profiles
              statusMap[sha1] = { kind: 'available' }
            }
          }
          setProfilePrefetch(prev => ({ ...prev, ...statusMap }))
          if (Object.keys(injections).length > 0) {
            setImportMatches(prev => prev.map(m => injections[m.identity.sha1]
              ? { ...m, profiles: [...m.profiles, ...injections[m.identity.sha1]] }
              : m))
            // Thread the injected matches into the carried ref too so the next
            // resolver (import-pick-identity) sees the prefetched profiles.
            iosCarriedRef.current = {
              ...iosCarriedRef.current,
              importMatches: (iosCarriedRef.current.importMatches ?? importMatches).map(m => injections[m.identity.sha1]
                ? { ...m, profiles: [...m.profiles, ...injections[m.identity.sha1]] }
                : m),
            }
          }
        }

        // creating a profile via D2 can persist duplicateProfileOrigin; mirror it.
        if (np.duplicateProfileOrigin)
          setDuplicateProfileOrigin(np.duplicateProfileOrigin)

        // ── advance ──────────────────────────────────────────────────────────
        // import-scanning's engine `next` is getImportEntryStep(progress) — the
        // un-redirected import-entry target. The bespoke wrapped it in
        // redirectIfMismatch (the bundle-id resolution, a SYNC FS read the
        // IO-free engine can't do) so the import path silently adopts the
        // authoritative Release bundle id when config.appId and pbxproj disagree.
        // Re-apply it here for import-scanning; every other import effect's next
        // is used verbatim.
        const next = result.next ?? getIosResumeStep(np)
        if (!next)
          return
        const advanceTo = step === 'import-scanning' ? redirectIfMismatch(next) : next
        if (advanceTo !== step)
          setStep(advanceTo)
      }
      catch (err) {
        if (!cancelled)
          handleErrorRef.current(err, step)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ─── Engine-driven post-save TAIL driver (ink-thin-wrapper, Stage 3 slice A) ──
  // Delegate the post-save tail effect steps (IOS_TAIL_DRIVER_STEPS) to the shared
  // engine's `runIosEffect`, which routes them into the platform-neutral tail module
  // (via toTailDeps). The FLOW lives in the engine (tail/flow.ts, e2e-tested); the
  // RENDERING stays ink. Mirrors the android post-save tail driver
  // (android/ui/app.tsx). saving-credentials still finds the create-new payloads in
  // iosCarriedRef (mirrored by the create driver) and the import payloads in React
  // state (the import effects stay bespoke until slice C); the env/workflow/build
  // steps read the in-memory React tail inputs via a SYNTHETIC progress. The engine
  // NEVER re-creates progress.json here. ai-analysis-* + the fullscreen build/diff
  // takeovers stay ink-only; the requesting-build → ai-analysis-prompt handoff still
  // reaches the AI UI because the engine returns next: 'ai-analysis-prompt'.
  useEffect(() => {
    if (!IOS_TAIL_DRIVER_STEPS.has(step))
      return

    let cancelled = false
    const abort = new AbortController()

    void (async () => {
      // CLI-flag key takes precedence over the saved one (mirrors the bespoke tail's
      // `apikey ?? findSavedKeySilent()` at saving-credentials / requesting-build).
      const resolveCapgoKey = (): string | undefined => apikey ?? findSavedKeySilent()

      // Load the on-disk progress so the saving-credentials self-heal guard can
      // re-validate it (the engine re-loads internally too via deps.loadProgress).
      // For the later tail steps progress.json is already deleted, so this is null
      // and the SYNTHETIC progress below carries the in-memory tail inputs instead.
      const disk = await loadProgress(appId)
      if (cancelled)
        return
      const base: OnboardingProgress = disk ?? {
        platform: 'ios',
        appId,
        startedAt: new Date().toISOString(),
        completedSteps: {},
      }
      // SYNTHETIC progress: overlay the in-memory React tail inputs the engine reads
      // (setupMode / ciSecretTarget / selectedPackageManager / buildScriptChoice /
      // envExportTargetPath). For saving-credentials `disk` carries the create-new
      // completedSteps + setupMethod + importDistribution + iosBundleIdOverride; the
      // import path's cert/profile payloads ride deps.carried below.
      const tailProgress: OnboardingProgress = {
        ...base,
        setupMode,
        ciSecretTarget,
        selectedPackageManager: selectedPackageManager ?? normalizePackageManager(pm.pm),
        buildScriptChoice,
        envExportTargetPath,
      }

      const deps: IosEffectDeps = {
        appId,
        onInternalLog: line => appendInternalLog(line),

        // ── persistence (saving-credentials writes + deletes progress.json) ──
        loadProgress,
        saveProgress,
        deleteProgress,
        updateSavedCredentials,
        // Crash-recovery: buildIosSavedCredentials re-reads the .p8 from the
        // persisted p8Path when the carried key content was lost (restart) —
        // without this seam the resume's refuse guard fires even though the
        // key file is perfectly readable (hostile-review 2026-06-12).
        readFile: async path => Buffer.from(await readFile(path)),

        // ── tail helpers — pre-bind the resolved Capgo key into the entry builder
        // so CAPGO_TOKEN is included (mirrors createCiSecretEntries(creds, capgoKey)).
        createCiSecretEntries: creds => createCiSecretEntries(creds, resolveCapgoKey()),
        detectCiSecretTargets,
        getCiSecretRepoLabelAsync,
        listExistingCiSecretKeysAsync,
        uploadCiSecretsAsync,
        exportCredentialsToEnv,
        defaultExportPath,
        generateWorkflow,
        writeWorkflowFile,
        // Merge the --supa-host override into the build request options — the
        // shared tail builds the options itself (apikey/platform/caller-handled),
        // so the driver injects the gateway override here (parity with main's
        // bespoke requesting-build body).
        requestBuildInternal: (id, options, silent, logger) =>
          requestBuildInternal(id, { ...options, supaHost, builderJourneyId: journeyId }, silent, logger),

        // ── streaming / telemetry / preload sinks (forwarded into the shared tail) ──
        // The rich streaming BuildLogger requesting-build forwards into
        // requestBuildInternal (4th arg) — every build line streams into the
        // FullscreenBuildOutput pane via setBuildOutput, byte-for-byte the bespoke
        // logger (info/error/warn/success/buildLog sanitize/uploadProgress dedup/
        // customMsg → handleCustomMsg). Only requesting-build consumes it.
        logger: {
          info: (msg: string) => { if (!cancelled) setBuildOutput(prev => [...prev, msg]) },
          error: (msg: string) => { if (!cancelled) setBuildOutput(prev => [...prev, `✖ ${msg}`]) },
          warn: (msg: string) => { if (!cancelled) setBuildOutput(prev => [...prev, `⚠ ${msg}`]) },
          success: (msg: string) => { if (!cancelled) setBuildOutput(prev => [...prev, `✔ ${msg}`]) },
          buildLog: (msg: string) => { if (!cancelled) setBuildOutput(prev => [...prev, ...sanitizeBuildLogLines(msg)]) },
          uploadProgress: (percent: number) => {
            if (cancelled)
              return
            setBuildOutput((prev) => {
              const idx = prev.findIndex(l => l.startsWith('Uploading:'))
              const line = `Uploading: ${percent.toFixed(0)}%`
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = line
                return next
              }
              return [...prev, line]
            })
          },
          customMsg: async (kind: string, data: Record<string, unknown>) => {
            await handleCustomMsg(
              kind,
              data,
              (line: string) => { if (!cancelled) setBuildOutput(prev => [...prev, line]) },
              (line: string) => { if (!cancelled) setBuildOutput(prev => [...prev, line]) },
            )
          },
        },
        onBuildOutput: (line) => {
          if (!cancelled)
            setBuildOutput(prev => [...prev, line])
        },
        resolveApikey: resolveCapgoKey,
        onCiSecretUploadProgress: (current, total, keyName) => {
          if (!cancelled)
            setCiSecretUploadProgress({ current, total, key: keyName })
        },
        onCiSecretCheckPhase: (phase) => {
          if (!cancelled)
            setCiSecretCheckPhase(phase)
        },
        onCiSecretError: (message) => {
          if (!cancelled)
            setCiSecretError(message)
        },
        getPackageScripts,
        findProjectType,
        findBuildCommandForProjectType,
        trackWorkflowEvent: (event, options) => {
          trackWorkflowEvent(event as BuildOnboardingWorkflowEvent, options as { decision?: BuildOnboardingWorkflowDecision })
        },

        // ── carried transient (driver-held) — the create-new payloads live in
        // iosCarriedRef (mirrored by the create driver); the import path's
        // cert/profile/p12 + the .p8 bytes live in React state until slice C routes
        // the import effects, so thread BOTH so saving-credentials finds its inputs
        // on either path. The tail state (savedCredentials / ciSecretEntries /
        // ciSecretExistingKeys / workflowIsNew) is the in-memory React tail state.
        carried: {
          ...iosCarriedRef.current,
          certData: iosCarriedRef.current.certData ?? certData ?? undefined,
          profileData: iosCarriedRef.current.profileData ?? profileData ?? undefined,
          teamId: iosCarriedRef.current.teamId ?? teamId ?? undefined,
          p8Content: iosCarriedRef.current.p8Content ?? (p8ContentRef.current ? Buffer.from(p8ContentRef.current) : undefined),
          importedP12Password: iosCarriedRef.current.importedP12Password ?? (importedP12Password || undefined),
          savedCredentials: toCarriedSavedCredentials(savedCredentials),
          ciSecretEntries,
          ciSecretExistingKeys,
          workflowIsNew: previewIsNew,
        },

        onLog: (message, color) => {
          if (!cancelled)
            addLog(message, color)
        },
        signal: abort.signal,
      }

      // requesting-build resets the build VIEWER to empty BEFORE the engine streams
      // in, so the engine's appended header (onBuildOutput) reproduces the bespoke
      // `setBuildOutput([header])` REPLACE — wiping a prior build's output on the AI
      // retry re-entry instead of appending under it.
      if (step === 'requesting-build')
        setBuildOutput([])

      try {
        const result = await runIosEffect(step, tailProgress, deps)
        if (cancelled)
          return

        const t = result.transient
        const np = result.progress

        // ── Mirror engine transient → render state ─────────────────────────────
        if (t?.savedCredentials !== undefined)
          setSavedCredentials(t.savedCredentials)
        if (t?.ciSecretEntries !== undefined)
          setCiSecretEntries(t.ciSecretEntries)
        if (t?.ciSecretTargets !== undefined)
          setCiSecretTargets(t.ciSecretTargets)
        if (t?.ciSecretSetupAdvice !== undefined)
          setCiSecretSetupAdvice(t.ciSecretSetupAdvice)
        if (t?.ciSecretRepoLabel !== undefined)
          setCiSecretRepoLabel(t.ciSecretRepoLabel)
        if (t?.ciSecretExistingKeys !== undefined)
          setCiSecretExistingKeys(t.ciSecretExistingKeys)
        if (t?.ciSecretUploadSummary !== undefined)
          setCiSecretUploadSummary(t.ciSecretUploadSummary)
        if (t?.availableScripts !== undefined)
          setAvailableScripts(t.availableScripts)
        if (t?.recommendedScript !== undefined)
          setRecommendedScript(t.recommendedScript)
        // env-export results (exporting-env / overwrite-and-export-env).
        if (t?.envExportPath !== undefined)
          setEnvExportPath(t.envExportPath)
        if (t?.envExportError !== undefined)
          setEnvExportError(t.envExportError)
        // writing-workflow-file: the written path (transient.workflowFilePath →
        // setWorkflowWrittenPath). The engine already emitted the Wrote/Overwrote
        // log + workflow-file-written telemetry via onLog / trackWorkflowEvent.
        if (t?.workflowFilePath !== undefined)
          setWorkflowWrittenPath(t.workflowFilePath)
        // requesting-build: the queued build URL + the captured AI-analysis job id
        // surfaced on a failed build (transient.aiJobId → the ai-analysis-* sub-flow).
        if (t?.buildUrl !== undefined)
          setBuildUrl(t.buildUrl)
        if (t?.aiJobId !== undefined)
          setAiJobId(t.aiJobId)
        // The chosen CI-secret target rides on the RETURNED progress (the engine sets
        // it when detecting resolves a single target); mirror it into React state.
        if (np.ciSecretTarget !== undefined && np.ciSecretTarget !== null)
          setCiSecretTarget(np.ciSecretTarget)
        // exporting-env 'exists' carries the resolved export path forward on the
        // RETURNED progress so overwrite-and-export-env can write to it.
        if (np.envExportTargetPath !== undefined && np.envExportTargetPath !== envExportTargetPath)
          setEnvExportTargetPath(np.envExportTargetPath)
        // The upload progress bar is cleared by uploading-ci-secrets completing.
        if (step === 'uploading-ci-secrets')
          setCiSecretUploadProgress(null)
        // The shared tail engine routes a CI-secret check/upload failure to
        // ci-secrets-failed on its SUCCESS path (it RETURNS the failure route +
        // transient.ciSecretError rather than throwing — tail/flow.ts checking-
        // ci-secrets). ci-secrets-failed renders `error={ciSecretError}`, so
        // mirror the engine transient into React state or the screen shows a
        // blank reason. (The catch branch below covers the THROW path.)
        if (t?.ciSecretError !== undefined)
          setCiSecretError(t.ciSecretError)
        // requesting-build surfaces a non-throwing build-request failure via
        // transient.error (tail/flow.ts requesting-build catch → build-complete).
        // Mirror it to React error state for parity with the bespoke setError
        // path; the reason is also already streamed into the build viewer.
        if (t?.error !== undefined)
          setError(t.error)

        // ── Advance ────────────────────────────────────────────────────────────
        // writing-workflow-file keeps the bespoke 150ms settle before advancing to
        // build-complete (a driver concern — the engine returns next immediately).
        if (result.next && result.next !== step) {
          if (step === 'writing-workflow-file') {
            const next = result.next
            setTimeout(() => {
              if (!cancelled)
                setStep(next)
            }, 150)
          }
          else {
            setStep(result.next)
          }
        }
      }
      catch (err) {
        if (cancelled)
          return
        // Step-aware error routing — match each bespoke tail handler's catch EXACTLY.
        // The shared engine wraps checking-ci-secrets / exporting-env /
        // overwrite-and-export-env / requesting-build internally (returns a failure
        // route, never throws), but detecting-ci-secrets / uploading-ci-secrets /
        // writing-workflow-file can still throw OUT of the engine, so the driver
        // reproduces the bespoke recovery for those here. Credentials are already
        // saved on every post-save tail step, so only saving-credentials uses
        // handleError.
        const message = err instanceof Error ? err.message : String(err)
        if (step === 'saving-credentials') {
          handleErrorRef.current(err, 'saving-credentials')
        }
        else if (step === 'requesting-build') {
          // The engine catches build-request throws internally (→ build-complete),
          // so this is defensive parity with the bespoke catch.
          setBuildOutput(prev => [...prev, `⚠ ${message}`])
          setBuildOutput(prev => [...prev, `Your credentials are saved. Run \`${buildRequestCommand}\` to try again.`])
          setStep('build-complete')
        }
        else if (step === 'exporting-env' || step === 'overwrite-and-export-env') {
          setEnvExportError(message)
          setStep('build-complete')
        }
        else if (step === 'writing-workflow-file') {
          addLog(`⚠ Failed to write workflow file: ${message}`, 'yellow')
          setTimeout(() => {
            if (!cancelled)
              setStep('build-complete')
          }, 150)
        }
        else {
          // detecting-ci-secrets / checking-ci-secrets / uploading-ci-secrets
          setCiSecretError(message)
          setStep('ci-secrets-failed')
        }
      }
    })()

    return () => {
      cancelled = true
      abort.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Spinner-frame ticker for the in-flight profile prefetch cells. Runs only
  // while at least one entry in profilePrefetch is `pending`; the cleanup
  // function clears the interval the instant the last row resolves, AND on
  // unmount. setSpinnerFrame uses a functional update so we don't need to
  // re-establish the effect when the frame index changes.
  useEffect(() => {
    const anyPending = Object.values(profilePrefetch).some(p => p.kind === 'pending')
    if (!anyPending)
      return
    const id = setInterval(() => {
      setSpinnerFrame(prev => (prev + 1) % SPINNER_FRAMES.length)
    }, 100)
    return () => clearInterval(id)
  }, [profilePrefetch])

  // Route between the inline AI-result render and the scrollable fullscreen
  // viewer based on the LIVE terminal size — BIDIRECTIONALLY. Depends on the
  // terminal dimensions so it re-evaluates on resize: shrinking past the inline
  // budget opens the viewer, and growing back so it fits again returns to the
  // inline render. (Previously this was one-way — once the viewer opened it
  // never went back, leaving the user stuck in the scroll view with empty
  // space after enlarging the window.) `resolveAiResultRoute` is the single
  // source of truth, driven by one predicate so it can't oscillate.
  useEffect(() => {
    if (step !== 'ai-analysis-result' && step !== 'ai-analysis-result-scroll')
      return
    const next = resolveAiResultRoute({
      current: step,
      text: aiAnalysisText,
      viewedFull: aiViewedFull,
      terminalRows,
      terminalCols,
    })
    if (next)
      setStep(next)
  }, [step, aiAnalysisText, aiViewedFull, terminalRows, terminalCols])

  // Reset the error-viewer "dismissed" pin whenever we leave the error step, so
  // a NEW error re-opens the scrollable viewer. While on the error step it
  // persists, so dismissing the viewer keeps the compact form across resizes.
  useEffect(() => {
    if (step !== 'error')
      setErrorViewedFull(false)
  }, [step])

  // ── Render ──

  const progress = STEP_PROGRESS[step] ?? 0
  const phaseLabel = getPhaseLabel(step)
  // Header is a normal conditional: visible on every interactive step
  // including the AI sub-flow; hidden on `requesting-build`, the scrollable
  // AI viewer, and the fullscreen workflow diff (those want the full
  // viewport). Whether it renders as the bordered box or the one-line form is
  // decided by `headerCompact` above, from the measured body height vs the
  // live terminal height.
  const isAiResultScroll = step === 'ai-analysis-result-scroll'
  const isAiStep = step === 'ai-analysis-prompt' || step === 'ai-analysis-running' || step === 'ai-analysis-result' || isAiResultScroll
  // Tall fullscreen-style steps from the post-build GitHub Actions / .env
  // export flow. They run WITHOUT Progress + Logs so transitions don't flash
  // chrome in and out and leftover content from a previous tall step doesn't
  // bleed into the next short step's live area.
  const tallStep = step === 'detecting-ci-secrets'
    || step === 'checking-ci-secrets'
    || step === 'ask-github-actions-setup'
    || step === 'confirm-secrets-push'
    || step === 'uploading-ci-secrets'
    || step === 'ci-secrets-target-select'
    || step === 'ci-secrets-setup'
    || step === 'ask-ci-secrets'
    || step === 'pick-package-manager'
    || step === 'pick-build-script'
    || step === 'pick-build-script-custom'
    || step === 'preview-workflow-file'
    || step === 'view-workflow-diff'
    || step === 'writing-workflow-file'
    || step === 'ask-export-env'
    || step === 'exporting-env'
    || step === 'confirm-env-export-overwrite'
    || step === 'overwrite-and-export-env'
    || step === 'ci-secrets-failed'
    || step === 'confirm-ci-secret-overwrite'
  const showHeader = step !== 'requesting-build' && step !== 'view-workflow-diff' && !isAiResultScroll
  const showProgress = step !== 'welcome' && step !== 'platform-select' && step !== 'adding-platform' && step !== 'no-platform' && step !== 'error' && step !== 'build-complete' && step !== 'asc-key-created' && step !== 'requesting-build' && step !== 'ai-analysis-result' && step !== 'support-confirm' && step !== 'support-log-view' && step !== 'support-uploading' && !isAiResultScroll && !tallStep
  const showLog = step !== 'requesting-build' && step !== 'build-complete' && step !== 'asc-key-created' && !isAiStep && !tallStep
  const recoveryAdvice = error
    ? getBuildOnboardingRecoveryAdvice(error, retryStep, pm.runner, appId)
    : null
  // The iOS error screen's recovery advice is unbounded (42–54 rows). Like the
  // AI analysis + build log, it routes through the scrollable FullscreenAiViewer
  // when it's taller than the viewport, so the Try again / Restart / Exit actions
  // (rendered by the compact ErrorStep after the viewer is dismissed) are never
  // pushed off-screen. The decision uses a STRUCTURAL estimate of the comfortable
  // ErrorStep body (NOT measureElement — measuring the rendered body would
  // feedback-loop: the collapsed body measures short → "fits" → renders full →
  // measures tall → collapses again, forever). ERROR_FRAME_CHROME_ROWS is the
  // fixed header + log + padding reserve, calibrated against the VT harness at
  // ~15 rows for the boxed header; the compact-header case is shorter, so this
  // errs toward scroll — never toward a clip. `errorViewedFull` pins the compact
  // inline form once the user dismisses the viewer (mirrors aiViewedFull).
  const ERROR_FRAME_CHROME_ROWS = 15
  const errorViewerLines = error ? formatErrorViewerLines(error, recoveryAdvice, supportBundlePath) : []
  const errorTooTall = step === 'error' && !!error
    && estimateErrorBodyRows(error, recoveryAdvice, supportBundlePath, terminalCols, !!retryStep, !!aiJobId, offerGuidedKeyFallback) + ERROR_FRAME_CHROME_ROWS > terminalRows
  const isErrorScroll = errorTooTall && !errorViewedFull

  // The streaming build output is a fullscreen takeover too — same reasoning as
  // the AI viewer below. Rendered inside the measured body, its unbounded growth
  // inflated bodyHeight and tripped `tooSmall`, replacing a live build with a
  // resize prompt on a perfectly usable terminal. As an early return it
  // auto-tails inside a viewport that always fits, so the build phase never
  // reports "terminal too small". (Must precede the `tooSmall` guard.)
  if (step === 'requesting-build')
    return <FullscreenBuildOutput title="Building..." lines={buildOutput} terminalRows={terminalRows} />

  // Size gate (resize-reactive): below the enforced floor, render the resize
  // prompt from THIS mounted component so all in-progress state (current step,
  // entered values) is preserved — a shrink shows the prompt, a re-grow shows
  // the exact same step. It's an early return after all hooks (rules of hooks
  // hold). Crucially this does NOT unmount the app: gating at the shell instead
  // would tear the app down on resize and fire its exit/teardown effects (the
  // "onboarding complete" flash + quit). The startup gate guarantees the floor
  // before mount; this keeps it guaranteed across mid-flow resizes.
  if (!terminalFitsOnboarding(terminalCols, terminalRows, 'ios'))
    return <TerminalTooSmallPrompt cols={terminalCols} rows={terminalRows} minRows={IOS_MIN_ROWS} />

  // (The wizard never clips on a too-small terminal: the gate above replaces it
  // with the resize prompt instead.)

  // The fullscreen AI viewer is a takeover: render it as an EARLY RETURN so it
  // owns the whole terminal and bypasses the regular wizard frame above. It
  // fills the screen itself via minHeight.
  if (isAiResultScroll && aiAnalysisText) {
    return (
      <FullscreenAiViewer
        title="AI analysis"
        subtitle={`${aiAnalysisText.split('\n').length} lines — scrollable because the analysis is taller than your terminal`}
        lines={aiAnalysisText.split('\n')}
        terminalRows={terminalRows}
        onExit={() => {
          setAiViewedFull(true)
          setStep('ai-analysis-result')
        }}
      />
    )
  }

  // "View logs first" from the support confirm — a scrollable takeover of the
  // exact bundle that will be sent (secrets already redacted). Exit returns to
  // the confirm so the user can then send or cancel.
  if (step === 'support-log-view') {
    return (
      <FullscreenAiViewer
        title="Logs that will be sent to Capgo support"
        subtitle={`${supportLogLines.length} lines — secrets are already removed.`}
        lines={supportLogLines}
        terminalRows={terminalRows}
        exitHint="Press Esc or Enter to go back to the send / cancel prompt."
        onExit={() => setStep('support-confirm')}
      />
    )
  }

  // The iOS error screen is a fullscreen scroll takeover when its recovery
  // advice is taller than the viewport — same treatment as the AI viewer above,
  // so the Try again / Restart / Exit actions (in the compact ErrorStep shown
  // after dismiss) are never pushed off-screen. Placed after the size gate like
  // the AI viewer: below the floor the resize prompt wins.
  if (isErrorScroll && error) {
    return (
      <FullscreenAiViewer
        title="Build error"
        subtitle={`${errorViewerLines.length} lines — scrollable because the error details are taller than your terminal`}
        lines={errorViewerLines}
        terminalRows={terminalRows}
        onExit={() => setErrorViewedFull(true)}
      />
    )
  }

  // The workflow-file diff is a fullscreen takeover too (same reasoning as the
  // AI/build viewers): rendered inside the wizard Box it inherited the header +
  // padding (a large top gap) and a too-short viewport. As an early return it
  // owns the whole terminal and fills it.
  if (step === 'view-workflow-diff' && previewDiff.length > 0) {
    return (
      <FullscreenDiffViewer
        title={previewIsNew
          ? `🆕  Proposed new file — ${previewExistingPath ?? WORKFLOW_PATH}`
          : `✏️  Proposed changes — ${previewExistingPath ?? WORKFLOW_PATH}`}
        subtitle={previewIsNew
          ? 'Nothing exists on disk yet. Every line below is what would be written.'
          : 'Proposed diff vs the file on disk. Lines marked - would be removed, lines marked + would be added.'}
        lines={previewDiff}
        terminalRows={terminalRows}
        onExit={() => {
          trackWorkflowEvent('workflow-diff-closed', { decision: 'close' })
          setStep('preview-workflow-file')
        }}
      />
    )
  }

  // Full-screen celebration takeover: the guided helper created + validated the
  // key. Render ONLY the header + the centered success screen — no progress bar,
  // no completed-steps log, no chrome — so it reads as a clean "done!" moment
  // (like the platform picker). Enter closes the helper and continues.
  if (step === 'asc-key-created') {
    return (
      <Box flexDirection="column" minHeight={terminalRows} padding={1}>
        {showHeader && <Header compact={headerCompact} />}
        <AscKeyCreatedStep
          keyId={keyId}
          onContinue={() => {
            ascHelperCloseRef.current?.()
            ascHelperCloseRef.current = null
            setStep('verifying-key')
          }}
        />
      </Box>
    )
  }

  // `minHeight={terminalRows}` makes the root fill the whole viewport. Ink
  // only does a full clear-the-screen redraw when the frame height is ≥ the
  // terminal height; for shorter frames it uses an incremental cursor-up
  // redraw whose line math breaks after the terminal SHRINKS, leaving stale
  // rows from the previous (taller) frame on screen. Filling the viewport
  // forces the full-clear path on every frame, so resizing down never leaves
  // ghost content behind.
  return (
    <Box flexDirection="column" minHeight={terminalRows} padding={1}>
      {showHeader && <Header compact={headerCompact} />}
      {/* Banner stays pinned to the top; this flex spacer pushes the rest (log +
          step body) to the bottom of the viewport. On a tight terminal it
          collapses to zero (content fills the height), so the frame-fit contract
          is unaffected; on a tall terminal it absorbs the extra rows, and since
          both the banner (top) and the content (bottom) are anchored, neither
          jumps as the step's content height changes between steps. */}
      <Box flexGrow={1} />
      {/* Completed-steps log — rendered OUTSIDE the measured body so its growth
          can't inflate the dense / fit decision. Capped (see logMaxRows) to the
          rows the current step leaves; CompletedStepsLog drops its leading gap
          when it collapses to a single line so no orphaned blank survives. */}
      {showLog && <CompletedStepsLog entries={log} maxRows={logMaxRows} />}
      {/* Body: the current step (+ its progress bar). Measured via `bodyRef` to
          drive the dense / box-vs-compact-header / too-small decisions. The log
          above is excluded so the body height stays independent of how many
          steps have completed. */}
      <Box flexDirection="column" ref={bodyRef}>
        {/* Progress bar */}
        {showProgress && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">{phaseLabel}</Text>
            <Box marginTop={1}>
              <ProgressBar value={progress} />
              <Text dimColor>
                {' '}
                {progress}
                %
              </Text>
            </Box>
            <Divider />
          </Box>
        )}

        {/* Resume-or-restart prompt — only reachable when initialProgress is
          non-null AND getResumeStep didn't resolve to 'welcome'. The initial
          step useState above wires this branch. */}
        {step === 'resume-prompt' && initialProgress && (() => {
          const { startedAt, setupMethod, importDistribution: savedDist, completedSteps, iosBundleIdOverride } = initialProgress
          // Defensive date parse: legacy / corrupted progress files can carry an
          // unparseable startedAt — show the raw string with a dim suffix instead
          // of crashing the wizard.
          let whenLabel: string
          try {
            const d = new Date(startedAt)
            if (Number.isNaN(d.getTime()))
              throw new Error('NaN')
            whenLabel = d.toLocaleString()
          }
          catch {
            whenLabel = `${startedAt} (could not parse)`
          }
          const setupLabel = setupMethod === 'import-existing'
            ? 'Import existing credentials'
            : 'Create new via Apple'
          const distLabel = savedDist === 'app_store'
            ? 'App Store'
            : savedDist === 'ad_hoc' ? 'Ad Hoc' : null
          const keyVerified = Boolean(completedSteps.apiKeyVerified)
          const certCreated = Boolean(completedSteps.certificateCreated)
          const profileCreated = Boolean(completedSteps.profileCreated)
          const showBundleOverride = Boolean(
            iosBundleIdOverride && iosBundleIdOverride !== iosBundleIdInitial,
          )
          const resumeLabel = getPhaseLabel(startStep) || startStep
          return (
            <Box flexDirection="column" marginTop={1} gap={1}>
              <Text bold color="cyan">{`↩️  Found in-progress onboarding for ${appId}`}</Text>
              <Text>Pick up where you left off, or start over from the welcome step.</Text>
              <Box flexDirection="column">
                <Text>{`•  Started: ${whenLabel}`}</Text>
                <Text>{`•  Setup method: ${setupLabel}`}</Text>
                {distLabel && <Text>{`•  Distribution mode: ${distLabel}`}</Text>}
                <Text>{`•  ASC API key verified: ${keyVerified ? `Yes (Key: ${completedSteps.apiKeyVerified!.keyId})` : 'No'}`}</Text>
                <Text>{`•  Certificate created: ${certCreated ? `Yes (expires ${completedSteps.certificateCreated!.expirationDate})` : 'No'}`}</Text>
                <Text>{`•  Profile created: ${profileCreated ? `Yes ("${completedSteps.profileCreated!.profileName}")` : 'No'}`}</Text>
                {showBundleOverride && <Text>{`•  Confirmed iOS bundle id: ${iosBundleIdOverride}`}</Text>}
                <Text dimColor>{`•  Resume target: ${resumeLabel}`}</Text>
              </Box>
              <Select
                options={[
                  { label: '▶️  Continue from where I left off', value: 'continue' },
                  { label: '🔄  Restart onboarding (wipe saved progress)', value: 'restart' },
                ]}
                onChange={async (value) => {
                // Record which branch the user took. The funnel already shows
                // the resume-prompt step + the next step (welcome on restart,
                // the resume target on continue), but the explicit choice tag
                // gives a clean continue-vs-restart split without inferring it.
                  trackAction('resume_prompt_decision', { choice: value })
                  if (value === 'continue') {
                  // Now that the user has committed to picking up where
                  // they left off, replay the breadcrumb log so they see
                  // the in-progress state they're resuming into. Held
                  // back at mount so the resume-prompt screen itself
                  // wasn't surrounded by stale "Distribution · ad_hoc",
                  // "Key file selected · …" entries while they were
                  // still deciding.
                    hydrateCompletedLog()
                    setStep(startStep)
                    return
                  }
                  await resetForFreshStart()
                  addLog('↩️  Restarted — fresh start', 'yellow')
                  setStep('welcome')
                }}
              />
            </Box>
          )
        })()}

        {/* Welcome */}
        {step === 'welcome' && <WelcomeStep />}

        {/* Platform select */}
        {step === 'platform-select' && (
          <PlatformSelectStep
            appId={appId}
            dense={dense}
            onChange={async (value) => {
              if (value === 'android') {
              // The Android flow lives in a separate Ink app — this iOS app
              // can't host it inline. Exit cleanly and tell the user to
              // re-run with --platform android.
                addLog('Re-run with `npx @capgo/cli@latest build init --platform android` to set up Android.', 'cyan')
                exitOnboarding()
                return
              }
              // Check for existing credentials before proceeding
              const existing = await loadSavedCredentials(appId)
              if (existing?.ios) {
                setStep('credentials-exist')
              }
              else if (isMacOS()) {
              // macOS users see the fork: import existing or create new
                setStep('setup-method-select')
              }
              else {
              // Non-macOS hosts can only create new (importing requires Keychain)
                setStep('api-key-instructions')
              }
            }}
          />
        )}

        {/* No platform directory */}
        {step === 'no-platform' && (
          <NoPlatformStep
            iosDir={iosDir}
            addIosCommand={addIosCommand}
            syncIosCommand={syncIosCommand}
            dense={dense}
            onChange={(value) => {
              if (value === 'run') {
                setStep('adding-platform')
              }
              else if (value === 'recheck') {
                if (existsSync(join(process.cwd(), iosDir))) {
                  addLog(`✔ Found ${iosDir}/ — resuming onboarding.`)
                  ;(async () => {
                    const existing = await loadSavedCredentials(appId)
                    if (existing?.ios)
                      setStep('credentials-exist')
                    else
                      setStep('api-key-instructions')
                  })()
                }
                else {
                  addLog(`⚠ ${iosDir}/ is still missing. Try ${addIosCommand} or ${doctorCommand}.`, 'yellow')
                }
              }
              else {
                addLog(`Exiting. Run \`${buildInitCommand}\` after the native iOS folder exists.`, 'yellow')
                exitOnboarding()
              }
            }}
          />
        )}

        {step === 'adding-platform' && (
          <AddingPlatformStep addIosCommand={addIosCommand} doctorCommand={doctorCommand} dense={dense} />
        )}

        {/* Existing credentials warning */}
        {step === 'credentials-exist' && (
          <CredentialsExistStep
            appId={appId}
            dense={dense}
            onChange={(value) => {
              if (value === 'backup') {
                setStep('backing-up')
              }
              else {
                addLog('Exiting onboarding.', 'yellow')
                exitOnboarding()
              }
            }}
          />
        )}

        {/* Backing up credentials */}
        {step === 'backing-up' && <BackingUpStep />}

        {/* Setup-method fork (macOS only) */}
        {step === 'setup-method-select' && (
          <SetupMethodSelectStep
            dense={dense}
            onChange={async (value) => {
            // Persist the fork choice to progress so resume after CLI close
            // routes to the right path. Without this, an interrupted import
            // run resumes into the create-new path's `creating-certificate`
            // step and triggers the cert-limit error. applyIosInput records
            // setupMethod ('import-existing' | 'create-new') exactly as the
            // bespoke `existing.setupMethod = …` did.
            const existing = await loadProgress(appId) || {
              platform: 'ios' as const,
              appId,
              startedAt: new Date().toISOString(),
              completedSteps: {},
            }
            // Re-entering the create fork clears any prior .p8 source choice so
            // quitting before re-choosing doesn't resume onto a path the user
            // has since left (guided helper vs manual instructions).
            const reduced = {
              ...applyIosInput('setup-method-select', existing, { step: 'setup-method-select', value }),
              p8CreateMethod: value === 'import' ? existing.p8CreateMethod : undefined,
            }
            await saveProgress(appId, reduced)

            // Keep the React `importMode` mirror in sync (read by the
            // create-new effect driver's verifying-key guard + saving-credentials).
            if (value === 'import') {
              setImportMode(true)
              // DIVERGE: the bespoke jumps STRAIGHT to the silent import-scanning
              // discovery, which is NOT a resume target (getIosResumeStep with no
              // importDistribution yet collapses onto import-distribution-mode).
              // The driver runs import-scanning as a navigation gate, so keep the
              // explicit setStep here (matches the routing test's DIVERGE class).
              setStep('import-scanning')
            }
            else {
              setImportMode(false)
              // Only ask "do you already have a .p8?" when answering it actually
              // changes the path — i.e. when the guided macOS helper is available
              // to offer. Otherwise both answers funnel to the same manual
              // instructions, so skip straight there (the pre-fork behaviour on
              // every non-automatable host: non-macOS, or macOS without the binary).
              if (guidedHelperUsable)
                setStep('p8-source-select')
              else
                setStep('api-key-instructions')
            }
          }}
        />
      )}

        {/* Do you already have a .p8 file? */}
        {step === 'p8-source-select' && (
          <P8SourceSelectStep
            dense={dense}
            canAutomate={guidedHelperUsable}
            onChange={async (value) => {
              if (value === 'have') {
                await persistP8CreateMethod('manual')
                setStep('api-key-instructions')
              }
              else if (guidedHelperUsable) {
              // No key yet, and we can drive the guided helper — launch it right
              // away. Its own intro/consent screen explains the safety model and
              // offers manual creation, so there's no separate TUI question. We
              // persist 'automated' so a quit-and-resume re-launches the helper;
              // if the user picks "manual" inside it, the helper returns
              // USER_CHOSE_MANUAL and the asc-key-generating effect re-routes to
              // the manual instructions (and re-persists 'manual').
                await persistP8CreateMethod('automated')
                setStep('asc-key-generating')
              }
              else {
              // No automation available — fall back to the manual instructions.
                await persistP8CreateMethod('manual')
                setStep('api-key-instructions')
              }
            }}
          />
        )}

        {/* Guided helper is running in its own window */}
        {step === 'asc-key-generating' && <AscKeyGeneratingStep />}
        {/* asc-key-created renders as a full-screen takeover above (early return). */}

        {/* Import: scanning */}
        {step === 'import-scanning' && <ImportScanningStep />}

        {/* Verify the App Store Connect app exists for the Release build id.
          app_store mode only; reached after verifying-key. The single
          invariant: an ASC app exists whose bundleId
          == the Release PRODUCT_BUNDLE_IDENTIFIER. The exact-match and
          fetch-failure cases are handled in the effect above (they transition
          straight through); this render only drives the picker + the two
          resolution-path gates. */}
        {step === 'verify-app' && (
          <Box flexDirection="column">
            {verifyDebugBundleId && verifyReleaseBundleId
              ? (
                  <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
                    <Text bold color="yellow">{'⚠  Debug and Release use different bundle IDs'}</Text>
                    <Text>
                      {'Debug builds '}
                      <Text bold>{verifyDebugBundleId}</Text>
                      {'   ·   Release builds '}
                      <Text bold color="cyan">{verifyReleaseBundleId}</Text>
                    </Text>
                    <Text>
                      {'Capgo Builder signs the '}
                      <Text bold color="cyan">Release</Text>
                      {' ID → '}
                      <Text bold color="cyan">{verifyReleaseBundleId}</Text>
                    </Text>
                  </Box>
                )
              : null}
            {(() => {
          if (verifyAppLoading) {
            return (
              <Box flexDirection="column" marginTop={1}>
                <SpinnerLine text="Checking App Store Connect for your app..." />
                <Text dimColor>Fetching your apps and registered bundle IDs to verify the build matches a real App Store app.</Text>
              </Box>
            )
          }

          const releaseId = verifyReleaseBundleId

          // Gate ACTIONS are ENGINE-driven: each Select pick records the action
          // into iosCarriedRef.verifyAction and re-drives the engine's verify-app
          // RESOLVER via runVerifyGateAction (fresh pbxproj re-check, the
          // writeReleaseBundleId auto-fix, the Path B ASC re-poll +
          // ask-before-reopen, the back-to-picker reset, the persistVerifyOverride
          // write and the evaluateGate escalation all live in ios/flow.ts). Only
          // CANCEL stays a bespoke driver exit: telemetry + log + exitOnboarding,
          // exactly as before (the engine's error-sink 'cancel' is for headless
          // drivers, which have no exitOnboarding).
          const cancelGate = (path: GatePath) => {
            trackVerifyEvent('iOS App Verify Cancelled', '🚫', { attempt: verifyAttempt, path })
            addLog('Exiting onboarding.', 'yellow')
            exitOnboarding()
          }

          // Escalating border colour ramp so a repeatedly-blocked gate never
          // looks frozen (spec: each blocked Continue must look visibly
          // different). Tops out at red.
          const escalation = evaluateGate({ satisfied: false, attempt: verifyAttempt }).escalationLevel
          const gateBorder = escalation >= 3 ? 'red' : escalation === 2 ? 'yellow' : 'cyan'
          const attemptMarker = verifyAttempt > 0 ? ` (attempt ${verifyAttempt})` : ''

          // ── Path A: fix the build id ──────────────────────────────────────
          if (verifyPath === 'fix-build-id' && verifyChosenApp) {
            const wrong = releaseId
            const right = verifyChosenApp.bundleId
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="column" borderStyle="round" borderColor={gateBorder} paddingX={1}>
                  <Text bold color={gateBorder}>{`Build ID doesn't match "${verifyChosenApp.name}"${attemptMarker}`}</Text>
                  <Newline />
                  <Text>
                    {'Your project builds '}
                    <Text bold color="red">{wrong || '(no Release build ID resolved)'}</Text>
                    {', but the App Store app you picked is '}
                    <Text bold color="green">{right}</Text>
                    {'.'}
                  </Text>
                  <Newline />
                  <Text>
                    {'Set '}
                    <Text bold>PRODUCT_BUNDLE_IDENTIFIER</Text>
                    {' (Release) to '}
                    <Text bold color="cyan">{right}</Text>
                    {' — pick "Update … for me" below to do it automatically, or edit it in Xcode yourself and re-check.'}
                  </Text>
                  <Text dimColor>{'capacitor.config.appId can stay as-is — only the Release PRODUCT_BUNDLE_IDENTIFIER must match.'}</Text>
                </Box>
                <Newline />
                <Select
                  key={`gate-a-${gateActionSeq}`}
                  options={[
                    { label: '🔧 Update PRODUCT_BUNDLE_IDENTIFIER for me', value: 'autofix' },
                    { label: '✅ I\'ve edited it myself — re-check', value: 'continue' },
                    { label: '↩  Back — pick a different app', value: 'back' },
                    { label: '❌ Cancel onboarding', value: 'cancel' },
                  ]}
                  onChange={(value) => {
                    setGateActionSeq(s => s + 1)
                    if (value === 'autofix')
                      void runVerifyGateAction('autofix')
                    else if (value === 'continue')
                      void runVerifyGateAction('continue')
                    else if (value === 'back')
                      void runVerifyGateAction('back')
                    else
                      cancelGate('fix-build-id')
                  }}
                />
              </Box>
            )
          }

          // ── Path B: create the app ────────────────────────────────────────
          if (verifyPath === 'create-app') {
            const alreadyRegistered = verifyRegisteredIds.includes(releaseId)
            // After a blocked re-poll we ASK before re-opening the browser.
            if (verifyAskReopen) {
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Box flexDirection="column" borderStyle="round" borderColor={gateBorder} paddingX={1}>
                    <Text bold color={gateBorder}>{`Still no App Store app for ${releaseId}${attemptMarker}`}</Text>
                    <Newline />
                    <Text>{`We re-checked App Store Connect and didn't find an app whose bundle ID is `}<Text bold color="cyan">{releaseId}</Text>{'.'}</Text>
                    <Text dimColor>{'Create the app on appstoreconnect.com (the API cannot create apps), then re-check.'}</Text>
                  </Box>
                  <Newline />
                  <Select
                    key={`gate-b-reopen-${gateActionSeq}`}
                    options={[
                      { label: '🔁 I\'ve created it — re-check', value: 'recheck' },
                      { label: '🌐 Re-open the create-app page', value: 'reopen' },
                      { label: '❌ Cancel onboarding', value: 'cancel' },
                    ]}
                    onChange={(value) => {
                      setGateActionSeq(s => s + 1)
                      if (value === 'recheck')
                        void runVerifyGateAction('recheck')
                      else if (value === 'reopen')
                        void runVerifyGateAction('reopen')
                      else
                        cancelGate('create-app')
                    }}
                  />
                </Box>
              )
            }
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="column" borderStyle="round" borderColor={gateBorder} paddingX={1}>
                  <Text bold color={gateBorder}>{`No App Store app exists for ${releaseId}${attemptMarker}`}</Text>
                  <Newline />
                  <Text>
                    {'Your project builds '}
                    <Text bold color="cyan">{releaseId}</Text>
                    {`, but there's no App Store Connect app with that bundle ID yet. An app_store build needs one to upload to.`}
                  </Text>
                  <Newline />
                  <Text dimColor>
                    {alreadyRegistered
                      ? `The identifier ${releaseId} is already registered in your Developer account — select it when creating the app.`
                      : `We'll register the identifier ${releaseId} (so it's selectable) when you open the create-app page.`}
                  </Text>
                  <Text dimColor>{'The App Store Connect API cannot create apps — this is a one-time manual step on the web.'}</Text>
                </Box>
                <Newline />
                <Select
                  key={`gate-b-${gateActionSeq}`}
                  options={[
                    { label: '🌐 Open App Store Connect to create the app', value: 'open' },
                    { label: '🔁 I\'ve already created it — re-check', value: 'recheck' },
                    ...(verifyApps.length > 0 ? [{ label: '↩  Back — pick an existing app', value: 'back' }] : []),
                    { label: '❌ Cancel onboarding', value: 'cancel' },
                  ]}
                  onChange={(value) => {
                    setGateActionSeq(s => s + 1)
                    if (value === 'open')
                      void runVerifyGateAction('open')
                    else if (value === 'recheck')
                      void runVerifyGateAction('recheck')
                    else if (value === 'back')
                      void runVerifyGateAction('back')
                    else
                      cancelGate('create-app')
                  }}
                />
              </Box>
            )
          }

          // ── Picker (wrong-build-id): account has apps, none match the build
          //    id. Let the user pick the intended app (→ Path A) or declare the
          //    build id correct and create a new app (→ Path B). ──────────────
          return (
            <Box flexDirection="column" marginTop={1}>
              <Alert variant="warning">
                {`No App Store app matches the bundle ID your project builds (${releaseId}).`}
              </Alert>
              <Newline />
              <Text dimColor>
                {`An app_store build signs the Release PRODUCT_BUNDLE_IDENTIFIER and uploads to the App Store app with the same bundle ID. None of your apps use ${releaseId}, so the upload would be rejected. Which app are you building?`}
              </Text>
              <Newline />
              <Select
                options={[
                  ...verifyApps.map(a => ({
                    label: `${a.name} — ${a.bundleId}`,
                    value: a.bundleId,
                  })),
                  { label: '➕ None of these — my build ID is correct, create a new app', value: '__create_new__' },
                ]}
                onChange={(value) => {
                  if (value === '__create_new__') {
                    trackVerifyEvent('iOS App Verify Picked', '👆', { matches_build_id: false, chose_create_new: true })
                    void runVerifyGateAction('create-new')
                    return
                  }
                  const chosen = verifyApps.find(a => a.bundleId === value) ?? null
                  trackVerifyEvent('iOS App Verify Picked', '👆', {
                    matches_build_id: value === releaseId,
                    chose_create_new: false,
                  })
                  // The engine resolver routes the pick: an app already matching
                  // the Release build id passes straight through (defensive — the
                  // exact-match case is normally handled by the initial fetch; the
                  // ✓ log + the override persist happen engine-side); any other
                  // app parks the Path A fix-build-id gate with the chosen target.
                  void runVerifyGateAction('pick', chosen)
                }}
              />
            </Box>
          )
            })()}
          </Box>
        )}

        {/* Import: distribution mode (now FIRST visible step in import flow) */}
        {step === 'import-distribution-mode' && (
          <ImportDistributionModeStep
            dense={dense}
            onChange={async (value) => {
              // Engine-derived persistence: applyIosInput records the import fork —
              // 'app_store'/'ad_hoc' → setupMethod='import-existing' + importDistribution;
              // '__cancel__' → setupMethod='create-new' (importDistribution dropped).
              const base = await loadProgress(appId) || {
                platform: 'ios' as const,
                appId,
                startedAt: new Date().toISOString(),
                completedSteps: {},
              }
              const reduced = applyIosInput('import-distribution-mode', base, { step: 'import-distribution-mode', value: value as 'app_store' | 'ad_hoc' | '__cancel__' })
              await saveProgress(appId, reduced)

              if (value === '__cancel__') {
                // The user bailed to the create-new path. Keep the React importMode
                // mirror in sync; the reducer already cleared importDistribution.
                setImportMode(false)
                setStep('api-key-instructions')
                return
              }
              const mode = value as 'app_store' | 'ad_hoc'
              setImportDistribution(mode)
              upsertLog('✔ Distribution · ', `✔ Distribution · ${mode}`)
              if (mode === 'app_store') {
                // Need .p8 for TestFlight upload AND for any profile auto-recovery.
                // After verifying-key the import-mode branch routes back to import-pick-identity.
                // Skip the .p8 input chain entirely if the key was already
                // verified on a previous attempt (resume) — otherwise we
                // re-ask "How do you want to provide the .p8 file?" even
                // though APPLE_KEY_CONTENT is already known. Use the same
                // routing decision as the post-scan entry point. (DIVERGE from a
                // bare getIosResumeStep: getImportEntryStep is the bespoke router.)
                setStep(getImportEntryStep(reduced))
              }
              else {
                // ad_hoc skips .p8; can opt into it later from no-match recovery.
                // Surface the support hint up-front rather than waiting until
                // the user is mid-recovery in the portal-explanation step —
                // they've now committed to the harder path and deserve to
                // know help is available before they hit a wall. The helper
                // is idempotent across the session, so re-picking Ad Hoc
                // after a back-navigation doesn't re-emit. (DIVERGE: the
                // bespoke jumps straight to the picker; the matches are already
                // scanned upstream.)
                logAdHocSupportHint()
                setStep('import-pick-identity')
              }
            }}
          />
        )}

        {/* Import: validating all certs with Apple — eager batch */}
        {step === 'import-validating-all-certs' && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text={`Validating ${importMatches.length} certificate${importMatches.length === 1 ? '' : 's'} with Apple...`} />
            <Text dimColor>Splitting into Available / Unavailable so we only offer options that can succeed.</Text>
          </Box>
        )}

        {/* Import: per-identity Apple check + auto-fetch profile */}
        {step === 'import-checking-apple-cert' && chosenIdentity && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text={`Checking Apple for matching profiles for "${chosenIdentity.name}"...`} />
            <Text dimColor>Looking up the cert + listing its profiles so we either auto-import or only show recovery options that can succeed.</Text>
          </Box>
        )}

        {/* Import: pick identity — two-table picker (Available + Unavailable)
            when we have classification data from import-validating-all-certs;
            falls back to main's flat list when not. */}
        {step === 'import-pick-identity' && (() => {
          const haveClassification = Object.keys(identityAvailability).length > 0
          // Partition identities. When the batch validation didn't run
          // (no API key yet) every identity lands in "available" so the
          // user gets the unfiltered list — they can still recover from
          // each pick via the no-match menu / per-identity check.
          const available: IdentityProfileMatch[] = []
          const unavailable: IdentityProfileMatch[] = []
          for (const m of importMatches) {
            const a = identityAvailability[m.identity.sha1]
            if (!haveClassification || a?.available)
              available.push(m)
            else
              unavailable.push(m)
          }

          const onPick = async (value: string) => {
            const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
            if (value === '__cancel__') {
              // EPHEMERAL-branching: the user bailed to create-new. The engine
              // resolver routes no-chosenIdentity → api-key-instructions, but the
              // DRIVER owns the persistence (switch setupMethod, drop the stale
              // importDistribution) BEFORE re-driving — exactly the routing test's
              // contract. Clear the carried identity so the resolver sees __cancel__.
              setImportMode(false)
              const cleared: OnboardingProgress = { ...current, setupMethod: 'create-new' }
              delete cleared.importDistribution
              await saveProgress(appId, cleared)
              iosCarriedRef.current = { ...iosCarriedRef.current, chosenIdentity: undefined }
              const res = await runIosEffect('import-pick-identity', cleared, { appId, carried: iosCarriedRef.current })
              if (res.next && res.next !== 'import-pick-identity')
                setStep(res.next)
              return
            }
            const match = importMatches.find(m => m.identity.sha1 === value)
            if (!match)
              return
            // EPHEMERAL-branching: stash the picked identity into the carried ref
            // (resolved from the option SHA-1 against importMatches) + keep the React
            // mirror, then run the PURE resolver effect for next. The engine's
            // three-way routing (usable on-disk → import-pick-profile; no on-disk +
            // ASC key → import-checking-apple-cert; otherwise → import-no-match-
            // recovery with noMatchReason='no-profile-on-disk') mirrors the bespoke.
            setChosenIdentity(match.identity)
            // Clear stale per-identity cert id from a previous pick so the
            // per-identity check doesn't trust an old result.
            setAppleCertIdForChosen(undefined)
            addLog(`✔ Identity · ${match.identity.name}`)
            iosCarriedRef.current = {
              ...iosCarriedRef.current,
              chosenIdentity: match.identity,
              importMatches,
              p8Content: iosCarriedRef.current.p8Content ?? (p8ContentRef.current ? Buffer.from(p8ContentRef.current) : undefined),
            }
            const res = await runIosEffect('import-pick-identity', current, { appId, carried: iosCarriedRef.current })
            // The no-ASC-key branch sets noMatchReason in transient; mirror it so the
            // recovery menu renders the right variant.
            if (res.transient?.noMatchReason !== undefined) {
              iosCarriedRef.current = { ...iosCarriedRef.current, noMatchReason: res.transient.noMatchReason }
              setNoMatchReason(res.transient.noMatchReason as NoMatchReason)
            }
            if (res.next && res.next !== 'import-pick-identity')
              setStep(res.next)
          }

          // When classification ran we render two tables + a Select with
          // available rows only (unavailable certs can't be picked). Without
          // classification we fall back to main's flat-list ImportPickIdentityStep
          // so nothing regresses for the ad_hoc-without-.p8 entry path.
          if (!haveClassification) {
            return (
              <ImportPickIdentityStep
                identityCount={importMatches.length}
                dense={dense}
                options={[
                  ...importMatches.map((m) => {
                    const matchCount = filterProfilesForApp(m.profiles, iosBundleId, importDistribution).length
                    const label = matchCount > 0
                      ? `🔑  ${m.identity.name} · ${matchCount} matching profile${matchCount === 1 ? '' : 's'}`
                      : `🔑  ${m.identity.name} · ⚠ no matching profiles on this Mac (recovery available)`
                    return { label, value: m.identity.sha1 }
                  }),
                  { label: '↩️   Cancel and use Create new instead', value: '__cancel__' },
                ]}
                onChange={onPick}
              />
            )
          }

          const availableRows = available.map((m, i) => {
            const matchCount = filterProfilesForApp(m.profiles, iosBundleId, importDistribution).length
            // Cell value is a three-way state:
            //   1. matchCount > 0 → 'AVAILABLE' (green). Catches BOTH the
            //      on-disk-match case AND the prefetch-injected case (the
            //      prefetch synthesises profiles into m.profiles, so this
            //      branch lights up automatically — no separate prefetch
            //      branch needed for the success path).
            //   2. matchCount === 0 + prefetch pending → animated spinner.
            //      Yellow cellColor (see Table below) signals "in flight,
            //      click is still allowed" — the onPick handler routes
            //      pending clicks the same way unavailable clicks go,
            //      through import-checking-apple-cert.
            //   3. matchCount === 0 + timeout/error/unavailable/no entry →
            //      'UNAVAILABLE' (red). Click re-routes through
            //      import-checking-apple-cert so the user gets a fresh fetch.
            const prefetchState = profilePrefetch[m.identity.sha1]
            let profileCell: string
            if (matchCount > 0)
              profileCell = 'AVAILABLE'
            else if (prefetchState?.kind === 'pending')
              profileCell = `${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]} checking…`
            else
              profileCell = 'UNAVAILABLE'
            return {
              '#': `${i + 1}`,
              'Name': `🔑 ${m.identity.name}`,
              'Team': m.identity.teamId,
              'Profile': profileCell,
            }
          })
          const unavailableRows = unavailable.map(m => ({
            'Name': `🔒 ${m.identity.name}`,
            'Team': m.identity.teamId,
            'Reason': identityAvailability[m.identity.sha1]?.reasonText || 'Not classified',
          }))

          return (
            <Box flexDirection="column" marginTop={1}>
              {available.length > 0 && (
                <>
                  <Text bold color="green">{`✅  CERTIFICATE${available.length === 1 ? '' : 'S'} AVAILABLE (${available.length})`}</Text>
                  <Newline />
                  <Table
                    data={availableRows}
                    cellColor={(col, val) => {
                      if (col !== 'Profile')
                        return undefined
                      if (val === 'AVAILABLE')
                        return 'green'
                      if (val === 'UNAVAILABLE')
                        return 'red'
                      // Spinner cell — every pending render is one of
                      // SPINNER_FRAMES followed by ` checking…`. Endswith is
                      // cheaper than scanning frame chars and tolerates the
                      // frame index rolling over between renders.
                      if (typeof val === 'string' && val.endsWith(' checking…'))
                        return 'yellow'
                      return undefined
                    }}
                  />
                  <Newline />
                </>
              )}
              {available.length === 0 && (
                <Box flexDirection="column">
                  <Text bold color="red">{`✖  NO CERTIFICATES AVAILABLE`}</Text>
                  <Text dimColor>
                    All
                    {' '}
                    {unavailable.length}
                    {' '}
                    identit
                    {unavailable.length === 1 ? 'y is' : 'ies are'}
                    {' '}
                    unavailable on Apple's side. See the table below for the reason, or use "Create new" to generate a fresh cert + profile.
                  </Text>
                  <Newline />
                </Box>
              )}
              {unavailable.length > 0 && (
                <>
                  <Text bold color="red">{`✖  CERTIFICATE${unavailable.length === 1 ? '' : 'S'} UNAVAILABLE (${unavailable.length})`}</Text>
                  <Newline />
                  <Table
                    data={unavailableRows}
                    cellColor={col => (col === 'Reason' ? 'yellow' : undefined)}
                    cellDim={col => col !== 'Reason'}
                  />
                  <Newline />
                </>
              )}
              <Text bold>Pick an option:</Text>
              <Select
                options={[
                  ...available.map((m, i) => ({
                    label: `[${i + 1}] ${m.identity.name}`,
                    value: m.identity.sha1,
                  })),
                  { label: '↩️   Cancel and use Create new instead', value: '__cancel__' },
                ]}
                onChange={onPick}
              />
            </Box>
          )
        })()}

        {/* Import: pick profile */}
        {step === 'import-pick-profile' && chosenIdentity && (() => {
          const allMatchedProfiles = importMatches.find(m => m.identity.sha1 === chosenIdentity.sha1)?.profiles || []
          // Filter to profiles that are actually usable for THIS app + THIS
          // distribution mode. Without this filter, a user with a cert reused
          // across multiple apps (or with both app_store and ad_hoc profiles
          // linked to one cert) could pick a profile whose bundleId !== iosBundleId
          // or whose profileType !== importDistribution. `doSaveCredentials`
          // would then persist a mismatched provisioning_map / distribution
          // pair, producing unusable signing credentials.
          const matchedProfiles = filterProfilesForApp(allMatchedProfiles, iosBundleId, importDistribution)
          const droppedCount = allMatchedProfiles.length - matchedProfiles.length
          return (
            <ImportPickProfileStep
              matchedCount={matchedProfiles.length}
              droppedCount={droppedCount}
              distribution={importDistribution}
              dense={dense}
              options={[
                ...matchedProfiles.map(p => ({
                  label: `📜  ${p.name} · bundle ${p.bundleId} · ${p.profileType} · expires ${p.expirationDate.split('T')[0]}`,
                  // Key by UUID, NOT path. Disk-discovered profiles have a
                  // unique path, but Apple-fetched profiles (from the D
                  // no-match-recovery path) are synthesized with path=''.
                  // UUID is unique for both kinds: disk profiles use the
                  // mobileprovision UUID, synthesized ones use Apple's
                  // profile resource ID.
                  value: p.uuid,
                })),
                { label: '↩️   Back to identity selection', value: '__back__' },
              ]}
              onChange={async (value) => {
                // EPHEMERAL-branching: '__back__' records no profile → the resolver
                // routes to import-pick-identity. A valid pick stashes the resolved
                // DiscoveredProfile into the carried ref (+ React mirror) and runs the
                // PURE resolver effect, which re-runs the SAME three validations
                // (bundle id via bundleIdMatches, distribution type, the chosen cert's
                // SHA-1 in the allowed-certs list — byte-for-byte the bespoke
                // messages) and routes valid → import-export-warning, invalid → error.
                const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
                const profile = value === '__back__' ? undefined : matchedProfiles.find(p => p.uuid === value)
                if (value !== '__back__' && !profile)
                  return
                if (profile) {
                  setChosenProfile(profile)
                  iosCarriedRef.current = { ...iosCarriedRef.current, chosenProfile: profile, chosenIdentity: chosenIdentity ?? iosCarriedRef.current.chosenIdentity }
                }
                else {
                  iosCarriedRef.current = { ...iosCarriedRef.current, chosenProfile: undefined }
                }
                const res = await runIosEffect('import-pick-profile', current, { appId, carried: iosCarriedRef.current })
                if (res.next === 'error') {
                  // The resolver's validation failure → surface through handleError
                  // exactly as the bespoke onChange guards did (the engine emits the
                  // same detailed message + retryStep='import-pick-identity').
                  handleError(new Error(res.transient?.error ?? 'Profile validation failed.'), (res.transient?.retryStep as OnboardingStep) ?? 'import-pick-profile')
                  return
                }
                if (profile)
                  addLog(`✔ Profile · ${profile.name}`)
                if (res.next && res.next !== 'import-pick-profile')
                  setStep(res.next)
              }}
            />
          )
        })()}

        {/* Import: no-match recovery menu */}
        {step === 'import-no-match-recovery' && chosenIdentity && (() => {
          const hasAscKey = !!(p8ContentRef.current || p8PathRef.current)
          // D2 (create-profile-only) currently only knows how to create
          // IOS_APP_STORE profiles via apple-api.ts createProfile, which
          // hardcodes that profileType. For ad_hoc we'd need a separate
          // create path that calls Apple with IOS_APP_ADHOC. Until that
          // exists, hide the "Create" option for ad_hoc users so they
          // can't end up with an app_store profile saved under
          // CAPGO_IOS_DISTRIBUTION='ad_hoc'. Browser + Fetch still work.
          const canCreateProfile = importDistribution !== 'ad_hoc'
          return (
            <ImportNoMatchRecoveryStep
              reason={noMatchReason ?? undefined}
              appId={iosBundleId}
              importDistribution={importDistribution}
              identityName={chosenIdentity.name}
              dense={dense}
              options={[
                // Order optimized for most-likely-to-succeed first:
                //   1. Create a fresh profile via Apple API — automatic
                //   2. Use a local .mobileprovision file — fastest when you
                //      already have one
                //   3. Open the Developer Portal — manual fallback with a
                //      guided walkthrough that funnels back to option 2
                //   4. Back to identity selection
                //
                // The legacy "🔍 Fetch matching profile from Apple" / "🔄
                // Rescan" option was dropped (commit 36a7c282): the auto-
                // fetch built into the per-identity check already covers
                // the "Apple has a profile" case, and the portal walkthrough
                // routes the manual case through the file picker. Two
                // parallel rescan paths made the UX inconsistent with the
                // instructions we render in the walkthrough.
                ...(canCreateProfile
                  ? [{
                      label: hasAscKey
                        ? `✨  Create a new App Store profile for this cert via Apple`
                        : `✨  Provide ASC API key, then create a new App Store profile for this cert`,
                      value: 'create',
                    }]
                  : []),
                ...(canUseFilePicker()
                  ? [{ label: `📁  Use a .mobileprovision file from disk`, value: 'provide-profile-path' }]
                  : []),
                {
                  label: `🌐  Open Apple Developer Portal (browse / create profiles manually)`,
                  value: 'browser',
                },
                { label: '↩️   Back to identity selection', value: 'back' },
              ]}
              onChange={async (value) => {
                // EPHEMERAL-branching: record the recovery pick into the carried ref
                // + thread the sticky noMatchReason (so the menu keeps its variant on
                // a bounce) and run the resolver effect. The engine routes 'browser' →
                // import-portal-explanation, 'provide-profile-path' →
                // import-provide-profile-path, 'back' → import-pick-identity, 'create'
                // + ASC key → import-create-profile-only, 'create' + no key →
                // api-key-instructions (PERSISTING pendingRecoveryAction). The driver
                // RESETS profilePickerOpened before the file-picker path so the picker
                // re-opens, mirroring the bespoke mobileprovisionPickerOpenedRef reset.
                if (value === 'provide-profile-path') {
                  mobileprovisionPickerOpenedRef.current = false
                  iosCarriedRef.current = { ...iosCarriedRef.current, profilePickerOpened: false }
                }
                const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
                iosCarriedRef.current = {
                  ...iosCarriedRef.current,
                  recoveryAction: value as 'create' | 'provide-profile-path' | 'browser' | 'back',
                  chosenIdentity: chosenIdentity ?? iosCarriedRef.current.chosenIdentity,
                  noMatchReason: (noMatchReason ?? iosCarriedRef.current.noMatchReason) ?? undefined,
                  p8Content: iosCarriedRef.current.p8Content ?? (p8ContentRef.current ? Buffer.from(p8ContentRef.current) : undefined),
                }
                const res = await runIosEffect('import-no-match-recovery', current, { appId, carried: iosCarriedRef.current, saveProgress })
                // 'create' + no ASC key persists pendingRecoveryAction in progress; keep
                // the React mirror in sync so the import-mode verifying-key resume can
                // route back to the profile-creation action.
                if (res.next === 'api-key-instructions')
                  setPendingRecoveryAction('create-profile-only')
                if (res.next && res.next !== 'import-no-match-recovery')
                  setStep(res.next)
              }}
            />
          )
        })()}

        {/* Import: native picker for a .mobileprovision file on disk */}
        {step === 'import-provide-profile-path' && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text="Opening file picker for your .mobileprovision file..." />
            <Text dimColor>{`If the dialog doesn't appear, check behind other windows or in the menu bar.`}</Text>
          </Box>
        )}

        {/* Import: manual portal walkthrough — explains what to do on
            developer.apple.com and steers toward the automatic "Create new"
            path or the file-picker path. Routed to from the recovery menu's
            "🌐 Open Apple Developer Portal" option. */}
        {step === 'import-portal-explanation' && chosenIdentity && (() => {
          const canAutoCreate = importDistribution !== 'ad_hoc'
          // The walkthrough renders one of two flavours:
          //  - app_store: the original "you CAN do this manually, but
          //    here's an easier automatic option" framing, ending with a
          //    Select that nudges toward the auto path.
          //  - ad_hoc: an honest "this is complex, here's what's involved,
          //    and you can email support if you want help" framing, with a
          //    plain Open Portal option (no "anyway" — there's no
          //    automatic alternative to contrast with), the file-picker
          //    return path, and a Capgo-support breadcrumb. The manual
          //    walkthrough below stops at step 7 (download + come back),
          //    intentionally skipping the device-registration step that
          //    ad_hoc profiles require — that step varies wildly by team
          //    and is exactly the kind of thing support can help with.
          return (
            <Box flexDirection="column" marginTop={1}>
              <Alert variant="info">
                {canAutoCreate
                  ? 'You can do this manually in the Apple Developer Portal — but the automatic path is much easier.'
                  : `Ad-hoc distribution is genuinely fiddly (you also need to register every target device on Apple's side). Here's what's involved — and how to get help if you're stuck.`}
              </Alert>
              <Newline />
              {/* The ad_hoc "want help?" breadcrumb fires at the moment the
                  user picks Ad Hoc on the distribution-mode step (yellow log
                  entries), not here. Surfacing it on the recovery walkthrough
                  meant the user only saw the offer AFTER they'd already
                  started fumbling — too late. The log lines stay visible in
                  the side log throughout the rest of the wizard. */}
              <Text bold>{`What you'd need to do manually:`}</Text>
              <Box flexDirection="column" marginLeft={2} marginTop={1}>
                <Text>1. Sign in at developer.apple.com/account/resources/profiles/list.</Text>
                <Text>
                  2. Select the correct team (top right) —
                  {' '}
                  <Text bold>{chosenIdentity.teamId}</Text>
                  {chosenIdentity.teamName ? ` (${chosenIdentity.teamName})` : ''}
                  .
                </Text>
                <Text>
                  3. Click
                  {' '}
                  <Text bold>+</Text>
                  {' '}
                  to create a new profile. Pick
                  {' '}
                  <Text bold>{importDistribution === 'ad_hoc' ? 'Ad Hoc' : 'App Store'}</Text>
                  {' '}
                  under
                  {' '}
                  <Text bold>Distribution</Text>
                  .
                </Text>
                <Text>
                  4. Pick the App ID matching
                  {' '}
                  <Text bold>{iosBundleId}</Text>
                  {`. Create it first if it doesn't exist.`}
                </Text>
                <Text>
                  5. In the "Certificates" step, tick the cert matching
                  {' '}
                  <Text bold>{chosenIdentity.name}</Text>
                  . If multiple are listed, pick carefully — we re-verify the cert SHA1 in the next step.
                </Text>
                {!canAutoCreate && (
                  <Text>
                    6. In the "Devices" step, tick every device UDID that should be able to run this build. (This is the ad-hoc-specific step. Devices have to be registered under
                    {' '}
                    <Text color="cyan" underline>developer.apple.com/account/resources/devices/list</Text>
                    {' '}
                    first.)
                  </Text>
                )}
                <Text>
                  {canAutoCreate ? '6. ' : '7. '}
                  Name + Generate + Download. The .mobileprovision file lands in your Downloads folder.
                </Text>
                <Text>
                  {canAutoCreate ? '7. ' : '8. '}
                  Come back here and pick
                  {' '}
                  <Text bold>📁  Use a .mobileprovision file from disk</Text>
                  .
                </Text>
              </Box>
              <Newline />
              {canAutoCreate && (
                <Box flexDirection="column">
                  <Text bold color="green">💡 Recommended: let Capgo do this automatically.</Text>
                  <Text dimColor>
                    "✨ Create a new App Store profile for this cert via Apple" runs the same steps via the Apple API — same cert, same bundle ID, no portal navigation, no manual download.
                  </Text>
                  <Newline />
                </Box>
              )}
              <Select
                options={[
                  ...(canAutoCreate
                    ? [{ label: '✨  Use "Create a new App Store profile" instead (recommended)', value: 'use-create' }]
                    : []),
                  {
                    label: canAutoCreate
                      ? '🌐  Open the portal anyway (advanced)'
                      : '🌐  Open Apple Developer Portal',
                    value: 'open-anyway',
                  },
                  ...(canUseFilePicker()
                    ? [{ label: '📁  I already have a .mobileprovision on disk — let me pick it', value: 'use-file' }]
                    : []),
                  { label: '↩️   Back to recovery menu', value: 'back' },
                ]}
                onChange={async (value) => {
                  // EPHEMERAL-branching: record the portal pick into the carried ref +
                  // thread the sticky noMatchReason and run the resolver effect. The
                  // engine routes 'use-create' → import-create-profile-only, 'use-file'
                  // → import-provide-profile-path, 'open-anyway' → opens the portal
                  // (deps.openExternal, best-effort) + a yellow breadcrumb then BACK to
                  // import-no-match-recovery, 'back' → import-no-match-recovery. The
                  // driver resets profilePickerOpened before the file-picker path.
                  if (value === 'use-file') {
                    mobileprovisionPickerOpenedRef.current = false
                    iosCarriedRef.current = { ...iosCarriedRef.current, profilePickerOpened: false }
                  }
                  const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
                  iosCarriedRef.current = {
                    ...iosCarriedRef.current,
                    portalAction: value as 'use-create' | 'open-anyway' | 'use-file' | 'back',
                    noMatchReason: (noMatchReason ?? iosCarriedRef.current.noMatchReason) ?? undefined,
                  }
                  const res = await runIosEffect('import-portal-explanation', current, {
                    appId,
                    carried: iosCarriedRef.current,
                    openExternal: async (url) => { await open(url) },
                    onLog: (message, color) => addLog(message, color),
                  })
                  if (res.next && res.next !== 'import-portal-explanation')
                    setStep(res.next)
                }}
              />
            </Box>
          )
        })()}

        {/* Import: D2 — creating a new profile via Apple for the existing cert */}
        {step === 'import-create-profile-only' && <ImportCreateProfileOnlyStep />}

        {/* Import: export warning (heads-up before the one Keychain dialog) */}
        {step === 'import-export-warning' && chosenIdentity && (
          <ImportExportWarningStep
            identityName={chosenIdentity.name}
            dense={dense}
            onChange={async (value) => {
              if (value === 'exit') {
                // DIVERGE: the bespoke exit escape calls exitOnboarding directly (the
                // engine models it as the resolver's 'error' route; the TUI's
                // user-facing exit sink is exitOnboarding — keep it).
                exitOnboarding('Exiting. Re-run `build init` whenever you\'re ready.')
                return
              }
              // EPHEMERAL-branching: record 'go' / 'back' into the carried ref and run
              // the resolver effect. 'go' → import-exporting (the precompiled helper
              // is resolved + signature-verified in the export step itself — PR #2458
              // removed the swiftc compile step); 'back' → import-pick-profile.
              const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
              iosCarriedRef.current = { ...iosCarriedRef.current, exportWarningAction: value as 'go' | 'back' | 'exit' }
              const res = await runIosEffect('import-export-warning', current, { appId, carried: iosCarriedRef.current })
              if (res.next && res.next !== 'import-export-warning')
                setStep(res.next)
            }}
          />
        )}

        {/* Import: exporting (the one Keychain prompt happens here) */}
        {step === 'import-exporting' && <ImportExportingStep />}

        {/* API key instructions + .p8 input */}
        {step === 'api-key-instructions' && (
          <ApiKeyInstructionsStep
            canUseFilePicker={canUseFilePicker()}
            canCreateGuided={guidedHelperUsable}
            dense={dense}
            onMethodChange={async (value) => {
              if (value === 'guided') {
                // Switch from the manual .p8 path to the guided helper.
                await persistP8CreateMethod('automated')
                setStep('asc-key-generating')
              }
              else if (value === 'picker') {
                setStep('p8-method-select')
              }
              else {
                setStep('input-p8-path')
              }
            }}
            onPathSubmit={async (value) => {
              const filePath = value.replace(/^~/, process.env.HOME || '')
              try {
                const content = await readFile(filePath, 'utf-8')
                setP8Path(filePath)
                setP8Content(content)
                const extracted = extractKeyIdFromPath(filePath)
                if (extracted)
                  setKeyId(extracted)
                addLog(`✔ Key file found · ${filePath}`)
                // Persist the extracted keyId too, so a quit-before-confirm resume
                // restores it instead of showing the empty placeholder.
                await savePartialProgress({ p8Path: filePath, keyId: extracted || undefined })
                // Engine-derived routing (same as the input-p8-path onSubmit): the
                // direct path-submit on the api-key-instructions screen is an
                // input-p8-path action. Route off a base WITHOUT keyId so it lands
                // on input-key-id, matching the bespoke setStep('input-key-id').
                // We load the FULL persisted progress first (the sibling input-key-id
                // / input-issuer-id handlers do the same) so routing-critical fields
                // — esp. iosBundleIdOverride + iosBundleIdContextAppId (the verified bundle-id override) —
                // survive into the routing base instead of being dropped by a minimal
                // synthetic object. We then merge the new p8Path but CLEAR keyId so
                // getIosResumeStep still lands on input-key-id (the user confirms the
                // auto-detected Key ID). Note: keyId is still SAVED above for resume.
                const loaded = await loadProgress(appId)
                const base = { ...(loaded ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {}, setupMethod: importMode ? 'import-existing' as const : 'create-new' as const, ...(importMode && importDistribution ? { importDistribution } : {}) }), p8Path: filePath, keyId: undefined }
                const reduced = applyIosInput('input-p8-path', base, { step: 'input-p8-path', value: filePath })
                setStep(getIosResumeStep(reduced))
              }
              catch (err) {
                // The try spans MORE than the readFile — savePartialProgress /
                // loadProgress can fail AFTER the read succeeded. Only a missing
                // file earns the friendly not-found copy; everything else
                // surfaces the REAL error. The raw error is always logged.
                appendInternalLog(`api-key-instructions .p8 submit failed: ${err instanceof Error ? err.message : String(err)}`)
                if (classifyP8SubmitError(err) === 'not-found')
                  handleError(new Error(`File not found: ${filePath}`), 'api-key-instructions')
                else
                  handleError(err, 'api-key-instructions')
              }
            }}
          />
        )}

        {/* File picker opening */}
        {step === 'p8-method-select' && <P8MethodSelectStep />}

        {/* Manual .p8 path input */}
        {step === 'input-p8-path' && (
          <InputP8PathStep
            onSubmit={async (value) => {
              const filePath = value.replace(/^~/, process.env.HOME || '')
              try {
                const content = await readFile(filePath, 'utf-8')
                setP8Path(filePath)
                setP8Content(content)
                const extracted = extractKeyIdFromPath(filePath)
                if (extracted)
                  setKeyId(extracted)
                addLog(`✔ Key file found · ${filePath}`)
                // Persist the extracted keyId too, so a quit-before-confirm resume
                // restores it instead of showing the empty placeholder.
                await savePartialProgress({ p8Path: filePath, keyId: extracted || undefined })
                // Engine-derived routing: applyIosInput records ONLY p8Path (file
                // read + keyId extraction are the effect boundary, done above), then
                // getIosResumeStep routes on the .p8 chain. We route off a base WITHOUT
                // keyId so it lands on input-key-id (the user still confirms/overrides
                // the auto-detected Key ID), matching the bespoke setStep('input-key-id')
                // — even though keyId is persisted to disk for resume restoration.
                // We load the FULL persisted progress first (the sibling input-key-id
                // / input-issuer-id handlers do the same) so routing-critical fields
                // — esp. iosBundleIdOverride + iosBundleIdContextAppId (the verified bundle-id override) —
                // survive into the routing base instead of being dropped by a minimal
                // synthetic object. We then merge the new p8Path but CLEAR keyId so
                // getIosResumeStep still lands on input-key-id (the user confirms the
                // auto-detected Key ID). Note: keyId is still SAVED above for resume.
                const loaded = await loadProgress(appId)
                const base = { ...(loaded ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {}, setupMethod: importMode ? 'import-existing' as const : 'create-new' as const, ...(importMode && importDistribution ? { importDistribution } : {}) }), p8Path: filePath, keyId: undefined }
                const reduced = applyIosInput('input-p8-path', base, { step: 'input-p8-path', value: filePath })
                setStep(getIosResumeStep(reduced))
              }
              catch (err) {
                // Same classification as the api-key-instructions handler: the
                // try also covers savePartialProgress / loadProgress, so only
                // ENOENT becomes "File not found" — real errors surface as-is.
                appendInternalLog(`input-p8-path submit failed: ${err instanceof Error ? err.message : String(err)}`)
                if (classifyP8SubmitError(err) === 'not-found')
                  handleError(new Error(`File not found: ${value}`), 'input-p8-path')
                else
                  handleError(err, 'input-p8-path')
              }
            }}
          />
        )}

        {/* Key ID */}
        {step === 'input-key-id' && (
          <InputKeyIdStep
            keyId={keyId}
            dense={dense}
            onSubmit={async (value) => {
            // `value || keyId` reuses the detected key ID when the user just
            // presses Enter; the trim+guard rejects an empty submission in the
            // no-detection case (keyId='' makes the fallback a no-op).
              const finalKeyId = (value || keyId).trim()
              if (!finalKeyId)
                return
              setKeyId(finalKeyId)
              upsertLog('✔ Key ID · ', `✔ Key ID · ${finalKeyId}`)
              await savePartialProgress({ keyId: finalKeyId })
              // Engine-derived routing: applyIosInput records keyId (we pass the
              // already-resolved finalKeyId so the engine's `value || detected`
              // matches the bespoke `value || keyId`), then getIosResumeStep
              // re-derives the next step from the persisted .p8 chain (p8Path +
              // keyId set, no issuerId → input-issuer-id). matches the bespoke
              // setStep('input-issuer-id').
              const loaded = await loadProgress(appId)
              const reduced = applyIosInput('input-key-id', loaded ?? { platform: 'ios', appId, startedAt: new Date().toISOString(), completedSteps: {} }, { step: 'input-key-id', value: finalKeyId })
              setStep(getIosResumeStep(reduced))
            }}
          />
        )}

        {/* Issuer ID */}
        {step === 'input-issuer-id' && (
          <InputIssuerIdStep
            dense={dense}
            onSubmit={async (value) => {
              const cleaned = value.trim()
              if (!cleaned)
                return
              setIssuerId(cleaned)
              upsertLog('✔ Issuer ID · ', `✔ Issuer ID · ${cleaned}`)
              await savePartialProgress({ issuerId: cleaned })
              // Engine-derived routing: applyIosInput records issuerId, then
              // getIosResumeStep re-derives the next step from the persisted .p8
              // chain (p8Path + keyId + issuerId all set → verifying-key). matches
              // the bespoke setStep('verifying-key'). Works for both create-new and
              // import app_store (getResumeStep routes the same on a full .p8 chain).
              const loaded = await loadProgress(appId)
              const reduced = applyIosInput('input-issuer-id', loaded ?? { platform: 'ios', appId, startedAt: new Date().toISOString(), completedSteps: {} }, { step: 'input-issuer-id', value })
              setStep(getIosResumeStep(reduced))
            }}
          />
        )}

        {/* Verifying */}
        {step === 'verifying-key' && <VerifyingKeyStep />}

        {/* Creating certificate */}
        {step === 'creating-certificate' && <CreatingCertificateStep />}

        {/* Certificate limit — ask which to revoke */}
        {step === 'cert-limit-prompt' && (
          <CertLimitPromptStep
            existingCount={existingCerts.length}
            dense={dense}
            options={[
              ...existingCerts.map((c) => {
                const ourCertId = certData?.certificateId || initialProgress?.completedSteps.certificateCreated?.certificateId
                const isOurs = ourCertId === c.id
                const creator = isOurs ? ' · 🔧 Created by Capgo' : ''
                return {
                  label: `🗑️   ${c.name} · expires ${c.expirationDate.split('T')[0]}${creator}`,
                  value: c.id,
                }
              }),
              { label: '✖  Exit onboarding', value: '__exit__' },
            ]}
            onChange={async (value) => {
              // Known @inkjs/ui bug: Select re-fires onChange while it stays
              // mounted post-select — one-shot guard (reset on step change) so
              // the async resolver below cannot double-run.
              if (certLimitPickHandledRef.current)
                return
              certLimitPickHandledRef.current = true
              if (value === '__exit__') {
                // DIVERGE: the bespoke exit escape calls exitOnboarding directly
                // (the engine models this as the resolver's 'error' route, but the
                // TUI's user-facing exit sink is exitOnboarding — keep it).
                addLog(`Exiting. Revoke a certificate manually in App Store Connect, then resume with ${buildInitCommand}.`, 'yellow')
                exitOnboarding()
              }
              else {
                // EPHEMERAL-branching: stash the picked cert into the carried ref
                // (resolved to the AscDistributionCert the revoke effect needs) +
                // keep the React `certToRevoke` mirror (the create-new effect driver
                // reconstructs the cert object from it). Then run the pure resolver
                // effect to derive next (always → revoking-certificate on a pick),
                // mirroring the BATCH-2 ephemeral-branching mechanism.
                setCertToRevoke(value)
                const certObj = existingCerts.find(c => c.id === value) ?? { id: value, name: '', serialNumber: '', expirationDate: '' }
                iosCarriedRef.current = { ...iosCarriedRef.current, certToRevoke: certObj }
                const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
                const res = await runIosEffect('cert-limit-prompt', current, { appId, carried: iosCarriedRef.current })
                if (res.next && res.next !== 'cert-limit-prompt')
                  setStep(res.next)
              }
            }}
          />
        )}

        {/* Revoking certificate */}
        {step === 'revoking-certificate' && <RevokingCertificateStep />}

        {/* Creating profile */}
        {step === 'creating-profile' && <CreatingProfileStep appId={appId} dense={dense} />}

        {/* Duplicate profile prompt */}
        {step === 'duplicate-profile-prompt' && (
          <DuplicateProfilePromptStep
            duplicateCount={duplicateProfiles.length}
            dense={dense}
            onChange={async (value) => {
              // Known @inkjs/ui bug: Select re-fires onChange while it stays
              // mounted post-select — one-shot guard (reset on step change) so
              // the async resolver below cannot double-run.
              if (duplicateProfilePickHandledRef.current)
                return
              duplicateProfilePickHandledRef.current = true
              if (value === 'delete') {
                // EPHEMERAL-branching: record the confirm into the carried ref +
                // thread the duplicate list (the delete effect reads it). Then run
                // the pure resolver effect to derive next (confirm →
                // deleting-duplicate-profiles), mirroring the BATCH-2 mechanism.
                iosCarriedRef.current = { ...iosCarriedRef.current, confirmDeleteDuplicates: true, duplicateProfiles }
                const current = (await loadProgress(appId)) ?? { platform: 'ios' as const, appId, startedAt: new Date().toISOString(), completedSteps: {} }
                const res = await runIosEffect('duplicate-profile-prompt', current, { appId, carried: iosCarriedRef.current })
                if (res.next && res.next !== 'duplicate-profile-prompt')
                  setStep(res.next)
              }
              else {
                // DIVERGE: the bespoke exit escape calls exitOnboarding directly
                // (the engine models it as the resolver's 'error' route; the TUI's
                // user-facing exit sink is exitOnboarding — keep it).
                addLog(`Exiting. Delete the duplicate profiles in App Store Connect, then resume with ${buildInitCommand}.`, 'yellow')
                exitOnboarding()
              }
            }}
          />
        )}

        {/* Deleting duplicate profiles */}
        {step === 'deleting-duplicate-profiles' && (
          <DeletingDuplicateProfilesStep duplicateCount={duplicateProfiles.length} />
        )}

        {/* Saving credentials */}
        {step === 'saving-credentials' && <SavingCredentialsStep />}

        {step === 'detecting-ci-secrets' && <DetectingCiSecretsStep />}

        {step === 'ci-secrets-setup' && (
          <CiSecretsSetupStep
            advice={ciSecretSetupAdvice}
            dense={dense}
            onChange={(value) => {
              setStep(value === 'retry' ? 'detecting-ci-secrets' : 'build-complete')
            }}
          />
        )}

        {step === 'ci-secrets-target-select' && (
          <CiSecretsTargetSelectStep
            options={[
              ...ciSecretTargets.map(target => ({
                label: target.provider === 'github' ? 'GitHub Actions repository secrets' : 'GitLab CI/CD variables',
                value: target.provider,
              })),
              { label: 'Skip', value: 'skip' },
            ]}
            dense={dense}
            onChange={(value) => {
              if (value === 'skip') {
                setStep('build-complete')
                return
              }
              const target = ciSecretTargets.find(candidate => candidate.provider === value) || null
              setCiSecretTarget(target)
              if (!target) {
                setStep('build-complete')
                return
              }
              // GitHub routes into the new 3-option GitHub Actions prompt
              // (secrets + workflow / secrets-only / no); GitLab keeps the legacy
              // 2-option ask-ci-secrets flow.
              setStep(target.provider === 'github' ? 'ask-github-actions-setup' : 'ask-ci-secrets')
            }}
          />
        )}

        {step === 'ask-ci-secrets' && (
          <AskCiSecretsStep
            entryCount={ciSecretEntries.length}
            target={ciSecretTarget}
            targetLabel={getCiSecretTargetLabel(ciSecretTarget)}
            dense={dense}
            onChange={(value) => {
              setStep(value === 'yes' ? 'checking-ci-secrets' : 'build-complete')
            }}
          />
        )}

        {step === 'ask-github-actions-setup' && (
          <Box flexDirection="column" marginTop={1}>
            <SuccessLine text="Credentials saved · GitHub detected" />
            <Newline />
            <Text bold>Set up GitHub Actions for you?</Text>
            <Text dimColor>
              Capgo can push your
              {' '}
              {ciSecretEntries.length}
              {' '}
              build env var
              {ciSecretEntries.length === 1 ? '' : 's'}
              {' '}
              as repository secrets and drop a
              {' '}
              .github/workflows/capgo-build.yml file you can dispatch manually.
            </Text>
            <Newline />
            <Select
              options={[
                { label: '🚀  Yes — set the secrets AND create a workflow file', value: 'with-workflow' },
                { label: '🔒  Yes — set ONLY the secrets', value: 'secrets-only' },
                { label: '❌  No', value: 'no' },
              ]}
              onChange={(value) => {
                if (value === 'no') {
                  setSetupMode('declined')
                  setStep('ask-export-env')
                  return
                }
                setSetupMode(value as 'with-workflow' | 'secrets-only')
                setStep('checking-ci-secrets')
              }}
            />
          </Box>
        )}

        {step === 'ask-export-env' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Export the credentials as a .env file instead?</Text>
            <Text dimColor>
              Writes
              {' '}
              {defaultExportPath(appId, 'ios').split('/').slice(-1)[0]}
              {' '}
              so you can wire up CI later via
              {' '}
              <Text>gh secret set -f</Text>
              {' '}
              or paste the values manually.
            </Text>
            <Newline />
            <Select
              options={[
                { label: `📝  Yes — write .env.capgo.${appId}.ios`, value: 'yes' },
                { label: '❌  No, exit without exporting', value: 'no' },
              ]}
              onChange={(value) => {
                if (value === 'yes') {
                  setEnvExportTargetPath(defaultExportPath(appId, 'ios'))
                  setStep('exporting-env')
                  return
                }
                setStep('build-complete')
              }}
            />
          </Box>
        )}

        {step === 'exporting-env' && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text={`Writing ${defaultExportPath(appId, 'ios').split('/').slice(-1)[0]}…`} />
          </Box>
        )}

        {step === 'confirm-env-export-overwrite' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="yellow">
              {envExportTargetPath}
              {' '}
              already exists.
            </Text>
            <Text dimColor>Replace it with a fresh export, or skip?</Text>
            <Newline />
            <Select
              options={[
                { label: '✏️   Replace it', value: 'replace' },
                { label: '🛑  Skip — keep the existing file', value: 'skip' },
              ]}
              onChange={(value) => {
                setStep(value === 'replace' ? 'overwrite-and-export-env' : 'build-complete')
              }}
            />
          </Box>
        )}

        {step === 'pick-package-manager' && (() => {
          const detected = normalizePackageManager(pm.pm)
          const detectionNote = pm.pm === 'unknown'
            ? '(no recognizable lockfile in this project — pick whichever you actually use)'
            : `(detected from your lockfile — ${pm.pm})`
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Which package manager does this project use?</Text>
              <Text dimColor>
                Drives the install + build steps in the generated workflow. We
                {' '}
                {detectionNote}
              </Text>
              <Newline />
              <Select
                options={[
                  { label: `📦  bun${detected === 'bun' ? '  (recommended — matches your lockfile)' : ''}`, value: 'bun' },
                  { label: `📦  npm${detected === 'npm' ? '  (recommended — matches your lockfile)' : ''}`, value: 'npm' },
                  { label: `📦  pnpm${detected === 'pnpm' ? '  (recommended — matches your lockfile)' : ''}`, value: 'pnpm' },
                  { label: `📦  yarn${detected === 'yarn' ? '  (recommended — matches your lockfile)' : ''}`, value: 'yarn' },
                ]}
                onChange={(value) => {
                  setSelectedPackageManager(value as PackageManager)
                  setStep('pick-build-script')
                }}
              />
            </Box>
          )
        })()}

        {step === 'pick-build-script' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Which script builds your web assets?</Text>
            <Text dimColor>
              Capgo will run this before invoking
              {' '}
              <Text>capgo build request</Text>
              {' '}
              in the workflow. Pick the script you use locally to produce the web build (typically into capacitor.config webDir, e.g. dist/).
            </Text>
            <Newline />
            <Select
              options={buildScriptPickerOptions(availableScripts, recommendedScript)}
              onChange={(value) => {
                if (value === '__skip__') {
                  setBuildScriptChoice({ type: 'skip' })
                  setStep('preview-workflow-file')
                  return
                }
                if (value === '__custom__') {
                  setStep('pick-build-script-custom')
                  return
                }
                setBuildScriptChoice({ type: 'npm-script', name: value })
                setStep('preview-workflow-file')
              }}
            />
          </Box>
        )}

        {step === 'pick-build-script-custom' && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Custom build command</Text>
            <Text dimColor>
              Type the exact command you want the workflow to run before
              {' '}
              <Text>capgo build request</Text>
              {' '}
              (e.g.
              {' '}
              <Text>make web</Text>
              ,
              {' '}
              <Text>bash scripts/build.sh</Text>
              ).
            </Text>
            <Box marginTop={1}>
              <FilteredTextInput
                placeholder="make web"
                onSubmit={(value) => {
                  const cleaned = value.trim()
                  if (!cleaned)
                    return
                  setBuildScriptChoice({ type: 'custom', command: cleaned })
                  setStep('preview-workflow-file')
                }}
              />
            </Box>
          </Box>
        )}

        {step === 'preview-workflow-file' && previewDiff.length > 0 && (() => {
          const allEqual = previewDiff.every(l => l.kind === 'eq')
          const writeLabel = allEqual
            ? '✏️   Write file anyway (re-writes identical content)'
            : (previewIsNew ? '✏️   Write file' : '✏️   Replace existing file')
          const skipLabel = '❌  Do not write file'
          const title = previewIsNew
            ? `🆕  Proposed new file — ${previewExistingPath ?? WORKFLOW_PATH}`
            : `✏️  Proposed changes — ${previewExistingPath ?? WORKFLOW_PATH}`
          const subtitle = previewIsNew
            ? 'Nothing exists on disk yet. Every line below is what would be written.'
            : 'Proposed diff vs the file on disk. Lines marked - would be removed, lines marked + would be added.'
          return (
            <Box flexDirection="column" marginTop={1}>
              <DiffSummary title={title} subtitle={subtitle} lines={previewDiff} />
              <Box marginTop={1} flexDirection="column">
                <Text bold>What should we do with {WORKFLOW_PATH}?</Text>
                <Select
                  options={[
                    { label: writeLabel, value: 'write' },
                    { label: '👀  Show proposed file diff', value: 'view' },
                    { label: skipLabel, value: 'cancel' },
                  ]}
                  onChange={(value) => {
                    if (value === 'view') {
                      trackWorkflowEvent('workflow-preview-action', { decision: 'view' })
                      trackWorkflowEvent('workflow-diff-opened', { decision: 'view' })
                      setStep('view-workflow-diff')
                      return
                    }
                    trackWorkflowEvent('workflow-preview-action', { decision: value === 'write' ? 'write' : 'cancel' })
                    setPreviewDiff([])
                    setStep(value === 'write' ? 'writing-workflow-file' : 'build-complete')
                  }}
                />
              </Box>
            </Box>
          )
        })()}
        {step === 'preview-workflow-file' && previewDiff.length === 0 && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text={`Preparing diff for ${WORKFLOW_PATH}…`} />
          </Box>
        )}

        {/* view-workflow-diff renders as a fullscreen early-return takeover above. */}

        {step === 'writing-workflow-file' && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text={`Writing ${WORKFLOW_PATH}…`} />
          </Box>
        )}

        {step === 'checking-ci-secrets' && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine text={ciSecretCheckPhase} />
          </Box>
        )}

        {step === 'confirm-secrets-push' && (
          (() => {
            const existingSet = new Set(ciSecretExistingKeys)
            const newCount = ciSecretEntries.filter(entry => !existingSet.has(entry.key)).length
            const replaceCount = ciSecretEntries.length - newCount
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color="yellow">⚠  Confirm before pushing secrets</Text>
                <Text>
                  Repository:
                  {' '}
                  <Text bold color="cyan">{ciSecretRepoLabel}</Text>
                  {' '}
                  <Text dimColor>(resolved via `gh repo view`)</Text>
                </Text>
                <Text bold>
                  {`Will push ${ciSecretEntries.length} env var${ciSecretEntries.length === 1 ? '' : 's'}`}
                  {replaceCount > 0 ? ` — ${newCount} new, ${replaceCount} REPLACING existing:` : ' — all new:'}
                </Text>
                <Box marginTop={1}>
                  <SecretsTable
                    rows={ciSecretEntries.map(entry => ({
                      name: entry.key,
                      status: existingSet.has(entry.key) ? 'REPLACE' : 'NEW',
                    }))}
                  />
                </Box>
                {replaceCount > 0 && (
                  <Box marginTop={1}>
                    <Text dimColor color="yellow">⚠  `gh secret set` overwrites silently — replaced values cannot be recovered.</Text>
                  </Box>
                )}
              </Box>
            )
          })()
        )}
        {step === 'confirm-secrets-push' && (
          <>
            <Box marginTop={1}>
              <Select
                options={[
                  {
                    label: `✅  Yes, push to ${ciSecretRepoLabel}`,
                    value: 'confirm',
                  },
                  { label: '❌  Cancel — don\'t push anything', value: 'cancel' },
                ]}
                onChange={(value) => {
                  setStep(value === 'confirm' ? 'uploading-ci-secrets' : 'build-complete')
                }}
              />
            </Box>
          </>
        )}

        {step === 'confirm-ci-secret-overwrite' && (
          <ConfirmCiSecretOverwriteStep
            existingKeys={ciSecretExistingKeys}
            dense={dense}
            onChange={(value) => {
              setStep(value === 'replace' ? 'uploading-ci-secrets' : 'build-complete')
            }}
          />
        )}

        {step === 'uploading-ci-secrets' && (
          <Box flexDirection="column" marginTop={1}>
            <SpinnerLine
              text={ciSecretUploadProgress
                ? `Pushing ${ciSecretUploadProgress.current} of ${ciSecretUploadProgress.total}: ${ciSecretUploadProgress.key}…`
                : `Uploading env vars to ${ciSecretRepoLabel ?? getCiSecretTargetLabel(ciSecretTarget)}…`}
            />
          </Box>
        )}

        {step === 'ci-secrets-failed' && (
          <CiSecretsFailedStep
            error={ciSecretError}
            dense={dense}
            onChange={(value) => {
              setStep(value === 'retry' ? (ciSecretTarget ? 'checking-ci-secrets' : 'detecting-ci-secrets') : 'build-complete')
            }}
          />
        )}

        {/* Ask to build */}
        {step === 'ask-build' && (
          <AskBuildStep
            dense={dense}
            onChange={(value) => {
              if (value === 'yes') {
                setStep('requesting-build')
              }
              else {
                setStep('build-complete')
              }
            }}
          />
        )}

        {/* Requesting build: handled by the FullscreenBuildOutput early return
          above (fullscreen takeover, bypasses the too-small gate) — nothing
          renders here in the measured body. */}

        {/* AI debug — ask the user whether to send the captured log */}
        {step === 'ai-analysis-prompt' && (
          <AiAnalysisPromptStep
            dense={dense}
            onChange={async (value) => {
              if (value === 'support') {
                await handleSupport('ai-analysis-prompt')
                return
              }
              if (value === 'debug') {
                // Additive: offer to ALSO upload the logs to Capgo support
                // (upload-only, no mailto) BEFORE the AI analysis runs. This
                // awaits the user's yes/no and any upload, then proceeds.
                await offerAiSupportUpload().catch((err) => { try { appendInternalLog(`[support-flow] ${String(err)}`) } catch {} })
                setStep('ai-analysis-running')
              }
              else {
                if (aiJobId) {
                  await trackAiAnalysisChoice({
                    apikey: resolvedApiKeyRef.current ?? apikey ?? '',
                    orgId: resolvedOrgId ?? '',
                    appId,
                    platform: 'ios',
                    jobId: aiJobId,
                    choice: 'skip',
                    triggeredBy: 'onboarding',
                  }).catch(() => { /* telemetry never breaks the wizard */ })
                }
                setStep('build-complete')
              }
            }}
          />
        )}

        {/* AI debug — spinner while the edge function is running */}
        {step === 'ai-analysis-running' && <AiAnalysisRunningStep streamText={aiStreamPreview} terminalRows={terminalRows} terminalCols={terminalCols} />}

        {step === 'support-uploading' && (
          <Box marginTop={1}>
            <SpinnerLine text={supportBusyText} />
          </Box>
        )}

        {/* AI debug — render the diagnosis (or fallback message), then offer
          retry-or-skip. Retry transitions back to 'requesting-build' so the
          user can rebuild after applying the AI's fix in another terminal,
          without re-running the credential wizard. Capped at MAX_AI_RETRIES. */}
        {step === 'ai-analysis-result' && (
          <AiAnalysisResultStep
            analysisText={aiAnalysisText}
            // Collapse to the compact marker + "Re-read" option only when the
            // user has dismissed the viewer AND the analysis is still too tall to
            // show inline. If the terminal is now big enough, show the full text.
            collapsed={aiViewedFull && !!aiAnalysisText && isAiAnalysisTooTall(aiAnalysisText, terminalRows, terminalCols)}
            result={aiResult}
            canRetry={MAX_AI_RETRIES - aiRetryCount > 0}
            retriesLeft={MAX_AI_RETRIES - aiRetryCount}
            maxRetries={MAX_AI_RETRIES}
            dense={dense}
            onChange={async (value) => {
              if (value === 'support') {
                await handleSupport('ai-analysis-result')
                return
              }
              if (value === 'reread') {
              // Re-open the fullscreen scroll viewer (alt buffer has no
              // scrollback, so this is the only way to re-read).
                setStep('ai-analysis-result-scroll')
                return
              }
              if (value === 'retry') {
              // Track the retry intent before we tear down the AI state so
              // the choice event carries the per-attempt context.
                if (aiJobId) {
                  await trackAiAnalysisChoice({
                    apikey: resolvedApiKeyRef.current ?? apikey ?? '',
                    orgId: resolvedOrgId ?? '',
                    appId,
                    platform: 'ios',
                    jobId: aiJobId,
                    choice: 'retry',
                    triggeredBy: 'onboarding',
                  }).catch(() => { /* telemetry never breaks the wizard */ })
                  // Free the captured log for the previous attempt; the next
                  // attempt's `requestBuildInternal` will create a new file
                  // tied to a new builder_job_id.
                  void releaseCapturedLogs(aiJobId).catch(() => { /* best-effort */ })
                }
                // Reset AI state so the next failure starts clean. The fit
                // check (and possible scroll-viewer route) will re-evaluate
                // against the new analysis text.
                setAiJobId(null)
                setAiAnalysisText(null)
                setAiResult(null)
                setAiViewedFull(false)
                setAiRetryCount(prev => prev + 1)
                setStep('requesting-build')
                return
              }
              // 'skip' (with retries available) or 'continue' (none left).
              setStep('build-complete')
            }}
          />
        )}

        {/* (ai-analysis-result-scroll renders as a fullscreen early return above.) */}

        {/* Contact-support confirmation gate. In 'email' mode it tells the user
          everything that's about to happen (logs saved, revealed in Finder on
          macOS, email opened) and waits for an explicit Yes before the mail
          client opens. In 'ai-upload' mode it's the ADDITIVE upload gate shown
          before AI analysis: a plain yes/no, upload-only (no mailto). */}
        {step === 'support-confirm' && supportConfirmMode === 'ai-upload' && (
          <Box flexDirection="column" marginTop={1} gap={1}>
            <Text bold>Upload logs to Capgo support?</Text>
            <Text>{supportConfirmMessage}</Text>
            <Select
              options={[
                { label: '📤  Yes, upload my logs', value: 'yes' },
                { label: '✖  No, just run AI', value: 'no' },
              ]}
              onChange={(value) => {
                const resolve = supportConfirmResolveRef.current
                supportConfirmResolveRef.current = null
                resolve?.(value === 'yes')
              }}
            />
          </Box>
        )}
        {step === 'support-confirm' && supportConfirmMode === 'email' && (
          <Box flexDirection="column" marginTop={1} gap={1}>
            <Text bold>Email Capgo support</Text>
            <Text>{supportConfirmMessage}</Text>
            <Select
              options={[
                { label: '📨  Yes, send to support', value: 'yes' },
                { label: '👀  View logs first', value: 'view' },
                { label: '✖  Cancel', value: 'no' },
              ]}
              onChange={(value) => {
                if (value === 'view') {
                  let lines: string[] = []
                  try { lines = readFileSync(supportLogPathRef.current, 'utf8').split('\n') }
                  catch { lines = ['(could not read the logs file)'] }
                  setSupportLogLines(lines)
                  setStep('support-log-view')
                  return
                }
                const resolve = supportConfirmResolveRef.current
                supportConfirmResolveRef.current = null
                resolve?.(value === 'yes')
              }}
            />
          </Box>
        )}

        {/* Error with retry */}
        {step === 'error' && error && (
          <ErrorStep
            error={error}
            recoveryAdvice={recoveryAdvice}
            supportBundlePath={supportBundlePath}
            showRetry={!!retryStep}
            dense={dense}
            collapsed={errorTooTall && errorViewedFull}
            hasBuildLog={!!aiJobId}
            showGuidedKey={offerGuidedKeyFallback}
            onChange={async (value) => {
              if (value === 'guided-key') {
                // Fall back to the guided macOS helper after a manual key failed
                // to validate. Clear the error, remember the guided choice, and
                // launch the helper (its intro/consent screen leads).
                setError(null)
                errorCategoryRef.current = undefined
                setOfferGuidedKeyFallback(false)
                await persistP8CreateMethod('automated')
                setStep('asc-key-generating')
              }
              else if (value === 'support') {
                await handleSupport()
              }
              else if (value === 'ai') {
              // A captured build-failure log is available — route into the
              // existing AI-analysis prompt (unchanged from today).
                setStep('ai-analysis-prompt')
              }
              else if (value === 'retry') {
                setError(null)
                errorCategoryRef.current = undefined
                pickerOpenedRef.current = false
                mobileprovisionPickerOpenedRef.current = false
                if (retryStep)
                  setStep(retryStep)
              }
              else if (value === 'restart') {
              // Centralised reset (also clears the per-identity Apple-side
              // availability map + the iOS bundle id confirmation gate — both
              // missing from the previous inline version). The log message
              // stays error-recovery specific.
                await resetForFreshStart()
                addLog('↩️  Onboarding reset — starting fresh', 'yellow')
                setStep('welcome')
              }
              else {
                setError(`Run \`${buildInitCommand}\` to resume.`)
                exitOnboarding()
              }
            }}
          />
        )}

        {/* Done */}
        {step === 'build-complete' && (
          <BuildCompleteStep
            buildUrl={buildUrl}
            ciSecretUploadSummary={ciSecretUploadSummary}
            buildRequestCommand={buildRequestCommand}
            workflowWrittenPath={workflowWrittenPath}
            envExportPath={envExportPath}
            envExportError={envExportError}
            dense={dense}
          />
        )}
      </Box>
    </Box>
  )
}

export default OnboardingApp

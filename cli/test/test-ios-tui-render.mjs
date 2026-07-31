#!/usr/bin/env node
// Render-snapshot BASELINE for the iOS `build init` onboarding step bodies.
//
// The iOS onboarding wizard (src/build/onboarding/ui/app.tsx) renders each step
// body as either (a) a separate, importable ink component in
// ui/steps/ios-shared.tsx / ios-credentials.tsx / ios-import.tsx / ios-ci.tsx,
// or (b) bespoke inline JSX directly in app.tsx. The ink-thin-wrapper migration
// will move the FLOW into the shared iOS engine while keeping the RENDERING in
// ink. This test pins the CURRENT rendering of every iOS step body that is
// renderable in ISOLATION — i.e. the importable ink components — so the
// post-migration rendering can be diffed against this behaviour baseline.
//
// Each case renders the real component through the shared frame-fit harness
// (ink render → plain frame text, see test/helpers/frame-fit.mjs) with
// representative props and asserts the rendered text CONTAINS the key content
// (titles, Select option labels, prompts, numbered instructions, table rows,
// error/recovery copy). It does NOT assert exact frames or row budgets — the
// budget contract is covered elsewhere; this is a content/presence snapshot.
//
// DETERMINISM: renderFrameText is synchronous (single ink commit, debug frame).
// We only assert on STATIC copy, never on the animated spinner glyph (the
// spinner's first dots-frame is non-deterministic across runs), so every
// assertion is stable. The fullscreen viewers are not iOS-step bodies — the iOS
// flow shares the same FullscreenBuildOutput / FullscreenDiffViewer /
// FullscreenAiViewer pinned by test-android-tail-render.mjs, so they're not
// re-pinned here.
//
// COVERAGE NOTE (importable vs inline-only). Covered here (importable from
// ui/steps/ios-shared.tsx, ios-credentials.tsx, ios-import.tsx, ios-ci.tsx):
//   welcome, platform-select, no-platform, adding-platform, credentials-exist,
//   backing-up, setup-method-select, api-key-instructions (picker + manual
//   forms), p8-method-select, input-p8-path, input-key-id (detected + fresh),
//   input-issuer-id, verifying-key, creating-certificate, cert-limit-prompt,
//   revoking-certificate, creating-profile, duplicate-profile-prompt,
//   deleting-duplicate-profiles, saving-credentials, ai-analysis-prompt,
//   ai-analysis-running, ai-analysis-result (inline / collapsed /
//   banner-exhausted / last-retry), error (full + collapsed), build-complete
//   (bare / build-url / ci-summary / workflow / env-export / env-error), the
//   import steps (import-scanning, import-distribution-mode, import-pick-identity
//   flat-list, import-pick-profile, import-no-match-recovery for every
//   NoMatchReason, import-create-profile-only, import-export-warning,
//   import-exporting), and the CI steps
//   (detecting-ci-secrets, ci-secrets-setup, ci-secrets-target-select,
//   ask-ci-secrets, confirm-ci-secret-overwrite, ci-secrets-failed, ask-build).
//
//   NOT covered here — these iOS step bodies are inline-JSX-only in app.tsx (no
//   importable component), so they rely on the parity review + manual test
//   instead: resume-prompt, verify-app (loader + picker + gate forms),
//   import-validating-all-certs, import-checking-apple-cert, import-pick-identity
//   TWO-TABLE classified form (Table-based; only the flat-list
//   ImportPickIdentityStep is importable), import-provide-profile-path,
//   import-portal-explanation (app_store + ad_hoc walkthroughs),
//   ask-github-actions-setup, ask-export-env, exporting-env,
//   confirm-env-export-overwrite, pick-package-manager, pick-build-script,
//   pick-build-script-custom, preview-workflow-file (DiffSummary wrapper —
//   DiffSummary itself is pinned by the android test), writing-workflow-file,
//   checking-ci-secrets, confirm-secrets-push (SecretsTable wrapper —
//   SecretsTable itself is pinned by the android test), uploading-ci-secrets,
//   and the requesting-build / view-workflow-diff / ai-analysis-result-scroll
//   fullscreen takeovers.
import React from 'react'
import {
  AskBuildStep,
  AskCiSecretsStep,
  CiSecretsFailedStep,
  CiSecretsSetupStep,
  CiSecretsTargetSelectStep,
  ConfirmCiSecretOverwriteStep,
  DetectingCiSecretsStep,
} from '../src/build/onboarding/ui/steps/ios-ci.tsx'
import {
  ApiKeyInstructionsStep,
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
  RevokingCertificateStep,
  SavingCredentialsStep,
  SetupMethodSelectStep,
  VerifyingKeyStep,
} from '../src/build/onboarding/ui/steps/ios-credentials.tsx'
import {
  ImportCreateProfileOnlyStep,
  ImportDistributionModeStep,
  ImportExportingStep,
  ImportExportWarningStep,
  ImportNoMatchRecoveryStep,
  ImportPickIdentityStep,
  ImportPickProfileStep,
  ImportScanningStep,
} from '../src/build/onboarding/ui/steps/ios-import.tsx'
import {
  AddingPlatformStep,
  AiAnalysisPromptStep,
  AiAnalysisResultStep,
  AiAnalysisRunningStep,
  BuildCompleteStep,
  ErrorStep,
  NoPlatformStep,
  PlatformSelectStep,
  WelcomeStep,
} from '../src/build/onboarding/ui/steps/ios-shared.tsx'
import { renderFrameText } from './helpers/frame-fit.mjs'

const h = React.createElement
const noop = () => {}

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`✔ ${name}`)
  }
  catch (error) {
    failed++
    console.error(`✖ ${name}\n  ${error.message}`)
  }
}

// Render `element` (optionally at a given terminal size) and assert the plain
// frame text contains EVERY needle. On a miss the rendered frame is included so
// the failing snapshot pinpoints what drifted.
function assertContains(element, needles, label, { cols = 80, rows } = {}) {
  const frame = renderFrameText(element, cols, rows)
  for (const needle of needles) {
    if (!frame.includes(needle)) {
      throw new Error(
        `"${label}" rendered frame is missing expected content: ${JSON.stringify(needle)}\n`
        + `Rendered ${cols}-col frame:\n${frame}`,
      )
    }
  }
}

// ── PROJECT-LEVEL FRAMES (ios-shared.tsx) ─────────────────────────────────────

// welcome (spinner)
test('welcome shows the detecting-project spinner copy', () => {
  assertContains(h(WelcomeStep), ['Detecting project...'], 'welcome')
})

// platform-select — detected project + iOS/Android picker
test('platform-select shows the detected project, the prompt and both platforms', () => {
  assertContains(
    h(PlatformSelectStep, { appId: 'com.example.app', onChange: noop }),
    [
      'Detected Capacitor project',
      'com.example.app',
      'Which platform do you want to set up?',
      'iOS',
      'Android',
    ],
    'platform-select',
  )
})

// no-platform — missing native dir + run/recheck/exit control
test('no-platform shows the missing-dir error, the suggested commands and the control', () => {
  assertContains(
    h(NoPlatformStep, {
      iosDir: 'ios',
      addIosCommand: 'npx cap add ios',
      syncIosCommand: 'npx cap sync ios',
      onChange: noop,
    }),
    [
      'No ios/ directory found.',
      // Body sentence wraps at 80 cols ("…before credentials can" / "be created."),
      // so assert the un-wrapped head + the tail separately.
      'This onboarding flow needs a generated native iOS project before credentials',
      'be created.',
      'Suggested commands: npx cap add ios && npx cap sync ios',
      'Run npx cap add ios now',
      'I already fixed it, re-check',
      'Exit onboarding',
    ],
    'no-platform',
  )
})

// adding-platform (spinner + doctor hint)
test('adding-platform shows the running spinner copy and the doctor fallback hint', () => {
  assertContains(
    h(AddingPlatformStep, { addIosCommand: 'npx cap add ios', doctorCommand: 'npx cap doctor' }),
    [
      'Running npx cap add ios...',
      'If this still fails, try npx cap doctor',
      'support bundle path',
    ],
    'adding-platform',
  )
})

// ── CREATE-NEW CREDENTIAL STEPS (ios-credentials.tsx) ─────────────────────────

// credentials-exist — overwrite warning + backup/exit control
test('credentials-exist shows the warning, the replace sentence and the backup/exit control', () => {
  assertContains(
    h(CredentialsExistStep, { appId: 'com.example.app', onChange: noop }),
    [
      'iOS credentials already exist for',
      'com.example.app',
      // Sentence wraps at 80 cols ("…your existing" / "credentials."), assert head + tail.
      'Onboarding will create new certificates and profiles, replacing your existing',
      'credentials.',
      'Start fresh (backup existing credentials first)',
      'Exit onboarding',
    ],
    'credentials-exist',
  )
})

// backing-up (spinner)
test('backing-up shows the backup spinner copy', () => {
  assertContains(h(BackingUpStep), ['Backing up existing credentials...'], 'backing-up')
})

// setup-method-select — create/import fork + tip
test('setup-method-select shows the prompt, both methods and the import tip', () => {
  assertContains(
    h(SetupMethodSelectStep, { onChange: noop }),
    [
      'How do you want to set up iOS credentials?',
      'Create new via App Store Connect API',
      'Import existing from this Mac (Keychain + Xcode profiles)',
      // Tip wraps at 80 cols ("…doesn't" / "count against…"), assert head + tail.
      'Tip: Importing reuses the certificate Xcode already installed',
      'count against Apple\'s 3-cert limit.',
    ],
    'setup-method-select',
  )
})

// api-key-instructions (picker form) — info alert + 4 numbered steps + Ctrl+O hint + picker fork
test('api-key-instructions (picker) shows the alert, the four numbered steps, the Ctrl+O hint and the picker fork', () => {
  assertContains(
    h(ApiKeyInstructionsStep, { canUseFilePicker: true, onMethodChange: noop, onPathSubmit: noop }),
    [
      // Alert wraps inside the box ("…certificates and profiles" / "for you."), assert head.
      'We need an App Store Connect API key to manage certificates and profiles',
      'appstoreconnect.apple.com/access/integrations/api',
      'Generate API Key',
      'Capgo Builder',
      'Admin',
      'Download the',
      'to open App Store Connect in your browser',
      'How do you want to provide the .p8 file?',
      'Open file picker',
      'Type the path',
    ],
    'api-key-instructions-picker',
  )
})

// api-key-instructions (no-picker form) — direct path input
test('api-key-instructions (no picker) shows the direct .p8 path prompt and placeholder', () => {
  assertContains(
    h(ApiKeyInstructionsStep, { canUseFilePicker: false, onMethodChange: noop, onPathSubmit: noop }),
    [
      // Alert wraps inside the box ("…certificates and profiles" / "for you."), assert head.
      'We need an App Store Connect API key to manage certificates and profiles',
      'Path to your .p8 file:',
      'AuthKey_XXXXXXXXXX.p8',
    ],
    'api-key-instructions-manual',
  )
})

// p8-method-select (spinner)
test('p8-method-select shows the file-picker spinner copy', () => {
  assertContains(h(P8MethodSelectStep), ['Opening file picker...'], 'p8-method-select')
})

// input-p8-path — label + placeholder
test('input-p8-path shows the .p8 path prompt and the placeholder', () => {
  assertContains(
    h(InputP8PathStep, { onSubmit: noop }),
    ['Path to your .p8 file:', 'AuthKey_XXXXXXXXXX.p8'],
    'input-p8-path',
  )
})

// input-key-id (detected) — pre-confirm the detected key id
test('input-key-id shows the detected key id, the confirm hint and the value', () => {
  assertContains(
    h(InputKeyIdStep, { keyId: 'ABC123DEF', onSubmit: noop }),
    [
      'Key ID',
      '(detected from filename)',
      'ABC123DEF',
      'press Enter to confirm, or type a different one',
    ],
    'input-key-id-detected',
  )
})

// input-key-id (fresh) — prompt for it with the ASC hint + placeholder
test('input-key-id (no detection) shows the App Store Connect hint', () => {
  assertContains(
    h(InputKeyIdStep, { keyId: '', onSubmit: noop }),
    [
      'Key ID',
      '(shown next to the key name in App Store Connect)',
    ],
    'input-key-id-fresh',
  )
})

// input-issuer-id — UUID prompt + Ctrl+O hint + placeholder
test('input-issuer-id shows the issuer-id prompt, the Ctrl+O hint and the UUID placeholder', () => {
  assertContains(
    h(InputIssuerIdStep, { onSubmit: noop }),
    [
      'Issuer ID',
      '(UUID at the very top of the API keys page, above the key list)',
      'to open App Store Connect in your browser',
      'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    ],
    'input-issuer-id',
  )
})

// verifying-key (spinner)
test('verifying-key shows the Apple-verify spinner copy', () => {
  assertContains(h(VerifyingKeyStep), ['Verifying API key with Apple...'], 'verifying-key')
})

// creating-certificate (two spinners)
test('creating-certificate shows the CSR + distribution-certificate spinner copy', () => {
  assertContains(
    h(CreatingCertificateStep),
    ['Generating signing key and CSR...', 'Creating Apple Distribution certificate...'],
    'creating-certificate',
  )
})

// cert-limit-prompt — Apple 3-cert limit + revoke picker
test('cert-limit-prompt shows the limit error, the revoke prompt and the provided cert rows', () => {
  assertContains(
    h(CertLimitPromptStep, {
      existingCount: 3,
      options: [
        { label: '🗑️   Distribution: Old Cert · expires 2025-01-01', value: 'cert-a' },
        { label: '🗑️   Distribution: Capgo Cert · expires 2026-01-01 · 🔧 Created by Capgo', value: 'cert-b' },
        { label: '✖  Exit onboarding', value: '__exit__' },
      ],
      onChange: noop,
    }),
    [
      'Apple Distribution certificate limit reached (3 existing).',
      'Select a certificate to revoke:',
      'Distribution: Old Cert',
      'Created by Capgo',
      'Exit onboarding',
    ],
    'cert-limit-prompt',
  )
})

// revoking-certificate (spinner)
test('revoking-certificate shows the revoke spinner copy', () => {
  assertContains(h(RevokingCertificateStep), ['Revoking old certificate...'], 'revoking-certificate')
})

// creating-profile — bundle-id confirmation + spinner
test('creating-profile shows the bundle-id confirmation and the profile-creation spinner', () => {
  assertContains(
    h(CreatingProfileStep, { appId: 'com.example.app' }),
    ['Bundle ID', 'com.example.app', 'Creating App Store provisioning profile...'],
    'creating-profile',
  )
})

// duplicate-profile-prompt — existing-profile warning + delete/exit control
test('duplicate-profile-prompt shows the duplicate count, the question and the delete/exit control', () => {
  assertContains(
    h(DuplicateProfilePromptStep, { duplicateCount: 2, onChange: noop }),
    [
      'Found 2 existing Capgo profile(s) for this app.',
      'Delete old profiles and create a new one?',
      'Yes, delete old profiles and recreate',
      'No, exit onboarding',
    ],
    'duplicate-profile-prompt',
  )
})

// deleting-duplicate-profiles (spinner)
test('deleting-duplicate-profiles shows the pluralized delete spinner copy', () => {
  assertContains(
    h(DeletingDuplicateProfilesStep, { duplicateCount: 2 }),
    ['Deleting 2 old profile(s)...'],
    'deleting-duplicate-profiles',
  )
})

// saving-credentials (spinner)
test('saving-credentials shows the saving spinner copy', () => {
  assertContains(h(SavingCredentialsStep), ['Saving credentials...'], 'saving-credentials')
})

// ── IMPORT STEPS (ios-import.tsx) ─────────────────────────────────────────────

// import-scanning (spinner + read-only note)
test('import-scanning shows the Keychain-scan spinner and the read-only note', () => {
  assertContains(
    h(ImportScanningStep),
    [
      'Scanning Keychain and provisioning profiles...',
      'This is read-only — no Keychain password prompt yet.',
    ],
    'import-scanning',
  )
})

// import-distribution-mode — App Store / Ad-hoc / Cancel + bullets
test('import-distribution-mode shows the prompt, both mode bullets and the three choices', () => {
  assertContains(
    h(ImportDistributionModeStep, { onChange: noop }),
    [
      'How will Capgo distribute your build?',
      'App Store: builds upload to TestFlight automatically',
      // Ad-hoc bullet wraps at 80 cols ("…installed via" / "QR. No ASC key needed.").
      'Ad-hoc: builds are signed and either downloaded from Capgo or installed via',
      'QR. No ASC key needed.',
      'App Store / TestFlight',
      'Ad-hoc (no TestFlight upload)',
      'Cancel and use Create new instead',
    ],
    'import-distribution-mode',
  )
})

// import-pick-identity (flat-list / unclassified form) — header + identity rows + cancel
test('import-pick-identity (flat list) shows the pluralized header and the identity + cancel rows', () => {
  assertContains(
    h(ImportPickIdentityStep, {
      identityCount: 2,
      options: [
        { label: '🔑  iPhone Distribution: Acme Inc · 2 matching profiles', value: 'sha-a' },
        { label: '🔑  iPhone Distribution: Other Co · ⚠ no matching profiles on this Mac (recovery available)', value: 'sha-b' },
        { label: '↩️   Cancel and use Create new instead', value: '__cancel__' },
      ],
      onChange: noop,
    }),
    [
      'Found 2 distribution identities in your Keychain. Pick one:',
      'iPhone Distribution: Acme Inc · 2 matching profiles',
      // The long second option label wraps ("…on this Mac" / "(recovery available)").
      'no matching profiles on this Mac',
      '(recovery available)',
      'Cancel and use Create new instead',
    ],
    'import-pick-identity',
  )
})

test('import-pick-identity uses the singular noun for a single identity', () => {
  assertContains(
    h(ImportPickIdentityStep, {
      identityCount: 1,
      options: [
        { label: '🔑  iPhone Distribution: Acme Inc · 1 matching profile', value: 'sha-a' },
        { label: '↩️   Cancel and use Create new instead', value: '__cancel__' },
      ],
      onChange: noop,
    }),
    ['Found 1 distribution identity in your Keychain. Pick one:'],
    'import-pick-identity-singular',
  )
})

// import-pick-profile — matched header + dropped hint + profile rows + back row
test('import-pick-profile shows the matched header, the dropped hint and the profile + back rows', () => {
  assertContains(
    h(ImportPickProfileStep, {
      matchedCount: 1,
      droppedCount: 2,
      distribution: 'app_store',
      options: [
        { label: '📜  Capgo App Store · bundle com.example.app · IOS_APP_STORE · expires 2026-03-01', value: 'uuid-a' },
        { label: '↩️   Back to identity selection', value: '__back__' },
      ],
      onChange: noop,
    }),
    [
      // Header wraps at 80 cols ("…and app_store" / "distribution):"), assert head + tail.
      'Pick a provisioning profile (1 matching this app\'s bundle ID and app_store',
      'distribution):',
      '2 other profiles hidden — wrong bundle ID or distribution mode',
      'Capgo App Store · bundle com.example.app',
      'Back to identity selection',
    ],
    'import-pick-profile',
  )
})

// import-no-match-recovery — Alert + hint + recovery option list, per NoMatchReason
const RECOVERY_OPTIONS = [
  { label: '✨  Create a new App Store profile for this cert via Apple', value: 'create' },
  { label: '📁  Use a .mobileprovision file from disk', value: 'provide-profile-path' },
  { label: '🌐  Open Apple Developer Portal (browse / create profiles manually)', value: 'browser' },
  { label: '↩️   Back to identity selection', value: 'back' },
]

test('import-no-match-recovery (default/no-profile-on-disk) shows the on-disk alert, the hint and the recovery options', () => {
  assertContains(
    h(ImportNoMatchRecoveryStep, {
      identityName: 'iPhone Distribution: Acme Inc',
      options: RECOVERY_OPTIONS,
      onChange: noop,
    }),
    [
      // Alert wraps inside the box ("…linked to \"iPhone Distribution:" / "Acme Inc\".")
      // and the hint wraps ("…Pick a" / "recovery path:"); assert wrap-safe sub-phrases.
      'No provisioning profile on this Mac is linked to "iPhone Distribution:',
      'Acme Inc".',
      'The cert is in your Keychain but the matching profile isn\'t on disk. Pick a',
      'recovery path:',
      'Create a new App Store profile for this cert via Apple',
      'Use a .mobileprovision file from disk',
      'Open Apple Developer Portal',
      'Back to identity selection',
    ],
    'import-no-match-recovery-default',
  )
})

test('import-no-match-recovery (apple-no-cert-match) names the revoked/unknown cert + re-issue hint', () => {
  assertContains(
    h(ImportNoMatchRecoveryStep, {
      identityName: 'Acme Cert',
      reason: 'apple-no-cert-match',
      options: RECOVERY_OPTIONS,
      onChange: noop,
    }),
    [
      'Apple\'s records don\'t include the certificate "Acme Cert".',
      // Hint wraps at 80 cols ("…re-issued in the Apple" / "Developer Portal first.").
      'the certificate needs to be re-issued in the Apple',
      'Developer Portal first.',
    ],
    'import-no-match-recovery-no-cert',
  )
})

test('import-no-match-recovery (apple-no-profiles-linked) explains zero linked profiles + create hint', () => {
  assertContains(
    h(ImportNoMatchRecoveryStep, {
      identityName: 'Acme Cert',
      reason: 'apple-no-profiles-linked',
      options: RECOVERY_OPTIONS,
      onChange: noop,
    }),
    [
      // Alert wraps inside the box ("…profiles are" / "linked to it yet.") and the hint
      // wraps ("…one for this cert" / "via the Apple API."); assert wrap-safe sub-phrases.
      'Apple has the certificate "Acme Cert" but no provisioning profiles are',
      'linked to it yet.',
      '"Create a new App Store profile" makes one for this cert',
      'via the Apple API.',
    ],
    'import-no-match-recovery-no-profiles',
  )
})

test('import-no-match-recovery (apple-bundle-mismatch) names the app bundle id', () => {
  assertContains(
    h(ImportNoMatchRecoveryStep, {
      identityName: 'Acme Cert',
      reason: 'apple-bundle-mismatch',
      appId: 'com.example.app',
      options: RECOVERY_OPTIONS,
      onChange: noop,
    }),
    [
      'Apple has profiles for "Acme Cert" but none target "com.example.app".',
      // Hint wraps at 80 cols ("…makes one for" / "\"com.example.app\".").
      'makes one for',
      '"com.example.app".',
    ],
    'import-no-match-recovery-bundle',
  )
})

test('import-no-match-recovery (apple-distribution-mismatch) names the distribution mode', () => {
  assertContains(
    h(ImportNoMatchRecoveryStep, {
      identityName: 'Acme Cert',
      reason: 'apple-distribution-mismatch',
      appId: 'com.example.app',
      importDistribution: 'app_store',
      options: RECOVERY_OPTIONS,
      onChange: noop,
    }),
    [
      // Alert wraps inside the box ("…but none are" / "app_store."); assert head + tail.
      'Apple has profiles for "com.example.app" under "Acme Cert" but none are',
      'app_store.',
      're-run with the matching distribution mode',
    ],
    'import-no-match-recovery-distribution',
  )
})

test('import-no-match-recovery (apple-other) shows the catch-all alert + generic hint', () => {
  assertContains(
    h(ImportNoMatchRecoveryStep, {
      identityName: 'Acme Cert',
      reason: 'apple-other',
      options: RECOVERY_OPTIONS,
      onChange: noop,
    }),
    [
      'Apple returned profiles for "Acme Cert" but none match this app.',
      'Pick a recovery path:',
    ],
    'import-no-match-recovery-other',
  )
})

// import-create-profile-only (spinner + cert-reuse note)
test('import-create-profile-only shows the create-profile spinner and the cert-reuse note', () => {
  assertContains(
    h(ImportCreateProfileOnlyStep),
    [
      'Creating a new App Store profile via Apple for your existing certificate...',
      '(Skipping cert creation — using the cert already in your Keychain.)',
    ],
    'import-create-profile-only',
  )
})

// import-export-warning — Keychain-permission warning + 3 steps + export/back/exit
test('import-export-warning shows the permission warning, the three numbered steps and the export/back/exit control', () => {
  assertContains(
    h(ImportExportWarningStep, { identityName: 'iPhone Distribution: Acme Inc', onChange: noop }),
    [
      'macOS will now ask permission to access your private key.',
      // Step 1 quotes the macOS dialog text, which wraps ("…use your" / "confidential
      // information"); assert head + tail. Steps 2/3 fit one line each.
      'security wants to use your',
      'confidential information',
      'Always Allow',
      'so it doesn\'t ask again on retry',
      'That\'s the only prompt — the export is otherwise non-interactive',
      'Export "iPhone Distribution: Acme Inc" now',
      'Back',
      'Exit onboarding',
    ],
    'import-export-warning',
  )
})

// import-exporting (spinner + dialog-not-found note)
test('import-exporting shows the export spinner and the missing-dialog note', () => {
  assertContains(
    h(ImportExportingStep),
    [
      'Exporting from Keychain — check for the macOS dialog...',
      'If you don\'t see a dialog, look behind other windows or check the menu bar.',
    ],
    'import-exporting',
  )
})

// ── CI-SECRETS STEPS (ios-ci.tsx) ─────────────────────────────────────────────

// detecting-ci-secrets (spinner)
test('detecting-ci-secrets shows the git-hosting check copy', () => {
  assertContains(h(DetectingCiSecretsStep), ['Checking git hosting...'], 'detecting-ci-secrets')
})

// ci-secrets-setup — heading + per-provider advice + retry/skip
test('ci-secrets-setup shows the heading, provider advice, commands and the retry/skip control', () => {
  assertContains(
    h(CiSecretsSetupStep, {
      advice: [{
        target: { provider: 'github', label: 'GitHub (gh CLI)', cli: 'gh' },
        reason: 'not-installed',
        message: 'gh is not installed.',
        commands: ['brew install gh', 'gh auth login'],
      }],
      onChange: noop,
    }),
    [
      'Set up your git hosting CLI to upload env vars',
      'GitHub (gh CLI)',
      'gh is not installed.',
      'brew install gh',
      'gh auth login',
      'Run this in another terminal, then come back here.',
      'I installed and logged in, check again',
      'Skip upload',
    ],
    'ci-secrets-setup',
  )
})

// ci-secrets-target-select — provider picker
test('ci-secrets-target-select shows the prompt and the provided options', () => {
  assertContains(
    h(CiSecretsTargetSelectStep, {
      options: [
        { label: 'GitHub Actions repository secrets', value: 'github' },
        { label: 'GitLab CI/CD variables', value: 'gitlab' },
        { label: 'Skip', value: 'skip' },
      ],
      onChange: noop,
    }),
    [
      'Where should Capgo upload the build env vars?',
      'GitHub Actions repository secrets',
      'GitLab CI/CD variables',
      'Skip',
    ],
    'ci-secrets-target-select',
  )
})

// ask-ci-secrets — pluralized upload prompt + confirm CLI option
test('ask-ci-secrets shows the saved line, the pluralized prompt and the CLI upload option', () => {
  assertContains(
    h(AskCiSecretsStep, {
      entryCount: 3,
      target: { provider: 'github', label: 'GitHub Actions', cli: 'gh' },
      targetLabel: 'GitHub Actions',
      onChange: noop,
    }),
    [
      'Credentials saved',
      'Upload 3 build env vars to GitHub Actions?',
      'Capgo will check for existing names first and ask before replacing anything.',
      'Upload with gh',
      'Skip',
    ],
    'ask-ci-secrets',
  )
})

test('ask-ci-secrets uses the singular noun for a single env var', () => {
  assertContains(
    h(AskCiSecretsStep, {
      entryCount: 1,
      target: { provider: 'gitlab', label: 'GitLab CI/CD', cli: 'glab' },
      targetLabel: 'GitLab CI/CD',
      onChange: noop,
    }),
    ['Upload 1 build env var to GitLab CI/CD?', 'Upload with glab'],
    'ask-ci-secrets-singular',
  )
})

// confirm-ci-secret-overwrite — existing-key list + replace/skip
test('confirm-ci-secret-overwrite lists the existing keys and the replace/skip control', () => {
  assertContains(
    h(ConfirmCiSecretOverwriteStep, {
      existingKeys: ['CAPGO_TOKEN', 'APPLE_KEY_CONTENT'],
      onChange: noop,
    }),
    [
      'These env vars already exist and will be replaced:',
      '• CAPGO_TOKEN',
      '• APPLE_KEY_CONTENT',
      'Replace existing env vars',
      'Skip upload',
    ],
    'confirm-ci-secret-overwrite',
  )
})

// ci-secrets-failed — error string + retry/continue
test('ci-secrets-failed shows the error string, the saved-locally reassurance and the retry/continue control', () => {
  assertContains(
    h(CiSecretsFailedStep, { error: 'gh: HTTP 403 — token lacks repo scope', onChange: noop }),
    [
      'gh: HTTP 403 — token lacks repo scope',
      'You can continue; credentials are already saved locally.',
      'Try upload again',
      'Continue without upload',
    ],
    'ci-secrets-failed',
  )
})

test('ci-secrets-failed falls back to a default message when error is null', () => {
  assertContains(
    h(CiSecretsFailedStep, { error: null, onChange: noop }),
    ['Could not upload env vars.', 'Try upload again'],
    'ci-secrets-failed-null',
  )
})

// ask-build — final request-a-build prompt
test('ask-build shows the saved line, the prompt and the build-now/later control', () => {
  assertContains(
    h(AskBuildStep, { onChange: noop }),
    [
      'Credentials saved',
      'Start your first cloud build now?',
      'Yes, build now',
      'No, I\'ll build later',
    ],
    'ask-build',
  )
})

// ── AI ANALYSIS + ERROR + BUILD-COMPLETE (ios-shared.tsx) ─────────────────────

// ai-analysis-prompt — offer to debug with Capgo AI
test('ai-analysis-prompt shows the build-failed line, the offer and the debug/skip control', () => {
  assertContains(
    h(AiAnalysisPromptStep, { onChange: noop }),
    [
      'Build failed.',
      'We can analyze the build log with Capgo AI and suggest a fix.',
      'Debug with AI',
      'Skip',
    ],
    'ai-analysis-prompt',
  )
})

// ai-analysis-running (spinner)
test('ai-analysis-running shows the analyzing spinner copy', () => {
  assertContains(
    h(AiAnalysisRunningStep),
    ['Analyzing build log with Capgo AI...'],
    'ai-analysis-running',
  )
})

// ai-analysis-result (inline) — diagnosis + caution + retry/skip
test('ai-analysis-result shows the inline diagnosis, the AI caution and the retry/skip control', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: 'CODE_SIGN_IDENTITY is unset — add it to the build settings and retry.',
      collapsed: false,
      result: null,
      canRetry: true,
      retriesLeft: 2,
      maxRetries: 2,
      onChange: noop,
    }),
    [
      'AI analysis',
      'CODE_SIGN_IDENTITY is unset — add it to the build settings and retry.',
      'AI can make mistakes',
      'I fixed it, retry build (2 retries left)',
      'Continue (skip retry)',
    ],
    'ai-analysis-result-inline',
  )
})

test('ai-analysis-result uses the last-retry label when one retry remains', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: 'short diagnosis',
      collapsed: false,
      result: null,
      canRetry: true,
      retriesLeft: 1,
      maxRetries: 2,
      onChange: noop,
    }),
    ['I fixed it, retry build (last retry)'],
    'ai-analysis-result-last-retry',
  )
})

// ai-analysis-result (collapsed) — scroll-viewer marker + re-read option
test('ai-analysis-result shows the collapsed reviewed-marker and the re-read option', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: 'a'.repeat(200),
      collapsed: true,
      result: null,
      canRetry: true,
      retriesLeft: 2,
      maxRetries: 2,
      onChange: noop,
    }),
    [
      'Analysis reviewed — pick an option below, or re-read it.',
      'Re-read analysis',
    ],
    'ai-analysis-result-collapsed',
  )
})

// ai-analysis-result (banner + retries exhausted) — non-success banner + continue
test('ai-analysis-result shows a non-success banner and the exhausted-retries continue control', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: null,
      collapsed: false,
      result: { kind: 'error', message: 'AI analysis failed: (status 500) internal error.' },
      canRetry: false,
      retriesLeft: 0,
      maxRetries: 2,
      onChange: noop,
    }),
    [
      'AI analysis failed: (status 500) internal error.',
      'You\'ve used all 2 retries.',
      'Continue',
    ],
    'ai-analysis-result-banner-exhausted',
  )
})

// error (full form) — recovery plan + commands + docs + support bundle + control
test('error (full form) shows the error, the recovery plan, commands, docs, support bundle and the action control', () => {
  assertContains(
    h(ErrorStep, {
      error: 'Apple API key verification failed (401).',
      recoveryAdvice: {
        summary: ['Double-check the Key ID + Issuer ID', 'Confirm the .p8 has Admin access'],
        commands: ['cat ~/Downloads/AuthKey_ABC123DEF.p8'],
        docs: ['https://capgo.app/docs/cli/ios-credentials'],
      },
      supportBundlePath: '/tmp/capgo-support-bundle.zip',
      showRetry: true,
      onChange: noop,
    }),
    [
      'Apple API key verification failed (401).',
      'Recovery plan',
      '• Double-check the Key ID + Issuer ID',
      '• Confirm the .p8 has Admin access',
      'Helpful commands',
      'cat ~/Downloads/AuthKey_ABC123DEF.p8',
      'Docs',
      'https://capgo.app/docs/cli/ios-credentials',
      'Support bundle',
      '/tmp/capgo-support-bundle.zip',
      'What do you want to do?',
      'Try again',
      'Restart onboarding',
      'Exit',
    ],
    'error-full',
  )
})

// error (collapsed form) — headline + action control only (advice shown in viewer)
test('error (collapsed form) shows only the error headline and the action control', () => {
  assertContains(
    h(ErrorStep, {
      error: 'Apple API key verification failed (401).',
      recoveryAdvice: {
        summary: ['Double-check the Key ID + Issuer ID'],
        commands: [],
        docs: [],
      },
      supportBundlePath: null,
      showRetry: true,
      collapsed: true,
      onChange: noop,
    }),
    [
      'Apple API key verification failed (401).',
      'What do you want to do?',
      'Try again',
      'Restart onboarding',
      'Exit',
    ],
    'error-collapsed',
  )
})

// build-complete (bare) — completion box + finish hint, no build kicked off
test('build-complete (bare) shows the all-set box, the credentials-ready line and the finish hint', () => {
  assertContains(
    h(BuildCompleteStep, {
      buildUrl: '',
      ciSecretUploadSummary: null,
      buildRequestCommand: 'npx @capgo/cli build request',
    }),
    [
      'You\'re all set!',
      'Your iOS credentials are saved and ready to use.',
      'anytime to start a build.',
      'Press Enter to finish',
    ],
    'build-complete-bare',
  )
})

// build-complete (build kicked off) — cloud-build detail + tracking url
test('build-complete surfaces the cloud-build line and the tracking url when a build was kicked off', () => {
  assertContains(
    h(BuildCompleteStep, {
      buildUrl: 'https://console.capgo.app/app/com.example.app/builds',
      ciSecretUploadSummary: null,
      buildRequestCommand: 'npx @capgo/cli build request',
    }),
    [
      'You\'re all set!',
      'Your iOS app is building in the cloud.',
      'Track it at',
      'https://console.capgo.app/app/com.example.app/builds',
      'Press Enter to finish',
    ],
    'build-complete-build-url',
  )
})

// build-complete (ci summary) — uploaded-env-vars summary line
test('build-complete surfaces the CI upload summary when env vars were pushed', () => {
  assertContains(
    h(BuildCompleteStep, {
      buildUrl: '',
      ciSecretUploadSummary: 'Uploaded 5 env vars to GitHub Actions',
      buildRequestCommand: 'npx @capgo/cli build request',
    }),
    ['Uploaded 5 env vars to GitHub Actions.'],
    'build-complete-ci-summary',
  )
})

// build-complete (workflow written) — workflow path + dispatch hint
test('build-complete surfaces the written workflow path and the dispatch hint', () => {
  assertContains(
    h(BuildCompleteStep, {
      buildUrl: '',
      ciSecretUploadSummary: null,
      buildRequestCommand: 'npx @capgo/cli build request',
      workflowWrittenPath: '/repo/.github/workflows/capgo-build.yml',
    }),
    [
      'Workflow file written:',
      '/repo/.github/workflows/capgo-build.yml',
      'Dispatch it from GitHub Actions to kick off a build',
    ],
    'build-complete-workflow',
  )
})

// build-complete (env export) — exported path + push hint + gitignore warning
test('build-complete surfaces the .env export path, the push hint and the gitignore warning', () => {
  assertContains(
    h(BuildCompleteStep, {
      buildUrl: '',
      ciSecretUploadSummary: null,
      buildRequestCommand: 'npx @capgo/cli build request',
      envExportPath: '/repo/.env.capgo.com.example.app.ios',
    }),
    [
      'Credentials exported to:',
      '/repo/.env.capgo.com.example.app.ios',
      // The "push them with `gh secret set -f <file>`" hint wraps, so assert
      // the un-wrapped command head + the gitignore warning separately.
      'gh secret set -f',
      '.gitignore',
    ],
    'build-complete-env-export',
  )
})

// build-complete (env export error) — non-fatal export failure
test('build-complete surfaces a non-fatal .env export error', () => {
  assertContains(
    h(BuildCompleteStep, {
      buildUrl: '',
      ciSecretUploadSummary: null,
      buildRequestCommand: 'npx @capgo/cli build request',
      envExportError: 'permission denied writing to /repo',
    }),
    ['Could not export .env:', 'permission denied writing to /repo'],
    'build-complete-env-error',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

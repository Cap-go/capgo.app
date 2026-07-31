#!/usr/bin/env node
// Render-snapshot BASELINE for the Android post-build "tail" step bodies.
//
// The Android onboarding wizard's tail (Phase 6: save-credentials → CI-secrets
// push → GitHub-Actions-workflow → optional .env export → request-build → AI
// debug → build-complete) currently renders each step body as bespoke JSX in
// src/build/onboarding/android/ui/app.tsx. The ink-thin-wrapper migration will
// move the FLOW into the shared tail engine while keeping the RENDERING in ink.
// This test pins the CURRENT (bespoke) rendering of every tail step body that is
// renderable in ISOLATION — i.e. the separate, importable ink components the
// tail's CHOICE / INPUT / viewer steps delegate to — so the post-migration
// rendering can be diffed against this behaviour baseline.
//
// Each case renders the real component through the shared frame-fit harness
// (ink render → plain frame text, see test/helpers/frame-fit.mjs) with
// representative props and asserts the rendered text CONTAINS the key content
// (titles, Select option labels, streamed log lines, error strings). It does
// NOT assert exact frames or row budgets — the budget contract is covered by
// test-frame-fit-android-shared.mjs; this is a content/presence snapshot.
//
// DETERMINISM: renderFrameText is synchronous (single ink commit, debug frame).
// We only assert on STATIC copy, never on the animated spinner glyph (the
// spinner's first dots-frame is non-deterministic across runs), so every
// assertion is stable.
//
// COVERAGE NOTE (importable vs inline-only):
//   Covered here (importable from ui/steps/android-ci.tsx, ui/steps/
//   android-shared.tsx, ui/components.tsx): saving-credentials,
//   detecting-ci-secrets, ci-secrets-setup, ci-secrets-target-select,
//   ask-ci-secrets, confirm-ci-secret-overwrite, ci-secrets-failed, ask-build,
//   build-complete, error, ai-analysis-prompt / -running / -result, the
//   requesting-build streaming build-output viewer (FullscreenBuildOutput), the
//   view-workflow-diff fullscreen viewer (FullscreenDiffViewer), the
//   preview-workflow-file diff summary (DiffSummary), and the confirm-secrets-
//   push table (SecretsTable).
//
//   NOT covered here — these tail step bodies are inline-JSX-only in
//   android/ui/app.tsx (no importable component), so they rely on the parity
//   review + manual test instead: ask-github-actions-setup, ask-export-env,
//   exporting-env, confirm-env-export-overwrite, pick-package-manager,
//   pick-build-script, pick-build-script-custom, the preview-workflow-file
//   choice wrapper (its DiffSummary is covered), writing-workflow-file,
//   checking-ci-secrets, the confirm-secrets-push choice wrapper (its
//   SecretsTable is covered), and uploading-ci-secrets.
import React from 'react'
import {
  AskBuildStep,
  AskCiSecretsStep,
  CiSecretsFailedStep,
  CiSecretsSetupStep,
  CiSecretsTargetSelectStep,
  ConfirmCiSecretOverwriteStep,
  DetectingCiSecretsStep,
  SavingCredentialsStep,
} from '../src/build/onboarding/ui/steps/android-ci.tsx'
import {
  AiAnalysisPromptStep,
  AiAnalysisResultStep,
  AiAnalysisRunningStep,
  BuildCompleteStep,
  ErrorStep,
} from '../src/build/onboarding/ui/steps/android-shared.tsx'
import {
  DiffSummary,
  FullscreenBuildOutput,
  FullscreenDiffViewer,
  SecretsTable,
} from '../src/build/onboarding/ui/components.tsx'
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

// A single CI-secret setup-advice entry (the parent builds one per git-hosting
// provider whose CLI needs installing/auth). Shape mirrors CiSecretSetupAdvice.
const githubSetupAdvice = {
  target: { provider: 'github', label: 'GitHub (gh CLI)', cli: 'gh' },
  reason: 'not-installed',
  message: 'gh is not installed.',
  commands: ['brew install gh', 'gh auth login'],
}

// ── saving-credentials (spinner) ──────────────────────────────────────────────
test('saving-credentials shows the saving spinner copy', () => {
  assertContains(h(SavingCredentialsStep), ['Saving credentials...'], 'saving-credentials')
})

// ── detecting-ci-secrets (spinner) ────────────────────────────────────────────
test('detecting-ci-secrets shows the git-hosting check copy', () => {
  assertContains(h(DetectingCiSecretsStep), ['Checking git hosting...'], 'detecting-ci-secrets')
})

// ── ci-secrets-setup — provider advice + retry/skip control ───────────────────
test('ci-secrets-setup shows heading, provider advice, commands and choices', () => {
  assertContains(
    h(CiSecretsSetupStep, { advice: [githubSetupAdvice], onChoose: noop }),
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

// ── ci-secrets-target-select — provider picker ────────────────────────────────
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
      'Skip',
    ],
    'ci-secrets-target-select',
  )
})

// ── ask-ci-secrets — pluralized upload prompt + confirm CLI ───────────────────
test('ask-ci-secrets shows saved line, pluralized prompt and the CLI option', () => {
  assertContains(
    h(AskCiSecretsStep, { entryCount: 3, targetLabel: 'GitHub Actions', cli: 'gh', onChoose: noop }),
    [
      'Android credentials saved',
      'Upload 3 build env vars to GitHub Actions?',
      'Upload with gh',
      'Skip',
    ],
    'ask-ci-secrets',
  )
})
test('ask-ci-secrets uses the singular noun for a single env var', () => {
  assertContains(
    h(AskCiSecretsStep, { entryCount: 1, targetLabel: 'GitLab CI/CD', cli: 'glab', onChoose: noop }),
    ['Upload 1 build env var to GitLab CI/CD?', 'Upload with glab'],
    'ask-ci-secrets-singular',
  )
})

// ── confirm-ci-secret-overwrite — existing-key list + replace/skip ────────────
test('confirm-ci-secret-overwrite lists the existing keys and the replace/skip control', () => {
  assertContains(
    h(ConfirmCiSecretOverwriteStep, { existingKeys: ['CAPGO_TOKEN', 'ANDROID_KEYSTORE_FILE'], onChoose: noop }),
    [
      'These env vars already exist and will be replaced:',
      '• CAPGO_TOKEN',
      '• ANDROID_KEYSTORE_FILE',
      'Replace existing env vars',
      'Skip upload',
    ],
    'confirm-ci-secret-overwrite',
  )
})

// ── ci-secrets-failed — error string + retry/continue ─────────────────────────
test('ci-secrets-failed shows the error string and the retry/continue control', () => {
  assertContains(
    h(CiSecretsFailedStep, { error: 'gh: HTTP 403 — token lacks repo scope', onChoose: noop }),
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
    h(CiSecretsFailedStep, { error: null, onChoose: noop }),
    ['Could not upload env vars.', 'Try upload again'],
    'ci-secrets-failed-null',
  )
})

// ── ask-build — final request-a-build prompt ──────────────────────────────────
test('ask-build shows the saved line, the prompt and the yes/no control', () => {
  assertContains(
    h(AskBuildStep, { onChoose: noop }),
    [
      'Android credentials saved',
      'Request a build now?',
      'Yes, request a build',
      'Not now',
    ],
    'ask-build',
  )
})

// ── build-complete — terminal frame with every optional follow-up line ────────
test('build-complete shows the completion line and the finish hint (bare)', () => {
  assertContains(
    h(BuildCompleteStep, { uploadSummary: null, buildUrl: '' }),
    ['Onboarding complete', 'Press Enter to finish'],
    'build-complete-bare',
  )
})
test('build-complete surfaces the upload summary, workflow path, build url and finish hint', () => {
  assertContains(
    h(BuildCompleteStep, {
      uploadSummary: 'Uploaded 5 env vars to GitHub Actions',
      buildUrl: 'https://console.capgo.app/app/com.example.app/builds',
      workflowWrittenPath: '/repo/.github/workflows/capgo-build.yml',
    }),
    [
      'Onboarding complete',
      'Uploaded 5 env vars to GitHub Actions.',
      'Workflow file written:',
      '/repo/.github/workflows/capgo-build.yml',
      'Dispatch it from GitHub Actions to kick off an Android build.',
      'Track your build:',
      'https://console.capgo.app/app/com.example.app/builds',
      'Press Enter to finish',
    ],
    'build-complete-full',
  )
})
test('build-complete surfaces the .env export hint and gitignore warning', () => {
  assertContains(
    h(BuildCompleteStep, {
      uploadSummary: null,
      buildUrl: '',
      envExportPath: '/repo/.env.capgo.com.example.app.android',
    }),
    [
      'Credentials exported to:',
      '/repo/.env.capgo.com.example.app.android',
      // The "push them with `gh secret set -f <file>`" hint wraps at 80 cols, so
      // assert the un-wrapped command head + the gitignore warning separately.
      'gh secret set -f',
      '.gitignore',
    ],
    'build-complete-env-export',
  )
})
test('build-complete surfaces a non-fatal .env export error', () => {
  assertContains(
    h(BuildCompleteStep, {
      uploadSummary: null,
      buildUrl: '',
      envExportError: 'permission denied writing to /repo',
    }),
    ['Could not export .env:', 'permission denied writing to /repo'],
    'build-complete-env-error',
  )
})

// ── error — recovery prompt with the failure detail + the help menu ───────────
// Options come from buildHelpMenuOptions (main PR #2406): support always first,
// then 'Try again' (the old bare 'Retry' label is gone) and 'Exit'.
test('error shows the failure message and the support/retry/exit control', () => {
  assertContains(
    h(ErrorStep, { message: 'Store password was rejected by the keystore. Try again.', onChoose: noop }),
    [
      'Store password was rejected by the keystore. Try again.',
      'Email Capgo support',
      'Try again',
      'Exit',
    ],
    'error',
  )
})

// ── ai-analysis-prompt — offer to debug with Capgo AI ─────────────────────────
test('ai-analysis-prompt shows the build-failed line, the offer and the debug/skip control', () => {
  assertContains(
    h(AiAnalysisPromptStep, { onChoose: noop }),
    [
      'Build failed.',
      'We can analyze the build log with Capgo AI and suggest a fix.',
      'Debug with AI',
      'Skip',
    ],
    'ai-analysis-prompt',
  )
})

// ── ai-analysis-running (spinner) ─────────────────────────────────────────────
test('ai-analysis-running shows the analyzing spinner copy', () => {
  assertContains(
    h(AiAnalysisRunningStep),
    ['Analyzing build log with Capgo AI...'],
    'ai-analysis-running',
  )
})

// ── ai-analysis-result — diagnosis + caution + retry control ──────────────────
test('ai-analysis-result shows the inline diagnosis, the AI caution and the retry control', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: 'Gradle could not find the keystore at the configured path.',
      collapsed: false,
      result: null,
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      onReread: noop,
    }),
    [
      'AI analysis',
      'Gradle could not find the keystore at the configured path.',
      'AI can make mistakes',
      'I fixed it, retry build (2 retries left)',
      'Continue (skip retry)',
    ],
    'ai-analysis-result-inline',
  )
})
test('ai-analysis-result shows the collapsed (scroll-viewer) marker + re-read option', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: 'a'.repeat(200),
      collapsed: true,
      result: null,
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      onReread: noop,
    }),
    [
      'Analysis reviewed — pick an option below, or re-read it.',
      'Re-read analysis',
    ],
    'ai-analysis-result-collapsed',
  )
})
test('ai-analysis-result shows a non-success banner and the exhausted-retries continue control', () => {
  assertContains(
    h(AiAnalysisResultStep, {
      analysisText: null,
      collapsed: false,
      result: { kind: 'error', message: 'AI analysis failed: (status 500) internal error.' },
      retryCount: 2,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      onReread: noop,
    }),
    [
      'Analysis failed',
      'AI analysis failed: (status 500) internal error.',
      'used all 2 retries',
      'Continue',
    ],
    'ai-analysis-result-banner-exhausted',
  )
})

// ── confirm-secrets-push table (SecretsTable) ─────────────────────────────────
// The confirm-secrets-push CHOICE wrapper is inline JSX in app.tsx, but the
// table it renders is the importable SecretsTable — pin its content here.
test('secrets-table renders the header and one NEW + one REPLACE row', () => {
  assertContains(
    h(SecretsTable, {
      rows: [
        { name: 'CAPGO_TOKEN', status: 'NEW' },
        { name: 'ANDROID_KEYSTORE_FILE', status: 'REPLACE' },
      ],
    }),
    [
      'Secret name',
      'Status',
      'CAPGO_TOKEN',
      'NEW',
      'ANDROID_KEYSTORE_FILE',
      'REPLACE',
    ],
    'secrets-table',
  )
})

// ── preview-workflow-file diff summary (DiffSummary) ──────────────────────────
// The preview-workflow-file CHOICE wrapper is inline JSX in app.tsx, but the
// summary it renders is the importable DiffSummary — pin its content here.
test('diff-summary shows the title, subtitle and the add/remove/total counts', () => {
  assertContains(
    h(DiffSummary, {
      title: '🆕  Proposed new file — .github/workflows/capgo-build.yml',
      subtitle: 'Nothing exists on disk yet. Every line below is what would be written.',
      lines: [
        { kind: 'add', text: 'name: Capgo build' },
        { kind: 'add', text: 'on: workflow_dispatch' },
        { kind: 'eq', text: 'jobs:' },
      ],
    }),
    [
      'Proposed new file',
      '.github/workflows/capgo-build.yml',
      'Nothing exists on disk yet.',
      '+2 added',
      '-0 removed',
      '3 lines total',
    ],
    'diff-summary',
  )
})
test('diff-summary shows the "matches — no diff" banner when every line is equal', () => {
  assertContains(
    h(DiffSummary, {
      title: 'Proposed changes',
      lines: [
        { kind: 'eq', text: 'name: Capgo build' },
        { kind: 'eq', text: 'on: workflow_dispatch' },
      ],
    }),
    ['File on disk already matches the proposed content', '2', 'identical line'],
    'diff-summary-no-diff',
  )
})

// ── requesting-build streaming build-output viewer (FullscreenBuildOutput) ────
// Rendered at a fixed terminal size so the viewport math is deterministic. The
// viewer is a 1:1 truncated tail: assert the streamed lines (incl. the colored
// success/error rows) and the status footer are present.
test('build-output viewer streams the build lines and shows the status footer', () => {
  assertContains(
    h(FullscreenBuildOutput, {
      title: 'Building...',
      lines: [
        'Requesting build for app (android)...',
        '✔ Build succeeded',
        '✖ gradle: task assembleRelease FAILED',
      ],
      terminalRows: 14,
    }),
    [
      'Requesting build for app (android)...',
      '✔ Build succeeded',
      '✖ gradle: task assembleRelease FAILED',
      'Building...',
      '(3 lines)',
    ],
    'build-output-viewer',
    { rows: 14 },
  )
})

// ── view-workflow-diff fullscreen viewer (FullscreenDiffViewer) ───────────────
// Rendered at a fixed terminal size. Assert the title/subtitle, the per-line
// diff markers, the position footer and the exit hint.
test('workflow-diff viewer shows the title, the +/- diff lines, the position and the exit hint', () => {
  assertContains(
    h(FullscreenDiffViewer, {
      title: '🆕  Proposed new file — .github/workflows/capgo-build.yml',
      subtitle: 'Every line below is what would be written.',
      lines: [
        { kind: 'add', text: 'name: Capgo build' },
        { kind: 'del', text: 'name: Old build' },
        { kind: 'eq', text: 'on: workflow_dispatch' },
      ],
      terminalRows: 16,
      onExit: noop,
    }),
    [
      'Proposed new file',
      '.github/workflows/capgo-build.yml',
      'Every line below is what would be written.',
      '+ name: Capgo build',
      '- name: Old build',
      'on: workflow_dispatch',
      'Showing 1-3 of 3 lines.',
      'Press Escape or Enter to exit diff viewer',
    ],
    'workflow-diff-viewer',
    { rows: 16 },
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

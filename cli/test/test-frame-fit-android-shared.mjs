#!/usr/bin/env node
// Frame-fit tests for the Android shared lifecycle + AI-analysis onboarding
// steps (welcome / credentials-exist / backing-up / no-platform /
// build-complete / error / ai-analysis-prompt / ai-analysis-running /
// ai-analysis-result). Renders each step component × each meaningful state
// variant via the shared harness and asserts it fits the 16-row contract's
// body budget (13 rows) at every reference width (80 and 60 cols).
//
// Adaptive spacing: each body renders its COMFORTABLE form by default (boxed
// banners + blank-line spacing + full copy) and collapses to a terse,
// budget-fitting DENSE form when the parent passes `dense`. The 13-row budget
// is the floor we must survive on short terminals — it bounds the DENSE form
// only. The comfortable form is allowed to exceed it (the parent renders it
// only after measuring that it fits the viewport), so EVERY assertion below
// passes `dense: true` and asserts the dense form against the budget. The
// prop-less spinner steps (welcome / backing-up / ai-analysis-running) have no
// spacing to collapse, so they render identically in both modes.
import React from 'react'
import {
  AiAnalysisPromptStep,
  AiAnalysisResultStep,
  AiAnalysisRunningStep,
  BackingUpStep,
  BuildCompleteStep,
  CredentialsExistStep,
  ErrorStep,
  NoPlatformStep,
  WelcomeStep,
} from '../src/build/onboarding/ui/steps/android-shared.tsx'
import { assertFitsBudget, BODY_BUDGET_ROWS } from './helpers/frame-fit.mjs'

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

const h = React.createElement
const noop = () => {}

// ── welcome (spinner) ─────────────────────────────────────────────────────────
test(`welcome [dense] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(h(WelcomeStep), 'welcome-dense')
})

// ── no-platform — short and long native-dir names ─────────────────────────────
test(`no-platform [dense, short dir] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(h(NoPlatformStep, { androidDir: 'android', dense: true }), 'no-platform-dense-short')
})
test(`no-platform [dense, long dir] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(NoPlatformStep, { androidDir: 'apps/mobile/platforms/android-native', dense: true }),
    'no-platform-dense-long',
  )
})

// ── credentials-exist — short and long appId (heading width) ──────────────────
test(`credentials-exist [dense, short appId] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(CredentialsExistStep, { appId: 'com.x.y', onChoose: noop, dense: true }),
    'credentials-exist-dense-short',
  )
})
test(`credentials-exist [dense, long appId] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(CredentialsExistStep, {
      appId: 'com.companyname.product.flavor.staging.internal.example',
      onChoose: noop,
      dense: true,
    }),
    'credentials-exist-dense-long',
  )
})

// ── backing-up (spinner) ──────────────────────────────────────────────────────
test(`backing-up [dense] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(h(BackingUpStep), 'backing-up-dense')
})

// ── build-complete — every combination of the two optional follow-up lines ────
test(`build-complete [dense, bare] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(BuildCompleteStep, { uploadSummary: null, buildUrl: '', dense: true }),
    'build-complete-dense-bare',
  )
})
test(`build-complete [dense, url only] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(BuildCompleteStep, { uploadSummary: null, buildUrl: 'https://console.capgo.app/app/com.example.app/builds', dense: true }),
    'build-complete-dense-url',
  )
})
test(`build-complete [dense, summary + url] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(BuildCompleteStep, {
      uploadSummary: 'Uploaded 5 env vars to GitHub Actions',
      buildUrl: 'https://console.capgo.app/app/com.example.app/builds',
      dense: true,
    }),
    'build-complete-dense-summary-url',
  )
})
test(`build-complete [dense, long summary] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(BuildCompleteStep, {
      uploadSummary: 'Uploaded 12 build environment variables to the GitHub Actions repository secrets store',
      buildUrl: 'https://console.capgo.app/app/com.example.app/builds',
      dense: true,
    }),
    'build-complete-dense-long-summary',
  )
})

// ── error — short and very long (wrapped stderr) failure messages ─────────────
// Dense mode truncates the message to a single line so even a multi-hundred-char
// stderr keeps the retry/exit control on screen.
test(`error [dense, short] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(ErrorStep, { message: 'Store password was rejected by the keystore. Try again.', onChoose: noop, dense: true }),
    'error-dense-short',
  )
})
test(`error [dense, long stderr] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  const longMessage
    = 'Failed to provision Google Cloud resources: the Android Publisher API '
      + 'returned 403 PERMISSION_DENIED — the signed-in account lacks the '
      + 'serviceusage.services.enable permission on project capgo-native-build-9f3a2c, '
      + 'and the linked billing account is suspended. Re-run after enabling billing '
      + 'and granting the Service Usage Admin role, then try the build again from the top.'
  assertFitsBudget(h(ErrorStep, { message: longMessage, onChoose: noop, dense: true }), 'error-dense-long')
})

// ── ai-analysis-prompt ────────────────────────────────────────────────────────
test(`ai-analysis-prompt [dense] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(h(AiAnalysisPromptStep, { onChoose: noop, dense: true }), 'ai-analysis-prompt-dense')
})

// ── ai-analysis-running (spinner) ─────────────────────────────────────────────
test(`ai-analysis-running [dense] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(h(AiAnalysisRunningStep), 'ai-analysis-running-dense')
})

// ── ai-analysis-result — every content variant × retry affordance (DENSE) ─────
// Short inline success text (long analyses route to the scroll step, so the
// inline branch only ever sees short text). Retries available.
test(`ai-analysis-result [dense, short success, retries left] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: 'Gradle could not find the keystore at the configured path. Verify ANDROID_KEYSTORE_FILE.',
      collapsed: false,
      result: null,
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-short-success',
  )
})
// aiViewedFull marker (the long-analysis case: user dismissed the scroll viewer).
test(`ai-analysis-result [dense, viewedFull marker] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: 'a'.repeat(4000),
      collapsed: true,
      result: null,
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-viewed-full',
  )
})
// Non-success banner: error. In dense mode the banner is boxless.
test(`ai-analysis-result [dense, error banner] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: null,
      collapsed: false,
      result: { kind: 'error', message: 'AI analysis failed: (status 500) internal error.' },
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-error',
  )
})
// Non-success banner: already_analyzed.
test(`ai-analysis-result [dense, already_analyzed banner] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: null,
      collapsed: false,
      result: {
        kind: 'already_analyzed',
        message: 'AI analysis was already requested for this build (only one per job).',
      },
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-already-analyzed',
  )
})
// Non-success banner: too_big.
test(`ai-analysis-result [dense, too_big banner] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: null,
      collapsed: false,
      result: {
        kind: 'too_big',
        message: 'Build log is too large for Capgo AI (>10 MB). Try a local AI tool with the captured log.',
      },
      retryCount: 0,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-too-big',
  )
})
// Retries exhausted — the single-line "used all N retries" note + Continue.
test(`ai-analysis-result [dense, retries exhausted, banner] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: null,
      collapsed: false,
      result: { kind: 'error', message: 'AI analysis failed: (status 503) service unavailable.' },
      retryCount: 2,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-exhausted',
  )
})
// Last-retry label variant (retriesLeft === 1).
test(`ai-analysis-result [dense, last retry label] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: 'Short inline diagnosis.',
      collapsed: false,
      result: null,
      retryCount: 1,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-last-retry',
  )
})
// viewedFull marker WITH retries exhausted (both terse lines present at once).
test(`ai-analysis-result [dense, viewedFull + exhausted] fits ${BODY_BUDGET_ROWS}-row budget`, () => {
  assertFitsBudget(
    h(AiAnalysisResultStep, {
      analysisText: 'b'.repeat(2000),
      collapsed: true,
      result: null,
      retryCount: 2,
      maxRetries: 2,
      onRetry: noop,
      onSkipOrContinue: noop,
      dense: true,
    }),
    'ai-result-dense-viewed-full-exhausted',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

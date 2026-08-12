// src/build/onboarding/ui/steps/android-shared.tsx
//
// Pure presentational step bodies for the Android `build init` onboarding
// wizard's shared lifecycle frames (welcome / credentials-exist / backing-up /
// no-platform / build-complete / error) plus the AI build-log analysis
// prompt / running / result frames. Each component is "props in → JSX out":
// every dynamic value and event handler is an explicit, typed prop. The parent
// wizard (android/ui/app.tsx) owns all state, routing, async work, telemetry
// (trackAiAnalysisChoice etc.) and terminal-size measurement; these components
// never touch `useStdout` / `measureElement`. `useInput` inside a leaf control
// is fine — that's not layout measurement.
//
// Adaptive spacing — each body renders its COMFORTABLE form by default (the
// original design: bordered banners where applicable + decorative <Newline/>
// blank-line spacing + full copy). The 16-row frame contract is a FLOOR we must
// survive on short terminals, not a cap on every terminal: when the parent
// measures that the comfortable body can't fit the viewport it flips the sticky
// `dense` signal and threads `dense={true}` here, collapsing each body to the
// terse, budget-fitting form (blank lines dropped, copy trimmed, banners
// boxless via AiResultBanner's own `dense` pass-through). The two
// variable-length frames also cap their growth in dense mode: `error`
// truncates a long failure message to a single line and `ai-analysis-result`
// renders SHORT analysis text inline (long analyses are routed to the
// fullscreen scroll viewer by the parent before this frame is shown) and
// collapses the "retries exhausted" hint to one line. `dense` defaults to
// `false` so a component rendered without the prop (e.g. a test asserting the
// comfortable form) gets the original look.
import type { FC } from 'react'
import type { AiResultKind } from '../components.js'
import { Select } from '@inkjs/ui'
import { Box, Newline, Text } from 'ink'
import { pickAiPreviewTail } from '../../ai-fit.js'
import React from 'react'
import { AiResultBanner, ErrorLine, SpinnerLine, SuccessLine } from '../components.js'
import { buildHelpMenuOptions } from '../../../../support/help-menu.js'

// Longest a single failure message may be before we hard-truncate it with an
// ellipsis in the DENSE form. A raw backend / CLI stderr can be hundreds of
// characters and would wrap several rows at 60 cols, pushing the retry/exit
// control off the 13-row budget. One line of failure context + the recovery
// control is enough in dense mode; the parent already logs the full message to
// the scrollback above, and the comfortable form prints the message in full.
const MAX_ERROR_CHARS = 110

function truncate(text: string, max: number): string {
  if (text.length <= max)
    return text
  // -1 so the ellipsis itself doesn't push us over `max`.
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

// ── welcome (spinner) ─────────────────────────────────────────────────────────
// Single spinner line — identical comfortable / dense (no spacing to collapse).

export const WelcomeStep: FC = () => (
  <Box marginTop={1} justifyContent="center">
    <SpinnerLine text="Detecting Android project..." />
  </Box>
)

// ── no-platform ───────────────────────────────────────────────────────────────
// `androidDir` is the (configurable) native dir we looked for, e.g. "android".
// Comfortable: a <Newline/> separates the error line from the recovery
// instruction (3 rows). Dense: the blank line is dropped so the two lines sit
// together (2 rows).

export interface NoPlatformStepProps {
  androidDir: string
  dense?: boolean
}

export const NoPlatformStep: FC<NoPlatformStepProps> = ({ androidDir, dense = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <ErrorLine text={`No ${androidDir}/ directory found.`} />
    {!dense && <Newline />}
    <Text>
      Run
      {' '}
      <Text bold color="white">npx cap add android</Text>
      {' '}
      first, then re-run onboarding.
    </Text>
  </Box>
)

// ── credentials-exist ─────────────────────────────────────────────────────────
// `appId` is the Capgo app whose credentials already exist. Comfortable: the
// warning, the explanation and the Select are each separated by a <Newline/>.
// Dense: the blank lines are dropped so the prompt + choices fit at 60 cols.

export interface CredentialsExistStepProps {
  appId: string
  onChoose: (choice: 'backup' | 'exit') => void
  dense?: boolean
}

export const CredentialsExistStep: FC<CredentialsExistStepProps> = ({ appId, onChoose, dense = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold color="yellow">{`⚠ Android credentials already exist for ${appId}`}</Text>
    {!dense && <Newline />}
    <Text>Onboarding will create new credentials, replacing the existing ones.</Text>
    {!dense && <Newline />}
    <Select
      options={[
        { label: '📦  Start fresh (backup existing credentials first)', value: 'backup' },
        { label: '✖  Exit onboarding', value: 'exit' },
      ]}
      onChange={value => onChoose(value as 'backup' | 'exit')}
    />
  </Box>
)

// ── backing-up (spinner) ──────────────────────────────────────────────────────
// Single spinner line — identical comfortable / dense.

export const BackingUpStep: FC = () => (
  <Box marginTop={1}><SpinnerLine text="Backing up existing credentials..." /></Box>
)

// ── build-complete ────────────────────────────────────────────────────────────
// Terminal frame of the flow. `uploadSummary` (CI-secret push result) and
// `buildUrl` are both optional. Comfortable: each follow-up line is preceded by
// a <Newline/> (the original padded both). Dense: the blank lines are dropped so
// the success line + the (at most two) follow-up lines stay within budget.

export interface BuildCompleteStepProps {
  uploadSummary: string | null
  buildUrl: string
  /** Absolute path of a workflow file written by the GitHub Actions flow. */
  workflowWrittenPath?: string | null
  /** Absolute path of credentials exported to a .env fallback. */
  envExportPath?: string | null
  /** Surfaced when the .env export failed (non-fatal). */
  envExportError?: string | null
  dense?: boolean
}

export const BuildCompleteStep: FC<BuildCompleteStepProps> = ({ uploadSummary, buildUrl, workflowWrittenPath = null, envExportPath = null, envExportError = null, dense = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <SuccessLine text="Onboarding complete" />
    {uploadSummary && (
      <>
        {!dense && <Newline />}
        <Text>{`${uploadSummary}.`}</Text>
      </>
    )}
    {workflowWrittenPath && (
      <>
        {!dense && <Newline />}
        <Text color="green">
          ✔ Workflow file written:
          {' '}
          {workflowWrittenPath}
        </Text>
        <Text dimColor>Dispatch it from GitHub Actions to kick off an Android build.</Text>
      </>
    )}
    {envExportPath && (
      <>
        {!dense && <Newline />}
        <Text color="green">
          ✔ Credentials exported to:
          {' '}
          {envExportPath}
        </Text>
        <Text dimColor>
          When you're ready, push them with
          {' '}
          <Text bold>{`gh secret set -f ${envExportPath.split('/').slice(-1)[0]}`}</Text>
          . Add the file to
          {' '}
          <Text bold>.gitignore</Text>
          {' '}
          — never commit it.
        </Text>
      </>
    )}
    {envExportError && (
      <>
        {!dense && <Newline />}
        <Text color="yellow">
          ⚠ Could not export .env:
          {' '}
          {envExportError}
        </Text>
      </>
    )}
    {buildUrl && (
      <>
        {!dense && <Newline />}
        <Text>
          Track your build:
          {' '}
          <Text color="cyan" underline>{buildUrl}</Text>
        </Text>
      </>
    )}
    <Newline />
    <Text dimColor>Press Enter to finish ›</Text>
  </Box>
)

// ── error ─────────────────────────────────────────────────────────────────────
// `message` is the failure detail and can be arbitrarily long (wrapped backend
// / CLI stderr). Comfortable: the FULL message + a <Newline/> + the retry/exit
// Select (the original look — renders only when the parent measured it fits).
// Dense: the message is truncated to a single line (the parent logs the full
// text to the scrollback) and the blank line dropped, so the recovery control
// always stays on screen within the 13-row budget.

export type ErrorStepChoice = 'support' | 'ai' | 'retry' | 'exit'

export interface ErrorStepProps {
  message: string
  onChoose: (choice: ErrorStepChoice) => void
  /** A captured build log exists for this run (e.g. a build was attempted), so
   *  the help menu may offer the "Ask AI for help" option. Defaults to false. */
  hasBuildLog?: boolean
  dense?: boolean
}

export const ErrorStep: FC<ErrorStepProps> = ({ message, onChoose, hasBuildLog = false, dense = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <ErrorLine text={dense ? truncate(message, MAX_ERROR_CHARS) : message} />
    {!dense && <Newline />}
    <Select
      options={buildHelpMenuOptions({ hasBuildLog })}
      onChange={value => onChoose(value as ErrorStepChoice)}
    />
  </Box>
)

// ── ai-analysis-prompt ────────────────────────────────────────────────────────
// Offered when a build fails and Capgo captured a log to analyze. Comfortable:
// the failure line, the offer and the Select are each separated by a <Newline/>.
// Dense: the blank lines are dropped so the offer + debug/skip control fit at 60
// cols. All telemetry on the choice stays in the parent's onChoose handler.

export interface AiAnalysisPromptStepProps {
  onChoose: (choice: 'debug' | 'logs' | 'skip' | 'support') => void
  dense?: boolean
}

export const AiAnalysisPromptStep: FC<AiAnalysisPromptStepProps> = ({ onChoose, dense = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <ErrorLine text="Build failed." />
    {!dense && <Newline />}
    <Text>We can analyze the build log with Capgo AI and suggest a fix.</Text>
    {!dense && <Newline />}
    <Select
      options={[
        { label: '📨  Email Capgo support', value: 'support' },
        { label: '🤖  Debug with AI', value: 'debug' },
        { label: '👀  Show me the build logs', value: 'logs' },
        { label: '⏭   Skip', value: 'skip' },
      ]}
      onChange={value => onChoose(value as 'debug' | 'logs' | 'skip' | 'support')}
    />
  </Box>
)

// ── ai-analysis-running (spinner) ─────────────────────────────────────────────
// Single spinner line — identical comfortable / dense.

export const AiAnalysisRunningStep: FC<{ streamText?: string, terminalRows: number, terminalCols: number }> = ({ streamText, terminalRows, terminalCols }) => {
  // Live tail of the streaming analysis (pre-rendered ANSI from the parent),
  // sized to the ACTUAL viewport via the shared wrap-aware fit math in
  // ai-fit.ts — no arbitrary cap; lines scroll off only when the terminal is
  // genuinely out of rows. Flicker rules (learned the hard way):
  //   • height only ever GROWS (text appends; the helper caps at the viewport
  //     budget) — no padding, so the frame starts compact like other steps;
  //   • ONE <Text> node for the tail so Ink diffs the block in place;
  //   • the "… earlier lines" marker row is always rendered (blank when
  //     nothing is hidden) so it never pops in and shifts layout.
  // The result step owns full-text display with proper fit/scroll handling.
  const { rows, hidden } = pickAiPreviewTail(streamText ?? '', terminalRows, terminalCols)
  return (
    <Box flexDirection="column" marginTop={1}>
      <SpinnerLine text="Analyzing build log with Capgo AI..." />
      {rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{hidden > 0 ? `… ${hidden} earlier line${hidden === 1 ? '' : 's'}` : ' '}</Text>
          <Text>{rows.join('\n')}</Text>
        </Box>
      )}
    </Box>
  )
}

// ── ai-analysis-result ────────────────────────────────────────────────────────
// Renders the AI diagnosis (or a non-success banner), the "AI can make
// mistakes" caution, and the retry-or-skip control. Mutually-exclusive content:
//   • `analysisText` (success) — rendered inline ONLY when short; the parent
//     routes long analyses to the fullscreen scroll viewer BEFORE this frame is
//     shown, so the inline branch never blows the budget.
//   • `collapsed` — when the analysis is too tall to show inline alongside the
//     picker it lives in the fullscreen scroll viewer, and here we show a
//     one-line "reviewed" marker plus a "Re-read analysis" option that re-opens
//     the viewer (the alt-screen buffer has no scrollback — "scroll up" is
//     impossible). The parent computes collapsed = (viewer dismissed) AND
//     (still too tall), so growing the terminal reveals the full text again.
//   • `result` (non-success) — an AiResultBanner. Comfortable: bordered box;
//     dense: boxless (we thread `dense` straight through to it).
//
// `retryCount` + `maxRetries` derive the retry affordance; the parent keeps the
// counter and ALL telemetry (trackAiAnalysisChoice) + state-reset in its
// onChange handlers. We expose two handlers: `onRetry` ("I fixed it, rebuild")
// and `onSkipOrContinue` (skip retry / continue). Comfortable: every element is
// padded with <Newline/>s and the "retries exhausted" note is the original
// two-line copy; dense: the blank lines are dropped, the caution copy is
// shortened, and the exhausted note collapses to a single dim line so the
// Select always stays visible.

export interface AiAnalysisResultStepProps {
  /** Pre-rendered (markdown→ANSI) analysis text, or null on a non-success result. */
  analysisText: string | null
  /**
   * True when the analysis is too tall to show inline alongside the picker, so
   * it lives in the scroll viewer and is replaced here by a compact marker + a
   * "Re-read analysis" option. False ⇒ render the full text inline.
   */
  collapsed: boolean
  /** Non-success outcome banner (error / already_analyzed / too_big), else null. */
  result: { kind: AiResultKind, message: string } | null
  /** Retries already consumed; with `maxRetries` decides whether retry is offered. */
  retryCount: number
  maxRetries: number
  onRetry: () => void
  onSkipOrContinue: () => void
  /** Re-open the fullscreen scroll viewer to re-read the analysis. */
  onReread: () => void
  /** Escalate to Capgo support (email flow), carrying the logs + this analysis. */
  onSupport: () => void
  dense?: boolean
}

export const AiAnalysisResultStep: FC<AiAnalysisResultStepProps> = ({
  analysisText,
  collapsed,
  result,
  retryCount,
  maxRetries,
  onRetry,
  onSkipOrContinue,
  onReread,
  onSupport,
  dense = false,
}) => {
  const retriesLeft = maxRetries - retryCount
  const canRetry = retriesLeft > 0
  const retryLabel = retriesLeft === 1
    ? '🔄  I fixed it, retry build (last retry)'
    : `🔄  I fixed it, retry build (${retriesLeft} retries left)`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">AI analysis</Text>
      {!dense && <Newline />}
      {analysisText && !collapsed && <Text>{analysisText}</Text>}
      {analysisText && collapsed && (
        <Text dimColor>📖  Analysis reviewed — pick an option below, or re-read it.</Text>
      )}
      {result && <AiResultBanner kind={result.kind} message={result.message} dense={dense} />}
      {!dense && <Newline />}
      <Text color="yellow">
        {dense
          ? '⚠ AI can make mistakes. Verify against the full log before applying the fix.'
          : '⚠ AI can make mistakes. Always verify the diagnosis against the full log before applying the suggested fix.'}
      </Text>
      {!dense && <Newline />}
      {!canRetry && (
        <>
          <Text dimColor>
            {dense
              ? `You've used all ${maxRetries} retries. Exit and re-run the wizard for another attempt.`
              : `You've used all ${maxRetries} retries. Exit and re-run the wizard if you need another attempt.`}
          </Text>
          {!dense && <Newline />}
        </>
      )}
      <Select
        options={[
          ...(canRetry
            ? [
                { label: retryLabel, value: 'retry' },
                { label: '⏭   Continue (skip retry)', value: 'skip' },
              ]
            : [
                { label: '✔  Continue', value: 'continue' },
              ]),
          { label: '📨  Still stuck — email Capgo support', value: 'support' },
          // Only when the analysis is in the scroll viewer (collapsed); inline
          // there's nothing to re-read.
          ...(collapsed ? [{ label: '📖  Re-read analysis', value: 'reread' }] : []),
        ]}
        onChange={(value) => {
          if (value === 'retry')
            onRetry()
          else if (value === 'support')
            onSupport()
          else if (value === 'reread')
            onReread()
          else
            onSkipOrContinue()
        }}
      />
    </Box>
  )
}

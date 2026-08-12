import type { FC } from 'react'
import type { BuildOnboardingRecoveryAdvice } from '../../recovery.js'
import type { AiResultKind } from '../components.js'
// src/build/onboarding/ui/steps/ios-shared.tsx
//
// Pure presentational step bodies shared across the `build init` onboarding
// wizard (ui/app.tsx): the project-level frames (welcome / platform-select /
// adding-platform / no-platform / build-complete / error) plus the AI
// build-analysis prompt / running / result frames. Each component is
// "props in → JSX out": every dynamic value and event handler is an explicit,
// typed prop. The parent wizard owns ALL state, routing, async work, telemetry
// (trackAiAnalysisChoice) and terminal-size measurement; these components only
// render and forward callbacks. They never touch `useStdout` /
// `measureElement`.
//
// Spacing. Each step renders its COMFORTABLE form (bordered boxes, blank-line
// spacing, full copy). The old adaptive `dense` collapse was dropped once the
// startup size gate began guaranteeing a per-platform minimum height (see
// min-terminal-size.ts), so a `dense` prop is still accepted on some steps for
// call-site compatibility but no longer changes the layout.
//
// The two steps whose content is UNBOUNDED don't rely on a dense form at all —
// they hand off to a scrollable fullscreen takeover instead:
//   • error — recovery advice is variable-length (recovery.ts can match several
//     branches at once). When the full form is taller than the viewport the
//     parent shows it in the FullscreenAiViewer, then renders ErrorStep in its
//     `collapsed` form (error headline + the action Select only) so Try again /
//     Restart / Exit stay reachable. (See the per-step note on ErrorStep below.)
//   • ai-analysis-result — the inline success text is always SHORT here; long
//     analyses are routed to the fullscreen scroll step by the parent BEFORE
//     this frame renders.
import { Select } from '@inkjs/ui'
import { Box, Newline, Text } from 'ink'
import { pickAiPreviewTail } from '../../ai-fit.js'
import React from 'react'
import { AiResultBanner, ErrorLine, SpinnerLine, SuccessLine } from '../components.js'
import { buildHelpMenuOptions } from '../../../../support/help-menu.js'

// ── welcome ─────────────────────────────────────────────────────────────────
export const WelcomeStep: FC = () => (
  <Box marginTop={1} justifyContent="center">
    <SpinnerLine text="Detecting project..." />
  </Box>
)

// ── platform-select ───────────────────────────────────────────────────────────
// `appId` drives the "detected project" detail. The parent owns the routing
// (iOS → credential flow; Android → exit-with-instructions).
export interface PlatformSelectStepProps {
  appId: string
  dense?: boolean
  onChange: (value: string) => void | Promise<void>
}

export const PlatformSelectStep: FC<PlatformSelectStepProps> = ({ appId, dense = false, onChange }) => (
  <Box flexDirection="column" marginTop={1} gap={dense ? 0 : 1}>
    <SuccessLine text="Detected Capacitor project" detail={appId} />
    <Text bold>Which platform do you want to set up?</Text>
    <Select
      options={[
        { label: '🍎  iOS', value: 'ios' },
        { label: '🤖  Android', value: 'android' },
      ]}
      onChange={onChange}
    />
  </Box>
)

// ── no-platform ────────────────────────────────────────────────────────────────
// The iOS native folder is missing. `iosDir` names the missing directory,
// `addIosCommand`/`syncIosCommand` are the suggested fixes (shown terse), and
// the option labels embed `addIosCommand`. The parent owns run/recheck/exit.
export interface NoPlatformStepProps {
  iosDir: string
  addIosCommand: string
  syncIosCommand: string
  dense?: boolean
  onChange: (value: string) => void
}

export const NoPlatformStep: FC<NoPlatformStepProps> = ({ iosDir, addIosCommand, syncIosCommand, dense = false, onChange }) => (
  <Box flexDirection="column" marginTop={1} gap={dense ? 0 : 1}>
    <ErrorLine text={`No ${iosDir}/ directory found.`} />
    <Text>
      {dense
        ? 'Onboarding needs a generated native iOS project before creating credentials.'
        : 'This onboarding flow needs a generated native iOS project before credentials can be created.'}
    </Text>
    <Text dimColor>{dense ? `Suggested: ${addIosCommand} && ${syncIosCommand}` : `Suggested commands: ${addIosCommand} && ${syncIosCommand}`}</Text>
    <Select
      options={[
        { label: `🛠  Run ${addIosCommand} now`, value: 'run' },
        { label: '🔄  I already fixed it, re-check', value: 'recheck' },
        { label: '✖  Exit onboarding', value: 'exit' },
      ]}
      onChange={onChange}
    />
  </Box>
)

// ── adding-platform ─────────────────────────────────────────────────────────────
// Spinner shown while `addIosCommand` runs. `doctorCommand` is the fallback hint.
export interface AddingPlatformStepProps {
  addIosCommand: string
  doctorCommand: string
  dense?: boolean
}

export const AddingPlatformStep: FC<AddingPlatformStepProps> = ({ addIosCommand, doctorCommand, dense = false }) => (
  <Box flexDirection="column" marginTop={1}>
    <SpinnerLine text={`Running ${addIosCommand}...`} />
    <Text dimColor>
      {dense
        ? `If this fails, try ${doctorCommand} and keep the support bundle path from the error screen.`
        : `If this still fails, try ${doctorCommand} and keep the support bundle path from the error screen.`}
    </Text>
  </Box>
)

// ── ai-analysis-prompt ──────────────────────────────────────────────────────────
// Build failed; offer an AI diagnosis. The parent routes debug →
// ai-analysis-running, skip → build-complete (and fires the 'skip' telemetry).
export interface AiAnalysisPromptStepProps {
  dense?: boolean
  onChange: (value: string) => void | Promise<void>
}

export const AiAnalysisPromptStep: FC<AiAnalysisPromptStepProps> = ({ dense = false, onChange }) => (
  <Box flexDirection="column" marginTop={1} gap={dense ? 0 : 1}>
    <ErrorLine text="Build failed." />
    <Text>We can analyze the build log with Capgo AI and suggest a fix.</Text>
    <Select
      options={[
        { label: '📨  Email Capgo support', value: 'support' },
        { label: '🤖  Debug with AI', value: 'debug' },
        { label: '👀  Show me the build logs', value: 'logs' },
        { label: '⏭   Skip', value: 'skip' },
      ]}
      onChange={onChange}
    />
  </Box>
)

// ── ai-analysis-running ─────────────────────────────────────────────────────────
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

// ── ai-analysis-result ──────────────────────────────────────────────────────────
// Renders the diagnosis (or fallback banner), then a retry/skip Select. The
// parent computes whether retries remain and owns ALL telemetry + state-reset
// on retry; this component only renders and forwards the chosen value.
//
// Display rules:
//   • success + fits inline (`collapsed` false) → render `analysisText` inline.
//   • success + too tall (`collapsed` true) → a compact "reviewed" marker plus
//     a "Re-read analysis" option that re-opens the fullscreen scroll viewer.
//     The parent sets `collapsed` = (dismissed the viewer) AND (still too tall
//     for the current terminal), so growing the terminal reveals the full text
//     again instead of leaving a stale marker.
//   • a non-success outcome (`result`) → the coloured AiResultBanner.
// The "⚠ AI can make mistakes…" caution always shows. When no retries remain a
// terse "used all N retries" notice + a single "Continue" option replace the
// retry/skip pair.
//
// `maxRetries` is the parent's MAX_AI_RETRIES; `retriesLeft` is the remaining
// count (0 ⇒ `canRetry` false). The `analysisText` rendered inline here only
// happens when it fits (collapsed false), so it never threatens the budget.
export interface AiAnalysisResultStepProps {
  analysisText: string | null
  // True when the analysis is too tall to show inline alongside the picker, so
  // it lives in the fullscreen scroll viewer and is replaced here by a compact
  // marker + a "Re-read analysis" option. False ⇒ render the full text inline.
  collapsed: boolean
  result: { kind: AiResultKind, message: string } | null
  canRetry: boolean
  retriesLeft: number
  maxRetries: number
  dense?: boolean
  // Receives 'retry' | 'skip' | 'continue' | 'reread'. 'reread' re-opens the
  // fullscreen scroll viewer (the wizard runs in the alt-screen buffer, which
  // has no scrollback — so re-reading must re-open the viewer, not scroll up).
  onChange: (value: string) => void | Promise<void>
}

export const AiAnalysisResultStep: FC<AiAnalysisResultStepProps> = ({
  analysisText,
  collapsed,
  result,
  canRetry,
  retriesLeft,
  maxRetries,
  dense = false,
  onChange,
}) => {
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
          ? '⚠ AI can make mistakes. Verify the diagnosis against the full log before applying the fix.'
          : '⚠ AI can make mistakes. Always verify the diagnosis against the full log before applying the suggested fix.'}
      </Text>
      {!canRetry && (
        <>
          {!dense && <Newline />}
          <Text dimColor>
            {dense
              ? `You've used all ${maxRetries} retries. Exit and re-run the wizard for another attempt.`
              : `You've used all ${maxRetries} retries. Exit and re-run the wizard if you need another attempt.`}
          </Text>
        </>
      )}
      {!dense && <Newline />}
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
          // Only offered when the analysis is in the scroll viewer (collapsed);
          // when shown inline there's nothing to re-read.
          ...(collapsed ? [{ label: '📖  Re-read analysis', value: 'reread' }] : []),
        ]}
        onChange={onChange}
      />
    </Box>
  )
}

// ── error ───────────────────────────────────────────────────────────────────────
// Recovery advice is variable-length (recovery.ts can match several branches for
// one composite error, growing summary/commands/docs).
//
// Full form (default): the complete layout — "Recovery plan", "Helpful commands"
// and "Docs" headings, each over its uncapped list; the full (unclamped) error;
// the "Support bundle" heading + path; and the "What do you want to do?" Select,
// all with blank-line spacing.
//
// Collapsed form (`collapsed`): when the parent measured the full form as taller
// than the viewport, it first shows the error + advice in the scrollable
// FullscreenAiViewer, then renders ONLY the error headline + the action Select
// here — so Try again / Restart / Exit stay reachable no matter how long the
// advice was. This `collapsed` route REPLACES the old adaptive `dense` collapse,
// which was dropped along with the rest of the dense flag; `dense` is still
// accepted for call-site compatibility but no longer alters the layout.
//
// `showRetry` gates the Select (the parent only sets a retryStep on recoverable
// errors); the parent owns retry/restart/exit.
export interface ErrorStepProps {
  error: string
  recoveryAdvice: BuildOnboardingRecoveryAdvice | null
  supportBundlePath: string | null
  showRetry: boolean
  dense?: boolean
  /** When true, the full error + recovery advice was already shown in the
   *  scrollable viewer (it was taller than the viewport), so render only the
   *  error headline + the action prompt here — keeping Try again / Restart /
   *  Exit reachable no matter how long the advice was. */
  collapsed?: boolean
  /** A captured build log exists for this run (e.g. a build was attempted), so
   *  the help menu may offer the "Ask AI for help" option. Defaults to false. */
  hasBuildLog?: boolean
  /** Offer "✨ Create a new key for me (guided)" as the first recovery option —
   *  set when an App Store Connect key failed to validate on a host where the
   *  guided macOS helper is available. Defaults to false. */
  showGuidedKey?: boolean
  onChange: (value: string) => void | Promise<void>
}

const RESTART_OPTION = { label: '↩️   Restart onboarding', value: 'restart' }
const GUIDED_KEY_OPTION = { label: '✨  Create a new key for me (guided)', value: 'guided-key' }

// Build the failure-menu options: support-first (and AI iff a build log exists)
// from the shared `buildHelpMenuOptions`, with the onboarding-specific
// "Restart onboarding" action spliced in just before Exit so it stays reachable.
// When `showGuidedKey` is set (an ASC key failed to validate and the macOS helper
// is available) the guided-creation option leads the list as the default action.
function buildErrorMenuOptions(hasBuildLog: boolean, showGuidedKey = false): { label: string, value: string }[] {
  const options = buildHelpMenuOptions({ hasBuildLog })
  const exitIndex = options.findIndex(option => option.value === 'exit')
  const withRestart = exitIndex === -1
    ? [...options, RESTART_OPTION]
    : [...options.slice(0, exitIndex), RESTART_OPTION, ...options.slice(exitIndex)]
  return showGuidedKey ? [GUIDED_KEY_OPTION, ...withRestart] : withRestart
}

// Flatten an error + its recovery advice into plain text lines for the
// scrollable FullscreenAiViewer. The recovery advice is UNBOUNDED — a stacked
// failure produces 6+ summary lines (50+ rows) — so when the screen is taller
// than the viewport the parent shows these lines in the same scroll viewer as
// the AI analysis (rather than clipping the actions off the bottom), then
// renders the compact ErrorStep once dismissed. Mirrors the inline ErrorStep
// layout; the action prompt is intentionally omitted (it lives in the compact
// step that follows).
export function formatErrorViewerLines(
  error: string,
  recoveryAdvice: BuildOnboardingRecoveryAdvice | null,
  supportBundlePath: string | null,
): string[] {
  const lines: string[] = [`✖  ${error}`, '']
  if (recoveryAdvice) {
    lines.push('Recovery plan', '')
    for (const item of recoveryAdvice.summary)
      lines.push(`  • ${item}`)
    if (recoveryAdvice.commands.length > 0) {
      lines.push('', 'Helpful commands', '')
      for (const command of recoveryAdvice.commands)
        lines.push(`  ${command}`)
    }
    if (recoveryAdvice.docs.length > 0) {
      lines.push('', 'Docs', '')
      for (const doc of recoveryAdvice.docs)
        lines.push(`  ${doc}`)
    }
  }
  if (supportBundlePath)
    lines.push('', 'Support bundle', supportBundlePath)
  return lines
}

function wrapRows(text: string, cols: number): number {
  return Math.max(1, Math.ceil(text.length / Math.max(1, cols)))
}

/**
 * Estimate the rendered row height of the COMFORTABLE ErrorStep body (marginTop
 * + error line + recovery advice + action prompt), independent of whether the
 * collapsed or full form actually renders. The parent uses this to decide
 * whether to route the error through the scroll viewer.
 *
 * Why a structural estimate and not `measureElement`: measuring the rendered
 * body would FEEDBACK-LOOP — a collapsed body measures short → "fits" → render
 * full → measures tall → collapse → measures short → … This estimate depends
 * only on the advice shape + width, so the decision is stable at any size.
 *
 * Calibrated against the VT harness: the body estimate lands within ~1 row of
 * the real render across every recovery-advice shape, and the surrounding frame
 * chrome (boxed header + completed-steps log + padding) is a fixed ~15 rows the
 * caller reserves on top.
 */
export function estimateErrorBodyRows(
  error: string,
  recoveryAdvice: BuildOnboardingRecoveryAdvice | null,
  supportBundlePath: string | null,
  cols: number,
  showRetry: boolean,
  hasBuildLog: boolean,
  showGuidedKey = false,
): number {
  let rows = 1 // outer marginTop
  rows += wrapRows(`✖  ${error}`, cols) // ErrorLine (wraps)
  rows += 1 // Newline after the error
  if (recoveryAdvice) {
    rows += 2 // "Recovery plan" heading + its box marginTop
    for (const item of recoveryAdvice.summary)
      rows += wrapRows(`• ${item}`, cols - 2) // marginLeft 2
    if (recoveryAdvice.commands.length > 0) {
      rows += 3 // Newline + "Helpful commands" + marginTop
      for (const command of recoveryAdvice.commands)
        rows += wrapRows(command, cols - 2)
    }
    if (recoveryAdvice.docs.length > 0) {
      rows += 3 // Newline + "Docs" + marginTop
      for (const doc of recoveryAdvice.docs)
        rows += wrapRows(doc, cols - 2)
    }
  }
  if (supportBundlePath)
    rows += 2 + wrapRows(supportBundlePath, cols) // Newline + "Support bundle" + path
  rows += 1 // Newline before the action prompt
  if (showRetry)
    // "What do you want to do?" + Newline + Select (one row per option). The
    // option count tracks buildErrorMenuOptions (guided-key iff showGuidedKey +
    // support [+ AI iff hasBuildLog] + retry + restart + exit), so it stays
    // correct as the menu grows.
    rows += 2 + buildErrorMenuOptions(hasBuildLog, showGuidedKey).length
  return rows
}

export const ErrorStep: FC<ErrorStepProps> = ({ error, recoveryAdvice, supportBundlePath, showRetry, collapsed = false, hasBuildLog = false, showGuidedKey = false, onChange }) => {
  const errorMenuOptions = buildErrorMenuOptions(hasBuildLog, showGuidedKey)
  // Collapsed form: the full error + recovery advice was too tall for the
  // viewport, so the parent already showed it in the scrollable viewer. Render
  // only the error headline + the action prompt, so Try again / Restart / Exit
  // are always reachable. (recoveryAdvice / supportBundlePath were shown in the
  // viewer, so they're intentionally not repeated here.)
  if (collapsed) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <ErrorLine text={error} />
        {showRetry && (
          <>
            <Newline />
            <Text bold>What do you want to do?</Text>
            <Newline />
            <Select options={errorMenuOptions} onChange={onChange} />
          </>
        )}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <ErrorLine text={error} />
      <Newline />
      {recoveryAdvice && (
        <>
          <Text bold>Recovery plan</Text>
          <Box flexDirection="column" marginTop={1} marginLeft={2}>
            {recoveryAdvice.summary.map(line => (
              <Text key={`recovery-summary-${line}`}>{`• ${line}`}</Text>
            ))}
          </Box>
          {recoveryAdvice.commands.length > 0 && (
            <>
              <Newline />
              <Text bold>Helpful commands</Text>
              <Box flexDirection="column" marginTop={1} marginLeft={2}>
                {recoveryAdvice.commands.map(command => (
                  <Text key={`recovery-command-${command}`} dimColor>{command}</Text>
                ))}
              </Box>
            </>
          )}
          {recoveryAdvice.docs.length > 0 && (
            <>
              <Newline />
              <Text bold>Docs</Text>
              <Box flexDirection="column" marginTop={1} marginLeft={2}>
                {recoveryAdvice.docs.map(doc => (
                  <Text key={`recovery-doc-${doc}`} color="cyan">{doc}</Text>
                ))}
              </Box>
            </>
          )}
        </>
      )}
      {supportBundlePath && (
        <>
          <Newline />
          <Text bold>Support bundle</Text>
          <Text dimColor>{supportBundlePath}</Text>
        </>
      )}
      <Newline />
      {showRetry && (
        <>
          <Text bold>What do you want to do?</Text>
          <Newline />
          <Select options={errorMenuOptions} onChange={onChange} />
        </>
      )}
    </Box>
  )
}

// ── build-complete ──────────────────────────────────────────────────────────────
// Final success screen. `buildUrl` (when a build was kicked off) and
// `ciSecretUploadSummary` (when env vars were uploaded) are optional details.
// `buildRequestCommand` is shown as the "run anytime" hint. Always renders the
// comfortable form: the bordered box with `paddingY={1}` plus the blank-line
// spacing around and inside it. (The startup size gate guarantees enough rows,
// so the old adaptive `dense` collapse was dropped; the `dense` prop is accepted
// for call-site compatibility but no longer alters the layout.)
export interface BuildCompleteStepProps {
  buildUrl: string
  ciSecretUploadSummary: string | null
  buildRequestCommand: string
  /** Absolute path of a workflow file written by the GitHub Actions flow. */
  workflowWrittenPath?: string | null
  /** Absolute path of credentials exported to a .env fallback. */
  envExportPath?: string | null
  /** Surfaced when the .env export failed (non-fatal). */
  envExportError?: string | null
  dense?: boolean
}

export const BuildCompleteStep: FC<BuildCompleteStepProps> = ({ buildUrl, ciSecretUploadSummary, buildRequestCommand, workflowWrittenPath = null, envExportPath = null, envExportError = null }) => {
  const detail = buildUrl
    ? (
        <>
          <Text>Your iOS app is building in the cloud.</Text>
          <Text>
            Track it at
            {' '}
            <Text color="cyan" underline>{buildUrl}</Text>
          </Text>
        </>
      )
    : (
        <Text>Your iOS credentials are saved and ready to use.</Text>
      )
  const runHint = (
    <Text dimColor>
      Run
      {' '}
      <Text bold color="white">{buildRequestCommand}</Text>
      {' '}
      anytime to start a build.
    </Text>
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      <Newline />
      <Box
        borderStyle="round"
        borderColor="green"
        paddingX={3}
        paddingY={1}
        flexDirection="column"
        alignItems="center"
      >
        <Text bold color="green">🎉  You're all set!</Text>
        <Newline />
        {detail}
        <Newline />
        {ciSecretUploadSummary && (
          <>
            <Text>{`${ciSecretUploadSummary}.`}</Text>
            <Newline />
          </>
        )}
        {workflowWrittenPath && (
          <>
            <Text color="green">
              ✔ Workflow file written:
              {' '}
              {workflowWrittenPath}
            </Text>
            <Text dimColor>
              Dispatch it from GitHub Actions to kick off a build, or run
              {' '}
              <Text bold>{buildRequestCommand}</Text>
              {' '}
              locally.
            </Text>
            <Newline />
          </>
        )}
        {envExportPath && (
          <>
            <Text color="green">
              ✔ Credentials exported to:
              {' '}
              {envExportPath}
            </Text>
            <Text dimColor>
              When you're ready, push them with
              {' '}
              <Text bold>{`gh secret set -f ${envExportPath.split('/').slice(-1)[0]}`}</Text>
              {' '}
              (or your CI's equivalent). Add the file to
              {' '}
              <Text bold>.gitignore</Text>
              {' '}
              — never commit it.
            </Text>
            <Newline />
          </>
        )}
        {envExportError && (
          <>
            <Text color="yellow">
              ⚠ Could not export .env:
              {' '}
              {envExportError}
            </Text>
            <Newline />
          </>
        )}
        {runHint}
      </Box>
      <Newline />
      <Text dimColor>Press Enter to finish ›</Text>
    </Box>
  )
}

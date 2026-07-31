import type { FC } from 'react'
import type { OnboardingResult, Platform } from '../types.js'
// src/build/onboarding/ui/shell.tsx
//
// Top-level wizard shell, rendered ONCE inside the alt-screen buffer
// (render(<OnboardingShell/>, { alternateScreen: true })). It owns platform
// selection so the picker lives inside the alt screen, then mounts the chosen
// platform's existing app INLINE in the same Ink tree — no second render, no
// alt-screen flash.
//
// Progress is loaded BEFORE the app mounts, and crucially WITHOUT a visible
// loading interstitial on the picker path: pressing a platform kicks off the
// (few-ms) disk read while the picker stays on screen, then the app mounts
// directly once it resolves. So the user sees picker → app, never a 1-frame
// "Loading…" that appears and vanishes. (When the platform is pre-resolved via
// --platform / a single native dir there's no picker to keep, so we briefly
// show just the framed header until the app mounts — startup, not mid-flow.)
//
// `command.ts` passes `initialPlatform` to skip the picker, and
// `onResolvePlatform` so it can print the post-exit completion breadcrumb.
import { Box, Text, useApp, useStdout } from 'ink'
import React, { useCallback, useEffect, useState } from 'react'
import { loadAndroidProgress } from '../android/progress.js'
import AndroidOnboardingApp from '../android/ui/app.js'
import { loadProgress } from '../progress.js'
import OnboardingApp from './app.js'
import AppflowApp from './appflow-app.js'
import { PICKER_MIN_COLS, PICKER_MIN_ROWS, terminalFitsPicker } from '../min-terminal-size.js'
import { Header } from './components.js'
import { pickPlatformLayout } from './frame-fit.js'
import { TerminalTooSmallPrompt } from './min-size-gate.js'
import { CardChooser, PlatformPicker } from './platform-picker.js'
import { exitAfterOnboardingBeforeExit } from './exit.js'
import { UpdatePrompt } from './update-prompt.js'
import type { OnboardingBeforeExit } from './exit.js'

// Progress shapes derived from the loaders so we don't re-import the type names.
type IosProgress = Awaited<ReturnType<typeof loadProgress>>
type AndroidProgress = Awaited<ReturnType<typeof loadAndroidProgress>>

// A loaded, ready-to-mount app (discriminated so the per-platform progress
// types stay precise without a union-of-progress field).
type ReadyApp
  = | { kind: 'ios', progress: IosProgress }
    | { kind: 'android', progress: AndroidProgress }
    | { kind: 'appflow', scope: 'ios' | 'android' }

async function loadReady(platform: Platform, appId: string): Promise<ReadyApp> {
  if (platform === 'android')
    return { kind: 'android', progress: await loadAndroidProgress(appId) }
  return { kind: 'ios', progress: await loadProgress(appId) }
}

// Live terminal size, tracked through resize — drives the picker's cards↔list
// layout and the full-height frame.
//
// We read `stdout.rows/columns` DIRECTLY each render (not from state) and only
// use the resize listener to force a re-render. When the terminal resizes, Node
// updates stdout.rows/columns and Ink re-renders the tree — at which point the
// direct read is already current. Holding the size in state instead lags by one
// frame (the resize re-render runs with the stale state until setState flushes),
// which shows up as a 1-row "jump then correct" on the bottom-pinned legend.
//
// Exported so the resize harness in test/test-frame-fit-resize.mjs drives the
// REAL hook (not a copy) through a simulated resize.
export function useTerminalSize(): { cols: number, rows: number } {
  const { stdout } = useStdout()
  const [, forceRerender] = useState(0)
  useEffect(() => {
    if (!stdout)
      return
    const onResize = (): void => forceRerender(n => n + 1)
    stdout.on('resize', onResize)
    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])
  return { cols: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 }
}

export interface OnboardingShellProps {
  appId: string
  /**
   * iOS-side bundle id default — sourced from `config.appId` (top-level), which
   * is what `cap sync` writes into `PRODUCT_BUNDLE_IDENTIFIER`. Distinct from
   * `appId` above, which `getAppId()` may resolve to
   * `config.plugins.CapacitorUpdater.appId` (a Capgo lookup key — wrong for
   * Apple signing). Threaded down to the iOS OnboardingApp; the Android app
   * ignores it.
   */
  iosBundleIdInitial: string
  iosDir: string
  androidDir: string
  /**
   * Whether guided ASC-key creation may be offered (macOS + signed helper
   * installed + signature/team verified — see the probe in command.ts).
   * Threaded into the iOS OnboardingApp; the Android app ignores it.
   */
  guidedHelperUsable: boolean
  apikey?: string
  supaHost?: string
  /** Correlation id for this onboarding run; threaded into every analytics event the apps emit. */
  journeyId: string
  /** Pre-resolved platform (--platform flag or the single existing native dir); skips the picker. */
  initialPlatform?: Platform
  /**
   * Set when a newer @capgo/cli is published. Drives the self-update prompt
   * shown as the FIRST wizard screen (before platform selection / auto-load).
   * Undefined → up to date → no prompt.
   */
  updateInfo?: { currentVersion: string, latestVersion: string }
  /** Shows the terminal replay/analytics opt-out notice on the first shell screen. */
  analyticsNotice?: boolean
  /** Called once a platform is chosen so the caller can print the completion breadcrumb. */
  onResolvePlatform?: (platform: Platform) => void
  /** Called by the mounted app on every step transition, so the caller can record
   *  where the user dropped off for the quit event. */
  onStep?: (step: string) => void
  /** Called by the mounted app when it reaches the build-complete screen, so the
   *  caller prints the accurate post-exit message + durable summary. If the wizard
   *  exits any other way (cancel / missing platform), this never fires and the
   *  caller treats it as cancelled. */
  onResult?: (result: OnboardingResult) => void
  /** Awaited immediately before Ink exits so replay can capture the alt-screen frame. */
  onBeforeExit?: OnboardingBeforeExit
}

const AnalyticsNotice: FC = () => (
  <Box width="100%" marginTop={1}>
    <Text dimColor>Analytics: this onboarding records usage and terminal replay to improve Capgo. Opt out with --no-analytics.</Text>
  </Box>
)

const OnboardingShell: FC<OnboardingShellProps> = ({ appId, iosBundleIdInitial, iosDir, androidDir, guidedHelperUsable, apikey, supaHost, journeyId, initialPlatform, updateInfo, analyticsNotice, onResolvePlatform, onStep, onResult, onBeforeExit }) => {
  const { exit } = useApp()
  const { cols, rows } = useTerminalSize()
  const [ready, setReady] = useState<ReadyApp | null>(null)
  // Set when progress loading fails (e.g. corrupt saved-progress JSON). loadProgress
  // throws for non-ENOENT errors, so without a rejection handler `choose` would
  // leave an unhandled promise rejection and the picker stuck with no feedback.
  const [loadError, setLoadError] = useState<string | null>(null)
  // Whether the self-update prompt (first screen, when updateInfo is set) has
  // been dismissed with "skip". On "update" we exit Ink instead (see below).
  const [updateAnswered, setUpdateAnswered] = useState(false)
  // When the user picks iOS or Android from the picker we first ask whether they
  // are migrating from Ionic Appflow (the spec's single-platform migration gate).
  // Holds the pending native platform while that yes/no is on screen; null when
  // no gate is showing. Pre-resolved --platform skips it (the user already decided).
  const [migrationGate, setMigrationGate] = useState<'ios' | 'android' | null>(null)
  const exitAfterBeforeExit = useCallback(() => {
    exitAfterOnboardingBeforeExit(onBeforeExit, exit)
  }, [exit, onBeforeExit])

  // Begin loading the chosen platform's progress; mount the app once it lands.
  // The picker stays on screen during the (few-ms) load, so there's no loading
  // frame on the picker path.
  const choose = useCallback((platform: Platform) => {
    onResolvePlatform?.(platform)
    void loadReady(platform, appId)
      .then(setReady)
      .catch((err: unknown) => {
        // Surface the failure instead of hanging: show an error frame, report a
        // cancelled outcome (so the caller doesn't claim success), and exit. The
        // common cause is unreadable/corrupt saved progress on disk.
        const message = err instanceof Error ? err.message : String(err)
        setLoadError(message)
        onResult?.({ outcome: 'cancelled' })
        setTimeout(exitAfterBeforeExit, 50)
      })
  }, [appId, onResolvePlatform, onResult, exitAfterBeforeExit])

  // Picker answer. The picker only yields iOS / Android now; both pass through
  // the "migrating from Appflow?" gate before committing to native onboarding.
  const onPick = useCallback((platform: Platform) => {
    if (platform === 'ios' || platform === 'android')
      setMigrationGate(platform)
  }, [])

  // Answer to the migration gate: YES enters the Appflow migration scoped to the
  // pending platform (no disk progress to load — the AppflowApp owns its state);
  // NO proceeds to native onboarding for that platform.
  const answerMigrationGate = useCallback((migrating: boolean) => {
    const platform = migrationGate
    setMigrationGate(null)
    if (!platform)
      return
    if (migrating) {
      onResolvePlatform?.('appflow')
      setReady({ kind: 'appflow', scope: platform })
      return
    }
    choose(platform)
  }, [migrationGate, choose, onResolvePlatform])

  // Pre-resolved platform → load immediately (no picker shown).
  useEffect(() => {
    // Hold the auto-load until the update prompt (if any) is answered, so the
    // update offer is the first screen even when --platform pre-resolves.
    if (initialPlatform && (!updateInfo || updateAnswered))
      choose(initialPlatform)
  }, [initialPlatform, choose, updateInfo, updateAnswered])

  // Progress load failed (corrupt/unreadable saved state) — show why and exit,
  // rather than hanging on a frozen picker. The exit is scheduled in the .catch.
  if (loadError) {
    return (
      <Box flexDirection="column" minHeight={rows} padding={1}>
        <Text bold color="red">{`✖  Could not load onboarding progress for ${appId}.`}</Text>
        <Text>{loadError}</Text>
        <Box marginTop={1}>
          <Text dimColor>Your saved progress file may be corrupt. Remove it and re-run `capgo build init`.</Text>
        </Box>
      </Box>
    )
  }

  // Render the chosen app DIRECTLY (no MinSizeGate wrapper). Each app self-gates
  // internally (renders the resize prompt from its own render when the terminal
  // is too small) so it STAYS MOUNTED across resizes — wrapping it in a gate
  // here would unmount it on a mid-flow shrink, tearing down step state and
  // exiting the wizard. The app owns the size decision so a shrink→regrow keeps
  // the user exactly where they were.
  if (ready?.kind === 'ios')
    return <OnboardingApp appId={appId} iosBundleIdInitial={iosBundleIdInitial} initialProgress={ready.progress} iosDir={iosDir} guidedHelperUsable={guidedHelperUsable} apikey={apikey} supaHost={supaHost} journeyId={journeyId} onStep={onStep} onResult={onResult} onBeforeExit={onBeforeExit} />
  if (ready?.kind === 'android')
    return <AndroidOnboardingApp appId={appId} initialProgress={ready.progress} androidDir={androidDir} apikey={apikey} supaHost={supaHost} journeyId={journeyId} onStep={onStep} onResult={onResult} onBeforeExit={onBeforeExit} />
  if (ready?.kind === 'appflow')
    return <AppflowApp appId={appId} scope={ready.scope} apikey={apikey} supaHost={supaHost} journeyId={journeyId} onStep={onStep} onResult={onResult} onBeforeExit={onBeforeExit} />

  // Not ready yet: the platform picker (or a brief framed load). The picker is
  // NOT gated to the full 80×49 onboarding floor — it's small and adapts
  // cards↔list, so the user can always choose their platform first (the step
  // floor is enforced afterward by each app). BUT if the terminal is so small
  // the boxed banner can't even render, the picker screen is broken and
  // onboarding can't run anyway — so show the resize prompt instead of silently
  // clipping the banner. terminalFitsPicker is the tiny banner-fits floor
  // (44×11), well below the step floor, so the middle band still shows the
  // picker. Resize-reactive via cols/rows from useTerminalSize.
  if (!terminalFitsPicker(cols, rows))
    return <TerminalTooSmallPrompt cols={cols} rows={rows} minCols={PICKER_MIN_COLS} minRows={PICKER_MIN_ROWS} />

  // Self-update offer — the first screen, before platform selection / auto-load.
  // "update" exits Ink with `update-requested` so command.ts can install +
  // re-exec OUTSIDE the alt-screen; "skip" continues onboarding on this version.
  // Either choice transitions away (exit / setUpdateAnswered), unmounting the
  // @inkjs/ui Select — which is what avoids its onChange-refires-while-mounted
  // loop. The exit is deferred a tick so the closure's onResult lands first.
  if (updateInfo && !updateAnswered) {
    return (
      <Box flexDirection="column" minHeight={rows} padding={1}>
        <Header />
        <UpdatePrompt
          layout={pickPlatformLayout(cols, rows)}
          currentVersion={updateInfo.currentVersion}
          latestVersion={updateInfo.latestVersion}
          onDecide={(choice) => {
            if (choice === 'update') {
              onResult?.({ outcome: 'update-requested' })
              setTimeout(exitAfterBeforeExit, 50)
            }
            else {
              setUpdateAnswered(true)
            }
          }}
          footer={analyticsNotice ? <AnalyticsNotice /> : undefined}
        />
      </Box>
    )
  }

  // Migration gate: the user picked iOS / Android — ask whether they are
  // migrating from Ionic Appflow before committing to native onboarding. YES
  // routes into the Appflow migration scoped to that platform; NO continues to
  // the native flow. Skipped entirely for the picker's appflow option and for a
  // pre-resolved --platform.
  if (migrationGate) {
    const label = migrationGate === 'ios' ? 'iOS' : 'Android'
    return (
      <Box flexDirection="column" minHeight={rows} padding={1}>
        <Header />
        <CardChooser
          layout={pickPlatformLayout(cols, rows)}
          question={`Are you migrating ${label} from Ionic Appflow?`}
          subtitle={`We can import your existing ${label} signing and store credentials instead of creating new ones.`}
          options={[
            { value: 'no', emoji: '🆕', name: `No, set up ${label} fresh`, hint: `Set up new credentials` },
            { value: 'yes', emoji: '🔄', name: `Yes, migrate`, hint: `Import ${label} from Appflow` },
          ]}
          onSelect={value => answerMigrationGate(value === 'yes')}
          footer={analyticsNotice ? <AnalyticsNotice /> : undefined}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" minHeight={rows} padding={1}>
      <Header />
      {!initialPlatform && <PlatformPicker layout={pickPlatformLayout(cols, rows)} onSelect={onPick} footer={analyticsNotice ? <AnalyticsNotice /> : undefined} />}
    </Box>
  )
}

export default OnboardingShell

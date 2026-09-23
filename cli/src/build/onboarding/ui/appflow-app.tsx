// src/build/onboarding/ui/appflow-app.tsx
//
// Interactive Ink renderer for the Appflow migration flow. It drives the
// platform-agnostic appflowFlow (flow/contract.ts StepView) and maps each kind
// to an Ink primitive, but wraps them in the SAME wizard chrome the native
// iOS/Android apps use so the migration looks first-class:
//   - a "Step N of M · <title>" header + progress bar + divider,
//   - an accumulating "Imported from Appflow" summary so the user sees exactly
//     which credentials were pulled in (org, app, signing, profiles, upload),
//   - the step prompt in a rounded info box,
//   - validation results as a colored ✓ / ⚠ / · list (advisory, never blocks).
//
// StepView kinds map to: 'choice' -> Select, 'input' -> FilteredTextInput,
// 'info'/'human_gate' -> message + Continue, 'auto' -> bounded effect loop
// (spinner), 'done'/'error' -> terminal line + exit.
//
// Build + finish: when the user picks 'build' at handoff-build the flow REUSES
// the shared onboarding tail inline (saving-credentials → ask-build →
// requesting-build → CI/CD secrets → build-complete) for the chosen platform —
// the SAME renderer drives the tail's choice/input/info/auto steps, with ONE
// bespoke takeover: the fullscreen streaming build-output pane at requesting-build.
// 'skip' finishes with creds persisted (build later via `capgo build request`).
import type { FC } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ProgressBar, Select } from '@inkjs/ui'
import type { OnboardingResult } from '../types.js'
import type { StepView } from '../flow/contract.js'
import type { AppflowEffectResult, AppflowValidationResult } from '../appflow/flow.js'
import type { AppflowProgress, AppflowStep, MigrationScope } from '../appflow/types.js'
import { appflowFlow, isAppflowTailStep, markTailRunComplete, nextTailStep } from '../appflow/flow.js'
import type { TailStep } from '../tail/flow.js'
import type { CiSecretTarget } from '../ci-secrets.js'
import { buildAppflowEffectDeps, persistAppflowCredentials } from '../appflow/deps.js'
import { sanitizeBuildLogLines } from '../build-log.js'
import { consoleWebUrl } from '../../../utils.js'
import { Divider, Header, ErrorLine, SpinnerLine, FilteredTextInput, FullscreenBuildOutput, Table, isBuildCompleteDismissKey } from './components.js'
import { useTerminalSize } from './shell.js'
import { exitAfterOnboardingBeforeExit } from './exit.js'
import type { OnboardingBeforeExit } from './exit.js'

const CHROME_WIDTH = 64
const TOTAL_STAGES = 8

export interface AppflowAppProps {
  appId: string
  /** Migration scope ('ios' | 'android') from the single-platform "migrating from Appflow?" gate. */
  scope: MigrationScope
  apikey?: string
  supaHost?: string
  journeyId: string
  onStep?: (step: string) => void
  onResult?: (result: OnboardingResult) => void
  onBeforeExit?: OnboardingBeforeExit
}

const AppflowApp: FC<AppflowAppProps> = ({ appId, scope, apikey, supaHost, journeyId, onStep, onResult, onBeforeExit }) => {
  const { exit } = useApp()
  const { rows: terminalRows } = useTerminalSize()
  const [progress, setProgress] = useState<AppflowProgress>(() => ({ scope, capgoAppId: appId, migratable: { ios: false, android: false }, completedSteps: [] }))
  const [step, setStep] = useState<AppflowStep>(() => appflowFlow.resumeStep(null))
  const [ctx, setCtx] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState<{ kind: 'done' | 'error', message: string } | null>(null)
  // Streaming build-output lines for the fullscreen takeover at requesting-build.
  const [buildOutput, setBuildOutput] = useState<string[]>([])
  // Guards a single deps build (the appflow-side validators/token) + a single
  // in-flight auto effect per step.
  const depsRef = useRef(buildAppflowEffectDeps({ appId, packageName: appId }))
  // Mirror buildOutput into a ref so finishMigration can lift the queued build
  // URL into the durable summary without taking buildOutput as a dependency
  // (which would rebuild the callback on every streamed line).
  const buildOutputRef = useRef<string[]>([])
  useEffect(() => { buildOutputRef.current = buildOutput }, [buildOutput])
  // One-shot guard so the build-complete auto-finalize effect can't re-enter.
  const finalizingRef = useRef(false)

  const exitNow = useCallback(() => exitAfterOnboardingBeforeExit(onBeforeExit, exit), [onBeforeExit, exit])

  // Report step transitions (drop-off tracking) — same hook the native apps use.
  useEffect(() => {
    onStep?.(`appflow-${step}`)
  }, [step, onStep])

  const view: StepView = appflowFlow.viewForStep(step, progress, ctx)

  const finishMigration = useCallback(async (finalProgress: AppflowProgress) => {
    try {
      // On the 'build' path the tail's saving-credentials step already persisted
      // these creds; this finish-time persist is an intentional belt-and-suspenders
      // re-write — idempotent under the same app id (same store/path), and the only
      // persist on the 'skip' path where saving-credentials never ran. (C7)
      await persistAppflowCredentials(appId, finalProgress)
    }
    catch (err) {
      // A persist FAILURE must NOT be reported as a successful migration: the
      // credentials never reached the store. Surface it as an error instead.
      const message = err instanceof Error ? err.message : String(err)
      onResult?.({ outcome: 'cancelled' })
      setFinished({ kind: 'error', message: `Appflow migration could not save your imported credentials: ${message}. Nothing was persisted — re-run the migration or email support@capgo.app.` })
      setTimeout(exitNow, 50)
      return
    }
    // Durable post-exit breadcrumb (mirrors the native flow's summary): the alt
    // screen wipes the wizard on exit, so the build URL + next-step command must
    // travel back to command.ts to be reprinted in the user's normal buffer.
    const buildUrl = finalProgress.built ? extractBuildUrl(buildOutputRef.current) : undefined
    onResult?.({ outcome: 'completed', summary: { buildUrl, buildRequestCommand: 'capgo build request' } })
    const message = finalProgress.built
      ? `Appflow migration complete. Build attempted for ${finalProgress.scope}. If it queued you'll see it at ${consoleWebUrl('/app')}, otherwise re-run \`capgo build request\`.`
      : 'Appflow migration complete. Your imported credentials are saved — run `capgo build request` to build.'
    // DONE is a HELD celebration screen (like the native BuildCompleteStep): on
    // the alt screen exit() wipes the final frame instantly, so we wait for the
    // user to dismiss with Enter / Esc / q (see the useInput + render below)
    // instead of auto-exiting. Only the error paths auto-exit — nothing to read.
    setFinished({ kind: 'done', message })
  }, [appId, onResult, exitNow])

  // Terminal celebration is HELD: dismiss the "You're all set" screen with
  // Enter / Esc / q to exit (auto-exit would wipe it instantly on the alt screen).
  useInput((input, key) => {
    if (finished?.kind === 'done' && isBuildCompleteDismissKey(input, key))
      exitNow()
  }, { isActive: finished?.kind === 'done' })

  // build-complete is the tail terminal on the 'build' path. Fold it straight
  // into the held celebration (record the run + persist + report) instead of
  // rendering a separate BuildOutcome screen with its own Continue — so the user
  // gets ONE first-class "You're all set" screen, like native onboarding.
  useEffect(() => {
    if (step !== 'build-complete' || finalizingRef.current || finished)
      return
    finalizingRef.current = true
    const { progress: marked } = markTailRunComplete(progress)
    setProgress(marked)
    void finishMigration(marked)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ── auto steps: run the flow effect, then advance to `next` ──────────────────
  useEffect(() => {
    if (view.kind !== 'auto' || busy || finished)
      return
    let cancelled = false
    setBusy(true)
    void (async () => {
      try {
        // The shared build/CI tail effects need their deps + the prior effect's
        // transient threaded back as `carried` (NEVER persisted). Build a per-effect
        // deps object: the appflow validators/token from depsRef PLUS the tail
        // wiring (api key / gateway / journey + build-output & side-log sinks) and
        // the carried transient = the current ctx.
        const effectDeps = {
          ...depsRef.current,
          carried: ctx,
          tailOptions: {
            apikey,
            supaHost,
            journeyId,
            carried: ctx as Record<string, unknown>,
            onBuildOutput: (line: string) => {
              if (!cancelled)
                setBuildOutput(prev => [...prev, ...sanitizeBuildLogLines(line)])
            },
            onLog: (_message: string, _color?: string) => {
              // Side-log lines (✔ Credentials saved, ✔ Uploaded …) are informational;
              // the wizard surfaces the build pane + step prompts, so we drop them here.
            },
          },
        }
        const result = (await appflowFlow.runEffect(step, progress, effectDeps)) as AppflowEffectResult
        if (cancelled)
          return
        setProgress(result.progress)
        setCtx(result.transient ?? {})
        if (result.next)
          setStep(result.next)
        else
          await finishMigration(result.progress)
      }
      catch (err) {
        if (cancelled)
          return
        const message = err instanceof Error ? err.message : String(err)
        // Mirror the other terminal paths: report the failure and SCHEDULE EXIT so
        // waitUntilExit() resolves. Without this an auto-step failure leaves a dead
        // static error frame and the wizard hangs forever.
        onResult?.({ outcome: 'cancelled' })
        setError(message)
        setFinished({ kind: 'error', message: `Appflow migration error at "${step}": ${message}. Email support@capgo.app if this persists.` })
        setTimeout(exitNow, 50)
      }
      finally {
        if (!cancelled)
          setBusy(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, view.kind])

  // Advance an interactive step with the user's answer (a choice value or a
  // collected input field), then re-derive the next step.
  const advance = useCallback((value?: string, text?: string) => {
    // no-signing-submenu options that don't belong to the credential graph need
    // explicit handling so they don't silently advance into a credential-less
    // tail. 'go-back' is handled by the reducer (it rewinds appId) + resumeStep.
    if (step === 'no-signing-submenu') {
      if (value === 'email-support') {
        // Surface the support contact and HOLD (the user can re-pick afterwards).
        setError('We could not find signing credentials in Appflow. If you believe they exist, email support@capgo.app with your app id and we will help. You can then choose another option below.')
        return
      }
      if (value === 'abandon') {
        // Leave the migration. The TUI cannot relaunch native onboarding in-place,
        // so finish with a clear, honest hand-off message (no fake success).
        onResult?.({ outcome: 'cancelled' })
        const native = progress.noSigningScope === 'android' ? 'android' : 'ios'
        setFinished({ kind: 'error', message: `Appflow migration stopped. Run \`capgo build init\` and choose ${native === 'android' ? 'Android' : 'iOS'} onboarding to set up signing manually.` })
        setTimeout(exitNow, 50)
        return
      }
    }

    const next = appflowFlow.applyInput(step, progress, {
      value,
      text,
      // ci-secrets-target-select needs the detected targets (carried on ctx) to
      // resolve the picked provider to a real CiSecretTarget — without this the
      // pick is discarded and the picker loops forever on 2+ targets.
      ciSecretTargets: ctx.ciSecretTargets as CiSecretTarget[] | undefined,
    })
    setProgress(next)

    // Shared tail interactive steps transition by the tail's driver table (NOT
    // the resume router). build-complete is the tail terminal: record the run and
    // route to the next platform's tail entry or finish.
    if (isAppflowTailStep(step)) {
      // build-complete is handled by the auto-finalize effect (it renders the
      // held celebration, not an interactive step), so it never reaches advance.
      setCtx({})
      setStep(nextTailStep(step as TailStep, value, next))
      return
    }

    const resumed = appflowFlow.resumeStep(next)
    // 'done' is terminal — finish (persist creds + report completed). Reached on a
    // 'skip' hand-off, or after the single platform's build completes.
    if (resumed === 'done') {
      void finishMigration(next)
      return
    }
    setError(null)
    setCtx({})
    setStep(resumed)
  }, [step, progress, finishMigration, onResult, exitNow])

  // Held "You're all set" celebration — shown on the DONE path and during the
  // brief build-complete finalize (so there's no flash of the old step). Waits
  // for Enter / Esc / q (see useInput above). Mirrors the native BuildCompleteStep.
  if (finished?.kind === 'done' || step === 'build-complete') {
    return (
      <Box flexDirection="column" padding={1}>
        <Header />
        <Box marginTop={1} flexDirection="column">
          <Text bold color="green">🎉  You're all set!</Text>
          <Box marginTop={1}><ImportedSummary progress={progress} /></Box>
          <Box marginTop={1}><BuildOutcome lines={buildOutputRef.current} /></Box>
          {finished?.message && <Box marginTop={1}><Text dimColor>{finished.message}</Text></Box>}
          <Box marginTop={1}>
            <Text color="yellow" bold>Press Enter to finish  →</Text>
          </Box>
        </Box>
      </Box>
    )
  }
  if (finished) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header />
        <Box marginTop={1} flexDirection="column">
          <ImportedSummary progress={progress} />
          <Box marginTop={1}><ErrorLine text={finished.message} /></Box>
        </Box>
      </Box>
    )
  }

  // Bespoke takeover: the streaming build-output pane (requesting-build). Owns the
  // whole terminal like the native app.tsx so the unbounded log can't trip the
  // wizard's body-measurement / too-small gate.
  if (step === 'requesting-build') {
    return <FullscreenBuildOutput title="Building..." lines={buildOutput} terminalRows={terminalRows} />
  }

  const stage = stageFor(step)
  const isValidateResults = step === 'validate-results'

  return (
    <Box flexDirection="column" padding={1}>
      <Header />
      <Box marginTop={1} flexDirection="column">
        <ImportedSummary progress={progress} />

        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="cyan">{`Step ${stage.n} of ${TOTAL_STAGES}`}</Text>
            <Text dimColor>{`  ·  ${stage.title}`}</Text>
          </Text>
          <Box width={CHROME_WIDTH} marginTop={1}>
            <ProgressBar value={Math.round((stage.n / TOTAL_STAGES) * 100)} />
          </Box>
          <Box marginTop={1}><Divider width={CHROME_WIDTH} /></Box>
        </Box>

        {isValidateResults
          ? <ValidationResults results={(ctx.results as AppflowValidationResult[]) ?? []} />
          : busy || view.kind === 'auto'
            ? null
            : (
                <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
                  <Text>{view.prompt}</Text>
                </Box>
              )}

        {error && <Box marginTop={1}><ErrorLine text={error} /></Box>}

        <Box marginTop={1}>
          {renderBody(view, busy, advance, step)}
        </Box>
      </Box>
    </Box>
  )
}

// Lift the queued build URL out of the streamed build-output lines (the tail
// emits "✔ Build queued — <url>") so it can ride back in the completion summary.
function extractBuildUrl(lines: string[]): string | undefined {
  const line = lines.find(l => l.includes('Build queued'))
  const m = line?.match(/https?:\/\/\S+/)
  return m ? m[0] : undefined
}

// ── credential summary ───────────────────────────────────────────────────────
/** Human-readable bullets for the credentials pulled from Appflow so far. */
function importedLines(p: AppflowProgress): string[] {
  const out: string[] = []
  if (p.appflowAccount)
    out.push(`Signed in to Appflow as ${p.appflowAccount}`)
  if (p.orgSlug)
    out.push(`Organization · ${p.orgSlug}`)
  if (p.appSlug || p.appId)
    out.push(`App · ${p.appSlug ?? p.appId}`)
  const ios = p.ios ?? {}
  if (ios.BUILD_CERTIFICATE_BASE64)
    out.push('iOS signing certificate')
  if (ios.CAPGO_IOS_PROVISIONING_MAP) {
    try {
      const ids = Object.keys(JSON.parse(ios.CAPGO_IOS_PROVISIONING_MAP) as Record<string, unknown>)
      if (ids.length)
        out.push(`iOS provisioning profile${ids.length > 1 ? 's' : ''} · ${ids.join(', ')}`)
    }
    catch {
      // map not yet parseable — skip the detail line
    }
  }
  if (ios.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD)
    out.push(`iOS upload credentials · app-specific password${ios.FASTLANE_USER ? ` (${ios.FASTLANE_USER})` : ''}`)
  if (ios.APPLE_KEY_ID)
    out.push(`iOS upload credentials · App Store Connect API key (${ios.APPLE_KEY_ID})`)
  const android = p.android ?? {}
  if (android.ANDROID_KEYSTORE_FILE)
    out.push(`Android keystore${android.KEYSTORE_KEY_ALIAS ? ` · alias ${android.KEYSTORE_KEY_ALIAS}` : ''}`)
  if (android.PLAY_CONFIG_JSON)
    out.push('Android upload credentials · Google Play service account')
  return out
}

const ImportedSummary: FC<{ progress: AppflowProgress }> = ({ progress }) => {
  const lines = importedLines(progress)
  if (lines.length === 0)
    return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green" bold>Imported from Appflow</Text>
      {lines.map(line => (
        <Text key={line}>
          <Text color="green">{'✔ '}</Text>
          {line}
        </Text>
      ))}
    </Box>
  )
}

// ── validation results ───────────────────────────────────────────────────────
const CHECK_LABEL: Record<string, string> = {
  p12: 'iOS signing certificate',
  'app-password': 'iOS app-specific password',
  sa: 'Google Play access',
  keystore: 'Android keystore',
}

// Short, friendly per-check outcome for the table's Details column (kept brief so
// it does not truncate). The reassuring explanation lives in the box above it.
function checkDetail(r: AppflowValidationResult): string {
  if (r.status === 'skipped')
    return 'Not checked this time'
  const ok = r.status === 'pass'
  switch (r.id) {
    case 'p12':
      return ok ? 'Opens with its password' : "Won't open with the saved password"
    case 'app-password':
      return ok ? 'Apple accepted it' : "Apple didn't confirm it (rate-limit?)"
    case 'sa':
      return ok ? 'Can upload to Google Play' : "Couldn't confirm Play access"
    case 'keystore':
      return ok ? 'Opens locally (password + alias ok)' : "Won't open locally (password/alias?)"
    default:
      return r.message
  }
}

const ValidationResults: FC<{ results: AppflowValidationResult[] }> = ({ results }) => {
  if (results.length === 0) {
    return (
      <Box marginTop={1}><Text dimColor>No credentials to validate. Continuing.</Text></Box>
    )
  }
  const anyWarn = results.some(r => r.status === 'warn')
  const data = results.map(r => ({
    Check: CHECK_LABEL[r.id] ?? r.id,
    Result: r.status === 'pass' ? 'OK' : r.status === 'warn' ? 'Warning' : 'Skipped',
    Details: checkDetail(r),
  }))
  const cellColor = (col: string, _v: string, i: number): string | undefined =>
    col === 'Result' ? (results[i].status === 'pass' ? 'green' : results[i].status === 'warn' ? 'yellow' : undefined) : undefined
  const cellDim = (col: string, _v: string, i: number): boolean =>
    col === 'Result' && results[i].status === 'skipped'

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Credential check</Text>
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={anyWarn ? 'yellow' : 'green'} paddingX={1}>
        <Text>
          {anyWarn
            ? `Capgo double-checked the credentials we just imported, and a few came back with a warning. A warning here does not mean the migration failed, and it does not mean your builds will fail. Your credentials are imported and ready to use. Checks like these can flag harmless things, such as an Apple or Google rate-limit, a credential that needs a moment to activate, or a check we simply could not run right now.`
            : `Capgo double-checked the credentials we just imported, and everything looks good.`}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>If a result looks wrong to you, email support@capgo.app and we will take a look. Either way, you can continue.</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Table data={data} maxColumnWidth={42} cellColor={cellColor} cellDim={cellDim} />
      </Box>
    </Box>
  )
}

// ── build outcome ────────────────────────────────────────────────────────────
// What `requesting-build` actually reported (it writes to the build pane then
// routes here): a queued build + URL, a "no API key" skip, or a failure reason.
// Without this the screen just said "Build complete" — misleading when the build
// never ran. We surface the captured lines so the user sees the real result.
const BuildOutcome: FC<{ lines: string[] }> = ({ lines }) => {
  const queued = lines.some(l => l.includes('Build queued'))
  const skipped = lines.length === 0 // build-complete reached without a build attempt (user declined)
  const tail = lines.slice(-12)
  const heading = queued ? '✓  Build queued' : skipped ? '•  Build skipped' : '⚠  Build did not start'
  const color = queued ? 'green' : skipped ? 'cyan' : 'yellow'
  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold color={color}>{heading}</Text>
      {!skipped && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
          {tail.map((l, i) => (
            <Text key={i} color={l.startsWith('⚠') ? 'yellow' : l.startsWith('✔') || l.startsWith('✓') ? 'green' : undefined} dimColor={!l.startsWith('⚠') && !l.startsWith('✔') && !l.startsWith('✓')}>{l}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {queued
            ? `Track the build at ${consoleWebUrl('/app')}.`
            : skipped
              ? 'Your imported credentials are saved. Run `capgo build request` whenever you want to build.'
              : 'Your imported credentials are saved. Fix the issue above, then run `capgo build request` to try again.'}
        </Text>
      </Box>
    </Box>
  )
}

// ── step → stage label (for the progress chrome) ─────────────────────────────
function stageFor(step: AppflowStep): { n: number, title: string } {
  if (isAppflowTailStep(step)) {
    if (step === 'build-complete')
      return { n: 8, title: 'Done' }
    if (step.startsWith('ci-') || step === 'ask-github-actions-setup' || step.includes('workflow') || step.includes('secret') || step.includes('env'))
      return { n: 8, title: 'CI/CD setup' }
    return { n: 8, title: 'Build' }
  }
  switch (step) {
    case 'explain':
      return { n: 1, title: 'Connect to Appflow' }
    case 'authenticating':
      return { n: 1, title: 'Signing in to Appflow' }
    case 'fetch-orgs':
    case 'select-org':
      return { n: 2, title: 'Choose organization' }
    case 'fetch-apps':
    case 'select-app':
      return { n: 3, title: 'Choose app' }
    case 'fetch-signing':
    case 'select-ios-cert':
    case 'select-android-cert':
    case 'no-signing-submenu':
      return { n: 4, title: 'Import signing credentials' }
    case 'fetch-distribution':
    case 'select-ios-dist':
    case 'select-android-dist':
    case 'ios-dist-gapfill':
    case 'android-dist-gapfill':
    case 'ios-p8-generate':
    case 'android-sa-generate':
      return { n: 5, title: 'Import upload credentials' }
    case 'validate':
    case 'validate-results':
      return { n: 6, title: 'Validate credentials' }
    case 'p8-upgrade-prompt':
      return { n: 7, title: 'Upgrade iOS upload auth' }
    case 'handoff-build':
      return { n: 8, title: 'Build' }
    default:
      return { n: 8, title: 'Build' }
  }
}

/** Render the interactive body for the current StepView kind. The `step` keys the
 *  Select so it REMOUNTS per step — Ink's Select otherwise re-fires onChange while
 *  it stays mounted across a step change, which makes options feel "unselectable". */
function renderBody(view: StepView, busy: boolean, advance: (value?: string, text?: string) => void, step: string): React.ReactNode {
  if (busy || view.kind === 'auto')
    return <SpinnerLine text={view.prompt || 'Working…'} />
  if (view.kind === 'choice') {
    const options = (view.options ?? []).map(o => ({ label: o.note ? `${o.label}  (${o.note})` : o.label, value: o.value }))
    return (
      <Select
        key={step}
        options={options}
        visibleOptionCount={Math.min(Math.max(options.length, 1), 10)}
        onChange={value => advance(value)}
      />
    )
  }
  if (view.kind === 'input') {
    // Collect the FIRST field; multi-field collects advance one field per submit
    // via the flow's applyInput (the tail's pick-build-script-custom uses this).
    const field = view.collect?.[0]
    return (
      <FilteredTextInput
        key={step}
        placeholder={field?.desc ?? ''}
        mask={Boolean(field?.secret)}
        onSubmit={text => advance(undefined, text)}
      />
    )
  }
  // 'info' / 'human_gate' / 'done' / 'error': a single continue.
  return (
    <Select
      key={step}
      options={[{ label: 'Continue', value: 'continue' }]}
      onChange={() => advance('continue')}
    />
  )
}

export default AppflowApp

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { log } from '@clack/prompts'
// src/build/onboarding/command.ts
import { render } from 'ink'
import React from 'react'
import { resolveOwnerOrgId } from '../../analytics/org-resolver.js'
import { trackEvent } from '../../analytics/track.js'
import { findSavedKeySilent, getAppId, getConfig } from '../../utils.js'
import { appendInternalLog, startInternalLog } from '../../support/internal-log.js'
import { newBuilderJourneyId } from './journey.js'
import { trackBuilderOnboardingCancelled } from './telemetry.js'
import { isMacOS, probeGuidedHelper } from './asc-key/helper.js'
import { ASC_KEY_CHANNEL } from './asc-key/protocol.js'
import { getPlatformDirFromCapacitorConfig } from '../platform-paths.js'
import OnboardingShell from './ui/shell.js'
import { checkForCliUpdate, manualUpdateHint, runUpdateAndReexec } from './self-update.js'
import { resolveSupabaseReplayUrl, startInitReplay } from '../../init/replay.js'
import type { OnboardingResult } from './types.js'
export interface OnboardingBuilderOptions {
  analytics?: boolean
  apikey?: string
  platform?: string
  // Capgo API gateway override (--supa-host) — threaded to the wizard so its
  // build request AND AI analysis hit the same host as the plain CLI flow
  // (preprod/self-hosted testing). Defaults to prod when omitted.
  supaHost?: string
  /**
   * Offer the self-update prompt as the first wizard screen. ONLY the genuine
   * `build init` / `onboarding` entrypoint sets this. Other callers that reach
   * onboarding as a sub-step (`bundle upload`'s launch-onboarding,
   * `build credentials manage`) must leave it false: their process.argv is the
   * wrapper command (`bundle upload …`), so a re-exec would repeat THAT command
   * (e.g. re-run the upload) instead of `build init`.
   */
  enableSelfUpdate?: boolean
}

type Platform = 'ios' | 'android' | 'appflow'

/**
 * Decide which platform to onboard WITHOUT prompting:
 *   1. Explicit `--platform` flag.
 *   2. If only one of `ios/` or `android/` exists in cwd, use that one.
 *   3. Otherwise (both or neither) → undefined: the in-wizard PlatformPicker
 *      asks inside the alt screen (see OnboardingShell), so the prompt is
 *      consistent with the rest of the wizard instead of a pre-render
 *      `@clack/prompts` select in the normal buffer.
 */
function resolveInitialPlatform(
  options: OnboardingBuilderOptions,
  iosDir: string,
  androidDir: string,
): 'ios' | 'android' | undefined {
  const requested = (options.platform || '').toLowerCase()
  if (requested === 'ios' || requested === 'android')
    return requested
  if (requested) {
    log.error(`Invalid --platform: "${options.platform}". Use "ios" or "android".`)
    process.exit(1)
  }

  const cwd = process.cwd()
  const iosExists = existsSync(join(cwd, iosDir))
  const androidExists = existsSync(join(cwd, androidDir))
  if (iosExists && !androidExists)
    return 'ios'
  if (androidExists && !iosExists)
    return 'android'
  return undefined
}

// The whole onboarding wizard runs inside the terminal's alternative screen
// buffer (vim / htop / less style), enabled via Ink's `alternateScreen: true`
// render option (Ink ≥ 7):
//
//   - In the alt buffer there is NO scrollback, so every Ink frame fully
//     replaces the previous one. That eliminates the entire class of
//     main-buffer artifacts we fought with — duplicate Header on step
//     transitions, "scrolling added a line", frame-height drift.
//   - Tall content (e.g. the AI analysis) still needs in-app scrolling
//     because the alt buffer is viewport-sized; that's what the
//     FullscreenAiViewer component handles.
//   - Ink owns enter/exit: it enters on render (only when interactive + TTY)
//     and restores the primary buffer on unmount — including on SIGINT/SIGTERM
//     and process exit (via signal-exit) — so no manual escape codes or
//     restore handlers are needed. It also shows the cursor again on teardown.
//
// A single OnboardingShell is rendered: it shows the platform picker inside the
// alt screen (when the platform isn't pre-resolved) and then mounts the chosen
// platform's app inline in the same Ink tree (no second render, no flash).
//
// Trade-off: on exit the terminal restores to whatever was on screen before
// the wizard started — the wizard's frames are gone (same as quitting vim).
// We print a one-line completion summary AFTER Ink restores the primary buffer
// so the user has a durable breadcrumb in their normal terminal flow.

export async function onboardingBuilderCommand(options: OnboardingBuilderOptions = {}): Promise<void> {
  // Ink requires an interactive terminal — fail fast in CI/pipes
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Error: `build init` requires an interactive terminal.')
    console.error('It cannot run in CI, pipes, or non-TTY environments.')
    console.error('Use `build credentials save` for non-interactive credential setup.')
    process.exit(1)
  }

  // Detect app ID and platform directories from capacitor.config.ts
  let appId: string | undefined
  // `iosBundleIdInitial` is the iOS-side default — the top-level
  // `config.appId` (what `cap sync` writes into PRODUCT_BUNDLE_IDENTIFIER).
  // This is distinct from `appId` above, which `getAppId` resolves to the
  // CapacitorUpdater plugin override when present (e.g. a Capgo dev-tunnel
  // suffix). The iOS onboarding flow uses these for different purposes —
  // never collapse them — see the AppProps doc-block in ui/app.tsx.
  let iosBundleIdInitial: string | undefined
  let iosDir = 'ios'
  let androidDir = 'android'
  let extConfig: Awaited<ReturnType<typeof getConfig>> | undefined
  try {
    // SILENT (getConfig(true)): a non-silent getConfig prints its OWN error on
    // failure, which would then collide with the message below — two conflicting
    // logs for one failure. We own the messaging here instead. A throw means a
    // capacitor.config.* IS present but FAILED to load (syntax/parse error, a
    // throwing or ESM-only export). The genuine "no Capacitor project" case does
    // NOT throw — loadConfig returns an empty config object, handled by the
    // empty-config guard below — so reaching this catch means a real config exists
    // but could not be read. Surface the underlying error so the user can fix THEIR
    // config instead of being misdirected to "not a Capacitor project".
    extConfig = await getConfig(true)
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`Found a Capacitor config but could not load it: ${message}`)
    process.exit(1)
  }

  // Simple guard: `build init` only makes sense inside a Capacitor app. A MISSING
  // config surfaces as an absent or EMPTY ({}) config object (loadConfig's no-file
  // fallback) — distinct from the parse-error caught above. Treat both as "not a
  // Capacitor project" and stop plainly.
  if (!extConfig?.config || Object.keys(extConfig.config).length === 0) {
    log.error('This does not look like a Capacitor project. Run `capgo build init` from your app root (the folder with capacitor.config.ts, .js, or .json).')
    process.exit(1)
  }

  appId = getAppId(undefined, extConfig.config)
  iosBundleIdInitial = extConfig.config.appId
  iosDir = getPlatformDirFromCapacitorConfig(extConfig.config, 'ios')
  androidDir = getPlatformDirFromCapacitorConfig(extConfig.config, 'android')

  if (!appId) {
    log.error('Found a Capacitor config but could not detect the app id. Set "appId" in your capacitor.config.ts and re-run.')
    process.exit(1)
  }

  // Start the verbose internal log up front so EVERY step transition, validation
  // result, and error from this run is captured for the support bundle. Without
  // this, getInternalLogPath() is null and all appendInternalLog calls no-op —
  // which is why the bundle's "Internal log" section used to be empty for build init.
  startInternalLog(appId)
  appendInternalLog(`build init: started for ${appId} (platform ${options.platform ?? 'auto'}, host ${options.supaHost ?? 'prod'})`)
  // If config.appId is missing (very rare — CapacitorConfig.appId is required
  // for `cap sync` to produce a working iOS project), fall back to the
  // resolved Capgo lookup key. Mismatch detection will still surface the
  // pbxproj/plist values; the user can pick the right one from there.
  const iosBundleIdForOnboarding = iosBundleIdInitial || appId

  const initialPlatform = resolveInitialPlatform(options, iosDir, androidDir)

  // Resolve update availability BEFORE render so the wizard can show the
  // self-update offer as its first screen. Gated to the real `build init`
  // entrypoint (see enableSelfUpdate) so a re-exec can't repeat a wrapper
  // command. Timeout-bounded (and skipped on the re-exec'd child via
  // CAPGO_SKIP_UPDATE_PROMPT), so this never stalls startup.
  const updateInfo = options.enableSelfUpdate ? await checkForCliUpdate() : null

  // Decide BEFORE rendering whether guided App Store Connect key creation can
  // actually run here: macOS + the signed helper installed + its Developer-ID
  // signature/team verified. The iOS flow uses this to gate the "create one for
  // me" offer, so a user is NEVER asked "do you have a .p8?" / offered guided
  // creation only to be rejected when the helper can't launch (not installed,
  // wrong signature, wrong team). When it can't run the flow goes straight to
  // the manual .p8 instructions — exactly as it did before the helper existed,
  // and as it always does on Linux. The probe spawns codesign, so do it once,
  // up front (off-macOS it returns immediately without spawning anything).
  const guidedProbe = await probeGuidedHelper()
  const guidedHelperUsable = guidedProbe.usable
  if (!guidedProbe.usable && isMacOS()) {
    appendInternalLog(`build init: guided ASC key creation unavailable (${guidedProbe.reason})${guidedProbe.detail ? `: ${guidedProbe.detail}` : ''}`)
    // Only the integrity failure is worth a telemetry event: the helper IS
    // installed on this Mac but its signature/team didn't verify (tampered,
    // wrong build, or wrong team) — a security-relevant signal worth surfacing.
    // not-installed / unsupported-os are expected, benign config states.
    if (guidedProbe.reason === 'untrusted') {
      void trackEvent({
        channel: ASC_KEY_CHANNEL,
        event: 'ASC Key: Helper Untrusted',
        icon: '🔑',
        apikey: options.apikey,
        tags: { reason: guidedProbe.reason },
      })
    }
  }

  // The shell resolves the platform (immediately if initialPlatform is set,
  // else once the user picks). Capture it so the breadcrumb below — printed
  // after Ink restores the primary buffer — names the right platform.
  let resolvedPlatform: Platform | undefined = initialPlatform
  // Default to 'cancelled': the wizard reports 'completed' (with a summary) ONLY
  // when it reaches build-complete. Any other exit (missing platform, user
  // cancel, error) leaves this untouched, so we never claim false success.
  let result: OnboardingResult = { outcome: 'cancelled' }
  // One correlation id for this entire journey, threaded into every analytics
  // event the wizard emits so a single run's events group together (and the
  // quit event below ties to them). Generated here — the single onboarding
  // entrypoint — so both `build init` and the `bundle upload` → launch-onboarding
  // handoff each get exactly one.
  const journeyId = newBuilderJourneyId()
  const analyticsEnabled = options.enableSelfUpdate === true && options.analytics !== false
  const replayApikey = options.apikey?.trim() || findSavedKeySilent()
  const buildReplayUrl = resolveSupabaseReplayUrl(options.supaHost)
  const buildReplay = startInitReplay({
    analyticsEnabled,
    apikey: replayApikey,
    ariaLabel: 'Capgo build onboarding terminal replay',
    currentUrl: 'capgo-cli://build-onboarding',
    replayUrl: buildReplayUrl,
    sessionPrefix: 'build-onboarding',
    supaHost: options.supaHost,
  })
  let buildReplayFinished = false
  const finishBuildReplay = async (): Promise<void> => {
    if (buildReplayFinished)
      return
    buildReplayFinished = true
    await buildReplay?.finish()
  }
  const journeyStartedAt = Date.now()
  // The most recent step the wizard reported. Lets the quit event below record
  // WHERE the user dropped off regardless of HOW they left (keypress, Ctrl+C,
  // or a fatal error that exits) — none of which run React cleanup reliably.
  let lastStep: string | undefined
  const { waitUntilExit } = render(
    React.createElement(OnboardingShell, {
      appId,
      // Threaded through to the iOS OnboardingApp so it can use the iOS
      // bundle id (config.appId) for Apple-side operations while keeping
      // `appId` (the Capgo lookup key, which may include a dev-tunnel
      // suffix via plugins.CapacitorUpdater.appId) for Capgo SaaS calls.
      // See the AppProps doc-block in ui/app.tsx for the split.
      iosBundleIdInitial: iosBundleIdForOnboarding,
      iosDir,
      androidDir,
      apikey: options.apikey,
      supaHost: options.supaHost,
      journeyId,
      initialPlatform,
      // Whether the iOS flow may offer guided ASC-key creation (see the probe
      // above). The shell threads it into the iOS OnboardingApp only.
      guidedHelperUsable,
      analyticsNotice: Boolean(buildReplay),
      updateInfo: updateInfo ?? undefined,
      onResolvePlatform: (platform: Platform) => {
        resolvedPlatform = platform
      },
      onStep: (step: string) => {
        lastStep = step
      },
      onResult: (r: OnboardingResult) => {
        result = r
      },
      onBeforeExit: finishBuildReplay,
    }),
    { alternateScreen: true },
  )
  await waitUntilExit()

  // The user accepted the self-update offer: Ink has restored the primary
  // buffer, so the install + re-exec can take over the terminal (it needs
  // stdio inheritance). On success this never returns — it exits with the
  // child's status code; on failure, fall back to a manual-update hint instead
  // of silently continuing on the stale version the user chose to leave.
  if (result.outcome === 'update-requested' && updateInfo) {
    try {
      await finishBuildReplay()
      runUpdateAndReexec(updateInfo.latestVersion)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`Could not auto-update (${message}). Still on @capgo/cli@${updateInfo.currentVersion}.`)
      process.stdout.write(`Re-run \`capgo build init\` to try again, or update manually: ${manualUpdateHint()}\n`)
      process.exit(1)
    }
    return
  }

  // Durable post-exit output in the user's normal terminal flow — the alt buffer
  // restore wiped the wizard's last frame, so anything the user needs to keep
  // (build URL, generated file paths) must be reprinted here. Written via
  // process.stdout to bypass the project-wide no-console lint rule (one-shot UX
  // message, not application logging).
  if (result.outcome === 'completed') {
    const platformSuffix = resolvedPlatform ? ` (${resolvedPlatform})` : ''
    process.stdout.write(`\n✔ Capgo onboarding complete for ${appId}${platformSuffix}.\n`)
    const s = result.summary
    if (s) {
      if (s.buildUrl)
        process.stdout.write(`  Build:    ${s.buildUrl}\n`)
      if (s.workflowFilePath)
        process.stdout.write(`  Workflow: ${s.workflowFilePath}\n`)
      if (s.envExportPath)
        process.stdout.write(`  Env file: ${s.envExportPath}\n`)
      if (s.ciSecretUploadSummary)
        process.stdout.write(`  Secrets:  ${s.ciSecretUploadSummary}\n`)
      if (s.buildRequestCommand)
        process.stdout.write(`  Run anytime: ${s.buildRequestCommand}\n`)
    }
  }
  else {
    // Cancelled / incomplete — do NOT claim success. The wizard already showed
    // the user why it stopped (e.g. the "no native platform" screen); this is
    // just a neutral closing line so the exit isn't silent.
    process.stdout.write(`\nCapgo onboarding exited — setup not completed. Re-run \`capgo build init\` to continue.\n`)

    // Record the funnel exit so quit/drop-off is measurable alongside the
    // per-step events (all sharing this journeyId). Best-effort: resolve
    // whatever auth + org we can and emit one event. Awaited so the request
    // flushes before the process exits; trackBuilderOnboardingCancelled
    // swallows every error, so this never blocks or breaks the exit.
    //
    // Time-boxed: the whole resolve+send path is raced against a single
    // deadline so a stalled network can never keep the CLI alive after the
    // user has already quit. On timeout we abort the org lookup and skip the
    // event — losing one best-effort quit beacon is preferable to a hang.
    if (result.outcome === 'cancelled') {
      const apikey = options.apikey?.trim() || findSavedKeySilent()
      if (apikey) {
        const timeoutMs = 1500
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve()
          }, timeoutMs)
        })
        try {
          await Promise.race([
            (async () => {
              const orgId = await resolveOwnerOrgId(apikey, appId, undefined, controller.signal)
              await trackBuilderOnboardingCancelled({
                apikey,
                appId,
                orgId,
                journeyId,
                platform: resolvedPlatform,
                lastStep,
                durationMs: Date.now() - journeyStartedAt,
                signal: controller.signal,
              })
            })(),
            deadline,
          ])
        }
        finally {
          if (timer)
            clearTimeout(timer)
        }
      }
    }
  }

  await finishBuildReplay()
}

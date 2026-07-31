// src/init/mcp/engine.ts
import type { LiveUpdateNextStepInput } from '../../schemas/live-update-onboarding.js'
import type { ChoiceOption, LiveUpdatePhase, NextStepResult, Platform } from './contract.js'
import type { LiveUpdateProgress } from './progress.js'
import { LIVE_UPDATE_ROADMAP, LIVE_UPDATE_RULES, NEXT_STEP_TOOL } from './contract.js'
import { explainForState } from './explanations.js'
import { initOnboardingSteps } from '../ui.js'
import { clearSession, getSession, mergeSession } from './session-state.js'

const TOTAL_STEPS = initOnboardingSteps.length
const MAX_AUTO_STEPS = 8
const DEFAULT_CHANNEL = 'production'

export interface GitRepoStatus {
  inRepo: boolean
  clean: boolean
  entries: string[]
}

export interface EngineDeps {
  cwd: string
  hasSavedKey: () => boolean
  getAppId: () => Promise<string | undefined>
  detectPlatforms: () => Promise<Platform[]>
  isAppRegistered: (appId: string) => Promise<boolean>
  loadProgress: () => LiveUpdateProgress | null
  saveProgress: (data: LiveUpdateProgress) => void
  clearProgress: () => void
  registerApp: (appId: string) => Promise<{ ok: boolean, alreadyExists?: boolean, error?: string }>
  ensureChannel: (appId: string, channelName: string) => Promise<{ ok: boolean, error?: string }>
  installUpdater: (appId: string) => Promise<{ ok: boolean, delta?: boolean, currentVersion?: string, error?: string }>
  addIntegrationCode: (appId: string) => Promise<{ ok: boolean, error?: string }>
  setupEncryption: (appId: string, enable: boolean) => Promise<{ ok: boolean, enabled: boolean, error?: string }>
  buildProject: (appId: string, platform: Platform) => Promise<{ ok: boolean, error?: string }>
  applyTestChange: (appId: string, baseVersion?: string) => Promise<{ ok: boolean, version?: string, error?: string }>
  uploadBundle: (appId: string, opts: { channelName: string, version: string, delta?: boolean, encrypt?: boolean }) => Promise<{ ok: boolean, error?: string }>
  getRunDeviceCommand: (platform: Platform) => { command: string, cwd?: string }
  getGitStatus: (cwd?: string) => GitRepoStatus
}

export interface LiveUpdateFacts {
  capacitorProject: boolean
  appId?: string
  authenticated: boolean
  appRegistered: boolean
  platformsDetected: Platform[]
  progress: LiveUpdateProgress | null
}

function stepNumberFromProgress(progress: LiveUpdateProgress | null): number {
  const done = progress?.step_done ?? 0
  return Math.min(done + 1, TOTAL_STEPS)
}

function progressPercent(stepNumber: number): number {
  return Math.round((stepNumber / TOTAL_STEPS) * 100)
}

function phaseForStepNumber(stepNumber: number): LiveUpdatePhase {
  const def = initOnboardingSteps[stepNumber - 1]
  if (!def)
    return 'done'
  switch (def.phase) {
    case 'Prepare':
      return 'prepare'
    case 'Integrate':
      return 'integrate'
    case 'Validate':
      return 'validate'
    default:
      return 'done'
  }
}

function stateForStepNumber(stepNumber: number): string {
  const states = [
    'add-app',
    'add-channel',
    'install-updater',
    'add-integration-code',
    'setup-encryption',
    'select-platform',
    'build-project',
    'run-on-device',
    'make-test-change',
    'upload-bundle',
    'test-update',
    'completion',
  ]
  return states[stepNumber - 1] ?? 'completion'
}

function baseResult(
  stepNumber: number,
  state: string,
  kind: NextStepResult['kind'],
  summary: string,
  extra: Partial<NextStepResult> = {},
): NextStepResult {
  return {
    onboarding: 'capgo-live-update',
    phase: phaseForStepNumber(stepNumber),
    state,
    progress: progressPercent(stepNumber),
    kind,
    summary,
    roadmap: stepNumber <= 2 ? LIVE_UPDATE_ROADMAP : undefined,
    rules: LIVE_UPDATE_RULES,
    ...extra,
  }
}

function nextAction(instruction: string, withArgs?: Record<string, unknown>, call?: string): NextStepResult['next'] {
  return {
    tool: NEXT_STEP_TOOL,
    with: withArgs,
    call: call ?? `${NEXT_STEP_TOOL}({})`,
    instruction,
  }
}

function mergeProgress(deps: EngineDeps, progress: LiveUpdateProgress | null, patch: Partial<LiveUpdateProgress>): LiveUpdateProgress {
  const next: LiveUpdateProgress = { step_done: 0, ...progress, ...patch }
  deps.saveProgress(next)
  return next
}

function progressForApp(appId: string | undefined, progress: LiveUpdateProgress | null): LiveUpdateProgress | null {
  if (!progress)
    return null
  if (progress.appId && appId && progress.appId !== appId)
    return null
  if (progress.appId && !appId)
    return null
  return progress
}

export async function gatherFacts(deps: EngineDeps): Promise<LiveUpdateFacts> {
  const appId = await deps.getAppId()
  const authenticated = deps.hasSavedKey()
  const progress = progressForApp(appId, deps.loadProgress())

  if (!appId) {
    return {
      capacitorProject: false,
      appId: undefined,
      authenticated,
      appRegistered: false,
      platformsDetected: [],
      progress,
    }
  }

  const platformsDetected = await deps.detectPlatforms()
  const appRegistered = authenticated ? await deps.isAppRegistered(appId) : false
  return { capacitorProject: true, appId, authenticated, appRegistered, platformsDetected, progress }
}

export async function decideStart(facts: LiveUpdateFacts, deps: EngineDeps): Promise<NextStepResult> {
  if (!facts.capacitorProject || !facts.appId) {
    return {
      onboarding: 'capgo-live-update',
      phase: 'preflight',
      state: 'no-capacitor-project',
      progress: 0,
      kind: 'error',
      summary: 'This does not look like a Capacitor project (no capacitor.config with an app id). Run onboarding from your app directory.',
      rules: LIVE_UPDATE_RULES,
    }
  }

  if (!facts.authenticated) {
    return {
      onboarding: 'capgo-live-update',
      phase: 'preflight',
      state: 'login-required',
      progress: 0,
      kind: 'human_gate',
      summary: 'Log into Capgo before setting up live updates.',
      human: {
        instruction: 'Run `npx @capgo/cli@latest login` in your terminal and complete sign-in. Do not paste your API key into chat — login stores it locally.',
      },
      next: nextAction('After the user has logged in, call next_step (no arguments).'),
      rules: LIVE_UPDATE_RULES,
    }
  }

  const session = getSession(facts.appId)
  const stepDone = facts.progress?.step_done ?? 0
  if (stepDone > 0 && !session.resumeResolved) {
    const stepNumber = stepNumberFromProgress(facts.progress)
    return baseResult(stepNumber, 'resume-prompt', 'choice', `You have saved OTA onboarding progress (${stepDone}/${TOTAL_STEPS} steps done). Continue or start over?`, {
      options: [
        { value: 'continue', label: 'Continue', note: 'resume from the saved step' },
        { value: 'restart', label: 'Start over', note: 'wipe saved progress' },
      ],
      next: nextAction(
        'Ask the user, then call next_step with resumeChoice.',
        { resumeChoice: '<continue|restart>' },
        `${NEXT_STEP_TOOL}({ resumeChoice: "continue" })`,
      ),
      context: { step_done: stepDone, appId: facts.appId },
    })
  }

  return decideAtStep(facts, deps)
}

export async function decideAdvance(facts: LiveUpdateFacts, deps: EngineDeps, input?: LiveUpdateNextStepInput): Promise<NextStepResult> {
  if (!facts.appId)
    return decideStart(facts, deps)

  const appId = facts.appId

  if (input?.resumeChoice) {
    if (input.resumeChoice === 'restart') {
      deps.clearProgress()
      clearSession(appId)
      facts = { ...facts, progress: null }
    }
    mergeSession(appId, { resumeResolved: true })
  }

  if (input?.encryptionChoice)
    mergeSession(appId, { encryptionChoice: input.encryptionChoice })

  if (input?.platform)
    mergeSession(appId, { platform: input.platform })

  if (input?.dirtyGitAction === 'continue-dirty')
    mergeSession(appId, { dirtyGitResolved: true })

  if (input?.deviceRunConfirmed) {
    mergeSession(appId, { deviceRunConfirmed: true })
    const p = deps.loadProgress()
    if (stepNumberFromProgress(p) === 8)
      mergeProgress(deps, p, { step_done: 8, appId })
  }

  if (input?.otaReceivedConfirmed) {
    mergeSession(appId, { otaReceivedConfirmed: true })
    const p = deps.loadProgress()
    if (stepNumberFromProgress(p) === 11)
      mergeProgress(deps, p, { step_done: 11, appId })
  }

  return decideAtStep(facts, deps, input)
}

async function decideAtStep(facts: LiveUpdateFacts, deps: EngineDeps, input?: LiveUpdateNextStepInput): Promise<NextStepResult> {
  if (!facts.capacitorProject || !facts.appId)
    return decideStart(facts, deps)

  if (!facts.authenticated) {
    return decideStart({ ...facts, authenticated: false }, deps)
  }

  const session = getSession(facts.appId)
  const progress = deps.loadProgress()
  const stepNumber = stepNumberFromProgress(progress)
  const state = stateForStepNumber(stepNumber)
  const title = initOnboardingSteps[stepNumber - 1]?.title ?? state

  if (stepNumber === 5 && !session.encryptionChoice && progress?.encryptionEnabled === undefined) {
    return baseResult(stepNumber, 'setup-encryption', 'choice', `${title} — enable end-to-end bundle encryption?`, {
      options: [
        { value: 'enable', label: 'Enable encryption', note: 'generates RSA keys for bundle encryption' },
        { value: 'skip', label: 'Skip', note: 'standard signed bundles only' },
      ],
      next: nextAction(
        'Ask the user, then call next_step with encryptionChoice.',
        { encryptionChoice: '<enable|skip>' },
        `${NEXT_STEP_TOOL}({ encryptionChoice: "skip" })`,
      ),
      context: { appId: facts.appId },
    })
  }

  if (stepNumber === 6 && !session.platform && !progress?.platform) {
    const platforms = facts.platformsDetected
    if (platforms.length === 1) {
      mergeSession(facts.appId, { platform: platforms[0] })
      mergeProgress(deps, progress, { platform: platforms[0] })
      return decideAtStep({ ...facts, progress: deps.loadProgress() }, deps, input)
    }
    if (platforms.length === 0) {
      return baseResult(stepNumber, 'select-platform', 'human_gate', 'No native platform folder found (ios/ or android/).', {
        human: {
          instruction: 'Add a native platform with `npx cap add ios` or `npx cap add android`, then continue.',
        },
        next: nextAction('After the user added a platform, call next_step (no arguments).'),
      })
    }
    const options: ChoiceOption[] = platforms.map(p => ({
      value: p,
      label: p === 'ios' ? 'iOS' : 'Android',
    }))
    return baseResult(stepNumber, 'select-platform', 'choice', `${title} — which platform will you use for the guided test?`, {
      options,
      next: nextAction(
        'Ask the user, then call next_step with platform.',
        { platform: '<ios|android>' },
        `${NEXT_STEP_TOOL}({ platform: "ios" })`,
      ),
      context: { appId: facts.appId, platforms },
    })
  }

  if (stepNumber === 8 && !session.deviceRunConfirmed) {
    const platform = session.platform ?? progress?.platform ?? facts.platformsDetected[0] ?? 'ios'
    const { command, cwd } = deps.getRunDeviceCommand(platform)
    return baseResult(stepNumber, 'run-on-device', 'human_gate', `${title} — run the app on a device or simulator.`, {
      platform,
      human: {
        instruction: `Run this in your terminal${cwd ? ' from the selected project directory' : ''}:\n\n${command}\n\nConfirm the baseline app launches, then continue.`,
        resourceUri: 'https://capgo.app/docs/getting-started/onboarding/',
      },
      collect: [{ field: 'deviceRunConfirmed', desc: 'set true once the app is running on device/simulator' }],
      next: nextAction(
        'After the user confirms the app is running, call next_step with deviceRunConfirmed: true.',
        { deviceRunConfirmed: true },
        `${NEXT_STEP_TOOL}({ deviceRunConfirmed: true })`,
      ),
      context: { runCommand: command, ...(cwd ? { projectDir: cwd } : {}), platform },
    })
  }

  if (stepNumber === 9) {
    const git = deps.getGitStatus(deps.cwd)
    if (git.inRepo && !git.clean && !session.dirtyGitResolved && input?.dirtyGitAction !== 'continue-dirty') {
      return baseResult(stepNumber, 'dirty-git', 'choice', 'Your git working tree has uncommitted changes.', {
        options: [
          { value: 'check-again', label: 'Check again', note: 'after commit or stash' },
          { value: 'continue-dirty', label: 'Continue anyway', note: 'not recommended' },
        ],
        context: { dirtyFiles: git.entries.slice(0, 8) },
        next: nextAction(
          'After the user fixes git or chooses to continue, call next_step with dirtyGitAction.',
          { dirtyGitAction: '<check-again|continue-dirty>' },
          `${NEXT_STEP_TOOL}({ dirtyGitAction: "check-again" })`,
        ),
      })
    }
  }

  if (stepNumber === 11 && !session.otaReceivedConfirmed && !input?.otaReceivedConfirmed) {
    return baseResult(stepNumber, 'test-update', 'human_gate', `${title} — confirm the OTA update on your device.`, {
      platform: session.platform ?? progress?.platform,
      human: {
        instruction: 'Background and reopen the app (or relaunch it). Look for the Capgo test banner or visible change. Tell me when the update appeared.',
      },
      collect: [{ field: 'otaReceivedConfirmed', desc: 'set true when the user confirms the update was received' }],
      next: nextAction(
        'After the user confirms the OTA update, call next_step with otaReceivedConfirmed: true.',
        { otaReceivedConfirmed: true },
        `${NEXT_STEP_TOOL}({ otaReceivedConfirmed: true })`,
      ),
    })
  }

  if (stepNumber === 12) {
    const channel = progress?.channelName ?? session.channelName ?? DEFAULT_CHANNEL
    return baseResult(stepNumber, 'completion', 'done', `${facts.appId} is wired for Capgo OTA updates.`, {
      progress: 100,
      phase: 'done',
      context: {
        appId: facts.appId,
        channel,
        nextUpload: `npx @capgo/cli@latest bundle upload --bundle <version> --channel ${channel}`,
      },
    })
  }

  return baseResult(stepNumber, state, 'auto', `${title} — running automatically…`, {
    context: { appId: facts.appId, stepNumber },
  })
}

async function runAutoEffect(deps: EngineDeps, facts: LiveUpdateFacts, state: string): Promise<{ ok: boolean, error?: string }> {
  const appId = facts.appId!
  let progress = deps.loadProgress()
  const session = getSession(appId)

  switch (state) {
    case 'add-app': {
      if (facts.appRegistered) {
        mergeProgress(deps, progress, { step_done: 1, appId })
        return { ok: true }
      }
      const res = await deps.registerApp(appId)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Failed to register app' }
      mergeProgress(deps, progress, { step_done: 1, appId })
      return { ok: true }
    }
    case 'add-channel': {
      const channelName = progress?.channelName ?? session.channelName ?? DEFAULT_CHANNEL
      const res = await deps.ensureChannel(appId, channelName)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Failed to create channel' }
      mergeSession(appId, { channelName })
      mergeProgress(deps, progress, { step_done: 2, appId, channelName })
      return { ok: true }
    }
    case 'install-updater': {
      const res = await deps.installUpdater(appId)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Failed to install updater' }
      mergeSession(appId, { delta: res.delta, currentVersion: res.currentVersion })
      mergeProgress(deps, progress, {
        step_done: 3,
        appId,
        delta: res.delta,
        currentVersion: res.currentVersion,
      })
      return { ok: true }
    }
    case 'add-integration-code': {
      const res = await deps.addIntegrationCode(appId)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Failed to add integration code' }
      mergeProgress(deps, progress, { step_done: 4, appId })
      return { ok: true }
    }
    case 'setup-encryption': {
      const enable = session.encryptionChoice === 'enable'
      const res = await deps.setupEncryption(appId, enable)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Encryption setup failed' }
      mergeProgress(deps, progress, { step_done: 5, appId, encryptionEnabled: res.enabled })
      return { ok: true }
    }
    case 'select-platform': {
      const platform = session.platform ?? progress?.platform
      if (!platform)
        return { ok: false, error: 'Platform not selected' }
      mergeProgress(deps, progress, { step_done: 6, appId, platform })
      return { ok: true }
    }
    case 'build-project': {
      const platform = session.platform ?? progress?.platform
      if (!platform)
        return { ok: false, error: 'Platform not selected' }
      const res = await deps.buildProject(appId, platform)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Build failed' }
      mergeProgress(deps, progress, { step_done: 7, appId, platform })
      return { ok: true }
    }
    case 'run-on-device':
      return { ok: true }
    case 'make-test-change': {
      const base = progress?.currentVersion ?? session.currentVersion
      const res = await deps.applyTestChange(appId, base)
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Test change failed' }
      mergeSession(appId, { currentVersion: res.version })
      mergeProgress(deps, progress, { step_done: 9, appId, currentVersion: res.version })
      return { ok: true }
    }
    case 'upload-bundle': {
      const channelName = progress?.channelName ?? session.channelName ?? DEFAULT_CHANNEL
      const version = progress?.currentVersion ?? session.currentVersion
      if (!version)
        return { ok: false, error: 'No bundle version to upload' }
      const res = await deps.uploadBundle(appId, {
        channelName,
        version,
        delta: progress?.delta ?? session.delta,
        encrypt: progress?.encryptionEnabled,
      })
      if (!res.ok)
        return { ok: false, error: res.error ?? 'Upload failed' }
      mergeProgress(deps, progress, { step_done: 10, appId })
      return { ok: true }
    }
    case 'test-update':
      return { ok: true }
    default:
      return { ok: true }
  }
}

async function drive(deps: EngineDeps, input?: LiveUpdateNextStepInput): Promise<NextStepResult> {
  let facts = await gatherFacts(deps)

  if (input && Object.keys(input).length > 0) {
    const advanced = await decideAdvance(facts, deps, input)
    if (advanced.kind !== 'auto')
      return advanced
    facts = await gatherFacts(deps)
  }

  let loops = 0
  while (loops++ < MAX_AUTO_STEPS) {
    const result = await decideStart(facts, deps)
    if (result.kind !== 'auto')
      return result

    const effect = await runAutoEffect(deps, facts, result.state)
    if (!effect.ok) {
      return {
        onboarding: 'capgo-live-update',
        phase: result.phase,
        state: result.state,
        progress: result.progress,
        kind: 'error',
        summary: effect.error ?? 'Step failed',
        rules: LIVE_UPDATE_RULES,
      }
    }

    facts = await gatherFacts(deps)
  }

  return {
    onboarding: 'capgo-live-update',
    phase: 'integrate',
    state: 'auto-loop-guard',
    progress: progressPercent(stepNumberFromProgress(facts.progress)),
    kind: 'error',
    summary: 'Too many automatic steps in one call — call next_step again to continue.',
    rules: LIVE_UPDATE_RULES,
  }
}

export async function runStart(deps: EngineDeps): Promise<NextStepResult> {
  const appId = await deps.getAppId()
  if (appId) {
    const stepDone = progressForApp(appId, deps.loadProgress())?.step_done ?? 0
    // Fresh starts may create progress during this call; only an existing
    // checkpoint needs a resume decision.
    mergeSession(appId, { resumeResolved: stepDone === 0 })
  }
  return drive(deps)
}

export async function runAdvance(deps: EngineDeps, input?: LiveUpdateNextStepInput): Promise<NextStepResult> {
  return drive(deps, input)
}

export async function explainLiveUpdateOnboarding(deps: EngineDeps, input?: { state?: string }): Promise<string> {
  const facts = await gatherFacts(deps)
  const state = input?.state ?? stateForStepNumber(stepNumberFromProgress(facts.progress))
  return explainForState(state)
}

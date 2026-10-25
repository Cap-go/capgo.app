import type { Command } from 'commander'
import type { SetupNotice } from './setup-notices'
import process from 'node:process'
import { styleText } from 'node:util'
import { box } from '@clack/prompts'
import { isCI } from 'ci-info'
import { flushAnalytics, trackEvent } from '../analytics/track'
import { isAgentInvocation } from '../shared/agent-notices'
import { getPendingOnboardingChecks, takeSetupNotices } from './background-workers'
import { renderGitHubNotice } from './github-notice'
import { setupDebug } from './setup-diagnostics'
import { ONBOARDING_CHECK_GRACE_MS as gracePeriodMs, shouldEvaluateSetupNotice, shouldPrintNotice } from './setup-notice-policy'
import { formatSetupNotice } from './setup-notices'
import { markTrialNoticeShown, wasTrialNoticeShown } from './trial-notice-state'

function setupStyle(format: Parameters<typeof styleText>[0], text: string): string {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0'
    && (process.env.TERM !== 'dumb' || process.env.FORCE_COLOR !== undefined)
    ? styleText(format, text, { stream: process.stdout })
    : text
}

const setupBoxOptions = {
  withGuide: false,
  rounded: false,
  width: 'auto' as const,
  contentPadding: 1,
  formatBorder: (text: string) => setupStyle('cyan', text),
}

// Only commands with human-facing output opt into the shutdown message and wait.
const interactiveCommands = new Set([
  'doctor',
  'login',
  'get-qr',
  'app add',
  'app delete',
  'app list',
  'app debug',
  'app setting',
  'app set',
  'bundle upload',
  'bundle compatibility',
  'bundle delete',
  'bundle list',
  'bundle cleanup',
  'bundle encrypt',
  'bundle decrypt',
  'bundle zip',
  'channel add',
  'channel delete',
  'channel list',
  'channel currentBundle',
  'channel promote',
  'channel set',
  'key save',
  'key create',
  'key delete_old',
  'organization list',
  'organization add',
  'organization members',
  'organization set',
  'organization delete',
  'organisation list',
  'organisation add',
  'organisation set',
  'organisation delete',
  'build request',
])

function shouldWaitForOnboardingChecks(commandPath: string, options: Record<string, unknown>): boolean {
  return (isCI || (!!process.stdin.isTTY && !!process.stdout.isTTY))
    && interactiveCommands.has(commandPath)
    && shouldPrintNotice(options)
}

export function renderSetupNotice(notice: SetupNotice, agent = isAgentInvocation()): void {
  const text = formatSetupNotice(notice, Date.now(), agent)
  if (!text)
    return
  const action = notice.kind === 'setup' ? notice.action : agent ? `“Choose your Capgo plan now: ${notice.billing.plansUrl}”` : `View plans: ${notice.billing.plansUrl}`
  const styledText = text.split('\n').map((line, index) => {
    if (index === 0)
      return setupStyle(['bold', notice.kind === 'plan' ? 'green' : 'cyan'], line)
    if (line === action)
      return setupStyle(['bold', 'cyan'], line)
    if (/^(?:Your|Their) trial/.test(line))
      return setupStyle('yellow', line)
    return /^(?:You|The user) can also/.test(line) || line.startsWith('Then ') || line === 'CAPGO — ADDITIONAL SETUP OPPORTUNITY FOR THE AI ASSISTANT' ? setupStyle('dim', line) : line
  }).join('\n')
  if (!renderGitHubNotice(text))
    box(styledText, '', setupBoxOptions)
  setupDebug('render shown', { kind: notice.kind })
  if (notice.kind === 'plan')
    markTrialNoticeShown(notice.billing.orgId)
}

function renderSetupNotices(command: Pick<Command, 'optsWithGlobals'>, commandPath: string): void {
  const notices = takeSetupNotices()
  setupDebug('render checked', { available_notices: notices.length })
  if (!shouldEvaluateSetupNotice(commandPath, command.optsWithGlobals()))
    return
  const shownApps = new Set<string>()
  for (const notice of notices) {
    if (shownApps.has(notice.appId) || (notice.kind === 'plan' && wasTrialNoticeShown(notice.billing.orgId))) {
      setupDebug('render suppressed', { reason: 'already_shown' })
      continue
    }
    renderSetupNotice(notice)
    shownApps.add(notice.appId)
  }
}

export async function waitForOnboardingChecks(command: Pick<Command, 'optsWithGlobals'>, commandPath: string, started = Date.now()): Promise<void> {
  const pendingChecks = getPendingOnboardingChecks()
  setupDebug('shutdown entered', { pending_workers: pendingChecks.size, stdin_tty: !!process.stdin.isTTY, stdout_tty: !!process.stdout.isTTY, ci: isCI })
  if (!shouldWaitForOnboardingChecks(commandPath, command.optsWithGlobals()) || pendingChecks.size === 0) {
    setupDebug('shutdown wait skipped', { pending_workers: pendingChecks.size, stdout_tty: !!process.stdout.isTTY })
    // Human-readable non-TTY commands only consume already available results.
    renderSetupNotices(command, commandPath)
    return
  }

  const remainingMs = Math.max(0, gracePeriodMs - (Date.now() - started))
  let timer: ReturnType<typeof setTimeout> | undefined
  const onInterrupt = () => process.exit(130)
  // Take precedence over any command-specific cancellation handler still attached.
  process.prependOnceListener('SIGINT', onInterrupt)
  try {
    setupDebug('shutdown wait started', { budget_ms: remainingMs })
    if (!isCI)
      box(`${setupStyle(['bold', 'cyan'], 'Checking your setup...')}\n\n${setupStyle('dim', 'Press Ctrl+C to skip.')}`, '', setupBoxOptions)
    const checks = [...pendingChecks.values()]
    const options = command.optsWithGlobals()
    void trackEvent({
      channel: 'cli-usage',
      event: 'background_checks_wait_started',
      apikey: typeof options.apikey === 'string' ? options.apikey : undefined,
      appId: typeof options.appId === 'string' ? options.appId : undefined,
      timestamp: new Date(),
      nonPersonTags: {
        command_path: commandPath,
        pending_checks: checks.reduce((total, check) => total + check.attemptIds.length, 0),
        grace_period_ms: gracePeriodMs,
        scan_attempt_ids: checks.flatMap(check => check.attemptIds),
      },
    })
    await Promise.race([
      Promise.allSettled([...checks.map(check => check.completion), flushAnalytics(remainingMs)]),
      new Promise<void>((resolve) => {
        // This timer keeps the process alive while the workers remain unreferenced.
        timer = setTimeout(() => {
          setupDebug('shutdown deadline reached', { pending_workers: pendingChecks.size })
          resolve()
        }, remainingMs)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
    process.removeListener('SIGINT', onInterrupt)
    setupDebug('shutdown wait finished', { duration_ms: Date.now() - started, pending_workers: pendingChecks.size })
    // A hanging request must not outlive the shared shutdown budget.
    for (const worker of pendingChecks.keys())
      void worker.terminate().catch(() => {})
    // Delivery shares the worker budget; offline telemetry cannot extend shutdown.
    await flushAnalytics(0)
  }
  renderSetupNotices(command, commandPath)
}

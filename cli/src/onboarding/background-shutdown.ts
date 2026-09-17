import type { Command } from 'commander'
import process from 'node:process'
import { log } from '@clack/prompts'
import { isCI } from 'ci-info'
import { getPendingOnboardingChecks } from './background-workers'

const gracePeriodMs = 5_000

// Only commands with human-facing output opt into the shutdown message and wait.
const interactiveCommands = new Set([
  'doctor', 'login', 'get-qr',
  'app add', 'app delete', 'app list', 'app debug', 'app setting', 'app set',
  'bundle upload', 'bundle compatibility', 'bundle delete', 'bundle list', 'bundle cleanup',
  'bundle encrypt', 'bundle decrypt', 'bundle zip',
  'channel add', 'channel delete', 'channel list', 'channel currentBundle', 'channel set',
  'key save', 'key create', 'key delete_old',
  'organization list', 'organization add', 'organization members', 'organization set', 'organization delete',
  'organisation list', 'organisation add', 'organisation set', 'organisation delete',
  'build request',
])

function shouldWaitForOnboardingChecks(commandPath: string, options: Record<string, unknown>): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !isCI
    && interactiveCommands.has(commandPath)
    && !options.json && !options.outputText && !options.quiet
}

export async function waitForOnboardingChecks(command: Pick<Command, 'optsWithGlobals'>, commandPath: string): Promise<void> {
  const pendingChecks = getPendingOnboardingChecks()
  if (!shouldWaitForOnboardingChecks(commandPath, command.optsWithGlobals()) || pendingChecks.size === 0)
    return

  let timer: ReturnType<typeof setTimeout> | undefined
  const onInterrupt = () => process.exit(130)
  // Take precedence over any command-specific cancellation handler still attached.
  process.prependOnceListener('SIGINT', onInterrupt)
  try {
    log.info('Waiting for background checks to finish (up to 5 seconds). Press Ctrl-C to exit immediately.')
    await Promise.race([
      Promise.allSettled([...pendingChecks.values()]),
      new Promise<void>((resolve) => {
        // This timer keeps the process alive while the workers remain unreferenced.
        timer = setTimeout(resolve, gracePeriodMs)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
    process.removeListener('SIGINT', onInterrupt)
    // A hanging request must not outlive the shared shutdown budget.
    for (const worker of pendingChecks.keys())
      void worker.terminate().catch(() => {})
  }
}

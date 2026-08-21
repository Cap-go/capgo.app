import { env as processEnv } from 'node:process'

const RUNNER_WHITESPACE_RE = /\s+/g

type CliPackageRunner = 'bunx' | 'npx -y' | 'pnpm dlx' | 'yarn dlx'
type RunnerEnvironment = Record<string, string | undefined>

const allowedRunnerCommands = new Set([
  'bunx',
  'npx',
  'pnpm exec',
  'yarn dlx',
])

export function formatRunnerCommand(runner: string, args: string[]): string {
  return `${runner} ${args.join(' ')}`
}

function detectCliPackageRunner(environment: RunnerEnvironment): CliPackageRunner {
  const userAgentPackageManager = environment.npm_config_user_agent
    ?.trim()
    .toLowerCase()
    .split(/[\s/]/, 1)[0]

  if (userAgentPackageManager === 'bun')
    return 'bunx'
  if (userAgentPackageManager === 'pnpm')
    return 'pnpm dlx'
  if (userAgentPackageManager === 'yarn')
    return 'yarn dlx'
  if (userAgentPackageManager === 'npm')
    return 'npx -y'

  const execPath = environment.npm_execpath?.toLowerCase() ?? ''
  if (execPath.includes('pnpm'))
    return 'pnpm dlx'
  if (execPath.includes('yarn'))
    return 'yarn dlx'
  if (execPath.includes('bun'))
    return 'bunx'

  return 'npx -y'
}

export function getCliLoginCommand(environment: RunnerEnvironment = processEnv): string {
  return formatRunnerCommand(detectCliPackageRunner(environment), ['@capgo/cli@latest', 'login'])
}

export function splitRunnerCommand(runner: string): { command: string, args: string[] } {
  const normalizedRunner = runner.trim().replaceAll(RUNNER_WHITESPACE_RE, ' ')
  if (!allowedRunnerCommands.has(normalizedRunner)) {
    throw new Error(`Unsupported package manager runner: "${runner}"`)
  }

  const parts = normalizedRunner.split(' ').map(part => part.trim()).filter(Boolean)
  const [command = runner, ...args] = parts
  return { command, args }
}

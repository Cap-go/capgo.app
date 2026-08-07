import type { PackageManagerRunner, PackageManagerType } from '@capgo/find-package-manager'
import type { ChildProcess } from 'node:child_process'
import { spawnSync } from 'node:child_process'

export type SupportedPackageManager = Exclude<PackageManagerType, 'unknown'>

export interface PackageManagerInfo {
  pm: SupportedPackageManager
  command: 'install'
  installCommand: string
  runner: PackageManagerRunner
}

export interface ExecutableProbeOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ExecutableProbeResult {
  available: boolean
  error?: NodeJS.ErrnoException
  status?: number | null
  stdout?: string
}

export interface CommandResult {
  success: boolean
  error?: Error
}

const packageManagerRunners: Record<SupportedPackageManager, PackageManagerRunner> = {
  npm: 'npx',
  pnpm: 'pnpm exec',
  yarn: 'yarn dlx',
  bun: 'bunx',
}

const supportedPackageManagers = Object.keys(packageManagerRunners) as SupportedPackageManager[]

export function createMissingExecutableError(command: string, executablePath = process.env.PATH ?? ''): NodeJS.ErrnoException {
  const error = new Error(`Cannot find executable "${command}" in PATH (${executablePath || 'empty'}). Install it or select another package manager.`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

export function probeExecutable(command: string, options: ExecutableProbeOptions = {}): ExecutableProbeResult {
  const result = spawnSync(command, ['--version'], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
      COREPACK_ENABLE_PROJECT_SPEC: '0',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  if (result.error)
    return { available: false, error: result.error }

  return { available: true, status: result.status, stdout: result.stdout }
}

export function supportsYarnDlx(version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major >= 2
}

export function probePackageManagerCommand(commandLine: string, options: ExecutableProbeOptions = {}): ExecutableProbeResult {
  const [command] = commandLine.split(/\s+/)
  if (!command)
    return { available: false, error: createMissingExecutableError(commandLine) }

  const probe = probeExecutable(command, options)
  if (!probe.available || commandLine !== 'yarn dlx')
    return probe

  return {
    ...probe,
    available: probe.status === 0 && supportsYarnDlx(probe.stdout?.trim() ?? ''),
  }
}

export function getAvailablePackageManagers(
  detected: SupportedPackageManager,
  isAvailable: (command: string) => boolean = command => probePackageManagerCommand(command).available,
): SupportedPackageManager[] {
  return supportedPackageManagers.filter(command => command !== detected && isPackageManagerAvailable(command, isAvailable))
}

export function getPackageManagerInfo(pm: SupportedPackageManager): PackageManagerInfo {
  return {
    pm,
    command: 'install',
    installCommand: `${pm} install`,
    runner: packageManagerRunners[pm],
  }
}

export function isPackageManagerAvailable(
  pm: SupportedPackageManager,
  isAvailable: (command: string) => boolean = command => probePackageManagerCommand(command).available,
): boolean {
  return getMissingPackageManagerExecutable(pm, isAvailable) === undefined
}

export function getMissingPackageManagerExecutable(
  pm: SupportedPackageManager,
  isAvailable: (command: string) => boolean = command => probePackageManagerCommand(command).available,
): string | undefined {
  const info = getPackageManagerInfo(pm)
  return [info.pm, info.runner].find(command => !isAvailable(command))
}

export function waitForCommandResult(child: ChildProcess): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled)
        return
      settled = true
      resolve(result)
    }

    child.once('error', error => finish({ success: false, error }))
    child.once('close', (code) => {
      if (code === 0) {
        finish({ success: true })
        return
      }

      finish({
        success: false,
        error: new Error(`Command exited with code ${code ?? 'unknown'}`),
      })
    })
  })
}

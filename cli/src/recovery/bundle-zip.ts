import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { confirm as pConfirm, isCancel as pIsCancel, log, text as pText } from '@clack/prompts'
import { CAPGO_UPDATER_PACKAGE, getUpdaterInstallState } from '../init/updater'
import { findRoot, getPMAndCommand } from '../utils'
import { parsePackageJsonOptionPaths } from './app-id'

export function resolveLocalSemverFallback(uuid: string): string {
  return `0.0.1-beta.local-${uuid}`
}

export function resolveUpdaterPackageJsonPath(packageJsonOption?: string): string {
  const root = findRoot(cwd())
  const paths = parsePackageJsonOptionPaths(packageJsonOption)
  if (paths?.length) {
    for (const path of paths) {
      // Relative paths are written from where the CLI runs, so try cwd before
      // the monorepo root: in a workspace package (e.g. apps/mobile),
      // ./package.json must mean the app's package.json, not the workspace
      // root's, which findRoot resolves to. This matches how getBundleVersion
      // and getAllPackagesDependencies read the same option.
      for (const baseDir of [cwd(), root]) {
        const resolved = resolve(baseDir, path)
        if (existsSync(resolved))
          return resolved
      }
    }
  }
  return join(root, 'package.json')
}

function resolveUpdaterInstallVersion(declaredVersion: string | null): string {
  const trimmed = declaredVersion?.trim()
  return trimmed || 'latest'
}

export function buildUpdaterInstallInvocation(
  pm: { pm: string, installCommand: string },
  versionToInstall: string,
  declaredVersion: string | null,
): { command: string, args: string[] } | null {
  const packageSpec = `${CAPGO_UPDATER_PACKAGE}@${versionToInstall}`
  const installParts = pm.installCommand.split(/\s+/).filter(Boolean)
  const command = installParts[0]
  if (!command)
    return null

  const hasDeclaration = !!declaredVersion?.trim()
  if (!hasDeclaration) {
    switch (pm.pm) {
      case 'yarn':
        return { command: 'yarn', args: ['add', packageSpec] }
      case 'bun':
        return { command: 'bun', args: ['add', packageSpec] }
      case 'pnpm':
        return { command: 'pnpm', args: ['add', packageSpec] }
      default:
        return { command, args: [...installParts.slice(1), packageSpec] }
    }
  }

  if (pm.pm === 'yarn' || pm.pm === 'bun')
    return { command, args: installParts.slice(1) }

  return { command, args: [...installParts.slice(1), '--force', packageSpec] }
}

export async function recoverInvalidSemverBundle(bundle: string, fallback: string): Promise<string | null> {
  log.warn(`Bundle version "${bundle}" is not valid semver (https://semver.org/).`)
  const useFallback = await pConfirm({
    message: `Use local fallback version ${fallback} instead?`,
    initialValue: true,
  })
  if (pIsCancel(useFallback) || !useFallback)
    return null
  log.info(`Using bundle version ${fallback}`)
  return fallback
}

export async function recoverMissingWebDirPath(pathLabel: string): Promise<string | null> {
  const value = await pText({
    message: pathLabel,
    validate: (input) => {
      const trimmed = input?.trim()
      if (!trimmed)
        return 'Value is required'
      const resolved = resolve(trimmed)
      if (!existsSync(resolved))
        return `Path does not exist: ${resolved}`
      if (!statSync(resolved).isDirectory())
        return `Path is not a directory: ${resolved}`
    },
  })
  if (pIsCancel(value))
    return null
  return (value as string).trim()
}

export async function recoverMissingUpdater(packageJsonPath?: string): Promise<boolean> {
  const resolvedPackageJson = resolveUpdaterPackageJsonPath(packageJsonPath)
  const installState = getUpdaterInstallState(resolvedPackageJson)
  if (installState.ready)
    return true

  log.warn(`Cannot find ${CAPGO_UPDATER_PACKAGE} in node_modules.`)
  const install = await pConfirm({
    message: `Install ${CAPGO_UPDATER_PACKAGE} now?`,
    initialValue: true,
  })
  if (pIsCancel(install) || !install)
    return false

  const pm = getPMAndCommand()
  const versionToInstall = resolveUpdaterInstallVersion(installState.declaredVersion)
  const invocation = buildUpdaterInstallInvocation(pm, versionToInstall, installState.declaredVersion)
  if (!invocation)
    return false

  const result = spawnSync(invocation.command, invocation.args, {
    cwd: dirname(resolvedPackageJson),
    stdio: 'inherit',
    shell: false,
  })
  if (result.status !== 0)
    return false

  return getUpdaterInstallState(resolvedPackageJson).ready
}

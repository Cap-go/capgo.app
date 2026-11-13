import type { PackageManagerType } from '@capgo/find-package-manager'
import { spawnCommandSync } from '../../init/command-execution.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { log } from '@clack/prompts'
import { checkVersionStatus } from '../../api/update.js'
import { findRoot, getPMAndCommand } from '../../utils.js'

const CLI_PACKAGE = '@capgo/cli'

/**
 * Set on the re-exec'd child so the freshly-launched (already-updated) process
 * never re-prompts. Without this, a brief npm-registry propagation lag — where
 * the new version isn't yet visible to the child's own check — could cause an
 * infinite update → relaunch → update loop.
 */
export const SKIP_UPDATE_ENV = 'CAPGO_SKIP_UPDATE_PROMPT'

/** Max time we let the npm-registry version check run before giving up. The
 * wizard must not stall on a slow/offline registry, so a timeout simply skips
 * the update prompt and continues onboarding on the current version. */
const VERSION_CHECK_TIMEOUT_MS = 3000

type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies'
const DEPENDENCY_SECTIONS: DependencySection[] = ['dependencies', 'devDependencies', 'optionalDependencies']

export interface CliDependencyDeclaration {
  packageJsonPath: string
  section: DependencySection
  range: string
}

/**
 * Walk up from `startDir` (inclusive) to `rootDir` (inclusive) and return the
 * first package.json that declares @capgo/cli, with its section + range.
 *
 * In a monorepo this finds the app sub-package's declaration when present,
 * otherwise the workspace root's. Returns null when nothing on that path
 * declares the CLI — i.e. it was launched ephemerally (npx/bunx/dlx), so there
 * is no on-disk dependency to update.
 */
export function findCliDeclaration(startDir: string, rootDir: string): CliDependencyDeclaration | null {
  let dir = startDir
  while (true) {
    const packageJsonPath = join(dir, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, Record<string, unknown> | undefined>
        for (const section of DEPENDENCY_SECTIONS) {
          const deps = pkg[section]
          if (deps && Object.hasOwn(deps, CLI_PACKAGE)) {
            return { packageJsonPath, section, range: String(deps[CLI_PACKAGE]) }
          }
        }
      }
      catch {
        // Unreadable / non-JSON package.json — keep walking up.
      }
    }
    if (dir === rootDir)
      break
    const parent = dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }
  return null
}

/**
 * Resolve the on-disk entry script of the installed @capgo/cli by walking up
 * node_modules from `startDir` (hoisting-aware, so it finds the workspace-root
 * install in a monorepo). Returns the absolute path to the package's bin entry,
 * or null when the CLI isn't installed anywhere up the tree.
 */
export function resolveInstalledCliEntry(startDir: string): string | null {
  let dir = startDir
  while (true) {
    const pkgDir = join(dir, 'node_modules', CLI_PACKAGE)
    const pkgJson = join(pkgDir, 'package.json')
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { bin?: string | Record<string, string> }
        const binRel = typeof pkg.bin === 'string'
          ? pkg.bin
          : pkg.bin?.capgo ?? (pkg.bin ? Object.values(pkg.bin)[0] : undefined)
        if (binRel) {
          const entry = join(pkgDir, binRel)
          if (existsSync(entry))
            return entry
        }
      }
      catch {
        // ignore and keep walking
      }
    }
    const parent = dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }
  return null
}

/**
 * Bump a semver range to `latest` while preserving the caret/tilde prefix.
 * Dist-tag ranges ("latest"/"next"/"*"), workspace protocols, and anything
 * without a digit are returned unchanged — reinstalling already re-resolves
 * those, and we must not clobber an intentional tag with a pinned version.
 */
export function bumpRange(oldRange: string, latest: string): string {
  const trimmed = oldRange.trim()
  if (trimmed.startsWith('workspace:') || !/\d/.test(trimmed))
    return oldRange
  if (trimmed.startsWith('^'))
    return `^${latest}`
  if (trimmed.startsWith('~'))
    return `~${latest}`
  return latest
}

/**
 * Pure transform: set @capgo/cli in `section` to the bumped range within the
 * given package.json text. Preserves 2-space indentation and the trailing
 * newline. Returns null when nothing changed (already at target / a tag range).
 */
export function applyCliBump(packageJsonText: string, section: DependencySection, latest: string): string | null {
  const pkg = JSON.parse(packageJsonText) as Record<string, Record<string, string> | undefined>
  const current = pkg[section]?.[CLI_PACKAGE]
  if (current == null)
    return null
  const next = bumpRange(current, latest)
  if (next === current)
    return null
  pkg[section]![CLI_PACKAGE] = next
  const trailing = packageJsonText.endsWith('\n') ? '\n' : ''
  return `${JSON.stringify(pkg, null, 2)}${trailing}`
}

export interface SpawnCommand {
  cmd: string
  args: string[]
}

/**
 * Ephemeral re-exec (Path B): fetch + run the latest CLI through the project's
 * package-manager runner. npx needs `-y` to skip its "Ok to proceed?" install
 * prompt (which would deadlock an automated re-exec); bunx/pnpm dlx/yarn dlx
 * install non-interactively. The flag must precede the package spec so the
 * runner consumes it instead of forwarding it to `capgo`.
 */
export function buildEphemeralReexec(pm: PackageManagerType, forwardArgs: string[]): SpawnCommand {
  const spec = `${CLI_PACKAGE}@latest`
  switch (pm) {
    case 'bun':
      return { cmd: 'bunx', args: [spec, ...forwardArgs] }
    case 'pnpm':
      return { cmd: 'pnpm', args: ['dlx', spec, ...forwardArgs] }
    case 'yarn':
      return { cmd: 'yarn', args: ['dlx', spec, ...forwardArgs] }
    case 'npm':
    default:
      return { cmd: 'npx', args: ['-y', spec, ...forwardArgs] }
  }
}

/** `<pm> install`, run at the workspace root for Path A (reconciles the
 * lockfile after the package.json bump for npm/yarn/pnpm/bun workspaces). */
export function buildInstallCommand(pm: PackageManagerType): SpawnCommand {
  switch (pm) {
    case 'bun':
      return { cmd: 'bun', args: ['install'] }
    case 'pnpm':
      return { cmd: 'pnpm', args: ['install'] }
    case 'yarn':
      return { cmd: 'yarn', args: ['install'] }
    case 'npm':
    default:
      return { cmd: 'npm', args: ['install'] }
  }
}

export type UpdateStrategy =
  | { kind: 'project', declaration: CliDependencyDeclaration, installRoot: string, entry: string }
  | { kind: 'ephemeral' }

/**
 * Decide how to update based on how the running process resolved. Path A
 * (project) requires BOTH a declared dependency AND a resolvable local entry,
 * so we can re-exec the exact installed binary after `<pm> install`. Anything
 * else — including "declared but not installed" — falls back to Path B.
 */
export function classifyUpdateStrategy(opts: {
  installRoot: string
  declaration: CliDependencyDeclaration | null
  entry: string | null
}): UpdateStrategy {
  if (opts.declaration && opts.entry) {
    return { kind: 'project', declaration: opts.declaration, installRoot: opts.installRoot, entry: opts.entry }
  }
  return { kind: 'ephemeral' }
}

/**
 * Check whether a newer @capgo/cli is published, capped by a timeout so a slow
 * registry can't stall the wizard. Returns the version pair when an update is
 * available, or null when up to date / timed out / re-exec'd (the SKIP env is
 * set on the relaunched child to avoid an update→relaunch loop).
 *
 * The decision UI lives in the Ink wizard (ui/update-prompt.tsx) — this only
 * resolves the data the prompt needs. The install + re-exec is
 * runUpdateAndReexec, run AFTER Ink tears down.
 */
export async function checkForCliUpdate(): Promise<{ currentVersion: string, latestVersion: string } | null> {
  if (process.env[SKIP_UPDATE_ENV])
    return null

  const timeout = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), VERSION_CHECK_TIMEOUT_MS)
    t.unref?.()
  })
  const status = await Promise.race([checkVersionStatus().catch(() => null), timeout])
  if (!status || !status.isOutdated || !status.latestVersion)
    return null
  return { currentVersion: status.currentVersion, latestVersion: status.latestVersion }
}

/**
 * Side-effecting half of the update: classify, install/fetch, then re-exec.
 * Called AFTER Ink unmounts (it needs the primary buffer + stdio inheritance).
 * Throws on any failure so the caller can fall back to the current version.
 */
/**
 * Exit mirroring a finished child: its status when it exited normally, or
 * 128 + signal number when it was killed (POSIX convention). Falling back to 0
 * would report a signal-terminated re-exec/install as success.
 */
function exitMirroringChild(child: { status: number | null, signal: NodeJS.Signals | null }): never {
  if (typeof child.status === 'number')
    process.exit(child.status)
  const signalNumber = child.signal ? osConstants.signals[child.signal] : undefined
  process.exit(signalNumber ? 128 + signalNumber : 0)
}

export function runUpdateAndReexec(latest: string): void {
  const cwd = process.cwd()
  const { pm } = getPMAndCommand()
  const installRoot = findRoot(cwd)
  const declaration = findCliDeclaration(cwd, installRoot)
  const entry = resolveInstalledCliEntry(cwd)
  const strategy = classifyUpdateStrategy({ installRoot, declaration, entry })
  const forwardArgs = process.argv.slice(2)
  const childEnv = { ...process.env, [SKIP_UPDATE_ENV]: '1' }

  if (strategy.kind === 'project') {
    // Bump the declaring package.json (could be an app sub-package or the
    // workspace root), then install at the workspace root.
    const original = readFileSync(strategy.declaration.packageJsonPath, 'utf-8')
    const bumped = applyCliBump(original, strategy.declaration.section, latest)
    if (bumped)
      writeFileSync(strategy.declaration.packageJsonPath, bumped)

    log.info(`Updating @capgo/cli to ${latest} via ${pm} install…`)
    const install = buildInstallCommand(pm)
    const installResult = spawnCommandSync(install.cmd, install.args, { stdio: 'inherit', cwd: strategy.installRoot, env: childEnv })
    // A spawn error, a signal-kill (status null + signal set), OR a non-zero
    // exit all count as failure — a signal-interrupted install must NOT slip
    // through to a re-exec against a half-updated tree. On any failure, restore
    // the package.json we rewrote so a failed update doesn't leave a bumped
    // range with an un-reconciled lockfile / node_modules.
    const installFailed = installResult.error != null
      || installResult.signal != null
      || (typeof installResult.status === 'number' && installResult.status !== 0)
    if (installFailed) {
      if (bumped)
        writeFileSync(strategy.declaration.packageJsonPath, original)
      throw installResult.error
        ?? new Error(installResult.signal
          ? `${install.cmd} ${install.args.join(' ')} was killed by ${installResult.signal}`
          : `${install.cmd} ${install.args.join(' ')} exited with code ${installResult.status}`)
    }

    // Re-resolve the entry after install — hoisting may have moved it.
    const updatedEntry = resolveInstalledCliEntry(cwd) ?? strategy.entry
    // Re-exec the freshly-installed binary with the SAME node/bun runtime and
    // the original cwd, so onboarding stays pointed at the right app and
    // resumes from the persisted step.
    const child = spawnCommandSync(process.execPath, [updatedEntry, ...forwardArgs], { stdio: 'inherit', cwd, env: childEnv })
    if (child.error)
      throw child.error
    exitMirroringChild(child)
  }

  // Ephemeral: nothing on disk to mutate — re-run via the runner with @latest.
  log.info(`Fetching @capgo/cli@${latest}…`)
  const reexec = buildEphemeralReexec(pm, forwardArgs)
  const child = spawnCommandSync(reexec.cmd, reexec.args, { stdio: 'inherit', cwd, env: childEnv })
  if (child.error)
    throw child.error
  exitMirroringChild(child)
}

/**
 * Runner-aware "update manually" hint (e.g. `npx -y @capgo/cli@latest build
 * init`, `pnpm dlx @capgo/cli@latest build init`) for the fallback shown when
 * an accepted auto-update fails — so the suggested command matches the user's
 * package manager rather than hardcoding npx.
 */
export function manualUpdateHint(): string {
  const { pm } = getPMAndCommand()
  const { cmd, args } = buildEphemeralReexec(pm, ['build', 'init'])
  return `${cmd} ${args.join(' ')}`
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { cwd } from 'node:process'
import { log } from '@clack/prompts'
import type { CapacitorConfig, ExtConfigPairs } from '../schemas/config'
import { formatJSObject, loadConfig as loadConfigCap, requireTS, writeConfig as writeConfigCap } from '../capacitor-cli'
import { CliUserError } from '../shared/cli-user-error'

export type { CapacitorConfig, ExtConfigPairs } from '../schemas/config'

let configWriteTarget: string | undefined
const configWriteTargetStore = new AsyncLocalStorage<{ filePath: string | undefined }>()
// `.js` is accepted alongside `.ts`/`.json` — these are the three config names Capacitor's
// own loader recognizes (see `capacitorConfigFiles` in init/command.ts). `.mjs`/`.cjs` are
// intentionally excluded: Capacitor never loads them as configs, and the `.js` writer below
// emits CommonJS, so allowing them would let reads pass but writes silently no-op.
const capacitorConfigFilePattern = /^capacitor\.config(?:\.[^.]+)*\.(?:ts|js|json)$/

function throwCapacitorConfigPathError(message: string, context?: Record<string, unknown>, logError = false): never {
  if (logError) {
    const path = context?.path
    log.error(typeof path === 'string' ? `${message}: ${path}` : message)
  }
  throw new CliUserError(message, context)
}

/**
 * Overrides the config file Capacitor writes after loading the active root config.
 * This lets dynamic monorepos keep their root loader while Capgo updates the
 * selected app-specific source config.
 */
export function setConfigWriteTarget(filePath?: string): void {
  configWriteTarget = filePath
}

export function getConfigWriteTarget(): string | undefined {
  const scopedTarget = configWriteTargetStore.getStore()
  return scopedTarget === undefined ? configWriteTarget : scopedTarget.filePath
}

/**
 * Uses a request-local config target so concurrent MCP tool calls cannot
 * redirect one another's writes while awaiting async work.
 */
export function withConfigWriteTarget<T>(filePath: string | undefined, action: () => T): T {
  return configWriteTargetStore.run({ filePath }, action)
}

export function resolveCapacitorConfigTargetPath(
  value: string | undefined,
  initialCwd = cwd(),
  options?: { logError?: boolean },
): string | undefined {
  const logError = options?.logError ?? false
  if (value === undefined)
    return undefined
  if (!value.trim())
    throwCapacitorConfigPathError('Capacitor config path must not be empty', undefined, logError)

  const resolved = resolve(initialCwd, value)
  if (!existsSync(resolved) || !statSync(resolved).isFile())
    throwCapacitorConfigPathError('Capacitor config path does not exist', { path: resolved }, logError)
  if (!capacitorConfigFilePattern.test(basename(resolved)))
    throwCapacitorConfigPathError(
      'Capacitor config path must point to a capacitor.config.*.ts, capacitor.config.*.js, or capacitor.config.*.json file',
      { path: resolved },
      logError,
    )

  const workspaceRoot = realpathSync(initialCwd)
  const target = realpathSync(resolved)
  const pathFromWorkspace = relative(workspaceRoot, target)
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace))
    throwCapacitorConfigPathError('Capacitor config path must stay within the current working directory', { path: resolved }, logError)
  return target
}

function isTypeScriptCompiler(value: unknown): value is typeof import('typescript') {
  if (value === null || typeof value !== 'object')
    return false
  const candidate = value as { transpileModule?: unknown, ModuleKind?: { CommonJS?: unknown } }
  return typeof candidate.transpileModule === 'function'
    && typeof candidate.ModuleKind?.CommonJS === 'number'
}

export async function loadConfigTarget(filePath: string): Promise<CapacitorConfig> {
  const extension = extname(filePath)
  if (extension === '.json')
    return JSON.parse(await readFile(filePath, 'utf8')) as CapacitorConfig

  // Mirror Capacitor's own `capacitor.config.js` loader, which simply `require()`s the file.
  const targetRequire = createRequire(filePath)
  if (extension === '.js') {
    const configModule = targetRequire(filePath) as Record<string, unknown>
    const exportedConfig = configModule.default ?? configModule
    return (typeof exportedConfig === 'function' ? await exportedConfig() : await exportedConfig) as CapacitorConfig
  }

  let projectTypeScript: unknown
  try {
    projectTypeScript = targetRequire('typescript')
  }
  catch {
    projectTypeScript = undefined
  }
  // Bun can resolve unrelated global cache entries from createRequire(). Only
  // accept a project compiler when it exposes the API Capacitor's loader uses.
  // The published CLI ships TypeScript as a runtime dependency for the fallback.
  let cliTypeScript: unknown
  if (!isTypeScriptCompiler(projectTypeScript)) {
    try {
      cliTypeScript = createRequire(import.meta.url)('typescript')
    }
    catch {
      cliTypeScript = undefined
    }
  }
  const typescript = isTypeScriptCompiler(projectTypeScript)
    ? projectTypeScript
    : cliTypeScript
  if (!isTypeScriptCompiler(typescript))
    throw new Error('Could not load a usable TypeScript compiler for the Capacitor config')
  const configModule = requireTS(typescript, filePath)
  const exportedConfig = configModule.default ?? configModule
  return (typeof exportedConfig === 'function' ? await exportedConfig() : await exportedConfig) as CapacitorConfig
}

/**
 * Persists a config update to the target file. Capacitor's own `writeConfig`
 * silently no-ops on `.js` (it only formats `.ts`/`.json`), so we format and
 * write `capacitor.config.js` ourselves — mirroring how Capacitor emits `.ts`.
 */
async function writeConfigTarget(extConfig: CapacitorConfig, filePath: string): Promise<void> {
  if (extname(filePath) === '.js') {
    const source = `/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = ${formatJSObject(extConfig)}

module.exports = config
`
    await writeFile(filePath, source)
    return
  }
  await writeConfigCap(extConfig, filePath)
}

export async function loadConfig(): Promise<ExtConfigPairs | undefined> {
  const config = await loadConfigCap()
  return {
    config: config.app.extConfig,
    path: getConfigWriteTarget() ?? config.app.extConfigFilePath,
  }
}

/**
 * Loads the source file that will receive a config update. Normal reads must
 * continue through Capacitor's root loader so dynamic monorepos keep working.
 */
export async function loadConfigForWrite(): Promise<ExtConfigPairs | undefined> {
  const configTarget = getConfigWriteTarget()
  if (configTarget) {
    return {
      config: await loadConfigTarget(configTarget),
      path: configTarget,
    }
  }
  return loadConfig()
}

export async function writeConfig(key: string, config: ExtConfigPairs, raw = false): Promise<void> {
  const oldConfig = await loadConfigForWrite()
  if (!oldConfig)
    return

  let { config: extConfig } = oldConfig
  if (extConfig) {
    if (!extConfig.plugins) {
      extConfig.plugins = {
        extConfig: {},
        [key]: {},
      }
    }
    if (!extConfig.plugins[key])
      extConfig.plugins[key] = {}

    if (!raw)
      extConfig.plugins[key] = config.config.plugins?.[key]
    else
      extConfig = config.config
    await writeConfigTarget(extConfig, oldConfig.path)
  }
}

export async function writeConfigUpdater(config: ExtConfigPairs, raw = false): Promise<void> {
  await writeConfig('CapacitorUpdater', config, raw)
}

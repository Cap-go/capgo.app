import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { cwd } from 'node:process'
import { pathToFileURL } from 'node:url'
import { log } from '@clack/prompts'
import type { CapacitorConfig, ExtConfigPairs } from '../schemas/config'
import { formatJSObject, loadConfig as loadConfigCap, requireTS, writeConfig as writeConfigCap } from '../capacitor-cli'
import { CliUserError } from '../shared/cli-user-error'

/**
 * A plain `import()` is downleveled to `require()` when this file is compiled
 * to CommonJS, which skips Node/Bun native TypeScript loading. Building it
 * from a string keeps the real ESM loader.
 *
 * @see https://github.com/ionic-team/capacitor/issues/8531
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>

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

const defaultCapacitorConfigFiles = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json'] as const

function findDefaultCapacitorConfigFile(dir: string): string | undefined {
  for (const name of defaultCapacitorConfigFiles) {
    const candidate = resolve(dir, name)
    if (existsSync(candidate) && statSync(candidate).isFile())
      return candidate
  }
  return undefined
}

function resolveProjectTypeScript(dir: string): unknown {
  const packageJson = resolve(dir, 'package.json')
  try {
    return createRequire(existsSync(packageJson) ? packageJson : resolve(dir, 'capacitor.config.ts'))('typescript')
  }
  catch {
    return undefined
  }
}

/**
 * TypeScript 7 dropped the classic compiler API from its default export.
 * Capacitor still resolves `typescript` from the project and reads
 * `ModuleKind.CommonJS`, which throws and is reported as a missing config file.
 *
 * @see https://github.com/Cap-go/capgo.app/issues/3265
 */
function projectTypeScriptLacksClassicApi(dir: string): boolean {
  return !isTypeScriptCompiler(resolveProjectTypeScript(dir))
}

let cliTypeScriptModule: unknown

function loadCliTypeScript(): unknown {
  if (cliTypeScriptModule === undefined) {
    try {
      cliTypeScriptModule = createRequire(import.meta.url)('typescript')
    }
    catch {
      cliTypeScriptModule = null
    }
  }
  return cliTypeScriptModule
}

// Node 20 (CLI minimum) loads `.ts` configs through requireTS + the CLI's own
// runtime TypeScript dependency. Native `import()` of `.ts` is only used as a
// recovery path on Bun and Node.js 22+, where the runtime can load TypeScript.
function supportsNativeTypeScriptImport(): boolean {
  if (process.versions.bun)
    return true
  const major = Number(process.versions.node.split('.')[0])
  return Number.isFinite(major) && major >= 22
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
  // Prefer a project compiler that still has the classic API. TypeScript 7
  // dropped it (`require('typescript')` is only version metadata), so fall
  // back to the CLI's own runtime TypeScript dependency. Never hand a TS7 stub
  // to Capacitor's requireTS — that reads `ModuleKind.CommonJS` unguarded.
  const typescript = isTypeScriptCompiler(projectTypeScript) ? projectTypeScript : loadCliTypeScript()
  let configModule: Record<string, unknown>
  if (isTypeScriptCompiler(typescript)) {
    try {
      configModule = await Promise.resolve(requireTS(typescript, filePath)) as Record<string, unknown>
    }
    catch (requireTsError) {
      if (!supportsNativeTypeScriptImport())
        throw requireTsError
      configModule = await dynamicImport(pathToFileURL(resolve(filePath)).href)
    }
  }
  else if (supportsNativeTypeScriptImport()) {
    configModule = await dynamicImport(pathToFileURL(resolve(filePath)).href)
  }
  else {
    throw new Error('Could not load a usable TypeScript compiler for the Capacitor config')
  }
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
  const configPath = findDefaultCapacitorConfigFile(cwd())
  if (configPath && extname(configPath) === '.ts' && projectTypeScriptLacksClassicApi(cwd())) {
    return {
      config: await loadConfigTarget(configPath),
      path: getConfigWriteTarget() ?? configPath,
    }
  }
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

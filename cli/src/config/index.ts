import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { cwd } from 'node:process'
import type { CapacitorConfig, ExtConfigPairs } from '../schemas/config'
import { formatJSObject, loadConfig as loadConfigCap, requireTS, writeConfig as writeConfigCap } from '../capacitor-cli'

export type { CapacitorConfig, ExtConfigPairs } from '../schemas/config'

let configWriteTarget: string | undefined
const configWriteTargetStore = new AsyncLocalStorage<{ filePath: string | undefined }>()
// `.js` is accepted alongside `.ts`/`.json` — these are the three config names Capacitor's
// own loader recognizes (see `capacitorConfigFiles` in init/command.ts). `.mjs`/`.cjs` are
// intentionally excluded: Capacitor never loads them as configs, and the `.js` writer below
// emits CommonJS, so allowing them would let reads pass but writes silently no-op.
const capacitorConfigFilePattern = /^capacitor\.config(?:\.[^.]+)*\.(?:ts|js|json)$/

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

export function resolveCapacitorConfigTargetPath(value: string | undefined, initialCwd = cwd()): string | undefined {
  if (value === undefined)
    return undefined
  if (!value.trim())
    throw new Error('Capacitor config path must not be empty')

  const resolved = resolve(initialCwd, value)
  if (!existsSync(resolved) || !statSync(resolved).isFile())
    throw new Error(`Capacitor config path does not exist: ${resolved}`)
  if (!capacitorConfigFilePattern.test(basename(resolved)))
    throw new Error(`Capacitor config path must point to a capacitor.config.*.ts, capacitor.config.*.js, or capacitor.config.*.json file: ${resolved}`)

  const workspaceRoot = realpathSync(initialCwd)
  const target = realpathSync(resolved)
  const pathFromWorkspace = relative(workspaceRoot, target)
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace))
    throw new Error(`Capacitor config path must stay within the current working directory: ${resolved}`)
  return target
}

async function loadConfigTarget(filePath: string): Promise<CapacitorConfig> {
  if (extname(filePath) === '.json')
    return JSON.parse(await readFile(filePath, 'utf8')) as CapacitorConfig

  // Mirror Capacitor's own `capacitor.config.js` loader, which simply `require()`s the file.
  const configModule = extname(filePath) === '.js'
    ? (createRequire(filePath)(filePath) as Record<string, unknown>)
    : requireTS(createRequire(filePath)('typescript'), filePath)
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

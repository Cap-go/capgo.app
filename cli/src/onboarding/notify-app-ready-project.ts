import type { CapacitorConfig } from '../config'
import type { NotifyAppReadyCheckOptions } from '../notify-app-ready-background'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { discoverCapacitorProjects, hasCapacitorConfig } from '../build/onboarding/project-discovery'
import { loadConfigTarget } from '../config'
import { getAppId } from '../utils'

export interface NotifyAppReadyProject {
  dir: string
  workspaceRoot: string
  config: CapacitorConfig
  appId: string
  webDir?: string
}

function ancestors(dir: string): string[] {
  const result: string[] = []
  for (let current = resolve(dir); ; current = dirname(current)) {
    result.push(current)
    if (current === dirname(current))
      return result
  }
}

function workspaceRoot(dir: string): string {
  return ancestors(dir).find((candidate) => {
    if (['pnpm-workspace.yaml', 'nx.json', 'lerna.json', 'rush.json'].some(name => existsSync(join(candidate, name))))
      return true
    try {
      return !!JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).workspaces
    }
    catch {
      return false
    }
  }) ?? dir
}

async function readConfig(dir: string): Promise<CapacitorConfig> {
  const file = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json']
    .map(name => join(dir, name))
    .find(existsSync)
  if (!file)
    throw new Error('No Capacitor config')
  return loadConfigTarget(file)
}

function projectDirectory(options: NotifyAppReadyCheckOptions, configDir: string, config: CapacitorConfig): string | undefined {
  if (options.packageJson) {
    const paths = options.packageJson.split(',').map(path => path.trim()).filter(Boolean)
    // Multiple metadata files do not identify a unique source app.
    if (paths.length !== 1)
      return undefined
    const path = realpathSync(resolve(options.cwd, paths[0]))
    JSON.parse(readFileSync(path, 'utf8'))
    return dirname(path)
  }
  if (options.mainFile) {
    const mainFile = realpathSync(resolve(options.cwd, options.mainFile))
    return ancestors(dirname(mainFile)).find(dir => existsSync(join(dir, 'package.json')))
  }
  // A dynamic root config can point at web assets in an app workspace.
  if (typeof config.webDir === 'string') {
    const webDir = resolve(configDir, config.webDir)
    const owner = ancestors(webDir === configDir ? webDir : dirname(webDir))
      .find(dir => existsSync(join(dir, 'package.json')))
    if (owner)
      return owner
  }
  return existsSync(join(configDir, 'package.json')) ? configDir : undefined
}

export async function resolveNotifyAppReadyProject(options: NotifyAppReadyCheckOptions): Promise<NotifyAppReadyProject | undefined> {
  const initialDir = realpathSync(options.cwd)
  const root = workspaceRoot(initialDir)
  const activeDir = ancestors(initialDir).find(hasCapacitorConfig)
  let configDir = activeDir
  let config: CapacitorConfig | undefined

  if (configDir) {
    config = await readConfig(configDir)
  }
  else if (options.capacitorConfig) {
    const path = realpathSync(resolve(initialDir, options.capacitorConfig))
    configDir = dirname(path)
    config = await loadConfigTarget(path)
  }
  else {
    const discovery = await discoverCapacitorProjects(root)
    const selectedSource = options.packageJson || options.mainFile
      ? projectDirectory(options, root, {} as CapacitorConfig)
      : undefined
    const matches: { dir: string, config: CapacitorConfig }[] = []
    for (const candidate of discovery.candidates) {
      if (selectedSource && realpathSync(candidate.dir) !== selectedSource)
        continue
      try {
        const candidateConfig = await readConfig(candidate.dir)
        if (!options.appId || getAppId(undefined, candidateConfig) === options.appId)
          matches.push({ dir: candidate.dir, config: candidateConfig })
      }
      catch {
        // An invalid sibling config must not prevent checking the selected app.
      }
    }
    if (matches.length !== 1)
      return undefined
    configDir = matches[0].dir
    config = matches[0].config
  }

  const appId = getAppId(undefined, config)
  if (typeof appId !== 'string' || !appId.trim() || (options.appId && options.appId !== appId)
    || (config.webDir !== undefined && (typeof config.webDir !== 'string' || !config.webDir.trim()))) {
    return undefined
  }

  if (activeDir && options.capacitorConfig) {
    const target = await loadConfigTarget(realpathSync(resolve(initialDir, options.capacitorConfig)))
    // A write target must not silently select a different app than the root loader.
    if (getAppId(undefined, target) !== appId)
      return undefined
  }

  const dir = projectDirectory(options, configDir, config)
  if (!dir)
    return undefined
  // If source selection points at another Capacitor app, do not report for this one.
  if (dir !== configDir && hasCapacitorConfig(dir) && getAppId(undefined, await readConfig(dir)) !== appId)
    return undefined
  return {
    dir: realpathSync(dir),
    workspaceRoot: workspaceRoot(realpathSync(dir)),
    config,
    appId,
    webDir: resolve(configDir, config.webDir ?? 'www'),
  }
}

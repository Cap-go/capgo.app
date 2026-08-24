import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  BunTool,
  LernaTool,
  NpmTool,
  PnpmTool,
  RushTool,
  YarnTool,
} from '@manypkg/tools'
import type { Tool } from '@manypkg/tools'

const CAPACITOR_CONFIG_FILES = [
  'capacitor.config.ts',
  'capacitor.config.js',
  'capacitor.config.json',
] as const

interface WorkspacePackageJson {
  name?: string
  packageManager?: string
  workspaces?: string[] | { packages?: string[] }
}

export type BuilderProjectDiscoveryReason
  = 'missing-package-json'
    | 'unsupported-workspace'
    | 'invalid-workspace'
    | 'no-capacitor-app'

export interface CapacitorProjectCandidate {
  dir: string
  relativeDir: string
  packageName?: string
  appId?: string
}

export interface BuilderProjectDiscovery {
  searchRoot: string
  candidates: CapacitorProjectCandidate[]
  nxDetected: boolean
  reason?: BuilderProjectDiscoveryReason
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  }
  catch {
    return false
  }
}

export function hasCapacitorConfig(directory: string): boolean {
  return CAPACITOR_CONFIG_FILES.some(file => isFile(join(directory, file)))
}

function findCapacitorConfig(directory: string): string | undefined {
  return CAPACITOR_CONFIG_FILES
    .map(file => join(directory, file))
    .find(isFile)
}

interface StaticStringToken {
  end: number
  value?: string
}

function skipTrivia(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2)
      return index === -1 ? source.length : skipTrivia(source, index + 1)
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      return end === -1 ? source.length : skipTrivia(source, end + 2)
    }
    break
  }
  return index
}

function readStaticString(source: string, start: number): StaticStringToken | undefined {
  const quote = source[start]
  if (quote !== '\'' && quote !== '"')
    return undefined

  let value = ''
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      escaped = true
      index += 1
      continue
    }
    if (character === quote)
      return { end: index + 1, value: escaped ? undefined : value }
    value += character
  }
  return { end: source.length }
}

function readStaticAppId(source: string): string | undefined {
  const values = new Set<string>()
  let index = 0
  while (index < source.length) {
    index = skipTrivia(source, index)
    const stringToken = readStaticString(source, index)
    let key: string | undefined
    let keyEnd = index
    if (stringToken) {
      key = stringToken.value
      keyEnd = stringToken.end
    }
    else if (/[A-Za-z_$]/u.test(source[index] ?? '')) {
      const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/u)?.[0]
      key = identifier
      keyEnd = index + (identifier?.length ?? 1)
    }

    if (key === 'appId') {
      const colon = skipTrivia(source, keyEnd)
      if (source[colon] === ':') {
        const valueStart = skipTrivia(source, colon + 1)
        const valueToken = readStaticString(source, valueStart)
        const value = valueToken?.value?.trim()
        if (value)
          values.add(value)
      }
    }
    index = Math.max(keyEnd, index + 1)
  }
  return values.size === 1 ? [...values][0] : undefined
}

function readCapacitorAppId(directory: string): string | undefined {
  const configPath = findCapacitorConfig(directory)
  if (!configPath)
    return undefined
  try {
    const source = readFileSync(configPath, 'utf8')
    if (configPath.endsWith('.json')) {
      const config = JSON.parse(source) as { appId?: unknown }
      const appId = typeof config.appId === 'string' ? config.appId.trim() : ''
      return appId || undefined
    }
    return readStaticAppId(source)
  }
  catch {
    // Discovery remains best-effort. The selected project's normal config load
    // reports malformed or dynamic configuration errors afterward.
    return undefined
  }
}

async function projectCandidate(
  searchRoot: string,
  directory: string,
  packageName?: string,
): Promise<CapacitorProjectCandidate> {
  return {
    dir: directory,
    relativeDir: displayRelativePath(searchRoot, directory),
    packageName,
    appId: readCapacitorAppId(directory),
  }
}

function selectWorkspaceTool(searchRoot: string, packageJson: WorkspacePackageJson): Tool | undefined {
  if (isFile(join(searchRoot, 'pnpm-workspace.yaml')))
    return PnpmTool
  if (isFile(join(searchRoot, 'rush.json')))
    return RushTool

  const packageManager = packageJson.packageManager?.toLowerCase() ?? ''
  const hasArrayWorkspaces = Array.isArray(packageJson.workspaces)
  const hasObjectWorkspaces = packageJson.workspaces != null
    && !Array.isArray(packageJson.workspaces)
    && Array.isArray(packageJson.workspaces.packages)
  if (hasArrayWorkspaces || hasObjectWorkspaces) {
    if (packageManager.startsWith('bun@') || isFile(join(searchRoot, 'bun.lock')) || isFile(join(searchRoot, 'bun.lockb')))
      return BunTool
    if (packageManager.startsWith('yarn@') || isFile(join(searchRoot, 'yarn.lock')) || hasObjectWorkspaces)
      return YarnTool
    return NpmTool
  }

  // Modern Lerna derives packages from root workspaces when they exist. Lerna's
  // own adapter is still needed for custom `lerna.json` package globs.
  if (isFile(join(searchRoot, 'lerna.json')))
    return LernaTool
  return undefined
}

function isContained(root: string, directory: string): boolean {
  const relativePath = relative(root, directory)
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function displayRelativePath(root: string, directory: string): string {
  const relativePath = relative(root, directory)
  return relativePath ? relativePath.split(sep).join('/') : '.'
}

function resultWithoutCandidates(
  searchRoot: string,
  nxDetected: boolean,
  reason: BuilderProjectDiscoveryReason,
): BuilderProjectDiscovery {
  return { searchRoot, candidates: [], nxDetected, reason }
}

export async function discoverCapacitorProjects(searchRoot: string): Promise<BuilderProjectDiscovery> {
  const resolvedRoot = resolve(searchRoot)
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(resolvedRoot)
  }
  catch {
    return resultWithoutCandidates(resolvedRoot, false, 'invalid-workspace')
  }

  const nxDetected = existsSync(join(canonicalRoot, 'nx.json'))
  if (hasCapacitorConfig(canonicalRoot)) {
    return {
      searchRoot: canonicalRoot,
      candidates: [await projectCandidate(canonicalRoot, canonicalRoot)],
      nxDetected,
    }
  }

  const packageJsonPath = join(canonicalRoot, 'package.json')
  if (!isFile(packageJsonPath))
    return resultWithoutCandidates(canonicalRoot, nxDetected, 'missing-package-json')

  let packageJson: WorkspacePackageJson
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as WorkspacePackageJson
  }
  catch {
    return resultWithoutCandidates(canonicalRoot, nxDetected, 'invalid-workspace')
  }

  const tool = selectWorkspaceTool(canonicalRoot, packageJson)
  if (!tool)
    return resultWithoutCandidates(canonicalRoot, nxDetected, 'unsupported-workspace')

  try {
    const workspace = await tool.getPackages(canonicalRoot)
    const candidatesByDirectory = new Map<string, CapacitorProjectCandidate>()

    for (const pkg of workspace.packages) {
      let canonicalPackageDir: string
      try {
        canonicalPackageDir = realpathSync(pkg.dir)
      }
      catch {
        continue
      }
      if (!isContained(canonicalRoot, canonicalPackageDir) || !hasCapacitorConfig(canonicalPackageDir))
        continue

      const packageName = typeof pkg.packageJson.name === 'string' ? pkg.packageJson.name : undefined
      candidatesByDirectory.set(
        canonicalPackageDir,
        await projectCandidate(canonicalRoot, canonicalPackageDir, packageName),
      )
    }

    const candidates = [...candidatesByDirectory.values()]
      .sort((a, b) => a.relativeDir.localeCompare(b.relativeDir))

    if (candidates.length === 0)
      return resultWithoutCandidates(canonicalRoot, nxDetected, 'no-capacitor-app')
    return { searchRoot: canonicalRoot, candidates, nxDetected }
  }
  catch {
    return resultWithoutCandidates(canonicalRoot, nxDetected, 'invalid-workspace')
  }
}

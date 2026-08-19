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
      candidates: [{ dir: canonicalRoot, relativeDir: '.' }],
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
      candidatesByDirectory.set(canonicalPackageDir, {
        dir: canonicalPackageDir,
        relativeDir: displayRelativePath(canonicalRoot, canonicalPackageDir),
        packageName,
      })
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

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { hasCapacitorConfig } from '../build/onboarding/project-discovery'

/**
 * The MCP server resolves the user's project from `process.cwd()` (capacitor config,
 * package.json, native folders, ./.capgo key...). A user-scoped MCP install is spawned
 * by the client from wherever the client lives (often `~` or `/`), not from the folder
 * the agent is working in. These helpers move the server into the agent's project:
 * automatically from the client's MCP `roots`, or explicitly via capgo_set_project_dir.
 */

export interface McpRoot {
  uri: string
  name?: string
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Convert MCP roots to existing local directories. Non-`file://` roots are ignored. */
export function rootsToDirectories(roots: McpRoot[]): string[] {
  const dirs: string[] = []
  for (const root of roots) {
    if (!root.uri.startsWith('file://'))
      continue
    let dir: string
    try {
      dir = resolve(fileURLToPath(root.uri))
    }
    catch {
      continue
    }
    if (isDirectory(dir) && !dirs.includes(dir))
      dirs.push(dir)
  }
  return dirs
}

/**
 * Pick the project directory from the client's roots. Keeps `currentDir` when it is
 * already a Capacitor project inside one of the roots (e.g. a project-scoped install
 * launched from a sub-app of a monorepo); otherwise prefers the first root holding a
 * Capacitor config, then the first root. Returns undefined when no usable root exists.
 */
export function pickProjectDirFromRoots(roots: McpRoot[], currentDir = process.cwd()): string | undefined {
  const dirs = rootsToDirectories(roots)
  if (dirs.length === 0)
    return undefined
  const current = resolve(currentDir)
  if (hasCapacitorConfig(current) && dirs.some(dir => isInside(current, dir)))
    return current
  return dirs.find(dir => hasCapacitorConfig(dir)) ?? dirs[0]
}

/** Resolve a user/agent-supplied project path (absolute, `~`, or relative to the current dir). */
export function resolveProjectDirInput(input: string, currentDir = process.cwd()): string {
  const trimmed = input.trim()
  if (!trimmed)
    throw new Error('Project directory is empty.')
  const home = process.env.HOME || process.env.USERPROFILE
  const expanded = trimmed.startsWith('file://')
    ? fileURLToPath(trimmed)
    : (home && (trimmed === '~' || trimmed.startsWith('~/')) ? `${home}${trimmed.slice(1)}` : trimmed)
  const dir = resolve(currentDir, expanded)
  if (!existsSync(dir))
    throw new Error(`Project directory does not exist: ${dir}`)
  if (!isDirectory(dir))
    throw new Error(`Project directory is not a directory: ${dir}`)
  return dir
}

/** Switch the server's working directory. Returns true when it actually changed. */
export function switchProjectDir(dir: string): boolean {
  const target = resolve(dir)
  if (target === process.cwd())
    return false
  process.chdir(target)
  return true
}

export function describeProjectDir(dir = process.cwd()): string {
  return hasCapacitorConfig(dir)
    ? `Capgo MCP project directory: ${dir} (Capacitor config found).`
    : `Capgo MCP project directory: ${dir} (no capacitor.config.* found here; call capgo_set_project_dir with the app's root folder if this is wrong).`
}

/**
 * Memoize a factory per working directory, so long-lived tool dependencies built from
 * `process.cwd()` follow capgo_set_project_dir / MCP roots instead of the spawn dir.
 */
export function memoizeByCwd<T>(factory: () => T): () => T {
  let cachedCwd: string | undefined
  let cached: T
  return () => {
    const cwd = process.cwd()
    if (cachedCwd !== cwd) {
      cached = factory()
      cachedCwd = cwd
    }
    return cached
  }
}

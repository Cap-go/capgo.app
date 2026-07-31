import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export interface SupabaseWorktreePorts {
  api: number
  db: number
  dbShadow: number
  dbPooler: number
  studio: number
  inbucket: number
  analytics: number
  edgeInspector: number
}

export interface SupabaseWorktreeConfig {
  repoRoot: string
  worktreeHash: string
  projectId: string
  ports: SupabaseWorktreePorts
}

/**
 * Best-effort repo root lookup for the current worktree.
 *
 * Falls back to `cwd` when git is unavailable.
 */
function getGitRepoRoot(cwd: string): string {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  })
  if (res.status === 0) {
    const out = (res.stdout || '').trim()
    if (out)
      return out
  }
  return cwd
}

/**
 * Resolve a deliberate CI port band when jobs share a runner.
 *
 * The default remains path-derived for local worktrees; CI supplies a reserved,
 * ten-port-aligned band so its jobs never depend on the runner's default ports.
 */
function getConfiguredPortOffset(): number | undefined {
  const raw = process.env.SUPABASE_WORKTREE_PORT_OFFSET
  if (!raw)
    return undefined

  if (!/^\d+$/.test(raw))
    throw new Error('SUPABASE_WORKTREE_PORT_OFFSET must be a non-negative integer.')

  const offset = Number(raw)
  if (!Number.isSafeInteger(offset) || offset % 10 !== 0 || offset > 11000)
    throw new Error('SUPABASE_WORKTREE_PORT_OFFSET must be a multiple of 10 no greater than 11000.')

  return offset
}

/**
 * Returns a deterministic per-worktree Supabase configuration (unique project_id and ports)
 * derived from the git worktree path and, when supplied, a CI job instance.
 *
 * This allows running multiple `supabase start` instances in parallel across worktrees
 * without Docker container/volume name collisions or port conflicts.
 */
export function getSupabaseWorktreeConfig(cwd: string = process.cwd()): SupabaseWorktreeConfig {
  const repoRootRaw = getGitRepoRoot(cwd)
  const repoRoot = realpathSync(resolve(repoRootRaw))
  const configuredOffset = getConfiguredPortOffset()
  const instance = process.env.SUPABASE_WORKTREE_INSTANCE?.trim()
  const identity = [repoRoot, instance, configuredOffset === undefined ? undefined : `ports:${configuredOffset}`]
    .filter((value): value is string => Boolean(value))
    .join('\0')

  // Hashing the worktree plus job identity gives isolated Docker resources and generated config.
  const worktreeHash = createHash('sha256').update(identity).digest('hex').slice(0, 8)
  const offset = configuredOffset ?? (Number.parseInt(worktreeHash.slice(0, 6), 16) % 1000) * 10

  const base = {
    api: 54321,
    db: 54322,
    dbShadow: 54320,
    dbPooler: 54329,
    studio: 54323,
    inbucket: 54324,
    analytics: 54327,
    edgeInspector: 8083,
  } satisfies SupabaseWorktreePorts

  return {
    repoRoot,
    worktreeHash,
    projectId: `capgo-app-${worktreeHash}`,
    ports: {
      api: base.api + offset,
      db: base.db + offset,
      dbShadow: base.dbShadow + offset,
      dbPooler: base.dbPooler + offset,
      studio: base.studio + offset,
      inbucket: base.inbucket + offset,
      analytics: base.analytics + offset,
      edgeInspector: base.edgeInspector + (offset / 10),
    },
  }
}

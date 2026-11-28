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

const DEFAULT_API_PORT = 54321

/**
 * The API port of offset 0. CI moves it below Linux's ephemeral port range (32768-60999):
 * an outbound socket the runner opened before the job (its own agent keeps one) can hold a
 * port in that range, and reserving the port afterwards does not evict it, so `docker` failed
 * with "address already in use" on every retry.
 */
function getConfiguredBasePort(): number {
  const raw = process.env.SUPABASE_WORKTREE_PORT_BASE
  if (!raw)
    return DEFAULT_API_PORT
  const port = Number(raw)
  // Leaves room for the largest offset (11000) and the highest derived port (api + 8).
  if (!/^\d+$/.test(raw) || port < 1024 || port + 11_008 > 65_535)
    throw new Error('SUPABASE_WORKTREE_PORT_BASE must be an integer from 1024 to 54527.')
  return port
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

  const shift = getConfiguredBasePort() - DEFAULT_API_PORT
  const base = {
    api: 54321 + shift,
    db: 54322 + shift,
    dbShadow: 54320 + shift,
    dbPooler: 54329 + shift,
    studio: 54323 + shift,
    inbucket: 54324 + shift,
    analytics: 54327 + shift,
    edgeInspector: 8083,
  } satisfies SupabaseWorktreePorts

  const ports: SupabaseWorktreePorts = {
    api: base.api + offset,
    db: base.db + offset,
    dbShadow: base.dbShadow + offset,
    dbPooler: base.dbPooler + offset,
    studio: base.studio + offset,
    inbucket: base.inbucket + offset,
    analytics: base.analytics + offset,
    edgeInspector: base.edgeInspector + (offset / 10),
  }
  // A base near the inspector band (8083 + offset / 10) could give two services one host port.
  const seen = new Map<number, string>()
  for (const [name, port] of Object.entries(ports)) {
    if (seen.has(port))
      throw new Error(`Supabase worktree ports collide: ${seen.get(port)} and ${name} both use ${port}. Change SUPABASE_WORKTREE_PORT_BASE or SUPABASE_WORKTREE_PORT_OFFSET.`)
    seen.set(port, name)
  }
  return { repoRoot, worktreeHash, projectId: `capgo-app-${worktreeHash}`, ports }
}

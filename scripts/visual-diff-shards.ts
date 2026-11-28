export function parseShard(raw: string): { index: number, total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(raw)
  const index = match ? Number(match[1]) : Number.NaN
  const total = match ? Number(match[2]) : Number.NaN
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total)
    throw new Error(`--shard must look like 2/4, received "${raw}"`)
  return { index, total }
}

/**
 * Contiguous slice of the configured order. Some routes persist UI state (onboarding progress)
 * that later routes see, so both phases must capture each slice in the same order on a fresh
 * stack; a contiguous split keeps every route's predecessors identical across phases.
 */
export function shardRoutes<T>(routes: T[], shard: { index: number, total: number } | undefined): T[] {
  if (!shard)
    return routes
  const start = Math.floor(routes.length * (shard.index - 1) / shard.total)
  const end = Math.floor(routes.length * shard.index / shard.total)
  return routes.slice(start, end)
}

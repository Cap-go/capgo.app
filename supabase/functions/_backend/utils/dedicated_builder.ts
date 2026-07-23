import type { Context } from 'hono'
import type { Database } from './supabase.types.ts'
import { cloudlogErr } from './logging.ts'
import { supabaseAdmin } from './supabase.ts'

export type DedicatedBuilderStatus = 'requested' | 'provisioning' | 'active' | 'suspended' | 'cancelled'
export type DedicatedWorkerStatus = 'unknown' | 'idle' | 'busy' | 'offline'
export type BuilderPool = 'dedicated' | 'shared'

export type DedicatedBuilderRow = Database['public']['Tables']['dedicated_builders']['Row']

export interface DedicatedPoolRouting {
  preferDedicated: boolean
  allowSharedFallback: boolean
  poolId: string | null
  workerName: string | null
}

/** Statuses that mean a dedicated worker is currently occupied. */
const ACTIVE_DEDICATED_BUILD_STATUSES = ['starting', 'running'] as const

export function isDedicatedBuilderActive(row: Pick<DedicatedBuilderRow, 'status'> | null | undefined): boolean {
  return row?.status === 'active'
}

export async function getDedicatedBuilderForOrg(
  c: Context,
  orgId: string,
): Promise<DedicatedBuilderRow | null> {
  const { data, error } = await supabaseAdmin(c)
    .from('dedicated_builders')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to load dedicated builder',
      org_id: orgId,
      error: error.message,
    })
    throw error
  }

  return data
}

export function toDedicatedPoolRouting(row: DedicatedBuilderRow | null): DedicatedPoolRouting | null {
  if (!isDedicatedBuilderActive(row) || !row)
    return null

  return {
    preferDedicated: true,
    allowSharedFallback: row.allow_shared_fallback,
    poolId: row.pool_id,
    workerName: row.worker_name,
  }
}

export async function countActiveDedicatedBuilds(
  c: Context,
  orgId: string,
): Promise<number> {
  const { count, error } = await supabaseAdmin(c)
    .from('build_requests')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)
    .eq('builder_pool', 'dedicated')
    .in('status', [...ACTIVE_DEDICATED_BUILD_STATUSES])

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to count active dedicated builds',
      org_id: orgId,
      error: error.message,
    })
    // Do not invent idle/zero — callers must surface the failure.
    throw error
  }

  return count ?? 0
}

/**
 * Derive a customer-facing worker status from stored state + active dedicated jobs.
 *
 * `builder_pool` on build_requests is the preferred pool at request time. When
 * shared fallback is enabled, a preferred-dedicated job may still run on shared,
 * so busy must not be inferred from that count alone — trust explicit worker
 * heartbeats (`worker_status`) instead. When fallback is disabled, preferred
 * dedicated jobs must use the dedicated worker, so the count is reliable.
 */
export function deriveWorkerStatus(
  row: DedicatedBuilderRow,
  activeDedicatedBuilds: number,
): DedicatedWorkerStatus {
  if (row.status !== 'active')
    return 'unknown'
  if (row.worker_status === 'offline')
    return 'offline'
  if (row.allow_shared_fallback) {
    if (row.worker_status === 'busy' || row.worker_status === 'idle')
      return row.worker_status
    return 'unknown'
  }
  if (activeDedicatedBuilds > 0)
    return 'busy'
  return 'idle'
}

export function publicDedicatedBuilderView(
  row: DedicatedBuilderRow,
  activeDedicatedBuilds: number,
) {
  const workerStatus = deriveWorkerStatus(row, activeDedicatedBuilds)
  return {
    id: row.id,
    org_id: row.org_id,
    status: row.status as DedicatedBuilderStatus,
    requested_by: row.requested_by,
    use_case: row.use_case,
    monthly_builds_estimate: row.monthly_builds_estimate,
    platforms: row.platforms ?? [],
    allow_shared_fallback: row.allow_shared_fallback,
    pool_id: row.pool_id,
    worker_name: row.worker_name,
    worker_status: workerStatus,
    worker_current_job_id: workerStatus === 'busy' ? row.worker_current_job_id : null,
    worker_last_seen_at: row.worker_last_seen_at,
    activated_at: row.activated_at,
    suspended_at: row.suspended_at,
    cancelled_at: row.cancelled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    active_dedicated_builds: activeDedicatedBuilds,
  }
}

import type { Context } from 'hono'
import {
  nativeBuildQueueTierFromPriority,
  type NativeBuildQueueTier,
} from '../../utils/native_build_queue_priority.ts'

interface PgClient {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<{
    rowCount?: number | null
    rows: T[]
  }>
}

export interface OrgNativeBuildQueuePriority {
  planName: string
  priority: number
  tier: NativeBuildQueueTier
}

export async function readOrgNativeBuildQueuePriority(
  client: PgClient,
  orgId: string,
): Promise<OrgNativeBuildQueuePriority> {
  const result = await client.query<{
    plan_name: string | null
    native_build_queue_priority: number | string | null
  }>(
    `
      SELECT
        COALESCE(current_plan.name, solo_plan.name) AS plan_name,
        COALESCE(current_plan.native_build_queue_priority, solo_plan.native_build_queue_priority) AS native_build_queue_priority
      FROM public.orgs o
      LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
      LEFT JOIN public.plans current_plan ON si.product_id = current_plan.stripe_id
      LEFT JOIN public.plans solo_plan ON solo_plan.name = 'Solo'
      WHERE o.id = $1
      LIMIT 1
    `,
    [orgId],
  )

  const planName = result.rows[0]?.plan_name ?? 'Solo'
  const priority = Number(result.rows[0]?.native_build_queue_priority)

  if (!Number.isInteger(priority) || priority <= 0) {
    throw new Error('Native build queue priority is not configured for plan')
  }

  return {
    planName,
    priority,
    tier: nativeBuildQueueTierFromPriority(priority),
  }
}

export async function resolveOrgNativeBuildQueuePriority(c: Context, orgId: string): Promise<OrgNativeBuildQueuePriority> {
  const { getPgClient, closeClient } = await import('../../utils/pg.ts')
  const client = await getPgClient(c)
  try {
    return await readOrgNativeBuildQueuePriority(client, orgId)
  }
  finally {
    closeClient(c, client)
  }
}

import type { ReadReplicaSchemaSyncPlan } from './schema_additive_sync.ts'

export type ReadReplicaSchemaSyncMode = 'refresh-subscription' | 'guard' | 'dry-run' | 'apply'

export const DROP_INDEX_GUARD_SKIP_REASON = 'drop_index_requires_allow_drop' as const

export function resolveReadReplicaSchemaSyncMode(
  argv: readonly string[],
  _env: { GITHUB_ACTIONS?: string },
): ReadReplicaSchemaSyncMode {
  if (argv.includes('--refresh-subscription'))
    return 'refresh-subscription'
  if (argv.includes('--guard'))
    return 'guard'
  // sync-schema:apply passes both flags; dry-run must never mutate the subscriber.
  if (argv.includes('--dry-run'))
    return 'dry-run'
  if (argv.includes('--apply'))
    return 'apply'
  return 'dry-run'
}

export function filterReadReplicaSchemaPlanForApply(
  plan: ReadReplicaSchemaSyncPlan,
  allowDrop: boolean,
): ReadReplicaSchemaSyncPlan {
  if (allowDrop)
    return plan

  const statements = plan.statements.filter(statement => statement.kind !== 'drop_index')
  const dropped = plan.statements.filter(statement => statement.kind === 'drop_index')
  if (!dropped.length)
    return { ...plan, statements }

  return {
    statements,
    skipped: [
      ...plan.skipped,
      ...dropped.map(statement => ({
        kind: 'index' as const,
        table: statement.table,
        name: statement.name,
        reason: DROP_INDEX_GUARD_SKIP_REASON,
      })),
    ],
  }
}

export function partitionGuardSkipped(
  skipped: ReadReplicaSchemaSyncPlan['skipped'],
): {
  blocking: ReadReplicaSchemaSyncPlan['skipped']
  warned: ReadReplicaSchemaSyncPlan['skipped']
} {
  const blocking: ReadReplicaSchemaSyncPlan['skipped'] = []
  const warned: ReadReplicaSchemaSyncPlan['skipped'] = []
  for (const item of skipped) {
    if (item.reason === DROP_INDEX_GUARD_SKIP_REASON)
      warned.push(item)
    else
      blocking.push(item)
  }
  return { blocking, warned }
}
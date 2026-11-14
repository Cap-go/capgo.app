import type { ReadReplicaSchemaSyncPlan } from './schema_additive_sync.ts'

export type ReadReplicaSchemaSyncMode = 'refresh-subscription' | 'guard' | 'dry-run' | 'apply'

export function resolveReadReplicaSchemaSyncMode(
  argv: readonly string[],
  env: { GITHUB_ACTIONS?: string },
): ReadReplicaSchemaSyncMode {
  if (argv.includes('--refresh-subscription'))
    return 'refresh-subscription'
  if (argv.includes('--guard'))
    return 'guard'
  if (argv.includes('--apply'))
    return 'apply'
  if (env.GITHUB_ACTIONS === 'true' && !argv.includes('--dry-run'))
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
        reason: 'drop_index_requires_allow_drop',
      })),
    ],
  }
}
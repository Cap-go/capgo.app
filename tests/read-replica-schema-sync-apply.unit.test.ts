import { describe, expect, it } from 'vitest'
import type { ReadReplicaSchemaSyncPlan } from '../read_replicate/schema_additive_sync.ts'
import {
  DROP_INDEX_GUARD_SKIP_REASON,
  filterReadReplicaSchemaPlanForApply,
  partitionGuardSkipped,
  resolveReadReplicaSchemaSyncMode,
} from '../read_replicate/schema_sync_apply.ts'

describe('read-replica schema sync apply policy', () => {
  it.concurrent('defaults local and CI runs to dry-run without --apply', () => {
    expect(resolveReadReplicaSchemaSyncMode([], {})).toBe('dry-run')
    expect(resolveReadReplicaSchemaSyncMode([], { GITHUB_ACTIONS: 'true' })).toBe('dry-run')
    expect(resolveReadReplicaSchemaSyncMode(['--dry-run'], { GITHUB_ACTIONS: 'true' })).toBe('dry-run')
  })

  it.concurrent('requires explicit --apply', () => {
    expect(resolveReadReplicaSchemaSyncMode(['--apply'], {})).toBe('apply')
    expect(resolveReadReplicaSchemaSyncMode(['--apply'], { GITHUB_ACTIONS: 'true' })).toBe('apply')
  })

  it.concurrent('blocks drop_index statements unless --allow-drop', () => {
    const plan: ReadReplicaSchemaSyncPlan = {
      statements: [
        {
          kind: 'column',
          table: 'apps',
          name: 'x',
          sql: 'ALTER TABLE public."apps" ADD COLUMN IF NOT EXISTS "x" boolean',
        },
        {
          kind: 'drop_index',
          table: 'apps',
          name: 'extra_idx',
          sql: 'DROP INDEX CONCURRENTLY IF EXISTS public."extra_idx"',
        },
      ],
      skipped: [],
    }

    const filtered = filterReadReplicaSchemaPlanForApply(plan, false)
    expect(filtered.statements.map(statement => statement.kind)).toEqual(['column'])
    expect(filtered.skipped).toEqual([
      {
        kind: 'index',
        table: 'apps',
        name: 'extra_idx',
        reason: DROP_INDEX_GUARD_SKIP_REASON,
      },
    ])
  })

  it.concurrent('lets the post-migration guard warn on blocked index drops only', () => {
    const skipped: ReadReplicaSchemaSyncPlan['skipped'] = [
      {
        kind: 'index',
        table: 'apps',
        name: 'extra_idx',
        reason: DROP_INDEX_GUARD_SKIP_REASON,
      },
      {
        kind: 'column',
        table: 'apps',
        name: 'legacy_col',
        reason: 'unsupported_column_drift',
      },
    ]
    const { blocking, warned } = partitionGuardSkipped(skipped)
    expect(warned).toHaveLength(1)
    expect(blocking).toHaveLength(1)
    expect(blocking[0]?.reason).toBe('unsupported_column_drift')
  })
})
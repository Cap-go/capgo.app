import { describe, expect, it } from 'vitest'
import type { ReadReplicaSchemaSyncPlan } from '../read_replicate/schema_additive_sync.ts'
import {
  filterReadReplicaSchemaPlanForApply,
  resolveReadReplicaSchemaSyncMode,
} from '../read_replicate/schema_sync_apply.ts'

describe('read-replica schema sync apply policy', () => {
  it.concurrent('defaults local runs to dry-run', () => {
    expect(resolveReadReplicaSchemaSyncMode([], {})).toBe('dry-run')
    expect(resolveReadReplicaSchemaSyncMode(['--dry-run'], { GITHUB_ACTIONS: 'true' })).toBe('dry-run')
  })

  it.concurrent('requires explicit --apply outside CI', () => {
    expect(resolveReadReplicaSchemaSyncMode(['--apply'], {})).toBe('apply')
    expect(resolveReadReplicaSchemaSyncMode([], { GITHUB_ACTIONS: 'true' })).toBe('apply')
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
        reason: 'drop_index_requires_allow_drop',
      },
    ])
  })
})
import { describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import {
  buildUnsizedDeltaApplyCheckpointPath,
  INITIAL_UNSIZED_DELTA_REQUEUE_CURSOR,
  parseUnsizedDeltaRequeueArgs,
  requeueUnsizedDeltaBatch,
} from '../scripts/requeue_unsized_delta_files.ts'

describe('requeue_unsized_delta_files', () => {
  it.concurrent('rejects an empty --created-after value', () => {
    expect(() => parseUnsizedDeltaRequeueArgs(['bun', 'script', '--created-after='])).toThrow('--created-after must not be empty')
  })

  it.concurrent('uses different apply checkpoints per created-after filter', () => {
    const dbHash = 'a'.repeat(64)
    expect(buildUnsizedDeltaApplyCheckpointPath(dbHash)).not.toBe(
      buildUnsizedDeltaApplyCheckpointPath(dbHash, '2026-11-12T14:18:42Z'),
    )
  })

  it.concurrent('does not mark scan completion when --limit stops the invocation', async () => {
    const client = {
      query: async () => ({ rows: Array.from({ length: 200 }, (_, index) => ({ id: String(index + 1) })) }),
    } as unknown as Pick<Client, 'query'>
    const progress = await requeueUnsizedDeltaBatch(client, INITIAL_UNSIZED_DELTA_REQUEUE_CURSOR, {
      apply: false,
      batchSize: 200,
      limit: 200,
    })
    expect(progress.cursor.done).toBe(false)
    expect(progress.limit).toBe(0)
    expect(progress.cursor.lastId).toBe('200')
  })
})

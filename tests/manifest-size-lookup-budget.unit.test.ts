import type { Context } from 'hono'
import type { StorageSizeDiagnostics } from '../supabase/functions/_backend/utils/s3.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onManifestCreateTestUtils } from '../supabase/functions/_backend/triggers/on_manifest_create.ts'
import { __queueConsumerTestUtils__ } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import * as manifestSizeBudget from '../supabase/functions/_backend/utils/manifest_size_lookup_budget.ts'
import { s3 } from '../supabase/functions/_backend/utils/s3.ts'

const HOMOGENEOUS_BATCH_PATH = 'orgs/org-id/apps/com.test.app/delta/hash_file.js'

function mockManifestQueueContext(perMessageBudget: number): Context {
  const values = new Map<string, unknown>([
    ['manifestSizeLookupSubrequestBudgetPerMessage', perMessageBudget],
    ['requestId', 'test-request'],
  ])
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  } as unknown as Context
}

function transientDiagnosticsForCandidateCount(candidateCount: number): StorageSizeDiagnostics {
  const keys = Array.from({ length: candidateCount }, (_, i) => `${HOMOGENEOUS_BATCH_PATH}#${i}`)
  return {
    bucket: 'capgo',
    candidateKeys: keys,
    candidates: keys.map(fileId => ({
      fileId,
      finalSize: 0,
      head: { rawSize: 0, size: 0, success: true },
      range: { reason: 'missing_head_size', size: 0, status: 200, statusText: 'OK' },
      usedFallback: true,
    })),
    endpoint: 'https://example.invalid/',
    fileId: keys[0] ?? HOMOGENEOUS_BATCH_PATH,
    selectedCandidateKey: null,
    size: 0,
  }
}

describe('manifest size lookup subrequest budget', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.concurrent('keeps queue consumer constants aligned with the budget module', () => {
    expect(__queueConsumerTestUtils__.defaultBatchSize).toBe(manifestSizeBudget.MANIFEST_QUEUE_DEFAULT_BATCH_SIZE)
    expect(__queueConsumerTestUtils__.manifestQueueHttpConcurrency)
      .toBe(manifestSizeBudget.MANIFEST_QUEUE_HTTP_CONCURRENCY_SUBREQUESTS)
    expect(__queueConsumerTestUtils__.getQueueBatchSize('on_manifest_create', 950)).toBe(950)
    expect(() => manifestSizeBudget.assertDefaultManifestBatchFitsR2Budget(onManifestCreateTestUtils.sizeRetryAttempts))
      .not.toThrow()
    expect(manifestSizeBudget.MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET).toBe(9_750)
  })

  it('bounds homogeneous R2 usage for every batch size and candidate count', async () => {
    vi.useFakeTimers()
    const lookup = vi.spyOn(s3, 'getSizeDiagnostics').mockImplementation(async (_c, _s3Path) => {
      return transientDiagnosticsForCandidateCount(currentCandidateCount)
    })
    let currentCandidateCount = 1
    const countSpy = vi.spyOn(manifestSizeBudget, 'manifestStorageCandidateCount').mockImplementation(() => currentCandidateCount)

    try {
      for (let batchSize = 1; batchSize <= 950; batchSize++) {
        const perMessage = manifestSizeBudget.perMessageManifestSizeLookupBudget(batchSize)
        for (let candidateCount = 1; candidateCount <= 5; candidateCount++) {
          currentCandidateCount = candidateCount
          const context = mockManifestQueueContext(perMessage)
          const pending = onManifestCreateTestUtils.getManifestSizeWithRetry(context, HOMOGENEOUS_BATCH_PATH, 0)
          await vi.runAllTimersAsync()
          const { spentSubrequests } = await pending
          const invocationR2 = batchSize * spentSubrequests
          expect(invocationR2 + manifestSizeBudget.MANIFEST_QUEUE_INVOCATION_SUBREQUEST_RESERVE)
            .toBeLessThanOrEqual(manifestSizeBudget.CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET)
        }
      }
    }
    finally {
      countSpy.mockRestore()
      lookup.mockRestore()
      vi.useRealTimers()
    }
  })
})

import type { Context } from 'hono'
import type { StorageSizeDiagnostics } from '../supabase/functions/_backend/utils/s3.ts'
import { describe, expect, it, vi } from 'vitest'
import { onManifestCreateTestUtils } from '../supabase/functions/_backend/triggers/on_manifest_create.ts'
import { getManifestStorageCandidateKeys } from '../supabase/functions/_backend/utils/manifest_encoding.ts'
import {
  assertDefaultManifestBatchFitsR2Budget,
  CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET,
  MANIFEST_QUEUE_INVOCATION_SUBREQUEST_RESERVE,
  MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET,
  MANIFEST_SIZE_MAX_CANDIDATE_KEYS,
  perMessageManifestSizeLookupBudget,
} from '../supabase/functions/_backend/utils/manifest_size_lookup_budget.ts'
import { s3 } from '../supabase/functions/_backend/utils/s3.ts'

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

function transientDiagnosticsForPath(s3Path: string): StorageSizeDiagnostics {
  const keys = getManifestStorageCandidateKeys(s3Path)
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
    fileId: keys[0] ?? s3Path,
    selectedCandidateKey: null,
    size: 0,
  }
}

function manifestTestPath(candidateCount: number): string {
  return `capgo-manifest-size-test/k/${candidateCount}/file`
}

describe('manifest size lookup subrequest budget', () => {
  it('keeps the default 950 batch and 5 paths inside the R2 budget', () => {
    expect(() => assertDefaultManifestBatchFitsR2Budget(onManifestCreateTestUtils.sizeRetryAttempts)).not.toThrow()
    const perMessage = perMessageManifestSizeLookupBudget(950)
    const attempts = Math.min(
      onManifestCreateTestUtils.sizeRetryAttempts,
      Math.floor(perMessage / (MANIFEST_SIZE_MAX_CANDIDATE_KEYS * 2)),
    )
    const worstR2 = 950 * attempts * MANIFEST_SIZE_MAX_CANDIDATE_KEYS * 2
    expect(worstR2).toBeLessThanOrEqual(MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET)
  })

  it('bounds homogeneous R2 usage for every batch size and candidate count', async () => {
    vi.useFakeTimers()
    const lookup = vi.spyOn(s3, 'getSizeDiagnostics').mockImplementation(async (_c, s3Path) => {
      return transientDiagnosticsForPath(s3Path)
    })

    try {
      for (let batchSize = 1; batchSize <= 950; batchSize++) {
        const perMessage = perMessageManifestSizeLookupBudget(batchSize)
        for (let candidateCount = 1; candidateCount <= 5; candidateCount++) {
          const path = manifestTestPath(candidateCount)
          expect(getManifestStorageCandidateKeys(path)).toHaveLength(candidateCount)
          const context = mockManifestQueueContext(perMessage)
          const pending = onManifestCreateTestUtils.getManifestSizeWithRetry(context, path, 0)
          await vi.runAllTimersAsync()
          const { spentSubrequests } = await pending
          const invocationR2 = batchSize * spentSubrequests
          expect(invocationR2 + MANIFEST_QUEUE_INVOCATION_SUBREQUEST_RESERVE)
            .toBeLessThanOrEqual(CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET)
        }
      }
    }
    finally {
      lookup.mockRestore()
      vi.useRealTimers()
    }
  })
})

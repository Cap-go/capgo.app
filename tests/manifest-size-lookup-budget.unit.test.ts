import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET,
  computeManifestQueueWorstCaseSubrequests,
  MANIFEST_SIZE_MAX_CANDIDATE_KEYS,
  maxManifestSizeLookupAttemptsForBudget,
  perMessageManifestSizeLookupBudget,
  worstCaseSubrequestsPerSizeLookupAttempt,
} from '../supabase/functions/_backend/utils/manifest_size_lookup_budget.ts'
import { onManifestCreateTestUtils } from '../supabase/functions/_backend/triggers/on_manifest_create.ts'

describe('manifest size lookup subrequest budget', () => {
  it.concurrent('caps attempts per message from the queue batch size', () => {
    const batchSize = 950
    const perMessage = perMessageManifestSizeLookupBudget(batchSize)
    expect(perMessage).toBe(Math.floor(CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET / batchSize))
    expect(maxManifestSizeLookupAttemptsForBudget(perMessage, 'apps/a/manifest/x.js', onManifestCreateTestUtils.sizeRetryAttempts))
      .toBeLessThanOrEqual(onManifestCreateTestUtils.sizeRetryAttempts)
    expect(worstCaseSubrequestsPerSizeLookupAttempt('apps/a/manifest/%2Eenv')).toBeGreaterThan(0)
  })

  it.concurrent('bounds worst-case queue invocation subrequests', () => {
    const batchSize = 950
    expect(computeManifestQueueWorstCaseSubrequests(batchSize, onManifestCreateTestUtils.sizeRetryAttempts, 1))
      .toBeLessThanOrEqual(CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET)
    expect(computeManifestQueueWorstCaseSubrequests(batchSize, onManifestCreateTestUtils.sizeRetryAttempts, MANIFEST_SIZE_MAX_CANDIDATE_KEYS))
      .toBeLessThanOrEqual(CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET)
  })
})

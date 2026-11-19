import type { StorageSizeDiagnostics } from './s3.ts'
import { getManifestStorageCandidateKeys } from './manifest_encoding.ts'

export function estimateManifestSizeLookupSubrequests(diagnostics: StorageSizeDiagnostics): number {
  return diagnostics.candidates.reduce((sum, candidate) => sum + 1 + (candidate.usedFallback ? 1 : 0), 0)
}

// Paid Workers default subrequest limit unless overridden in wrangler.
export const CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET = 10_000
export const MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE = 2
export const MANIFEST_SIZE_MAX_CANDIDATE_KEYS = 5
// Keep in sync with queue_consumer DEFAULT_BATCH_SIZE (950).
export const MANIFEST_QUEUE_DEFAULT_BATCH_SIZE = 950
// Sized to queue_consumer MANIFEST_QUEUE_HTTP_CONCURRENCY (100) plus one pgmq read,
// archive, delete, persistQueueCfIds, and related Hyperdrive traffic per invocation.
export const MANIFEST_QUEUE_HTTP_CONCURRENCY_SUBREQUESTS = 100
export const MANIFEST_QUEUE_PLATFORM_SUBREQUEST_RESERVE = 150
export const MANIFEST_QUEUE_INVOCATION_SUBREQUEST_RESERVE =
  MANIFEST_QUEUE_PLATFORM_SUBREQUEST_RESERVE + MANIFEST_QUEUE_HTTP_CONCURRENCY_SUBREQUESTS
export const MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET =
  CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET - MANIFEST_QUEUE_INVOCATION_SUBREQUEST_RESERVE

export function manifestStorageCandidateCount(s3Path: string): number {
  return Math.min(MANIFEST_SIZE_MAX_CANDIDATE_KEYS, getManifestStorageCandidateKeys(s3Path).length)
}

export function worstCaseSubrequestsPerSizeLookupAttempt(s3Path: string): number {
  return manifestStorageCandidateCount(s3Path) * MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE
}

export function worstCaseSubrequestsPerAttemptForCandidateCount(candidateCount: number): number {
  const bounded = Math.min(MANIFEST_SIZE_MAX_CANDIDATE_KEYS, candidateCount)
  return bounded * MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE
}

export function perMessageManifestSizeLookupBudget(
  batchSize: number,
  totalR2Budget = MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET,
): number {
  if (batchSize <= 0)
    return 0
  return Math.floor(totalR2Budget / batchSize)
}

export function maxManifestSizeLookupAttemptsForBudget(
  perMessageBudget: number,
  candidateCount: number,
  maxAttempts: number,
): number {
  const perAttempt = worstCaseSubrequestsPerAttemptForCandidateCount(candidateCount)
  if (perAttempt <= 0)
    return 1
  return Math.max(1, Math.min(maxAttempts, Math.floor(perMessageBudget / perAttempt)))
}

export function assertDefaultManifestBatchFitsR2Budget(maxAttempts: number): void {
  const perMessage = perMessageManifestSizeLookupBudget(MANIFEST_QUEUE_DEFAULT_BATCH_SIZE)
  const attempts = maxManifestSizeLookupAttemptsForBudget(
    perMessage,
    MANIFEST_SIZE_MAX_CANDIDATE_KEYS,
    maxAttempts,
  )
  const worst = MANIFEST_QUEUE_DEFAULT_BATCH_SIZE
    * attempts
    * worstCaseSubrequestsPerAttemptForCandidateCount(MANIFEST_SIZE_MAX_CANDIDATE_KEYS)
  if (worst > MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET) {
    throw new Error(
      `default manifest batch exceeds R2 subrequest budget (${worst} > ${MANIFEST_QUEUE_R2_SUBREQUEST_BUDGET})`,
    )
  }
}

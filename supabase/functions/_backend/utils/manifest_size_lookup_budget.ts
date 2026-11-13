import type { StorageSizeDiagnostics } from './s3.ts'
import { getManifestStorageCandidateKeys } from './manifest_encoding.ts'

// Paid Workers default subrequest limit unless overridden in wrangler.
export const CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET = 10_000
export const MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE = 2
export const MANIFEST_SIZE_MAX_CANDIDATE_KEYS = 5

export function estimateManifestSizeLookupSubrequests(diagnostics: StorageSizeDiagnostics): number {
  return diagnostics.candidates.reduce((sum, candidate) => sum + 1 + (candidate.usedFallback ? 1 : 0), 0)
}

export function worstCaseSubrequestsPerSizeLookupAttempt(s3Path: string): number {
  const candidates = Math.min(MANIFEST_SIZE_MAX_CANDIDATE_KEYS, getManifestStorageCandidateKeys(s3Path).length)
  return candidates * MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE
}

export function perMessageManifestSizeLookupBudget(batchSize: number, totalBudget = CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET): number {
  if (batchSize <= 0)
    return 0
  return Math.floor(totalBudget / batchSize)
}

export function maxManifestSizeLookupAttemptsForBudget(
  perMessageBudget: number,
  s3Path: string,
  maxAttempts: number,
): number {
  const perAttempt = worstCaseSubrequestsPerSizeLookupAttempt(s3Path)
  if (perAttempt <= 0)
    return 1
  return Math.max(1, Math.min(maxAttempts, Math.floor(perMessageBudget / perAttempt)))
}

export function computeManifestQueueWorstCaseSubrequests(
  batchSize: number,
  maxAttempts: number,
  maxCandidates: number,
  totalBudget = CLOUDFLARE_MANIFEST_QUEUE_SUBREQUEST_BUDGET,
): number {
  const perMessage = perMessageManifestSizeLookupBudget(batchSize, totalBudget)
  const attempts = Math.max(1, Math.min(maxAttempts, Math.floor(perMessage / (maxCandidates * MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE))))
  return batchSize * attempts * maxCandidates * MANIFEST_SIZE_R2_CALLS_PER_CANDIDATE
}

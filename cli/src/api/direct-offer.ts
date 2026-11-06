import type { CapgoApiTarget } from '../utils'
import { isZeroLengthTrial } from '../shared/direct-offer'
import { invokeCliHttpFromClient } from '../utils'

const DIRECT_OFFER_LOOKUP_TIMEOUT_MS = 5_000

interface BillingProgress {
  billing?: { status?: string, orgCreatedAt?: unknown, trialEndsAt?: unknown, hasPaid?: unknown }
}

/**
 * Best-effort: true when the app's org never had a free trial (direct offer).
 * Only called after a plan check already blocked the command. Reads the org
 * creation time and trial end from the existing `private/onboarding_progress`
 * billing summary (needs app.read + org.read_billing). `N: 4` without `initial`
 * runs none of the periodic onboarding checks. Any error, timeout, older server
 * without `orgCreatedAt`/`hasPaid`, `null` value, or an org that paid before
 * (churned) keeps the normal plan copy.
 */
export async function isDirectOfferApp(client: CapgoApiTarget, appId: string | undefined): Promise<boolean> {
  if (!appId)
    return false
  try {
    const { data, error } = await invokeCliHttpFromClient<BillingProgress>(client, 'private/onboarding_progress', {
      method: 'POST',
      body: { appId, N: 4, includeBilling: true },
      signal: AbortSignal.timeout(DIRECT_OFFER_LOOKUP_TIMEOUT_MS),
    })
    const billing = data?.billing
    if (error || billing?.status !== 'available')
      return false
    if (billing.hasPaid !== false || typeof billing.orgCreatedAt !== 'string' || typeof billing.trialEndsAt !== 'string')
      return false
    return isZeroLengthTrial(billing.orgCreatedAt, billing.trialEndsAt)
  }
  catch {
    return false
  }
}

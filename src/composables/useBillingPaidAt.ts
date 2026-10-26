import type { Ref } from 'vue'
import { ref, watch } from 'vue'
import { useConsole } from '~/services/console'
import { isZeroLengthTrial, resolveBillingPaidAt } from '~/services/paymentRequired'

const BILLING_PAID_AT_CACHE_TTL_MS = 5 * 60 * 1000
const BILLING_PAID_AT_CACHE_MAX_ENTRIES = 100
const billingPaidAtCache = new Map<string, { paidAt: string | null, trialSkipped: boolean, expiresAt: number }>()
type BillingHistoryResult = { paidAt: string | null, trialSkipped: boolean } | { error: unknown }
// Several components (for example the two responsive navbar banners) can ask
// for the same org at once: share one in-flight request per org.
const billingPaidAtInFlight = new Map<string, Promise<BillingHistoryResult>>()

async function fetchBillingHistory(orgId: string): Promise<BillingHistoryResult> {
  const { data, error } = await useConsole()
    .from('orgs')
    .select('created_at, stripe_info(paid_at, trial_at)')
    .eq('id', orgId)
    .maybeSingle()
  if (error || !data)
    return { error }
  const paidAt = resolveBillingPaidAt(data.stripe_info)
  // Only orgs that never paid: a churned customer must not see "choose a plan to start".
  const trialSkipped = paidAt === null && isZeroLengthTrial(data.created_at, data.stripe_info?.trial_at)
  cacheBillingPaidAt(orgId, paidAt, trialSkipped)
  return { paidAt, trialSkipped }
}

function loadBillingHistory(orgId: string): Promise<BillingHistoryResult> {
  const pending = billingPaidAtInFlight.get(orgId)
  if (pending)
    return pending
  const request = fetchBillingHistory(orgId)
    .catch((error: unknown) => ({ error }))
    .finally(() => billingPaidAtInFlight.delete(orgId))
  billingPaidAtInFlight.set(orgId, request)
  return request
}

function cacheBillingPaidAt(orgId: string, paidAt: string | null, trialSkipped: boolean) {
  const now = Date.now()
  for (const [cachedOrgId, cached] of billingPaidAtCache) {
    if (cached.expiresAt <= now)
      billingPaidAtCache.delete(cachedOrgId)
  }

  if (!billingPaidAtCache.has(orgId) && billingPaidAtCache.size >= BILLING_PAID_AT_CACHE_MAX_ENTRIES) {
    const oldestOrgId = billingPaidAtCache.keys().next().value
    if (oldestOrgId)
      billingPaidAtCache.delete(oldestOrgId)
  }

  billingPaidAtCache.set(orgId, {
    paidAt,
    trialSkipped,
    expiresAt: now + BILLING_PAID_AT_CACHE_TTL_MS,
  })
}

export function useBillingPaidAt(orgId: Readonly<Ref<string | null | undefined>>, disabled = false) {
  const paidAt = ref<string | null | undefined>(undefined)
  const billingLookupFailed = ref(false)
  // True when the org was created without a free trial (direct offer): show
  // "choose a plan to start" instead of "your trial has ended".
  const trialSkipped = ref(false)
  let billingLookupRun = 0

  watch(orgId, async (nextOrgId) => {
    const currentRun = ++billingLookupRun
    paidAt.value = undefined
    billingLookupFailed.value = false
    trialSkipped.value = false

    if (disabled || !nextOrgId)
      return

    const cached = billingPaidAtCache.get(nextOrgId)
    if (cached && cached.expiresAt <= Date.now())
      billingPaidAtCache.delete(nextOrgId)

    if (cached && cached.expiresAt > Date.now()) {
      paidAt.value = cached.paidAt
      trialSkipped.value = cached.trialSkipped
      return
    }

    const result = await loadBillingHistory(nextOrgId)

    if (currentRun !== billingLookupRun)
      return

    if ('error' in result) {
      billingLookupFailed.value = true
      console.error('Failed to load organization billing history', { orgId: nextOrgId, error: result.error })
      return
    }

    paidAt.value = result.paidAt
    trialSkipped.value = result.trialSkipped
  }, { immediate: true })

  return { paidAt, billingLookupFailed, trialSkipped }
}

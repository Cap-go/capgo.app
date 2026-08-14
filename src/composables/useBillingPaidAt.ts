import type { Ref } from 'vue'
import { ref, watch } from 'vue'
import { resolveBillingPaidAt } from '~/services/paymentRequired'
import { useSupabase } from '~/services/supabase'

const BILLING_PAID_AT_CACHE_TTL_MS = 5 * 60 * 1000
const BILLING_PAID_AT_CACHE_MAX_ENTRIES = 100
const billingPaidAtCache = new Map<string, { paidAt: string | null, expiresAt: number }>()

function cacheBillingPaidAt(orgId: string, paidAt: string | null) {
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
    expiresAt: now + BILLING_PAID_AT_CACHE_TTL_MS,
  })
}

export function useBillingPaidAt(orgId: Readonly<Ref<string | null | undefined>>, disabled = false) {
  const paidAt = ref<string | null | undefined>(undefined)
  const billingLookupFailed = ref(false)
  let billingLookupRun = 0

  watch(orgId, async (nextOrgId) => {
    const currentRun = ++billingLookupRun
    paidAt.value = undefined
    billingLookupFailed.value = false

    if (disabled || !nextOrgId)
      return

    const cached = billingPaidAtCache.get(nextOrgId)
    if (cached && cached.expiresAt <= Date.now())
      billingPaidAtCache.delete(nextOrgId)

    if (cached && cached.expiresAt > Date.now()) {
      paidAt.value = cached.paidAt
      return
    }

    const { data, error } = await useSupabase()
      .from('orgs')
      .select('stripe_info(paid_at)')
      .eq('id', nextOrgId)
      .maybeSingle()

    if (currentRun !== billingLookupRun)
      return

    if (error || !data) {
      billingLookupFailed.value = true
      console.error('Failed to load organization billing history', { orgId: nextOrgId, error })
      return
    }

    const resolvedPaidAt = resolveBillingPaidAt(data.stripe_info)
    cacheBillingPaidAt(nextOrgId, resolvedPaidAt)
    paidAt.value = resolvedPaidAt
  }, { immediate: true })

  return { paidAt, billingLookupFailed }
}

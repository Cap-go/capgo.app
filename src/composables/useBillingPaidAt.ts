import type { Ref } from 'vue'
import { ref, watch } from 'vue'
import { resolveBillingPaidAt } from '~/services/paymentRequired'
import { useSupabase } from '~/services/supabase'

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

    paidAt.value = resolveBillingPaidAt(data.stripe_info)
  }, { immediate: true })

  return { paidAt, billingLookupFailed }
}

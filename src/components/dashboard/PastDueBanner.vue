<script setup lang="ts">
/**
 * PastDueBanner Component
 *
 * Shown in the dashboard shell when the current organization's subscription
 * renewal failed, so access gating never happens without an explanation.
 *
 * Visibility conditions:
 * - Stripe billing is enabled and external purchase flows are allowed
 * - The user can manage org billing (org.update_billing)
 * - The backend reports the org as past due
 */

import type { PastDueStatus } from '~/services/stripe'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconExclamationTriangle from '~icons/heroicons/exclamation-triangle'
import { getFormatLocale } from '~/services/formatLocale'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { checkPermissions } from '~/services/permissions'
import { pushEvent } from '~/services/posthog'
import { getPastDueStatus, openBlank, openPortal } from '~/services/stripe'
import { getLocalConfig, stripeEnabled } from '~/services/supabase'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const config = getLocalConfig()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

const pastDue = ref<PastDueStatus | null>(null)
let lookupRun = 0

const currentOrg = computed(() => organizationStore.currentOrganization)
const orgId = computed(() => {
  const org = currentOrg.value
  if (!org || isPendingOrganizationInvite(org))
    return ''
  return org.gid
})

watch([orgId, () => !!stripeEnabled.value], async ([id, enabled]) => {
  const run = ++lookupRun
  pastDue.value = null
  if (!id || !enabled || hideExternalPurchaseFlows)
    return
  if (!await checkPermissions('org.update_billing', { orgId: id }) || run !== lookupRun)
    return
  const status = await getPastDueStatus(id)
  if (run !== lookupRun)
    return
  pastDue.value = status
  if (status?.past_due) {
    pushEvent('past_due_banner_shown', config.supaHost, {
      org_id: id,
      attempt_count: status.invoice?.attempt_count ?? 0,
    })
  }
}, { immediate: true })

const invoice = computed(() => pastDue.value?.invoice ?? null)
const showBanner = computed(() => !!pastDue.value?.past_due)

const formattedAmount = computed(() => {
  const value = invoice.value
  if (!value)
    return ''
  try {
    return new Intl.NumberFormat(getFormatLocale(), { style: 'currency', currency: value.currency.toUpperCase() })
      .format(value.amount_due / 100)
  }
  catch {
    return `${(value.amount_due / 100).toFixed(2)} ${value.currency.toUpperCase()}`
  }
})

const message = computed(() => formattedAmount.value
  ? t('past-due-banner-message-amount', { amount: formattedAmount.value })
  : t('past-due-banner-message'))

async function payNow() {
  const url = invoice.value?.hosted_invoice_url
  if (!url)
    return
  pushEvent('past_due_banner_pay_clicked', config.supaHost, { org_id: orgId.value })
  await openBlank(url)
}

async function updateCard() {
  pushEvent('past_due_banner_update_card_clicked', config.supaHost, { org_id: orgId.value })
  await openPortal(orgId.value, t)
}
</script>

<template>
  <aside
    v-if="showBanner"
    class="relative z-20 flex w-full shrink-0 flex-col gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-amber-950 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:border-amber-700/60 dark:bg-amber-950/60 dark:text-amber-100"
    role="alert"
    data-test="past-due-banner"
  >
    <div class="flex min-w-0 items-center gap-3">
      <IconExclamationTriangle class="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div class="min-w-0">
        <p class="text-sm font-semibold">
          {{ message }}
        </p>
        <p class="text-xs text-amber-900/80 dark:text-amber-200/80">
          {{ t('past-due-banner-detail') }}
        </p>
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <button
        type="button"
        class="d-btn d-btn-sm d-btn-ghost text-amber-950 dark:text-amber-100"
        data-test="past-due-update-card"
        @click="updateCard"
      >
        {{ t('past-due-banner-update-card') }}
      </button>
      <button
        v-if="invoice?.hosted_invoice_url"
        type="button"
        class="d-btn d-btn-sm d-btn-warning text-black"
        data-test="past-due-pay-now"
        @click="payNow"
      >
        {{ t('past-due-banner-pay-now') }}
      </button>
    </div>
  </aside>
</template>

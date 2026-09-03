<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { stripeEnabled } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'
import { resolveOrgBillingStatus } from '~/utils/organizationBilling'

const props = defineProps({
  text: { type: String, default: '' },
  color: { type: String, default: '' },
  desktop: { type: Boolean, default: false },
})

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const isMobile = Capacitor.isNativePlatform()
const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled === true && org?.password_has_access === false
  return lacks2FA || lacksPassword
})
const status = computed(() => resolveOrgBillingStatus(organizationStore.currentOrganization, {
  stripeEnabled: !!stripeEnabled.value,
  lacksSecurityAccess: lacksSecurityAccess.value,
  organizationFailed: !!organizationStore.currentOrganizationFailed,
}))
const billingCtaHref = computed(() => {
  if (isMobile)
    return '/settings/organization/usage'
  if (status.value.cta === 'go_credits')
    return '/settings/organization/credits'
  return '/settings/organization/plans'
})
const billingCtaLabel = computed(() => {
  if (isMobile)
    return t('see-usage')
  if (status.value.cta === 'go_credits')
    return t('manage')
  return t('upgrade')
})

const showBanner = computed(() => status.value.kind !== 'hidden')
const showCta = computed(() => status.value.cta !== 'none')

const statusLabel = computed(() => {
  switch (status.value.kind) {
    case 'trial':
      return t('free-trial')
    case 'trial_over':
      return t('trial-over')
    case 'plan_active':
      return t('plan-active')
    case 'using_credits':
    case 'limit_reached_credits':
      return t('using-credits')
    case 'limit_reached':
      return t('plan-limit-reached')
    default:
      return ''
  }
})

const statusDetail = computed(() => {
  if (status.value.kind !== 'trial')
    return null
  if (status.value.trialDaysLeft === 1)
    return t('one-day-left')
  return t('trial-days-left', { count: status.value.trialDaysLeft })
})

const statusAriaLabel = computed(() => {
  if (statusDetail.value)
    return `${statusLabel.value}, ${statusDetail.value}`
  return statusLabel.value
})

const badgeClass = computed(() => {
  switch (status.value.tone) {
    case 'trial':
      return 'border-none bg-azure-500 text-white'
    case 'warning':
      return 'd-badge-warning text-black'
    case 'success':
      return 'd-badge-success text-black'
    default:
      return 'd-badge-ghost'
  }
})

const bannerColor = computed(() => {
  if (status.value.tone === 'warning' || (status.value.kind === 'trial' && status.value.trialDaysLeft <= 7))
    return 'd-btn-warning text-black'
  if (status.value.cta === 'none')
    return ''
  return 'd-btn-success text-black'
})
</script>

<template>
  <!-- Desktop inline version -->
  <div
    v-if="props.desktop && showBanner"
    class="flex items-center ml-auto space-x-2 sm:space-x-3"
    data-test="org-billing-banner"
  >
    <component
      :is="showCta ? 'div' : 'a'"
      v-bind="showCta ? {} : { href: billingCtaHref }"
      role="status"
      class="flex items-center gap-2"
      :class="showCta ? '' : 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500'"
      :aria-label="statusAriaLabel"
    >
      <span
        class="d-badge d-badge-sm font-semibold"
        :class="badgeClass"
        data-test="org-billing-status"
      >
        {{ statusLabel }}
      </span>
      <span
        v-if="statusDetail"
        class="text-xs font-semibold sm:text-sm"
        :class="status.trialDaysLeft <= 7 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-800 dark:text-slate-200'"
        data-test="org-billing-detail"
      >
        {{ statusDetail }}
      </span>
    </component>
    <a
      v-if="showCta"
      :href="billingCtaHref"
      class="border-none d-btn d-btn-xs sm:d-btn-sm"
      :class="bannerColor"
      data-test="org-billing-cta"
    >
      {{ billingCtaLabel }}
    </a>
  </div>

  <!-- Mobile/original version -->
  <div
    v-else-if="!props.desktop && showBanner"
    class="flex gap-2 justify-end items-center px-2 bg-gray-200 sm:px-4 min-h-12 sm:min-h-16 dark:bg-gray-800/90"
    data-test="org-billing-banner"
  >
    <component
      :is="showCta ? 'div' : 'a'"
      v-bind="showCta ? {} : { href: billingCtaHref }"
      role="status"
      class="flex items-center gap-2"
      :class="showCta ? '' : 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500'"
      :aria-label="statusAriaLabel"
    >
      <span
        class="d-badge d-badge-sm font-semibold"
        :class="badgeClass"
        data-test="org-billing-status"
      >
        {{ statusLabel }}
      </span>
      <span
        v-if="statusDetail"
        class="text-xs font-medium sm:text-base"
        :class="status.trialDaysLeft <= 7 ? 'text-amber-700 dark:text-amber-300' : 'text-black dark:text-white'"
        data-test="org-billing-detail"
      >
        {{ statusDetail }}
      </span>
    </component>
    <a
      v-if="showCta"
      :href="billingCtaHref"
      class="ml-2 whitespace-nowrap border-none d-btn d-btn-xs sm:d-btn-sm"
      :class="bannerColor"
      data-test="org-billing-cta"
    >
      {{ billingCtaLabel }}
    </a>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from '@capacitor/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { stripeEnabled } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps({
  text: { type: String, default: '' },
  color: { type: String, default: '' },
  desktop: { type: Boolean, default: false },
})

const { t } = useI18n()
const organizationStore = useOrganizationStore()
const isMobile = Capacitor.isNativePlatform()
const billingCtaHref = computed(() => isMobile ? '/settings/organization/usage' : '/settings/organization/plans')

// Check if user lacks security compliance (2FA or password) - data is unreliable in this case
const lacksSecurityAccess = computed(() => {
  const org = organizationStore.currentOrganization
  const lacks2FA = org?.enforcing_2fa === true && org?.['2fa_has_access'] === false
  const lacksPassword = org?.password_policy_config?.enabled && org?.password_has_access === false
  return lacks2FA || lacksPassword
})

const bannerLeftText = computed(() => {
  const org = organizationStore.currentOrganization
  if (org?.paying)
    return t('billing')

  return t('free-trial')
})

const bannerText = computed(() => {
  if (!stripeEnabled.value)
    return null
  const org = organizationStore.currentOrganization
  if (!org)
    return null

  // Don't show billing banner when user lacks 2FA or password access - data is unreliable
  if (lacksSecurityAccess.value)
    return null

  if (organizationStore.currentOrganizationFailed)
    return t('subscription-required')

  if (org.is_canceled) {
    return t('plan-inactive')
  }

  else if (!org.paying && org.trial_left > 1) {
    return `${org.trial_left} ${t('trial-left')}`
  }

  else if (!org.paying && org.trial_left === 1) {
    return t('one-day-left')
  }

  else if (!org.paying && !org.can_use_more) {
    return t('trial-plan-expired')
  }

  else if (org.paying && !org.can_use_more) {
    // Si l'org a des crédits, afficher un message différent
    const hasCredits = (org.credit_available ?? 0) > 0
    return hasCredits ? t('limit-reached-with-credits') : t('limit-reached-no-credits')
  }

  return null
})
const bannerColor = computed(() => {
  const warning = 'd-btn-warning text-black'
  const success = 'd-btn-success text-black'

  const org = organizationStore.currentOrganization
  if (!org)
    return ''

  if (organizationStore.currentOrganizationFailed)
    return warning

  if (org.paying && org.can_use_more)
    return ''

  else if (org.is_canceled)
    return warning

  else if (!org.paying && org.trial_left > 1 && org.trial_left <= 7)
    return warning

  else if (!org.paying && org.trial_left === 1)
    return warning

  else if (!org.paying && !org.can_use_more)
    return warning

  else if (org.paying && !org.can_use_more)
    return warning

  return success
})
</script>

<template>
  <!-- Desktop inline version -->
  <div v-if="props.desktop && bannerText" class="flex items-center ml-auto space-x-2 sm:space-x-3">
    <span class="hidden text-xs font-medium sm:inline sm:text-sm text-slate-600 dark:text-slate-400">
      {{ bannerLeftText }}:
    </span>
    <span class="text-xs font-semibold sm:text-sm text-slate-800 dark:text-slate-200">
      {{ bannerText }}
    </span>
    <a :href="billingCtaHref" class="border-none d-btn d-btn-xs sm:d-btn-sm" :class="bannerColor">
      {{ isMobile ? t('see-usage') : t('upgrade') }}
    </a>
  </div>

  <!-- Mobile/original version -->
  <div v-else-if="!props.desktop && bannerText" class="flex gap-2 justify-end items-center px-2 bg-gray-200 sm:px-4 min-h-12 sm:min-h-16 dark:bg-gray-800/90">
    <span class="text-sm font-semibold text-black sm:text-lg dark:text-white">
      {{ bannerLeftText }}:
    </span>
    <span class="text-xs font-medium text-black sm:text-base dark:text-white">{{ bannerText }}</span>
    <a :href="billingCtaHref" class="ml-2 whitespace-nowrap border-none d-btn d-btn-xs sm:d-btn-sm" :class="bannerColor">{{ isMobile ? t('see-usage') : t('upgrade') }}</a>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { useBillingPaidAt } from '~/composables/useBillingPaidAt'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { resolveUnpaidCopyVariant } from '~/services/paymentRequired'
import { useOrganizationStore } from '~/stores/organization'

// Page-level empty state for gated pages when the organization has no active
// subscription. It replaces a blurred, empty table with a clear reason and a
// reachable route to the plans page.
const { t } = useI18n()
const router = useRouter()
const organizationStore = useOrganizationStore()
const hideExternalPurchaseFlows = isNativeAppStoreContext()
const billingOrgId = computed(() => organizationStore.currentOrganization?.gid)
const { paidAt, trialSkipped } = useBillingPaidAt(billingOrgId, hideExternalPurchaseFlows)
const copyVariant = computed(() => resolveUnpaidCopyVariant({
  isNative: hideExternalPurchaseFlows,
  paidAt: paidAt.value,
  trialSkipped: trialSkipped.value,
}))
const showNoTrialCopy = computed(() => copyVariant.value === 'no_trial')

function goToPlans() {
  router.push('/settings/organization/plans')
}
</script>

<template>
  <div class="flex flex-col justify-center items-center px-4 min-h-[50vh] text-center">
    <div class="flex justify-center items-center mb-4 w-16 h-16 bg-amber-100 rounded-full dark:bg-amber-900/30">
      <IconAlertCircle class="w-8 h-8 text-amber-500" />
    </div>
    <h2 class="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
      {{ t(showNoTrialCopy ? 'no-trial-choose-plan-title' : 'subscription-required') }}
    </h2>
    <div v-if="showNoTrialCopy" class="mb-6 max-w-md text-gray-600 dark:text-gray-400">
      <p>{{ t('no-trial-choose-plan-description') }}</p>
      <p class="mt-2 text-sm font-medium text-gray-700 dark:text-gray-300" data-test="no-trial-money-back">
        {{ t('no-trial-money-back-guarantee-description') }}
      </p>
    </div>
    <p v-else class="mb-6 max-w-md text-gray-600 dark:text-gray-400">
      {{ t(hideExternalPurchaseFlows ? 'plan-failed-native-description' : 'unpaid-content-hidden') }}
    </p>
    <button
      v-if="!hideExternalPurchaseFlows"
      type="button"
      class="d-btn d-btn-warning"
      @click="goToPlans"
    >
      {{ t(showNoTrialCopy ? 'choose-a-plan' : 'plan-upgrade-v2') }}
    </button>
  </div>
</template>

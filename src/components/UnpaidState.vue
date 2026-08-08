<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'

// Page-level empty state for gated pages when the organization has no active
// subscription. It replaces a blurred, empty table with a clear reason and a
// reachable route to the plans page.
const { t } = useI18n()
const router = useRouter()
const hideExternalPurchaseFlows = isNativeAppStoreContext()

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
      {{ t('subscription-required') }}
    </h2>
    <p class="mb-6 max-w-md text-gray-600 dark:text-gray-400">
      {{ t(hideExternalPurchaseFlows ? 'plan-failed-native-description' : 'unpaid-content-hidden') }}
    </p>
    <button
      v-if="!hideExternalPurchaseFlows"
      class="inline-flex gap-2 items-center px-6 py-3 text-white bg-amber-500 rounded-lg transition-colors cursor-pointer hover:bg-amber-600 focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:outline-none"
      @click="goToPlans"
    >
      {{ t('plan-upgrade-v2') }}
    </button>
  </div>
</template>

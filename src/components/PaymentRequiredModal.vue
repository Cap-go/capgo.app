<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { isNativeAppStoreContext } from '~/services/nativeCompliance'
import { shouldShowExpiredTrialCopy } from '~/services/paymentRequired'
import { useSupabase } from '~/services/supabase'
import { useOrganizationStore } from '~/stores/organization'

const { t } = useI18n()
const router = useRouter()
const hideExternalPurchaseFlows = isNativeAppStoreContext()
const organizationStore = useOrganizationStore()
const paidAt = ref<string | null | undefined>(undefined)
const showExpiredTrialCopy = computed(() => shouldShowExpiredTrialCopy(hideExternalPurchaseFlows, paidAt.value))

let billingLookupRun = 0
watch(() => organizationStore.currentOrganization?.gid, async (orgId) => {
  const currentRun = ++billingLookupRun
  paidAt.value = undefined

  if (hideExternalPurchaseFlows || !orgId)
    return

  const { data, error } = await useSupabase()
    .from('orgs')
    .select('stripe_info(paid_at)')
    .eq('id', orgId)
    .maybeSingle()

  if (currentRun !== billingLookupRun || error || !data?.stripe_info)
    return

  paidAt.value = data.stripe_info.paid_at
}, { immediate: true })

function goToPlans() {
  router.push('/settings/organization/plans')
}
</script>

<template>
  <div class="flex absolute inset-0 z-10 flex-col justify-center items-center bg-white/60 dark:bg-gray-900/60">
    <div class="p-8 text-center bg-white rounded-xl border shadow-xl dark:bg-gray-800 border-amber-200 dark:border-amber-700">
      <div class="flex justify-center mb-4">
        <div class="flex justify-center items-center w-16 h-16 bg-amber-100 rounded-full dark:bg-amber-900/30">
          <svg class="w-8 h-8 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clip-rule="evenodd"
            />
          </svg>
        </div>
      </div>
      <h2 class="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
        {{ t(showExpiredTrialCopy ? 'trial-ended-title' : 'subscription-required') }}
      </h2>
      <i18n-t v-if="showExpiredTrialCopy" keypath="trial-ended-description" tag="p" class="mb-6 max-w-sm text-gray-600 dark:text-gray-400">
        <template #supportEmail>
          <a href="mailto:support@capgo.app" class="d-link font-medium text-amber-700 underline dark:text-amber-400">support@capgo.app</a>
        </template>
      </i18n-t>
      <p v-else class="mb-6 max-w-sm text-gray-600 dark:text-gray-400">
        {{ t(hideExternalPurchaseFlows ? 'plan-failed-native-description' : 'plan-failed-description') }}
      </p>
      <button
        v-if="!hideExternalPurchaseFlows"
        class="inline-flex gap-2 items-center px-6 py-3 text-white bg-amber-500 rounded-lg transition-colors cursor-pointer hover:bg-amber-600 focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:outline-none"
        @click="goToPlans"
      >
        <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
          <path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd" />
        </svg>
        {{ t(showExpiredTrialCopy ? 'choose-a-plan' : 'plan-upgrade-v2') }}
      </button>
    </div>
  </div>
</template>

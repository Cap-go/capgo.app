<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { AdminABTestDistribution } from '~/services/adminABTestDistribution'
import type { AdminABTestPublishIntentOutcome as AdminABTestPublishIntentOutcomeData } from '~/services/adminABTestPublishIntentOutcome'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminABTestDistributionMatrix from '~/components/admin/AdminABTestDistributionMatrix.vue'
import AdminABTestPublishIntentOutcome from '~/components/admin/AdminABTestPublishIntentOutcome.vue'
import PageLoader from '~/components/PageLoader.vue'
import { parseAdminABTestDistribution } from '~/services/adminABTestDistribution'
import { parseAdminABTestPublishIntentOutcome } from '~/services/adminABTestPublishIntentOutcome'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const adminStore = useAdminDashboardStore()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const distribution = ref<AdminABTestDistribution[]>([])
const publishIntentOutcome = ref<AdminABTestPublishIntentOutcomeData | null>(null)
const isLoading = ref(true)
const loadError = ref(false)

async function loadDashboard(forceRefresh = false) {
  isLoading.value = true
  loadError.value = false
  try {
    const [distributionData, outcomeData] = await Promise.all([
      adminStore.fetchStats('ab_test_distribution', forceRefresh),
      adminStore.fetchStats('ab_test_publish_intent_outcome', forceRefresh),
    ])
    const parsedDistribution = parseAdminABTestDistribution(distributionData)
    const parsedOutcome = parseAdminABTestPublishIntentOutcome(outcomeData)
    if (!parsedDistribution || !parsedOutcome)
      throw new Error('Invalid A/B test dashboard response')
    distribution.value = parsedDistribution
    publishIntentOutcome.value = parsedOutcome
  }
  catch (error) {
    console.error('[Admin A/B Tests] Error loading dashboard:', error)
    loadError.value = true
  }
  finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access A/B test distribution')
    await router.push('/dashboard')
    return
  }

  await loadDashboard()
})

displayStore.NavTitle = t('admin-ab-tests')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <PageLoader v-if="isLoading" />

      <div v-else-if="loadError" role="alert" class="flex flex-col gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error sm:flex-row sm:items-center sm:justify-between">
        <span>{{ t('admin-ab-tests-load-error') }}</span>
        <button type="button" class="d-btn d-btn-error d-btn-outline d-btn-sm self-start sm:self-auto" @click="loadDashboard(true)">
          {{ t('retry') }}
        </button>
      </div>

      <div v-else class="space-y-6">
        <AdminABTestDistributionMatrix :distribution="distribution" />
        <AdminABTestPublishIntentOutcome v-if="publishIntentOutcome" :outcome="publishIntentOutcome" />
      </div>
    </div>
  </div>
</template>

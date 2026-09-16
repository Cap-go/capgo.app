<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { AdminABTestChannelCreation as AdminABTestChannelCreationData } from '~/services/adminABTestChannelCreation'
import type { AdminABTestDevelopmentEnvironment as AdminABTestDevelopmentEnvironmentData } from '~/services/adminABTestDevelopmentEnvironment'
import type { AdminABTestDevelopmentEnvironmentIntents } from '~/services/adminABTestDevelopmentEnvironmentIntent'
import type { AdminABTestDistribution } from '~/services/adminABTestDistribution'
import type { AdminABTestPublishIntentOutcome as AdminABTestPublishIntentOutcomeData } from '~/services/adminABTestPublishIntentOutcome'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminABTestChannelCreation from '~/components/admin/AdminABTestChannelCreation.vue'
import AdminABTestDevelopmentEnvironment from '~/components/admin/AdminABTestDevelopmentEnvironment.vue'
import AdminABTestDevelopmentEnvironmentIntent from '~/components/admin/AdminABTestDevelopmentEnvironmentIntent.vue'
import AdminABTestDistributionMatrix from '~/components/admin/AdminABTestDistributionMatrix.vue'
import AdminABTestPublishIntentOutcome from '~/components/admin/AdminABTestPublishIntentOutcome.vue'
import PageLoader from '~/components/PageLoader.vue'
import { parseAdminABTestChannelCreation } from '~/services/adminABTestChannelCreation'
import { parseAdminABTestDevelopmentEnvironment } from '~/services/adminABTestDevelopmentEnvironment'
import { parseAdminABTestDevelopmentEnvironmentIntents } from '~/services/adminABTestDevelopmentEnvironmentIntent'
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
const channelCreation = ref<AdminABTestChannelCreationData | null>(null)
const distribution = ref<AdminABTestDistribution[]>([])
const publishIntentOutcome = ref<AdminABTestPublishIntentOutcomeData | null>(null)
const developmentEnvironment = ref<AdminABTestDevelopmentEnvironmentData | null>(null)
const environmentIntents = ref<AdminABTestDevelopmentEnvironmentIntents | null>(null)
const isLoading = ref(true)
const loadError = ref(false)

async function loadDashboard(forceRefresh = false) {
  isLoading.value = true
  loadError.value = false
  try {
    const [distributionData, channelCreationData, outcomeData, environmentData] = await Promise.all([
      adminStore.fetchStats('ab_test_distribution', forceRefresh),
      adminStore.fetchStats('ab_test_channel_creation', forceRefresh),
      adminStore.fetchStats('ab_test_publish_intent_outcome', forceRefresh),
      adminStore.fetchStats('ab_test_development_environment', forceRefresh),
    ])
    const parsedDistribution = parseAdminABTestDistribution(distributionData)
    const parsedChannelCreation = parseAdminABTestChannelCreation(channelCreationData)
    const parsedOutcome = parseAdminABTestPublishIntentOutcome(outcomeData)
    const parsedEnvironment = parseAdminABTestDevelopmentEnvironment(environmentData)
    const parsedIntents = parsedEnvironment && parseAdminABTestDevelopmentEnvironmentIntents(environmentData?.development_environment_intents, parsedEnvironment)
    if (!parsedDistribution || !parsedChannelCreation || !parsedOutcome || !parsedEnvironment || !parsedIntents) {
      throw new Error('Invalid A/B test dashboard response')
    }
    distribution.value = parsedDistribution
    channelCreation.value = parsedChannelCreation
    publishIntentOutcome.value = parsedOutcome
    developmentEnvironment.value = parsedEnvironment
    environmentIntents.value = parsedIntents
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
        <AdminABTestChannelCreation v-if="channelCreation" :analytics="channelCreation" />
        <AdminABTestPublishIntentOutcome v-if="publishIntentOutcome" :outcome="publishIntentOutcome" />
        <AdminABTestDevelopmentEnvironment v-if="developmentEnvironment" :outcome="developmentEnvironment" />
        <AdminABTestDevelopmentEnvironmentIntent v-if="environmentIntents" :groups="environmentIntents" />
      </div>
    </div>
  </div>
</template>

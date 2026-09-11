<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { AdminABTestDistribution } from '~/services/adminABTestDistribution'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminABTestDistributionMatrix from '~/components/admin/AdminABTestDistributionMatrix.vue'
import PageLoader from '~/components/PageLoader.vue'
import { parseAdminABTestDistribution } from '~/services/adminABTestDistribution'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const adminStore = useAdminDashboardStore()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const distribution = ref<AdminABTestDistribution[]>([])
const isLoading = ref(true)
const loadError = ref(false)

async function loadDistribution(forceRefresh = false) {
  isLoading.value = true
  loadError.value = false
  try {
    const data = await adminStore.fetchStats('ab_test_distribution', forceRefresh)
    const parsed = parseAdminABTestDistribution(data)
    if (!parsed)
      throw new Error('Invalid A/B test distribution response')
    distribution.value = parsed
  }
  catch (error) {
    console.error('[Admin A/B Tests] Error loading distribution:', error)
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

  await loadDistribution()
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
        <button type="button" class="d-btn d-btn-error d-btn-outline d-btn-sm self-start sm:self-auto" @click="loadDistribution(true)">
          {{ t('retry') }}
        </button>
      </div>

      <AdminABTestDistributionMatrix v-else :distribution="distribution" />
    </div>
  </div>
</template>

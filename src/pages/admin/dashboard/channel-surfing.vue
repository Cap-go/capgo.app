<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminBarChart from '~/components/admin/AdminBarChart.vue'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface ChannelSurfingData {
  total_events: number
  unique_devices: number
  unique_apps: number
  by_day: Array<{ date: string, events: number, devices: number, apps: number }>
  top_apps: Array<{ app_id: string, events: number, devices: number }>
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)
const isLoadingStats = ref(false)
const channelSurfing = ref<ChannelSurfingData | null>(null)
let loadGeneration = 0

async function loadChannelSurfing() {
  const generation = ++loadGeneration
  isLoadingStats.value = true
  try {
    const data = await adminStore.fetchStats('channel_surfing')
    if (generation !== loadGeneration)
      return
    channelSurfing.value = data || null
  }
  catch (error) {
    if (generation !== loadGeneration)
      return
    console.error('[Admin Dashboard Channel Surfing] Error loading stats:', error)
    channelSurfing.value = null
  }
  finally {
    if (generation === loadGeneration) {
      isLoadingStats.value = false
      isLoading.value = false
    }
  }
}

const totalEvents = computed(() => channelSurfing.value?.total_events || 0)
const uniqueDevices = computed(() => channelSurfing.value?.unique_devices || 0)
const uniqueApps = computed(() => channelSurfing.value?.unique_apps || 0)

const topApps = computed(() => channelSurfing.value?.top_apps ?? [])
const topAppLabels = computed(() => topApps.value.map(row => row.app_id))
const topAppEventValues = computed(() => topApps.value.map(row => row.events))
const topAppDeviceValues = computed(() => topApps.value.map(row => row.devices))

const dailySeries = computed(() => {
  const points = channelSurfing.value?.by_day ?? []
  if (points.length === 0)
    return []
  return [
    {
      label: t('channel-surfing-events'),
      data: points.map(point => ({ date: point.date, value: point.events || 0 })),
      color: '#119eff',
    },
    {
      label: t('channel-surfing-devices'),
      data: points.map(point => ({ date: point.date, value: point.devices || 0 })),
      color: '#10b981',
    },
    {
      label: t('channel-surfing-apps'),
      data: points.map(point => ({ date: point.date, value: point.apps || 0 })),
      color: '#f59e0b',
    },
  ]
})

watch(
  () => [adminStore.activeDateRange, adminStore.selectedAppId, adminStore.refreshTrigger] as const,
  () => {
    loadChannelSurfing()
  },
  { deep: true },
)

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin channel surfing dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadChannelSurfing()

  displayStore.NavTitle = t('channel-surfing')
})

displayStore.NavTitle = t('channel-surfing')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
            <AdminStatsCard
              :title="t('channel-surfing-events')"
              :value="totalEvents"
              color-class="text-primary"
              :is-loading="isLoadingStats"
              :subtitle="t('channel-surfing-period')"
            />
            <AdminStatsCard
              :title="t('channel-surfing-devices')"
              :value="uniqueDevices"
              color-class="text-[#119eff]"
              :is-loading="isLoadingStats"
              :subtitle="t('channel-surfing-unique-devices')"
            />
            <AdminStatsCard
              :title="t('channel-surfing-apps')"
              :value="uniqueApps"
              color-class="text-[#10b981]"
              :is-loading="isLoadingStats"
              :subtitle="t('channel-surfing-unique-apps')"
            />
          </div>

          <ChartCard
            :title="t('channel-surfing-trend')"
            :is-loading="isLoadingStats"
            :has-data="dailySeries.length > 0"
          >
            <AdminMultiLineChart
              :series="dailySeries"
              :is-loading="isLoadingStats"
            />
          </ChartCard>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ChartCard
              :title="t('channel-surfing-top-apps-events')"
              :is-loading="isLoadingStats"
              :has-data="topApps.length > 0"
            >
              <AdminBarChart
                :labels="topAppLabels"
                :values="topAppEventValues"
                :label="t('channel-surfing-events')"
                value-mode="count"
                :is-loading="isLoadingStats"
                :total="totalEvents"
              />
            </ChartCard>

            <ChartCard
              :title="t('channel-surfing-top-apps-devices')"
              :is-loading="isLoadingStats"
              :has-data="topApps.length > 0"
            >
              <AdminBarChart
                :labels="topAppLabels"
                :values="topAppDeviceValues"
                :label="t('channel-surfing-devices')"
                value-mode="count"
                :is-loading="isLoadingStats"
                :total="uniqueDevices"
              />
            </ChartCard>
          </div>

          <div class="overflow-hidden bg-white shadow dark:bg-gray-800 sm:rounded-lg">
            <div class="px-4 py-5 sm:px-6">
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">
                {{ t('channel-surfing-top-apps') }}
              </h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {{ t('channel-surfing-top-apps-desc') }}
              </p>
            </div>
            <div class="border-t border-gray-200 dark:border-gray-700">
              <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead class="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th scope="col" class="px-4 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                      {{ t('app-id') }}
                    </th>
                    <th scope="col" class="px-4 py-3 text-xs font-medium tracking-wider text-right text-gray-500 uppercase dark:text-gray-400">
                      {{ t('channel-surfing-events') }}
                    </th>
                    <th scope="col" class="px-4 py-3 text-xs font-medium tracking-wider text-right text-gray-500 uppercase dark:text-gray-400">
                      {{ t('channel-surfing-devices') }}
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                  <tr v-if="topApps.length === 0">
                    <td colspan="3" class="px-4 py-4 text-sm text-center text-gray-500 dark:text-gray-400">
                      {{ t('channel-surfing-empty') }}
                    </td>
                  </tr>
                  <tr v-for="row in topApps" :key="row.app_id">
                    <td class="px-4 py-3 font-mono text-sm text-gray-900 truncate dark:text-white max-w-md">
                      {{ row.app_id }}
                    </td>
                    <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-white">
                      {{ formatNumberValue(row.events) }}
                    </td>
                    <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-white">
                      {{ formatNumberValue(row.devices) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

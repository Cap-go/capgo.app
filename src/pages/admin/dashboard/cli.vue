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

interface CliUsageData {
  total: number
  by_version: Record<string, number>
  by_command: Record<string, number>
  by_api_version: Record<string, number>
  by_day: Array<{ date: string, count: number }>
  top_users: Array<{ email: string, count: number }>
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)
const isLoadingStats = ref(false)
const cliUsage = ref<CliUsageData | null>(null)

async function loadCliUsage() {
  isLoadingStats.value = true
  try {
    const data = await adminStore.fetchStats('cli_usage')
    cliUsage.value = data || null
  }
  catch (error) {
    console.error('[Admin Dashboard CLI] Error loading CLI usage:', error)
    cliUsage.value = null
  }
  finally {
    isLoadingStats.value = false
  }
}

const totalInvocations = computed(() => cliUsage.value?.total || 0)

const distinctVersionCount = computed(() => Object.keys(cliUsage.value?.by_version ?? {}).length)
const distinctCommandCount = computed(() => Object.keys(cliUsage.value?.by_command ?? {}).length)

const versionEntries = computed(() => {
  const breakdown = cliUsage.value?.by_version ?? {}
  return Object.entries(breakdown)
    .map(([version, count]) => ({ version, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
})

const commandEntries = computed(() => {
  const breakdown = cliUsage.value?.by_command ?? {}
  return Object.entries(breakdown)
    .map(([command, count]) => ({ command: command || '(empty)', count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
})

const apiVersionEntries = computed(() => {
  const breakdown = cliUsage.value?.by_api_version ?? {}
  return Object.entries(breakdown)
    .map(([version, count]) => ({ version: version || '(empty)', count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
})

const versionLabels = computed(() => versionEntries.value.map(entry => entry.version))
const versionValues = computed(() => versionEntries.value.map(entry => entry.count))
const commandLabels = computed(() => commandEntries.value.map(entry => entry.command))
const commandValues = computed(() => commandEntries.value.map(entry => entry.count))
const apiVersionLabels = computed(() => apiVersionEntries.value.map(entry => entry.version))
const apiVersionValues = computed(() => apiVersionEntries.value.map(entry => entry.count))

const dailySeries = computed(() => {
  const points = cliUsage.value?.by_day ?? []
  if (points.length === 0)
    return []
  return [{
    label: 'Invocations',
    data: points.map(point => ({ date: point.date, value: point.count || 0 })),
    color: '#119eff',
  }]
})

const topUsers = computed(() => cliUsage.value?.top_users ?? [])

watch(() => adminStore.activeDateRange, () => {
  loadCliUsage()
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadCliUsage()
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin CLI dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadCliUsage()
  isLoading.value = false

  displayStore.NavTitle = t('cli')
})

displayStore.NavTitle = t('cli')
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
              title="Total invocations"
              :value="totalInvocations"
              color-class="text-primary"
              :is-loading="isLoadingStats"
              subtitle="Selected period"
            />
            <AdminStatsCard
              title="CLI versions"
              :value="distinctVersionCount"
              color-class="text-[#119eff]"
              :is-loading="isLoadingStats"
              subtitle="Distinct versions"
            />
            <AdminStatsCard
              title="Commands"
              :value="distinctCommandCount"
              color-class="text-[#10b981]"
              :is-loading="isLoadingStats"
              subtitle="Distinct commands"
            />
          </div>

          <div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <ChartCard
              title="By CLI version"
              :is-loading="isLoadingStats"
              :has-data="versionEntries.length > 0"
            >
              <AdminBarChart
                :labels="versionLabels"
                :values="versionValues"
                label="Invocations"
                value-mode="count"
                :is-loading="isLoadingStats"
                :total="totalInvocations"
              />
            </ChartCard>

            <ChartCard
              title="By command"
              :is-loading="isLoadingStats"
              :has-data="commandEntries.length > 0"
            >
              <AdminBarChart
                :labels="commandLabels"
                :values="commandValues"
                label="Invocations"
                value-mode="count"
                :is-loading="isLoadingStats"
                :total="totalInvocations"
              />
            </ChartCard>

            <ChartCard
              title="By API version"
              :is-loading="isLoadingStats"
              :has-data="apiVersionEntries.length > 0"
            >
              <AdminBarChart
                :labels="apiVersionLabels"
                :values="apiVersionValues"
                label="Invocations"
                value-mode="count"
                :is-loading="isLoadingStats"
                :total="totalInvocations"
              />
            </ChartCard>
          </div>

          <ChartCard
            title="Daily trend"
            :is-loading="isLoadingStats"
            :has-data="dailySeries.length > 0"
          >
            <AdminMultiLineChart
              :series="dailySeries"
              :is-loading="isLoadingStats"
            />
          </ChartCard>

          <div class="overflow-hidden bg-white shadow dark:bg-gray-800 sm:rounded-lg">
            <div class="px-4 py-5 sm:px-6">
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">
                Top users
              </h3>
              <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Most active CLI users in the selected period
              </p>
            </div>
            <div class="border-t border-gray-200 dark:border-gray-700">
              <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead class="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th scope="col" class="px-4 py-3 text-xs font-medium tracking-wider text-left text-gray-500 uppercase dark:text-gray-400">
                      Email
                    </th>
                    <th scope="col" class="px-4 py-3 text-xs font-medium tracking-wider text-right text-gray-500 uppercase dark:text-gray-400">
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                  <tr v-if="topUsers.length === 0">
                    <td colspan="2" class="px-4 py-4 text-sm text-center text-gray-500 dark:text-gray-400">
                      No CLI user activity in this period
                    </td>
                  </tr>
                  <tr v-for="row in topUsers" :key="row.email">
                    <td class="px-4 py-3 text-sm text-gray-900 truncate dark:text-white max-w-md">
                      {{ row.email }}
                    </td>
                    <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-white">
                      {{ formatNumberValue(row.count) }}
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

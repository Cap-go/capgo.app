<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { FormKit } from '@formkit/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminBarChart from '~/components/admin/AdminBarChart.vue'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatLocalDate } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface PluginBreakdownTrendPoint {
  date: string
  version_breakdown: Record<string, number>
  major_breakdown: Record<string, number>
}

interface PluginVersionTopApp {
  app_id: string
  device_count: number
  share: number
}

interface PluginVersionLadderEntry {
  version: string
  device_count: number
  percent: number
  top_apps: PluginVersionTopApp[]
}

interface PluginBreakdownData {
  date: string | null
  devices_last_month: number
  devices_last_month_ios: number
  devices_last_month_android: number
  version_breakdown: Record<string, number>
  major_breakdown: Record<string, number>
  version_ladder?: PluginVersionLadderEntry[]
  trend?: PluginBreakdownTrendPoint[]
}

type PluginBreakdownKey = 'version_breakdown' | 'major_breakdown'

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()
const isLoading = ref(true)
const isLoadingBreakdown = ref(false)

const pluginBreakdown = ref<PluginBreakdownData | null>(null)
const thresholdSelection = ref<'0' | '0.1' | '0.5' | '1' | '2' | '5' | 'custom'>('1')
const customThreshold = ref(1)
const maxVersionRows = 20
const maxTrendVersions = 5
const maxTrendMajorVersions = 8
const trendColorPalette = ['#119eff', '#10b981', '#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6']

async function loadPluginBreakdown() {
  isLoadingBreakdown.value = true
  try {
    const data = await adminStore.fetchStats('plugin_breakdown')
    pluginBreakdown.value = data || null
  }
  catch (error) {
    console.error('[Admin Dashboard Plugins] Error loading plugin breakdown:', error)
    pluginBreakdown.value = null
  }
  finally {
    isLoadingBreakdown.value = false
  }
}

const devicesTotal = computed(() => pluginBreakdown.value?.devices_last_month || 0)
const devicesIos = computed(() => pluginBreakdown.value?.devices_last_month_ios || 0)
const devicesAndroid = computed(() => pluginBreakdown.value?.devices_last_month_android || 0)
const snapshotDate = computed(() => {
  const date = pluginBreakdown.value?.date
  return date ? formatLocalDate(date) || date : '-'
})

const thresholdValue = computed(() => {
  const raw = thresholdSelection.value === 'custom' ? customThreshold.value : Number(thresholdSelection.value)
  const value = Number.isFinite(raw) ? raw : 0
  return Math.min(100, Math.max(0, value))
})

const versionEntries = computed(() => {
  const breakdown = pluginBreakdown.value?.version_breakdown ?? {}
  return Object.entries(breakdown)
    .map(([version, percent]) => ({
      version,
      percent: Number(percent) || 0,
    }))
    .filter(entry => entry.percent > thresholdValue.value)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, maxVersionRows)
})

const majorEntries = computed(() => {
  const breakdown = pluginBreakdown.value?.major_breakdown ?? {}
  return Object.entries(breakdown)
    .map(([version, percent]) => ({
      version,
      percent: Number(percent) || 0,
    }))
    .filter(entry => entry.percent > 0)
    .sort((a, b) => b.percent - a.percent)
})

const versionLabels = computed(() => versionEntries.value.map(entry => entry.version))
const versionValues = computed(() => versionEntries.value.map(entry => entry.percent))
const majorLabels = computed(() => majorEntries.value.map(entry => entry.version))
const majorValues = computed(() => majorEntries.value.map(entry => entry.percent))

const hasVersionData = computed(() => versionEntries.value.length > 0)
const hasMajorData = computed(() => majorEntries.value.length > 0)
const versionLadderEntries = computed(() => (pluginBreakdown.value?.version_ladder ?? []).slice(0, maxVersionRows))
const hasVersionLadderData = computed(() => versionLadderEntries.value.length > 0)

const versionCountTotal = computed(() => Object.keys(pluginBreakdown.value?.version_breakdown ?? {}).length)
const versionCountShown = computed(() => versionEntries.value.length)
const versionTrendPoints = computed(() => pluginBreakdown.value?.trend ?? [])

function formatPercent(value: number) {
  return `${formatNumberValue(Number(value || 0), { maximumFractionDigits: 2 })}%`
}

function getTopBreakdownEntries(
  latestPoint: PluginBreakdownTrendPoint | undefined,
  key: PluginBreakdownKey,
  minPercent: number,
  limit: number,
) {
  if (!latestPoint)
    return []

  return Object.entries(latestPoint[key] ?? {})
    .map(([version, percent]) => ({
      version,
      percent: Number(percent) || 0,
    }))
    .filter(entry => entry.percent > minPercent)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, limit)
}

function buildTrendSeries(
  points: PluginBreakdownTrendPoint[],
  entries: Array<{ version: string }>,
  key: PluginBreakdownKey,
) {
  return entries.map((entry, index) => ({
    label: entry.version,
    data: points.map(point => ({
      date: point.date,
      value: Number(point[key]?.[entry.version]) || 0,
    })),
    color: trendColorPalette[index % trendColorPalette.length],
  }))
}

const topVersionsForTrend = computed(() => {
  const latestPoint = versionTrendPoints.value[versionTrendPoints.value.length - 1]
  return getTopBreakdownEntries(latestPoint, 'version_breakdown', thresholdValue.value, maxTrendVersions)
})
const versionTrendSeries = computed(() => {
  if (versionTrendPoints.value.length === 0 || topVersionsForTrend.value.length === 0)
    return []

  return buildTrendSeries(versionTrendPoints.value, topVersionsForTrend.value, 'version_breakdown')
})
const hasVersionTrendData = computed(() => versionTrendSeries.value.length > 0)
const topMajorVersionsForTrend = computed(() => {
  const latestPoint = versionTrendPoints.value[versionTrendPoints.value.length - 1]
  return getTopBreakdownEntries(latestPoint, 'major_breakdown', 0, maxTrendMajorVersions)
})
const majorTrendSeries = computed(() => {
  if (versionTrendPoints.value.length === 0 || topMajorVersionsForTrend.value.length === 0)
    return []

  return buildTrendSeries(versionTrendPoints.value, topMajorVersionsForTrend.value, 'major_breakdown')
})
const hasMajorTrendData = computed(() => majorTrendSeries.value.length > 0)

watch(() => adminStore.activeDateRange, () => {
  loadPluginBreakdown()
}, { deep: true })

watch(() => adminStore.refreshTrigger, () => {
  loadPluginBreakdown()
})

watch(thresholdSelection, (value) => {
  if (value !== 'custom')
    customThreshold.value = Number(value) || 0
})

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadPluginBreakdown()
  isLoading.value = false

  displayStore.NavTitle = t('plugins')
})

displayStore.NavTitle = t('plugins')
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
              title="Active devices (30d)"
              :value="devicesTotal"
              color-class="text-primary"
              :is-loading="isLoadingBreakdown"
              subtitle="All platforms"
            />
            <AdminStatsCard
              title="iOS devices (30d)"
              :value="devicesIos"
              color-class="text-[#119eff]"
              :is-loading="isLoadingBreakdown"
              subtitle="Active iOS devices"
            />
            <AdminStatsCard
              title="Android devices (30d)"
              :value="devicesAndroid"
              color-class="text-emerald-500"
              :is-loading="isLoadingBreakdown"
              subtitle="Active Android devices"
            />
          </div>

          <ChartCard
            title="Version Breakdown Over Time"
            :is-loading="isLoadingBreakdown"
            :has-data="hasVersionTrendData"
            no-data-message="No plugin version trend data available"
          >
            <template #header>
              <div class="flex flex-col gap-1">
                <h2 class="text-2xl font-semibold leading-tight dark:text-white text-slate-600">
                  Version Breakdown Over Time
                </h2>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  Top {{ topVersionsForTrend.length }} versions from latest snapshot (min share {{ thresholdValue }}%)
                </p>
              </div>
            </template>
            <AdminMultiLineChart
              :series="versionTrendSeries"
              :is-loading="isLoadingBreakdown"
              value-suffix="%"
              :suggested-max="100"
            />
          </ChartCard>

          <ChartCard
            title="Major Version Breakdown Over Time"
            :is-loading="isLoadingBreakdown"
            :has-data="hasMajorTrendData"
            no-data-message="No major version trend data available"
          >
            <template #header>
              <div class="flex flex-col gap-1">
                <h2 class="text-2xl font-semibold leading-tight dark:text-white text-slate-600">
                  Major Version Breakdown Over Time
                </h2>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  Top {{ topMajorVersionsForTrend.length }} major versions from latest snapshot
                </p>
              </div>
            </template>
            <AdminMultiLineChart
              :series="majorTrendSeries"
              :is-loading="isLoadingBreakdown"
              value-suffix="%"
              :suggested-max="100"
            />
          </ChartCard>

          <ChartCard
            title="Version Ladder"
            :is-loading="isLoadingBreakdown"
            :has-data="hasVersionLadderData"
            no-data-message="No plugin version ladder data available"
          >
            <template #header>
              <div class="flex flex-col gap-1">
                <h2 class="text-2xl font-semibold leading-tight dark:text-white text-slate-600">
                  Version Ladder
                </h2>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                  Top {{ maxVersionRows }} plugin versions with their top 3 app IDs
                </p>
              </div>
            </template>
            <div class="overflow-x-auto">
              <table class="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
                <thead class="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr>
                    <th class="px-4 py-3">
                      Rank
                    </th>
                    <th class="px-4 py-3">
                      Version
                    </th>
                    <th class="px-4 py-3 text-right">
                      Devices
                    </th>
                    <th class="px-4 py-3">
                      Top app IDs
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 dark:divide-slate-700">
                  <tr v-for="(entry, index) in versionLadderEntries" :key="entry.version" class="align-top">
                    <td class="px-4 py-4 font-semibold text-slate-500 dark:text-slate-400">
                      #{{ index + 1 }}
                    </td>
                    <td class="px-4 py-4">
                      <div class="font-semibold text-slate-900 dark:text-white">
                        {{ entry.version }}
                      </div>
                      <div class="text-xs text-slate-500 dark:text-slate-400">
                        {{ formatPercent(entry.percent) }} share
                      </div>
                    </td>
                    <td class="px-4 py-4 text-right font-semibold text-slate-700 dark:text-slate-200">
                      {{ formatNumberValue(entry.device_count) }}
                    </td>
                    <td class="px-4 py-4">
                      <div v-if="entry.top_apps.length > 0" class="min-w-[16rem] space-y-2">
                        <div
                          v-for="app in entry.top_apps"
                          :key="`${entry.version}-${app.app_id}`"
                          class="flex flex-col gap-1 rounded-md bg-slate-50 px-3 py-2 dark:bg-slate-800/80 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <span class="min-w-0 break-all font-medium text-slate-700 dark:text-slate-200">{{ app.app_id }}</span>
                          <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                            {{ formatNumberValue(app.device_count) }} ({{ formatPercent(app.share) }})
                          </span>
                        </div>
                      </div>
                      <span v-else class="text-slate-400">-</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </ChartCard>

          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <ChartCard
              title="Plugin Versions"
              :total="devicesTotal"
              unit="devices"
              :is-loading="isLoadingBreakdown"
              :has-data="hasVersionData"
              no-data-message="No plugin version data available"
            >
              <template #header>
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1">
                    <h2 class="text-2xl font-semibold leading-tight dark:text-white text-slate-600">
                      Plugin Versions
                    </h2>
                    <p class="text-xs text-slate-500 dark:text-slate-400">
                      Latest snapshot: {{ snapshotDate }}
                    </p>
                  </div>
                  <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>Min share</span>
                    <FormKit
                      v-model="thresholdSelection"
                      type="select"
                      :options="[
                        { label: '0%', value: '0' },
                        { label: '0.1%', value: '0.1' },
                        { label: '0.5%', value: '0.5' },
                        { label: '1%', value: '1' },
                        { label: '2%', value: '2' },
                        { label: '5%', value: '5' },
                        { label: 'Custom', value: 'custom' },
                      ]"
                      :classes="{ outer: 'mb-0! w-[92px]', input: 'd-select d-select-sm' }"
                    />
                    <div v-if="thresholdSelection === 'custom'" class="flex items-center gap-1">
                      <FormKit
                        v-model="customThreshold"
                        type="number"
                        number="float"
                        :min="0"
                        :max="100"
                        :step="0.1"
                        :classes="{ outer: 'mb-0! w-[80px]', input: 'd-input d-input-sm' }"
                      />
                      <span>%</span>
                    </div>
                    <span>Top {{ maxVersionRows }}</span>
                    <span v-if="versionCountTotal" class="text-[11px]">
                      (showing {{ versionCountShown }} of {{ versionCountTotal }})
                    </span>
                  </div>
                </div>
              </template>
              <AdminBarChart
                :labels="versionLabels"
                :values="versionValues"
                label="Device Share"
                :total="devicesTotal"
                :is-loading="isLoadingBreakdown"
              />
            </ChartCard>

            <ChartCard
              title="Major Versions"
              :total="devicesTotal"
              unit="devices"
              :is-loading="isLoadingBreakdown"
              :has-data="hasMajorData"
              no-data-message="No major version data available"
            >
              <template #header>
                <div class="flex flex-col gap-1">
                  <h2 class="text-2xl font-semibold leading-tight dark:text-white text-slate-600">
                    Major Versions
                  </h2>
                  <p class="text-xs text-slate-500 dark:text-slate-400">
                    Latest snapshot: {{ snapshotDate }}
                  </p>
                </div>
              </template>
              <AdminBarChart
                :labels="majorLabels"
                :values="majorValues"
                label="Device Share"
                :total="devicesTotal"
                :is-loading="isLoadingBreakdown"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

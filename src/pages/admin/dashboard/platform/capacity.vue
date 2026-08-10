<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminMultiLineChart from '~/components/admin/AdminMultiLineChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface BuilderCapacityLive {
  workers_total: number
  workers_online: number
  used: number
  free: number
  waiting: number
  offline: number
  builder_reachable: boolean
}
interface BuilderCapacityHourPoint {
  date: string
  workers: number
  used: number
  free: number
  waiting: number
}
interface BuilderCapacity {
  live: BuilderCapacityLive
  hourly: BuilderCapacityHourPoint[]
  capacity_events: number
  runs_sampled: number
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()

const isLoading = ref(true)
const isLoadingCapacity = ref(false)
const capacity = ref<BuilderCapacity | null>(null)

async function loadCapacity() {
  isLoadingCapacity.value = true
  try {
    capacity.value = (await adminStore.fetchStats('builder_capacity', true)) || null
  }
  catch (error) {
    console.error('[Admin Platform Capacity] Error loading builder capacity:', error)
    capacity.value = null
  }
  finally {
    isLoadingCapacity.value = false
  }
}

const capacityLive = computed(() => capacity.value?.live)
const capacityHourlySeries = computed(() => {
  const hourly = capacity.value?.hourly ?? []
  if (!hourly.length)
    return []
  return [
    { label: t('admin-capacity-workers'), color: '#64748b', data: hourly.map(d => ({ date: d.date, value: d.workers })) },
    { label: t('admin-capacity-used'), color: '#ef4444', data: hourly.map(d => ({ date: d.date, value: d.used })) },
    { label: t('admin-capacity-free'), color: '#10b981', data: hourly.map(d => ({ date: d.date, value: d.free })) },
  ]
})
const hasCapacityHourly = computed(() => {
  const c = capacity.value
  if (!c)
    return false
  // Show the series even when all values are 0 (outage / empty pool), as long as
  // we have capacity events or run intervals for the selected period.
  return c.hourly.length > 0 && (c.capacity_events > 0 || c.runs_sampled > 0)
})

function liveMetric(value: number | undefined): string | number {
  if (!capacityLive.value?.builder_reachable)
    return '—'
  return value ?? 0
}

const CAPACITY_POLL_MS = 30_000
let capacityPollTimer: ReturnType<typeof setInterval> | null = null

function startCapacityPolling() {
  stopCapacityPolling()
  capacityPollTimer = setInterval(() => {
    void loadCapacity()
  }, CAPACITY_POLL_MS)
}

function stopCapacityPolling() {
  if (!capacityPollTimer)
    return
  clearInterval(capacityPollTimer)
  capacityPollTimer = null
}

async function loadAll() {
  await loadCapacity()
  startCapacityPolling()
}

function sendNonAdminBack() {
  console.error('Non-admin user attempted to access admin platform capacity')
  return router.push('/dashboard')
}

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (mainStore.isAdmin)
      void loadCapacity()
  },
  { deep: true },
)

onMounted(async () => {
  if (!mainStore.isAdmin)
    return sendNonAdminBack()
  isLoading.value = true
  await loadAll()
  isLoading.value = false
})

onUnmounted(() => {
  stopCapacityPolling()
})

displayStore.NavTitle = t('admin-platform-capacity')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <div class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <AdminStatsCard
              :title="t('admin-pulse-builders-free')"
              :value="liveMetric(capacityLive?.free)"
              color-class="text-emerald-500"
              :is-loading="isLoadingCapacity"
              :subtitle="capacityLive?.builder_reachable ? t('admin-pulse-builders-online', { count: capacityLive?.workers_online ?? 0 }) : t('admin-pulse-builder-unreachable')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-builders-used')"
              :value="liveMetric(capacityLive?.used)"
              color-class="text-red-500"
              :is-loading="isLoadingCapacity"
              :subtitle="capacityLive?.builder_reachable ? t('admin-pulse-builders-used-subtitle') : t('admin-pulse-builder-unreachable')"
            />
            <AdminStatsCard
              :title="t('admin-capacity-online-workers')"
              :value="liveMetric(capacityLive?.workers_online)"
              color-class="text-[#119eff]"
              :is-loading="isLoadingCapacity"
              :subtitle="capacityLive?.builder_reachable ? `${capacityLive?.workers_total ?? 0} registered` : t('admin-pulse-builder-unreachable')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-builders-waiting')"
              :value="liveMetric(capacityLive?.waiting)"
              color-class="text-amber-500"
              :is-loading="isLoadingCapacity"
              :subtitle="capacityLive?.builder_reachable ? t('admin-pulse-builders-waiting-subtitle') : t('admin-pulse-builder-unreachable')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-builders-offline')"
              :value="liveMetric(capacityLive?.offline)"
              color-class="text-slate-500"
              :is-loading="isLoadingCapacity"
              :subtitle="capacityLive?.builder_reachable ? t('admin-pulse-builders-offline-subtitle') : t('admin-pulse-builder-unreachable')"
            />
          </div>

          <div class="grid grid-cols-1 gap-6">
            <ChartCard
              :title="t('admin-capacity-usage-by-hour')"
              :is-loading="isLoadingCapacity"
              :has-data="hasCapacityHourly"
              no-data-message="No capacity events yet — open after the builder reports worker +/-"
            >
              <template #header>
                <div class="flex flex-col gap-1">
                  <h2 class="text-2xl font-semibold leading-tight dark:text-white text-slate-600">
                    {{ t('admin-capacity-usage-by-hour') }}
                  </h2>
                  <p class="text-xs text-slate-500 dark:text-slate-400">
                    {{ t('admin-capacity-usage-by-hour-description') }}
                  </p>
                </div>
              </template>
              <AdminMultiLineChart
                :series="capacityHourlySeries"
                :is-loading="isLoadingCapacity"
                date-granularity="hour"
              />
            </ChartCard>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

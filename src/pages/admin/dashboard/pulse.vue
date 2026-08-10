<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import { formatNumberValue, formatOneDecimal } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

interface OnboardingFunnelData {
  total_registrations: number
  total_orgs: number
  orgs_with_app: number
  orgs_with_channel: number
  orgs_with_bundle: number
  orgs_subscribed: number
  orgs_with_production_device: number
  orgs_with_update_download: number
  activation_telemetry_available: boolean
  update_download_conversion_rate: number
  org_conversion_rate: number
}

interface GlobalStatsTrendPoint {
  date: string
  paying: number
  trial: number
  registers_today: number
  success_rate: number
  mrr: number
  paying_orgs_total?: number
}

interface BuilderCapacityLive {
  workers_total: number
  workers_online: number
  used: number
  free: number
  waiting: number
  offline: number
  builder_reachable: boolean
}

interface BuilderCapacity {
  live: BuilderCapacityLive
}

const { t } = useI18n()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const adminStore = useAdminDashboardStore()
const router = useRouter()

const isLoading = ref(true)
const isLoadingStats = ref(false)
const isLoadingFunnel = ref(false)
const isLoadingCapacity = ref(false)

const globalStatsTrendData = ref<GlobalStatsTrendPoint[]>([])
const onboardingFunnelData = ref<OnboardingFunnelData | null>(null)
const capacity = ref<BuilderCapacity | null>(null)

async function loadGlobalStatsTrend() {
  isLoadingStats.value = true
  try {
    const data = await adminStore.fetchStats('global_stats_trend')
    globalStatsTrendData.value = data || []
  }
  catch (error) {
    console.error('[Admin Dashboard Pulse] Error loading global stats trend:', error)
    globalStatsTrendData.value = []
  }
  finally {
    isLoadingStats.value = false
  }
}

async function loadOnboardingFunnel() {
  isLoadingFunnel.value = true
  try {
    const data = await adminStore.fetchStats('onboarding_funnel')
    onboardingFunnelData.value = data || null
  }
  catch (error) {
    console.error('[Admin Dashboard Pulse] Error loading onboarding funnel:', error)
    onboardingFunnelData.value = null
  }
  finally {
    isLoadingFunnel.value = false
  }
}

async function loadCapacity() {
  isLoadingCapacity.value = true
  try {
    capacity.value = (await adminStore.fetchStats('builder_capacity', true)) || null
  }
  catch (error) {
    console.error('[Admin Dashboard Pulse] Error loading builder capacity:', error)
    capacity.value = null
  }
  finally {
    isLoadingCapacity.value = false
  }
}

const latestGlobalStats = computed(() => {
  if (globalStatsTrendData.value.length === 0)
    return null
  return globalStatsTrendData.value[globalStatsTrendData.value.length - 1]
})

const activationRate = computed(() => {
  const funnel = onboardingFunnelData.value
  if (!funnel)
    return null
  if (funnel.activation_telemetry_available)
    return Number(funnel.update_download_conversion_rate) || 0
  return Number(funnel.org_conversion_rate) || 0
})

const stuckAppNoChannel = computed(() => {
  const funnel = onboardingFunnelData.value
  if (!funnel)
    return 0
  return Math.max(0, (Number(funnel.orgs_with_app) || 0) - (Number(funnel.orgs_with_channel) || 0))
})

const payingOrgs = computed(() => {
  const stats = latestGlobalStats.value
  if (!stats)
    return 0
  return stats.paying_orgs_total ?? stats.paying ?? 0
})

const capacityLive = computed(() => capacity.value?.live)

const kpiCardsLoading = computed(() => isLoadingStats.value || isLoadingFunnel.value)

function goTo(path: string) {
  void router.push(path)
}

async function loadAll() {
  await Promise.all([
    loadGlobalStatsTrend(),
    loadOnboardingFunnel(),
    loadCapacity(),
  ])
}

watch(
  [() => adminStore.activeDateRange, () => adminStore.refreshTrigger],
  () => {
    if (mainStore.isAdmin)
      void loadAll()
  },
  { deep: true },
)

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access admin dashboard pulse')
    router.push('/dashboard')
    return
  }

  isLoading.value = true
  await loadAll()
  isLoading.value = false

  displayStore.NavTitle = t('admin-pulse')
})

displayStore.NavTitle = t('admin-pulse')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div>
    <div class="h-full pb-4 overflow-hidden">
      <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
        <AdminFilterBar />

        <PageLoader v-if="isLoading" />

        <div v-else class="space-y-6">
          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-2 text-lg font-semibold">
              {{ t('admin-pulse') }}
            </h3>
            <p class="text-sm text-slate-600 dark:text-slate-400">
              {{ t('admin-pulse-description') }}
            </p>
          </div>

          <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatsCard
              :title="t('admin-pulse-new-registrations')"
              :value="latestGlobalStats?.registers_today ?? 0"
              color-class="text-[#119eff]"
              :subtitle="activationRate === null
                ? t('admin-pulse-activation-unavailable')
                : t('admin-pulse-activation-rate-subtitle', { rate: formatOneDecimal(activationRate) })"
              :is-loading="kpiCardsLoading"
              clickable
              @click="goTo('/admin/dashboard/onboarding')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-trials')"
              :value="latestGlobalStats?.trial ?? 0"
              color-class="text-amber-500"
              :subtitle="t('admin-pulse-trials-subtitle')"
              :is-loading="isLoadingStats"
              clickable
              @click="goTo('/admin/dashboard/retention')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-paying-orgs')"
              :value="payingOrgs"
              color-class="text-emerald-500"
              :subtitle="latestGlobalStats
                ? t('admin-pulse-mrr-subtitle', { mrr: formatNumberValue(latestGlobalStats.mrr || 0, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) })
                : t('admin-pulse-mrr-unavailable')"
              :is-loading="isLoadingStats"
              clickable
              @click="goTo('/admin/dashboard/revenue')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-update-success')"
              :value="latestGlobalStats
                ? `${formatOneDecimal(latestGlobalStats.success_rate || 0)}%`
                : '—'"
              color-class="text-purple-500"
              :subtitle="t('admin-pulse-update-success-subtitle')"
              :is-loading="isLoadingStats"
              clickable
              @click="goTo('/admin/dashboard/product/updates')"
            />
          </div>

          <div
            v-if="capacityLive"
            class="grid grid-cols-2 gap-4 md:grid-cols-4"
          >
            <AdminStatsCard
              :title="t('admin-pulse-builders-free')"
              :value="capacityLive.builder_reachable ? capacityLive.free : '—'"
              color-class="text-emerald-500"
              :subtitle="capacityLive.builder_reachable
                ? t('admin-pulse-builders-online', { count: formatNumberValue(capacityLive.workers_online) })
                : t('admin-pulse-builder-unreachable')"
              :is-loading="isLoadingCapacity"
              clickable
              @click="goTo('/admin/dashboard/platform/capacity')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-builders-used')"
              :value="capacityLive.builder_reachable ? capacityLive.used : '—'"
              color-class="text-red-500"
              :subtitle="t('admin-pulse-builders-used-subtitle')"
              :is-loading="isLoadingCapacity"
              clickable
              @click="goTo('/admin/dashboard/platform/capacity')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-builders-waiting')"
              :value="capacityLive.builder_reachable ? capacityLive.waiting : '—'"
              color-class="text-amber-500"
              :subtitle="t('admin-pulse-builders-waiting-subtitle')"
              :is-loading="isLoadingCapacity"
              clickable
              @click="goTo('/admin/dashboard/platform/capacity')"
            />
            <AdminStatsCard
              :title="t('admin-pulse-builders-offline')"
              :value="capacityLive.builder_reachable ? capacityLive.offline : '—'"
              color-class="text-slate-500"
              :subtitle="t('admin-pulse-builders-offline-subtitle')"
              :is-loading="isLoadingCapacity"
              clickable
              @click="goTo('/admin/dashboard/platform/capacity')"
            />
          </div>

          <div class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h3 class="mb-4 text-lg font-semibold">
              {{ t('admin-pulse-attention') }}
            </h3>
            <p class="mb-4 text-sm text-slate-600 dark:text-slate-400">
              {{ t('admin-pulse-attention-description') }}
            </p>

            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <AdminStatsCard
                :title="t('admin-onboarding-stuck-app-no-channel')"
                :value="stuckAppNoChannel"
                color-class="text-amber-500"
                :subtitle="t('admin-onboarding-stuck-app-no-channel-description')"
                :is-loading="isLoadingFunnel"
                clickable
                @click="goTo('/admin/dashboard/onboarding/cohorts')"
              />
              <AdminStatsCard
                :title="t('admin-pulse-trials')"
                :value="latestGlobalStats?.trial ?? 0"
                color-class="text-orange-500"
                :subtitle="t('admin-pulse-attention-trials-subtitle')"
                :is-loading="isLoadingStats"
                clickable
                @click="goTo('/admin/dashboard/retention')"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

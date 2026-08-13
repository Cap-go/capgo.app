<route lang="yaml">
meta:
  layout: admin
</route>

<script setup lang="ts">
import type { AdminOnboardingJourneyGraphConfig, AdminOnboardingJourneyNode } from '~/components/admin/adminOnboardingJourneyGraph'
import type { FrontendOnboardingAnalytics } from '~/services/adminFrontendOnboarding'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import AdminFilterBar from '~/components/admin/AdminFilterBar.vue'
import AdminFunnelChart from '~/components/admin/AdminFunnelChart.vue'
import AdminOnboardingJourneyGraph from '~/components/admin/AdminOnboardingJourneyGraph.vue'
import AdminStackedBarChart from '~/components/admin/AdminStackedBarChart.vue'
import AdminStatsCard from '~/components/admin/AdminStatsCard.vue'
import ChartCard from '~/components/dashboard/ChartCard.vue'
import PageLoader from '~/components/PageLoader.vue'
import {
  buildFrontendOnboardingDailySeries,
  buildFrontendOnboardingFunnelStages,
  buildFrontendOnboardingFunnelSummaries,
  buildFrontendOnboardingGraphMetrics,
  createFrontendOnboardingAnalyticsLoader,
  formatFrontendOnboardingDuration,
} from '~/services/adminFrontendOnboarding'
import { formatNumberValue } from '~/services/formatLocale'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'

const { t } = useI18n()
const router = useRouter()
const adminStore = useAdminDashboardStore()
const displayStore = useDisplayStore()
const mainStore = useMainStore()
const isLoading = ref(true)
const isLoadingStats = ref(false)
const isReady = ref(false)
const analytics = ref<FrontendOnboardingAnalytics | null>(null)
const loadError = ref(false)

const v2GraphDefinitions = [
  { key: 'onboarding_app_name_entered' },
  { key: 'onboarding_app_id_entered' },
  { key: 'onboarding_app_id_help_opened' },
  { key: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_hidden', parentKey: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_url_entered', parentKey: 'onboarding_store_import_shown' },
  { key: 'onboarding_store_import_submitted', parentKey: 'onboarding_store_url_entered' },
  { key: 'onboarding_store_import_succeeded', parentKey: 'onboarding_store_import_submitted' },
  { key: 'onboarding_store_import_failed', parentKey: 'onboarding_store_import_submitted' },
  { key: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picker_open_failed', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picker_closed_without_selection', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_picked', parentKey: 'onboarding_app_icon_picker_opened' },
  { key: 'onboarding_app_icon_uploaded', parentKey: 'onboarding_app_icon_picked' },
  { key: 'onboarding_app_icon_upload_failed', parentKey: 'onboarding_app_icon_picked' },
] as const

const v2GraphEventNodes = [
  { id: 'app_name', eventKey: 'onboarding_app_name_entered', labelKey: 'frontend-onboarding-graph-app-name-entered', x: 820, y: 90, icon: 'app' },
  { id: 'app_id', eventKey: 'onboarding_app_id_entered', labelKey: 'frontend-onboarding-graph-app-id-entered', x: 820, y: 195, icon: 'file' },
  { id: 'learn_more', eventKey: 'onboarding_app_id_help_opened', labelKey: 'frontend-onboarding-graph-app-id-help-opened', x: 820, y: 300, icon: 'details' },
  { id: 'store_opened', eventKey: 'onboarding_store_import_shown', labelKey: 'frontend-onboarding-graph-store-import-opened', x: 820, y: 455, icon: 'import' },
  { id: 'import_closed', eventKey: 'onboarding_store_import_hidden', labelKey: 'frontend-onboarding-graph-import-closed', x: 1180, y: 405, icon: 'close', tone: 'muted' },
  { id: 'store_url', eventKey: 'onboarding_store_url_entered', labelKey: 'frontend-onboarding-graph-store-url-entered', x: 1180, y: 505, icon: 'link' },
  { id: 'import_clicked', eventKey: 'onboarding_store_import_submitted', labelKey: 'frontend-onboarding-graph-import-clicked', x: 1540, y: 505, icon: 'import' },
  { id: 'import_succeeded', eventKey: 'onboarding_store_import_succeeded', labelKey: 'frontend-onboarding-graph-import-succeeded', x: 1880, y: 455, icon: 'success', tone: 'success' },
  { id: 'import_failed', eventKey: 'onboarding_store_import_failed', labelKey: 'frontend-onboarding-graph-import-failed', x: 1880, y: 555, icon: 'failure', tone: 'danger' },
  { id: 'picker_opened', eventKey: 'onboarding_app_icon_picker_opened', labelKey: 'frontend-onboarding-graph-file-picker-opened', x: 820, y: 720, icon: 'file' },
  { id: 'picker_failed', eventKey: 'onboarding_app_icon_picker_open_failed', labelKey: 'frontend-onboarding-graph-file-picker-failed', x: 1180, y: 620, icon: 'failure', tone: 'danger' },
  { id: 'picker_closed', eventKey: 'onboarding_app_icon_picker_closed_without_selection', labelKey: 'frontend-onboarding-graph-closed-without-selection', x: 1180, y: 720, icon: 'close', tone: 'muted' },
  { id: 'icon_picked', eventKey: 'onboarding_app_icon_picked', labelKey: 'frontend-onboarding-graph-app-icon-picked', x: 1180, y: 820, icon: 'icon' },
  { id: 'icon_uploaded', eventKey: 'onboarding_app_icon_uploaded', labelKey: 'frontend-onboarding-graph-app-icon-uploaded', x: 1540, y: 770, icon: 'upload', tone: 'success' },
  { id: 'icon_upload_failed', eventKey: 'onboarding_app_icon_upload_failed', labelKey: 'frontend-onboarding-graph-icon-upload-failed', x: 1540, y: 870, icon: 'upload', tone: 'danger' },
] as const

const loadAnalytics = createFrontendOnboardingAnalyticsLoader(
  async () => await adminStore.fetchStats('frontend_onboarding_analytics') || null,
  {
    onAnalytics: (value) => {
      analytics.value = value
      loadError.value = false
    },
    onError: (error) => {
      loadError.value = true
      console.error('[Admin Frontend Onboarding] Error loading analytics:', error)
    },
    onLoading: (value) => {
      isLoadingStats.value = value
      if (value)
        loadError.value = false
      if (!value)
        isLoading.value = false
    },
  },
)

const visibleAnalytics = computed(() => isLoadingStats.value ? null : analytics.value)
const kpis = computed(() => visibleAnalytics.value?.kpis)
const dailySeries = computed(() => buildFrontendOnboardingDailySeries(
  visibleAnalytics.value?.daily_attempts ?? [],
  t('frontend-onboarding-version-1'),
  t('frontend-onboarding-version-2'),
))
const v1FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(visibleAnalytics.value?.funnels.v1 ?? []))
const v2FunnelStages = computed(() => buildFrontendOnboardingFunnelStages(visibleAnalytics.value?.funnels.v2 ?? []))
const v1FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(visibleAnalytics.value?.funnels.v1 ?? []))
const v2FunnelSummaries = computed(() => buildFrontendOnboardingFunnelSummaries(visibleAnalytics.value?.funnels.v2 ?? []))
const hasDailyAttempts = computed(() => (visibleAnalytics.value?.daily_attempts ?? [])
  .some(day => day.v1_attempts > 0 || day.v2_attempts > 0))

const onboardingGraphV2 = computed<AdminOnboardingJourneyGraphConfig>(() => {
  const funnel = visibleAnalytics.value?.funnels.v2 ?? []
  const stage = (key: FrontendOnboardingAnalytics['funnels']['v2'][number]['key']) => funnel.find(item => item.key === key)
  const intent = stage('intent')
  const details = stage('details')
  const organization = stage('organization')
  const setup = stage('setup')
  const parentPercent = (current: number, previous: number) => previous > 0 ? current / previous * 100 : 0
  const graphMetrics = buildFrontendOnboardingGraphMetrics(
    v2GraphDefinitions,
    visibleAnalytics.value?.v2_graph.nodes ?? [],
    details?.reached,
  )
  const eventNodes: AdminOnboardingJourneyNode[] = v2GraphEventNodes.map((node) => {
    const metric = graphMetrics[node.eventKey]
    return {
      id: node.id,
      label: t(node.labelKey),
      count: metric?.count ?? 0,
      levelPercent: metric?.levelPercent ?? 0,
      previousPercent: metric?.previousPercent,
      levelLabel: t('frontend-onboarding-graph-stage-app-details'),
      x: node.x,
      y: node.y,
      kind: 'event',
      icon: node.icon,
      ...('tone' in node ? { tone: node.tone } : {}),
    }
  })

  return {
    width: 3100,
    height: 1100,
    levels: [
      { label: '1', start: 0, end: 300, divider: 300 },
      { label: '2', start: 300, end: 2200, divider: 2200 },
      { label: '3', start: 2200, end: 2650, divider: 2650 },
      { label: '4', start: 2650, end: 3100 },
    ],
    nodes: [
      { id: 'intent', label: t('frontend-onboarding-graph-stage-intent'), count: intent?.reached ?? 0, totalPercent: intent?.of_start_percent ?? 0, x: 145, y: 540, kind: 'stage', icon: 'intent' },
      {
        id: 'details',
        label: t('frontend-onboarding-graph-stage-app-details'),
        count: details?.reached ?? 0,
        totalPercent: details?.of_start_percent ?? 0,
        parentPercent: parentPercent(details?.reached ?? 0, intent?.reached ?? 0),
        x: 455,
        y: 540,
        kind: 'stage',
        icon: 'details',
      },
      ...eventNodes,
      {
        id: 'organization',
        label: t('frontend-onboarding-graph-stage-organization-details'),
        count: organization?.reached ?? 0,
        totalPercent: organization?.of_start_percent ?? 0,
        parentPercent: parentPercent(organization?.reached ?? 0, details?.reached ?? 0),
        x: 2400,
        y: 540,
        kind: 'stage',
        icon: 'organization',
        width: 280,
      },
      {
        id: 'setup',
        label: t('frontend-onboarding-graph-stage-setup-reached'),
        count: setup?.reached ?? 0,
        totalPercent: setup?.of_start_percent ?? 0,
        parentPercent: parentPercent(setup?.reached ?? 0, organization?.reached ?? 0),
        x: 2870,
        y: 540,
        kind: 'stage',
        icon: 'setup',
        width: 250,
      },
    ],
    edges: [
      { from: 'intent', to: 'details', style: 'primary' },
      { from: 'details', to: 'app_name', style: 'branch' },
      { from: 'details', to: 'app_id', style: 'branch' },
      { from: 'details', to: 'learn_more', style: 'branch' },
      { from: 'details', to: 'store_opened', style: 'branch' },
      { from: 'store_opened', to: 'import_closed', style: 'branch' },
      { from: 'store_opened', to: 'store_url', style: 'branch' },
      { from: 'store_url', to: 'import_clicked', style: 'branch' },
      { from: 'import_clicked', to: 'import_succeeded', style: 'branch' },
      { from: 'import_clicked', to: 'import_failed', style: 'branch' },
      { from: 'details', to: 'picker_opened', style: 'branch' },
      { from: 'picker_opened', to: 'picker_failed', style: 'branch' },
      { from: 'picker_opened', to: 'picker_closed', style: 'branch' },
      { from: 'picker_opened', to: 'icon_picked', style: 'branch' },
      { from: 'icon_picked', to: 'icon_uploaded', style: 'branch' },
      { from: 'icon_picked', to: 'icon_upload_failed', style: 'branch' },
      { from: 'app_name', toPoint: { x: 2130, y: 90 }, style: 'dotted' },
      { from: 'app_id', toPoint: { x: 2130, y: 195 }, style: 'dotted' },
      { from: 'learn_more', toPoint: { x: 2130, y: 300 }, style: 'dotted' },
      { from: 'import_closed', toPoint: { x: 2130, y: 405 }, style: 'dotted' },
      { from: 'import_succeeded', toPoint: { x: 2130, y: 455 }, style: 'dotted' },
      { from: 'import_failed', toPoint: { x: 2130, y: 555 }, style: 'dotted' },
      { from: 'picker_failed', toPoint: { x: 2130, y: 620 }, style: 'dotted' },
      { from: 'picker_closed', toPoint: { x: 2130, y: 720 }, style: 'dotted' },
      { from: 'icon_uploaded', toPoint: { x: 2130, y: 770 }, style: 'dotted' },
      { from: 'icon_upload_failed', toPoint: { x: 2130, y: 870 }, style: 'dotted' },
      { fromPoint: { x: 2130, y: 90 }, toPoint: { x: 2130, y: 870 }, style: 'dotted', arrow: false },
      { fromPoint: { x: 2130, y: 540 }, to: 'organization', style: 'primary' },
      { from: 'organization', to: 'setup', style: 'primary' },
    ],
    formatters: {
      levelPercent: (percent, level) => t('frontend-onboarding-graph-percent-of-level', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
        level,
      }),
      totalPercent: percent => t('frontend-onboarding-graph-percent-of-total', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
      }),
      previousPercent: percent => t('frontend-onboarding-graph-percent-of-previous', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
      }),
      parentPercent: percent => t('frontend-onboarding-graph-percent-of-parent-stage', {
        percent: formatNumberValue(percent, { maximumFractionDigits: 1 }),
      }),
    },
  }
})
const attemptsValue = computed(() => formatNumberValue(kpis.value?.attempts ?? 0))
const completionValue = computed(() => `${formatNumberValue(kpis.value?.completion_rate ?? 0, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})}%`)
const completionSubtitle = computed(() => t('frontend-onboarding-completed-subtitle', {
  count: formatNumberValue(kpis.value?.completed ?? 0),
}))
const largestDropoffValue = computed(() => kpis.value?.largest_dropoff
  ? `${formatNumberValue(kpis.value.largest_dropoff.percentage, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`
  : '—')
const largestDropoffSubtitle = computed(() => {
  const dropoff = kpis.value?.largest_dropoff
  if (!dropoff)
    return t('frontend-onboarding-no-dropoff')

  const stages = visibleAnalytics.value?.funnels.v2 ?? []
  const from = stages.find(stage => stage.key === dropoff.from)?.label ?? dropoff.from
  const to = stages.find(stage => stage.key === dropoff.to)?.label ?? dropoff.to
  return t('frontend-onboarding-transition', { from, to })
})

watch(() => adminStore.activeDateRange, () => {
  if (!isReady.value)
    return
  void loadAnalytics()
}, { deep: true })

onMounted(async () => {
  if (!mainStore.isAdmin) {
    console.error('Non-admin user attempted to access frontend onboarding analytics')
    await router.push('/dashboard')
    return
  }

  isReady.value = true
  void loadAnalytics()
  displayStore.NavTitle = t('frontend-onboarding')
})

displayStore.NavTitle = t('frontend-onboarding')
displayStore.defaultBack = '/dashboard'
</script>

<template>
  <div class="h-full pb-4 overflow-hidden">
    <div class="w-full h-full px-4 pt-2 mx-auto mb-8 overflow-y-auto sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <AdminFilterBar />

      <PageLoader v-if="isLoading" />

      <div v-else class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">
            {{ t('frontend-onboarding') }}
          </h1>
          <span class="px-3 py-1 text-xs font-semibold text-indigo-700 bg-indigo-100 rounded-full dark:bg-indigo-500/20 dark:text-indigo-200">
            {{ t('frontend-onboarding-version-2') }}
          </span>
        </div>

        <div v-if="loadError" role="alert" class="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {{ t('frontend-onboarding-load-error') }}
        </div>

        <template v-else>
          <div class="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
            <AdminStatsCard
              :title="t('frontend-onboarding-attempts')"
              :value="attemptsValue"
              :subtitle="t('frontend-onboarding-attempts-subtitle')"
              color-class="text-indigo-500"
              :is-loading="isLoadingStats"
            />
            <AdminStatsCard
              :title="t('frontend-onboarding-completed')"
              :value="completionValue"
              :subtitle="completionSubtitle"
              color-class="text-emerald-500"
              :is-loading="isLoadingStats"
            />
            <AdminStatsCard
              :title="t('frontend-onboarding-median-time')"
              :value="formatFrontendOnboardingDuration(kpis?.median_completion_ms ?? null)"
              :subtitle="t('frontend-onboarding-median-time-subtitle')"
              color-class="text-amber-500"
              :is-loading="isLoadingStats"
            />
            <AdminStatsCard
              :title="t('frontend-onboarding-largest-dropoff')"
              :value="largestDropoffValue"
              :subtitle="largestDropoffSubtitle"
              color-class="text-rose-500"
              :is-loading="isLoadingStats"
            />
          </div>

          <ChartCard
            :title="t('frontend-onboarding-daily-attempts')"
            :is-loading="isLoadingStats"
            :has-data="hasDailyAttempts"
          >
            <AdminStackedBarChart :series="dailySeries" :is-loading="isLoadingStats" />
          </ChartCard>

          <section class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ t('frontend-onboarding-funnel-v2') }}
            </h2>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {{ t('frontend-onboarding-funnel-description') }}
            </p>
            <div class="mt-6 h-72 sm:h-80">
              <AdminFunnelChart :stages="v2FunnelStages" :is-loading="isLoadingStats" />
            </div>
            <div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-4 dark:border-slate-700">
              <div v-for="summary in v2FunnelSummaries" :key="summary.key" class="text-center">
                <p class="text-xl font-bold text-slate-900 tabular-nums dark:text-white">
                  {{ formatNumberValue(summary.conversion_percent) }}%
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ summary.from_label ? t('frontend-onboarding-transition', { from: summary.from_label, to: summary.to_label }) : summary.to_label }} · {{ formatNumberValue(summary.reached) }}
                </p>
              </div>
            </div>
          </section>

          <section class="overflow-hidden rounded-[1.75rem] border border-slate-200/80 bg-white/95 p-5 shadow-[0_20px_60px_-38px_rgba(15,23,42,0.3)] dark:border-slate-700/70 dark:bg-slate-900/85 sm:p-6">
            <div>
              <h2 class="text-xl font-semibold leading-tight text-slate-900 dark:text-white sm:text-2xl">
                {{ t('frontend-onboarding-graph-v2') }}
              </h2>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {{ t('frontend-onboarding-graph-v2-description') }}
              </p>
            </div>
            <div class="mt-5">
              <AdminOnboardingJourneyGraph :config="onboardingGraphV2" />
            </div>
          </section>

          <section class="p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900">
            <h2 class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ t('frontend-onboarding-funnel-v1-legacy') }}
            </h2>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {{ t('frontend-onboarding-funnel-description') }}
            </p>
            <div class="mt-6 h-72 sm:h-80">
              <AdminFunnelChart :stages="v1FunnelStages" :is-loading="isLoadingStats" />
            </div>
            <div class="grid grid-cols-2 gap-4 pt-5 mt-5 border-t border-slate-200 md:grid-cols-4 dark:border-slate-700">
              <div v-for="summary in v1FunnelSummaries" :key="summary.key" class="text-center">
                <p class="text-xl font-bold text-slate-900 tabular-nums dark:text-white">
                  {{ formatNumberValue(summary.conversion_percent) }}%
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {{ summary.from_label ? t('frontend-onboarding-transition', { from: summary.from_label, to: summary.to_label }) : summary.to_label }} · {{ formatNumberValue(summary.reached) }}
                </p>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

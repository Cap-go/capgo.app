<script setup lang="ts">
import type { AppBuildSummary, BuildSummaryRow, BuildTotals } from '~/services/buildCharts'
import type { Database } from '~/types/database.types'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconHammer from '~icons/lucide/hammer'
import BuildChartControls from '~/components/dashboard/BuildChartControls.vue'
import BuildStatsCard from '~/components/dashboard/BuildStatsCard.vue'
import BuildTimeCard from '~/components/dashboard/BuildTimeCard.vue'
import Spinner from '~/components/Spinner.vue'
import { fetchAllRows, formatBuildDuration, getBuildChartWindow, summarizeBuilds } from '~/services/buildCharts'
import { useConsole } from '~/services/console'
import { formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useOrganizationStore } from '~/stores/organization'

type AppRow = Database['public']['Tables']['apps']['Row']

const props = withDefaults(defineProps<{
  orgId?: string
  apps?: AppRow[]
}>(), {
  orgId: '',
  apps: () => [],
})

const { t } = useI18n()
const capgo = useConsole()
const organizationStore = useOrganizationStore()

const useBillingPeriod = ref(false)
const showCumulative = ref(false)
const reloadTrigger = ref(0)
const accumulated = computed(() => useBillingPeriod.value && showCumulative.value)

const statsLoading = ref(false)
const timeLoading = ref(false)
const summaryLoading = ref(false)
const chartsRefreshing = computed(() => statsLoading.value || timeLoading.value || summaryLoading.value)

function emptyTotals(): BuildTotals {
  return { total: 0, succeeded: 0, failed: 0, inProgress: 0, successRate: null, avgDurationSeconds: null, avgWaitSeconds: null }
}

const totals = ref<BuildTotals>(emptyTotals())
const appSummaries = ref<AppBuildSummary[]>([])
const summaryError = ref(false)
let latestRequest = 0

const appNames = computed(() => new Map(props.apps.map(app => [app.app_id, app.name || app.app_id])))

function formatCount(value: number | null | undefined) {
  return formatNumberValue(value ?? 0)
}

function formatRate(value: number | null) {
  if (value == null)
    return '-'
  return `${formatNumberValue(value, { maximumFractionDigits: 1 })}%`
}

async function fetchSummary() {
  const requestId = ++latestRequest
  if (!props.orgId) {
    totals.value = emptyTotals()
    appSummaries.value = []
    summaryLoading.value = false
    return
  }

  summaryLoading.value = true
  summaryError.value = false
  try {
    const org = organizationStore.organizations.find(item => item.gid === props.orgId) ?? organizationStore.currentOrganization
    const window = getBuildChartWindow(useBillingPeriod.value, org?.subscription_start)
    const rows = await fetchAllRows<BuildSummaryRow>((from, to) => capgo
      .from('build_requests')
      .select('app_id, status, created_at, started_at, completed_at, runner_wait_seconds')
      .eq('owner_org', props.orgId)
      .gte('created_at', window.startISO)
      .lte('created_at', window.endISO)
      .order('created_at')
      .range(from, to))
    if (requestId !== latestRequest)
      return
    const summary = summarizeBuilds(rows)
    totals.value = summary.totals
    appSummaries.value = summary.apps
  }
  catch (error) {
    if (requestId !== latestRequest)
      return
    console.error('Error fetching org native build summary:', error)
    summaryError.value = true
    totals.value = emptyTotals()
    appSummaries.value = []
  }
  finally {
    if (requestId === latestRequest)
      summaryLoading.value = false
  }
}

watch(
  () => [props.orgId, useBillingPeriod.value, reloadTrigger.value] as const,
  fetchSummary,
  { immediate: true },
)

const kpis = computed(() => [
  {
    key: 'total',
    label: t('native-build-stats-total'),
    value: formatCount(totals.value.total),
    hint: t('native-build-stats-total-hint', { succeeded: formatCount(totals.value.succeeded), failed: formatCount(totals.value.failed) }),
  },
  {
    key: 'success-rate',
    label: t('native-build-stats-success-rate'),
    value: formatRate(totals.value.successRate),
    hint: totals.value.inProgress > 0 ? t('native-build-stats-in-progress', { count: formatCount(totals.value.inProgress) }) : '',
  },
  {
    key: 'avg-duration',
    label: t('native-build-stats-avg-duration'),
    value: formatBuildDuration(totals.value.avgDurationSeconds),
    hint: '',
  },
  {
    key: 'avg-wait',
    label: t('native-build-stats-avg-wait'),
    value: formatBuildDuration(totals.value.avgWaitSeconds),
    hint: '',
  },
])
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="org-native-build-stats">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
          {{ t('native-build-stats-title') }}
        </h2>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('native-build-stats-help') }}
        </p>
      </div>
      <BuildChartControls
        v-model:use-billing-period="useBillingPeriod"
        v-model:show-cumulative="showCumulative"
        :is-refreshing="chartsRefreshing"
        @reload="reloadTrigger++"
      />
    </div>

    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <div
        v-for="kpi in kpis"
        :key="kpi.key"
        class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10"
        :data-testid="`native-build-kpi-${kpi.key}`"
      >
        <div class="text-sm truncate text-slate-600 dark:text-slate-400">
          {{ kpi.label }}
        </div>
        <div class="mt-2 text-2xl font-semibold tabular-nums text-slate-950 dark:text-white">
          <Spinner v-if="summaryLoading && totals.total === 0" size="w-6 h-6" />
          <template v-else>
            {{ kpi.value }}
          </template>
        </div>
        <div v-if="kpi.hint" class="mt-1 text-xs truncate text-slate-500 dark:text-slate-400">
          {{ kpi.hint }}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
      <BuildStatsCard
        :org-id="orgId"
        :use-billing-period="useBillingPeriod"
        :accumulated="accumulated"
        :reload-trigger="reloadTrigger"
        @update:loading="statsLoading = $event"
      />
      <BuildTimeCard
        :org-id="orgId"
        :use-billing-period="useBillingPeriod"
        :accumulated="accumulated"
        :reload-trigger="reloadTrigger"
        @update:loading="timeLoading = $event"
      />
    </div>

    <div class="bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
      <div class="flex items-center justify-between gap-3 p-4">
        <div>
          <h3 class="text-base font-semibold text-slate-950 dark:text-white">
            {{ t('native-build-stats-by-app') }}
          </h3>
          <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {{ t('native-build-stats-by-app-help') }}
          </p>
        </div>
        <IconHammer class="w-5 h-5 text-sky-500" aria-hidden="true" />
      </div>

      <div v-if="summaryLoading && appSummaries.length === 0" class="flex items-center justify-center h-40">
        <Spinner size="w-8 h-8" />
      </div>
      <div
        v-else-if="summaryError"
        class="flex flex-col items-center justify-center h-40 gap-3 text-slate-500 dark:text-slate-400"
      >
        <p>{{ t('native-build-stats-load-error') }}</p>
        <button type="button" class="d-btn d-btn-sm d-btn-primary" @click="reloadTrigger++">
          {{ t('refresh') }}
        </button>
      </div>
      <div
        v-else-if="appSummaries.length === 0"
        class="flex flex-col items-center justify-center h-40 px-4 text-center text-slate-500 dark:text-slate-400"
      >
        <IconHammer class="w-10 h-10 mb-3" aria-hidden="true" />
        <h4 class="text-base font-semibold text-slate-800 dark:text-slate-100">
          {{ t('no-builds-yet') }}
        </h4>
        <p class="mt-1 text-sm max-w-lg">
          {{ t('native-build-stats-empty-help') }}
        </p>
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm text-left">
          <thead class="text-xs uppercase border-t border-b text-slate-500 bg-slate-50 dark:bg-slate-900/40 dark:text-slate-400 border-slate-200 dark:border-white/10">
            <tr>
              <th scope="col" class="px-4 py-3 font-medium">
                {{ t('app-name') }}
              </th>
              <th scope="col" class="px-4 py-3 font-medium text-right">
                {{ t('builds') }}
              </th>
              <th scope="col" class="px-4 py-3 font-medium text-right">
                {{ t('native-build-stats-success-rate') }}
              </th>
              <th scope="col" class="px-4 py-3 font-medium text-right">
                {{ t('failed') }}
              </th>
              <th scope="col" class="px-4 py-3 font-medium text-right">
                {{ t('native-build-stats-avg-duration') }}
              </th>
              <th scope="col" class="px-4 py-3 font-medium text-right">
                {{ t('last-build') }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 dark:divide-white/10">
            <tr v-for="app in appSummaries" :key="app.appId" class="hover:bg-slate-50 dark:hover:bg-slate-900/30">
              <td class="px-4 py-3">
                <router-link :to="`/app/${encodeURIComponent(app.appId)}/builds`" class="font-medium text-slate-900 hover:underline dark:text-white">
                  {{ appNames.get(app.appId) ?? app.appId }}
                </router-link>
                <div class="text-xs truncate text-slate-500 dark:text-slate-400">
                  {{ app.appId }}
                </div>
              </td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-white">
                {{ formatCount(app.total) }}
              </td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-white">
                {{ formatRate(app.successRate) }}
              </td>
              <td class="px-4 py-3 text-right tabular-nums" :class="app.failed > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-white'">
                {{ formatCount(app.failed) }}
              </td>
              <td class="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-white">
                {{ formatBuildDuration(app.avgDurationSeconds) }}
              </td>
              <td class="px-4 py-3 text-right whitespace-nowrap text-slate-600 dark:text-slate-300">
                {{ app.lastBuildAt ? formatLocalDateTime(app.lastBuildAt) : '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

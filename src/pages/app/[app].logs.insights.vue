<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconActivity from '~icons/lucide/activity'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconBug from '~icons/lucide/bug'
import IconExternalLink from '~icons/lucide/external-link'
import IconLayers from '~icons/lucide/layers'
import IconSmartphone from '~icons/lucide/smartphone'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import { formatLocalDateShort, formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { actionToFilter } from '~/services/statsActions'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

type PeriodDayOption = 1 | 3 | 7 | 30

interface LogInsightSummary {
  total: number
  device_count: number
  action_count: number
}

interface LogInsightAction {
  action: string
  total: number
  device_count: number
  version_count: number
  first_seen: string | null
  last_seen: string | null
  latest_version_name: string
  latest_device_id: string
}

interface LogInsightDaily {
  date: string
  action: string
  total: number
}

interface LogInsightVersion {
  action: string
  version_name: string
  total: number
  device_count: number
  last_seen: string | null
}

interface LogInsightDevice {
  action: string
  device_id: string
  total: number
  version_name: string
  last_seen: string | null
}

interface LogInsightsResponse {
  summary: LogInsightSummary
  actions: LogInsightAction[]
  daily: LogInsightDaily[]
  versions: LogInsightVersion[]
  devices: LogInsightDevice[]
  period: {
    requested_days: PeriodDayOption
    start: string
    end: string
    labels: string[]
  }
}

const { t } = useI18n()
const route = useRoute('/app/[app].logs.insights')
const router = useRouter()
const supabase = useSupabase()
const displayStore = useDisplayStore()

const id = ref('')
const lastPath = ref('')
const isLoading = ref(false)
const insightsLoading = ref(false)
const selectedDays = ref<PeriodDayOption>(7)
const app = ref<Database['public']['Tables']['apps']['Row']>()
const insights = ref<LogInsightsResponse | null>(null)
let latestInsightsRequest = 0

const appRouteSegment = computed(() => {
  const match = route.path.match(/^\/app\/([^/]+)/)
  return match ? match[1] : encodeURIComponent(id.value)
})
const totalErrors = computed(() => insights.value?.summary.total ?? 0)
const topAction = computed(() => insights.value?.actions[0] ?? null)
const topActionShare = computed(() => {
  if (!topAction.value || totalErrors.value <= 0)
    return 0
  return (topAction.value.total / totalErrors.value) * 100
})
const selectedPeriodLabel = computed(() => selectedDays.value === 1 ? t('last-one-day') : t('last-n-days', { days: selectedDays.value }))
const periodRangeLabel = computed(() => {
  const labels = insights.value?.period.labels ?? []
  const firstDay = labels[0]
  const lastDay = labels[labels.length - 1]
  if (!(firstDay && lastDay))
    return '-'
  return `${formatLocalDateShort(firstDay)} - ${formatLocalDateShort(lastDay)}`
})
const topPriorityMessage = computed(() => {
  if (!topAction.value)
    return t('top-priority-empty')
  return t('top-priority-help', {
    action: formatAction(topAction.value.action),
    count: formatCount(topAction.value.total),
    share: formatPercent(topActionShare.value),
  })
})
const dailyTotals = computed(() => {
  const labels = insights.value?.period.labels ?? []
  const dailyByDate = new Map<string, { date: string, total: number, topAction: string, topActionTotal: number }>()
  labels.forEach((date) => {
    dailyByDate.set(date, { date, total: 0, topAction: '', topActionTotal: 0 })
  })
  insights.value?.daily.forEach((row) => {
    const entry = dailyByDate.get(row.date) ?? { date: row.date, total: 0, topAction: '', topActionTotal: 0 }
    entry.total += row.total
    if (row.total > entry.topActionTotal) {
      entry.topAction = row.action
      entry.topActionTotal = row.total
    }
    dailyByDate.set(row.date, entry)
  })
  return [...dailyByDate.values()]
})
const maxDailyTotal = computed(() => Math.max(1, ...dailyTotals.value.map(day => day.total)))

function formatAction(action: string) {
  const filterKey = actionToFilter[action]
  return filterKey ? t(filterKey) : action
}

function formatCount(value: number | null | undefined) {
  return formatNumberValue(Math.round(value ?? 0))
}

function formatPercent(value: number | null | undefined) {
  return `${formatNumberValue(value ?? 0, { maximumFractionDigits: 1 })}%`
}

function formatLastSeen(value: string | null | undefined) {
  return value ? formatLocalDateTime(value) : '-'
}

async function loadAppInfo() {
  try {
    const { data: dataApp } = await supabase
      .from('apps')
      .select()
      .eq('app_id', id.value)
      .single()
    app.value = dataApp || app.value
  }
  catch (error) {
    console.error(error)
  }
}

async function fetchInsights() {
  if (!id.value)
    return

  const requestId = ++latestInsightsRequest
  insightsLoading.value = true
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session) {
      if (requestId === latestInsightsRequest)
        toast.error(t('not-authenticated'))
      return
    }

    const response = await fetch(`${defaultApiHost}/private/stats/insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({
        appId: id.value,
        days: selectedDays.value,
      }),
    })

    if (requestId !== latestInsightsRequest)
      return

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error('Failed to fetch log insights:', errorData)
      toast.error(t('failed-to-fetch-log-insights'))
      return
    }

    insights.value = await response.json() as LogInsightsResponse
  }
  catch (error) {
    if (requestId !== latestInsightsRequest)
      return
    console.error(error)
    toast.error(t('failed-to-fetch-log-insights'))
  }
  finally {
    if (requestId === latestInsightsRequest)
      insightsLoading.value = false
  }
}

async function refreshData() {
  isLoading.value = true
  try {
    await loadAppInfo()
    await fetchInsights()
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}

async function selectPeriod(option: PeriodDayOption) {
  if (selectedDays.value === option)
    return
  selectedDays.value = option
  await fetchInsights()
}

function logQuery(action?: string) {
  const period = insights.value?.period
  return {
    ...(period ? { start: period.start, end: period.end } : {}),
    ...(action ? { action } : {}),
  }
}

function openLogs(action?: string) {
  router.push({ path: `/app/${appRouteSegment.value}/logs`, query: logQuery(action) })
}

function openDeviceLogs(device: LogInsightDevice) {
  router.push({ path: `/app/${appRouteSegment.value}/device/${device.device_id}/logs`, query: logQuery(device.action) })
}

watchEffect(async () => {
  if (route.params.app && lastPath.value !== route.path) {
    lastPath.value = route.path
    id.value = route.params.app as string
    await refreshData()
    displayStore.NavTitle = ''
    displayStore.defaultBack = '/apps'
  }
})
</script>

<template>
  <div>
    <PageLoader v-if="isLoading" />
    <div v-else-if="app" class="w-full h-full px-4 pt-0 mx-auto mb-8 sm:px-6 md:pt-8 lg:px-8 max-w-9xl max-h-fit">
      <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
              {{ t('selected-period') }}
            </h3>
            <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {{ selectedPeriodLabel }} · {{ periodRangeLabel }}
            </p>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {{ t('log-insights-period-help') }}
            </p>
          </div>
          <PeriodDaySelector :model-value="selectedDays" @update:model-value="selectPeriod" />
        </div>

        <div
          class="p-4 border rounded-lg shadow-sm"
          :class="totalErrors > 0
            ? 'bg-rose-50 border-rose-200 dark:bg-rose-950/20 dark:border-rose-800'
            : 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800'"
        >
          <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div class="flex items-start gap-3 min-w-0">
              <IconBug
                v-if="totalErrors > 0"
                class="w-6 h-6 mt-0.5 shrink-0 text-rose-600 dark:text-rose-300"
              />
              <IconActivity
                v-else
                class="w-6 h-6 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-300"
              />
              <div class="min-w-0">
                <h3 class="font-semibold" :class="totalErrors > 0 ? 'text-rose-800 dark:text-rose-100' : 'text-emerald-800 dark:text-emerald-100'">
                  {{ totalErrors > 0 ? t('top-priority') : t('no-log-insights') }}
                </h3>
                <p class="mt-1 text-sm" :class="totalErrors > 0 ? 'text-rose-700 dark:text-rose-200' : 'text-emerald-700 dark:text-emerald-200'">
                  {{ totalErrors > 0 ? topPriorityMessage : t('no-log-insights-help') }}
                </p>
              </div>
            </div>
            <button type="button" class="gap-2 d-btn d-btn-sm d-btn-outline shrink-0" @click="openLogs(topAction?.action)">
              <IconExternalLink class="w-4 h-4" />
              {{ topAction ? t('view-action-logs') : t('view-logs') }}
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <IconBug class="w-4 h-4" />
              {{ t('errors-in-period') }}
            </div>
            <div class="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
              {{ formatCount(totalErrors) }}
            </div>
          </div>
          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <IconSmartphone class="w-4 h-4" />
              {{ t('affected-devices') }}
            </div>
            <div class="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
              {{ formatCount(insights?.summary.device_count) }}
            </div>
          </div>
          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <IconLayers class="w-4 h-4" />
              {{ t('action-count') }}
            </div>
            <div class="mt-2 text-lg font-semibold text-slate-900 dark:text-white">
              {{ formatCount(insights?.summary.action_count) }}
            </div>
          </div>
          <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
            <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
              <IconActivity class="w-4 h-4" />
              {{ t('top-priority') }}
            </div>
            <div class="mt-2 text-lg font-semibold text-slate-900 dark:text-white truncate">
              {{ topAction ? formatAction(topAction.action) : '-' }}
            </div>
            <div v-if="topAction" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {{ t('error-share', { share: formatPercent(topActionShare) }) }}
            </div>
          </div>
        </div>

        <div v-if="insightsLoading" class="flex items-center justify-center h-64 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <Spinner size="w-12 h-12" />
        </div>

        <div v-else-if="!insights || totalErrors === 0" class="flex flex-col items-center justify-center h-64 bg-white border rounded-lg shadow-sm text-slate-500 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700">
          <IconActivity class="w-12 h-12 mb-2" />
          <p>{{ t('no-log-insights') }}</p>
          <p class="mt-1 text-sm">
            {{ t('no-log-insights-help') }}
          </p>
        </div>

        <template v-else>
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <section class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="mb-4">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
                  {{ t('error-categories') }}
                </h3>
              </div>
              <div class="space-y-4">
                <button
                  v-for="action in insights.actions"
                  :key="action.action"
                  type="button"
                  class="w-full text-left group"
                  @click="openLogs(action.action)"
                >
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="font-medium text-slate-800 dark:text-slate-100 truncate">{{ formatAction(action.action) }}</span>
                    <span class="text-slate-500 dark:text-slate-400 shrink-0">{{ formatCount(action.total) }}</span>
                  </div>
                  <div class="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                    <div class="h-full rounded-full bg-rose-500 transition-all group-hover:bg-rose-600" :style="`width: ${Math.max(4, (action.total / totalErrors) * 100)}%`" />
                  </div>
                  <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>{{ t('affected-devices') }}: {{ formatCount(action.device_count) }}</span>
                    <span>{{ t('version-count') }}: {{ formatCount(action.version_count) }}</span>
                    <span>{{ t('last-seen') }}: {{ formatLastSeen(action.last_seen) }}</span>
                  </div>
                </button>
              </div>
            </section>

            <section class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="mb-4">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
                  {{ t('daily-error-trend') }}
                </h3>
              </div>
              <div class="flex items-end gap-2 h-56">
                <div v-for="day in dailyTotals" :key="day.date" class="flex flex-col items-center justify-end flex-1 h-full min-w-0 gap-2">
                  <div class="flex items-end w-full h-full rounded-t bg-slate-100 dark:bg-slate-700">
                    <div class="w-full rounded-t bg-amber-500" :style="`height: ${Math.max(4, (day.total / maxDailyTotal) * 100)}%`" />
                  </div>
                  <div class="w-full text-center text-[11px] text-slate-500 dark:text-slate-400 truncate" :title="day.topAction ? formatAction(day.topAction) : ''">
                    {{ formatLocalDateShort(day.date) }}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <section class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="mb-4">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
                  {{ t('top-error-versions') }}
                </h3>
              </div>
              <div class="overflow-x-auto">
                <table class="min-w-full text-sm">
                  <thead class="text-xs uppercase text-slate-500 dark:text-slate-400">
                    <tr>
                      <th class="px-0 py-2 text-left font-medium">
                        {{ t('version') }}
                      </th>
                      <th class="px-3 py-2 text-left font-medium">
                        {{ t('action') }}
                      </th>
                      <th class="px-3 py-2 text-right font-medium">
                        {{ t('events') }}
                      </th>
                      <th class="px-0 py-2 text-right font-medium">
                        {{ t('devices') }}
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
                    <tr v-for="version in insights.versions" :key="`${version.action}-${version.version_name}`">
                      <td class="px-0 py-2 font-medium text-slate-900 dark:text-white">
                        {{ version.version_name }}
                      </td>
                      <td class="px-3 py-2 text-slate-600 dark:text-slate-300">
                        {{ formatAction(version.action) }}
                      </td>
                      <td class="px-3 py-2 text-right text-slate-600 dark:text-slate-300">
                        {{ formatCount(version.total) }}
                      </td>
                      <td class="px-0 py-2 text-right text-slate-600 dark:text-slate-300">
                        {{ formatCount(version.device_count) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
              <div class="mb-4">
                <h3 class="text-lg font-semibold text-slate-900 dark:text-white">
                  {{ t('top-error-devices') }}
                </h3>
              </div>
              <div class="space-y-3">
                <button
                  v-for="device in insights.devices"
                  :key="`${device.action}-${device.device_id}`"
                  type="button"
                  class="flex items-center justify-between w-full gap-3 p-3 text-left border rounded-md border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/40"
                  @click="openDeviceLogs(device)"
                >
                  <div class="min-w-0">
                    <div class="font-medium truncate text-slate-900 dark:text-white">
                      {{ device.device_id }}
                    </div>
                    <div class="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                      {{ formatAction(device.action) }} · {{ device.version_name }} · {{ formatLastSeen(device.last_seen) }}
                    </div>
                  </div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                    {{ formatCount(device.total) }}
                  </div>
                </button>
              </div>
            </section>
          </div>
        </template>
      </div>
    </div>
    <div v-else class="flex flex-col justify-center items-center min-h-[50vh]">
      <IconAlertCircle class="w-16 h-16 mb-4 text-destructive" />
      <h2 class="text-xl font-semibold text-foreground">
        {{ t('app-not-found') }}
      </h2>
      <p class="mt-2 text-muted-foreground">
        {{ t('app-not-found-description') }}
      </p>
      <button class="mt-4 text-white d-btn d-btn-primary" @click="$router.push(`/apps`)">
        {{ t('back-to-apps') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>

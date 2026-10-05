<script setup lang="ts">
import type { UpdaterFailureCategory } from '~/services/statsActions'
import type { Database } from '~/types/supabase.types'
import type { PeriodDayOption } from '~/utils/periodDays'
import { computed, ref, useId, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconActivity from '~icons/lucide/activity'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconAlertTriangle from '~icons/lucide/alert-triangle'
import IconDownload from '~icons/lucide/download'
import IconExternalLink from '~icons/lucide/external-link'
import IconLayers from '~icons/lucide/layers'
import IconSmartphone from '~icons/lucide/smartphone'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import InfoPopover from '~/components/InfoPopover.vue'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { formatLocalDateShort, formatLocalDateTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { actionToFilter, updaterFailureCategory, updaterFailureHelpKey, updaterInsightActions } from '~/services/statsActions'
import { defaultApiHost, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'

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
const route = useRoute('/app/[app].observe.errors')
const router = useRouter()
const supabase = useSupabase()
const displayStore = useDisplayStore()

const id = ref('')
const lastPath = ref('')
const isLoading = ref(false)
const insightsLoading = ref(false)
const { days: selectedDays } = usePeriodDaysQuery()
const selectedVersionName = ref('')
const bundleNames = ref<string[]>([])
const versionFilterId = useId()
const app = ref<Database['public']['Tables']['apps']['Row']>()
const insights = ref<LogInsightsResponse | null>(null)
let latestInsightsRequest = 0
// Lists start at the top rows so the page fits one screen; "show all" expands.
const PREVIEW_ROWS = 5
const showAllActions = ref(false)
const showAllVersions = ref(false)
const showAllDevices = ref(false)

const failureCategories: UpdaterFailureCategory[] = ['rollback', 'bundle', 'device', 'setup']
const failureBadgeClass: Record<UpdaterFailureCategory, string> = {
  rollback: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200',
  bundle: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
  device: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-white/15 dark:bg-white/5 dark:text-slate-300',
  setup: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200',
}
const failureBarClass: Record<UpdaterFailureCategory, string> = {
  rollback: 'bg-rose-400 group-hover:bg-rose-500',
  bundle: 'bg-amber-400 group-hover:bg-amber-500',
  device: 'bg-slate-400 group-hover:bg-slate-500',
  setup: 'bg-sky-400 group-hover:bg-sky-500',
}

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
const visibleActions = computed(() => {
  const actions = insights.value?.actions ?? []
  return showAllActions.value ? actions : actions.slice(0, PREVIEW_ROWS)
})
const visibleVersions = computed(() => {
  const versions = insights.value?.versions ?? []
  return showAllVersions.value ? versions : versions.slice(0, PREVIEW_ROWS)
})
const visibleDevices = computed(() => {
  const devices = insights.value?.devices ?? []
  return showAllDevices.value ? devices : devices.slice(0, PREVIEW_ROWS)
})

function formatAction(action: string) {
  const filterKey = actionToFilter[action]
  return filterKey ? t(filterKey) : action
}

function failureLabel(action: string) {
  return t(`updater-failure-${updaterFailureCategory(action)}`)
}

function failureHelp(action: string) {
  const key = updaterFailureHelpKey(action)
  return key ? t(key) : ''
}

function openNative() {
  router.push({ path: `/app/${appRouteSegment.value}/observe/native`, query: { days: String(selectedDays.value) } })
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

function ensureBundleName(name: string) {
  if (name && !bundleNames.value.includes(name))
    bundleNames.value = [name, ...bundleNames.value]
}

async function loadBundleNames() {
  if (!id.value)
    return

  const appId = id.value
  const { data, error } = await supabase
    .from('app_versions')
    .select('name')
    .eq('app_id', appId)
    .eq('deleted', false)
    .order('created_at', { ascending: false })
    .limit(200)

  if (appId !== id.value)
    return

  if (error || !data) {
    bundleNames.value = selectedVersionName.value ? [selectedVersionName.value] : []
    return
  }

  bundleNames.value = [...new Set(data.map(row => row.name).filter(Boolean))]
  ensureBundleName(selectedVersionName.value)
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
        actions: updaterInsightActions,
        ...(selectedVersionName.value ? { versionName: selectedVersionName.value } : {}),
      }),
    })

    if (requestId !== latestInsightsRequest)
      return

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      if (requestId !== latestInsightsRequest)
        return
      console.error('Failed to fetch log insights:', errorData)
      toast.error(t('failed-to-fetch-log-insights'))
      return
    }

    const payload = await response.json() as LogInsightsResponse
    if (requestId !== latestInsightsRequest)
      return
    insights.value = payload
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
    await Promise.all([loadAppInfo(), loadBundleNames()])
    await fetchInsights()
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}

async function applyVersionFilter(name: string) {
  if (selectedVersionName.value === name)
    return
  ensureBundleName(name)
  selectedVersionName.value = name
  const query = { ...route.query }
  if (name)
    query.version = name
  else
    delete query.version
  await router.replace({ query })
}

function onVersionSelectChange(event: Event) {
  void applyVersionFilter((event.target as HTMLSelectElement).value)
}

function logQuery(action?: string) {
  const period = insights.value?.period
  return {
    ...(period ? { start: period.start, end: period.end } : {}),
    ...(action ? { action } : {}),
  }
}

function openLogs(action?: string) {
  router.push({ path: `/app/${appRouteSegment.value}/observe/logs`, query: logQuery(action) })
}

function openDeviceLogs(device: LogInsightDevice) {
  router.push({ path: `/app/${appRouteSegment.value}/device/${device.device_id}/logs`, query: logQuery(device.action) })
}

watchEffect(async () => {
  if (route.params.app && lastPath.value !== route.path) {
    lastPath.value = route.path
    id.value = route.params.app as string
    selectedVersionName.value = typeof route.query.version === 'string' ? route.query.version : ''
    await refreshData()
    displayStore.NavTitle = ''
    displayStore.defaultBack = '/apps'
  }
})

watch(() => [
  selectedDays.value,
  typeof route.query.version === 'string' ? route.query.version : '',
] as const, async ([, version], previous) => {
  if (!id.value || !previous)
    return
  if (selectedVersionName.value !== version) {
    ensureBundleName(version)
    selectedVersionName.value = version
  }
  await fetchInsights()
})
</script>

<template>
  <div>
    <PageLoader v-if="isLoading" />
    <div v-else-if="app" class="w-full h-full px-4 pt-4 mx-auto mb-8 sm:px-6 lg:px-8 max-w-9xl max-h-fit">
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap items-center min-w-0 gap-x-3 gap-y-2">
            <label :for="versionFilterId" class="sr-only">{{ t('version') }}</label>
            <select
              :id="versionFilterId"
              class="w-full py-0 text-sm d-select d-select-bordered h-9 min-h-9 sm:w-56"
              :value="selectedVersionName"
              data-test="observe-updater-version-filter"
              @change="onVersionSelectChange"
            >
              <option value="">
                {{ t('all-versions') }}
              </option>
              <option v-for="name in bundleNames" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <p
              class="text-sm text-slate-500 dark:text-slate-400"
              data-testid="observe-period-labels"
              :data-count="insights?.period.labels.length ?? 0"
              :title="t('log-insights-period-help')"
            >
              {{ selectedPeriodLabel }} · {{ periodRangeLabel }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class="gap-2 d-btn d-btn-sm d-btn-outline shrink-0" @click="openLogs(topAction?.action)">
              <IconExternalLink class="w-4 h-4" />
              {{ topAction ? t('view-action-logs') : t('view-logs') }}
            </button>
            <PeriodDaySelector v-model="selectedDays" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="observe-updater-summary">
          <div class="px-4 py-3 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
            <div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <IconDownload class="w-4 h-4" />
              {{ t('errors-in-period') }}
            </div>
            <div class="mt-1 text-xl font-semibold" :class="totalErrors > 0 ? 'text-slate-900 dark:text-white' : 'text-emerald-600 dark:text-emerald-400'">
              {{ formatCount(totalErrors) }}
            </div>
          </div>
          <div class="px-4 py-3 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
            <div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <IconSmartphone class="w-4 h-4" />
              {{ t('affected-devices') }}
            </div>
            <div class="mt-1 text-xl font-semibold text-slate-900 dark:text-white">
              {{ formatCount(insights?.summary.device_count) }}
            </div>
          </div>
          <div class="px-4 py-3 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
            <div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <IconLayers class="w-4 h-4" />
              {{ t('action-count') }}
            </div>
            <div class="mt-1 text-xl font-semibold text-slate-900 dark:text-white">
              {{ formatCount(insights?.summary.action_count) }}
            </div>
          </div>
          <div class="px-4 py-3 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10" :title="topPriorityMessage">
            <div class="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <IconAlertTriangle v-if="topAction" class="w-4 h-4 text-amber-500" />
              <IconActivity v-else class="w-4 h-4" />
              {{ t('top-priority') }}
            </div>
            <div class="mt-1 text-xl font-semibold truncate text-slate-900 dark:text-white">
              {{ topAction ? formatAction(topAction.action) : '-' }}
            </div>
            <div v-if="topAction" class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('error-share', { share: formatPercent(topActionShare) }) }}
            </div>
          </div>
        </div>

        <div v-if="insightsLoading" class="flex items-center justify-center h-64 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
          <Spinner size="w-12 h-12" />
        </div>

        <div v-else-if="!insights || totalErrors === 0" class="flex flex-col items-center justify-center h-48 bg-white border rounded-xl shadow-sm text-slate-500 dark:bg-slate-800/60 dark:text-slate-400 border-slate-200 dark:border-white/10">
          <IconActivity class="w-10 h-10 mb-2" />
          <p>{{ t('no-log-insights') }}</p>
          <p class="mt-1 text-sm">
            {{ t('no-log-insights-help') }}
          </p>
        </div>

        <template v-else>
          <div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <section class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
              <div class="flex items-center gap-1 mb-3">
                <h3 class="text-base font-semibold text-slate-900 dark:text-white">
                  {{ t('error-categories') }}
                </h3>
                <InfoPopover :label="t('updater-failures-note-title')">
                  <div data-testid="observe-updater-failures-note">
                    <div class="font-semibold text-slate-900 dark:text-slate-100">
                      {{ t('updater-failures-note-title') }}
                    </div>
                    <p class="mt-1 text-slate-600 dark:text-slate-300">
                      {{ t('updater-failures-note-body') }}
                    </p>
                    <ul class="flex flex-col gap-2 mt-3">
                      <li v-for="category in failureCategories" :key="category" class="flex items-center gap-2">
                        <span class="px-1.5 py-0.5 text-[11px] font-medium rounded border shrink-0" :class="failureBadgeClass[category]">{{ t(`updater-failure-${category}`) }}</span>
                        <span class="text-xs text-slate-600 dark:text-slate-400">{{ t(`updater-failures-note-${category}`) }}</span>
                      </li>
                    </ul>
                    <p class="mt-3 text-xs text-slate-600 dark:text-slate-400">
                      {{ t('updater-failures-note-native') }}
                      <button
                        type="button"
                        class="ml-1 underline text-sky-700 underline-offset-2 hover:text-sky-800 dark:text-sky-300 dark:hover:text-sky-200"
                        data-testid="observe-updater-open-native"
                        @click="openNative"
                      >
                        {{ t('updater-failures-note-native-link') }}
                      </button>
                    </p>
                  </div>
                </InfoPopover>
              </div>
              <div class="space-y-3">
                <button
                  v-for="action in visibleActions"
                  :key="action.action"
                  type="button"
                  class="w-full text-left group"
                  :title="[failureHelp(action.action), `${t('version-count')}: ${formatCount(action.version_count)}`, `${t('last-seen')}: ${formatLastSeen(action.last_seen)}`].filter(Boolean).join('\n')"
                  @click="openLogs(action.action)"
                >
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="flex items-center min-w-0 gap-2">
                      <span class="font-medium truncate text-slate-800 dark:text-slate-100">{{ formatAction(action.action) }}</span>
                      <span class="px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap rounded border shrink-0" :class="failureBadgeClass[updaterFailureCategory(action.action)]">
                        {{ failureLabel(action.action) }}
                      </span>
                    </span>
                    <span class="text-xs text-slate-500 dark:text-slate-400 shrink-0">
                      <span class="text-sm font-medium text-slate-700 dark:text-slate-200">{{ formatCount(action.total) }}</span>
                      · {{ t('affected-devices-count', { count: formatCount(action.device_count) }) }}
                    </span>
                  </div>
                  <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                    <div class="h-full transition-all rounded-full" :class="failureBarClass[updaterFailureCategory(action.action)]" :style="`width: ${Math.max(4, (action.total / totalErrors) * 100)}%`" />
                  </div>
                </button>
              </div>
              <button
                v-if="insights.actions.length > PREVIEW_ROWS"
                type="button"
                class="mt-3 text-xs font-medium text-azure-600 hover:underline dark:text-azure-300"
                @click="showAllActions = !showAllActions"
              >
                {{ showAllActions ? t('show-less') : t('show-all-count', { count: insights.actions.length }) }}
              </button>
            </section>

            <section class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
              <h3 class="mb-3 text-base font-semibold text-slate-900 dark:text-white">
                {{ t('daily-error-trend') }}
              </h3>
              <div class="flex items-end gap-2 h-48">
                <div v-for="day in dailyTotals" :key="day.date" class="flex flex-col items-center justify-end flex-1 h-full min-w-0 gap-2">
                  <div class="flex items-end w-full h-full rounded-t bg-slate-100 dark:bg-slate-700">
                    <div class="w-full rounded-t bg-slate-400 dark:bg-slate-500" :style="`height: ${Math.max(4, (day.total / maxDailyTotal) * 100)}%`" :title="`${formatCount(day.total)}${day.topAction ? ` · ${formatAction(day.topAction)}` : ''}`" />
                  </div>
                  <div class="w-full text-center text-[11px] text-slate-500 dark:text-slate-400 truncate">
                    {{ formatLocalDateShort(day.date) }}
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <section class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
              <h3 class="mb-3 text-base font-semibold text-slate-900 dark:text-white">
                {{ t('top-error-versions') }}
              </h3>
              <div class="overflow-x-auto">
                <table class="min-w-full text-sm">
                  <thead class="text-[11px] font-semibold tracking-wider uppercase border-y border-slate-200 text-slate-500 bg-slate-50 dark:border-white/10 dark:text-slate-400 dark:bg-white/[0.03]">
                    <tr>
                      <th class="px-0 py-2 font-medium text-left">
                        {{ t('version') }}
                      </th>
                      <th class="px-3 py-2 font-medium text-left">
                        {{ t('action') }}
                      </th>
                      <th class="px-3 py-2 font-medium text-right">
                        {{ t('events') }}
                      </th>
                      <th class="px-0 py-2 font-medium text-right">
                        {{ t('devices') }}
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 dark:divide-white/5">
                    <tr
                      v-for="version in visibleVersions"
                      :key="`${version.action}-${version.version_name}`"
                      :class="selectedVersionName === version.version_name ? 'bg-azure-50/70 dark:bg-azure-400/5' : ''"
                    >
                      <td class="px-0 py-2 font-medium text-slate-900 dark:text-white">
                        <button
                          type="button"
                          class="text-left hover:text-azure-600 focus:outline-hidden focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-azure-500 dark:hover:text-azure-300"
                          :aria-pressed="selectedVersionName === version.version_name"
                          @click="applyVersionFilter(selectedVersionName === version.version_name ? '' : version.version_name)"
                        >
                          {{ version.version_name }}
                        </button>
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
              <button
                v-if="insights.versions.length > PREVIEW_ROWS"
                type="button"
                class="mt-3 text-xs font-medium text-azure-600 hover:underline dark:text-azure-300"
                @click="showAllVersions = !showAllVersions"
              >
                {{ showAllVersions ? t('show-less') : t('show-all-count', { count: insights.versions.length }) }}
              </button>
            </section>

            <section class="p-4 bg-white border rounded-xl shadow-sm dark:bg-slate-800/60 border-slate-200 dark:border-white/10">
              <h3 class="mb-3 text-base font-semibold text-slate-900 dark:text-white">
                {{ t('top-error-devices') }}
              </h3>
              <div class="space-y-2">
                <button
                  v-for="device in visibleDevices"
                  :key="`${device.action}-${device.device_id}`"
                  type="button"
                  class="flex items-center justify-between w-full gap-3 px-3 py-2 text-left border rounded-md border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-700/40"
                  @click="openDeviceLogs(device)"
                >
                  <div class="min-w-0">
                    <div class="text-sm font-medium truncate text-slate-900 dark:text-white">
                      {{ device.device_id }}
                    </div>
                    <div class="text-xs truncate text-slate-500 dark:text-slate-400">
                      {{ formatAction(device.action) }} · {{ device.version_name }} · {{ formatLastSeen(device.last_seen) }}
                    </div>
                  </div>
                  <div class="text-sm font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                    {{ formatCount(device.total) }}
                  </div>
                </button>
              </div>
              <button
                v-if="insights.devices.length > PREVIEW_ROWS"
                type="button"
                class="mt-3 text-xs font-medium text-azure-600 hover:underline dark:text-azure-300"
                @click="showAllDevices = !showAllDevices"
              >
                {{ showAllDevices ? t('show-less') : t('show-all-count', { count: insights.devices.length }) }}
              </button>
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
      <button type="button" class="mt-4 text-white d-btn d-btn-primary" @click="$router.push(`/apps`)">
        {{ t('back-to-apps') }}
      </button>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: app
</route>

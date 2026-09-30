<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { ReleaseLiveDeployment } from '~/composables/useReleaseLive'
import { useDark, useDocumentVisibility, useNow } from '@vueuse/core'
import { computed, ref, useId, watch } from 'vue'
import { Bar } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconRefresh from '~icons/lucide/refresh-cw'
import Spinner from '~/components/Spinner.vue'
import { buildDemoReleaseLive, RELEASE_LIVE_POLL_INTERVAL_MS, useReleaseLive } from '~/composables/useReleaseLive'
import { registerDashboardCharts } from '~/services/dashboardChartRegister'
import { formatDistanceToNow, formatLocalDateShort, formatLocalDateTime, formatLocalTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

const props = withDefaults(defineProps<{
  appId: string
  forceDemo?: boolean
}>(), {
  forceDemo: false,
})

registerDashboardCharts()

const { t } = useI18n()
const isDark = useDark()
const visibility = useDocumentVisibility()
const now = useNow({ interval: 1000 })
const selectId = useId()

const route = useRoute()

// Key format is `${channel_id}|${version_name}`. Empty means "latest
// deployment"; `|${version}` (from ?version=, e.g. the release banner) asks the
// backend for that bundle on any channel.
function keyFromQuery() {
  const version = route.query.version
  return typeof version === 'string' && version ? `|${version}` : ''
}

const selectedKey = ref(keyFromQuery())
const selected = computed(() => {
  if (!selectedKey.value)
    return { version_name: undefined, channel_id: undefined }
  const [channel, ...versionParts] = selectedKey.value.split('|')
  const channelId = Number(channel)
  return {
    version_name: versionParts.join('|') || undefined,
    channel_id: channel && Number.isFinite(channelId) ? channelId : undefined,
  }
})

const { data, loading, error, lastUpdatedAt, fetchLive } = useReleaseLive(() => ({
  app_id: props.appId,
  channel_id: selected.value.channel_id,
  version_name: selected.value.version_name,
  enabled: !props.forceDemo && !!props.appId,
}))

const demo = computed(() => buildDemoReleaseLive())
const live = computed(() => props.forceDemo ? demo.value : data.value)
const release = computed(() => live.value?.release ?? null)
const series = computed(() => live.value?.series ?? [])
const totals = computed(() => live.value?.totals ?? { get: 0, install: 0, fail: 0, success_rate: null })
const adoption = computed(() => live.value?.adoption ?? { devices_on_release: 0, total_devices: 0, percent: null })
const failures = computed(() => live.value?.failures ?? [])
const hasActivity = computed(() => totals.value.get + totals.value.install + totals.value.fail > 0)
const isPolling = computed(() => !props.forceDemo && visibility.value === 'visible')

function deploymentKey(deployment: Pick<ReleaseLiveDeployment, 'channel_id' | 'version_name'>) {
  return `${deployment.channel_id ?? ''}|${deployment.version_name}`
}

// Kept across release switches so the picker does not vanish while loading.
const recentDeployments = ref<ReleaseLiveDeployment[]>([])
watch(live, (value) => {
  if (value)
    recentDeployments.value = value.recent_deployments
})

const deploymentOptions = computed(() => {
  const seen = new Set<string>()
  const options: { key: string, label: string }[] = []
  if (selectedKey.value.startsWith('|')) {
    seen.add(selectedKey.value)
    options.push({ key: selectedKey.value, label: selectedKey.value.slice(1) })
  }
  for (const deployment of recentDeployments.value) {
    const key = deploymentKey(deployment)
    if (seen.has(key))
      continue
    seen.add(key)
    const channel = deployment.channel_name ?? t('release-live-no-channel')
    options.push({
      key,
      label: `${deployment.version_name} · ${channel} · ${formatLocalDateTime(deployment.deployed_at)}`,
    })
  }
  return options
})

const secondsSinceUpdate = computed(() => {
  const updatedAt = props.forceDemo ? now.value.getTime() : lastUpdatedAt.value
  if (!updatedAt)
    return null
  return Math.max(0, Math.floor((now.value.getTime() - updatedAt) / 1000))
})

// Below this many outcomes the success rate is too noisy to label the release.
const MIN_STATUS_SAMPLES = 20

const status = computed(() => {
  const rate = totals.value.success_rate
  if (rate === null || totals.value.install + totals.value.fail < MIN_STATUS_SAMPLES)
    return null
  if (rate >= 95)
    return { label: t('release-live-status-healthy'), class: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' }
  if (rate >= 85)
    return { label: t('release-live-status-watch'), class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' }
  return { label: t('release-live-status-risk'), class: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' }
})

function formatCount(value: number | null | undefined) {
  return formatNumberValue(value ?? 0)
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '-'
  return `${formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function successRateClass(rate: number | null) {
  if (rate === null || totals.value.install + totals.value.fail < MIN_STATUS_SAMPLES)
    return 'text-slate-900 dark:text-white'
  if (rate >= 95)
    return 'text-emerald-600 dark:text-emerald-400'
  if (rate >= 85)
    return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

const spansMultipleDays = computed(() => {
  const window = live.value?.window
  if (!window)
    return false
  return Date.parse(window.end) - Date.parse(window.start) > 24 * 60 * 60 * 1000
})

function formatBucketLabel(ts: string) {
  if (spansMultipleDays.value)
    return `${formatLocalDateShort(ts)} ${formatLocalTime(ts)}`
  return formatLocalTime(ts)
}

const chartData = computed<ChartData<'bar'>>(() => ({
  labels: series.value.map(bucket => formatBucketLabel(bucket.ts)),
  datasets: [
    {
      label: t('release-live-installs'),
      data: series.value.map(bucket => bucket.install),
      backgroundColor: '#10b981',
      borderRadius: 2,
      stack: 'activity',
    },
    {
      label: t('release-live-failures'),
      data: series.value.map(bucket => bucket.fail),
      backgroundColor: '#f43f5e',
      borderRadius: 2,
      stack: 'activity',
    },
  ],
}))

const chartOptions = computed<ChartOptions<'bar'>>(() => {
  const tickColor = isDark.value ? '#94a3b8' : '#64748b'
  const gridColor = isDark.value ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.12)'
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom', labels: { color: tickColor, boxWidth: 12 } },
      tooltip: { enabled: true },
    },
    scales: {
      x: {
        stacked: true,
        grid: { display: false },
        ticks: { color: tickColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
      },
      y: {
        stacked: true,
        beginAtZero: true,
        grid: { color: gridColor },
        ticks: { color: tickColor, precision: 0 },
      },
    },
  }
})

function refresh() {
  void fetchLive()
}

// useReleaseLive refetches on its own when the target changes. Re-seed the
// selection when the app or the ?version= link changes; the picker list only
// belongs to the app, so keep it across query-only navigation.
watch([() => props.appId, () => route.query.version], ([appId], [previousAppId]) => {
  selectedKey.value = keyFromQuery()
  if (appId !== previousAppId)
    recentDeployments.value = []
})
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="release-live">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
            {{ t('release-live-title') }}
          </h2>
          <span
            class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold uppercase rounded-full"
            :class="isPolling ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'"
          >
            <span class="relative flex w-2 h-2">
              <span v-if="isPolling" class="absolute inline-flex w-full h-full rounded-full opacity-75 animate-ping bg-emerald-400" />
              <span class="relative inline-flex w-2 h-2 rounded-full" :class="isPolling ? 'bg-emerald-500' : 'bg-slate-400'" />
            </span>
            {{ isPolling ? t('release-live-live') : t('release-live-paused') }}
          </span>
          <span
            v-if="forceDemo"
            class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ t('demo') }}
          </span>
        </div>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('release-live-help', { seconds: RELEASE_LIVE_POLL_INTERVAL_MS / 1000 }) }}
        </p>
      </div>
      <div class="flex items-end gap-2">
        <div v-if="deploymentOptions.length > 1" class="flex flex-col gap-1">
          <label :for="selectId" class="text-xs font-medium text-slate-600 dark:text-slate-400">
            {{ t('release-live-select-release') }}
          </label>
          <select
            :id="selectId"
            v-model="selectedKey"
            class="d-select d-select-sm d-select-bordered max-w-xs"
            :aria-label="t('release-live-select-release')"
          >
            <option value="">
              {{ t('release-live-latest') }}
            </option>
            <option v-for="option in deploymentOptions" :key="option.key" :value="option.key">
              {{ option.label }}
            </option>
          </select>
        </div>
        <button
          type="button"
          class="d-btn d-btn-sm d-btn-ghost"
          :disabled="loading || forceDemo"
          :aria-label="t('refresh')"
          @click="refresh"
        >
          <IconRefresh class="w-4 h-4" :class="{ 'animate-spin': loading }" />
          <span v-if="secondsSinceUpdate !== null" class="text-xs font-normal text-slate-500 dark:text-slate-400">
            {{ t('release-live-updated-ago', { seconds: secondsSinceUpdate }) }}
          </span>
        </button>
      </div>
    </div>

    <div v-if="loading && !live && !error" class="flex items-center justify-center h-48 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
      <Spinner size="w-10 h-10" />
    </div>

    <div
      v-else-if="error && !live"
      class="flex flex-col items-center justify-center h-48 gap-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
    >
      <IconAlertCircle class="w-10 h-10" />
      <p class="text-sm">
        {{ t('release-live-fetch-error') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-primary" @click="refresh">
        {{ t('update-delivery-retry') }}
      </button>
    </div>

    <div
      v-else-if="!release"
      class="flex flex-col items-center justify-center h-48 gap-2 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
    >
      <IconAlertCircle class="w-10 h-10" />
      <p>{{ t('release-live-no-release') }}</p>
      <p class="max-w-lg text-sm text-center">
        {{ t('release-live-no-release-help') }}
      </p>
    </div>

    <template v-else>
      <div class="flex flex-col gap-3 p-4 bg-white border rounded-lg shadow-sm sm:flex-row sm:items-center sm:justify-between dark:bg-slate-800 border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-lg font-semibold text-slate-900 dark:text-white">{{ release.version_name }}</span>
            <span v-if="release.channel_name" class="px-2 py-0.5 text-xs font-medium rounded bg-azure-50 text-azure-700 dark:bg-azure-900/30 dark:text-azure-300">
              {{ release.channel_name }}
            </span>
            <span v-if="status" class="px-2 py-0.5 text-xs font-semibold rounded" :class="status.class">
              {{ status.label }}
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400" :title="formatLocalDateTime(release.deployed_at)">
            {{ t('release-live-deployed', { time: formatDistanceToNow(release.deployed_at) }) }}
            <template v-if="live?.window?.truncated">
              · {{ t('release-live-truncated') }}
            </template>
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <RouterLink
            v-if="release.bundle_id && !forceDemo"
            :to="`/app/${appId}/bundle/${release.bundle_id}`"
            class="d-btn d-btn-sm d-btn-outline"
          >
            {{ t('release-live-view-bundle') }}
          </RouterLink>
          <RouterLink
            v-if="release.channel_id && !forceDemo"
            :to="`/app/${appId}/channel/${release.channel_id}/statistics`"
            class="d-btn d-btn-sm d-btn-outline"
          >
            {{ t('release-live-view-channel') }}
          </RouterLink>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('release-live-adoption') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
            {{ formatPercent(adoption.percent) }}
          </div>
          <div class="w-full h-1.5 mt-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
            <div class="h-full transition-all duration-500 rounded-full bg-azure-500" :style="{ width: `${Math.min(100, adoption.percent ?? 0)}%` }" />
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('release-live-adoption-help', { onRelease: formatCount(adoption.devices_on_release), total: formatCount(adoption.total_devices) }) }}
          </p>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('release-live-installs') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
            {{ formatCount(totals.install) }}
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('release-live-served', { count: formatCount(totals.get) }) }}
          </p>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('release-live-failures') }}
          </div>
          <div class="mt-2 text-2xl font-semibold" :class="totals.fail > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-white'">
            {{ formatCount(totals.fail) }}
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm text-slate-600 dark:text-slate-400">
            {{ t('bundle-install-success-rate') }}
          </div>
          <div class="mt-2 text-2xl font-semibold" :class="successRateClass(totals.success_rate)">
            {{ formatPercent(totals.success_rate) }}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div class="p-4 bg-white border rounded-lg shadow-sm lg:col-span-2 dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="flex items-baseline justify-between gap-2 mb-3">
            <h3 class="text-sm font-semibold text-slate-900 dark:text-white">
              {{ t('release-live-chart-title') }}
            </h3>
            <span v-if="live?.window" class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('release-live-bucket', { minutes: live.window.bucket_minutes }) }}
            </span>
          </div>
          <div v-if="hasActivity" class="h-64">
            <Bar :data="chartData" :options="chartOptions" />
          </div>
          <div v-else class="flex flex-col items-center justify-center h-64 gap-2 text-sm text-center text-slate-500 dark:text-slate-400">
            <Spinner size="w-6 h-6" />
            <p class="max-w-sm">
              {{ t('release-live-waiting') }}
            </p>
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <h3 class="mb-3 text-sm font-semibold text-slate-900 dark:text-white">
            {{ t('release-live-top-failures') }}
          </h3>
          <ul v-if="failures.length" class="flex flex-col gap-2">
            <li v-for="failure in failures" :key="failure.action" class="flex items-center justify-between gap-2 text-sm">
              <code class="px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200">{{ failure.action }}</code>
              <span class="font-semibold text-rose-600 dark:text-rose-400">{{ formatCount(failure.count) }}</span>
            </li>
          </ul>
          <p v-else class="text-sm text-slate-500 dark:text-slate-400">
            {{ t('release-live-no-failures') }}
          </p>
        </div>
      </div>
    </template>
  </section>
</template>

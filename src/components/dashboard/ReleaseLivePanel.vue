<script setup lang="ts">
import type { ChartData, ChartOptions } from 'chart.js'
import type { ReleaseLiveChannel, ReleaseLiveDeployment, ReleaseLiveResponse } from '~/composables/useReleaseLive'
import { useDark, useDocumentVisibility, useNow } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { Bar } from 'vue-chartjs'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconRefresh from '~icons/lucide/refresh-cw'
import Spinner from '~/components/Spinner.vue'
import { buildDemoReleaseLive, RELEASE_LIVE_POLL_INTERVAL_MS, useReleaseLive } from '~/composables/useReleaseLive'
import { registerDashboardCharts } from '~/services/dashboardChartRegister'
import { formatDistanceToNow, formatLocalDateShort, formatLocalDateTime, formatLocalTime } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'

const props = withDefaults(defineProps<{
  appId: string
  forceDemo?: boolean
  // Folds the KPI tiles into the release row and shortens the chart so
  // Observe > Releases fits one screen.
  dense?: boolean
  // Locks the panel to one channel (channel statistics page): the channel
  // picker is hidden and only that channel's deployments are offered.
  channelId?: number
}>(), {
  forceDemo: false,
  dense: false,
  channelId: undefined,
})

const emit = defineEmits<{
  // Lets the page reuse the release and adoption it shows (alerts banner)
  // instead of polling release_live a second time.
  live: [value: ReleaseLiveResponse | null]
}>()

registerDashboardCharts()

const { t } = useI18n()
const isDark = useDark()
const visibility = useDocumentVisibility()
const now = useNow({ interval: 1000 })
// Toolbar segments: a muted label plus a borderless native select and our own chevron.
const segmentClass = 'relative flex flex-1 sm:flex-none items-center min-w-0 h-9 gap-1.5 pl-3 pr-7 text-xs font-medium rounded-md bg-white shadow-sm cursor-pointer focus-within:ring-2 focus-within:ring-primary/40 dark:bg-gray-700'
const segmentSelectClass = 'min-w-0 sm:max-w-48 flex-1 appearance-none truncate bg-transparent p-0 border-0 text-xs font-medium text-gray-900 cursor-pointer focus:outline-none focus:ring-0 disabled:cursor-not-allowed dark:text-white'

const route = useRoute()
const router = useRouter()

function queryString(value: unknown) {
  return typeof value === 'string' && value ? value : undefined
}

// The route query is the selection: ?channel= picks the channel (the backend
// falls back to the app's default channel) and ?version= a deployment on it
// (empty means the latest one). The release banner links with ?version= only.
const selected = computed(() => {
  const channelId = props.channelId ?? Number(queryString(route.query.channel))
  return {
    channel_id: Number.isInteger(channelId) && channelId > 0 ? channelId : undefined,
    version_name: queryString(route.query.version),
  }
})

function selectRelease(channelId: number | undefined, versionName: string | undefined) {
  void router.replace({
    query: {
      ...route.query,
      channel: props.channelId || !channelId ? undefined : String(channelId),
      version: versionName || undefined,
    },
  })
}

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
// Below this many outcomes the success rate is too noisy to label the release.
const MIN_STATUS_SAMPLES = 20
// Progressive rollout: the target only goes to a share of the channel, so
// reach (devices on target / devices targeted) replaces raw adoption, and the
// stable fallback is the baseline for the success rate.
const rollout = computed(() => live.value?.rollout ?? null)
const rolloutBadge = computed(() => {
  const value = rollout.value
  if (!value)
    return null
  if (value.status === 'paused')
    return { label: t('release-live-rollout-paused', { percent: formatPercent(value.percentage) }), class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' }
  if (value.status === 'zero')
    return { label: t('release-live-rollout-zero'), class: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' }
  return { label: t('release-live-rollout-badge', { percent: formatPercent(value.percentage) }), class: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' }
})
const reachStat = computed(() => {
  const value = rollout.value
  if (!value) {
    return {
      label: t('release-live-adoption'),
      value: adoption.value.total_devices > 0 ? formatPercent(adoption.value.percent) : '-',
      help: t('release-live-adoption-help', { onRelease: formatCount(adoption.value.devices_on_release), total: formatCount(adoption.value.total_devices) }),
      progress: adoption.value.percent ?? 0,
    }
  }
  return {
    label: t('release-live-rollout-reach'),
    value: formatPercent(value.reach_percent),
    help: t('release-live-rollout-reach-help', {
      onTarget: formatCount(value.devices_on_target),
      expected: formatCount(value.expected_on_target),
      percent: formatPercent(value.percentage),
      total: formatCount(value.total_devices),
    }),
    progress: value.reach_percent ?? 0,
  }
})
const fallbackRate = computed(() => {
  const totalsOnFallback = rollout.value?.fallback_totals
  if (!totalsOnFallback || totalsOnFallback.install + totalsOnFallback.fail < MIN_STATUS_SAMPLES)
    return null
  return totalsOnFallback.success_rate
})

const failures = computed(() => live.value?.failures ?? [])
const failedDevices = computed(() => live.value?.failed_devices ?? null)
const hasActivity = computed(() => totals.value.get + totals.value.install + totals.value.fail > 0)
const isPolling = computed(() => !props.forceDemo && visibility.value === 'visible')

// Kept across selection changes so the pickers do not vanish while loading.
const channels = ref<ReleaseLiveChannel[]>([])
const activeChannel = ref<ReleaseLiveChannel | null>(null)
const recentDeployments = ref<ReleaseLiveDeployment[]>([])
watch(live, (value) => {
  emit('live', value)
  if (!value)
    return
  channels.value = value.channels
  activeChannel.value = value.channel
  recentDeployments.value = value.recent_deployments
})

const channelOptions = computed(() => channels.value.map(channel => ({
  id: channel.id,
  label: channel.is_default ? `${channel.name} (${t('release-live-default-channel')})` : channel.name,
})))

const selectedChannelId = computed<number | ''>({
  get: () => selected.value.channel_id ?? activeChannel.value?.id ?? '',
  set: (channelId) => {
    if (!channelId || channelId === selectedChannelId.value)
      return
    // A new channel starts on its latest deployment.
    recentDeployments.value = []
    selectRelease(channelId, undefined)
  },
})

const selectedVersion = computed<string>({
  get: () => selected.value.version_name ?? '',
  set: versionName => selectRelease(selected.value.channel_id ?? activeChannel.value?.id, versionName || undefined),
})

const deploymentOptions = computed(() => {
  const seen = new Set<string>()
  const options: { value: string, label: string }[] = []
  for (const deployment of recentDeployments.value) {
    if (seen.has(deployment.version_name))
      continue
    seen.add(deployment.version_name)
    options.push({
      value: deployment.version_name,
      label: `${deployment.version_name} · ${formatLocalDateTime(deployment.deployed_at)}`,
    })
  }
  // A bundle opened by name (release banner) may not be in the recent list.
  const version = selected.value.version_name
  if (version && !seen.has(version))
    options.unshift({ value: version, label: version })
  return options
})

const secondsSinceUpdate = computed(() => {
  const updatedAt = props.forceDemo ? now.value.getTime() : lastUpdatedAt.value
  if (!updatedAt)
    return null
  return Math.max(0, Math.floor((now.value.getTime() - updatedAt) / 1000))
})

const status = computed(() => {
  const rate = totals.value.success_rate
  if (rate === null || totals.value.install + totals.value.fail < MIN_STATUS_SAMPLES)
    return null
  // During a rollout the question is "is the target worse than what the other
  // devices get?", so it is judged against the fallback, not a fixed bar.
  if (fallbackRate.value !== null) {
    const gap = fallbackRate.value - rate
    if (gap <= 2)
      return { label: t('release-live-status-healthy'), class: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' }
    if (gap <= 5)
      return { label: t('release-live-status-watch'), class: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' }
    return { label: t('release-live-status-risk'), class: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' }
  }
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

// Some failed attempts are expected on every rollout (offline devices, app
// closed mid-download, low storage), so failures only get a color when the
// success rate itself needs attention.
const failureCountClass = computed(() => {
  const rate = totals.value.success_rate
  if (rate === null || totals.value.install + totals.value.fail < MIN_STATUS_SAMPLES || rate >= 95)
    return 'text-slate-900 dark:text-white'
  if (rate >= 85)
    return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
})

const failureRate = computed(() => {
  const attempts = totals.value.install + totals.value.fail
  return attempts > 0 ? (totals.value.fail / attempts) * 100 : null
})

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
      // Muted so a normal trickle of failures does not dominate the installs.
      backgroundColor: isDark.value ? 'rgba(251, 113, 133, 0.55)' : '#fda4af',
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

// Pickers belong to one app: drop them when the app changes.
watch(() => props.appId, () => {
  channels.value = []
  activeChannel.value = null
  recentDeployments.value = []
})
</script>

<template>
  <section class="flex flex-col" :class="dense ? 'gap-3' : 'gap-4'" data-testid="release-live">
    <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <!-- Dense pages already name this view in their tab, so the title goes. -->
          <h2 v-if="!dense" class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
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
          <span
            v-if="dense && secondsSinceUpdate !== null"
            class="text-xs tabular-nums whitespace-nowrap text-slate-500 dark:text-slate-400"
            :title="t('release-live-help', { seconds: RELEASE_LIVE_POLL_INTERVAL_MS / 1000 })"
          >
            {{ t('release-live-updated-ago', { seconds: secondsSinceUpdate }) }}
          </span>
        </div>
        <p
          v-if="!dense && secondsSinceUpdate !== null"
          class="mt-1 text-xs tabular-nums text-slate-500 dark:text-slate-400"
          :title="t('release-live-help', { seconds: RELEASE_LIVE_POLL_INTERVAL_MS / 1000 })"
        >
          {{ t('release-live-updated-ago', { seconds: secondsSinceUpdate }) }}
        </p>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <!-- Page-level controls (alerts, period) sit on the same row. -->
        <slot name="actions" />
        <!-- Same gray toolbar as PeriodDaySelector on the other dashboard tabs. -->
        <div class="flex items-center w-full gap-1 p-1 bg-gray-200 rounded-lg sm:w-auto shrink-0 dark:bg-gray-800">
          <label v-if="channelOptions.length && !props.channelId" :class="segmentClass" data-testid="release-live-channel-segment">
            <span class="hidden text-gray-500 shrink-0 sm:inline dark:text-gray-400">{{ t('release-live-select-channel') }}</span>
            <select
              v-model="selectedChannelId"
              :class="segmentSelectClass"
              :aria-label="t('release-live-select-channel')"
              :disabled="forceDemo"
              data-testid="release-live-channel"
            >
              <option v-for="option in channelOptions" :key="option.id" :value="option.id">
                {{ option.label }}
              </option>
            </select>
            <IconChevronDown class="absolute w-3.5 h-3.5 -translate-y-1/2 pointer-events-none right-2 top-1/2 text-gray-400" aria-hidden="true" />
          </label>
          <label v-if="deploymentOptions.length" :class="segmentClass" data-testid="release-live-release-segment">
            <span class="hidden text-gray-500 shrink-0 sm:inline dark:text-gray-400">{{ t('release-live-select-release') }}</span>
            <select
              v-model="selectedVersion"
              :class="segmentSelectClass"
              :aria-label="t('release-live-select-release')"
              :disabled="forceDemo"
              data-testid="release-live-release"
            >
              <option value="">
                {{ t('release-live-latest') }}
              </option>
              <option v-for="option in deploymentOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <IconChevronDown class="absolute w-3.5 h-3.5 -translate-y-1/2 pointer-events-none right-2 top-1/2 text-gray-400" aria-hidden="true" />
          </label>
          <button
            type="button"
            class="flex items-center justify-center w-9 h-9 transition-colors rounded-md cursor-pointer shrink-0 text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
            :disabled="loading || forceDemo"
            :aria-label="t('refresh')"
            :title="t('refresh')"
            @click="refresh"
          >
            <IconRefresh class="w-4 h-4" :class="{ 'animate-spin': loading }" />
          </button>
        </div>
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
      <div class="flex flex-col gap-3 px-4 py-3 bg-white border rounded-lg shadow-sm sm:flex-row sm:items-center sm:justify-between dark:bg-slate-800 border-slate-200 dark:border-slate-700">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-lg font-semibold text-slate-900 dark:text-white">{{ release.version_name }}</span>
            <span v-if="release.channel_name" class="px-2 py-0.5 text-xs font-medium rounded bg-azure-500/10 text-blue-800 dark:bg-azure-900/30 dark:text-azure-300">
              {{ release.channel_name }}
            </span>
            <span v-if="rolloutBadge" class="px-2 py-0.5 text-xs font-semibold rounded" :class="rolloutBadge.class" data-testid="release-live-rollout-badge" :title="rollout?.pause_reason ?? undefined">
              {{ rolloutBadge.label }}
            </span>
            <span v-if="status" class="px-2 py-0.5 text-xs font-semibold rounded" :class="status.class">
              {{ status.label }}
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400" :title="formatLocalDateTime(release.deployed_at)">
            <template v-if="rollout?.fallback_version">
              {{ t('release-live-rollout-fallback', { version: rollout.fallback_version, percent: formatPercent(100 - rollout.percentage) }) }} ·
            </template>
            {{ rollout ? t('release-live-uploaded', { time: formatDistanceToNow(release.deployed_at) }) : t('release-live-deployed', { time: formatDistanceToNow(release.deployed_at) }) }}
            <template v-if="live?.window?.truncated">
              · {{ t('release-live-truncated') }}
            </template>
          </p>
        </div>
        <dl v-if="dense" class="flex flex-wrap items-center gap-x-6 gap-y-2" data-testid="release-live-dense-stats">
          <div :title="reachStat.help" data-testid="release-live-reach">
            <dt class="text-xs text-slate-500 dark:text-slate-400">
              {{ reachStat.label }}
            </dt>
            <dd class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ reachStat.value }}
            </dd>
          </div>
          <div :title="t('release-live-served', { count: formatCount(totals.get) })">
            <dt class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('release-live-installs') }}
            </dt>
            <dd class="text-lg font-semibold text-slate-900 dark:text-white">
              {{ formatCount(totals.install) }}
            </dd>
          </div>
          <div :title="failureRate !== null ? t('release-live-failure-rate', { rate: formatPercent(failureRate) }) : ''">
            <dt class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('release-live-failures') }}
            </dt>
            <dd class="text-lg font-semibold" :class="failureCountClass" data-testid="release-live-failure-count">
              {{ formatCount(totals.fail) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500 dark:text-slate-400">
              {{ t('bundle-install-success-rate') }}
            </dt>
            <dd class="text-lg font-semibold" :class="successRateClass(totals.success_rate)">
              {{ formatPercent(totals.success_rate) }}
              <span v-if="fallbackRate !== null && rollout?.fallback_version" class="text-xs font-normal text-slate-500 dark:text-slate-400" data-testid="release-live-fallback-rate">
                {{ t('release-live-vs-fallback', { rate: formatPercent(fallbackRate), version: rollout.fallback_version }) }}
              </span>
            </dd>
          </div>
        </dl>
        <div class="flex flex-wrap gap-2">
          <RouterLink
            v-if="release.bundle_id && !forceDemo"
            :to="`/app/${appId}/bundle/${release.bundle_id}`"
            class="d-btn d-btn-sm d-btn-outline"
          >
            {{ t('release-live-view-bundle') }}
          </RouterLink>
          <RouterLink
            v-if="release.channel_id && !forceDemo && !props.channelId"
            :to="`/app/${appId}/channel/${release.channel_id}/statistics`"
            class="d-btn d-btn-sm d-btn-outline"
          >
            {{ t('release-live-view-channel') }}
          </RouterLink>
        </div>
      </div>

      <div v-if="!dense" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="px-4 py-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-600 dark:text-slate-400">
            {{ reachStat.label }}
          </div>
          <div class="mt-1 text-xl font-semibold text-slate-900 dark:text-white">
            {{ reachStat.value }}
          </div>
          <div class="w-full h-1.5 mt-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
            <div class="h-full transition-all duration-500 rounded-full bg-azure-500" :style="{ width: `${Math.min(100, reachStat.progress)}%` }" />
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ reachStat.help }}
          </p>
        </div>
        <div class="px-4 py-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-600 dark:text-slate-400">
            {{ t('release-live-installs') }}
          </div>
          <div class="mt-1 text-xl font-semibold text-slate-900 dark:text-white">
            {{ formatCount(totals.install) }}
          </div>
          <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('release-live-served', { count: formatCount(totals.get) }) }}
          </p>
        </div>
        <div class="px-4 py-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-600 dark:text-slate-400">
            {{ t('release-live-failures') }}
          </div>
          <div class="mt-1 text-xl font-semibold" :class="failureCountClass" data-testid="release-live-failure-count">
            {{ formatCount(totals.fail) }}
          </div>
          <p v-if="failureRate !== null" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {{ t('release-live-failure-rate', { rate: formatPercent(failureRate) }) }}
          </p>
          <template v-if="failedDevices && failedDevices.total > 0">
            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400" data-testid="release-live-failed-devices">
              {{ t('release-live-failed-devices', { count: formatCount(failedDevices.total) }) }}
            </p>
            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400" :title="t('release-live-failed-devices-help')">
              {{ t('release-live-recovered-devices', { count: formatCount(failedDevices.recovered) }) }}
              <span class="text-slate-400"> · </span>
              {{ t('release-live-stuck-devices', { count: formatCount(failedDevices.stuck) }) }}
            </p>
          </template>
        </div>
        <div class="px-4 py-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-xs text-slate-600 dark:text-slate-400">
            {{ t('bundle-install-success-rate') }}
          </div>
          <div class="mt-1 text-xl font-semibold" :class="successRateClass(totals.success_rate)">
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
          <div v-if="hasActivity" :class="dense ? 'h-32' : 'h-56'">
            <Bar :data="chartData" :options="chartOptions" />
          </div>
          <div v-else class="flex flex-col items-center justify-center gap-2 text-sm text-center text-slate-500 dark:text-slate-400" :class="dense ? 'h-32' : 'h-56'">
            <Spinner size="w-6 h-6" />
            <p class="max-w-sm">
              {{ t('release-live-waiting') }}
            </p>
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <h3 class="mb-3 text-sm font-semibold text-slate-900 dark:text-white" :title="t('release-live-failures-normal')">
            {{ t('release-live-top-failures') }}
          </h3>
          <ul v-if="failures.length" class="flex flex-col gap-2">
            <li v-for="failure in failures" :key="failure.action" class="flex items-center justify-between gap-2 text-sm">
              <code class="px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200">{{ failure.action }}</code>
              <span class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ formatCount(failure.count) }}</span>
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

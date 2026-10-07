<script setup lang="ts">
import type { ReleaseLiveResponse } from '~/composables/useReleaseLive'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconArrowRight from '~icons/lucide/arrow-right'
import AlertsMenu from '~/components/dashboard/AlertsMenu.vue'
import BundleInstallStatsPanel from '~/components/dashboard/BundleInstallStatsPanel.vue'
import ChannelVersionChart from '~/components/dashboard/ChannelVersionChart.vue'
import { provideChartCardCompact } from '~/components/dashboard/chartCardDensity'
import DeliveryLatencyPanel from '~/components/dashboard/DeliveryLatencyPanel.vue'
import DevicesStats from '~/components/dashboard/DevicesStats.vue'
import { useDeviceDataCollection } from '~/composables/useDeviceDataCollection'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import ReleaseLivePanel from '~/components/dashboard/ReleaseLivePanel.vue'
import Spinner from '~/components/Spinner.vue'
import { useNativeObserveStats } from '~/composables/useNativeObserveStats'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { groupCompatibilityEvents } from '~/services/compatibilityEvents'
import { formatNumberValue } from '~/services/formatLocale'
import { actionToFilter, updaterInsightActions } from '~/services/statsActions'
import { defaultApiHost, useSupabase } from '~/services/supabase'

// The app landing page (Observe > Live release) and the channel statistics
// page share this one screen. On a channel page it is locked to that channel:
// no channel picker, no app-wide health tiles, and the version mix comes from
// that channel only.
const props = withDefaults(defineProps<{
  appId: string
  channelId?: number
  forceDemo?: boolean
}>(), {
  channelId: undefined,
  forceDemo: false,
})

const emit = defineEmits<{
  deployed: []
}>()

provideChartCardCompact('dense')

const { t } = useI18n()
const supabase = useSupabase()
const { days } = usePeriodDaysQuery()
const { collection: deviceDataCollection } = useDeviceDataCollection(() => props.appId)

const isChannelView = computed(() => props.channelId !== undefined)
const basePath = computed(() => `/app/${encodeURIComponent(props.appId)}`)
const periodQuery = computed(() => ({ days: String(days.value) }))

// Shared with the alerts banner so release_live is polled once.
const live = ref<ReleaseLiveResponse | null>(null)

// Updater failures for the selected period.
interface InsightsResponse {
  summary: { total: number, device_count: number, action_count: number }
  actions: Array<{ action: string, total: number, device_count: number }>
}
const insights = ref<InsightsResponse | null>(null)
const insightsLoading = ref(false)
let insightsRequest = 0

async function fetchInsights() {
  const requestId = ++insightsRequest
  if (!props.appId || props.forceDemo || isChannelView.value) {
    insights.value = null
    insightsLoading.value = false
    return
  }
  insightsLoading.value = true
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    if (!sessionData.session)
      return
    const response = await fetch(`${defaultApiHost}/private/stats/insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'authorization': `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({ appId: props.appId, days: days.value, actions: updaterInsightActions }),
    })
    if (requestId !== insightsRequest)
      return
    const payload = response.ok ? await response.json() as InsightsResponse : null
    // A slower, older request must not overwrite the current period.
    if (requestId !== insightsRequest)
      return
    insights.value = payload
  }
  catch (error) {
    console.error('Failed to fetch live release insights:', error)
    if (requestId === insightsRequest)
      insights.value = null
  }
  finally {
    if (requestId === insightsRequest)
      insightsLoading.value = false
  }
}

// Native health for the selected period.
interface NativeOverviewResponse {
  overview: { issue_count: number, affected_devices: number }
}
const { stats: nativeStats, statsLoading: nativeLoading, fetchStats: fetchNativeStats } = useNativeObserveStats<NativeOverviewResponse>(
  () => props.appId,
  () => ({ days: days.value, version_group: 'version' }),
  'live release native stats',
)

// Unresolved compatibility occurrences, grouped like the Compatibility tab.
const compatibilityCount = ref<number | null>(null)
async function fetchCompatibility() {
  if (!props.appId || props.forceDemo || isChannelView.value) {
    compatibilityCount.value = null
    return
  }
  const requestedAppId = props.appId
  const { data, error } = await supabase
    .from('compatibility_events')
    .select('id, platform, channel_id, current_version_id, previous_version_id, source, change_occurred_at, created_at, resolved_at')
    .eq('app_id', requestedAppId)
    .is('resolved_at', null)
  if (requestedAppId !== props.appId)
    return
  compatibilityCount.value = error ? null : groupCompatibilityEvents(data ?? []).length
}

watch(() => props.appId, () => {
  void fetchCompatibility()
}, { immediate: true })

watch(() => [props.appId, days.value, props.forceDemo] as const, () => {
  void fetchInsights()
  if (props.appId && !props.forceDemo && !isChannelView.value)
    void fetchNativeStats()
}, { immediate: true })

function formatCount(value: number | null | undefined) {
  return value === null || value === undefined ? '-' : formatNumberValue(Math.round(value))
}

function formatAction(action: string) {
  const filterKey = actionToFilter[action]
  return filterKey ? t(filterKey) : action
}

// App-wide health next to the release: what is failing, how the native app
// behaves, and whether native dependencies drifted. Each tile opens its tab.
const healthTiles = computed(() => {
  const neutral = 'text-slate-900 dark:text-white'
  const errorTotal = insights.value?.summary.total ?? null
  const topError = insights.value?.actions[0]
  return [
    {
      key: 'errors',
      label: t('overview-kpi-update-errors'),
      value: formatCount(errorTotal),
      detail: topError
        ? `${formatAction(topError.action)} · ${t('affected-devices-count', { count: formatCount(insights.value?.summary.device_count ?? 0) })}`
        : t('affected-devices-count', { count: formatCount(insights.value?.summary.device_count ?? 0) }),
      valueClass: neutral,
      help: undefined as string | undefined,
      to: { path: `${basePath.value}/observe/errors`, query: periodQuery.value },
      loading: insightsLoading.value && !insights.value,
    },
    {
      key: 'native',
      label: t('native-observe-issues'),
      value: formatCount(nativeStats.value?.overview.issue_count),
      detail: t('native-observe-signal-devices-count', { count: formatCount(nativeStats.value?.overview.affected_devices ?? 0) }),
      // Signals include routine events (JavaScript errors, WebView reloads), so
      // they are shown as plain counts to compare between releases, never as a
      // score or in warning colors.
      valueClass: neutral,
      help: t('native-observe-signals-help'),
      to: { path: `${basePath.value}/observe/native`, query: periodQuery.value },
      loading: nativeLoading.value && !nativeStats.value,
    },
    {
      key: 'compatibility',
      label: t('compatibility'),
      value: compatibilityCount.value === null ? '-' : formatCount(compatibilityCount.value),
      detail: t('overview-kpi-unresolved'),
      valueClass: compatibilityCount.value ? 'text-amber-600 dark:text-amber-400' : (compatibilityCount.value === 0 ? 'text-emerald-600 dark:text-emerald-400' : neutral),
      help: undefined as string | undefined,
      to: { path: `${basePath.value}/observe/compatibility` },
      loading: false,
    },
  ]
})
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="app-overview">
    <ReleaseLivePanel
      :app-id="appId"
      :channel-id="channelId"
      :force-demo="forceDemo"
      dense
      @live="live = $event"
    >
      <template #actions>
        <AlertsMenu
          v-if="!forceDemo && !isChannelView"
          :app-id="appId"
          :release="live?.release ?? null"
          :adoption-percent="live?.adoption?.percent ?? null"
          :rollout="live?.rollout ?? null"
          @deployed="emit('deployed')"
        />
        <PeriodDaySelector v-model="days" />
      </template>
    </ReleaseLivePanel>

    <div v-if="!isChannelView" class="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="overview-kpis">
      <RouterLink
        v-for="tile in healthTiles"
        :key="tile.key"
        :to="tile.to"
        class="flex items-center justify-between min-w-0 gap-3 px-4 py-2 transition-colors bg-white border shadow-sm group rounded-xl border-slate-200 hover:border-azure-400 dark:bg-slate-800/60 dark:border-white/10 dark:hover:border-azure-500/60"
        :data-testid="`overview-kpi-${tile.key}`"
        :title="tile.help"
      >
        <span class="flex flex-col min-w-0">
          <span class="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
            <span class="truncate">{{ tile.label }}</span>
            <IconArrowRight class="w-3.5 h-3.5 opacity-0 transition-opacity shrink-0 group-hover:opacity-100" />
          </span>
          <span class="text-xs truncate text-slate-500 dark:text-slate-400">{{ tile.detail || '\u00A0' }}</span>
        </span>
        <Spinner v-if="tile.loading" size="w-5 h-5" />
        <span v-else class="text-2xl font-semibold shrink-0" :class="tile.valueClass">{{ tile.value }}</span>
      </RouterLink>
    </div>

    <div class="grid grid-cols-1 gap-3 xl:grid-cols-3">
      <div v-if="channelId !== undefined">
        <ChannelVersionChart :app-id="appId" :channel-id="channelId" :days="days" />
      </div>
      <DevicesStats
        v-else
        :app-id="appId"
        usage-kind="bundle"
        variant="chart"
        :use-billing-period="false"
        :accumulated="false"
        :force-demo="forceDemo"
        :device-data-collection="deviceDataCollection"
      />
      <BundleInstallStatsPanel :app-id="appId" :channel-id="channelId" :days="days" :force-demo="forceDemo" hide-period-selector dense />
      <DeliveryLatencyPanel :key="appId" scope="app" :app-id="appId" :days="days" :force-demo="forceDemo" hide-period-selector dense />
    </div>
  </div>
</template>

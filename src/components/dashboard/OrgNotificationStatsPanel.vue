<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconBell from '~icons/heroicons/bell'
import IconRefresh from '~icons/lucide/refresh-cw'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import Spinner from '~/components/Spinner.vue'
import { formatNumberValue } from '~/services/formatLocale'
import { defaultApiHost, useSupabase } from '~/services/supabase'

type PeriodDayOption = 1 | 3 | 7 | 30

interface NotificationStat {
  event: string
  count: number
}

interface OrgNotificationStatsResponse {
  data: NotificationStat[]
  overview: {
    apps: number
    campaigns: number
    configured_providers: number
    total_events: number
  }
}

const props = withDefaults(defineProps<{
  orgId?: string
  forceDemo?: boolean
}>(), {
  orgId: '',
  forceDemo: false,
})

const { t } = useI18n()
const supabase = useSupabase()
const localDays = ref<PeriodDayOption>(7)
const stats = ref<NotificationStat[]>([])
const overview = ref<OrgNotificationStatsResponse['overview']>({
  apps: 0,
  campaigns: 0,
  configured_providers: 0,
  total_events: 0,
})
const loading = ref(false)
const error = ref(false)

const hasStats = computed(() => stats.value.length > 0)

const demoStats = computed<OrgNotificationStatsResponse>(() => {
  const eventCounts: NotificationStat[] = [
    { event: 'sent', count: 1280 },
    { event: 'delivered', count: 1142 },
    { event: 'opened', count: 486 },
    { event: 'failed', count: 38 },
  ]
  return {
    data: eventCounts,
    overview: {
      apps: 3,
      campaigns: 12,
      configured_providers: 4,
      total_events: eventCounts.reduce((sum, item) => sum + item.count, 0),
    },
  }
})

const effectiveStats = computed(() => props.forceDemo ? demoStats.value.data : stats.value)
const effectiveOverview = computed(() => props.forceDemo ? demoStats.value.overview : overview.value)
const effectiveTotal = computed(() => effectiveOverview.value.total_events)
const effectiveHasStats = computed(() => effectiveStats.value.length > 0)

function formatCount(value: number | null | undefined) {
  return formatNumberValue(value ?? 0)
}

function selectPeriod(option: PeriodDayOption) {
  if (localDays.value === option)
    return
  localDays.value = option
}

async function fetchStats() {
  if (props.forceDemo)
    return
  if (!props.orgId) {
    stats.value = []
    overview.value = { apps: 0, campaigns: 0, configured_providers: 0, total_events: 0 }
    error.value = false
    loading.value = false
    return
  }

  loading.value = true
  error.value = false
  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    if (!token) {
      error.value = true
      toast.error(t('not-authenticated'))
      return
    }

    const response = await fetch(
      `${defaultApiHost}/notifications/stats?org_id=${encodeURIComponent(props.orgId)}&days=${localDays.value}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    )
    if (!response.ok)
      throw new Error(await response.text())

    const body = await response.json() as OrgNotificationStatsResponse
    stats.value = body.data ?? []
    overview.value = body.overview ?? {
      apps: 0,
      campaigns: 0,
      configured_providers: 0,
      total_events: (body.data ?? []).reduce((sum, item) => sum + Number(item.count || 0), 0),
    }
  }
  catch (err) {
    console.error(err)
    error.value = true
    stats.value = []
    overview.value = { apps: 0, campaigns: 0, configured_providers: 0, total_events: 0 }
  }
  finally {
    loading.value = false
  }
}

watch(
  () => [props.orgId, props.forceDemo, localDays.value] as const,
  async () => {
    await fetchStats()
  },
  { immediate: true },
)
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="org-notification-stats">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
            {{ t('org-notification-stats-title') }}
          </h2>
          <span class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-azure-500/40 bg-azure-500/10 text-azure-700 dark:text-azure-200">{{ t('beta') }}</span>
          <span
            v-if="forceDemo"
            class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ t('demo') }}
          </span>
        </div>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('org-notification-stats-help') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <PeriodDaySelector
          :model-value="localDays"
          @update:model-value="selectPeriod"
        />
        <button
          type="button"
          class="d-btn d-btn-sm d-btn-outline"
          :disabled="loading || forceDemo"
          :aria-label="t('refresh')"
          @click="fetchStats"
        >
          <span v-if="loading" class="d-loading d-loading-spinner d-loading-xs" />
          <IconRefresh v-else class="w-4 h-4" aria-hidden="true" />
          {{ t('refresh') }}
        </button>
      </div>
    </div>

    <div v-if="loading && !forceDemo && !error && !hasStats" class="flex items-center justify-center h-64 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
      <Spinner size="w-10 h-10" />
    </div>

    <div
      v-else-if="error && !forceDemo"
      class="flex flex-col items-center justify-center h-64 gap-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
    >
      <IconBell class="w-12 h-12" />
      <h3 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
        {{ t('notification-load-error') }}
      </h3>
      <button type="button" class="d-btn d-btn-sm d-btn-primary" @click="fetchStats">
        {{ t('refresh') }}
      </button>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ t('org-notification-total-events') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
            {{ formatCount(effectiveTotal) }}
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ t('notification-campaigns') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
            {{ formatCount(effectiveOverview.campaigns) }}
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ t('notification-configured-providers') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
            {{ formatCount(effectiveOverview.configured_providers) }}
          </div>
        </div>
        <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
          <div class="text-sm truncate text-slate-600 dark:text-slate-400">
            {{ t('org-notification-apps') }}
          </div>
          <div class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
            {{ formatCount(effectiveOverview.apps) }}
          </div>
        </div>
      </div>

      <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
        <div class="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 class="text-base font-semibold text-slate-950 dark:text-white">
              {{ t('notification-stats') }}
            </h3>
            <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {{ t('org-notification-events-help', { days: localDays }) }}
            </p>
          </div>
          <IconBell class="w-5 h-5 text-sky-500" aria-hidden="true" />
        </div>

        <div v-if="loading && !forceDemo" class="flex items-center justify-center h-10 mb-3 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size="w-5 h-5" />
        </div>

        <div v-if="!effectiveHasStats" class="flex flex-col items-center justify-center h-56 text-slate-500 dark:text-slate-400">
          <IconBell class="w-12 h-12 mb-3" />
          <h3 class="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {{ t('notification-no-stats') }}
          </h3>
          <p class="mt-1 text-sm text-center text-slate-500 dark:text-slate-400 max-w-lg">
            {{ t('org-notification-no-stats-help') }}
          </p>
        </div>
        <div v-else class="space-y-3">
          <div v-for="stat in effectiveStats" :key="stat.event" class="space-y-1">
            <div class="flex items-center justify-between gap-3 text-sm">
              <span class="font-medium text-slate-700 dark:text-slate-200">{{ stat.event }}</span>
              <span class="font-mono tabular-nums text-slate-950 dark:text-white">{{ formatCount(stat.count) }}</span>
            </div>
            <progress
              class="w-full h-1.5 d-progress d-progress-secondary"
              :value="stat.count"
              :max="effectiveTotal || 1"
            />
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconAlertCircle from '~icons/lucide/alert-circle'
import IconCheckCircle from '~icons/lucide/check-circle'
import PeriodDaySelector from '~/components/dashboard/PeriodDaySelector.vue'
import Spinner from '~/components/Spinner.vue'
import { buildDemoBundleInstallStats, useBundleInstallStats } from '~/composables/useBundleInstallStats'
import { usePeriodDaysQuery } from '~/composables/usePeriodDaysQuery'
import { formatLocalDateShort } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useSupabase } from '~/services/supabase'

type PeriodDayOption = 1 | 3 | 7 | 30

const props = withDefaults(defineProps<{
  appId: string
  channelId?: number
  versionName?: string
  forceDemo?: boolean
  days?: number
  hidePeriodSelector?: boolean
  compact?: boolean
}>(), {
  channelId: undefined,
  versionName: '',
  forceDemo: false,
  hidePeriodSelector: false,
  compact: false,
})

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()
const { days: queryDays } = usePeriodDaysQuery()
const days = computed(() => props.days ?? queryDays.value)
const bundleIdCache = ref<Record<string, number>>({})

const { stats, statsLoading, statsError, fetchStats } = useBundleInstallStats(() => ({
  app_id: props.appId,
  days: days.value,
  channel_id: props.channelId,
  version_name: props.versionName || undefined,
}))

const demoStats = computed(() => buildDemoBundleInstallStats(days.value))
const effectiveStats = computed(() => props.forceDemo ? demoStats.value : stats.value)

const bundles = computed(() => effectiveStats.value?.bundles ?? [])
const hasData = computed(() => bundles.value.some(bundle => bundle.install + bundle.fail > 0 || bundle.timing.samples > 0))

const periodLabel = computed(() => {
  if (days.value === 1)
    return t('last-one-day')
  return t('last-n-days', { days: days.value })
})

const periodRangeLabel = computed(() => {
  const period = effectiveStats.value?.period
  if (!period)
    return '-'
  return `${formatLocalDateShort(period.start) || '-'} - ${formatLocalDateShort(period.end) || '-'}`
})

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '-'
  return `${formatNumberValue(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function formatCount(value: number | null | undefined) {
  return formatNumberValue(value ?? 0)
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '-'
  if (value >= 1000)
    return `${formatNumberValue(value / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
  return `${formatNumberValue(value)} ms`
}

function successRateClass(rate: number | null) {
  if (rate === null)
    return 'text-slate-500 dark:text-slate-400'
  if (rate >= 95)
    return 'text-emerald-600 dark:text-emerald-400'
  if (rate >= 85)
    return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

async function navigateToBundle(versionName: string) {
  if (!props.appId)
    return
  if (bundleIdCache.value[versionName]) {
    router.push(`/app/${props.appId}/bundle/${bundleIdCache.value[versionName]}`)
    return
  }
  const { data } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', props.appId)
    .eq('name', versionName)
    .limit(1)
    .single()
  if (data?.id) {
    bundleIdCache.value[versionName] = data.id
    router.push(`/app/${props.appId}/bundle/${data.id}`)
  }
}

function selectPeriod(option: PeriodDayOption) {
  if (props.days !== undefined)
    return
  queryDays.value = option
}

watch(
  () => [props.appId, props.channelId, props.versionName, props.forceDemo, days.value] as const,
  async () => {
    if (props.forceDemo)
      return
    await fetchStats()
  },
  { immediate: true },
)
</script>

<template>
  <section class="flex flex-col gap-4" data-testid="bundle-install-stats">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
            {{ t('bundle-install-stats-title') }}
          </h2>
          <span
            v-if="forceDemo"
            class="px-2 py-0.5 text-[10px] font-semibold uppercase rounded border border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
          >
            {{ t('demo') }}
          </span>
        </div>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {{ t('bundle-install-stats-help') }}
        </p>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ periodLabel }} · {{ periodRangeLabel }}
        </p>
      </div>
      <PeriodDaySelector
        v-if="!hidePeriodSelector && props.days === undefined"
        :model-value="queryDays"
        :labels="{ 30: 'max-period' }"
        @update:model-value="selectPeriod"
      />
    </div>

    <div
      v-if="effectiveStats?.totals && hasData && !compact"
      class="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
        <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <IconCheckCircle class="w-4 h-4" />
          {{ t('bundle-install-success-rate') }}
        </div>
        <div class="mt-2 text-2xl font-semibold" :class="successRateClass(effectiveStats.totals.success_rate)">
          {{ formatPercent(effectiveStats.totals.success_rate) }}
        </div>
        <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {{ t('bundle-install-success-rate-help') }}
        </p>
      </div>
      <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
        <div class="text-sm text-slate-600 dark:text-slate-400">
          {{ t('installed') }} / {{ t('failed') }}
        </div>
        <div class="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
          {{ formatCount(effectiveStats.totals.install) }} / {{ formatCount(effectiveStats.totals.fail) }}
        </div>
      </div>
    </div>

    <div v-if="statsLoading && !forceDemo && !stats && !statsError" class="flex items-center justify-center h-48 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
      <Spinner size="w-10 h-10" />
    </div>

    <div
      v-else-if="statsError && !forceDemo"
      class="flex flex-col items-center justify-center h-48 gap-3 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
    >
      <IconAlertCircle class="w-10 h-10" />
      <p class="text-sm">
        {{ t('bundle-install-stats-fetch-error') }}
      </p>
      <button type="button" class="d-btn d-btn-sm d-btn-primary" @click="fetchStats">
        {{ t('update-delivery-retry') }}
      </button>
    </div>

    <div
      v-else-if="!hasData"
      class="flex flex-col items-center justify-center h-48 gap-2 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
    >
      <IconAlertCircle class="w-10 h-10" />
      <p>{{ t('bundle-install-stats-no-data') }}</p>
      <p class="text-sm text-center max-w-lg">
        {{ t('bundle-install-stats-no-data-help') }}
      </p>
    </div>

    <div
      v-else
      class="overflow-x-auto bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700"
    >
      <table class="min-w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200 dark:border-slate-700 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('bundle') }}
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('bundle-install-success-rate') }}
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('installed') }} / {{ t('failed') }}
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('bundle-install-p50') }}
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('bundle-install-p70') }}
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('bundle-install-p90') }}
            </th>
            <th scope="col" class="px-4 py-3 font-semibold">
              {{ t('bundle-install-p95') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="bundle in bundles"
            :key="bundle.version_name"
            class="border-b border-slate-100 dark:border-slate-700/70 last:border-b-0"
          >
            <td class="px-4 py-3">
              <button
                type="button"
                class="font-medium text-left text-azure-600 hover:underline dark:text-azure-400"
                @click="navigateToBundle(bundle.version_name)"
              >
                {{ bundle.version_name }}
              </button>
            </td>
            <td class="px-4 py-3 font-semibold" :class="successRateClass(bundle.success_rate)">
              {{ formatPercent(bundle.success_rate) }}
            </td>
            <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
              {{ formatCount(bundle.install) }} / {{ formatCount(bundle.fail) }}
            </td>
            <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
              {{ formatDuration(bundle.timing.p50_ms) }}
            </td>
            <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
              {{ formatDuration(bundle.timing.p70_ms) }}
            </td>
            <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
              {{ formatDuration(bundle.timing.p90_ms) }}
            </td>
            <td class="px-4 py-3 text-slate-700 dark:text-slate-200">
              {{ formatDuration(bundle.timing.p95_ms) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

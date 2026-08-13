<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconSmartphone from '~icons/lucide/smartphone'
import IconTrendingUp from '~icons/lucide/trending-up'
import { getLatestDayVersionAdoption } from '~/services/bundleAdoption'
import { useChartData } from '~/services/chartDataService'
import { getChartDateRange } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useSupabase } from '~/services/supabase'

const props = withDefaults(defineProps<{
  appId: string
  versionName: string
  linkedChannelId?: number | null
  linkedChannelName?: string | null
  compact?: boolean
}>(), {
  linkedChannelId: null,
  linkedChannelName: null,
  compact: false,
})

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()

const loading = ref(true)
const adoption = ref<ReturnType<typeof getLatestDayVersionAdoption>>(null)
let requestToken = 0

const percentLabel = computed(() => {
  const percent = adoption.value?.percent ?? 0
  return `${formatNumberValue(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
})

const countLabel = computed(() => formatNumberValue(adoption.value?.count ?? 0))
const totalLabel = computed(() => formatNumberValue(adoption.value?.total ?? 0))
const progressWidth = computed(() => `${Math.max(0, Math.min(100, adoption.value?.percent ?? 0))}%`)
const hasDevices = computed(() => (adoption.value?.total ?? 0) > 0)

async function loadAdoption() {
  if (!props.appId || !props.versionName) {
    adoption.value = null
    loading.value = false
    return
  }

  const currentToken = ++requestToken
  loading.value = true
  try {
    const { startDate, endDate } = getChartDateRange(false)
    const data = await useChartData(supabase, props.appId, startDate, endDate, 'bundle')
    if (currentToken !== requestToken)
      return
    adoption.value = getLatestDayVersionAdoption(data?.datasets ?? [], props.versionName)
  }
  catch (error) {
    console.error('[BundleAdoptionCard] Failed to load adoption', error)
    if (currentToken !== requestToken)
      return
    adoption.value = {
      versionName: props.versionName,
      count: 0,
      total: 0,
      percent: 0,
    }
  }
  finally {
    if (currentToken === requestToken)
      loading.value = false
  }
}

function openDevices() {
  router.push({
    path: `/app/${props.appId}/devices`,
    query: { version: props.versionName },
  })
}

function openChannelStats() {
  if (!props.linkedChannelId)
    return
  router.push(`/app/${props.appId}/channel/${props.linkedChannelId}/statistics`)
}

watch(() => [props.appId, props.versionName] as const, () => {
  void loadAdoption()
}, { immediate: true })
</script>

<template>
  <section
    data-test="bundle-adoption-card"
    class="p-4 border rounded-lg shadow-sm"
    :class="hasDevices
      ? 'bg-sky-50 border-sky-200 dark:bg-sky-950/20 dark:border-sky-800'
      : 'bg-white border-slate-200 dark:bg-slate-800 dark:border-slate-700'"
  >
    <div class="flex flex-col gap-4" :class="{ 'lg:flex-row lg:items-center lg:justify-between': compact }">
      <div class="flex items-start gap-3 min-w-0">
        <IconTrendingUp class="w-6 h-6 mt-0.5 shrink-0 text-sky-600 dark:text-sky-300" />
        <div class="min-w-0">
          <h3 class="font-semibold text-slate-900 dark:text-white">
            {{ t('bundle-adoption') }}
          </h3>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
            <template v-if="loading">
              {{ t('loading-statistics') }}
            </template>
            <template v-else-if="hasDevices">
              {{ t('bundle-adoption-help', {
                version: versionName,
                count: countLabel,
                total: totalLabel,
                percent: percentLabel,
              }) }}
            </template>
            <template v-else>
              {{ t('bundle-adoption-empty', { version: versionName }) }}
            </template>
          </p>
        </div>
      </div>

      <div v-if="!loading" class="flex flex-col gap-3 min-w-0" :class="{ 'lg:w-80': compact }">
        <div class="flex items-baseline gap-2">
          <span class="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {{ percentLabel }}
          </span>
          <span class="text-sm text-slate-600 dark:text-slate-300">
            {{ t('bundle-adoption-devices', { count: countLabel, total: totalLabel }) }}
          </span>
        </div>
        <div
          class="w-full h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
          role="progressbar"
          :aria-label="t('bundle-adoption')"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuenow="Math.round(adoption?.percent ?? 0)"
        >
          <div class="h-full rounded-full bg-sky-500 dark:bg-sky-400" :style="{ width: progressWidth }" />
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="gap-2 d-btn d-btn-sm d-btn-outline"
            data-test="bundle-adoption-devices"
            @click="openDevices"
          >
            <IconSmartphone class="w-4 h-4" />
            {{ t('view-bundle-devices') }}
          </button>
          <button
            v-if="linkedChannelId"
            type="button"
            class="gap-2 d-btn d-btn-sm d-btn-primary"
            data-test="bundle-adoption-channel"
            @click="openChannelStats"
          >
            <IconTrendingUp class="w-4 h-4" />
            {{ linkedChannelName ? t('view-channel-adoption-named', { channel: linkedChannelName }) : t('view-channel-adoption') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

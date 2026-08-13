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
}>(), {
  linkedChannelId: null,
  linkedChannelName: null,
})

const { t } = useI18n()
const router = useRouter()
const supabase = useSupabase()

const loading = ref(true)
const loadError = ref(false)
const adoption = ref<ReturnType<typeof getLatestDayVersionAdoption>>(null)
let requestToken = 0

const percentLabel = computed(() => {
  const percent = adoption.value?.percent ?? 0
  return `${formatNumberValue(percent, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
})

const countLabel = computed(() => formatNumberValue(adoption.value?.count ?? 0))
const totalLabel = computed(() => formatNumberValue(adoption.value?.total ?? 0))
const hasDevices = computed(() => (adoption.value?.total ?? 0) > 0)

async function loadAdoption() {
  if (!props.appId || !props.versionName) {
    adoption.value = null
    loadError.value = false
    loading.value = false
    return
  }

  const currentToken = ++requestToken
  loading.value = true
  loadError.value = false
  try {
    const { startDate, endDate } = getChartDateRange(false)
    const data = await useChartData(supabase, props.appId, startDate, endDate, 'bundle')
    if (currentToken !== requestToken)
      return
    if (!data) {
      loadError.value = true
      adoption.value = null
      return
    }
    adoption.value = getLatestDayVersionAdoption(data.datasets ?? [], props.versionName)
  }
  catch (error) {
    console.error('[BundleAdoptionCard] Failed to load adoption', error)
    if (currentToken !== requestToken)
      return
    loadError.value = true
    adoption.value = null
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
  <div
    data-test="bundle-adoption-card"
    class="flex flex-col gap-3 py-3 min-h-24 sm:flex-row sm:items-center sm:justify-between"
  >
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-slate-900 dark:text-white">
          {{ versionName }}
        </span>
        <span
          v-if="linkedChannelName"
          class="text-sm text-slate-500 dark:text-slate-400"
        >
          {{ linkedChannelName }}
        </span>
      </div>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
        <template v-if="loading">
          {{ t('loading-statistics') }}
        </template>
        <template v-else-if="loadError">
          {{ t('bundle-adoption-error', { version: versionName }) }}
        </template>
        <template v-else-if="hasDevices">
          {{ t('bundle-adoption-help', {
            version: versionName,
            count: countLabel,
            total: totalLabel,
          }) }}
        </template>
        <template v-else>
          {{ t('bundle-adoption-empty', { version: versionName }) }}
        </template>
      </p>
    </div>

    <div
      v-if="!loading && !loadError"
      class="flex flex-col gap-2 min-w-0 sm:w-72 shrink-0"
    >
      <div class="flex items-baseline gap-2">
        <span class="text-lg font-semibold tabular-nums text-slate-900 dark:text-white">
          {{ percentLabel }}
        </span>
        <span class="text-sm tabular-nums text-slate-500 dark:text-slate-400">
          {{ t('bundle-adoption-devices', { count: countLabel, total: totalLabel }) }}
        </span>
      </div>
      <progress
        class="w-full h-1.5 d-progress d-progress-secondary"
        :value="hasDevices ? (adoption?.percent ?? 0) : 0"
        max="100"
        :aria-label="t('bundle-adoption')"
      />
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="gap-2 min-h-11 d-btn d-btn-sm d-btn-outline"
          data-test="bundle-adoption-devices"
          @click="openDevices"
        >
          <IconSmartphone class="w-4 h-4" />
          {{ t('view-bundle-devices') }}
        </button>
        <button
          v-if="linkedChannelId"
          type="button"
          class="gap-2 min-h-11 d-btn d-btn-sm d-btn-ghost"
          data-test="bundle-adoption-channel"
          @click="openChannelStats"
        >
          <IconTrendingUp class="w-4 h-4" />
          {{ linkedChannelName ? t('view-channel-adoption-named', { channel: linkedChannelName }) : t('view-channel-adoption') }}
        </button>
      </div>
    </div>
  </div>
</template>

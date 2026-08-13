<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconPackage from '~icons/lucide/package'
import { getLatestDayVersionAdoption } from '~/services/bundleAdoption'
import { useChartData } from '~/services/chartDataService'
import { getChartDateRange } from '~/services/date'
import { formatNumberValue } from '~/services/formatLocale'
import { useSupabase } from '~/services/supabase'

const props = defineProps<{
  appId: string
  versionName: string
  linkedChannelId?: number | null
}>()

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

const valueLabel = computed(() => {
  if (loading.value || loadError.value || !hasDevices.value)
    return '—'
  return percentLabel.value
})

const detailLabel = computed(() => {
  if (loading.value)
    return t('loading-statistics')
  if (loadError.value)
    return t('bundle-adoption-error', { version: props.versionName })
  if (!hasDevices.value)
    return t('bundle-adoption-empty', { version: props.versionName })
  return `${t('bundle-adoption-devices', { count: countLabel.value, total: totalLabel.value })} · ${props.versionName}`
})

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

function openAnalytics() {
  if (props.linkedChannelId) {
    router.push(`/app/${props.appId}/channel/${props.linkedChannelId}/statistics`)
    return
  }
  router.push({
    path: `/app/${props.appId}/devices`,
    query: { version: props.versionName },
  })
}

watch(() => [props.appId, props.versionName] as const, () => {
  void loadAdoption()
}, { immediate: true })
</script>

<template>
  <button
    type="button"
    data-test="bundle-adoption-card"
    class="p-4 text-left bg-white border rounded-lg shadow-sm cursor-pointer dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/40"
    @click="openAnalytics"
  >
    <div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
      <IconPackage class="w-4 h-4" />
      {{ t('bundle-adoption') }}
    </div>
    <div class="mt-2 text-lg font-semibold tabular-nums text-slate-900 dark:text-white">
      {{ valueLabel }}
    </div>
    <div class="mt-1 text-xs truncate text-slate-500 dark:text-slate-400">
      {{ detailLabel }}
    </div>
  </button>
</template>

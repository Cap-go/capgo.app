<script setup lang="ts">
import type { LocationQueryRaw } from 'vue-router'
import type { DateRangeMode } from '~/stores/adminDashboard'
import { useMutationObserver } from '@vueuse/core'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import ArrowPathIconSolid from '~icons/heroicons/arrow-path-solid'
import DateRangePicker from '~/components/DateRangePicker.vue'
import {
  parseDateRangeQuery,
  serializeDateRangeQuery,
} from '~/services/dateRange'
import {
  getDateRangeForMode,
  useAdminDashboardStore,
} from '~/stores/adminDashboard'

defineProps<{
  hideDatePicker?: boolean
}>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const adminStore = useAdminDashboardStore()

function storeMatchesQuery() {
  const parsed = parseDateRangeQuery(route.query)
  if (!parsed)
    return false
  if (parsed.mode !== adminStore.dateRangeMode)
    return false
  if (parsed.mode !== 'custom')
    return true
  return parsed.start.getTime() === adminStore.customDateRange.start.getTime()
    && parsed.end.getTime() === adminStore.customDateRange.end.getTime()
}

function applyQueryToStore() {
  const parsed = parseDateRangeQuery(route.query)
  if (!parsed || storeMatchesQuery())
    return
  if (parsed.mode === 'custom')
    adminStore.setCustomDateRange(parsed.start, parsed.end)
  else
    adminStore.setDateRangeMode(parsed.mode)
}

// Hydrate before first paint/fetch so reloads restore the selected timeframe.
applyQueryToStore()

const rangeMode = ref<DateRangeMode>(adminStore.dateRangeMode)
const rangeValue = ref<[Date, Date] | null>([
  adminStore.activeDateRange.start,
  adminStore.activeDateRange.end,
])
const isDark = ref(false)
let prefersDarkQuery: MediaQueryList | null = null

function syncThemeFromHtml() {
  const root = document.documentElement
  const theme = root.dataset.theme
  prefersDarkQuery ??= window.matchMedia('(prefers-color-scheme: dark)')
  isDark.value = root.classList.contains('dark')
    || theme === 'capgodark'
    || (theme !== 'capgolight' && prefersDarkQuery.matches)
}

onMounted(() => {
  syncThemeFromHtml()
  prefersDarkQuery?.addEventListener('change', syncThemeFromHtml)
})
onUnmounted(() => {
  prefersDarkQuery?.removeEventListener('change', syncThemeFromHtml)
})
useMutationObserver(
  document.documentElement,
  syncThemeFromHtml,
  { attributes: true, attributeFilter: ['class', 'data-theme'] },
)

function syncFromStore() {
  rangeMode.value = adminStore.dateRangeMode
  if (adminStore.dateRangeMode === 'custom') {
    const { start, end } = adminStore.activeDateRange
    rangeValue.value = [new Date(start), new Date(end)]
    return
  }
  const rolling = getDateRangeForMode(adminStore.dateRangeMode)
  rangeValue.value = [rolling.start, rolling.end]
}

function syncStoreToQuery() {
  const serialized = serializeDateRangeQuery(
    adminStore.dateRangeMode,
    adminStore.customDateRange,
  )
  const currentRange = typeof route.query.range === 'string' ? route.query.range : undefined
  const currentStart = typeof route.query.start === 'string' ? route.query.start : undefined
  const currentEnd = typeof route.query.end === 'string' ? route.query.end : undefined
  if (
    currentRange === serialized.range
    && currentStart === serialized.start
    && currentEnd === serialized.end
  ) {
    return
  }

  const nextQuery: LocationQueryRaw = { ...route.query }
  nextQuery.range = serialized.range
  if (serialized.start && serialized.end) {
    nextQuery.start = serialized.start
    nextQuery.end = serialized.end
  }
  else {
    delete nextQuery.start
    delete nextQuery.end
  }

  void router.replace({ query: nextQuery })
}

function onApply(payload: { start: Date, end: Date, mode: DateRangeMode }) {
  rangeMode.value = payload.mode
  rangeValue.value = [payload.start, payload.end]
  if (payload.mode === 'custom')
    adminStore.setCustomDateRange(payload.start, payload.end)
  else
    adminStore.setDateRangeMode(payload.mode)
}

function handleRefresh() {
  adminStore.invalidateCache()
  syncFromStore()
}

watch(
  () => [
    adminStore.dateRangeMode,
    adminStore.customDateRange.start.getTime(),
    adminStore.customDateRange.end.getTime(),
    adminStore.activeDateRange.start.getTime(),
    adminStore.activeDateRange.end.getTime(),
  ] as const,
  syncFromStore,
)

watch(
  () => [
    adminStore.dateRangeMode,
    adminStore.customDateRange.start.getTime(),
    adminStore.customDateRange.end.getTime(),
  ] as const,
  syncStoreToQuery,
  { immediate: true },
)

watch(
  () => [route.query.range, route.query.start, route.query.end] as const,
  () => {
    applyQueryToStore()
    syncFromStore()
  },
)
</script>

<template>
  <div class="mb-4">
    <div class="flex items-center justify-end gap-2">
      <DateRangePicker
        v-if="!hideDatePicker"
        v-model="rangeValue"
        v-model:mode="rangeMode"
        @apply="onApply"
      />

      <button
        type="button"
        class="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
        :class="isDark
          ? 'border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-800'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'"
        :aria-label="t('reload')"
        @click="handleRefresh"
      >
        <ArrowPathIconSolid class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

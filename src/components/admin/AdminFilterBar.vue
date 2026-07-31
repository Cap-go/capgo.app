<script setup lang="ts">
import type { DateRangeMode } from '~/stores/adminDashboard'
import { useMutationObserver } from '@vueuse/core'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ArrowPathIconSolid from '~icons/heroicons/arrow-path-solid'
import DateRangePicker from '~/components/DateRangePicker.vue'
import {
  getDateRangeForMode,
  useAdminDashboardStore,
} from '~/stores/adminDashboard'

const { t } = useI18n()
const adminStore = useAdminDashboardStore()

const rangeMode = ref<DateRangeMode>(adminStore.dateRangeMode)
const rangeValue = ref<[Date, Date] | null>([
  adminStore.activeDateRange.start,
  adminStore.activeDateRange.end,
])
const isDark = ref(false)

function syncThemeFromHtml() {
  const root = document.documentElement
  isDark.value = root.classList.contains('dark')
    || root.dataset.theme === 'capgodark'
}

onMounted(syncThemeFromHtml)
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
</script>

<template>
  <div class="mb-4">
    <div class="flex items-center justify-end gap-2">
      <DateRangePicker
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

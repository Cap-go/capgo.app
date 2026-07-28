<script setup lang="ts">
import type { DateRangeMode } from '~/stores/adminDashboard'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import { onClickOutside, useDark } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ArrowPathIconSolid from '~icons/heroicons/arrow-path-solid'
import CalendarDaysIcon from '~icons/heroicons/calendar-days'
import ClockIcon from '~icons/heroicons/clock'
import { formatLocalDateTime } from '~/services/date'
import { useAdminDashboardStore } from '~/stores/adminDashboard'
import '@vuepic/vue-datepicker/dist/main.css'

const { t } = useI18n()
const adminStore = useAdminDashboardStore()
const isDark = useDark()

const presets = computed(() => [
  { mode: '30min', label: t('last-30-minutes') },
  { mode: '1h', label: t('last-1-hour') },
  { mode: '6h', label: t('last-6-hours') },
  { mode: '12h', label: t('last-12-hours') },
  { mode: '24h', label: t('last-24-hours') },
  { mode: '3day', label: t('3-days') },
  { mode: '7day', label: t('7-days') },
  { mode: '14day', label: t('14-days') },
  { mode: '30day', label: t('30-days') },
  { mode: '90day', label: t('90-days') },
  { mode: 'quarter', label: t('last-quarter') },
  { mode: '6month', label: t('last-6-months') },
  { mode: '12month', label: t('last-12-months') },
] as const)

function computeRangeForMode(mode: DateRangeMode, now = new Date()): [Date, Date] {
  switch (mode) {
    case '30min':
      return [new Date(now.getTime() - 30 * 60 * 1000), now]
    case '1h':
      return [new Date(now.getTime() - 60 * 60 * 1000), now]
    case '6h':
      return [new Date(now.getTime() - 6 * 60 * 60 * 1000), now]
    case '12h':
      return [new Date(now.getTime() - 12 * 60 * 60 * 1000), now]
    case '24h':
      return [new Date(now.getTime() - 24 * 60 * 60 * 1000), now]
    case '3day':
      return [new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), now]
    case '7day':
      return [new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), now]
    case '14day':
      return [new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), now]
    case '30day':
      return [new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), now]
    case '90day':
    case 'quarter':
      return [new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), now]
    case '6month':
      return [new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000), now]
    case '12month':
      return [new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), now]
    case 'custom':
      return [adminStore.customDateRange.start, adminStore.customDateRange.end]
    default:
      return [new Date(now.getTime() - 24 * 60 * 60 * 1000), now]
  }
}

function rangesMatch(a: [Date, Date], b: [Date, Date], toleranceMs = 60_000): boolean {
  return Math.abs(a[0].getTime() - b[0].getTime()) <= toleranceMs
    && Math.abs(a[1].getTime() - b[1].getTime()) <= toleranceMs
}

const triggerLabel = computed(() => {
  const mode = adminStore.dateRangeMode
  const preset = presets.value.find(p => p.mode === mode)
  if (preset)
    return preset.label

  const { start, end } = adminStore.activeDateRange
  return `${formatLocalDateTime(start)} - ${formatLocalDateTime(end)}`
})

const isOpen = ref(false)
const pickerContainer = ref<HTMLElement | null>(null)
onClickOutside(pickerContainer, () => {
  isOpen.value = false
})

const pickerRange = ref<Date[]>(computeRangeForMode(adminStore.dateRangeMode))

const selectedMode = computed<DateRangeMode>(() => {
  const current = pickerRange.value
  if (!current || current.length < 2)
    return 'custom'
  for (const preset of presets.value) {
    if (rangesMatch(current as [Date, Date], computeRangeForMode(preset.mode)))
      return preset.mode
  }
  return 'custom'
})

function openPicker() {
  pickerRange.value = [
    new Date(adminStore.activeDateRange.start),
    new Date(adminStore.activeDateRange.end),
  ]
  isOpen.value = true
}

function selectPreset(mode: DateRangeMode) {
  pickerRange.value = computeRangeForMode(mode)
}

function apply() {
  const [start, end] = pickerRange.value
  if (selectedMode.value === 'custom') {
    adminStore.setCustomDateRange(start, end)
  }
  else {
    adminStore.setDateRangeMode(selectedMode.value)
  }
  isOpen.value = false
}

function handleRefresh() {
  adminStore.invalidateCache()
}
</script>

<template>
  <div class="mb-4">
    <div class="flex items-center justify-end gap-2 flex-nowrap sm:gap-4">
      <!-- Date Range Picker -->
      <div ref="pickerContainer" class="relative flex items-center">
        <label for="admin-date-range" class="sr-only">{{ t('date-range') }}</label>
        <CalendarDaysIcon class="absolute w-4 h-4 text-gray-500 pointer-events-none left-3 dark:text-gray-400" />
        <button
          id="admin-date-range"
          type="button"
          class="inline-flex items-center gap-2 py-2 pr-3 text-sm font-medium text-gray-900 bg-white border border-gray-300 rounded-lg appearance-none cursor-pointer pl-9 hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:text-white dark:bg-gray-700 dark:border-gray-600 dark:hover:bg-gray-600 dark:focus:ring-blue-400"
          :aria-label="t('date-range')"
          @click="openPicker"
        >
          <span class="truncate max-w-[12rem] sm:max-w-[16rem]">{{ triggerLabel }}</span>
          <svg class="w-4 h-4 text-gray-500 dark:text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div
          v-if="isOpen"
          class="absolute right-0 top-full z-50 mt-2 w-[min(840px,95vw)] rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-800"
        >
          <div class="flex flex-col gap-4 md:flex-row">
            <div class="flex-1 min-w-0">
              <VueDatePicker
                v-model="pickerRange"
                inline
                range
                :dark="isDark"
                :max-date="new Date()"
              />
            </div>
            <div class="w-full border-t border-gray-200 dark:border-gray-700 md:w-56 md:border-t-0 md:border-l md:max-h-[20rem] md:overflow-y-auto">
              <div class="flex flex-col gap-1 py-2 md:px-2 md:py-0">
                <button
                  v-for="preset in presets"
                  :key="preset.mode"
                  type="button"
                  class="rounded-lg px-3 py-2 text-left text-sm transition-colors"
                  :class="selectedMode === preset.mode
                    ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'"
                  @click="selectPreset(preset.mode)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>
          </div>

          <div class="mt-4 flex flex-col gap-3 border-t border-gray-200 pt-4 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex flex-1 items-center gap-2">
              <div class="flex flex-1 items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-700">
                <CalendarDaysIcon class="w-4 h-4 text-gray-500 shrink-0 dark:text-gray-400" />
                <ClockIcon class="w-4 h-4 text-gray-500 shrink-0 dark:text-gray-400" />
                <span class="truncate text-sm text-gray-900 dark:text-white">{{ formatLocalDateTime(pickerRange[0]) }}</span>
              </div>
              <span class="text-gray-400">→</span>
              <div class="flex flex-1 items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-700">
                <CalendarDaysIcon class="w-4 h-4 text-gray-500 shrink-0 dark:text-gray-400" />
                <ClockIcon class="w-4 h-4 text-gray-500 shrink-0 dark:text-gray-400" />
                <span class="truncate text-sm text-gray-900 dark:text-white">{{ formatLocalDateTime(pickerRange[1]) }}</span>
              </div>
            </div>
            <button
              type="button"
              class="d-btn d-btn-primary d-btn-sm whitespace-nowrap"
              @click="apply"
            >
              {{ t('apply') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Reload Button -->
      <button
        type="button"
        class="flex items-center justify-center w-8 h-8 text-gray-700 transition-colors bg-white border border-gray-300 rounded-lg cursor-pointer sm:w-9 sm:h-9 dark:text-gray-200 dark:bg-gray-700 dark:border-gray-600 hover:text-gray-900 hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:hover:bg-gray-600 dark:hover:text-white dark:focus:ring-blue-400"
        :aria-label="t('reload')"
        @click="handleRefresh"
      >
        <ArrowPathIconSolid class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

<style scoped>
:deep(.dp__main) {
  font-family: inherit;
}
:deep(.dp__theme_dark) {
  --dp-background-color: rgb(31 41 55);
  --dp-cell-size: 34px;
}
:deep(.dp__theme_light) {
  --dp-cell-size: 34px;
}
</style>

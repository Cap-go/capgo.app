<script setup lang="ts">
import type { DateRangeMode } from '~/stores/adminDashboard'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import { onClickOutside, onKeyStroke, useDark } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ArrowPathIconSolid from '~icons/heroicons/arrow-path-solid'
import CalendarDaysIcon from '~icons/heroicons/calendar-days'
import { formatLocalDateTime } from '~/services/date'
import {
  getDateRangeForMode,
  useAdminDashboardStore,
} from '~/stores/adminDashboard'
import '@vuepic/vue-datepicker/dist/main.css'

const { t } = useI18n()
const adminStore = useAdminDashboardStore()
const isDark = useDark()

const presets = computed(() => [
  { mode: '30min' as const, label: t('last-30-minutes') },
  { mode: '1h' as const, label: t('last-1-hour') },
  { mode: '6h' as const, label: t('last-6-hours') },
  { mode: '12h' as const, label: t('last-12-hours') },
  { mode: '24h' as const, label: t('last-24-hours') },
  { mode: '3day' as const, label: t('3-days') },
  { mode: '7day' as const, label: t('7-days') },
  { mode: '14day' as const, label: t('14-days') },
  { mode: '30day' as const, label: t('30-days') },
  { mode: '90day' as const, label: t('90-days') },
  { mode: 'quarter' as const, label: t('last-quarter') },
  { mode: '6month' as const, label: t('last-6-months') },
  { mode: '12month' as const, label: t('last-12-months') },
])

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
const draftMode = ref<DateRangeMode>(adminStore.dateRangeMode)
const pickerRange = ref<Date[] | null>(null)

function isCompleteRange(range: Date[] | null): range is [Date, Date] {
  return Array.isArray(range)
    && range.length === 2
    && range[0] instanceof Date
    && range[1] instanceof Date
    && !Number.isNaN(range[0].getTime())
    && !Number.isNaN(range[1].getTime())
}

const canApply = computed(() => isCompleteRange(pickerRange.value))

onClickOutside(pickerContainer, () => {
  isOpen.value = false
})

onKeyStroke('Escape', (e) => {
  if (!isOpen.value)
    return
  e.preventDefault()
  isOpen.value = false
})

function syncDraftFromStore() {
  draftMode.value = adminStore.dateRangeMode
  const { start, end } = adminStore.activeDateRange
  pickerRange.value = [new Date(start), new Date(end)]
}

function togglePicker() {
  if (isOpen.value) {
    isOpen.value = false
    return
  }
  syncDraftFromStore()
  isOpen.value = true
}

function selectPreset(mode: Exclude<DateRangeMode, 'custom'>) {
  draftMode.value = mode
  const range = getDateRangeForMode(mode)
  pickerRange.value = [range.start, range.end]
}

function onRangeUpdate(value: Date[] | null) {
  pickerRange.value = value
  // Calendar interaction freezes a custom window (presets stay rolling until Apply).
  draftMode.value = 'custom'
}

function apply() {
  if (!isCompleteRange(pickerRange.value))
    return

  const [start, end] = pickerRange.value
  if (draftMode.value === 'custom')
    adminStore.setCustomDateRange(start, end)
  else
    adminStore.setDateRangeMode(draftMode.value)

  isOpen.value = false
}

function handleRefresh() {
  adminStore.invalidateCache()
}

watch(() => adminStore.dateRangeMode, () => {
  if (!isOpen.value)
    draftMode.value = adminStore.dateRangeMode
})
</script>

<template>
  <div class="mb-4">
    <div class="flex items-center justify-end gap-2 flex-nowrap sm:gap-4">
      <div ref="pickerContainer" class="relative flex items-center">
        <label for="admin-date-range" class="sr-only">{{ t('date-range') }}</label>
        <button
          id="admin-date-range"
          type="button"
          class="d-btn d-btn-sm gap-2 border border-gray-300 bg-white font-medium normal-case dark:border-gray-600 dark:bg-gray-700"
          :aria-label="`${t('date-range')}: ${triggerLabel}`"
          aria-haspopup="dialog"
          :aria-expanded="isOpen"
          aria-controls="admin-date-range-popover"
          @click="togglePicker"
        >
          <CalendarDaysIcon class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
          <span class="truncate max-w-[12rem] sm:max-w-[16rem]">{{ triggerLabel }}</span>
          <svg class="h-4 w-4 text-gray-500 dark:text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div
          v-if="isOpen"
          id="admin-date-range-popover"
          role="dialog"
          :aria-label="`${t('date-range')}: ${triggerLabel}`"
          class="absolute right-0 top-full z-50 mt-2 w-[min(720px,95vw)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        >
          <div class="flex flex-col md:flex-row">
            <div class="min-w-0 flex-1 p-3 md:p-4">
              <VueDatePicker
                :model-value="pickerRange"
                inline
                range
                :time-config="{ enableTimePicker: true, timePickerInline: true }"
                :dark="isDark"
                :max-date="new Date()"
                @update:model-value="onRangeUpdate"
              />
            </div>

            <div class="flex w-full flex-col border-t border-gray-200 dark:border-gray-700 md:w-52 md:border-l md:border-t-0">
              <div class="max-h-[18rem] flex-1 overflow-y-auto p-2 md:max-h-[22rem]">
                <button
                  v-for="preset in presets"
                  :key="preset.mode"
                  type="button"
                  class="d-btn d-btn-ghost d-btn-sm h-auto min-h-0 w-full justify-start rounded-md px-3 py-2 font-normal normal-case"
                  :class="draftMode === preset.mode
                    ? 'd-btn-active bg-gray-100 font-medium text-gray-900 dark:bg-gray-700 dark:text-white'
                    : 'text-gray-600 dark:text-gray-300'"
                  :aria-pressed="draftMode === preset.mode"
                  @click="selectPreset(preset.mode)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-3 border-t border-gray-200 px-3 py-3 dark:border-gray-700 sm:flex-row sm:items-end sm:justify-between sm:px-4">
            <div class="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <div id="admin-range-start-label" class="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  {{ t('start') }}
                </div>
                <div
                  class="flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
                  aria-labelledby="admin-range-start-label"
                >
                  <CalendarDaysIcon class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                  <span class="truncate text-sm text-gray-900 dark:text-white">
                    {{ pickerRange?.[0] instanceof Date ? formatLocalDateTime(pickerRange[0]) : '—' }}
                  </span>
                </div>
              </div>
              <div>
                <div id="admin-range-end-label" class="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                  {{ t('end') }}
                </div>
                <div
                  class="flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 dark:border-gray-600 dark:bg-gray-800"
                  aria-labelledby="admin-range-end-label"
                >
                  <CalendarDaysIcon class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden="true" />
                  <span class="truncate text-sm text-gray-900 dark:text-white">
                    {{ pickerRange?.[1] instanceof Date ? formatLocalDateTime(pickerRange[1]) : '—' }}
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="d-btn d-btn-primary d-btn-sm whitespace-nowrap"
              :disabled="!canApply"
              @click="apply"
            >
              {{ t('apply') }}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="d-btn d-btn-square d-btn-sm border border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-700"
        :aria-label="t('reload')"
        @click="handleRefresh"
      >
        <ArrowPathIconSolid class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

<style scoped>
:deep(.dp__main) {
  font-family: inherit;
}
:deep(.dp__theme_dark) {
  --dp-background-color: transparent;
  --dp-cell-size: 34px;
}
:deep(.dp__theme_light) {
  --dp-background-color: transparent;
  --dp-cell-size: 34px;
}
:deep(.dp__menu) {
  border: none;
  box-shadow: none;
}
</style>

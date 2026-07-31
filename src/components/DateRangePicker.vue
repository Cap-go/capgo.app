<script setup lang="ts">
import type { DateRangePreset, RollingDateRangePreset } from '~/services/dateRange'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import { onClickOutside, onKeyStroke, useMediaQuery, useMutationObserver } from '@vueuse/core'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CalendarDaysIcon from '~icons/heroicons/calendar-days'
import ChevronDownIcon from '~icons/heroicons/chevron-down'
import { formatLocalDateTime } from '~/services/date'
import {
  DATE_RANGE_PRESET_GROUPS,
  DATE_RANGE_PRESET_LABEL_KEYS,
  DEFAULT_DATE_RANGE_PRESET,
  getDateRangeForPreset,
} from '~/services/dateRange'
import '@vuepic/vue-datepicker/dist/main.css'

const props = withDefaults(defineProps<{
  modelValue?: [Date, Date] | null
  mode?: DateRangePreset
  minDate?: Date
  maxDate?: Date
  /** Compact trigger for dense toolbars (tables). */
  compact?: boolean
}>(), {
  modelValue: null,
  mode: DEFAULT_DATE_RANGE_PRESET,
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [[Date, Date]]
  'update:mode': [DateRangePreset]
  'apply': [{ start: Date, end: Date, mode: DateRangePreset }]
}>()

const { t } = useI18n()
const isWide = useMediaQuery('(min-width: 768px)')

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

interface PresetOption {
  mode: RollingDateRangePreset
  label: string
}
interface PresetGroup {
  key: string
  items: PresetOption[]
}

const presetGroups = computed((): PresetGroup[] =>
  DATE_RANGE_PRESET_GROUPS.map(group => ({
    key: group.key,
    items: group.modes.map(mode => ({
      mode,
      label: t(DATE_RANGE_PRESET_LABEL_KEYS[mode]),
    })),
  })),
)

const allPresets = computed(() => presetGroups.value.flatMap(g => g.items))

const isOpen = ref(false)
const pickerContainer = ref<HTMLElement | null>(null)
const draftMode = ref<DateRangePreset>(props.mode)
const pickerRange = ref<Date[] | null>(null)

const boundFields = computed(() => [
  { id: 'start', label: t('start'), value: pickerRange.value?.[0] },
  { id: 'end', label: t('end'), value: pickerRange.value?.[1] },
])

const multiCalendarConfig = computed(() => ({
  count: isWide.value ? 2 : 1,
  static: true,
  solo: false,
}))

const triggerLabel = computed(() => {
  const preset = allPresets.value.find(p => p.mode === props.mode)
  if (preset && props.mode !== 'custom')
    return preset.label

  const range = props.modelValue
  if (range?.[0] && range?.[1])
    return `${formatLocalDateTime(range[0])} – ${formatLocalDateTime(range[1])}`

  return allPresets.value.find(p => p.mode === DEFAULT_DATE_RANGE_PRESET)?.label
    ?? t('date-range')
})

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

function syncDraftFromProps() {
  draftMode.value = props.mode
  if (props.modelValue?.[0] && props.modelValue?.[1]) {
    pickerRange.value = [new Date(props.modelValue[0]), new Date(props.modelValue[1])]
    return
  }
  const range = getDateRangeForPreset(props.mode === 'custom' ? DEFAULT_DATE_RANGE_PRESET : props.mode)
  pickerRange.value = [range.start, range.end]
}

function togglePicker() {
  if (isOpen.value) {
    isOpen.value = false
    return
  }
  syncDraftFromProps()
  isOpen.value = true
}

function selectPreset(mode: RollingDateRangePreset) {
  draftMode.value = mode
  const range = getDateRangeForPreset(mode)
  pickerRange.value = [range.start, range.end]
}

function onRangeUpdate(value: Date[] | null) {
  pickerRange.value = value
  draftMode.value = 'custom'
}

function apply() {
  if (!isCompleteRange(pickerRange.value))
    return

  const [start, end] = pickerRange.value
  emit('update:modelValue', [start, end])
  emit('update:mode', draftMode.value)
  emit('apply', { start, end, mode: draftMode.value })
  isOpen.value = false
}

watch(() => props.mode, (mode) => {
  if (!isOpen.value)
    draftMode.value = mode
})

function presetButtonClass(active: boolean) {
  if (active) {
    return isDark.value
      ? 'bg-white font-medium text-slate-900'
      : 'bg-slate-900 font-medium text-white'
  }
  return isDark.value
    ? 'text-slate-300 hover:bg-slate-800'
    : 'text-slate-600 hover:bg-slate-100'
}
</script>

<template>
  <div ref="pickerContainer" class="relative">
    <label for="date-range-picker-trigger" class="sr-only">{{ t('date-range') }}</label>
    <button
      id="date-range-picker-trigger"
      type="button"
      class="group inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
      :class="[
        compact ? 'h-10 min-h-10' : 'h-9 min-h-9',
        isDark
          ? 'border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800'
          : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50',
      ]"
      :aria-label="`${t('date-range')}: ${triggerLabel}`"
      aria-haspopup="dialog"
      :aria-expanded="isOpen"
      aria-controls="date-range-picker-popover"
      @click="togglePicker"
    >
      <CalendarDaysIcon
        class="h-4 w-4 shrink-0 transition-colors"
        :class="isDark ? 'text-slate-400 group-hover:text-slate-200' : 'text-slate-500 group-hover:text-slate-700'"
        aria-hidden="true"
      />
      <span class="max-w-[14rem] truncate sm:max-w-[20rem]">{{ triggerLabel }}</span>
      <ChevronDownIcon
        class="h-4 w-4 shrink-0 transition-transform duration-150"
        :class="[isOpen ? 'rotate-180' : '', isDark ? 'text-slate-500' : 'text-slate-400']"
        aria-hidden="true"
      />
    </button>

    <dialog
      v-if="isOpen"
      id="date-range-picker-popover"
      open
      :aria-label="`${t('date-range')}: ${triggerLabel}`"
      class="date-range-popover absolute right-0 top-full z-50 m-0 mt-2 w-[min(46rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border p-0 shadow-[0_12px_40px_-12px_rgba(15,23,42,0.35)]"
      :class="isDark
        ? 'border-slate-700 bg-slate-950 text-slate-100 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.65)]'
        : 'border-slate-200 bg-white text-slate-800'"
    >
      <div class="flex flex-col md:flex-row">
        <div
          class="flex w-full shrink-0 flex-col md:w-44 md:border-b-0 md:border-r"
          :class="isDark ? 'border-b border-slate-700' : 'border-b border-slate-200'"
        >
          <div class="max-h-64 overflow-y-auto p-2 md:max-h-[22.5rem]">
            <template v-for="(group, groupIndex) in presetGroups" :key="group.key">
              <div
                v-if="groupIndex > 0"
                class="my-1.5 border-t"
                :class="isDark ? 'border-slate-800' : 'border-slate-100'"
                aria-hidden="true"
              />
              <div class="flex flex-col gap-0.5">
                <button
                  v-for="preset in group.items"
                  :key="preset.mode"
                  type="button"
                  class="cursor-pointer rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
                  :class="presetButtonClass(draftMode === preset.mode)"
                  :aria-pressed="draftMode === preset.mode"
                  @click="selectPreset(preset.mode)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </template>

            <div
              class="my-1.5 border-t"
              :class="isDark ? 'border-slate-800' : 'border-slate-100'"
              aria-hidden="true"
            />
            <button
              type="button"
              class="w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
              :class="presetButtonClass(draftMode === 'custom')"
              :aria-pressed="draftMode === 'custom'"
              @click="draftMode = 'custom'"
            >
              {{ t('custom') }}
            </button>
          </div>
        </div>

        <div class="date-range-calendar min-w-0 flex-1 p-2 md:p-3">
          <VueDatePicker
            :key="isDark ? 'dark' : 'light'"
            :model-value="pickerRange"
            inline
            range
            :multi-calendars="multiCalendarConfig"
            hide-month-year-select
            :formats="{ month: 'MMM yyyy', year: 'yyyy' }"
            :time-config="{ enableTimePicker: true, timePickerInline: false }"
            :dark="isDark"
            :min-date="minDate"
            :max-date="maxDate ?? new Date()"
            :action-row="{ showSelect: false, showCancel: false, showNow: false, showPreview: false }"
            @update:model-value="onRangeUpdate"
          />
        </div>
      </div>

      <div
        class="flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-end sm:justify-between sm:px-4"
        :class="isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-slate-50'"
      >
        <div class="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
          <div v-for="field in boundFields" :key="field.id">
            <div
              :id="`date-range-${field.id}-label`"
              class="mb-1 text-[11px] font-medium tracking-wide uppercase"
              :class="isDark ? 'text-slate-400' : 'text-slate-500'"
            >
              {{ field.label }}
            </div>
            <div
              class="flex h-9 items-center gap-2 rounded-md border px-2.5"
              :class="isDark ? 'border-slate-600 bg-slate-950' : 'border-slate-200 bg-white'"
              :aria-labelledby="`date-range-${field.id}-label`"
            >
              <CalendarDaysIcon class="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              <span
                class="truncate font-mono text-[13px] tabular-nums"
                :class="isDark ? 'text-slate-100' : 'text-slate-800'"
              >
                {{ field.value instanceof Date ? formatLocalDateTime(field.value) : '—' }}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          class="inline-flex h-9 min-h-9 cursor-pointer items-center justify-center rounded-md bg-azure-500 px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-azure-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/50 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canApply"
          @click="apply"
        >
          {{ t('apply') }}
        </button>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
dialog.date-range-popover {
  position: absolute;
  inset: auto;
  max-width: none;
  max-height: none;
  color: inherit;
}

dialog.date-range-popover::backdrop {
  display: none;
}

.date-range-calendar :deep(.dp__main) {
  font-family: inherit;
}

.date-range-calendar :deep(.dp__theme_light) {
  --dp-background-color: transparent;
  --dp-text-color: #0f172a;
  --dp-hover-color: #f1f5f9;
  --dp-hover-text-color: #0f172a;
  --dp-hover-icon-color: #64748b;
  --dp-primary-color: var(--color-azure-500);
  --dp-primary-text-color: #ffffff;
  --dp-secondary-color: #e2e8f0;
  --dp-border-color: transparent;
  --dp-menu-border-color: transparent;
  --dp-border-color-hover: transparent;
  --dp-disabled-color: #f8fafc;
  --dp-disabled-color-text: #94a3b8;
  --dp-scroll-bar-background: transparent;
  --dp-scroll-bar-color: #cbd5e1;
  --dp-success-color: var(--color-azure-500);
  --dp-success-color-disabled: #94a3b8;
  --dp-icon-color: #64748b;
  --dp-danger-color: #ef4444;
  --dp-highlight-color: rgb(17 158 255 / 0.12);
  --dp-range-between-dates-background-color: rgb(17 158 255 / 0.12);
  --dp-range-between-dates-text-color: #0f172a;
  --dp-range-between-border-radius: 0;
  --dp-cell-size: 36px;
  --dp-cell-padding: 2px;
  --dp-row-margin: 0;
  --dp-month-year-row-height: 36px;
  --dp-month-year-row-button-size: 32px;
  --dp-button-height: 32px;
  --dp-font-size: 0.875rem;
}

.date-range-calendar :deep(.dp__theme_dark) {
  --dp-background-color: transparent;
  --dp-text-color: #e2e8f0;
  --dp-hover-color: #1e293b;
  --dp-hover-text-color: #f8fafc;
  --dp-hover-icon-color: #94a3b8;
  --dp-primary-color: var(--color-azure-500);
  --dp-primary-text-color: #ffffff;
  --dp-secondary-color: #334155;
  --dp-border-color: transparent;
  --dp-menu-border-color: transparent;
  --dp-border-color-hover: transparent;
  --dp-disabled-color: #0f172a;
  --dp-disabled-color-text: #64748b;
  --dp-scroll-bar-background: transparent;
  --dp-scroll-bar-color: #475569;
  --dp-success-color: var(--color-azure-500);
  --dp-success-color-disabled: #64748b;
  --dp-icon-color: #94a3b8;
  --dp-danger-color: #f87171;
  --dp-highlight-color: rgb(17 158 255 / 0.22);
  --dp-range-between-dates-background-color: rgb(17 158 255 / 0.2);
  --dp-range-between-dates-text-color: #e2e8f0;
  --dp-range-between-border-radius: 0;
  --dp-cell-size: 36px;
  --dp-cell-padding: 2px;
  --dp-row-margin: 0;
  --dp-month-year-row-height: 36px;
  --dp-month-year-row-button-size: 32px;
  --dp-button-height: 32px;
  --dp-font-size: 0.875rem;
}

.date-range-calendar :deep(.dp__menu),
.date-range-calendar :deep(.dp__menu_inner),
.date-range-calendar :deep(.dp__instance_calendar),
.date-range-calendar :deep(.dp__calendar),
.date-range-calendar :deep(.dp__calendar_wrap),
.date-range-calendar :deep(.dp__time_picker_inline_container),
.date-range-calendar :deep(.dp--tp-wrap),
.date-range-calendar :deep(.dp__overlay),
.date-range-calendar :deep(.dp__overlay_container) {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
}

.date-range-calendar :deep(.dp__menu) {
  padding: 0;
}

.date-range-calendar :deep(.dp__calendar_header_item) {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
}

.date-range-calendar :deep(.dp__theme_dark .dp__calendar_header_item) {
  color: #94a3b8;
}

.date-range-calendar :deep(.dp__cell_inner) {
  border-radius: 9999px;
  font-weight: 500;
}

.date-range-calendar :deep(.dp__theme_light .dp__cell_offset),
.date-range-calendar :deep(.dp__theme_light .dp__cell_disabled) {
  color: #cbd5e1;
}

.date-range-calendar :deep(.dp__theme_dark .dp__cell_offset),
.date-range-calendar :deep(.dp__theme_dark .dp__cell_disabled) {
  color: #475569;
}

.date-range-calendar :deep(.dp__range_start .dp__cell_inner),
.date-range-calendar :deep(.dp__range_end .dp__cell_inner),
.date-range-calendar :deep(.dp__active_date .dp__cell_inner) {
  background: var(--color-azure-500) !important;
  color: #fff !important;
  font-weight: 600;
}

.date-range-calendar :deep(.dp__instance_calendar) {
  padding: 0 0.25rem;
}

.date-range-calendar :deep(.dp__calendar_header_separator) {
  display: none;
}

.date-range-calendar :deep(.dp__month_year_wrap) {
  font-weight: 600;
  font-size: 0.875rem;
}

.date-range-calendar :deep(.dp__action_row) {
  display: none;
}

.date-range-calendar :deep(.dp__theme_dark .dp__time_display),
.date-range-calendar :deep(.dp__theme_dark .dp__input),
.date-range-calendar :deep(.dp__theme_dark .dp__time_input),
.date-range-calendar :deep(.dp__theme_dark .dp__pm_am_button),
.date-range-calendar :deep(.dp__theme_dark .dp__overlay) {
  background: #0f172a !important;
  color: #e2e8f0 !important;
  border-color: #334155 !important;
}

.date-range-calendar :deep(.dp__theme_light .dp__time_display),
.date-range-calendar :deep(.dp__theme_light .dp__input),
.date-range-calendar :deep(.dp__theme_light .dp__time_input),
.date-range-calendar :deep(.dp__theme_light .dp__pm_am_button) {
  background: #f8fafc !important;
  color: #0f172a !important;
  border-color: #e2e8f0 !important;
}

@media (prefers-reduced-motion: reduce) {
  .date-range-popover,
  .date-range-popover * {
    transition: none !important;
  }
}
</style>

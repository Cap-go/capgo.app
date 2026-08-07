<script setup lang="ts">
import type { DateRangePreset, DateRangePresetGroupKey, RollingDateRangePreset } from '~/services/dateRange'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import { onClickOutside, onKeyStroke, useMediaQuery, useMutationObserver } from '@vueuse/core'
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CalendarDaysIcon from '~icons/heroicons/calendar-days'
import ChevronDownIcon from '~icons/heroicons/chevron-down'
import { formatLocalDateTime } from '~/services/date'
import {
  clampDateRange,
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
const baseId = useId()
const triggerId = `${baseId}-trigger`
const popoverId = `${baseId}-popover`

const isDark = ref(false)
let prefersDarkQuery: MediaQueryList | null = null

function syncThemeFromHtml() {
  if (typeof document === 'undefined')
    return
  const root = document.documentElement
  const theme = root.dataset.theme
  prefersDarkQuery ??= window.matchMedia('(prefers-color-scheme: dark)')
  // Capgo DaisyUI: capgodark can win via data-theme OR prefersdark without `.dark`.
  isDark.value = root.classList.contains('dark')
    || theme === 'capgodark'
    || (theme !== 'capgolight' && prefersDarkQuery.matches)
}

useMutationObserver(
  document.documentElement,
  syncThemeFromHtml,
  { attributes: true, attributeFilter: ['class', 'data-theme'] },
)

interface PresetOption {
  mode: RollingDateRangePreset
  label: string
  disabled: boolean
}
interface PresetGroup {
  key: DateRangePresetGroupKey
  items: PresetOption[]
}

function isPresetAllowed(mode: RollingDateRangePreset) {
  // Rolling presets always end at "now". Only the window start must respect bounds.
  // Comparing end > maxDate breaks every shortcut when parents pass a stale `new Date()`.
  const { start } = getDateRangeForPreset(mode)
  if (props.minDate && start.getTime() < props.minDate.getTime())
    return false
  if (props.maxDate && start.getTime() > props.maxDate.getTime())
    return false
  return true
}

const presetGroups = computed((): PresetGroup[] =>
  DATE_RANGE_PRESET_GROUPS.map(group => ({
    key: group.key,
    items: group.modes.map(mode => ({
      mode,
      label: t(DATE_RANGE_PRESET_LABEL_KEYS[mode]),
      disabled: !isPresetAllowed(mode),
    })),
  })),
)

const allPresets = computed(() => presetGroups.value.flatMap(g => g.items))

const isOpen = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const popoverRef = ref<HTMLDialogElement | null>(null)
const returnFocusTarget = ref<HTMLElement | null>(null)
const positionAnchor = ref<HTMLElement | null>(null)
const draftMode = ref<DateRangePreset>(props.mode)
const pickerRange = ref<Date[] | null>(null)
const popoverStyle = ref<Record<string, string>>({})

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
    && range[0].getTime() <= range[1].getTime()
}

const canApply = computed(() => isCompleteRange(pickerRange.value))

/** Fresh upper bound for the calendar; recompute when opening so fallback `now` is not cached. */
const effectiveMaxDate = computed(() => {
  if (props.maxDate)
    return props.maxDate
  // Depend on isOpen so each open gets a current upper bound.
  return isOpen.value ? new Date() : undefined
})

function updatePopoverPosition() {
  const anchor = positionAnchor.value?.isConnected ? positionAnchor.value : triggerRef.value
  if (!anchor)
    return
  const rect = anchor.getBoundingClientRect()
  popoverStyle.value = {
    top: `${Math.round(rect.bottom + 8)}px`,
    right: `${Math.round(window.innerWidth - rect.right)}px`,
  }
}

function closePicker() {
  if (!isOpen.value)
    return
  isOpen.value = false
  const target = returnFocusTarget.value?.isConnected ? returnFocusTarget.value : triggerRef.value
  returnFocusTarget.value = null
  positionAnchor.value = null
  nextTick(() => target?.focus())
}

async function openPicker(invoker?: HTMLElement) {
  returnFocusTarget.value = invoker ?? triggerRef.value
  positionAnchor.value = invoker ?? triggerRef.value
  syncDraftFromProps()
  updatePopoverPosition()
  isOpen.value = true
  await nextTick()
  updatePopoverPosition()
  popoverRef.value?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus()
}

defineExpose({ openPicker })

onClickOutside(popoverRef, (event) => {
  const target = event.target as Node | null
  if (target && (triggerRef.value?.contains(target) || positionAnchor.value?.contains(target)))
    return
  closePicker()
})

onKeyStroke('Escape', (e) => {
  if (!isOpen.value)
    return
  e.preventDefault()
  closePicker()
})

function onViewportChange() {
  if (isOpen.value)
    updatePopoverPosition()
}

onMounted(() => {
  syncThemeFromHtml()
  prefersDarkQuery?.addEventListener('change', syncThemeFromHtml)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})

onUnmounted(() => {
  prefersDarkQuery?.removeEventListener('change', syncThemeFromHtml)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})

function syncDraftFromProps() {
  draftMode.value = props.mode
  if (props.mode !== 'custom') {
    const range = clampDateRange(getDateRangeForPreset(props.mode), props.minDate, props.maxDate)
    pickerRange.value = [range.start, range.end]
    return
  }
  if (props.modelValue?.[0] && props.modelValue?.[1]) {
    const range = clampDateRange(
      { start: new Date(props.modelValue[0]), end: new Date(props.modelValue[1]) },
      props.minDate,
      props.maxDate,
    )
    pickerRange.value = [range.start, range.end]
    return
  }
  const range = clampDateRange(getDateRangeForPreset(DEFAULT_DATE_RANGE_PRESET), props.minDate, props.maxDate)
  pickerRange.value = [range.start, range.end]
}

function togglePicker() {
  if (isOpen.value)
    closePicker()
  else
    void openPicker()
}

function selectPreset(mode: RollingDateRangePreset) {
  if (!isPresetAllowed(mode))
    return
  draftMode.value = mode
  const range = clampDateRange(getDateRangeForPreset(mode), props.minDate, props.maxDate)
  pickerRange.value = [range.start, range.end]
}

function onRangeUpdate(value: Date[] | null) {
  if (!value) {
    pickerRange.value = value
    draftMode.value = 'custom'
    return
  }
  const [rawStart, rawEnd] = value
  if (!(rawStart instanceof Date) || !(rawEnd instanceof Date)) {
    pickerRange.value = value
    draftMode.value = 'custom'
    return
  }
  const range = clampDateRange({ start: rawStart, end: rawEnd }, props.minDate, props.maxDate)
  pickerRange.value = [range.start, range.end]
  draftMode.value = 'custom'
}

function apply() {
  if (!isCompleteRange(pickerRange.value))
    return

  const mode = draftMode.value
  let start: Date
  let end: Date

  if (mode !== 'custom') {
    const fresh = clampDateRange(getDateRangeForPreset(mode), props.minDate, props.maxDate)
    start = fresh.start
    end = fresh.end
  }
  else {
    const clamped = clampDateRange(
      { start: pickerRange.value[0], end: pickerRange.value[1] },
      props.minDate,
      props.maxDate,
    )
    start = clamped.start
    end = clamped.end
  }

  emit('update:modelValue', [start, end])
  emit('update:mode', mode)
  emit('apply', { start, end, mode })
  closePicker()
}

watch(() => props.mode, (mode) => {
  if (!isOpen.value)
    draftMode.value = mode
})

function presetButtonClass(active: boolean, disabled: boolean) {
  return [
    'date-range-preset',
    active ? 'is-active' : '',
    disabled ? 'is-disabled' : '',
  ].filter(Boolean).join(' ')
}
</script>

<template>
  <div class="relative">
    <label :for="triggerId" class="sr-only">{{ t('date-range') }}</label>
    <button
      :id="triggerId"
      ref="triggerRef"
      type="button"
      class="date-range-trigger group inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
      :class="compact ? 'h-10 min-h-10' : 'h-9 min-h-9'"
      :data-capgo-surface="isDark ? 'dark' : 'light'"
      :aria-label="`${t('date-range')}: ${triggerLabel}`"
      aria-haspopup="dialog"
      :aria-expanded="isOpen"
      :aria-controls="popoverId"
      @click="togglePicker"
    >
      <CalendarDaysIcon
        class="date-range-trigger-icon h-4 w-4 shrink-0 transition-colors"
        aria-hidden="true"
      />
      <span class="max-w-[14rem] truncate sm:max-w-[20rem]">{{ triggerLabel }}</span>
      <ChevronDownIcon
        class="date-range-trigger-chevron h-4 w-4 shrink-0 transition-transform duration-150"
        :class="isOpen ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <dialog
        v-if="isOpen"
        :id="popoverId"
        ref="popoverRef"
        open
        :aria-label="`${t('date-range')}: ${triggerLabel}`"
        class="date-range-popover fixed z-[100] m-0 w-[min(48rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border p-0"
        :data-capgo-surface="isDark ? 'dark' : 'light'"
        :style="popoverStyle"
      >
        <div class="flex flex-col md:flex-row">
          <div class="date-range-sidebar flex w-full shrink-0 flex-col border-b md:w-44 md:border-b-0 md:border-r">
            <div class="max-h-64 overflow-y-auto p-2 md:max-h-[22.5rem]">
              <template v-for="(group, groupIndex) in presetGroups" :key="group.key">
                <div
                  v-if="groupIndex > 0"
                  class="date-range-divider my-1.5 border-t"
                  aria-hidden="true"
                />
                <div class="flex flex-col gap-0.5">
                  <button
                    v-for="preset in group.items"
                    :key="preset.mode"
                    type="button"
                    class="rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
                    :class="presetButtonClass(draftMode === preset.mode, preset.disabled)"
                    :aria-pressed="draftMode === preset.mode"
                    :disabled="preset.disabled"
                    @click="selectPreset(preset.mode)"
                  >
                    {{ preset.label }}
                  </button>
                </div>
              </template>

              <div
                class="date-range-divider my-1.5 border-t"
                aria-hidden="true"
              />
              <button
                type="button"
                class="w-full cursor-pointer rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500/40"
                :class="presetButtonClass(draftMode === 'custom', false)"
                :aria-pressed="draftMode === 'custom'"
                @click="draftMode = 'custom'"
              >
                {{ t('custom') }}
              </button>
            </div>
          </div>

          <div class="date-range-calendar min-w-0 flex-1">
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
              :max-date="effectiveMaxDate"
              :action-row="{ showSelect: false, showCancel: false, showNow: false, showPreview: false }"
              @update:model-value="onRangeUpdate"
            />
          </div>
        </div>

        <div class="date-range-footer flex flex-col gap-3 border-t px-3 py-3 sm:flex-row sm:items-end sm:justify-between sm:px-4">
          <div class="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
            <div v-for="field in boundFields" :key="field.id">
              <div
                :id="`${baseId}-${field.id}-label`"
                class="date-range-field-label mb-1 text-[11px] font-medium tracking-wide uppercase"
              >
                {{ field.label }}
              </div>
              <div
                class="date-range-field flex h-9 items-center gap-2 rounded-md border px-2.5"
                :aria-labelledby="`${baseId}-${field.id}-label`"
              >
                <CalendarDaysIcon class="date-range-field-icon h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span class="date-range-field-value truncate font-mono text-[13px] tabular-nums">
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
    </Teleport>
  </div>
</template>

<style scoped>
/* Shared surface tokens — contrast first (WCAG AA). One flat surface; no nested calendar card. */
.date-range-trigger[data-capgo-surface='light'],
.date-range-popover[data-capgo-surface='light'] {
  --drp-bg: #ffffff;
  --drp-bg-muted: #f8fafc;
  --drp-border: #e2e8f0;
  --drp-divider: #f1f5f9;
  --drp-text: #0f172a;
  --drp-text-muted: #64748b;
  --drp-text-subtle: #94a3b8;
  --drp-preset: #475569;
  --drp-preset-hover: #f1f5f9;
  --drp-preset-active-bg: #0f172a;
  --drp-preset-active-text: #ffffff;
  --drp-field-bg: #ffffff;
  --drp-field-border: #e2e8f0;
  --drp-shadow: 0 12px 40px -12px rgb(15 23 42 / 0.35);
  --drp-cal-text: #0f172a;
  --drp-cal-muted: #94a3b8;
  --drp-cal-header: #64748b;
  --drp-cal-hover: #f1f5f9;
  --drp-cal-icon: #64748b;
  --drp-cal-between: rgb(17 158 255 / 0.12);
  --drp-cal-between-text: #0f172a;
  --drp-cal-input-bg: #f8fafc;
}

.date-range-trigger[data-capgo-surface='dark'],
.date-range-popover[data-capgo-surface='dark'] {
  --drp-bg: #0b1220;
  --drp-bg-muted: #0b1220;
  --drp-border: #334155;
  --drp-divider: #1e293b;
  --drp-text: #f8fafc;
  --drp-text-muted: #cbd5e1;
  --drp-text-subtle: #94a3b8;
  --drp-preset: #e2e8f0;
  --drp-preset-hover: #1e293b;
  --drp-preset-active-bg: #f8fafc;
  --drp-preset-active-text: #0f172a;
  --drp-field-bg: #0b1220;
  --drp-field-border: #475569;
  --drp-shadow: 0 16px 48px -12px rgb(0 0 0 / 0.65);
  --drp-cal-text: #f1f5f9;
  --drp-cal-muted: #64748b;
  --drp-cal-header: #cbd5e1;
  --drp-cal-hover: #1e293b;
  --drp-cal-icon: #cbd5e1;
  --drp-cal-between: rgb(17 158 255 / 0.28);
  --drp-cal-between-text: #f8fafc;
  --drp-cal-input-bg: #0b1220;
}

.date-range-trigger {
  background: var(--drp-bg);
  border-color: var(--drp-border);
  color: var(--drp-text);
}

.date-range-trigger:hover {
  filter: brightness(1.05);
}

.date-range-trigger-icon,
.date-range-trigger-chevron {
  color: var(--drp-text-muted);
}

.date-range-trigger:hover .date-range-trigger-icon,
.date-range-trigger:hover .date-range-trigger-chevron {
  color: var(--drp-text);
}

.date-range-popover {
  max-width: none;
  max-height: none;
  background: var(--drp-bg) !important;
  border-color: var(--drp-border) !important;
  color: var(--drp-text) !important;
  box-shadow: var(--drp-shadow);
}

.date-range-popover::backdrop {
  display: none;
}

.date-range-sidebar,
.date-range-footer {
  background: var(--drp-bg);
  border-color: var(--drp-border);
}

.date-range-divider {
  border-color: var(--drp-divider);
}

.date-range-preset {
  color: var(--drp-preset) !important;
  background: transparent;
  cursor: pointer;
}

.date-range-preset:hover:not(.is-disabled):not(.is-active) {
  background: var(--drp-preset-hover);
}

.date-range-preset.is-active {
  background: var(--drp-preset-active-bg) !important;
  color: var(--drp-preset-active-text) !important;
  font-weight: 600;
}

.date-range-preset.is-disabled {
  color: var(--drp-text-subtle) !important;
  opacity: 0.45;
  cursor: not-allowed;
}

.date-range-field-label {
  color: var(--drp-text-muted);
}

.date-range-field {
  background: var(--drp-field-bg);
  border-color: var(--drp-field-border);
}

.date-range-field-icon {
  color: var(--drp-text-subtle);
}

.date-range-field-value {
  color: var(--drp-text);
}

.date-range-calendar {
  /* Single surface: calendar paints on the popover bg, no nested card. */
  background: var(--drp-bg) !important;
  min-width: 0;
  overflow: hidden;
  padding: 0.5rem 0.75rem 0.25rem;
}

.date-range-calendar :deep(.dp__main),
.date-range-calendar :deep(.dp--main),
.date-range-calendar :deep(.dp--menu),
.date-range-calendar :deep(.dp__menu) {
  font-family: inherit;
  width: 100%;
  max-width: 100%;
  min-width: 0 !important;
  border-radius: 0 !important;
  background: var(--drp-bg) !important;
  color: var(--drp-cal-text) !important;
  box-shadow: none !important;
  border: none !important;
  box-sizing: border-box;
}

.date-range-calendar :deep(.dp--flex-display) {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.date-range-calendar :deep(.dp__theme_light),
.date-range-calendar :deep(.dp__theme_dark),
.date-range-calendar :deep(.dp--theme-light),
.date-range-calendar :deep(.dp--theme-dark) {
  /* Match popover exactly — never the library dark #212121 panel. */
  --dp-background-color: var(--drp-bg);
  --dp-text-color: var(--drp-cal-text);
  --dp-hover-color: var(--drp-cal-hover);
  --dp-hover-text-color: var(--drp-cal-text);
  --dp-hover-icon-color: var(--drp-cal-icon);
  --dp-primary-color: var(--color-azure-500);
  --dp-primary-text-color: #ffffff;
  --dp-secondary-color: var(--drp-cal-muted);
  --dp-border-color: transparent;
  --dp-menu-border-color: transparent;
  --dp-border-color-hover: transparent;
  --dp-border-color-focus: transparent;
  --dp-disabled-color: transparent;
  --dp-disabled-color-text: var(--drp-cal-muted);
  --dp-scroll-bar-background: var(--drp-bg);
  --dp-scroll-bar-color: var(--drp-border);
  --dp-success-color: var(--color-azure-500);
  --dp-success-color-disabled: var(--drp-cal-muted);
  --dp-icon-color: var(--drp-cal-icon);
  --dp-danger-color: #f87171;
  --dp-tooltip-color: var(--drp-bg);
  --dp-highlight-color: var(--drp-cal-between);
  --dp-range-between-dates-background-color: var(--drp-cal-between);
  --dp-range-between-dates-text-color: var(--drp-cal-between-text);
  --dp-range-between-border-color: transparent;
  --dp-range-between-border-radius: 0;
  --dp-menu-padding: 0;
  --dp-calendar-wrap-padding: 0;
  /* Spacing handled by our divider; library gap would overflow the pane. */
  --dp-multi-calendars-spacing: 0;
  --dp-row-margin: 0;
  --dp-cell-size: 34px;
  --dp-cell-padding: 2px;
  --dp-month-year-row-height: 36px;
  --dp-month-year-row-button-size: 32px;
  --dp-button-height: 32px;
  --dp-font-size: 0.875rem;
  --dp-border-radius: 0;
}

.date-range-calendar :deep(.dp__menu),
.date-range-calendar :deep(.dp--menu),
.date-range-calendar :deep(.dp__menu_inner),
.date-range-calendar :deep(.dp--menu-inner),
.date-range-calendar :deep(.dp__instance_calendar),
.date-range-calendar :deep(.dp--instance-calendar),
.date-range-calendar :deep(.dp__calendar),
.date-range-calendar :deep(.dp--calendar),
.date-range-calendar :deep(.dp__calendar_wrap),
.date-range-calendar :deep(.dp__calendar_header),
.date-range-calendar :deep(.dp--calendar-header),
.date-range-calendar :deep(.dp__calendar_row),
.date-range-calendar :deep(.dp--calendar-row),
.date-range-calendar :deep(.dp__month_year_row),
.date-range-calendar :deep(.dp__time_picker_inline_container),
.date-range-calendar :deep(.dp--time-picker-inline-container),
.date-range-calendar :deep(.dp--tp-wrap),
.date-range-calendar :deep(.dp__overlay),
.date-range-calendar :deep(.dp--overlay),
.date-range-calendar :deep(.dp__overlay_container) {
  background: var(--drp-bg) !important;
  border: none !important;
  box-shadow: none !important;
  color: var(--drp-cal-text) !important;
  border-radius: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
}

.date-range-calendar :deep(.dp__calendar_header_item),
.date-range-calendar :deep(.dp--calendar-header-item) {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--drp-cal-header) !important;
}

.date-range-calendar :deep(.dp__cell_inner),
.date-range-calendar :deep(.dp--cell-inner) {
  border-radius: 0.375rem;
  font-weight: 500;
  color: var(--drp-cal-text);
}

.date-range-calendar :deep(.dp__cell_offset),
.date-range-calendar :deep(.dp__cell_disabled),
.date-range-calendar :deep(.dp--cell-offset),
.date-range-calendar :deep(.dp--cell-disabled) {
  color: var(--drp-cal-muted) !important;
}

.date-range-calendar :deep(.dp__range_start .dp__cell_inner),
.date-range-calendar :deep(.dp__range_end .dp__cell_inner),
.date-range-calendar :deep(.dp__active_date .dp__cell_inner),
.date-range-calendar :deep(.dp--range-border-start .dp--cell-inner),
.date-range-calendar :deep(.dp--range-border-end .dp--cell-inner),
.date-range-calendar :deep(.dp--active .dp--cell-inner) {
  background: var(--color-azure-500) !important;
  color: #fff !important;
  font-weight: 600;
}

.date-range-calendar :deep(.dp__calendar_header_separator),
.date-range-calendar :deep(.dp--calendar-header-separator) {
  display: none;
}

.date-range-calendar :deep(.dp__month_year_wrap) {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--drp-cal-text) !important;
}

.date-range-calendar :deep(.dp__action_row),
.date-range-calendar :deep(.dp--action-row) {
  display: none;
}

.date-range-calendar :deep(.dp__time_display),
.date-range-calendar :deep(.dp--time-display),
.date-range-calendar :deep(.dp__input),
.date-range-calendar :deep(.dp--input),
.date-range-calendar :deep(.dp__time_input),
.date-range-calendar :deep(.dp__pm_am_button),
.date-range-calendar :deep(.dp--pm-am-button),
.date-range-calendar :deep(.dp__overlay),
.date-range-calendar :deep(.dp--overlay) {
  background: var(--drp-cal-input-bg) !important;
  color: var(--drp-cal-text) !important;
  border-color: var(--drp-border) !important;
}

/* Dual months share the pane evenly — never spill past the popover edge. */
.date-range-calendar :deep(.dp__instance_calendar),
.date-range-calendar :deep(.dp--instance-calendar) {
  flex: 1 1 0 !important;
  width: auto !important;
  max-width: 100%;
  min-width: 0 !important;
  box-sizing: border-box;
}

.date-range-calendar :deep(.dp__calendar_next),
.date-range-calendar :deep(.dp--calendar-next),
.date-range-calendar :deep(.dp__instance_calendar + .dp__instance_calendar),
.date-range-calendar :deep(.dp--instance-calendar + .dp--instance-calendar) {
  margin-inline-start: 0 !important;
  padding-inline-start: 0.75rem !important;
  border-inline-start: 1px solid var(--drp-divider);
}

.date-range-calendar :deep(.dp__calendar),
.date-range-calendar :deep(.dp--calendar),
.date-range-calendar :deep(.dp__calendar_wrap) {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

@media (prefers-reduced-motion: reduce) {
  .date-range-popover,
  .date-range-popover *,
  .date-range-trigger,
  .date-range-trigger * {
    transition: none !important;
  }
}
</style>

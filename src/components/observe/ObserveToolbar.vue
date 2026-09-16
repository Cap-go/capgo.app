<script setup lang="ts">
import type { DateRangePreset } from '~/services/dateRange'
import { useNow } from '@vueuse/core'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import DateRangePicker from '~/components/DateRangePicker.vue'
import { clampDateRange } from '~/services/dateRange'

defineProps<{
  bundleNames: string[]
  selectedVersionName: string
  preciseDates: [Date, Date] | null
  rangeMode: DateRangePreset
}>()

const emit = defineEmits<{
  'update:version': [value: string]
  'applyRange': [payload: { start: Date, end: Date, mode: DateRangePreset }]
}>()

const { t } = useI18n()
const versionFilterId = useId()
const now = useNow({ interval: 60_000 })
const minDate = computed(() => new Date(now.value.getTime() - 30 * 24 * 60 * 60 * 1000))

function onVersionSelectChange(event: Event) {
  emit('update:version', (event.target as HTMLSelectElement).value)
}

function onRangeApply(payload: { start: Date, end: Date, mode: DateRangePreset }) {
  const clamped = clampDateRange({ start: payload.start, end: payload.end }, minDate.value)
  emit('applyRange', { ...payload, start: clamped.start, end: clamped.end })
}
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-end">
    <div class="min-w-0 sm:w-56">
      <label
        :for="versionFilterId"
        class="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400"
      >
        {{ t('version') }}
      </label>
      <select
        :id="versionFilterId"
        class="d-select d-select-bordered mt-1 h-9 min-h-9 w-full py-0 text-sm"
        :value="selectedVersionName"
        data-test="observe-updater-version-filter"
        @change="onVersionSelectChange"
      >
        <option value="">
          {{ t('all-versions') }}
        </option>
        <option v-for="name in bundleNames" :key="name" :value="name">
          {{ name }}
        </option>
      </select>
    </div>
    <DateRangePicker
      :model-value="preciseDates"
      :mode="rangeMode"
      compact
      :min-date="minDate"
      data-test="observe-date-range-picker"
      @apply="onRangeApply"
    />
  </div>
</template>

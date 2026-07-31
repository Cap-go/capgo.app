<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export type PeriodDayOption = 1 | 3 | 7 | 30

const props = withDefaults(defineProps<{
  modelValue: PeriodDayOption
  labels?: Partial<Record<PeriodDayOption, string>>
}>(), {
  labels: () => ({}),
})

const emit = defineEmits<{
  'update:modelValue': [value: PeriodDayOption]
}>()

const { t } = useI18n()
const options: PeriodDayOption[] = [1, 3, 7, 30]
const defaultLabels: Record<PeriodDayOption, string> = {
  1: 'one-day',
  3: 'three-days',
  7: 'seven-days',
  30: 'thirty-days',
}

const selectedLabel = computed(() => props.labels[props.modelValue] ?? defaultLabels[props.modelValue])

function select(option: PeriodDayOption) {
  if (option !== props.modelValue)
    emit('update:modelValue', option)
}
</script>

<template>
  <fieldset
    class="flex items-center p-1 space-x-1 shrink-0 bg-gray-200 rounded-lg dark:bg-gray-800"
    data-testid="period-day-selector"
  >
    <legend class="sr-only">
      {{ t('selected-period') }}: {{ t(selectedLabel) }}
    </legend>
    <button
      v-for="option in options"
      :key="option"
      type="button"
      :aria-pressed="props.modelValue === option"
      :aria-label="t(props.labels[option] ?? defaultLabels[option])"
      class="flex justify-center items-center h-9 min-h-9 min-w-[2.75rem] px-2.5 sm:px-3 py-1.5 text-xs font-medium text-center whitespace-nowrap rounded-md transition-colors duration-150 cursor-pointer"
      :class="props.modelValue === option
        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'"
      @click="select(option)"
    >
      {{ t(props.labels[option] ?? defaultLabels[option]) }}
    </button>
  </fieldset>
</template>

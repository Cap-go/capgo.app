<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'

type VersionCompareOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte'
type CompareOp = VersionCompareOp | 'in'

const props = defineProps<{
  label: string
  op: CompareOp
  value: string
  placeholder?: string
  testId: string
  includeIn?: boolean
}>()

const emit = defineEmits<{
  'update:op': [value: CompareOp]
  'update:value': [value: string]
}>()

const { t } = useI18n()
const opId = useId()
const valueId = useId()

const operators = computed(() => {
  const range = [
    { value: 'gte' as const, label: t('version-compare-gte') },
    { value: 'lte' as const, label: t('version-compare-lte') },
    { value: 'gt' as const, label: t('version-compare-gt') },
    { value: 'lt' as const, label: t('version-compare-lt') },
    { value: 'eq' as const, label: t('version-compare-eq') },
  ]
  if (!props.includeIn)
    return range
  return [{ value: 'in' as const, label: t('version-compare-in') }, ...range]
})
</script>

<template>
  <fieldset class="flex w-full flex-col gap-2" :data-test="testId">
    <legend class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {{ label }}
    </legend>
    <div class="flex gap-2">
      <div class="w-28 shrink-0">
        <label :for="opId" class="sr-only">{{ t('version-compare-operator') }}</label>
        <select
          :id="opId"
          class="d-select d-select-bordered min-h-11 w-full border-slate-200 bg-white text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
          :value="op"
          :data-test="`${testId}-op`"
          :name="`${testId}-op`"
          @change="emit('update:op', ($event.target as HTMLSelectElement).value as CompareOp)"
        >
          <option v-for="option in operators" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
      <div v-if="op !== 'in'" class="min-w-0 flex-1">
        <label :for="valueId" class="sr-only">{{ label }}</label>
        <input
          :id="valueId"
          :value="value"
          type="text"
          :name="`${testId}-value`"
          class="d-input d-input-bordered min-h-11 w-full border-slate-200 bg-white text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white max-sm:text-base/6"
          :placeholder="placeholder"
          :data-test="`${testId}-value`"
          autocomplete="off"
          @input="emit('update:value', ($event.target as HTMLInputElement).value)"
        >
      </div>
    </div>
  </fieldset>
</template>

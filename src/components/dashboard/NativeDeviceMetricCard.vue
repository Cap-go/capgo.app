<script setup lang="ts">
import { computed } from 'vue'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  value: {
    type: Number,
    default: undefined,
  },
  subtitle: {
    type: String,
    default: '',
  },
  evolution: {
    type: Number,
    default: undefined,
  },
  isLoading: {
    type: Boolean,
    default: false,
  },
  accentClass: {
    type: String,
    default: 'text-slate-900 dark:text-white',
  },
})

const showEvolution = computed(() => props.evolution !== undefined && props.evolution !== null && Number.isFinite(props.evolution))
const displayValue = computed(() => {
  if (props.isLoading)
    return '—'
  if (props.value === undefined || props.value === null)
    return '—'
  return formatNumberValue(props.value)
})
</script>

<template>
  <div class="p-4 bg-white border rounded-lg shadow-sm dark:bg-slate-800 border-slate-200 dark:border-slate-700">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 text-sm text-slate-600 dark:text-slate-400">
        {{ title }}
      </div>
      <div
        v-if="showEvolution"
        class="inline-flex shrink-0 items-center px-2 py-0.5 text-xs font-semibold rounded-full"
        :class="{
          'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200': (evolution ?? 0) >= 0,
          'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200': (evolution ?? 0) < 0,
        }"
      >
        {{ (evolution ?? 0) < 0 ? '' : '+' }}{{ formatNumberValue(evolution ?? 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
      </div>
    </div>
    <div
      class="mt-2 text-2xl font-semibold"
      :class="[accentClass, { 'animate-pulse text-slate-300 dark:text-slate-600': isLoading }]"
    >
      {{ displayValue }}
    </div>
    <p v-if="subtitle" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
      {{ subtitle }}
    </p>
  </div>
</template>

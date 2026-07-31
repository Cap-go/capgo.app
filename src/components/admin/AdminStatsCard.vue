<script setup lang="ts">
import { computed } from 'vue'
import { formatNumberValue } from '~/services/formatLocale'

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  value: {
    type: [Number, String],
    default: undefined,
  },
  unit: {
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
  colorClass: {
    type: String,
    default: 'text-primary',
  },
  subtitle: {
    type: String,
    default: '',
  },
  clickable: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['click'])

const showEvolution = computed(() => props.evolution !== undefined && props.evolution !== null)
const displayValue = computed(() => {
  if (props.value === undefined || props.value === null)
    return '-'
  if (typeof props.value === 'number')
    return formatNumberValue(props.value)
  return props.value
})

function handleClick() {
  if (props.clickable)
    emit('click')
}
</script>

<template>
  <div
    class="flex flex-col justify-between p-6 bg-white border rounded-lg shadow-lg border-slate-300 dark:bg-gray-800 dark:border-slate-900"
    :class="{ 'cursor-pointer hover:shadow-xl transition-shadow': clickable }"
    @click="handleClick"
  >
    <!-- Loading state -->
    <div class="flex items-start justify-between">
      <p class="text-sm text-slate-600 dark:text-slate-400">
        {{ title }}
      </p>

      <div
        v-if="showEvolution"
        class="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full shadow-sm"
        :class="{
          'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200': (evolution ?? 0) >= 0,
          'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200': (evolution ?? 0) < 0,
        }"
      >
        {{ (evolution ?? 0) < 0 ? '' : '+' }}{{ formatNumberValue(evolution ?? 0, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}%
      </div>
    </div>

    <div>
      <div v-if="isLoading" class="my-2">
        <span class="loading loading-spinner loading-lg" :class="[colorClass]" />
      </div>

      <p v-else class="mt-2 text-3xl font-bold" :class="colorClass">
        {{ displayValue }}<span v-if="unit" class="text-2xl font-normal"> {{ unit }}</span>
      </p>

      <p v-if="subtitle" class="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {{ subtitle }}
      </p>
    </div>
  </div>
</template>

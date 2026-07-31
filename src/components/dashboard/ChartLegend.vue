<script setup lang="ts">
import type { ChartLegendItem } from './chartLegend'

defineProps<{
  items: ChartLegendItem[]
}>()
</script>

<template>
  <ul
    v-if="items.length"
    tabindex="0"
    role="list"
    aria-label="Chart legend"
    class="mt-3 flex max-w-full shrink-0 gap-4 overflow-x-auto overflow-y-hidden whitespace-nowrap pb-1 pr-1 [scrollbar-gutter:stable]"
  >
    <li v-for="item in items" :key="item.id" class="flex max-w-[12rem] shrink-0 items-center gap-2 text-sm text-slate-700 dark:text-white">
      <span
        class="h-3 w-9 shrink-0 rounded-sm border"
        :style="{ backgroundColor: item.backgroundColor, borderColor: item.borderColor }"
        aria-hidden="true"
      />
      <span class="min-w-0 truncate">{{ item.label }}</span>
    </li>
  </ul>
</template>

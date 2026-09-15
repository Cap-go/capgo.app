<script setup lang="ts">
import IconInformation from '~icons/heroicons/information-circle'

defineProps<{
  label: string
  widthClass?: string
}>()
</script>

<template>
  <div class="relative inline-flex group">
    <button
      type="button"
      class="inline-flex items-center"
      :aria-label="label"
    >
      <IconInformation class="h-4 w-4 cursor-help text-slate-400 transition-colors group-hover:text-slate-600 dark:text-slate-400 dark:group-hover:text-slate-200" />
    </button>
    <div
      class="pointer-events-none absolute bottom-full right-0 z-20 mb-2 rounded-lg bg-gray-800 px-3 py-2 text-xs text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      :class="widthClass ?? 'w-56'"
      role="tooltip"
    >
      {{ label }}
      <div class="absolute -bottom-1 right-2 h-2 w-2 rotate-45 bg-gray-800" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
          {{ title }}
        </h2>
        <slot name="badges" />
      </div>
      <p v-if="description" class="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {{ description }}
      </p>
      <slot />
    </div>
    <slot name="actions" />
  </div>
</template>

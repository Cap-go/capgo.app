<script setup lang="ts">
import type { Component } from 'vue'

// Page-level state shown in place of content: missing record, disabled
// feature, nothing to show yet.
defineProps<{
  title: string
  description?: string
  icon?: Component
  iconClass?: string
}>()
</script>

<template>
  <div class="flex flex-col justify-center items-center px-4 min-h-[50vh] text-center">
    <component :is="icon" v-if="icon" class="mb-4 w-16 h-16" :class="iconClass ?? 'text-slate-500 dark:text-slate-400'" aria-hidden="true" />
    <h2 class="text-xl font-semibold text-slate-900 dark:text-white">
      {{ title }}
    </h2>
    <p v-if="description" class="mt-2 max-w-md text-slate-600 dark:text-slate-400">
      {{ description }}
    </p>
    <slot name="action" />
  </div>
</template>

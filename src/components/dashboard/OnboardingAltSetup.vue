<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  compressed: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <details
    v-if="compressed"
    class="d-collapse group rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-white/15 dark:bg-slate-950/90"
    data-test="onboarding-alt-setup"
  >
    <summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-slate-950 marker:content-none focus:outline-none focus:ring-2 focus:ring-primary-500 dark:text-white [&::-webkit-details-marker]:hidden">
      {{ t('app-onboarding-alt-setup-summary') }}
    </summary>
    <div class="space-y-4 border-t border-slate-200 px-4 py-4 dark:border-white/10">
      <slot />
    </div>
  </details>
  <div v-else class="space-y-4" data-test="onboarding-alt-setup">
    <slot />
  </div>
</template>

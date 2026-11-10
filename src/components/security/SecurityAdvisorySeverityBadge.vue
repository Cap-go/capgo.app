<script setup lang="ts">
import type { AdvisorySeverity } from '~/services/securityUpdates'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  severity: AdvisorySeverity
}>()

const { t } = useI18n()

const classes = computed(() => {
  switch (props.severity) {
    case 'critical':
      return 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200'
    case 'high':
      return 'bg-orange-100 text-orange-900 dark:bg-orange-950/50 dark:text-orange-200'
    case 'moderate':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200'
  }
})
</script>

<template>
  <span class="d-badge d-badge-sm border-0 font-semibold uppercase tracking-wide" :class="classes">
    {{ t(`security-updates-severity-${severity}`) }}
  </span>
</template>

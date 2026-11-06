<script setup lang="ts">
import type { ChangelogSectionType } from '~/services/changelog'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  type: ChangelogSectionType
  count?: number
}>()

const { t } = useI18n()

const STYLES: Record<ChangelogSectionType, string> = {
  added: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/30',
  changed: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/30',
  fixed: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-white/5 dark:text-slate-300 dark:ring-white/15',
  security: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/30',
  removed: 'bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/30',
  deprecated: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30',
  other: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-white/5 dark:text-slate-400 dark:ring-white/15',
}

const label = computed(() => t(`changelog-type-${props.type}`))
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset whitespace-nowrap"
    :class="STYLES[type]"
  >
    {{ label }}
    <span v-if="count !== undefined" class="font-mono font-medium opacity-70">{{ count }}</span>
  </span>
</template>

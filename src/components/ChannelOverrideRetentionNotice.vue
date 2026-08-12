<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import IconExternalLink from '~icons/heroicons/arrow-top-right-on-square'
import IconInformationCircle from '~icons/heroicons/information-circle'

withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})

const { t } = useI18n()

const docsUrl = 'https://capgo.app/docs/live-updates/channels/'
</script>

<template>
  <aside
    role="status"
    class="rounded-xl border border-azure-200/80 bg-azure-50/90 text-slate-700 dark:border-azure-500/25 dark:bg-azure-500/10 dark:text-slate-200"
    :class="compact ? 'px-3 py-2.5' : 'px-4 py-3.5'"
  >
    <div class="flex items-start gap-3">
      <span
        class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-azure-500/15 text-azure-700 dark:bg-azure-400/15 dark:text-azure-200"
        aria-hidden="true"
      >
        <IconInformationCircle class="size-5" />
      </span>
      <div class="min-w-0 flex-1 space-y-1.5">
        <p
          class="font-semibold text-slate-900 dark:text-white"
          :class="compact ? 'text-sm' : 'text-sm sm:text-base'"
        >
          {{ t('channel-override-retention-title') }}
        </p>
        <i18n-t
          keypath="channel-override-retention-desc"
          tag="p"
          class="text-sm leading-6 text-slate-600 dark:text-slate-300"
        >
          <template #days>
            <span class="font-semibold tabular-nums text-slate-800 dark:text-slate-100">90</span>
          </template>
          <template #defaultChannel>
            <code class="rounded-md bg-white/80 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-800 ring-1 ring-slate-200/80 dark:bg-slate-900/60 dark:text-slate-100 dark:ring-slate-700">defaultChannel</code>
          </template>
          <template #setChannel>
            <code class="rounded-md bg-white/80 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-800 ring-1 ring-slate-200/80 dark:bg-slate-900/60 dark:text-slate-100 dark:ring-slate-700">setChannel()</code>
          </template>
        </i18n-t>
        <a
          :href="docsUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-azure-700 underline-offset-2 transition-colors hover:text-azure-800 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:text-azure-300 dark:hover:text-azure-200 dark:focus-visible:ring-offset-slate-900"
        >
          {{ t('channel-override-retention-learn-more') }}
          <IconExternalLink class="size-4 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import IconExternalLink from '~icons/heroicons/arrow-top-right-on-square'
import IconInformationCircle from '~icons/heroicons/information-circle'
import IconXMark from '~icons/heroicons/x-mark'

withDefaults(defineProps<{
  /** Show a text label next to the help icon. */
  showLabel?: boolean
}>(), {
  showLabel: false,
})

const { t } = useI18n()
const open = defineModel<boolean>('open', { default: false })

/** Keep in sync with cleanup_old_channel_devices retention (90 days). */
const CHANNEL_OVERRIDE_RETENTION_DAYS = 90

const docsUrl = 'https://capgo.app/docs/live-updates/channels/'
const panelId = `channel-override-retention-${useId()}`
</script>

<template>
  <div class="flex w-full flex-col gap-2" :class="showLabel ? 'items-start' : 'items-end'">
    <button
      type="button"
      class="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:text-slate-400 dark:hover:bg-slate-700/70 dark:hover:text-slate-100 dark:focus-visible:ring-offset-slate-900"
      :aria-expanded="open"
      :aria-controls="panelId"
      :aria-label="t('channel-override-retention-help')"
      @click="open = !open"
    >
      <IconInformationCircle class="size-5 shrink-0 text-azure-600 dark:text-azure-300" aria-hidden="true" />
      <span v-if="showLabel">
        {{ t('channel-override-retention-help') }}
      </span>
    </button>

    <aside
      v-if="open"
      :id="panelId"
      role="region"
      :aria-label="t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS })"
      class="w-full rounded-xl border border-azure-200/80 bg-azure-50 p-3.5 text-left text-slate-700 dark:border-azure-500/25 dark:bg-slate-900/80 dark:text-slate-200"
      :class="showLabel ? 'max-w-3xl' : 'max-w-md'"
    >
      <div class="flex items-start gap-3">
        <span
          class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-azure-500/15 text-azure-700 dark:bg-azure-400/15 dark:text-azure-200"
          aria-hidden="true"
        >
          <IconInformationCircle class="size-5" />
        </span>
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex items-start justify-between gap-2">
            <p class="text-sm font-semibold text-slate-900 dark:text-white">
              {{ t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS }) }}
            </p>
            <button
              type="button"
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:hover:bg-slate-700 dark:hover:text-slate-100"
              :aria-label="t('close')"
              @click="open = false"
            >
              <IconXMark class="size-4" aria-hidden="true" />
            </button>
          </div>
          <i18n-t
            keypath="channel-override-retention-desc"
            tag="p"
            class="text-sm leading-6 text-slate-600 dark:text-slate-300"
          >
            <template #days>
              <span class="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{{ CHANNEL_OVERRIDE_RETENTION_DAYS }}</span>
            </template>
            <template #defaultChannel>
              <code class="rounded-md bg-white/80 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-800 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700">defaultChannel</code>
            </template>
            <template #setChannel>
              <code class="rounded-md bg-white/80 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-800 ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700">setChannel()</code>
            </template>
          </i18n-t>
          <a
            :href="docsUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-azure-700 underline-offset-2 transition-colors hover:text-azure-800 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:text-azure-300 dark:hover:text-azure-200 dark:focus-visible:ring-offset-slate-900"
          >
            {{ t('channel-override-retention-learn-more') }}
            <IconExternalLink class="size-4 shrink-0" aria-hidden="true" />
          </a>
        </div>
      </div>
    </aside>
  </div>
</template>

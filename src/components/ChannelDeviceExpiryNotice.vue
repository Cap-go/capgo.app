<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import IconInfo from '~icons/lucide/info'

withDefaults(defineProps<{
  compact?: boolean
}>(), {
  compact: false,
})

const { t } = useI18n()
const titleId = useId()

const persistentChannelDocsUrl = 'https://capgo.app/docs/plugin/api/#setchannel'
</script>

<template>
  <aside
    role="note"
    data-test="channel-device-expiry-notice"
    class="flex items-start gap-3 rounded-lg border border-azure-500/30 bg-azure-500/5 px-3.5 py-3 dark:border-azure-400/30 dark:bg-azure-500/10"
    :aria-labelledby="compact ? undefined : titleId"
  >
    <IconInfo
      class="mt-0.5 size-5 shrink-0 text-azure-600 dark:text-azure-300"
      aria-hidden="true"
    />
    <div class="min-w-0">
      <p
        v-if="!compact"
        :id="titleId"
        class="text-sm font-semibold leading-5 text-slate-900 dark:text-white"
      >
        {{ t('channel-device-expiry-title') }}
      </p>
      <i18n-t
        keypath="channel-device-expiry-description"
        tag="p"
        class="text-sm leading-6 text-slate-600 dark:text-slate-300"
        :class="{ 'mt-1': !compact }"
      >
        <template #defaultChannel>
          <code class="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-100">defaultChannel</code>
        </template>
        <template #setChannel>
          <code class="rounded bg-white px-1.5 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-100">setChannel()</code>
        </template>
      </i18n-t>
      <a
        :href="persistentChannelDocsUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-azure-700 underline decoration-azure-600/40 underline-offset-2 transition-colors hover:text-azure-800 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-300 dark:hover:text-azure-200"
        :aria-label="`${t('learn-more')} (${t('channel-device-expiry-title')})`"
      >
        {{ t('learn-more') }}
      </a>
    </div>
  </aside>
</template>

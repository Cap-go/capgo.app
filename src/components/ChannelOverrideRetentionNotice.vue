<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import IconExternalLink from '~icons/heroicons/arrow-top-right-on-square'
import IconChevronDown from '~icons/heroicons/chevron-down'
import IconInformationCircle from '~icons/heroicons/information-circle'

withDefaults(defineProps<{
  /** Show labeled disclosure (list / dialog). Icon-only popover when false. */
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
const root = useTemplateRef<HTMLElement>('root')

onClickOutside(root, () => {
  if (open.value)
    open.value = false
})

function toggle() {
  open.value = !open.value
}
</script>

<template>
  <!-- Labeled progressive disclosure (channel device list / dialog / empty state) -->
  <div v-if="showLabel" class="w-full">
    <button
      type="button"
      class="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-sm text-slate-500 transition-colors duration-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:text-slate-400 dark:hover:text-slate-100 dark:focus-visible:ring-offset-slate-900"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="toggle"
    >
      <IconInformationCircle class="size-4 shrink-0" aria-hidden="true" />
      <span>{{ t('channel-override-retention-help') }}</span>
      <IconChevronDown
        class="size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
        :class="open ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0 -translate-y-0.5"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-0.5"
    >
      <div
        v-if="open"
        :id="panelId"
        role="region"
        :aria-label="t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS })"
        class="mt-2 max-w-2xl border-l-2 border-azure-500 py-1 pl-4"
      >
        <p class="text-sm font-medium text-slate-900 dark:text-white">
          {{ t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS }) }}
        </p>
        <i18n-t
          keypath="channel-override-retention-desc"
          tag="p"
          class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300"
        >
          <template #days>
            <span class="font-medium tabular-nums text-slate-800 dark:text-slate-100">{{ CHANNEL_OVERRIDE_RETENTION_DAYS }}</span>
          </template>
          <template #defaultChannel>
            <code class="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100">defaultChannel</code>
          </template>
          <template #setChannel>
            <code class="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100">setChannel()</code>
          </template>
        </i18n-t>
        <a
          :href="docsUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-azure-700 underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-300"
        >
          {{ t('channel-override-retention-learn-more') }}
          <IconExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </Transition>
  </div>

  <!-- Icon popover (device detail channel override row) -->
  <div
    v-else
    ref="root"
    class="relative inline-flex"
  >
    <button
      type="button"
      class="inline-flex size-11 items-center justify-center rounded-md text-slate-400 transition-colors duration-200 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:hover:bg-slate-700/60 dark:hover:text-slate-100 dark:focus-visible:ring-offset-slate-900"
      :aria-expanded="open"
      :aria-controls="panelId"
      :aria-label="t('channel-override-retention-help')"
      @click="toggle"
    >
      <IconInformationCircle class="size-5" aria-hidden="true" />
    </button>

    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="opacity-0 translate-y-1 scale-[0.98]"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
      leave-from-class="opacity-100 translate-y-0 scale-100"
      leave-to-class="opacity-0 translate-y-1 scale-[0.98]"
    >
      <div
        v-if="open"
        :id="panelId"
        role="dialog"
        :aria-label="t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS })"
        class="absolute right-0 top-full z-40 mt-1 w-[min(100vw-2rem,20rem)] rounded-lg border border-slate-200 bg-white p-3.5 text-left shadow-lg dark:border-slate-600 dark:bg-slate-800"
      >
        <p class="text-sm font-medium text-slate-900 dark:text-white">
          {{ t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS }) }}
        </p>
        <i18n-t
          keypath="channel-override-retention-desc"
          tag="p"
          class="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300"
        >
          <template #days>
            <span class="font-medium tabular-nums text-slate-800 dark:text-slate-100">{{ CHANNEL_OVERRIDE_RETENTION_DAYS }}</span>
          </template>
          <template #defaultChannel>
            <code class="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-700 dark:text-slate-100">defaultChannel</code>
          </template>
          <template #setChannel>
            <code class="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-700 dark:text-slate-100">setChannel()</code>
          </template>
        </i18n-t>
        <a
          :href="docsUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-azure-700 underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-300"
        >
          {{ t('channel-override-retention-learn-more') }}
          <IconExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </Transition>
  </div>
</template>

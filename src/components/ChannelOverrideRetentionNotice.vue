<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import IconExternalLink from '~icons/heroicons/arrow-top-right-on-square'
import IconInformationCircle from '~icons/heroicons/information-circle'

withDefaults(defineProps<{
  /** Optional visible label next to the icon. */
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
const panel = useTemplateRef<HTMLElement>('panel')
const panelPos = ref({ top: 0, left: 0 })

onClickOutside(root, (event) => {
  if (!open.value)
    return
  const target = event.target as Node | null
  if (target && panel.value?.contains(target))
    return
  open.value = false
})

function placePanel() {
  const el = root.value
  if (!el)
    return
  const rect = el.getBoundingClientRect()
  const width = Math.min(window.innerWidth - 16, 352)
  let left = rect.right - width
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
  panelPos.value = {
    top: Math.round(rect.bottom + 8),
    left: Math.round(left),
  }
}

function toggle() {
  open.value = !open.value
}

watch(open, async (isOpen) => {
  if (!isOpen)
    return
  await nextTick()
  placePanel()
})
</script>

<template>
  <div ref="root" class="relative inline-flex items-center">
    <button
      type="button"
      class="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 focus-visible:ring-offset-2 dark:text-gray-200 dark:hover:bg-gray-700 dark:hover:text-white dark:focus-visible:ring-offset-gray-900"
      :aria-expanded="open"
      :aria-controls="panelId"
      :aria-label="t('channel-override-retention-help')"
      @click="toggle"
    >
      <IconInformationCircle class="size-5 shrink-0 text-azure-600 dark:text-azure-300" aria-hidden="true" />
      <span v-if="showLabel">{{ t('channel-override-retention-help') }}</span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        :id="panelId"
        ref="panel"
        role="dialog"
        :aria-label="t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS })"
        class="fixed z-[100] w-[min(100vw-2rem,22rem)] rounded-lg border border-gray-200 bg-white p-4 text-left shadow-xl dark:border-gray-600 dark:bg-gray-800"
        :style="{ top: `${panelPos.top}px`, left: `${panelPos.left}px` }"
      >
        <p class="text-sm font-semibold text-gray-900 dark:text-white">
          {{ t('channel-override-retention-title', { days: CHANNEL_OVERRIDE_RETENTION_DAYS }) }}
        </p>
        <i18n-t
          keypath="channel-override-retention-desc"
          tag="p"
          class="mt-2 text-sm leading-6 text-gray-700 dark:text-gray-200"
        >
          <template #days>
            <span class="font-semibold tabular-nums text-gray-900 dark:text-white">{{ CHANNEL_OVERRIDE_RETENTION_DAYS }}</span>
          </template>
          <template #defaultChannel>
            <code class="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs font-medium text-gray-900 dark:bg-gray-700 dark:text-gray-100">defaultChannel</code>
          </template>
          <template #setChannel>
            <code class="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs font-medium text-gray-900 dark:bg-gray-700 dark:text-gray-100">setChannel()</code>
          </template>
        </i18n-t>
        <a
          :href="docsUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-azure-700 underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-azure-300"
        >
          {{ t('channel-override-retention-learn-more') }}
          <IconExternalLink class="size-3.5 shrink-0" aria-hidden="true" />
        </a>
      </div>
    </Teleport>
  </div>
</template>

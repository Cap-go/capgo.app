<script setup lang="ts">
import type { BundleListChannel } from '~/services/bundleLinkedChannels'
import { computed, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAnchorPopover } from '~/composables/useAnchorPopover'
import { formatBundleListChannels, mergeBundleListChannels } from '~/services/bundleLinkedChannels'

const props = defineProps<{
  appId: string
  channels: BundleListChannel[]
}>()

const { t } = useI18n()
const router = useRouter()
const titleId = `${useId()}-bundle-channels-title`
const panelId = `${useId()}-bundle-channels-panel`
const triggerRef = useTemplateRef<HTMLButtonElement>('triggerRef')
const popoverRef = useTemplateRef<HTMLElement>('popoverRef')

const {
  isOpen,
  popoverStyle,
  finePointer,
  cancelClose,
  closePanel,
  openPanel,
  togglePanel,
  onTriggerLeave,
} = useAnchorPopover({ triggerRef, popoverRef, defaultWidth: 280, align: 'start' })

const merged = computed(() => mergeBundleListChannels(props.channels))
const label = computed(() => formatBundleListChannels(merged.value).label)

function onTriggerClick(event: MouseEvent) {
  event.stopPropagation()
  // Single channel: navigate directly (no need for a one-item menu).
  if (merged.value.length === 1) {
    router.push(`/app/${props.appId}/channel/${merged.value[0].id}`)
    return
  }
  if (event.detail === 0) {
    togglePanel(true)
    return
  }
  if (finePointer.value) {
    if (!isOpen.value)
      void openPanel()
    return
  }
  togglePanel()
}

function onTriggerEnter() {
  if (finePointer.value && merged.value.length > 1)
    void openPanel()
}

function goToChannel(channelId: number) {
  closePanel()
  router.push(`/app/${props.appId}/channel/${channelId}`)
}
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="w-full cursor-pointer rounded-md text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
    :aria-label="label"
    :aria-expanded="merged.length > 1 ? isOpen : undefined"
    :aria-controls="merged.length > 1 ? panelId : undefined"
    :aria-haspopup="merged.length > 1 ? 'dialog' : undefined"
    data-test="bundle-row-channels"
    @click="onTriggerClick"
    @mouseenter="onTriggerEnter"
    @mouseleave="onTriggerLeave"
  >
    {{ label }}
  </button>

  <Teleport to="body">
    <div
      v-if="isOpen && merged.length > 1"
      :id="panelId"
      ref="popoverRef"
      role="dialog"
      :aria-labelledby="titleId"
      class="fixed z-[100] flex max-h-[calc(100dvh-1.5rem)] w-[min(18rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl bg-white p-3 shadow-xl ring-1 ring-black/5 dark:bg-slate-900 dark:shadow-none dark:ring-white/10"
      :style="popoverStyle"
      data-test="bundle-row-channels-popover"
      @mouseenter="cancelClose"
      @mouseleave="onTriggerLeave"
    >
      <h3 :id="titleId" class="shrink-0 px-2 pb-2 text-sm font-semibold text-slate-950 dark:text-white">
        {{ t('channels') }}
      </h3>
      <ul class="min-h-0 flex-1 space-y-0.5 overflow-auto">
        <li v-for="channel in merged" :key="channel.id">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-left text-sm font-medium text-azure-600 underline-offset-2 hover:bg-azure-50 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500 dark:text-azure-400 dark:hover:bg-slate-800"
            :data-test="`bundle-row-channel-${channel.id}`"
            @click.stop="goToChannel(channel.id)"
          >
            {{ channel.name }}
          </button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>

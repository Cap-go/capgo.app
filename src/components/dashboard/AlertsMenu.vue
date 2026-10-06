<script setup lang="ts">
import type { ReleaseLiveDeployment, ReleaseLiveRollout } from '~/composables/useReleaseLive'
import { onClickOutside, useElementBounding, useMutationObserver, useWindowSize } from '@vueuse/core'
import { computed, onMounted, ref, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import IconBell from '~icons/lucide/bell'
import CompatibilityBanner from '~/components/dashboard/CompatibilityBanner.vue'
import DeploymentBanner from '~/components/dashboard/DeploymentBanner.vue'
import ReleaseBanner from '~/components/dashboard/ReleaseBanner.vue'

// The deploy, release and compatibility banners used to stack above the
// overview and push the data below the fold. They now live behind one calm
// "Activity" button with a count; the banners stay mounted so each keeps loading its own
// state and the count stays accurate.
defineProps<{
  appId: string
  release: ReleaseLiveDeployment | null
  adoptionPercent: number | null
  rollout?: ReleaseLiveRollout | null
}>()

const emit = defineEmits<{
  deployed: []
}>()

const { t } = useI18n()
const open = ref(false)
const alertCount = ref(0)
const panelId = useId()
const toggle = useTemplateRef<HTMLElement>('toggle')
const panel = useTemplateRef<HTMLElement>('panel')
const stack = useTemplateRef<HTMLElement>('stack')

// The panel lives in a fixed layer on <body>: page containers clip overflow,
// so an absolutely positioned dropdown got cut when the button sits mid-row.
// It is placed under the button and clamped to the viewport.
const PANEL_MAX_WIDTH = 640
const VIEWPORT_GUTTER = 16
const { bottom: toggleBottom, left: toggleLeft, update: updateToggleBounds } = useElementBounding(toggle)
const { width: viewportWidth } = useWindowSize()
const panelStyle = computed(() => {
  const width = Math.min(PANEL_MAX_WIDTH, viewportWidth.value - VIEWPORT_GUTTER * 2)
  const maxLeft = viewportWidth.value - width - VIEWPORT_GUTTER
  // Opens rightward from the button, into the page rather than over the sidebar.
  const left = Math.min(Math.max(toggleLeft.value, VIEWPORT_GUTTER), maxLeft)
  return { top: `${toggleBottom.value + 8}px`, left: `${left}px`, width: `${width}px` }
})

function toggleOpen() {
  updateToggleBounds()
  open.value = !open.value
}

function countAlerts() {
  // Hidden banners render as comment nodes, so element children are the
  // banners that currently have something to say.
  alertCount.value = stack.value?.children.length ?? 0
  if (alertCount.value === 0)
    open.value = false
}

useMutationObserver(stack, countAlerts, { childList: true })
onMounted(countAlerts)
onClickOutside(panel, () => {
  open.value = false
}, { ignore: [toggle] })
</script>

<template>
  <div class="relative" data-testid="alerts-menu">
    <button
      v-show="alertCount > 0"
      ref="toggle"
      type="button"
      class="relative inline-flex items-center gap-2 px-3 text-sm font-medium transition-colors bg-white border rounded-lg h-11 border-slate-200 text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:border-white/10 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
      :aria-expanded="open"
      :aria-controls="panelId"
      :title="t('activity')"
      data-testid="alerts-menu-toggle"
      @click="toggleOpen"
      @keydown.escape="open = false"
    >
      <IconBell class="w-4 h-4" />
      <span class="sr-only">{{ t('activity') }}</span>
      <span class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-semibold text-white rounded-full bg-azure-500">
        {{ alertCount }}
      </span>
    </button>
    <Teleport to="body">
      <div
        v-show="open"
        :id="panelId"
        ref="panel"
        class="fixed z-50 p-2 bg-white border shadow-xl rounded-xl border-slate-200 dark:bg-slate-800 dark:border-white/10"
        :style="panelStyle"
        data-testid="alerts-menu-panel"
        @keydown.escape="open = false"
      >
        <div ref="stack" class="flex flex-col gap-2 [&>*]:mb-0!">
          <CompatibilityBanner :app-id="appId" />
          <DeploymentBanner :app-id="appId" @deployed="emit('deployed')" />
          <ReleaseBanner :app-id="appId" :release="release" :adoption-percent="adoptionPercent" :rollout="rollout" />
        </div>
      </div>
    </Teleport>
  </div>
</template>

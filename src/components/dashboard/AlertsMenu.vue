<script setup lang="ts">
import type { ReleaseLiveDeployment } from '~/composables/useReleaseLive'
import { onClickOutside, useMutationObserver } from '@vueuse/core'
import { onMounted, ref, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import IconBell from '~icons/lucide/bell'
import CompatibilityBanner from '~/components/dashboard/CompatibilityBanner.vue'
import DeploymentBanner from '~/components/dashboard/DeploymentBanner.vue'
import ReleaseBanner from '~/components/dashboard/ReleaseBanner.vue'

// The deploy, release and compatibility banners used to stack above the
// overview and push the data below the fold. They now live behind one bell
// button with a count; the banners stay mounted so each keeps loading its own
// state and the count stays accurate.
defineProps<{
  appId: string
  release: ReleaseLiveDeployment | null
  adoptionPercent: number | null
}>()

const emit = defineEmits<{
  deployed: []
}>()

const { t } = useI18n()
const open = ref(false)
const alertCount = ref(0)
const panelId = useId()
const root = useTemplateRef<HTMLElement>('root')
const stack = useTemplateRef<HTMLElement>('stack')

function countAlerts() {
  // Hidden banners render as comment nodes, so element children are the
  // banners that currently have something to say.
  alertCount.value = stack.value?.children.length ?? 0
  if (alertCount.value === 0)
    open.value = false
}

useMutationObserver(stack, countAlerts, { childList: true })
onMounted(countAlerts)
onClickOutside(root, () => {
  open.value = false
})
</script>

<template>
  <div ref="root" class="relative" data-testid="alerts-menu">
    <button
      v-show="alertCount > 0"
      type="button"
      class="relative inline-flex items-center gap-2 px-3 text-sm font-medium transition-colors border rounded-lg h-11 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-700/70 dark:bg-amber-900/20 dark:text-amber-200 dark:hover:bg-amber-900/30"
      :aria-expanded="open"
      :aria-controls="panelId"
      data-testid="alerts-menu-toggle"
      @click="open = !open"
      @keydown.escape="open = false"
    >
      <IconBell class="w-4 h-4" />
      {{ t('alerts') }}
      <span class="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-semibold text-white rounded-full bg-amber-600">
        {{ alertCount }}
      </span>
    </button>
    <div
      v-show="open"
      :id="panelId"
      class="absolute right-0 z-30 mt-2 top-full w-[min(640px,calc(100vw-32px))] p-2 bg-white border shadow-xl rounded-xl border-slate-200 dark:bg-slate-800 dark:border-white/10"
      data-testid="alerts-menu-panel"
    >
      <div ref="stack" class="flex flex-col gap-2 [&>*]:mb-0!">
        <CompatibilityBanner :app-id="appId" />
        <DeploymentBanner :app-id="appId" @deployed="emit('deployed')" />
        <ReleaseBanner :app-id="appId" :release="release" :adoption-percent="adoptionPercent" />
      </div>
    </div>
  </div>
</template>

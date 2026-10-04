<script setup lang="ts">
import type { ReleaseLiveDeployment } from '~/composables/useReleaseLive'
import { useMutationObserver } from '@vueuse/core'
import { onMounted, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import CompatibilityBanner from '~/components/dashboard/CompatibilityBanner.vue'
import DeploymentBanner from '~/components/dashboard/DeploymentBanner.vue'
import ReleaseBanner from '~/components/dashboard/ReleaseBanner.vue'

// The deploy, release and compatibility banners used to stack above the
// overview and push the data below the fold. They are ordered by urgency and
// only the first visible one shows until the user expands the rest.
defineProps<{
  appId: string
  release: ReleaseLiveDeployment | null
  adoptionPercent: number | null
}>()

const emit = defineEmits<{
  deployed: []
}>()

const { t } = useI18n()
const expanded = ref(false)
const visibleCount = ref(0)
const stack = useTemplateRef<HTMLElement>('stack')

function countBanners() {
  // Hidden banners render as comment nodes, so element children are the
  // banners that currently have something to say.
  visibleCount.value = stack.value?.children.length ?? 0
  if (visibleCount.value <= 1)
    expanded.value = false
}

useMutationObserver(stack, countBanners, { childList: true })
onMounted(countBanners)
</script>

<template>
  <div v-show="visibleCount > 0" class="flex items-start min-w-0 gap-2" data-testid="attention-bar">
    <div
      ref="stack"
      class="flex flex-col flex-1 min-w-0 gap-2 [&>*]:mb-0!"
      :class="expanded ? '' : '[&>*+*]:hidden!'"
    >
      <CompatibilityBanner :app-id="appId" />
      <DeploymentBanner :app-id="appId" @deployed="emit('deployed')" />
      <ReleaseBanner :app-id="appId" :release="release" :adoption-percent="adoptionPercent" />
    </div>
    <button
      v-if="visibleCount > 1"
      type="button"
      class="self-center px-2 py-1 text-xs font-medium rounded-md shrink-0 text-slate-600 bg-slate-200/70 hover:bg-slate-200 dark:text-slate-300 dark:bg-slate-700/60 dark:hover:bg-slate-700"
      :aria-expanded="expanded"
      data-testid="attention-bar-toggle"
      @click="expanded = !expanded"
    >
      {{ expanded ? t('show-less') : t('attention-more', { count: visibleCount - 1 }) }}
    </button>
  </div>
</template>

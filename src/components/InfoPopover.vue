<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { ref, useId, useTemplateRef } from 'vue'
import IconInfo from '~icons/lucide/info'

// Long explanations used to sit in full-width notes above the data. This keeps
// them one click away so the data stays above the fold.
const props = withDefaults(defineProps<{
  label: string
  align?: 'left' | 'right'
}>(), {
  align: 'left',
})

const open = ref(false)
const panelId = useId()
const root = useTemplateRef<HTMLElement>('root')

onClickOutside(root, () => {
  open.value = false
})
</script>

<template>
  <span ref="root" class="relative inline-flex align-middle">
    <button
      type="button"
      class="inline-flex items-center justify-center w-6 h-6 rounded-full text-slate-400 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-azure-500 dark:text-slate-500 dark:hover:text-slate-200"
      :aria-label="props.label"
      :title="props.label"
      :aria-expanded="open"
      :aria-controls="panelId"
      data-testid="info-popover-trigger"
      @click="open = !open"
      @keydown.escape="open = false"
    >
      <IconInfo class="w-4 h-4" />
    </button>
    <div
      v-if="open"
      :id="panelId"
      role="dialog"
      :aria-label="props.label"
      class="absolute z-30 top-full mt-2 w-[min(360px,calc(100vw-32px))] p-4 text-sm font-normal normal-case tracking-normal text-left bg-white border rounded-xl shadow-xl border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-white/10 dark:text-slate-200"
      :class="props.align === 'right' ? 'right-0' : 'left-0'"
      data-testid="info-popover-panel"
    >
      <slot />
    </div>
  </span>
</template>

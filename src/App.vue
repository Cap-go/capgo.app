<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'
import { useWebMcp } from '~/composables/useWebMcp'

const Toast = defineAsyncComponent(() => import('~/components/Toast.vue'))
const DialogV2 = defineAsyncComponent(() => import('~/components/DialogV2.vue'))
const SupportUsernamesPrompt = defineAsyncComponent(() => import('~/components/dashboard/SupportUsernamesPrompt.vue'))

const route = useRoute()
const display = useDisplayStore()

useWebMcp()

watch(
  () => route.path,
  (path) => {
    display.updatePathTitle(path)
  },
  { immediate: true },
)
</script>

<template>
  <div class="app-shell h-full overflow-hidden bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
    <RouterView class="h-full overflow-hidden" />
    <Toast />
    <DialogV2 />
    <SupportUsernamesPrompt />
  </div>
</template>

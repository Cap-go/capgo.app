<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'

const Toast = defineAsyncComponent(() => import('~/components/Toast.vue'))
const DialogV2 = defineAsyncComponent(() => import('~/components/DialogV2.vue'))
const SupportUsernamesPrompt = defineAsyncComponent(() => import('~/components/dashboard/SupportUsernamesPrompt.vue'))

const ChinaConsoleSuggestion = defineAsyncComponent(() => import('~/components/ChinaConsoleSuggestion.vue'))

const route = useRoute()
const display = useDisplayStore()

watch(
  () => route.path,
  (path) => {
    display.updatePathTitle(path)
  },
  { immediate: true },
)
</script>

<template>
  <div class="app-shell flex h-full min-h-0 flex-col overflow-hidden bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
    <ChinaConsoleSuggestion />
    <RouterView class="min-h-0 flex-1 overflow-auto" />
    <Toast />
    <DialogV2 />
    <SupportUsernamesPrompt />
  </div>
</template>

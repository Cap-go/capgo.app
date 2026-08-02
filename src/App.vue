<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'
import DialogV2 from '~/components/DialogV2.vue'

const Toast = defineAsyncComponent(() => import('~/components/Toast.vue'))

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
  <div class="app-shell h-full overflow-hidden bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
    <RouterView class="h-full overflow-hidden" />
    <Toast />
    <DialogV2 />
  </div>
</template>

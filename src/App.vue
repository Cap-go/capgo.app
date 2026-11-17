<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'
import { CHANNEL_CHANGE_DIALOG_ID } from '~/composables/useChannelChangeConfirm'

const Toast = defineAsyncComponent(() => import('~/components/Toast.vue'))
const DialogV2 = defineAsyncComponent(() => import('~/components/DialogV2.vue'))
const SupportUsernamesPrompt = defineAsyncComponent(() => import('~/components/dashboard/SupportUsernamesPrompt.vue'))
// Loaded on first use: the impact confirm for channel bundle changes (set, promote, rollout, revert).
const ChannelChangeDialog = defineAsyncComponent(() => import('~/components/channel/ChannelChangeDialog.vue'))

const route = useRoute()
const display = useDisplayStore()
const dialogStore = useDialogV2Store()

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
    <ChannelChangeDialog v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID" />
    <SupportUsernamesPrompt />
  </div>
</template>

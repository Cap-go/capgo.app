<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'
import { CHANNEL_CHANGE_DIALOG_ID } from '~/composables/useChannelChangeConfirm'

const Toast = defineAsyncComponent(() => import('~/components/Toast.vue'))
const DialogV2 = defineAsyncComponent(() => import('~/components/DialogV2.vue'))
const SupportUsernamesPrompt = defineAsyncComponent(() => import('~/components/dashboard/SupportUsernamesPrompt.vue'))
// Loaded on first use: the impact confirm for channel bundle changes (set, promote, rollout, revert).
const ChannelChangeDialog = defineAsyncComponent(() => import('~/components/channel/ChannelChangeDialog.vue'))

const ChinaConsoleSuggestion = defineAsyncComponent(() => import('~/components/ChinaConsoleSuggestion.vue'))

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

// The impact confirm describes one change to one channel: leaving the page
// cancels it, so it can never be confirmed from a page the user already left.
watch(() => route.path, () => {
  if (dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID)
    void dialogStore.closeDialog()
})
</script>

<template>
  <div class="app-shell flex h-full min-h-0 flex-col overflow-hidden bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
    <ChinaConsoleSuggestion />
    <RouterView class="min-h-0 flex-1 overflow-auto" />
    <Toast />
    <DialogV2 />
    <ChannelChangeDialog v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === CHANNEL_CHANGE_DIALOG_ID" />
    <SupportUsernamesPrompt />
  </div>
</template>

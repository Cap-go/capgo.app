<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAppNavigation } from '~/composables/useAppNavigation'
import { useDialogV2Store } from '~/stores/dialogv2'

const dialogStore = useDialogV2Store()
const { t } = useI18n()
const { logAsInput, submitLogAsDialog } = useAppNavigation()
</script>

<template>
  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.title === t('log-as')" to="#dialog-v2-content" defer>
    <div class="w-full">
      <label for="log-as-input" class="sr-only">{{ t('user-email-or-org-id') }}</label>
      <input
        id="log-as-input"
        v-model="logAsInput"
        type="text"
        :placeholder="t('user-email-or-org-id')"
        :aria-label="t('user-email-or-org-id')"
        class="p-3 w-full rounded-lg border border-gray-300 dark:text-white dark:bg-gray-800 dark:border-gray-600"
        @keydown.enter.prevent="submitLogAsDialog"
      >
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useGitHubProfileDialog } from '~/composables/useGitHubProfileDialog'

const props = withDefaults(defineProps<{
  dialogId?: string
}>(), {
  dialogId: 'github-profile',
})

const { t } = useI18n()

const {
  dialogStore,
  githubUsername,
  githubUsernameInput,
  githubProfile,
  githubProfileLoading,
  githubProfileSaving,
  githubProfileError,
  openGitHubProfileDialog,
  closeGitHubProfileDialog,
  findGitHubProfile,
  confirmGitHubProfile,
  clearGitHubProfile,
} = useGitHubProfileDialog(props.dialogId)

defineExpose({
  githubUsername,
  openGitHubProfileDialog,
})
</script>

<template>
  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === dialogId" to="#dialog-v2-content" defer>
    <div>
      <template v-if="!githubProfile">
        <label :for="`${dialogId}-input`" class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {{ t('github-username') }}
        </label>
        <input
          :id="`${dialogId}-input`"
          v-model="githubUsernameInput"
          type="text"
          autocomplete="off"
          maxlength="39"
          class="d-input w-full"
          :disabled="githubProfileLoading || githubProfileSaving"
          :placeholder="t('github-username-placeholder')"
          @keydown.enter.prevent="findGitHubProfile"
        >
      </template>

      <div v-else class="flex items-center gap-4 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <img :src="githubProfile.avatarUrl" :alt="githubProfile.login" class="h-16 w-16 rounded-full" width="64" height="64">
        <div class="min-w-0">
          <p class="truncate font-semibold text-gray-900 dark:text-white">
            {{ githubProfile.name || githubProfile.login }}
          </p>
          <p class="text-sm text-gray-500 dark:text-gray-400">
            @{{ githubProfile.login }}
          </p>
        </div>
      </div>

      <p v-if="githubProfile" class="mt-4 text-sm text-gray-600 dark:text-gray-300">
        {{ t('github-username-confirm-description') }}
      </p>
      <p v-if="githubProfileError" class="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
        {{ githubProfileError }}
      </p>

      <div class="mt-6 flex justify-end gap-3">
        <button type="button" class="d-btn d-btn-ghost" :disabled="githubProfileLoading || githubProfileSaving" @click="closeGitHubProfileDialog">
          {{ t('button-cancel') }}
        </button>
        <button
          v-if="!githubProfile && githubUsername"
          type="button"
          class="d-btn d-btn-error"
          :aria-label="t('button-remove')"
          :disabled="githubProfileLoading || githubProfileSaving"
          @click="clearGitHubProfile"
        >
          <Spinner v-if="githubProfileSaving" size="w-4 h-4" />
          <span v-else>{{ t('button-remove') }}</span>
        </button>
        <button
          v-if="githubProfile"
          type="button"
          class="d-btn d-btn-primary"
          :disabled="githubProfileSaving"
          @click="confirmGitHubProfile"
        >
          <Spinner v-if="githubProfileSaving" size="w-4 h-4" />
          <span v-else>{{ t('github-username-confirm') }}</span>
        </button>
        <button
          v-else
          type="button"
          class="d-btn d-btn-primary"
          :disabled="githubProfileLoading || !githubUsernameInput.trim()"
          @click="findGitHubProfile"
        >
          <Spinner v-if="githubProfileLoading" size="w-4 h-4" />
          <span v-else>{{ t('next') }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { GitHubProfile } from '~/services/githubProfile'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconDiscord from '~icons/ic/round-discord'
import IconGithub from '~icons/lucide/github'
import { getGitHubProfile, GitHubProfileError } from '~/services/githubProfile'
import { useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'

const discordUsername = defineModel<string>('discordUsername', { required: true })

const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const dialogStore = useDialogV2Store()

const githubUsername = ref(main.user?.github_username ?? '')
const githubUsernameInput = ref('')
const githubProfile = ref<GitHubProfile | null>(null)
const githubProfileLoading = ref(false)
const githubProfileSaving = ref(false)
const githubProfileError = ref('')
let githubProfileLookupGeneration = 0

watch(() => main.user?.github_username, (value) => {
  githubUsername.value = value ?? ''
})

function resetGitHubProfileDialog() {
  githubProfileLookupGeneration += 1
  githubProfile.value = null
  githubProfileError.value = ''
  githubProfileLoading.value = false
}

function closeGitHubProfileDialog() {
  resetGitHubProfileDialog()
  dialogStore.closeDialog({ text: t('button-cancel'), role: 'cancel' })
}

function openGitHubProfileDialog() {
  resetGitHubProfileDialog()
  githubUsernameInput.value = githubUsername.value
  dialogStore.openDialog({
    id: 'onboarding-github-profile',
    title: t('github-username'),
    description: t('github-username-dialog-description'),
    size: 'sm',
    buttons: [],
    preventAccidentalClose: true,
  })
}

async function findGitHubProfile() {
  if (githubProfileLoading.value)
    return

  const lookupGeneration = githubProfileLookupGeneration
  const username = githubUsernameInput.value
  githubProfileError.value = ''
  githubProfileLoading.value = true
  try {
    const profile = await getGitHubProfile(username)
    if (lookupGeneration === githubProfileLookupGeneration)
      githubProfile.value = profile
  }
  catch (error) {
    if (lookupGeneration !== githubProfileLookupGeneration)
      return

    githubProfile.value = null
    if (error instanceof GitHubProfileError)
      githubProfileError.value = t(`github-username-error-${error.code}`)
    else
      githubProfileError.value = t('github-username-error-request_failed')
  }
  finally {
    if (lookupGeneration === githubProfileLookupGeneration)
      githubProfileLoading.value = false
  }
}

async function confirmGitHubProfile() {
  if (!githubProfile.value || !main.user?.id || githubProfileSaving.value)
    return

  const userId = main.user.id
  const dialogGeneration = githubProfileLookupGeneration
  githubProfileSaving.value = true
  const { data: user, error } = await supabase
    .from('users')
    .update({
      github_id: githubProfile.value.id,
      github_username: githubProfile.value.login,
    })
    .eq('id', userId)
    .select()
    .single()

  githubProfileSaving.value = false
  if (main.user?.id !== userId)
    return

  if (error || !user) {
    githubProfile.value = null
    githubProfileError.value = t('account-error')
    return
  }

  main.user = user
  githubUsername.value = user.github_username ?? ''
  if (dialogGeneration !== githubProfileLookupGeneration)
    return

  toast.success(t('account-updated-succ'))
  dialogStore.closeDialog({ text: t('confirm'), role: 'primary' })
  resetGitHubProfileDialog()
}

async function clearGitHubProfile() {
  if (!main.user?.id || githubProfileSaving.value)
    return

  const userId = main.user.id
  githubProfileSaving.value = true
  const { data: user, error } = await supabase
    .from('users')
    .update({
      github_id: null,
      github_username: null,
    })
    .eq('id', userId)
    .select()
    .single()

  githubProfileSaving.value = false
  if (main.user?.id !== userId)
    return

  if (error || !user) {
    githubProfileError.value = t('account-error')
    return
  }

  main.user = user
  githubUsername.value = ''
  toast.success(t('account-updated-succ'))
  dialogStore.closeDialog({ text: t('button-remove'), role: 'danger' })
  resetGitHubProfileDialog()
}
</script>

<template>
  <div class="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
    <div>
      <h3 class="text-sm font-semibold text-slate-950 dark:text-white">
        {{ t('organization-onboarding-support-usernames-title') }}
      </h3>
      <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
        {{ t('organization-onboarding-support-usernames-helper') }}
      </p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div>
        <label for="onboarding-discord-username" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
          <IconDiscord class="h-4 w-4 text-primary-500" />
          <span>{{ t('discord-username') }}</span>
          <span class="font-normal text-slate-400">{{ t('optional') }}</span>
        </label>
        <input
          id="onboarding-discord-username"
          v-model="discordUsername"
          type="text"
          autocomplete="off"
          maxlength="32"
          :placeholder="t('discord-username')"
          aria-describedby="onboarding-support-usernames-help"
          data-test="onboarding-discord-username"
          class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
        >
      </div>

      <div>
        <label for="onboarding-github-username" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
          <IconGithub class="h-4 w-4 text-primary-500" />
          <span>{{ t('github-username') }}</span>
          <span class="font-normal text-slate-400">{{ t('optional') }}</span>
        </label>
        <button
          id="onboarding-github-username"
          type="button"
          class="mt-2 flex min-h-11 w-full items-center rounded-xl border border-slate-300 bg-white px-3 text-left text-base text-slate-950 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
          aria-describedby="onboarding-support-usernames-help"
          data-test="onboarding-github-username"
          @click="openGitHubProfileDialog"
        >
          <span v-if="githubUsername" class="truncate">{{ githubUsername }}</span>
          <span v-else class="truncate text-slate-400 dark:text-slate-500">{{ t('github-username-select') }}</span>
        </button>
      </div>
    </div>

    <p id="onboarding-support-usernames-help" class="text-xs leading-5 text-slate-500 dark:text-slate-400">
      {{ t('social-username-help') }}
    </p>
  </div>

  <Teleport v-if="dialogStore.showDialog && dialogStore.dialogOptions?.id === 'onboarding-github-profile'" to="#dialog-v2-content" defer>
    <div>
      <template v-if="!githubProfile">
        <label for="onboarding-github-username-input" class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {{ t('github-username') }}
        </label>
        <input
          id="onboarding-github-username-input"
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
      <p v-if="githubProfileError" class="mt-3 text-sm text-red-600 dark:text-red-400">
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

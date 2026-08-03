<script setup lang="ts">
import type { GitHubProfile } from '~/services/githubProfile'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconDiscord from '~icons/ic/round-discord'
import IconBadgeCheck from '~icons/lucide/badge-check'
import IconChevronRight from '~icons/lucide/chevron-right'
import IconGithub from '~icons/lucide/github'
import IconHeadset from '~icons/lucide/headset'
import IconSparkles from '~icons/lucide/sparkles'
import IconZap from '~icons/lucide/zap'
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

const supportBenefits = computed(() => [
  { icon: IconBadgeCheck, label: t('organization-onboarding-support-benefit-match') },
  { icon: IconZap, label: t('organization-onboarding-support-benefit-maker') },
  { icon: IconSparkles, label: t('organization-onboarding-support-benefit-trial') },
])

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
  <section
    class="overflow-hidden rounded-2xl border border-primary-500/20 bg-linear-to-br from-primary-500/5 via-white to-slate-50 shadow-sm dark:border-primary-500/30 dark:from-primary-500/10 dark:via-slate-950/90 dark:to-slate-950"
    aria-labelledby="onboarding-support-usernames-title"
  >
    <div class="space-y-4 p-4 sm:p-5">
      <div class="flex items-start gap-3">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white shadow-sm shadow-primary-500/30">
          <IconHeadset class="h-5 w-5" aria-hidden="true" />
        </span>
        <div class="min-w-0">
          <h3 id="onboarding-support-usernames-title" class="text-base font-semibold text-slate-950 dark:text-white">
            {{ t('organization-onboarding-support-usernames-title') }}
          </h3>
          <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('organization-onboarding-support-usernames-helper') }}
          </p>
        </div>
      </div>

      <ul class="flex flex-wrap gap-2" :aria-label="t('organization-onboarding-support-usernames-title')">
        <li
          v-for="benefit in supportBenefits"
          :key="benefit.label"
          class="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white/90 px-3 text-xs font-medium text-slate-700 dark:border-white/15 dark:bg-slate-900/80 dark:text-slate-200"
        >
          <component :is="benefit.icon" class="h-3.5 w-3.5 text-primary-500" aria-hidden="true" />
          <span>{{ benefit.label }}</span>
        </li>
      </ul>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/15 dark:bg-slate-950/80">
          <label for="onboarding-discord-username" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <IconDiscord class="h-4 w-4 text-primary-500" aria-hidden="true" />
            <span>{{ t('discord-username') }}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {{ t('optional') }}
            </span>
          </label>
          <div class="relative mt-2">
            <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400" aria-hidden="true">
              @
            </span>
            <input
              id="onboarding-discord-username"
              v-model="discordUsername"
              type="text"
              autocomplete="off"
              maxlength="32"
              :placeholder="t('discord-username')"
              aria-describedby="onboarding-discord-username-help"
              data-test="onboarding-discord-username"
              class="min-h-11 w-full rounded-xl border border-slate-300 bg-white py-2 pr-3 pl-8 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 sm:text-sm dark:border-white/20 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
            >
          </div>
          <p id="onboarding-discord-username-help" class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('discord-username-help') }}
          </p>
        </div>

        <div class="rounded-xl border border-slate-200 bg-white p-3 dark:border-white/15 dark:bg-slate-950/80">
          <label for="onboarding-github-username" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
            <IconGithub class="h-4 w-4 text-primary-500" aria-hidden="true" />
            <span>{{ t('github-username') }}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {{ t('optional') }}
            </span>
          </label>
          <button
            id="onboarding-github-username"
            type="button"
            class="mt-2 flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-left text-base text-slate-950 outline-none transition hover:border-primary-500/50 hover:bg-primary-500/5 focus-visible:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-500/15 sm:text-sm dark:border-white/20 dark:bg-slate-950 dark:text-white dark:hover:border-primary-500/50 dark:hover:bg-primary-500/10 dark:focus-visible:border-primary-500 dark:focus-visible:ring-primary-500/30"
            aria-describedby="onboarding-github-username-help"
            data-test="onboarding-github-username"
            @click="openGitHubProfileDialog"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2">
              <template v-if="githubUsername">
                <IconBadgeCheck class="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                <span class="truncate font-medium">{{ githubUsername }}</span>
                <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  {{ t('organization-onboarding-support-github-verified') }}
                </span>
              </template>
              <span v-else class="truncate text-slate-500 dark:text-slate-400">
                {{ t('organization-onboarding-support-github-cta') }}
              </span>
            </span>
            <IconChevronRight class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
          </button>
          <p id="onboarding-github-username-help" class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {{ t('github-username-help') }}
          </p>
        </div>
      </div>

      <p id="onboarding-support-usernames-help" class="text-xs leading-5 text-slate-500 dark:text-slate-400">
        {{ t('social-username-help') }}
      </p>
    </div>
  </section>

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

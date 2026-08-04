<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { toast } from 'vue-sonner'
import OnboardingSupportUsernames from '~/components/dashboard/OnboardingSupportUsernames.vue'
import { useSupabase } from '~/services/supabase'
import {
  dismissSupportUsernamesPromptForever,
  isOnboardingOrganizationSet,
  markSupportUsernamesPromptShown,
  shouldShowSupportUsernamesPrompt,
} from '~/services/supportUsernamesPrompt'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

const PROMPT_DELAY_MS = 2500

const { t } = useI18n()
const route = useRoute()
const main = useMainStore()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()
const organizationStore = useOrganizationStore()

const isOpen = ref(false)
const isSaving = ref(false)
const discordUsername = ref('')
let showTimer: ReturnType<typeof setTimeout> | undefined

const isOnboarding = computed(() => {
  const organizations = organizationStore.organizations
    .filter(org => !isPendingOrganizationInvite(org))

  // Organization state is loaded asynchronously. Hide the prompt until it is known that the user is past onboarding.
  if (organizationStore.organizations.length === 0 || organizations.length === 0)
    return true

  return isOnboardingOrganizationSet(organizations)
})

const blockedPath = computed(() => {
  const path = route.path
  return path.startsWith('/login')
    || path.startsWith('/register')
    || path.startsWith('/forgot_password')
    || path.startsWith('/resend_email')
    || path.startsWith('/onboarding')
    || path.startsWith('/confirm-signup')
    || path.startsWith('/sso-callback')
    || path.startsWith('/delete_account')
})

function syncDiscordFromUser() {
  discordUsername.value = main.user?.discord_username ?? ''
}

function canOpenPrompt() {
  if (isOnboarding.value || blockedPath.value || dialogStore.showDialog || isOpen.value)
    return false
  return shouldShowSupportUsernamesPrompt(main.user)
}

function openPrompt() {
  if (!canOpenPrompt() || !main.user?.id)
    return
  syncDiscordFromUser()
  markSupportUsernamesPromptShown(main.user.id)
  isOpen.value = true
}

function schedulePrompt() {
  if (showTimer)
    clearTimeout(showTimer)
  if (!canOpenPrompt())
    return
  showTimer = setTimeout(() => {
    openPrompt()
  }, PROMPT_DELAY_MS)
}

function closePrompt() {
  isOpen.value = false
}

function remindLater() {
  if (main.user?.id)
    markSupportUsernamesPromptShown(main.user.id)
  closePrompt()
}

function dismissForever() {
  if (main.user?.id)
    dismissSupportUsernamesPromptForever(main.user.id)
  closePrompt()
}

async function saveDiscordUsername() {
  if (!main.user?.id)
    return false

  const userId = main.user.id
  const nextDiscordUsername = discordUsername.value.trim() || null
  if (nextDiscordUsername === (main.user.discord_username || null))
    return true

  const { data: user, error } = await supabase
    .from('users')
    .update({
      discord_username: nextDiscordUsername,
    })
    .eq('id', userId)
    .select()
    .single()

  if (main.user?.id !== userId)
    return false

  if (error || !user) {
    toast.error(t('organization-onboarding-support-usernames-save-failed'))
    return false
  }

  main.user = user
  return true
}

async function saveAndClose() {
  if (isSaving.value)
    return
  isSaving.value = true
  try {
    const saved = await saveDiscordUsername()
    if (!saved)
      return
    toast.success(t('account-updated-succ'))
    closePrompt()
  }
  finally {
    isSaving.value = false
  }
}

watch(
  () => [main.user?.id, main.user?.discord_username, main.user?.github_username, route.path, dialogStore.showDialog, isOnboarding.value] as const,
  () => {
    if (isOnboarding.value || !shouldShowSupportUsernamesPrompt(main.user) || blockedPath.value) {
      if (showTimer)
        clearTimeout(showTimer)
      if (isOnboarding.value)
        closePrompt()
      return
    }
    schedulePrompt()
  },
  { immediate: true },
)

onMounted(() => {
  syncDiscordFromUser()
})

onBeforeUnmount(() => {
  if (showTimer)
    clearTimeout(showTimer)
})
</script>

<template>
  <div
    v-if="isOpen"
    class="d-modal d-modal-open z-50"
    role="dialog"
    aria-modal="true"
    :aria-label="t('support-usernames-prompt-title')"
    data-test="support-usernames-prompt"
  >
    <button type="button" class="d-modal-backdrop bg-black/50" :aria-label="t('button-cancel')" @click="remindLater" />
    <div class="d-modal-box max-w-2xl bg-white p-0 dark:bg-slate-900">
      <div class="space-y-4 p-5 sm:p-6">
        <div>
          <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
            {{ t('support-usernames-prompt-title') }}
          </h2>
          <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('support-usernames-prompt-helper') }}
          </p>
        </div>

        <OnboardingSupportUsernames
          v-model:discord-username="discordUsername"
          dialog-id="support-usernames-prompt-github"
          compact
          hide-intro
        />

        <div class="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-white/15">
          <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              class="d-btn d-btn-ghost min-h-11"
              data-test="support-usernames-remind-later"
              :disabled="isSaving"
              @click="remindLater"
            >
              {{ t('support-usernames-prompt-remind-later') }}
            </button>
            <button
              type="button"
              class="d-btn d-btn-primary min-h-11"
              data-test="support-usernames-save"
              :disabled="isSaving"
              @click="saveAndClose"
            >
              <Spinner v-if="isSaving" size="w-4 h-4" />
              <span v-else>{{ t('support-usernames-prompt-save') }}</span>
            </button>
          </div>
          <div class="text-center sm:text-left">
            <button
              type="button"
              class="text-xs text-slate-400 underline-offset-2 transition hover:text-slate-500 hover:underline dark:text-slate-500 dark:hover:text-slate-400"
              data-test="support-usernames-dismiss-forever"
              :disabled="isSaving"
              @click="dismissForever"
            >
              {{ t('support-usernames-prompt-dismiss-forever') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

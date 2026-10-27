<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import IconBot from '~icons/lucide/bot'
import IconListChecks from '~icons/lucide/list-checks'
import IconLoader from '~icons/lucide/loader-2'
import AiAgentTaskCard from '~/components/dashboard/AiAgentTaskCard.vue'
import { developmentEnvironmentOptions } from '~/components/dashboard/onboardingDevelopmentEnvironmentOptions'
import OnboardingToolPattern from '~/components/dashboard/OnboardingToolPattern.vue'
import { useConsole } from '~/services/console'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { useOrganizationStore } from '~/stores/organization'
import { onboardingSecondaryButtonClass } from '~/utils/onboardingButtonClasses'
import { getAppGettingStartedPath } from '~/utils/onboardingRedirect'

// Lets the user add an app with their AI agent or with the manual wizard.
const emit = defineEmits<{ manual: [] }>()

const APP_POLL_INTERVAL_MS = 3000

const { t } = useI18n()
const router = useRouter()
const capgo = useConsole()
const organizationStore = useOrganizationStore()

const screen = ref<'choice' | 'ai'>('choice')
const isWaiting = ref(false)
const assistantIcons = developmentEnvironmentOptions.find(option => option.value === 'ai_assistant')?.icons ?? []
// Creation time of the newest app before the prompt was copied; only later apps count.
let appCursor: string | null | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
// Bumped whenever waiting stops, so a pending start or check from before is dropped.
let watchSession = 0
let checking = false

async function newestAppCreatedAt(orgId: string) {
  const { data, error } = await capgo
    .from('apps')
    .select('created_at')
    .eq('owner_org', orgId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error)
    throw error
  return data?.[0]?.created_at ?? null
}

async function firstAppAfter(orgId: string, cursor: string | null) {
  let query = capgo
    .from('apps')
    .select('app_id')
    .eq('owner_org', orgId)
  if (cursor)
    query = query.gt('created_at', cursor)
  const { data, error } = await query.order('created_at', { ascending: true }).limit(1)
  if (error)
    throw error
  return data?.[0]?.app_id ?? null
}

function stopPolling() {
  watchSession += 1
  isWaiting.value = false
  if (pollTimer)
    clearInterval(pollTimer)
  pollTimer = undefined
}

async function checkForNewApp(orgId: string, session: number) {
  if (document.visibilityState === 'hidden' || appCursor === undefined || checking)
    return
  checking = true
  try {
    const appId = await firstAppAfter(orgId, appCursor)
    if (!appId || session !== watchSession)
      return
    stopPolling()
    sendOnboardingEvent('add_app_ai_app_detected', { org_id: orgId, app_id: appId })
    await router.push(getAppGettingStartedPath(appId))
  }
  catch (error) {
    console.warn('Cannot check for the app added by the AI agent', error)
  }
  finally {
    checking = false
  }
}

// Once the prompt is copied, open the new app as soon as the agent registers it.
async function watchForNewApp() {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || isWaiting.value)
    return
  const session = ++watchSession
  isWaiting.value = true
  try {
    appCursor = await newestAppCreatedAt(orgId)
  }
  catch (error) {
    console.warn('Cannot list apps before the AI agent adds one', error)
    if (session === watchSession)
      isWaiting.value = false
    return
  }
  // The user went back, chose manual or left while the cursor loaded.
  if (session !== watchSession)
    return
  pollTimer = setInterval(() => void checkForNewApp(orgId, session), APP_POLL_INTERVAL_MS)
}

function choose(mode: 'ai' | 'manual') {
  sendOnboardingEvent('add_app_setup_mode_selected', { setup_mode: mode, org_id: organizationStore.currentOrganization?.gid ?? '' })
  if (mode === 'manual') {
    emit('manual')
    return
  }
  screen.value = 'ai'
}

function backToChoice() {
  stopPolling()
  screen.value = 'choice'
}

onBeforeUnmount(stopPolling)
</script>

<template>
  <section class="h-full overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-slate-950">
    <div class="mx-auto w-full max-w-3xl">
      <div v-if="screen === 'choice'" class="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="add-app-setup-mode">
        <div>
          <h2 class="text-2xl font-semibold text-slate-950 dark:text-white">
            {{ t('add-app-mode-title') }}
          </h2>
          <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('ai-onboarding-mode-subtitle') }}
          </p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            class="d-btn d-btn-ghost group relative h-auto min-h-[13rem] w-full flex-col items-start justify-end gap-0 overflow-hidden whitespace-normal rounded-xl border border-primary-500 bg-white p-5 text-left ring-2 ring-primary-500/15 transition hover:border-primary-500 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:bg-slate-950/90 dark:hover:bg-slate-900"
            data-test="add-app-setup-mode-ai"
            @click="choose('ai')"
          >
            <OnboardingToolPattern :icons="assistantIcons" muted />
            <span class="relative z-10 mb-auto inline-flex items-center gap-1.5 rounded-full bg-primary-500 px-2.5 py-1 text-xs font-semibold text-white">
              {{ t('ai-onboarding-mode-recommended') }}
            </span>
            <span class="relative z-10 mt-6 flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
              <IconBot class="h-5 w-5 text-primary-500" aria-hidden="true" />
              {{ t('ai-onboarding-mode-ai-label') }}
            </span>
            <span class="relative z-10 mt-1 block text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('ai-onboarding-mode-ai-desc') }}
            </span>
          </button>

          <button
            type="button"
            class="d-btn d-btn-ghost group h-auto min-h-[13rem] w-full flex-col items-start justify-end gap-0 whitespace-normal rounded-xl border border-slate-200 bg-white p-5 text-left transition hover:border-primary-500/40 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/15 dark:bg-slate-950/90 dark:hover:border-white/30 dark:hover:bg-slate-900"
            data-test="add-app-setup-mode-manual"
            @click="choose('manual')"
          >
            <span class="flex items-center gap-2 text-base font-semibold text-slate-950 dark:text-white">
              <IconListChecks class="h-5 w-5 text-slate-500 dark:text-slate-400" aria-hidden="true" />
              {{ t('ai-onboarding-mode-manual-label') }}
            </span>
            <span class="mt-1 block text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('ai-onboarding-mode-manual-desc') }}
            </span>
          </button>
        </div>
      </div>

      <div v-else class="space-y-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="add-app-ai">
        <div>
          <h2 class="text-2xl font-semibold text-slate-950 dark:text-white">
            {{ t('ai-onboarding-prompt-title') }}
          </h2>
          <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {{ t('ai-onboarding-prompt-subtitle') }}
          </p>
        </div>

        <AiAgentTaskCard task="add-app" @copied="watchForNewApp" />

        <p v-if="isWaiting" class="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300" data-test="add-app-ai-waiting" role="status">
          <IconLoader class="h-4 w-4 shrink-0 animate-spin text-primary-500" aria-hidden="true" />
          {{ t('ai-onboarding-waiting-for-app') }}
        </p>

        <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between dark:border-white/15">
          <button type="button" class="d-btn min-h-12" :class="onboardingSecondaryButtonClass" data-test="add-app-ai-back" @click="backToChoice">
            {{ t('button-back') }}
          </button>
          <button type="button" class="d-btn min-h-12" :class="onboardingSecondaryButtonClass" data-test="add-app-ai-manual" @click="choose('manual')">
            {{ t('ai-onboarding-switch-manual') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

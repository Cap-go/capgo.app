<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconCircleCheck from '~icons/lucide/circle-check'
import IconCopy from '~icons/lucide/copy'
import IconLoader from '~icons/lucide/loader-2'
import IconShieldCheck from '~icons/lucide/shield-check'
import AppOnboardingHeader from '~/components/dashboard/AppOnboardingHeader.vue'
import AppOnboardingPageFrame from '~/components/dashboard/AppOnboardingPageFrame.vue'
import { developmentEnvironmentOptions } from '~/components/dashboard/onboardingDevelopmentEnvironmentOptions'
import { createDefaultApiKey, findUsablePlainApiKey, shareInFlightApiKeyLoad } from '~/services/apikeys'
import { buildAiOnboardingPrompt } from '~/services/cliAiPrompt'
import { useConsole } from '~/services/console'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { replaceUserOnboardingWithRetry, serializeUserOnboardingWrite } from '~/services/userOnboardingWriteQueue'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { onboardingPrimaryButtonClass, onboardingSecondaryButtonClass } from '~/utils/onboardingButtonClasses'
import { allowOnboardingDashboardExploration, getAppGettingStartedPath, ONBOARDING_DASHBOARD_EXPLORED_EVENT } from '~/utils/onboardingRedirect'
import { readAiAgentProgress, readAiOnboardingGoal, withOnboardingSetupMode } from '~/utils/onboardingSetupMode'

// Must match AI_ONBOARDING_API_KEY_NAME in the backend agent marker.
const AI_ONBOARDING_API_KEY_NAME = 'ai-onboarding'
const APP_POLL_INTERVAL_MS = 3000
// Long enough to read the confirmation, short enough to feel automatic.
const AUTO_OPEN_DELAY_MS = 2500
const MASKED_KEY = 'capgo_••••••••••••••••'

const { t } = useI18n()
const router = useRouter()
const capgo = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const isLoading = ref(true)
const isLoggingOut = ref(false)
const isLeaving = ref(false)
const loadFailed = ref(false)
const orgLoadFailed = ref(false)
const apiKey = ref<string | null>(null)
const copied = ref(false)
const detectedApp = ref<{ app_id: string, name: string | null } | null>(null)
const agentProgress = ref(readAiAgentProgress(main.user?.onboarding))
const goal = readAiOnboardingGoal(main.user?.onboarding)
const organization = computed(() => organizationStore.currentOrganization)
const assistantIcons = developmentEnvironmentOptions.find(option => option.value === 'ai_assistant')?.icons ?? []
let pollTimer: ReturnType<typeof setInterval> | undefined
let autoOpenTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

const steps = computed(() => [
  { id: 'name', label: t('unified-onboarding-step-about-you') },
  { id: 'mode', label: t('ai-onboarding-step-mode') },
  { id: 'plan', label: t('ai-onboarding-step-plan') },
  { id: 'agent', label: t('ai-onboarding-step-agent') },
])
// Each task ticks off live from what the agent's CLI and MCP report to Capgo.
const agentTasks = computed(() => {
  const appDone = !!detectedApp.value
  return [
    { label: t('ai-onboarding-task-login'), done: appDone || agentProgress.value.agentConnected },
    { label: t('ai-onboarding-task-mcp'), done: appDone || agentProgress.value.mcpConnected },
    { label: t('ai-onboarding-task-app'), done: appDone },
    { label: t(`ai-onboarding-task-setup-${goal ?? 'unsure'}`), done: false },
  ]
})
const waitingMessage = computed(() => {
  if (agentProgress.value.mcpConnected)
    return t('ai-onboarding-waiting-mcp-connected')
  if (agentProgress.value.agentConnected)
    return t('ai-onboarding-waiting-agent-connected')
  return t('ai-onboarding-waiting-for-app')
})

function promptFor(key: string) {
  const org = organization.value
  if (!org)
    return ''
  return buildAiOnboardingPrompt({ apiKey: key, organization: { id: org.gid, name: org.name }, goal })
}

const prompt = computed(() => apiKey.value ? promptFor(apiKey.value) : '')
// Show the prompt without the secret; the real key only goes to the clipboard.
// The key only appears after an explicit reveal, for copying by hand when the clipboard is blocked.
const revealKey = ref(false)
const promptPreview = computed(() => apiKey.value ? promptFor(revealKey.value ? apiKey.value : MASKED_KEY) : '')

async function ensureApiKey(userId: string, orgId: string) {
  // Always hand out the dedicated key: the backend recognizes the agent's first CLI/MCP
  // events by this key name to tick off live progress on this page.
  const existing = await findUsablePlainApiKey(capgo, userId, orgId, null, { name: AI_ONBOARDING_API_KEY_NAME })
  if (existing)
    return existing
  const { data, error } = await createDefaultApiKey(capgo, AI_ONBOARDING_API_KEY_NAME, { orgId })
  if (error)
    throw error
  return typeof data?.key === 'string' ? data.key : await findUsablePlainApiKey(capgo, userId, orgId, null, { name: AI_ONBOARDING_API_KEY_NAME })
}

async function loadApiKey() {
  const userId = main.user?.id ?? main.auth?.id
  const orgId = organization.value?.gid
  if (!userId || !orgId)
    return
  loadFailed.value = false
  try {
    // Right after signup the backend is still processing the new user and organization, and the
    // key insert can lose a database deadlock against that work. One retry covers it.
    const load = () => shareInFlightApiKeyLoad({ userId, orgId, name: AI_ONBOARDING_API_KEY_NAME }, () => ensureApiKey(userId, orgId))
    apiKey.value = await load().catch(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000))
      return load()
    })
    if (!apiKey.value)
      loadFailed.value = true
  }
  catch (error) {
    console.error('Cannot prepare API key for AI onboarding', error)
    loadFailed.value = true
  }
}

async function copyPrompt() {
  if (!prompt.value)
    return
  try {
    await navigator.clipboard.writeText(prompt.value)
    copied.value = true
    toast.success(t('copied-to-clipboard'))
    sendOnboardingEvent('onboarding_ai_setup_prompt_copied', { org_id: organization.value?.gid ?? '' })
  }
  catch (error) {
    // Never put the key in a dialog: it would bypass the masked preview. Point to the reveal toggle instead.
    console.error('Failed to copy AI onboarding prompt', error)
    toast.error(t('ai-onboarding-copy-failed'))
  }
}

async function refreshAgentProgress(userId: string) {
  const { data, error } = await capgo.from('users').select('onboarding').eq('id', userId).maybeSingle()
  if (disposed || error || !data)
    return
  const next = readAiAgentProgress(data.onboarding)
  if (next.agentConnected && !agentProgress.value.agentConnected)
    sendOnboardingEvent('onboarding_ai_agent_connected', { org_id: organization.value?.gid ?? '' })
  if (next.mcpConnected && !agentProgress.value.mcpConnected)
    sendOnboardingEvent('onboarding_ai_mcp_connected', { org_id: organization.value?.gid ?? '' })
  agentProgress.value = next
  // Keep the store current so later onboarding writes compare against the latest row.
  if (main.user?.id === userId)
    main.user = { ...main.user, onboarding: data.onboarding }
}

async function checkForApp() {
  const orgId = organization.value?.gid
  const userId = main.user?.id
  if (disposed || !orgId || detectedApp.value || document.visibilityState === 'hidden')
    return
  const [{ data, error }] = await Promise.all([
    capgo
      .from('apps')
      .select('app_id, name')
      .eq('owner_org', orgId)
      .order('created_at', { ascending: true })
      .limit(1),
    userId ? refreshAgentProgress(userId) : Promise.resolve(),
  ])
  if (disposed || error || !data?.[0] || detectedApp.value)
    return
  detectedApp.value = data[0]
  stopPolling()
  sendOnboardingEvent('onboarding_ai_app_detected', { org_id: orgId, app_id: data[0].app_id })
  // Getting started is where the agent's progress shows live, so go there on our own.
  autoOpenTimer = setTimeout(() => {
    openApp().catch(error => console.error('Failed to open setup progress after AI onboarding', error))
  }, AUTO_OPEN_DELAY_MS)
}

function stopPolling() {
  if (pollTimer)
    clearInterval(pollTimer)
  pollTimer = undefined
}

async function rememberManualSetup() {
  const userId = main.user?.id
  if (!userId)
    return
  try {
    await serializeUserOnboardingWrite(userId, async () => {
      const result = await replaceUserOnboardingWithRetry(userId, main.user!.onboarding, current => withOnboardingSetupMode(current, 'manual'), () => main.user?.id === userId)
      if (result.status === 'persisted' && main.user?.id === userId)
        main.user = { ...main.user, onboarding: result.onboarding }
    })
  }
  catch (error) {
    console.warn('Cannot remember manual onboarding setup', error)
  }
}

async function switchToManual() {
  if (isLeaving.value)
    return
  isLeaving.value = true
  try {
    sendOnboardingEvent('onboarding_ai_switched_to_manual', { org_id: organization.value?.gid ?? '' })
    await rememberManualSetup()
    await router.push('/app/new')
  }
  finally {
    isLeaving.value = false
  }
}

function reloadPage() {
  window.location.reload()
}

async function exploreDashboard() {
  sendOnboardingEvent('onboarding_ai_explore_dashboard', { org_id: organization.value?.gid ?? '' })
  // Same signal as the other "explore the dashboard" exits, emitted before granting exploration.
  window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))
  allowOnboardingDashboardExploration(main.user?.id ?? main.auth?.id)
  await router.push('/dashboard')
}

async function openApp() {
  clearTimeout(autoOpenTimer)
  autoOpenTimer = undefined
  if (!disposed && detectedApp.value)
    await router.push(getAppGettingStartedPath(detectedApp.value.app_id))
}

async function logout() {
  if (isLoggingOut.value)
    return
  isLoggingOut.value = true
  try {
    await main.logout()
    await router.replace('/login')
  }
  catch (error) {
    console.error('Failed to log out from AI onboarding', error)
    toast.error(t('cannot-sign-off'))
  }
  finally {
    isLoggingOut.value = false
  }
}

onMounted(async () => {
  try {
    await organizationStore.awaitInitialLoad()
    if (disposed)
      return
    if (!organization.value) {
      // The plan step may have created the org but failed to refresh the list. Refetch before
      // sending anyone back there, or a retry could create a second organization.
      try {
        await organizationStore.fetchOrganizations()
      }
      catch (error) {
        console.error('Cannot load organizations for AI onboarding', error)
        orgLoadFailed.value = true
        return
      }
      if (disposed)
        return
      if (!organization.value) {
        await router.replace('/onboarding/app')
        return
      }
    }
    await Promise.all([loadApiKey(), checkForApp()])
    // The user may have left while the first requests were pending: never poll from a dead page.
    if (!disposed && !detectedApp.value)
      pollTimer = setInterval(() => void checkForApp(), APP_POLL_INTERVAL_MS)
  }
  finally {
    isLoading.value = false
  }
})

onBeforeUnmount(() => {
  disposed = true
  stopPolling()
  clearTimeout(autoOpenTimer)
})
</script>

<template>
  <AppOnboardingPageFrame :is-logging-out="isLoggingOut" @logout="logout">
    <section class="onboarding-flow-shell onboarding-flow-app-creation h-full min-h-0 flex-1 overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-slate-950">
      <div class="onboarding-flow-content mx-auto w-full max-w-3xl space-y-6">
        <AppOnboardingHeader :title="t('ai-onboarding-agent-title')" :steps="steps" current-step-id="agent" />

        <div v-if="isLoading" class="flex min-h-[40vh] items-center justify-center">
          <Spinner size="w-16 h-16" />
        </div>

        <div v-else-if="orgLoadFailed" role="alert" class="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300" data-test="onboarding-ai-org-load-error">
          {{ t('organization-onboarding-refresh-failed') }}
          <button type="button" class="ml-2 font-semibold underline" data-test="onboarding-ai-org-retry" @click="reloadPage">
            {{ t('retry') }}
          </button>
        </div>

        <template v-else>
          <div v-if="detectedApp" class="rounded-2xl border border-emerald-500/40 bg-emerald-50 p-5 shadow-sm sm:p-6 dark:border-emerald-400/30 dark:bg-emerald-500/10" data-test="onboarding-ai-app-detected">
            <div class="flex gap-3">
              <IconCircleCheck class="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <div class="min-w-0">
                <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
                  {{ t('ai-onboarding-app-detected-title', { name: detectedApp.name || detectedApp.app_id }) }}
                </h2>
                <p class="mt-1 break-all text-sm text-slate-600 dark:text-slate-300">
                  {{ detectedApp.app_id }}
                </p>
                <p class="mt-2 flex items-center gap-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  <IconLoader class="h-4 w-4 animate-spin" aria-hidden="true" />
                  {{ t('ai-onboarding-app-detected-desc') }}
                </p>
              </div>
            </div>
            <div class="mt-5 flex justify-end">
              <button type="button" class="d-btn min-h-12" :class="onboardingPrimaryButtonClass" data-test="onboarding-ai-open-app" @click="openApp">
                {{ t('ai-onboarding-open-app') }}<IconArrowRight class="h-4 w-4" />
              </button>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95" data-test="onboarding-ai-prompt-card">
            <div class="space-y-5">
              <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                    {{ organization?.name }}
                  </p>
                  <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                    {{ t('ai-onboarding-prompt-title') }}
                  </h2>
                  <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    {{ t('ai-onboarding-prompt-subtitle') }}
                  </p>
                </div>
                <div class="flex shrink-0 -space-x-2" aria-hidden="true">
                  <img v-for="icon in assistantIcons" :key="icon" :src="icon" alt="" class="h-8 w-8 rounded-full border-2 border-white bg-white p-1 dark:border-slate-900">
                </div>
              </div>

              <div v-if="loadFailed" role="alert" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                {{ t('app-onboarding-toast-apikey-error') }}
                <button type="button" class="ml-2 font-semibold underline" data-test="onboarding-ai-retry-key" @click="loadApiKey">
                  {{ t('retry') }}
                </button>
              </div>

              <pre
                v-else
                class="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-200 dark:border-white/10"
                :class="{ 'select-all': revealKey }"
                data-test="onboarding-ai-prompt"
              >{{ promptPreview || '…' }}</pre>

              <button
                type="button"
                class="d-btn min-h-14 w-full text-base"
                :class="onboardingPrimaryButtonClass"
                :disabled="!prompt"
                data-test="onboarding-ai-copy-prompt"
                @click="copyPrompt"
              >
                <IconCheck v-if="copied" class="h-5 w-5" />
                <IconCopy v-else class="h-5 w-5" />
                {{ copied ? t('ai-onboarding-prompt-copied') : t('ai-onboarding-copy-prompt') }}
              </button>

              <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <p class="flex items-start gap-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  <IconShieldCheck class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {{ t('ai-onboarding-prompt-key-note') }}
                </p>
                <button
                  v-if="prompt"
                  type="button"
                  class="d-btn d-btn-ghost d-btn-xs shrink-0 text-slate-600 dark:text-slate-300"
                  :aria-pressed="revealKey"
                  data-test="onboarding-ai-reveal-key"
                  @click="revealKey = !revealKey"
                >
                  {{ revealKey ? t('ai-onboarding-hide-key') : t('ai-onboarding-show-key') }}
                </button>
              </div>
            </div>
          </div>

          <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
            <h3 class="text-base font-semibold text-slate-950 dark:text-white">
              {{ t('ai-onboarding-tasks-title') }}
            </h3>
            <ol class="mt-4 space-y-3">
              <li v-for="(task, index) in agentTasks" :key="task.label" class="flex items-start gap-3 text-sm leading-6" :class="task.done ? 'text-slate-500 dark:text-slate-400' : 'text-slate-700 dark:text-slate-200'" :data-test="`onboarding-ai-task-${index + 1}`" :data-done="task.done">
                <span v-if="task.done" class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"><IconCheck class="h-3.5 w-3.5" aria-hidden="true" /></span>
                <span v-else class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-500/10 text-xs font-semibold text-primary-500">{{ index + 1 }}</span>
                <span :class="{ 'line-through decoration-slate-300 dark:decoration-slate-600': task.done }">{{ task.label }}</span>
              </li>
            </ol>
            <div v-if="!detectedApp" class="mt-5 flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:bg-slate-950/60 dark:text-slate-300" role="status" data-test="onboarding-ai-waiting">
              <IconLoader class="h-4 w-4 animate-spin text-primary-500" aria-hidden="true" />
              {{ waitingMessage }}
            </div>
          </div>

          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" class="d-btn min-h-11" :class="onboardingSecondaryButtonClass" :disabled="isLeaving" data-test="onboarding-ai-manual" @click="switchToManual">
              {{ t('ai-onboarding-switch-manual') }}
            </button>
            <button type="button" class="d-btn d-btn-ghost min-h-11 text-slate-600 dark:text-slate-300" data-test="onboarding-ai-explore" @click="exploreDashboard">
              {{ t('ai-onboarding-explore-dashboard') }}
            </button>
          </div>
        </template>
      </div>
    </section>
  </AppOnboardingPageFrame>
</template>

<route lang="yaml">
meta:
  layout: naked
  middleware: auth
</route>

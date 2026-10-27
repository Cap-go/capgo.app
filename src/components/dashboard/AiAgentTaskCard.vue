<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconBot from '~icons/lucide/bot'
import IconCheck from '~icons/lucide/check'
import IconCopy from '~icons/lucide/copy'
import IconLoader from '~icons/lucide/loader-2'
import { createDefaultApiKey, findUsablePlainApiKey, shareInFlightApiKeyLoad } from '~/services/apikeys'
import { buildAiAddAppPrompt, buildAiCreateChannelPrompt, buildAiUploadBundlePrompt } from '~/services/cliAiPrompt'
import { useConsole } from '~/services/console'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

/**
 * "Let my AI agent do it" alternative to a manual console action. Copies a prompt that logs
 * the agent's Capgo CLI in and performs the task. The prompt holds an API key, so it is never
 * shown on screen; it only goes to the clipboard.
 */
type AiAgentTask = 'add-app' | 'upload-bundle' | 'create-channel'

const props = defineProps<{
  task: AiAgentTask
  /** Required for every task except `add-app`. */
  appId?: string
  channelName?: string
  compact?: boolean
}>()

const emit = defineEmits<{ copied: [] }>()

const { t } = useI18n()
const capgo = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()

const isCopying = ref(false)
const copied = ref(false)

async function loadApiKey(userId: string, orgId: string, appId: string | null) {
  return shareInFlightApiKeyLoad({ userId, orgId, appId }, async () => {
    const existing = await findUsablePlainApiKey(capgo, userId, orgId, appId)
    if (existing)
      return existing
    const { data, error } = await createDefaultApiKey(capgo, t('api-key'), { orgId, appId })
    if (error)
      throw error
    return typeof data?.key === 'string' ? data.key : findUsablePlainApiKey(capgo, userId, orgId, appId)
  })
}

async function loadAppName(appId: string) {
  const { data } = await capgo.from('apps').select('name').eq('app_id', appId).maybeSingle()
  return data?.name ?? null
}

async function buildPrompt(): Promise<string | null> {
  const userId = main.user?.id ?? main.auth?.id
  const org = organizationStore.currentOrganization
  if (!userId || !org)
    return null
  const organization = { id: org.gid, name: org.name }
  if (props.task === 'add-app') {
    const apiKey = await loadApiKey(userId, org.gid, null)
    return apiKey ? buildAiAddAppPrompt({ apiKey, organization }) : null
  }
  const appId = props.appId
  if (!appId)
    return null
  const [apiKey, name] = await Promise.all([loadApiKey(userId, org.gid, appId), loadAppName(appId)])
  if (!apiKey)
    return null
  const app = { appId, name }
  return props.task === 'upload-bundle'
    ? buildAiUploadBundlePrompt({ apiKey, organization, app })
    : buildAiCreateChannelPrompt({ apiKey, organization, app, channelName: props.channelName })
}

async function copyPrompt() {
  if (isCopying.value)
    return
  isCopying.value = true
  try {
    let prompt: string | null = null
    try {
      prompt = await buildPrompt()
    }
    catch (error) {
      console.error('Cannot prepare AI agent prompt', error)
    }
    if (!prompt) {
      toast.error(t('app-onboarding-toast-apikey-error'))
      return
    }
    try {
      await navigator.clipboard.writeText(prompt)
    }
    catch (error) {
      // Never fall back to showing the prompt: it contains the API key.
      console.error('Failed to copy AI agent prompt', error)
      toast.error(t('ai-task-copy-failed'))
      return
    }
    copied.value = true
    toast.success(t('ai-onboarding-prompt-copied'))
    sendOnboardingEvent('ai_task_prompt_copied', {
      task: props.task,
      org_id: organizationStore.currentOrganization?.gid ?? '',
      app_id: props.appId ?? '',
    })
    emit('copied')
  }
  finally {
    isCopying.value = false
  }
}
</script>

<template>
  <div
    class="rounded-xl border border-slate-200 bg-slate-50/80 text-left dark:border-white/15 dark:bg-slate-950/60"
    :class="compact ? 'p-3' : 'p-4'"
    :data-test="`ai-task-${task}`"
  >
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex min-w-0 items-start gap-3">
        <IconBot class="mt-0.5 h-5 w-5 shrink-0 text-primary-500" aria-hidden="true" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-slate-950 dark:text-white">
            {{ t('ai-task-title') }}
          </p>
          <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
            {{ t(`ai-task-${task}-desc`) }}
          </p>
        </div>
      </div>
      <button
        type="button"
        class="d-btn min-h-10 shrink-0 self-start border-slate-300 bg-white px-3 text-sm text-slate-800 hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-primary-500 sm:self-auto dark:border-white/20 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
        :disabled="isCopying"
        data-test="ai-task-copy-prompt"
        @click="copyPrompt"
      >
        <IconLoader v-if="isCopying" class="h-4 w-4 animate-spin" aria-hidden="true" />
        <IconCheck v-else-if="copied" class="h-4 w-4 text-emerald-600" aria-hidden="true" />
        <IconCopy v-else class="h-4 w-4" aria-hidden="true" />
        {{ t('ai-onboarding-copy-prompt') }}
      </button>
    </div>
    <p class="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
      {{ t('ai-task-key-note') }}
    </p>
  </div>
</template>

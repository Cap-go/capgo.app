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

// App roles whose key can finish each app task. Uploading to a channel needs
// app.upload_bundle and channel.promote_bundle; creating a channel with --default or
// --self-assign also needs channel.update_settings, which only app_admin grants.
const APP_TASK_ROLES: Record<Exclude<AiAgentTask, 'add-app'>, readonly string[]> = {
  'upload-bundle': ['app_admin', 'app_developer', 'app_uploader'],
  'create-channel': ['app_admin'],
}

// Reuses a key the user already owns when it can do the task. A new key for an app task is
// bound to that app only (app_admin), so app administrators without organization rights can use it.
async function loadApiKey(userId: string, orgId: string, appId: string | null) {
  const appRoles = props.task === 'add-app' ? undefined : APP_TASK_ROLES[props.task]
  return shareInFlightApiKeyLoad({ userId, orgId, appId, appRoles }, async () => {
    const existing = await findUsablePlainApiKey(capgo, userId, orgId, appId, { appRoles })
    if (existing)
      return existing
    const { data, error } = await createDefaultApiKey(capgo, t('api-key'), appId ? { appId } : { orgId })
    if (error)
      throw error
    return typeof data?.key === 'string' ? data.key : findUsablePlainApiKey(capgo, userId, orgId, appId, { appRoles })
  })
}

async function buildPrompt(): Promise<string | null> {
  const userId = main.user?.id ?? main.auth?.id
  if (!userId)
    return null
  if (props.task === 'add-app') {
    const org = organizationStore.currentOrganization
    if (!org)
      return null
    const apiKey = await loadApiKey(userId, org.gid, null)
    return apiKey ? buildAiAddAppPrompt({ apiKey, organization: { id: org.gid, name: org.name } }) : null
  }
  const appId = props.appId
  if (!appId)
    return null
  // App pages can show a different current organization: use the app's own.
  const { data: app, error } = await capgo.from('apps').select('name, owner_org').eq('app_id', appId).maybeSingle()
  if (error || !app?.owner_org)
    return null
  const orgId = app.owner_org
  const organization = { id: orgId, name: organizationStore.organizations.find(org => org.gid === orgId)?.name ?? orgId }
  const apiKey = await loadApiKey(userId, orgId, appId)
  if (!apiKey)
    return null
  const appInfo = { appId, name: app.name }
  return props.task === 'upload-bundle'
    ? buildAiUploadBundlePrompt({ apiKey, organization, app: appInfo })
    : buildAiCreateChannelPrompt({ apiKey, organization, app: appInfo, channelName: props.channelName })
}

/**
 * Starts the clipboard write inside the click: browsers such as Safari reject writes that
 * begin after the user gesture, and the prompt needs async key and app lookups first.
 */
async function writePromptToClipboard(prompt: Promise<string>) {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': prompt.then(text => new Blob([text], { type: 'text/plain' })) })])
    return
  }
  await navigator.clipboard.writeText(await prompt)
}

async function copyPrompt() {
  if (isCopying.value)
    return
  isCopying.value = true
  try {
    let promptFailed = false
    const prompt = buildPrompt().then((text) => {
      if (!text)
        throw new Error('AI agent prompt unavailable')
      return text
    })
    prompt.catch((error) => {
      promptFailed = true
      console.error('Cannot prepare AI agent prompt', error)
    })
    try {
      await writePromptToClipboard(prompt)
    }
    catch (error) {
      // Never fall back to showing the prompt: it contains the API key.
      await prompt.catch(() => undefined)
      if (!promptFailed)
        console.error('Failed to copy AI agent prompt', error)
      toast.error(promptFailed ? t('app-onboarding-toast-apikey-error') : t('ai-task-copy-failed'))
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

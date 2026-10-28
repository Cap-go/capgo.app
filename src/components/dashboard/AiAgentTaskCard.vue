<script setup lang="ts">
import type { AiAgentKeyTask } from '~/services/aiAgentKey'
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconBot from '~icons/lucide/bot'
import IconCheck from '~icons/lucide/check'
import IconCopy from '~icons/lucide/copy'
import IconLoader from '~icons/lucide/loader-2'
import { useSetupMethodPreference } from '~/composables/useSetupMethodPreference'
import { canPrepareAgentKey, loadAgentKey } from '~/services/aiAgentKey'
import { buildAiAddAppPrompt, buildAiCreateChannelPrompt, buildAiRequestBuildPrompt, buildAiUploadBundlePrompt } from '~/services/cliAiPrompt'
import { useConsole } from '~/services/console'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

/**
 * "Let my AI agent do it" alternative to a manual console action. Copies a prompt that logs
 * the agent's Capgo CLI in and performs the task. The prompt holds an API key, so it is never
 * shown on screen; it only goes to the clipboard.
 */

const props = defineProps<{
  task: AiAgentKeyTask
  /** Required for every task except `add-app`. */
  appId?: string
  channelName?: string
  /** `request-build` only: the platform to build. */
  platform?: 'ios' | 'android'
  compact?: boolean
  /** Shows an "or" line next to the card: `before` under a manual form, `after` above one. */
  orSeparator?: 'before' | 'after'
}>()

const emit = defineEmits<{ copied: [] }>()

const { t } = useI18n()
const capgo = useConsole()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const { rememberSetupMethod } = useSetupMethodPreference()

const isCopying = ref(false)
const copied = ref(false)
// The prompt carries an API key; when the user has no suitable key and may not create one,
// the copy would always fail, so the card stays hidden and the manual path remains.
const canPrepareKey = ref(false)

// App pages can show a different current organization: app tasks use the app's own.
async function appOwnerOrg(appId: string) {
  const { data, error } = await capgo.from('apps').select('name, owner_org').eq('app_id', appId).maybeSingle()
  return error || !data?.owner_org ? null : data
}

// Saving the setup preference replaces main.user: only a different user re-runs the check.
const currentUserId = computed(() => main.user?.id ?? main.auth?.id)

watchEffect(async (onCleanup) => {
  // A newer run (task, app, user or organization changed) supersedes this one.
  let stale = false
  onCleanup(() => {
    stale = true
  })
  // Read every reactive input before awaiting, so a change re-runs this check.
  const task = props.task
  const appId = props.appId ?? null
  const userId = currentUserId.value
  const currentOrgId = organizationStore.currentOrganization?.gid ?? null
  const orgId = task === 'add-app' ? currentOrgId : appId ? (await appOwnerOrg(appId))?.owner_org ?? null : null
  const allowed = !!userId && !!orgId && await canPrepareAgentKey(capgo, { userId, orgId, appId: task === 'add-app' ? null : appId, task })
  if (!stale)
    canPrepareKey.value = allowed
})

async function buildPrompt(): Promise<string | null> {
  const userId = main.user?.id ?? main.auth?.id
  if (!userId)
    return null
  if (props.task === 'add-app') {
    const org = organizationStore.currentOrganization
    if (!org)
      return null
    const apiKey = await loadAgentKey(capgo, { userId, orgId: org.gid, appId: null, task: 'add-app' }, t('api-key'))
    return apiKey ? buildAiAddAppPrompt({ apiKey, organization: { id: org.gid, name: org.name } }) : null
  }
  const appId = props.appId
  if (!appId)
    return null
  const app = await appOwnerOrg(appId)
  if (!app)
    return null
  const orgId = app.owner_org
  const organization = { id: orgId, name: organizationStore.organizations.find(org => org.gid === orgId)?.name ?? orgId }
  const apiKey = await loadAgentKey(capgo, { userId, orgId, appId, task: props.task }, t('api-key'))
  if (!apiKey)
    return null
  const appInfo = { appId, name: app.name }
  if (props.task === 'upload-bundle')
    return buildAiUploadBundlePrompt({ apiKey, organization, app: appInfo })
  if (props.task === 'request-build')
    return buildAiRequestBuildPrompt({ apiKey, organization, app: appInfo, platform: props.platform ?? 'ios' })
  return buildAiCreateChannelPrompt({ apiKey, organization, app: appInfo, channelName: props.channelName })
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
    void rememberSetupMethod('ai')
    emit('copied')
  }
  finally {
    isCopying.value = false
  }
}
</script>

<template>
  <div v-if="canPrepareKey" class="space-y-4">
    <p v-if="orSeparator === 'before'" class="text-center text-xs font-medium uppercase tracking-wide text-slate-400">
      {{ t('ai-task-or') }}
    </p>
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
    <p v-if="orSeparator === 'after'" class="text-center text-xs font-medium uppercase tracking-wide text-slate-400">
      {{ t('ai-task-or') }}
    </p>
  </div>
</template>

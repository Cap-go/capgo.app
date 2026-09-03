<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import AppOnboardingCliSteps from '~/components/dashboard/AppOnboardingCliSteps.vue'
import OnboardingAltSetup from '~/components/dashboard/OnboardingAltSetup.vue'
import TechnicalTeammateInviteCard from '~/components/dashboard/TechnicalTeammateInviteCard.vue'
import { createDefaultApiKey, findUsablePlainApiKey } from '~/services/apikeys'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { getLocalConfig, isLocal, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { buildCapgoOtaCliInitCommand, capgoLocalCliArgs } from '~/utils/gettingStartedCli'
import { onboardingSecondaryButtonClass } from '~/utils/onboardingButtonClasses'

const props = defineProps<{
  appId: string
  appName?: string | null
  existingApp?: boolean | null
  initialOnboarding?: unknown
}>()

const emit = defineEmits<{
  progress: [{ isTerminal: boolean }]
}>()

const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()
const config = getLocalConfig()
const apiKey = ref<string | null>(null)
let apiKeyLoadingPromise: Promise<void> | null = null
const markedFeatures = new Set<string>()

const extraArgs = computed(() => capgoLocalCliArgs(config.supaHost, config.supaKey, isLocal(config.supaHost)))
const cliParts = computed(() => {
  if (!apiKey.value)
    return null
  return buildCapgoOtaCliInitCommand(apiKey.value, extraArgs.value)
})

function createAiHelpPrompt() {
  const command = cliParts.value?.command
  if (!command)
    return ''
  const resolvedAppName = props.appName?.trim() || props.appId
  const appStatus = props.existingApp
    ? t('app-onboarding-ai-help-status-existing')
    : t('app-onboarding-ai-help-status-new')
  return t('app-onboarding-ai-help-prompt', {
    appName: resolvedAppName,
    appId: props.appId,
    appStatus,
    apiKeyGuidance: t('app-onboarding-ai-help-with-key'),
    command,
  })
}

async function ensureApiKey() {
  const userId = main.user?.id ?? main.auth?.id
  if (!userId)
    return

  await organizationStore.awaitInitialLoad()
  // New apps are created after the last org fetch, so the app-id map can still
  // miss. currentOrganization is set during onboarding create.
  const orgId = organizationStore.getOrgByAppId(props.appId)?.gid
    ?? organizationStore.currentOrganization?.gid
  if (!orgId)
    return

  const existingKey = await findUsablePlainApiKey(supabase, userId, orgId, props.appId)
  if (existingKey) {
    apiKey.value = existingKey
    return
  }

  const { data: claimsData } = await supabase.auth.getClaims()
  const claimsUserId = claimsData?.claims?.sub ?? userId

  const { data, error: createError } = await createDefaultApiKey(supabase, 'api-key', {
    orgId,
    appId: props.appId,
  })
  if (createError)
    throw createError

  apiKey.value = typeof data?.key === 'string'
    ? data.key
    : await findUsablePlainApiKey(supabase, claimsUserId, orgId, props.appId)
}

function loadApiKey() {
  if (apiKey.value)
    return Promise.resolve()
  apiKeyLoadingPromise ??= ensureApiKey().finally(() => {
    apiKeyLoadingPromise = null
  })
  return apiKeyLoadingPromise
}

async function markOnboardingFeatureStarted() {
  const markKey = `${props.appId}:cli_install`
  if (markedFeatures.has(markKey))
    return

  for (let attempt = 0; attempt < 2; attempt++) {
    markedFeatures.add(markKey)
    const { data, error } = await supabase.rpc('mark_onboarding_feature_started', {
      p_app_id: props.appId,
      p_feature_key: 'cli_install',
    })
    if (!error) {
      organizationStore.updateAppOnboarding(props.appId, data)
      return
    }

    markedFeatures.delete(markKey)
    if (attempt === 0) {
      await new Promise(resolve => setTimeout(resolve, 400))
      continue
    }
    console.error('Failed to mark onboarding feature started', error)
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('copied-to-clipboard'))
    return true
  }
  catch (error) {
    console.error('Failed to copy text', error)
    dialogStore.openDialog({
      title: t('cannot-copy'),
      description: text,
      buttons: [
        {
          text: t('button-cancel'),
          role: 'cancel',
        },
      ],
    })
    await dialogStore.onDialogDismiss()
    return false
  }
}

async function copyCliCommand() {
  const command = cliParts.value?.command
  if (!command)
    return
  const copied = await copyText(command)
  if (copied) {
    sendOnboardingEvent('onboarding_cli_command_copied', {
      app_id: props.appId,
      setup_command: 'ota',
    })
  }
}

async function copyAiInstructions() {
  try {
    await loadApiKey()
  }
  catch (error) {
    console.error('Cannot ensure API key', error)
    toast.error(t('app-onboarding-toast-apikey-error'))
    return
  }

  if (!apiKey.value) {
    toast.error(t('app-onboarding-toast-apikey-error'))
    return
  }

  const copied = await copyText(createAiHelpPrompt())
  if (copied) {
    sendOnboardingEvent('onboarding_ai_instructions_copied', {
      app_id: props.appId,
      setup_command: 'ota',
    })
    const { error } = await supabase.rpc('report_app_onboarding_setup', {
      p_app_id: props.appId,
      p_patch: { source: 'ai' } as never,
    })
    if (error)
      console.error('Cannot report onboarding progress', error)
  }
}

function onCliStepsProgress(payload: { isTerminal: boolean }) {
  emit('progress', { isTerminal: payload.isTerminal })
}

watch(
  () => [
    main.user?.id ?? main.auth?.id,
    organizationStore.getOrgByAppId(props.appId)?.gid ?? organizationStore.currentOrganization?.gid,
  ] as const,
  ([userId, orgId]) => {
    if (!userId || !orgId || apiKey.value)
      return
    void loadApiKey().catch((error) => {
      console.error('Cannot ensure API key', error)
      toast.error(t('app-onboarding-toast-apikey-error'))
    })
  },
)

onMounted(() => {
  void markOnboardingFeatureStarted()
  void loadApiKey().catch((error) => {
    console.error('Cannot ensure API key', error)
    toast.error(t('app-onboarding-toast-apikey-error'))
  })
})
</script>

<template>
  <div class="mt-3 space-y-4" data-test="getting-started-cli-panel">
    <button
      v-if="cliParts"
      type="button"
      class="d-btn group relative h-auto min-h-0 w-full justify-start whitespace-normal rounded-2xl border-0 bg-slate-950 p-5 pr-14 text-left font-normal ring-1 ring-white/10 transition hover:bg-slate-950 hover:ring-white/20"
      data-test="getting-started-cli-command-copy"
      :aria-label="t('app-onboarding-command-copy')"
      @click="copyCliCommand"
    >
      <code class="block whitespace-pre-wrap break-all text-sm">
        <span class="text-slate-500">{{ cliParts.npx }}</span>
        <span class="text-sky-300"> {{ cliParts.pkg }}</span>
        <span class="font-bold text-violet-300">&nbsp;{{ cliParts.subcommand }}</span>
        <span class="text-emerald-300">&nbsp;{{ apiKey }}</span>
        <template v-for="(arg, index) in cliParts.extraArgs" :key="`${arg}-${index}`">
          <span :class="index % 2 === 0 ? 'text-amber-300' : 'text-cyan-300'"> {{ arg }}</span>
        </template>
      </code>
      <IconCopy class="absolute right-4 top-4 h-5 w-5 text-muted-blue-300 transition group-hover:text-white" />
    </button>
    <div
      v-else
      class="rounded-2xl bg-slate-950 p-5 pr-14 ring-1 ring-white/10"
      data-test="getting-started-cli-command-loading"
      role="status"
    >
      <div class="flex min-h-6 items-center gap-3 text-sm text-slate-300">
        <Spinner size="w-5 h-5" />
        <span>{{ t('app-onboarding-command-apikey-loading') }}</span>
      </div>
    </div>
    <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">
      {{ t('onboarding-manual-setup-prefix') }}
      <a
        href="https://capgo.app/docs/getting-started/add-an-app/#manual-setup"
        target="_blank"
        rel="noopener noreferrer"
        class="underline decoration-slate-300 underline-offset-2 transition hover:text-slate-700 dark:decoration-slate-600 dark:hover:text-slate-200"
      >{{ t('onboarding-manual-setup-link') }}</a>
    </p>

    <AppOnboardingCliSteps
      :key="appId"
      :app-id="appId"
      :initial-onboarding="initialOnboarding"
      @progress="onCliStepsProgress"
    />

    <OnboardingAltSetup :compressed="false">
      <div class="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-700 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200">
        <TechnicalTeammateInviteCard
          analytics-channel="onboarding-v3"
          :show-manual-setup-link="false"
          :tracking-version="3"
        />
      </div>

      <div class="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-700 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="max-w-2xl">
            <p class="font-medium text-slate-950 dark:text-white">
              {{ t('app-onboarding-ai-help-title') }}
            </p>
            <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
              {{ t('app-onboarding-ai-help-caption') }}
            </p>
          </div>
          <button
            type="button"
            class="d-btn min-h-11"
            :class="onboardingSecondaryButtonClass"
            data-test="getting-started-cli-copy-ai"
            @click="copyAiInstructions"
          >
            <IconCopy class="h-4 w-4" />
            {{ t('app-onboarding-ai-help-button') }}
          </button>
        </div>
      </div>
    </OnboardingAltSetup>
  </div>
</template>

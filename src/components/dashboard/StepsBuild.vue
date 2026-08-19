<script setup lang="ts">
import type { Component } from 'vue'
import { computed, onUnmounted, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconArrowLeft from '~icons/lucide/arrow-left'
import IconCheckCircle from '~icons/lucide/check-circle-2'
import IconClipboard from '~icons/lucide/clipboard'
import IconExternalLink from '~icons/lucide/external-link'
import IconLoader from '~icons/lucide/loader-2'
import IconPlay from '~icons/lucide/play'
import IconSettings from '~icons/lucide/settings-2'
import IconTerminal from '~icons/lucide/terminal-square'
import IconAndroid from '~icons/mdi/android'
import IconApple from '~icons/mdi/apple'
import { createDefaultApiKey, findUsablePlainApiKey } from '~/services/apikeys'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { getLocalConfig, isLocal, useSupabase } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

type Platform = 'ios' | 'android'

interface Step {
  key: string
  title: string
  command?: string
  subtitle: string
  icon: Component
}

interface PlatformBuildCounts {
  ios: number
  android: number
}

const props = withDefaults(defineProps<{
  onboarding: boolean
  appId: string
  platformBuildCounts?: PlatformBuildCounts
  canClose?: boolean
}>(), {
  canClose: true,
  platformBuildCounts: () => ({ ios: 0, android: 0 }),
})
const emit = defineEmits(['done', 'closeStep'])
const isLoading = ref(false)
const step = ref(0)
const clicked = ref(0)
const buildId = ref<string>()
const realtimeListener = ref(false)
const pollTimer = ref<number | null>(null)
const initialCount = ref<number | null>(null)
const selectedPlatform = ref<Platform>('ios')
const apiKey = ref('[APIKEY]')
const supabase = useSupabase()
const main = useMainStore()
const { t } = useI18n()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()
const config = getLocalConfig()
const initialOnboarding = props.onboarding
const localCommand = isLocal(config.supaHost) ? ` --supa-host ${config.supaHost} --supa-anon ${config.supaKey}` : ''

const platformBuildCounts = computed<PlatformBuildCounts>(() => ({
  ios: props.platformBuildCounts?.ios ?? 0,
  android: props.platformBuildCounts?.android ?? 0,
}))

const selectedPlatformLabel = computed(() => selectedPlatform.value === 'ios' ? t('build-platform-ios') : t('build-platform-android'))
const selectedPlatformDocsUrl = computed(() => `https://capgo.app/docs/cli/cloud-build/${selectedPlatform.value}/`)
const selectedPlatformHasBuilds = computed(() => platformBuildCounts.value[selectedPlatform.value] > 0)

const platformOptions = computed(() => [
  {
    value: 'ios' as const,
    label: t('build-platform-ios'),
    icon: IconApple,
    count: platformBuildCounts.value.ios,
  },
  {
    value: 'android' as const,
    label: t('build-platform-android'),
    icon: IconAndroid,
    count: platformBuildCounts.value.android,
  },
])

const setupStep = computed<Step>(() => {
  if (selectedPlatform.value === 'ios') {
    return {
      key: 'setup-ios',
      title: t('build-step-ios-setup-title'),
      command: `npx @capgo/cli@latest build init -a ${apiKey.value} --platform ios`,
      subtitle: t('build-step-ios-setup-subtitle'),
      icon: IconSettings,
    }
  }

  return {
    key: 'setup-android',
    title: t('build-step-android-setup-title'),
    command: `npx @capgo/cli@latest build init -a ${apiKey.value} --platform android`,
    subtitle: t('build-step-android-setup-subtitle'),
    icon: IconSettings,
  }
})

const requestStep = computed<Step>(() => ({
  key: 'request-build',
  title: t('build-step-request-build'),
  command: `npx @capgo/cli@latest build request ${props.appId} -a ${apiKey.value} --platform ${selectedPlatform.value}${localCommand}`,
  subtitle: t('build-step-request-subtitle-platform', { platform: selectedPlatformLabel.value }),
  icon: IconTerminal,
}))

const waitStep = computed<Step>(() => ({
  key: 'wait-for-build',
  title: t('build-step-wait'),
  command: '',
  subtitle: t('build-step-wait-subtitle'),
  icon: IconPlay,
}))

const steps = computed<Step[]>(() => {
  if (selectedPlatformHasBuilds.value)
    return [requestStep.value, waitStep.value]
  return [setupStep.value, requestStep.value, waitStep.value]
})

const waitStepIndex = computed(() => steps.value.length - 1)
const completedStepIndex = computed(() => steps.value.length)

function stepToName(stepNumber: number): string {
  if (stepNumber === completedStepIndex.value)
    return 'build-completed'
  return steps.value[stepNumber]?.key ?? 'unknown-step'
}

function setLog() {
  if (initialOnboarding && main.user?.id) {
    const orgId = organizationStore.currentOrganization?.gid
    if (orgId) {
      sendEvent({
        channel: 'onboarding-build',
        event: `onboarding-build-step-${stepToName(step.value)}`,
        icon: 'build',
        org_id: orgId,
        tracking_version: 2,
        notify: false,
      }).catch()
      void sendOnboardingEvent(`user:onboarding-build-${stepToName(step.value)}`, { org_id: orgId })
    }
  }
  if (step.value === completedStepIndex.value) {
    emit('done')
  }
}

function clearWatchers() {
  if (pollTimer.value !== null) {
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }
}

function resetFlow() {
  clicked.value = 0
  step.value = 0
  realtimeListener.value = false
  initialCount.value = null
  buildId.value = undefined
  clearWatchers()
}

function selectPlatform(platform: Platform) {
  if (selectedPlatform.value === platform)
    return
  selectedPlatform.value = platform
}

function scrollToElement(id: string) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

async function copyToast(allowed: boolean, id: string, text?: string) {
  if (!allowed || !text)
    return
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
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
  }
  clicked.value += 1
  if (!realtimeListener.value || clicked.value === 3) {
    step.value += 1
    clicked.value = 0
    realtimeListener.value = false
    clearWatchers()
    scrollToElement(id)
    setLog()
  }
}

async function addNewApiKey() {
  const { data: claimsData } = await supabase.auth.getClaims()
  const userId = claimsData?.claims?.sub

  if (!userId) {
    console.log('Not logged in, cannot regenerate API key')
    return null
  }
  const { data, error } = await createDefaultApiKey(supabase, t('api-key'), {
    orgId: organizationStore.currentOrganization?.gid,
    appId: props.appId,
  })

  if (error)
    throw error

  return typeof data?.key === 'string' ? data.key : null
}

async function getKey(retry = true): Promise<void> {
  isLoading.value = true
  if (!main?.user?.id)
    return

  const existingKey = await findUsablePlainApiKey(supabase, main.user.id, organizationStore.currentOrganization?.gid, props.appId)
  if (existingKey) {
    apiKey.value = existingKey
  }
  else if (retry) {
    apiKey.value = await addNewApiKey() ?? '[APIKEY]'
  }

  isLoading.value = false
}

async function getBuildRequestsCount(platform: Platform): Promise<number> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !props.appId)
    return 0
  const { count, error } = await supabase
    .from('build_requests')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)
    .eq('app_id', props.appId)
    .eq('platform', platform)

  if (error)
    return 0
  return count ?? 0
}

async function getLatestBuildId(platform: Platform): Promise<string | undefined> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !props.appId)
    return undefined
  const { data, error } = await supabase
    .from('build_requests')
    .select('id, created_at')
    .eq('owner_org', orgId)
    .eq('app_id', props.appId)
    .eq('platform', platform)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0)
    return undefined
  return `${data[0].id}`
}

watch(selectedPlatform, resetFlow)
watch(() => props.appId, resetFlow)

watchEffect(async () => {
  if (step.value === waitStepIndex.value && !realtimeListener.value) {
    const platform = selectedPlatform.value
    realtimeListener.value = true
    await organizationStore.awaitInitialLoad()

    try {
      initialCount.value = await getBuildRequestsCount(platform)
    }
    catch {
      initialCount.value = 0
    }

    clearWatchers()

    pollTimer.value = window.setInterval(async () => {
      try {
        const current = await getBuildRequestsCount(platform)
        if (initialCount.value !== null && current > initialCount.value) {
          const latestId = await getLatestBuildId(platform)
          step.value += 1
          buildId.value = latestId ?? ''
          realtimeListener.value = false
          clearWatchers()
          setLog()
        }
      }
      catch (e) {
        console.warn('Polling build_requests failed', e)
      }
    }, 2000)
  }
})

watchEffect(async () => {
  await getKey()
})

onUnmounted(() => {
  clearWatchers()
})
</script>

<template>
  <section class="overflow-y-auto py-4 sm:py-6">
    <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 sm:px-6 lg:px-8">
      <header class="flex flex-col gap-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="flex min-w-0 gap-3">
            <button
              v-if="canClose"
              type="button"
              class="d-btn d-btn-ghost d-btn-square shrink-0 text-slate-600 dark:text-slate-200"
              :aria-label="t('button-back')"
              @click="emit('closeStep')"
            >
              <IconArrowLeft class="h-5 w-5" />
            </button>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-3">
                <h2 class="text-2xl font-semibold text-slate-950 dark:text-white sm:text-3xl">
                  {{ t('build-setup-command-title') }}
                </h2>
              </div>
              <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300 sm:text-base">
                {{ t('build-setup-command-subtitle') }}
              </p>
            </div>
          </div>

          <a
            class="d-btn d-btn-outline min-h-11 shrink-0 gap-2 border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-100"
            :href="selectedPlatformDocsUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t('build-docs-link', { platform: selectedPlatformLabel }) }}
            <IconExternalLink class="h-4 w-4" />
          </a>
        </div>

        <div class="grid gap-3 rounded-lg bg-slate-100 p-1 dark:bg-slate-800 sm:grid-cols-2">
          <button
            v-for="option in platformOptions"
            :key="option.value"
            type="button"
            class="flex min-h-12 items-center justify-between rounded-md px-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azure-500"
            :class="selectedPlatform === option.value ? 'bg-white text-slate-950 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-600 hover:bg-white/70 dark:text-slate-300 dark:hover:bg-slate-700/70'"
            @click="selectPlatform(option.value)"
          >
            <span class="flex items-center gap-3 font-medium">
              <component :is="option.icon" class="h-5 w-5" />
              {{ option.label }}
            </span>
            <span class="text-xs font-medium" :class="option.count > 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'">
              {{ option.count > 0 ? t('build-platform-ready') : t('build-platform-needs-setup') }}
            </span>
          </button>
        </div>
      </header>

      <div class="flex flex-col gap-3">
        <article
          v-for="(s, i) in steps"
          :id="`build_step_${i}`"
          :key="s.key"
          class="rounded-lg border bg-white p-5 shadow-sm transition-opacity dark:bg-slate-900 sm:p-6"
          :class="step === i ? 'border-azure-500 dark:border-azure-500' : 'border-slate-200 opacity-60 dark:border-slate-800'"
        >
          <div class="flex gap-4">
            <div
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white"
              :class="step === i ? 'bg-azure-500' : 'bg-slate-500 dark:bg-slate-700'"
            >
              <IconLoader v-if="step === waitStepIndex && i === waitStepIndex" class="h-5 w-5 animate-spin" />
              <IconCheckCircle v-else-if="step > i" class="h-5 w-5" />
              <component :is="s.icon" v-else class="h-5 w-5" />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 class="text-base font-semibold text-slate-950 dark:text-white sm:text-lg">
                    {{ s.title }}
                  </h3>
                  <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    {{ s.subtitle }}
                  </p>
                </div>
                <span class="text-sm font-medium text-slate-500 dark:text-slate-400">
                  {{ i + 1 }} / {{ steps.length }}
                </span>
              </div>

              <button
                v-if="s.command"
                type="button"
                class="mt-4 flex w-full items-start gap-3 rounded-lg bg-slate-950 p-4 text-left text-sm text-orange-300 transition-colors hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-950 dark:hover:bg-slate-900 sm:text-base"
                :disabled="step !== i"
                :aria-label="t('copy-command')"
                @click="copyToast(step === i, `build_step_${i}`, s.command)"
              >
                <code class="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono leading-6">
                  {{ s.command }}
                </code>
                <IconClipboard class="mt-0.5 h-5 w-5 shrink-0 text-slate-300" />
              </button>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>

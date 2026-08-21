<script setup lang="ts">
import { computed, onUnmounted, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import arrowBack from '~icons/ion/arrow-back?width=2em&height=2em'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconLoader from '~icons/lucide/loader-2'
import TechnicalTeammateInviteCard from '~/components/dashboard/TechnicalTeammateInviteCard.vue'
import { createDefaultApiKey, findUsablePlainApiKey } from '~/services/apikeys'
import { invokeCapgoApi } from '~/services/capgoApi'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { getLocalConfig, isLocal, useSupabase } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  onboarding: boolean
}>()
const emit = defineEmits(['done', 'closeStep'])
const displayStore = useDisplayStore()
const isLoading = ref(false)
const isDemoLoading = ref(false)
const step = ref(0)
const clicked = ref(0)
const appId = ref<string>()
const realtimeListener = ref(false)
const pollTimer = ref<number | null>(null)
const initialCount = ref<number | null>(null)
const supabase = useSupabase()
const main = useMainStore()
const { t } = useI18n()
const organizationStore = useOrganizationStore()
const dialogStore = useDialogV2Store()

interface Step {
  title: string
  command?: string
  subtitle: string
}

const config = getLocalConfig()

const localCommand = isLocal(config.supaHost) ? ` --supa-host ${config.supaHost} --supa-anon ${config.supaKey}` : ``
const apiKey = ref<string | null>(null)
// keep NPX for better support of our customers env, everyone has npx but not everyone has bunx, and bunx has some issues with pnpm
const commandTemplate = `npx @capgo/cli@latest i [APIKEY]${localCommand}`
const stepCommand = computed(() => commandTemplate.replace('[APIKEY]', apiKey.value ?? '[APIKEY]'))
const steps = computed<Step[]>(() => [
  {
    title: t('init-capgo-in-your-a'),
    command: stepCommand.value,
    subtitle: t('onboarding-cli-where-why'),
  },
  {
    title: t('discover-your-dashbo'),
    command: '',
    subtitle: t('this-page-will-self-'),
  },
])
const prerequisitesOpen = ref(true)
const isWaiting = computed(() => props.onboarding && step.value === 1)
const shouldDimStep = (index: number) => step.value !== index && !(isWaiting.value && index === 0)

function togglePrerequisites() {
  prerequisitesOpen.value = !prerequisitesOpen.value
}

function stepToName(stepNumber: number): string {
  switch (stepNumber) {
    case 0:
      return 'copy-command'
    case 1:
      return 'wait-for-app'
    case 2:
      return 'discover-your-dashboard'
    default:
      return 'unknown-step'
  }
}

function setLog() {
  if (props.onboarding && main.user?.id) {
    const orgId = organizationStore.currentOrganization?.gid
    if (orgId) {
      sendEvent({
        channel: 'onboarding-v2',
        event: `onboarding-step-${stepToName(step.value)}`,
        org_id: orgId,
        tracking_version: 2,
      }).catch()
      sendOnboardingEvent(`user:onboarding-step-${stepToName(step.value)}`, { org_id: orgId })
    }
  }
  if (step.value === 2) {
    console.log('Finished onboarding for app ID:', appId.value)
    emit('done', appId.value)
  }
}

function scrollToElement(id: string) {
  // Get the element with the id
  const el = document.getElementById(id)
  console.log('el', el)
  if (el) {
    // Use el.scrollIntoView() to instantly scroll to the element
    el.scrollIntoView({ behavior: 'smooth' })
  }
}

function goToNextStep(scrollTargetId?: string) {
  step.value += 1
  clicked.value = 0
  realtimeListener.value = false
  clearWatchers()
  if (scrollTargetId)
    scrollToElement(scrollTargetId)
  setLog()
}

function onTechnicalInviteOpened() {
  const orgId = organizationStore.currentOrganization?.gid
  if (orgId) {
    sendEvent({
      channel: 'onboarding-v2',
      event: `onboarding-alternative-send-invite`,
      org_id: orgId,
      tracking_version: 2,
    }).catch()
    sendOnboardingEvent(`user:onboarding-alternative-send-invite`, { org_id: orgId })
  }
}

function onInviteSuccess() {
  goToNextStep('step_card_1')
}

async function createDemoApp() {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId) {
    toast.error(t('onboarding-demo-error-no-org'))
    return
  }
  const demoAppId = appId.value ?? await getLatestAppId()
  if (!demoAppId) {
    toast.error(t('onboarding-demo-error-create'))
    return
  }

  isDemoLoading.value = true
  try {
    sendEvent({
      channel: 'onboarding-v2',
      event: 'onboarding-create-demo-app',
      org_id: orgId,
      tracking_version: 2,
    }).catch()
    sendOnboardingEvent('user:onboarding-create-demo-app', { org_id: orgId })

    const { data, error } = await invokeCapgoApi('app/demo', {
      method: 'POST',
      body: {
        owner_org: orgId,
        app_id: demoAppId,
      },
    })

    if (error || !data?.app_id) {
      console.error('Error creating demo app:', error)
      toast.error(t('onboarding-demo-error-create'))
      return
    }

    appId.value = data.app_id
    toast.success(t('onboarding-demo-success'))

    // Skip directly to discover dashboard step
    step.value = 2
    setLog()
  }
  catch (err) {
    console.error('Error creating demo app:', err)
    toast.error(t('onboarding-demo-error-create'))
  }
  finally {
    isDemoLoading.value = false
  }
}

function clearWatchers() {
  if (pollTimer.value !== null) {
    console.log('clear poll timer', pollTimer.value)
    clearInterval(pollTimer.value)
    pollTimer.value = null
  }
}
async function copyToast(allowed: boolean, _id: string, text?: string) {
  if (!allowed || !text)
    return
  try {
    await navigator.clipboard.writeText(text)
    console.log('displayStore.messageToast', displayStore.messageToast)
    toast.success(t('copied-to-clipboard'))
  }
  catch (err) {
    console.error('Failed to copy: ', err)
    // Display a modal with the copied key
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
    goToNextStep()
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
    appId: appId.value,
  })

  if (error)
    throw error

  return typeof data?.key === 'string' ? data.key : null
}

async function getKey(retry = true): Promise<void> {
  isLoading.value = true
  if (!main?.user?.id)
    return

  const existingKey = await findUsablePlainApiKey(supabase, main.user.id, organizationStore.currentOrganization?.gid, appId.value)
  if (existingKey) {
    apiKey.value = existingKey
  }
  else if (retry) {
    apiKey.value = await addNewApiKey()
  }

  isLoading.value = false
}

async function getAppsCount(): Promise<number> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return 0
  const { count, error } = await supabase
    .from('apps')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)

  if (error)
    return 0
  return count ?? 0
}

async function getLatestAppId(): Promise<string | undefined> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return undefined
  const { data, error } = await supabase
    .from('apps')
    .select('app_id, created_at')
    .eq('owner_org', orgId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0)
    return undefined
  console.log('data', data)
  console.log('latest app id', data[0].app_id)
  return data[0].app_id as string
}

watchEffect(async () => {
  if (step.value === 1 && !realtimeListener.value) {
    console.log('watch app change step 1 via polling')
    realtimeListener.value = true
    await organizationStore.awaitInitialLoad()
    // establish baseline
    try {
      initialCount.value = await getAppsCount()
    }
    catch {
      initialCount.value = 0
    }

    clearWatchers()

    pollTimer.value = window.setInterval(async () => {
      try {
        const current = await getAppsCount()
        if (initialCount.value !== null && current > initialCount.value) {
          const latestId = await getLatestAppId()
          appId.value = latestId ?? ''
          goToNextStep()
        }
      }
      catch (e) {
        console.warn('Polling apps failed', e)
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
  <section class="h-full py-12 overflow-y-auto sm:py-16 lg:py-20 max-h-fit">
    <div class="px-4 mx-auto max-w-7xl sm:px-6 lg:px-8">
      <div class="flex items-center justify-items-center place-content-center">
        <button type="button" v-if="!onboarding" class="mr-6 text-white bg-gray-800 d-btn d-btn-outline" @click="emit('closeStep')">
          <arrowBack />
        </button>
        <div v-if="props.onboarding" class="text-center">
          <h2 class="text-3xl font-bold text-gray-900 sm:text-4xl xl:text-5xl dark:text-gray-50 font-pj">
            {{ t('start-using-capgo') }} <span class="font-prompt">Capgo</span> !
          </h2>
          <p class="mx-auto mt-6 text-lg font-normal text-gray-600 dark:text-gray-200 font-pj">
            {{ t('add-your-first-app-t') }}
          </p>
          <p class="mx-auto mt-2 font-normal text-md font-pj text-muted-blue-300 dark:text-muted-blue-50">
            {{ t('pro-tip-you-can-copy') }} <span class="text-pumpkin-orange-900">{{ t('commands') }}</span> {{ t('by-clicking-on-them') }}
          </p>
        </div>

        <div v-else class="text-center">
          <h2 class="text-3xl font-bold text-gray-900 sm:text-4xl xl:text-5xl dark:text-gray-50 font-pj">
            {{ t('add-another-app') }}
          </h2>
        </div>
      </div>

      <!-- Prerequisites Accordion -->
      <div v-if="props.onboarding && step === 0" class="max-w-6xl mx-auto mt-8 sm:px-10">
        <div class="overflow-hidden bg-white border border-gray-200 rounded-xl">
          <button
            type="button"
            class="flex items-center justify-between w-full px-5 py-4 text-left transition-colors hover:bg-gray-50"
            @click="togglePrerequisites"
          >
            <div class="flex items-center gap-3">
              <span class="text-lg font-semibold text-gray-900 font-pj">{{ t('onboarding-prerequisites-title') }}</span>
              <span class="text-sm text-gray-500">{{ t('onboarding-prerequisites-hint') }}</span>
            </div>
            <IconChevronDown
              class="w-5 h-5 text-gray-500 transition-transform duration-200"
              :class="{ 'rotate-180': prerequisitesOpen }"
            />
          </button>
          <div
            v-show="prerequisitesOpen"
            class="px-5 pb-5 border-t border-gray-100"
          >
            <p class="mt-4 text-sm text-gray-600">
              {{ t('onboarding-prerequisites-cli-desc') }}
            </p>
            <ul class="mt-4 space-y-3">
              <li class="flex items-start gap-3">
                <IconCheck class="w-5 h-5 mt-0.5 text-green-500 shrink-0" />
                <span class="text-sm text-gray-700">{{ t('onboarding-prerequisites-runtime') }}</span>
              </li>
              <li class="flex items-start gap-3">
                <IconCheck class="w-5 h-5 mt-0.5 text-green-500 shrink-0" />
                <span class="text-sm text-gray-700">{{ t('onboarding-prerequisites-capacitor') }}</span>
              </li>
              <li class="flex items-start gap-3">
                <IconCheck class="w-5 h-5 mt-0.5 text-green-500 shrink-0" />
                <span class="text-sm text-gray-700">{{ t('onboarding-prerequisites-built') }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="max-w-6xl mx-auto sm:px-10" :class="[props.onboarding && step === 0 ? 'mt-6' : 'mt-12']">
        <template v-for="(s, i) in steps" :key="i">
          <div
            v-if="i > 0"
            class="w-1 h-10 mx-auto bg-gray-200"
            :class="[shouldDimStep(i) ? 'opacity-30' : '']"
          />

          <div
            :id="`step_card_${i}`"
            :class="[shouldDimStep(i) ? 'opacity-30' : '']"
            class="relative p-5 overflow-hidden bg-white border border-gray-200 rounded-2xl"
          >
            <div class="flex items-start gap-6">
              <div class="inline-flex items-center justify-center text-xl font-bold text-white w-14 h-14 rounded-xl shrink-0 font-pj bg-muted-blue-800">
                <template v-if="i + 1 !== steps.length">
                  {{ i + 1 }}
                </template>
                <template v-else-if="step === 1 && i === 1">
                  <div class="flex justify-center">
                    <IconLoader class="w-10 h-10 text-blue-500 animate-spin" />
                  </div>
                </template>
                <template v-else>
                  🚀
                </template>
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-xl font-medium text-gray-900 font-pj">
                  {{ s.title }}<br>
                  <span class="text-sm">{{ s.subtitle }}</span>
                </div>
                <div v-if="s.command" class="relative p-5 pr-16 mt-4 bg-black rounded-lg cursor-pointer group" @click="copyToast(step === i, `step_command_${i}`, s.command)">
                  <code :id="`step_command_${i}`" class="block text-xl break-all whitespace-pre-wrap text-pumpkin-orange-700">
                    {{ s.command }}
                  </code>
                  <i-ion-copy-outline class="absolute w-6 h-6 top-5 right-5 text-muted-blue-300" />
                </div>
                <p v-if="s.command" class="mt-3 text-sm font-medium text-gray-700">
                  {{ t('onboarding-cli-guide-prefix') }}
                  <a
                    href="https://capgo.app/docs/getting-started/onboarding/"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-muted-blue-700 underline hover:text-muted-blue-900"
                  >{{ t('onboarding-cli-guide-link') }}</a>
                </p>
                <br v-if="s.command">
              </div>
            </div>
            <div v-if="i === 0 && props.onboarding" class="pt-6 border-t border-gray-200">
              <div class="pb-6 mb-6 border-b border-gray-200">
                <TechnicalTeammateInviteCard
                  @opened="onTechnicalInviteOpened"
                  @success="onInviteSuccess"
                />
              </div>

              <!-- Demo App Option (last option) -->
              <h3 class="text-lg font-semibold text-gray-900 font-pj">
                {{ t('onboarding-demo-option-title') }}
              </h3>
              <p class="mt-2 text-sm text-gray-600">
                {{ t('onboarding-demo-option-subtitle') }}
              </p>
              <button
                type="button"
                :disabled="isDemoLoading"
                class="inline-flex items-center px-4 py-2 mt-4 text-sm font-semibold transition-colors duration-200 rounded-md cursor-pointer focus:ring-2 focus:ring-offset-2 bg-muted-blue-50 text-muted-blue-800 hover:bg-muted-blue-100 focus:outline-hidden focus:ring-muted-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                @click="createDemoApp"
              >
                <IconLoader v-if="isDemoLoading" class="w-4 h-4 mr-2 animate-spin" />
                {{ isDemoLoading ? t('onboarding-demo-loading') : t('onboarding-demo-option-cta') }}
              </button>
            </div>
            <div v-else-if="i === 0" class="pt-6 border-t border-gray-200">
              <TechnicalTeammateInviteCard
                @opened="onTechnicalInviteOpened"
                @success="onInviteSuccess"
              />
            </div>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

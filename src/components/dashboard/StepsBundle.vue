<script setup lang="ts">
import { onUnmounted, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import arrowBack from '~icons/ion/arrow-back?width=2em&height=2em'
import IconLoader from '~icons/lucide/loader-2'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'
import { createDefaultApiKey, findUsablePlainApiKey } from '~/services/apikeys'
import { pushEvent } from '~/services/posthog'
import { getLocalConfig, isLocal, useSupabase } from '~/services/supabase'
import { sendEvent } from '~/services/tracking'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'

const props = defineProps<{
  onboarding: boolean
  appId: string
}>()
const emit = defineEmits(['done', 'closeStep'])
const displayStore = useDisplayStore()
const isLoading = ref(false)
const step = ref(0)
const clicked = ref(0)
const latestBundleId = ref<string>()
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
const steps = ref<Step[]>([
  {
    title: t('add-another-bundle'),
    command: `bunx @capgo/cli@latest bundle upload -a [APIKEY]${localCommand}`,
    subtitle: t('onboarding-bundle-cli-why'),
  },
  {
    title: t('discover-your-bundle'),
    command: '',
    subtitle: t('this-page-will-self-'),
  },
])
const inviteModalRef = ref<InstanceType<typeof InviteTeammateModal> | null>(null)

function stepToName(stepNumber: number): string {
  switch (stepNumber) {
    case 0:
      return 'copy-command'
    case 1:
      return 'wait-for-bundle'
    case 2:
      return 'discover-your-bundle'
    default:
      return 'unknown-step'
  }
}

function setLog() {
  console.log('setLog', props.onboarding, main.user?.id, step.value)
  if (props.onboarding && main.user?.id) {
    const orgId = organizationStore.currentOrganization?.gid
    if (orgId) {
      sendEvent({
        channel: 'onboarding-bundle',
        event: `onboarding-bundle-step-${stepToName(step.value)}`,
        icon: '👶',
        org_id: orgId,
        tracking_version: 2,
        notify: false,
      }).catch()
      pushEvent(`user:onboarding-bundle-${stepToName(step.value)}`, config.supaHost, { org_id: orgId })
    }
  }
  if (step.value === 2) {
    emit('done')
  }
}

function clearWatchers() {
  if (pollTimer.value !== null) {
    console.log('clear poll timer', pollTimer.value)
    clearInterval(pollTimer.value)
    pollTimer.value = null
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

async function copyToast(allowed: boolean, id: string, text?: string) {
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
    steps.value[0].command = steps.value[0].command?.replace('[APIKEY]', existingKey)
  }
  else if (retry) {
    const createdKey = await addNewApiKey()
    if (createdKey)
      steps.value[0].command = steps.value[0].command?.replace('[APIKEY]', createdKey)
    else
      return getKey(false)
  }

  isLoading.value = false
}

async function getVersionsCount(): Promise<number> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !props.appId)
    return 0
  const { count, error } = await supabase
    .from('app_versions')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)
    .eq('app_id', props.appId)
    .eq('deleted', false)

  if (error)
    return 0
  return count ?? 0
}

async function getLatestVersionId(): Promise<string | undefined> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !props.appId)
    return undefined
  const { data, error } = await supabase
    .from('app_versions')
    .select('id, created_at')
    .eq('owner_org', orgId)
    .eq('app_id', props.appId)
    .eq('deleted', false)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0)
    return undefined
  return `${data[0].id}`
}

function openInviteDialog() {
  inviteModalRef.value?.openDialog()
}

function onInviteSuccess() {
  step.value += 1
  clicked.value = 0
  realtimeListener.value = false
  clearWatchers()
  scrollToElement('step_card_1')
  setLog()
}

watchEffect(async () => {
  if (step.value === 1 && !realtimeListener.value) {
    console.log('watch app change step 1 via polling')
    realtimeListener.value = true
    await organizationStore.awaitInitialLoad()

    try {
      initialCount.value = await getVersionsCount()
    }
    catch {
      initialCount.value = 0
    }

    clearWatchers()

    pollTimer.value = window.setInterval(async () => {
      try {
        const current = await getVersionsCount()
        if (initialCount.value !== null && current > initialCount.value) {
          const latestId = await getLatestVersionId()
          step.value += 1
          latestBundleId.value = latestId ?? ''
        }
      }
      catch (e) {
        console.warn('Polling app_versions failed', e)
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
  <section class="overflow-y-auto py-12 h-full sm:py-16 lg:py-20 max-h-fit bg-slate-100 dark:bg-slate-900">
    <div class="px-4 mx-auto max-w-7xl sm:px-6 lg:px-8">
      <div class="flex justify-items-center items-center place-content-center">
        <button v-if="!onboarding" class="mr-6 text-white bg-gray-800 d-btn d-btn-outline" @click="emit('closeStep')">
          <arrowBack />
        </button>
        <div v-if="props.onboarding" class="text-center">
          <h2 class="text-3xl font-bold text-gray-900 sm:text-4xl xl:text-5xl dark:text-gray-50 font-pj">
            {{ t('feel-magic-of-capgo') }} <span class="font-prompt">Capgo</span> !
          </h2>
          <p class="mx-auto mt-6 text-lg font-normal text-gray-600 dark:text-gray-200 font-pj">
            {{ t('add-your-first-bundle') }}
          </p>
          <p class="mx-auto mt-2 font-normal text-md font-pj text-muted-blue-300 dark:text-muted-blue-50">
            {{ t('pro-tip-you-can-copy') }} <span class="text-pumpkin-orange-900">{{ t('commands') }}</span> {{ t('by-clicking-on-them') }}
          </p>
        </div>

        <div v-else class="text-center">
          <h2 class="text-3xl font-bold text-gray-900 sm:text-4xl xl:text-5xl dark:text-gray-50 font-pj">
            {{ t('add-another-bundle') }}
          </h2>
        </div>
      </div>
      <div class="mx-auto mt-12 max-w-6xl sm:px-10">
        <template v-for="(s, i) in steps" :key="i">
          <div v-if="i > 0" class="mx-auto w-1 h-10 bg-gray-200" :class="[step !== i ? 'opacity-30' : '']" />

          <div :class="[step !== i ? 'opacity-30' : '']" class="overflow-hidden relative p-5 bg-white rounded-2xl dark:border dark:border-gray-200">
            <div class="flex gap-6 items-start">
              <div class="inline-flex justify-center items-center w-14 h-14 text-xl font-bold text-white rounded-xl shrink-0 font-pj bg-muted-blue-800">
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
                  <code :id="`step_command_${i}`" class="block text-xl whitespace-pre-wrap break-all text-pumpkin-orange-700">
                    {{ s.command }}
                  </code>
                  <i-ion-copy-outline class="absolute top-5 right-5 w-6 h-6 text-muted-blue-300" />
                </div>
                <br v-if="s.command">
              </div>
            </div>
            <div v-if="i === 0" class="pt-6 border-t border-gray-200">
              <h3 class="text-lg font-semibold text-gray-900 font-pj">
                {{ t('onboarding-invite-option-title') }}
              </h3>
              <p class="mt-2 text-sm text-gray-600">
                {{ t('onboarding-invite-option-subtitle') }}
              </p>
              <button
                type="button"
                class="inline-flex items-center py-2 px-4 mt-4 text-sm font-semibold rounded-md transition-colors duration-200 focus:ring-2 focus:ring-offset-2 bg-muted-blue-50 text-muted-blue-800 hover:bg-muted-blue-100 focus:outline-hidden focus:ring-muted-blue-500"
                @click="openInviteDialog"
              >
                {{ t('onboarding-invite-option-cta') }}
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </section>
  <InviteTeammateModal ref="inviteModalRef" invite-kind="technical" @success="onInviteSuccess" />
</template>

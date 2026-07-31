<script setup lang="ts">
import type { Database } from '~/types/supabase.types'
import { FormKit } from '@formkit/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import IconAppWindow from '~icons/lucide/app-window'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconCode from '~icons/lucide/code-2'
import IconCompass from '~icons/lucide/compass'
import IconGlobe from '~icons/lucide/globe-2'
import IconLayers from '~icons/lucide/layers'
import IconLoader from '~icons/lucide/loader-2'
import IconPackage from '~icons/lucide/package'
import IconPencil from '~icons/lucide/pencil-line'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconSmartphone from '~icons/lucide/smartphone'
import IconSparkles from '~icons/lucide/sparkles'
import IconStore from '~icons/lucide/store'
import IconTerminal from '~icons/lucide/terminal'
import IconUsers from '~icons/lucide/users-round'
import { createDefaultApiKey, findUsablePlainApiKey } from '~/services/apikeys'
import { pushEvent } from '~/services/posthog'
import { createSignedImageUrl, getImmediateImageUrl } from '~/services/storage'
import { getLocalConfig, isLocal, useSupabase } from '~/services/supabase'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { isValidAppId } from '~/utils/appId'
import {
  buildAlternativeAppIds,
  createOnboardingAppWithFallbackIds,
} from '~/utils/onboardingAppCreateHelpers'
import {
  clearOnboardingAppDraft,
  loadOnboardingAppDraft,
} from '~/utils/onboardingAppDraft'
import { slugifyOnboardingSegment } from '~/utils/onboardingSlug'

const props = defineProps<{
  onboarding: boolean
  preOrg?: boolean
}>()

const route = useRoute('/app/new')
const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()
const dialogStore = useDialogV2Store()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const onboardingUserId = computed(() => main.user?.id ?? main.auth?.id ?? null)
const config = getLocalConfig()

type AppRow = Database['public']['Tables']['apps']['Row']
type StandardFlowStep = 'details' | 'choice' | 'install' | 'setup'
type PreOrgFlowStep = 'intent' | 'details' | 'organization' | 'setup'
type OrgOnboardingMode = 'app-name' | 'name' | null

interface UserCountStop {
  value: number
  label: string
  planName: string
}

const isLoading = ref(true)
const isSubmitting = ref(false)
const isImportingStore = ref(false)
const isResumeIconLoading = ref(false)
const isSeedingDemo = ref(false)
const isCliCommandVisible = ref(false)
const apiKey = ref<string | null>(null)
const createdApp = ref<AppRow | null>(null)
const flowStep = ref<StandardFlowStep | PreOrgFlowStep>('details')
const selectedIconFile = ref<File | null>(null)
const localIconPreview = ref('')
const storeIconPreview = ref('')
const storeScreenshotPreview = ref('')
const existingApp = ref<boolean | null>(null)
const existingAppSetup = ref<'import' | 'manual' | null>(null)
const appName = ref('')
const storeUrl = ref('')
const importedStoreAppId = ref('')
const manualAppId = ref('')
const appIdSuggestions = ref<string[]>([])
const appIdFeedback = ref('')
const hasEditedAppId = ref(false)
const selectedIntent = ref<string | null>(null)
const orgMode = ref<OrgOnboardingMode>(null)
const orgNameInput = ref('')
const estimatedUsersIndex = ref<number | null>(null)

const intentOptions = [
  { value: 'ota', icon: IconRefresh },
  { value: 'builder', icon: IconSmartphone },
  { value: 'both', icon: IconLayers },
  { value: 'exploring', icon: IconCompass },
] as const

const fallbackUserCountStops: UserCountStop[] = [
  { value: 2000, label: '2K', planName: 'Solo' },
  { value: 10000, label: '10K', planName: 'Maker' },
  { value: 100000, label: '100K', planName: 'Team' },
  { value: 1000000, label: '1M+', planName: 'Enterprise' },
]
const planNameOrder = ['Solo', 'Maker', 'Team', 'Enterprise'] as const

const localCommand = isLocal(config.supaHost) ? ` --supa-host ${config.supaHost} --supa-anon ${config.supaKey}` : ''
const usesBuilderSetupCommand = computed(() => selectedIntent.value === 'builder')
const cliSubcommand = computed(() => usesBuilderSetupCommand.value ? 'build init' : 'i')
const cliCommand = computed(() => {
  const key = apiKey.value ?? '[APIKEY]'
  if (usesBuilderSetupCommand.value)
    return `npx @capgo/cli@latest build init -a ${key}${localCommand}`

  return `npx @capgo/cli@latest i ${key}${localCommand}`
})
const redactedCliCommand = computed(() => {
  if (usesBuilderSetupCommand.value)
    return `npx @capgo/cli@latest build init -a [YOUR_CAPGO_API_KEY]${localCommand}`

  return `npx @capgo/cli@latest i [YOUR_CAPGO_API_KEY]${localCommand}`
})
const cliCommandArgs = computed(() => {
  const args: string[] = []

  if (usesBuilderSetupCommand.value)
    args.push('-a', apiKey.value ?? '[APIKEY]')

  if (isLocal(config.supaHost))
    args.push('--supa-host', config.supaHost, '--supa-anon', config.supaKey)

  return args
})
const currentOrg = computed(() => organizationStore.currentOrganization)
const resumeAppId = computed(() => {
  const value = route.query.resume
  return typeof value === 'string' ? value : ''
})
const resumeStep = computed(() => {
  const value = route.query.step
  return value === 'choice' || value === 'install' || value === 'setup' ? value : null
})
const canUseStoreImportPreview = computed(() => existingApp.value === true && existingAppSetup.value === 'import')
const iconPreview = computed(() => localIconPreview.value || (canUseStoreImportPreview.value ? storeIconPreview.value : '') || '')
const hasImportedStoreMetadata = computed(() => canUseStoreImportPreview.value && !!(importedStoreAppId.value || storeIconPreview.value || storeScreenshotPreview.value))
const canShowAppDetails = computed(() => {
  if (existingApp.value === false)
    return true
  if (existingApp.value === true)
    return existingAppSetup.value !== null
  return false
})
const suggestedAppId = computed(() => {
  if (createdApp.value)
    return createdApp.value.app_id

  const storeAppId = existingAppSetup.value === 'import'
    ? importedStoreAppId.value || extractAndroidAppId(storeUrl.value)
    : ''
  if (existingApp.value === true && storeAppId)
    return storeAppId

  const orgSlug = props.preOrg
    ? slugifyOnboardingSegment(appName.value || 'mobile-app')
    : slugifyOnboardingSegment(currentOrg.value?.name || 'capgo')
  const appSlug = slugifyOnboardingSegment(appName.value || 'mobile-app')
  return `com.${orgSlug}.${appSlug}`
})
const generatedAppId = computed(() => createdApp.value?.app_id || manualAppId.value.trim() || suggestedAppId.value)
const aiHelpPrompt = computed(() => {
  const resolvedAppId = createdApp.value?.app_id || generatedAppId.value || '[APP_ID]'
  const resolvedAppName = createdApp.value?.name?.trim() || appName.value.trim() || resolvedAppId
  const appStatus = createdApp.value?.existing_app
    ? t('app-onboarding-ai-help-status-existing')
    : t('app-onboarding-ai-help-status-new')

  return t('app-onboarding-ai-help-prompt', {
    appName: resolvedAppName,
    appId: resolvedAppId,
    appStatus,
    command: redactedCliCommand.value,
  })
})
const appOnboardingSteps = computed<Array<{ id: StandardFlowStep | PreOrgFlowStep, label: string }>>(() => {
  if (props.preOrg) {
    return [
      { id: 'intent', label: t('unified-onboarding-step-intent') },
      { id: 'details', label: t('app-onboarding-step-details') },
      { id: 'organization', label: t('unified-onboarding-step-organization') },
      { id: 'setup', label: t('unified-onboarding-step-setup') },
    ]
  }
  return [
    { id: 'details', label: t('app-onboarding-step-details') },
    { id: 'choice', label: t('app-onboarding-step-choice') },
    { id: 'install', label: t('app-onboarding-step-install') },
  ]
})
const currentStepIndex = computed(() => Math.max(0, appOnboardingSteps.value.findIndex(entry => entry.id === flowStep.value)))
const stepProgress = computed(() => `${((currentStepIndex.value + 1) / appOnboardingSteps.value.length) * 100}%`)
const userCountStops = computed<UserCountStop[]>(() => {
  const planStops = planNameOrder.map(planName => main.plans.find(plan => plan.name === planName)).flatMap((plan) => {
    if (!plan?.mau)
      return []
    const mau = Number(plan.mau)
    if (!Number.isFinite(mau) || mau <= 0)
      return []
    return [{ value: mau, label: formatUserCount(mau, plan.name === 'Enterprise'), planName: plan.name }]
  })
  return planStops.length === planNameOrder.length ? planStops : fallbackUserCountStops
})
const selectedUserCountStop = computed<UserCountStop | null>(() => estimatedUsersIndex.value === null ? null : userCountStops.value[Math.min(estimatedUsersIndex.value, userCountStops.value.length - 1)] ?? null)
const canShowOrgDetails = computed(() => orgMode.value !== null)
const canCreatePreOrgOrganization = computed(() => {
  if (!orgMode.value || !orgNameInput.value.trim())
    return false
  if (existingApp.value === true)
    return selectedUserCountStop.value !== null
  return true
})
const setupTitle = computed(() => usesBuilderSetupCommand.value ? t('unified-onboarding-setup-builder-title') : t('unified-onboarding-setup-ota-title'))
const setupSubtitle = computed(() => usesBuilderSetupCommand.value ? t('unified-onboarding-setup-builder-subtitle') : t('unified-onboarding-setup-ota-subtitle'))

function whiteCardToggleButtonClass(active: boolean) {
  return active
    ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 hover:border-primary-500 hover:bg-slate-100 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30 dark:hover:bg-primary-500/30'
    : 'border-slate-200 bg-white text-slate-700 hover:border-primary-500/40 hover:bg-slate-50 hover:text-slate-950 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900 dark:hover:text-white'
}

function whiteCardSecondaryButtonClass() {
  return 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-100 dark:hover:border-white/30 dark:hover:bg-slate-900 dark:disabled:border-white/15 dark:disabled:bg-slate-900 dark:disabled:text-slate-500'
}

function whiteCardPrimaryButtonClass() {
  return 'border-primary-500 bg-primary-500 text-white hover:border-primary-500 hover:bg-primary-500/90 disabled:border-slate-300 disabled:bg-slate-300 disabled:text-white disabled:opacity-100 dark:border-primary-500/90 dark:bg-primary-500 dark:hover:border-primary-500 dark:hover:bg-primary-500/90 dark:disabled:border-white/15 dark:disabled:bg-slate-800 dark:disabled:text-slate-500'
}

function formatUserCount(value: number, plus = false) {
  if (value >= 1_000_000)
    return plus ? '1M+' : '1M'
  if (value >= 1000)
    return `${value / 1000}K`
  return String(value)
}
function getUserCountStopTitle(stop: UserCountStop) {
  if (stop.value >= 1_000_000)
    return t('organization-onboarding-active-users-plus', { count: stop.label })
  return t('organization-onboarding-active-users-up-to', { count: stop.label })
}
function isUserCountStopSelected(index: number) {
  return estimatedUsersIndex.value === index
}
function selectUserCountStop(index: number) {
  estimatedUsersIndex.value = index
}
function extractAndroidAppId(url: string) {
  if (!url)
    return ''

  try {
    const parsed = new URL(url)
    return parsed.searchParams.get('id')?.trim() ?? ''
  }
  catch {
    return ''
  }
}

function getStoreUrls(url: string) {
  if (!url)
    return { iosStoreUrl: null, androidStoreUrl: null }

  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()

    if (host === 'apps.apple.com') {
      return {
        iosStoreUrl: parsed.toString(),
        androidStoreUrl: null,
      }
    }

    if (host === 'play.google.com') {
      return {
        iosStoreUrl: null,
        androidStoreUrl: parsed.toString(),
      }
    }
  }
  catch {
    // Keep validation soft here, backend will report invalid URLs on import.
  }

  return { iosStoreUrl: null, androidStoreUrl: null }
}

let storeImportRun = 0
function resetStoreImportState() {
  storeImportRun += 1
  storeUrl.value = ''
  storeIconPreview.value = ''
  storeScreenshotPreview.value = ''
  importedStoreAppId.value = ''
  isImportingStore.value = false
}

let resumeIconLoadRun = 0
async function loadResumeIconPreview(rawIconUrl: string | null | undefined, appId: string, run: number) {
  if (!rawIconUrl || getImmediateImageUrl(rawIconUrl)) {
    if (run === resumeIconLoadRun)
      isResumeIconLoading.value = false
    return
  }

  isResumeIconLoading.value = true
  try {
    const signedIconUrl = await createSignedImageUrl(rawIconUrl)
    if (!signedIconUrl || run !== resumeIconLoadRun || createdApp.value?.app_id !== appId)
      return

    localIconPreview.value = signedIconUrl
  }
  catch (error) {
    console.warn('Cannot load signed resume app icon', { appId, error })
  }
  finally {
    if (run === resumeIconLoadRun)
      isResumeIconLoading.value = false
  }
}

async function ensureApiKey() {
  const userId = main.user?.id
  if (!userId)
    return

  const existingKey = await findUsablePlainApiKey(supabase, userId, currentOrg.value?.gid, resumeAppId.value)
  if (existingKey) {
    apiKey.value = existingKey
    return
  }

  const { data: claimsData } = await supabase.auth.getClaims()
  const claimsUserId = claimsData?.claims?.sub
  if (!claimsUserId)
    return

  const { data, error: createError } = await createDefaultApiKey(supabase, 'api-key', {
    orgId: currentOrg.value?.gid,
    appId: resumeAppId.value,
  })
  if (createError)
    throw createError

  apiKey.value = typeof data?.key === 'string'
    ? data.key
    : await findUsablePlainApiKey(supabase, claimsUserId, currentOrg.value?.gid, resumeAppId.value)
}

async function loadResumeApp() {
  if (!resumeAppId.value || !currentOrg.value?.gid)
    return false

  const { data, error } = await supabase
    .from('apps')
    .select()
    .eq('owner_org', currentOrg.value.gid)
    .eq('app_id', resumeAppId.value)
    .single()

  if (error || !data) {
    toast.error(t('app-onboarding-toast-resume-not-found'))
    return false
  }

  createdApp.value = data
  appName.value = data.name ?? ''
  existingApp.value = data.existing_app ?? null
  storeUrl.value = data.ios_store_url ?? data.android_store_url ?? ''
  importedStoreAppId.value = extractAndroidAppId(data.android_store_url ?? '') || ''
  const iconLoadRun = ++resumeIconLoadRun
  localIconPreview.value = getImmediateImageUrl(data.icon_url) || ''
  void loadResumeIconPreview(data.icon_url, data.app_id, iconLoadRun)
  storeScreenshotPreview.value = ''
  if (resumeStep.value === 'setup') {
    flowStep.value = 'setup'
    hydrateIntentFromCurrentOrg()
    try {
      await ensureApiKey()
    }
    catch (error) {
      console.error('Cannot ensure API key', error)
      toast.error(t('app-onboarding-toast-apikey-error'))
    }
  }
  else {
    flowStep.value = resumeStep.value === 'choice' ? 'choice' : 'install'
  }
  return true
}

async function importStoreMetadata() {
  const requestedUrl = storeUrl.value.trim()
  if (!requestedUrl || existingAppSetup.value !== 'import')
    return

  const requestedRun = ++storeImportRun
  isImportingStore.value = true
  try {
    const { data, error } = await supabase.functions.invoke('app/store-metadata', {
      method: 'POST',
      body: { url: requestedUrl },
    })

    if (requestedRun !== storeImportRun || existingAppSetup.value !== 'import' || storeUrl.value.trim() !== requestedUrl)
      return

    if (error)
      throw error

    if (typeof data?.name === 'string' && data.name.trim() && !appName.value.trim())
      appName.value = data.name.trim()

    const importedIcon = typeof data?.icon_data_url === 'string' && data.icon_data_url.trim()
      ? data.icon_data_url.trim()
      : typeof data?.icon_url === 'string' && data.icon_url.trim()
        ? data.icon_url.trim()
        : ''
    if (importedIcon && !localIconPreview.value)
      storeIconPreview.value = importedIcon

    if (typeof data?.screenshot_url === 'string' && data.screenshot_url.trim())
      storeScreenshotPreview.value = data.screenshot_url.trim()

    if (typeof data?.app_id === 'string' && data.app_id.trim())
      importedStoreAppId.value = data.app_id.trim()
  }
  catch (error) {
    if (requestedRun !== storeImportRun || existingAppSetup.value !== 'import' || storeUrl.value.trim() !== requestedUrl)
      return

    console.error('Cannot import store metadata', error)
    toast.error(t('app-onboarding-toast-store-metadata-error'))
  }
  finally {
    if (requestedRun === storeImportRun)
      isImportingStore.value = false
  }
}

function onSelectIconFormKit(value: unknown) {
  const fileValue = Array.isArray(value) ? value[0] : value
  const file = fileValue && typeof fileValue === 'object' && 'file' in fileValue
    ? (fileValue as { file?: File }).file ?? null
    : fileValue instanceof File
      ? fileValue
      : null

  selectedIconFile.value = file
  if (localIconPreview.value.startsWith('blob:'))
    URL.revokeObjectURL(localIconPreview.value)
  localIconPreview.value = file ? URL.createObjectURL(file) : ''
  isResumeIconLoading.value = false
}

function onAppIdInput(event: Event) {
  hasEditedAppId.value = true
  manualAppId.value = (event.target as HTMLInputElement).value
  appIdFeedback.value = ''
}

function applyAppIdSuggestion(suggestion: string) {
  hasEditedAppId.value = true
  manualAppId.value = suggestion
  appIdFeedback.value = ''
}

async function uploadIcon(appId: string, iconSourceUrl?: string) {
  if (!currentOrg.value?.gid)
    return

  let fileToUpload = selectedIconFile.value

  if (!fileToUpload && iconSourceUrl) {
    try {
      const parsedIconUrl = new URL(iconSourceUrl)
      if (parsedIconUrl.protocol !== 'https:') {
        console.warn('Skipping non-HTTPS icon URL', iconSourceUrl)
      }
      else {
        const response = await fetch(parsedIconUrl.toString())
        const blob = await response.blob()
        fileToUpload = new File([blob], 'store-icon.png', { type: blob.type || 'image/png' })
      }
    }
    catch (error) {
      console.warn('Cannot fetch remote icon', error)
    }
  }

  if (!fileToUpload)
    return

  const iconPath = `org/${currentOrg.value.gid}/${appId}/icon`
  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(iconPath, fileToUpload, {
      upsert: true,
      contentType: fileToUpload.type || 'image/png',
    })

  if (uploadError) {
    console.error('Cannot upload app icon', uploadError)
    return
  }

  await supabase
    .from('apps')
    .update({ icon_url: iconPath })
    .eq('app_id', appId)
}

function ensureValidAppId(): boolean {
  const appId = generatedAppId.value.trim()
  if (!appId) {
    toast.error(t('app-onboarding-toast-appid-required'))
    return false
  }

  if (!isValidAppId(appId)) {
    appIdFeedback.value = t('app-onboarding-appid-invalid-format')
    toast.error(appIdFeedback.value)
    return false
  }

  appIdFeedback.value = ''
  return true
}

function restoreDraftState() {
  const draft = loadOnboardingAppDraft(onboardingUserId.value)
  if (!draft)
    return false

  appName.value = draft.appName
  manualAppId.value = draft.appId
  hasEditedAppId.value = true
  existingApp.value = draft.existingApp
  existingAppSetup.value = draft.existingAppSetup
  storeUrl.value = draft.storeUrl
  importedStoreAppId.value = draft.importedStoreAppId
  if (draft.storeIconDataUrl)
    storeIconPreview.value = draft.storeIconDataUrl
  if (draft.storeScreenshotUrl)
    storeScreenshotPreview.value = draft.storeScreenshotUrl
  if (draft.iconDataUrl)
    localIconPreview.value = draft.iconDataUrl
  return true
}

function hydrateIntentFromCurrentOrg() {
  const onboarding = (currentOrg.value as { onboarding?: unknown } | null | undefined)?.onboarding
  if (!onboarding || typeof onboarding !== 'object' || Array.isArray(onboarding))
    return

  const intent = (onboarding as { intent?: unknown }).intent
  if (typeof intent === 'string' && intent)
    selectedIntent.value = intent
}

function continueFromIntent() {
  if (!selectedIntent.value) {
    toast.error(t('organization-onboarding-intent-required'))
    return
  }

  flowStep.value = 'details'
}

function continuePreOrgDetails() {
  if (existingApp.value === null) {
    toast.error(t('app-onboarding-toast-existing-required'))
    return
  }

  if (!appName.value.trim()) {
    toast.error(t('app-onboarding-toast-name-required'))
    return
  }

  if (!generatedAppId.value.trim()) {
    toast.error(t('app-onboarding-toast-appid-required'))
    return
  }

  if (!ensureValidAppId())
    return

  if (!orgMode.value)
    orgMode.value = 'app-name'

  flowStep.value = 'organization'
}

async function createOrganizationAndApp() {
  if (!selectedIntent.value) {
    toast.error(t('organization-onboarding-intent-required'))
    return
  }

  if (!canCreatePreOrgOrganization.value) {
    toast.error(t('organization-onboarding-mode-required'))
    return
  }

  const orgName = orgNameInput.value.trim()
  const estimatedMau = existingApp.value === true
    ? selectedUserCountStop.value?.value
    : userCountStops.value[0]?.value

  if (!estimatedMau) {
    toast.error(t('organization-onboarding-user-scale-required'))
    return
  }

  isSubmitting.value = true
  try {
    const { data, error } = await supabase.functions.invoke('organization', {
      method: 'POST',
      body: {
        name: orgName,
        email: main.auth?.email ?? '',
        estimatedMau,
        intent: selectedIntent.value,
      },
    })

    if (error || !data?.id) {
      console.error('Error creating organization during unified onboarding', error)
      toast.error(error?.code === '23505'
        ? t('org-with-this-name-exists')
        : t('cannot-create-org'))
      return
    }

    try {
      pushEvent('onboarding_intent_selected', config.supaHost, {
        intent: selectedIntent.value,
        estimated_mau: estimatedMau,
        org_id: data.id,
      })
    }
    catch (eventError) {
      console.error('Failed to track onboarding intent', eventError)
    }

    try {
      await organizationStore.fetchOrganizations()
      organizationStore.setCurrentOrganization(data.id)
    }
    catch (refreshError) {
      console.error('Failed to refresh organizations after unified onboarding create', refreshError)
      toast.error(t('organization-onboarding-refresh-failed'))
      return
    }

    clearOnboardingAppDraft(onboardingUserId.value)
    await createAppRecord({ nextStep: 'setup' })

    if (!createdApp.value)
      return

    try {
      await ensureApiKey()
    }
    catch (apiKeyError) {
      console.error('Cannot ensure API key', apiKeyError)
      toast.error(t('app-onboarding-toast-apikey-error'))
    }

    flowStep.value = 'setup'
  }
  finally {
    isSubmitting.value = false
  }
}

async function createAppRecord(options?: { nextStep?: StandardFlowStep | PreOrgFlowStep }) {
  if (!currentOrg.value?.gid) {
    toast.error(t('app-onboarding-toast-no-organization'))
    return
  }

  if (existingApp.value === null) {
    toast.error(t('app-onboarding-toast-existing-required'))
    return
  }

  if (!appName.value.trim()) {
    toast.error(t('app-onboarding-toast-name-required'))
    return
  }

  if (!generatedAppId.value.trim()) {
    toast.error(t('app-onboarding-toast-appid-required'))
    return
  }

  if (!ensureValidAppId())
    return

  isSubmitting.value = true
  try {
    const normalizedStoreUrls = existingApp.value === true && existingAppSetup.value === 'import'
      ? getStoreUrls(storeUrl.value.trim())
      : { iosStoreUrl: null, androidStoreUrl: null }

    let appId = generatedAppId.value
    const createResult = await createOnboardingAppWithFallbackIds(supabase, {
      ownerOrgId: currentOrg.value.gid,
      baseAppId: appId,
      appName: appName.value.trim(),
      existingApp: existingApp.value,
      iosStoreUrl: normalizedStoreUrls.iosStoreUrl,
      androidStoreUrl: normalizedStoreUrls.androidStoreUrl,
      orgName: currentOrg.value?.name,
      fallbackBaseId: suggestedAppId.value,
    }, {
      defaultMessage: t('app-onboarding-toast-create-error'),
      statusMessage: status => t('app-onboarding-toast-create-error-status', { status }),
    })

    if (createResult.ok === false) {
      if (createResult.reason === 'all_conflicts') {
        appIdSuggestions.value = createResult.suggestions
        appIdFeedback.value = t('app-onboarding-appid-taken-pick-another', {
          appId: createResult.originalAppId,
        })
        toast.error(appIdFeedback.value)
        return
      }

      appIdFeedback.value = createResult.message
      toast.error(appIdFeedback.value)
      throw createResult.error
    }

    const responseData = createResult.app
    appId = createResult.usedAppId
    manualAppId.value = createResult.usedAppId
    if (createResult.wasRetried) {
      appIdFeedback.value = t('app-onboarding-appid-taken-switched', {
        original: createResult.originalAppId,
        replacement: createResult.usedAppId,
      })
      appIdSuggestions.value = buildAlternativeAppIds(createResult.originalAppId, {
        orgName: currentOrg.value?.name,
        fallbackBaseId: suggestedAppId.value,
      })
      toast.info(appIdFeedback.value)
    }
    else {
      appIdFeedback.value = ''
      appIdSuggestions.value = []
    }

    const importedIconSource = canUseStoreImportPreview.value ? storeIconPreview.value : ''
    await uploadIcon(appId, importedIconSource)
    const { data: refreshed } = await supabase
      .from('apps')
      .select()
      .eq('app_id', appId)
      .single()

    createdApp.value = refreshed ?? responseData
    flowStep.value = options?.nextStep ?? 'choice'
  }
  catch (error) {
    console.error('Cannot create onboarding app', error)
    if (!appIdFeedback.value)
      toast.error(t('app-onboarding-toast-create-error'))
  }
  finally {
    isSubmitting.value = false
  }
}

async function seedDemoData() {
  if (!createdApp.value || !currentOrg.value?.gid)
    return

  isSeedingDemo.value = true
  try {
    const { data, error } = await supabase.functions.invoke('app/demo', {
      method: 'POST',
      body: {
        owner_org: currentOrg.value.gid,
        app_id: createdApp.value.app_id,
      },
    })

    if (error || !data?.app_id) {
      throw error
    }

    router.push(`/app/${encodeURIComponent(createdApp.value.app_id)}?tour=1&refresh=true`)
  }
  catch (error) {
    console.error('Cannot seed demo data', error)
    toast.error(t('app-onboarding-toast-demo-error'))
  }
  finally {
    isSeedingDemo.value = false
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('copied-to-clipboard'))
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
  }
}

async function copyCliCommand() {
  await copyText(cliCommand.value)
}

async function copyAiInstructions() {
  await copyText(aiHelpPrompt.value)
}

function goToInstallStep() {
  isCliCommandVisible.value = false
  flowStep.value = 'install'
}

function openDashboard() {
  if (!createdApp.value)
    return

  router.push(`/app/${encodeURIComponent(createdApp.value.app_id)}`)
}

onMounted(async () => {
  isLoading.value = true
  try {
    if (props.preOrg) {
      restoreDraftState()
      flowStep.value = 'intent'
      return
    }

    await organizationStore.awaitInitialLoad()
    await main.awaitInitialLoad()

    try {
      await ensureApiKey()
    }
    catch (error) {
      console.error('Cannot ensure API key', error)
      toast.error(t('app-onboarding-toast-apikey-error'))
    }
    const resumed = await loadResumeApp()
    if (!resumed)
      flowStep.value = 'details'
  }
  finally {
    isLoading.value = false
  }
})

onBeforeUnmount(() => {
  if (localIconPreview.value.startsWith('blob:'))
    URL.revokeObjectURL(localIconPreview.value)
})

watch(existingApp, (value) => {
  existingAppSetup.value = value === true ? null : value === false ? 'manual' : null
  if (value !== true) {
    resetStoreImportState()
  }
  if (value === false)
    estimatedUsersIndex.value = 0
  appIdSuggestions.value = []
  appIdFeedback.value = ''
})

watch(orgMode, (value) => {
  if (value === 'app-name')
    orgNameInput.value = appName.value.trim()
})

watch(appName, (value) => {
  if (orgMode.value === 'app-name')
    orgNameInput.value = value.trim()
})

watch(existingAppSetup, (value) => {
  if (value === 'manual')
    resetStoreImportState()
})

watch(suggestedAppId, (value) => {
  if (!hasEditedAppId.value && !createdApp.value)
    manualAppId.value = value
}, { immediate: true })
</script>

<template>
  <section class="min-h-full overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-slate-950">
    <div class="mx-auto w-full max-w-3xl">
      <div v-if="isLoading" class="flex min-h-[50vh] items-center justify-center">
        <Spinner size="w-32 h-32" />
      </div>

      <div v-else class="space-y-6">
        <header>
          <div class="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-700 shadow-sm dark:border-white/15 dark:bg-slate-900/95 dark:text-slate-200">
            <IconSparkles class="h-4 w-4" />
            {{ t('app-onboarding-badge') }}
          </div>
          <h1 class="mt-4 text-2xl font-semibold text-slate-950 sm:text-3xl dark:text-white">
            {{ props.onboarding
              ? t('app-onboarding-title-first')
              : t('app-onboarding-title-return') }}
          </h1>
          <p v-if="!props.preOrg" class="mt-2 text-base leading-7 text-slate-600 dark:text-slate-300">
            {{ t('app-onboarding-subtitle') }}
          </p>

          <nav class="mt-6" :aria-label="t('app-onboarding-step-details')">
            <ol class="flex items-center gap-2">
              <li
                v-for="(entry, index) in appOnboardingSteps"
                :key="entry.id"
                class="flex min-w-0 flex-1 items-center gap-2"
                :aria-current="flowStep === entry.id ? 'step' : undefined"
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  :class="index < currentStepIndex ? 'bg-emerald-500 text-white' : flowStep === entry.id ? 'bg-primary-500 text-white' : 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'"
                >
                  <IconCheck v-if="index < currentStepIndex" class="h-3.5 w-3.5" />
                  <span v-else>{{ index + 1 }}</span>
                </span>
                <span
                  class="hidden truncate text-sm font-medium sm:block"
                  :class="flowStep === entry.id ? 'text-slate-950 dark:text-white' : index < currentStepIndex ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-400 dark:text-slate-500'"
                >
                  {{ entry.label }}
                </span>
                <span
                  v-if="index < appOnboardingSteps.length - 1"
                  class="mx-1 hidden h-px flex-1 bg-slate-200 sm:block dark:bg-white/15"
                  aria-hidden="true"
                />
              </li>
            </ol>
            <div class="mt-3 h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden="true">
              <div class="h-full rounded-full bg-primary-500 transition-all duration-300" :style="{ width: stepProgress }" />
            </div>
          </nav>
        </header>

        <div v-if="props.preOrg && flowStep === 'intent'" class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
          <div class="space-y-6">
            <div>
              <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                {{ t('unified-onboarding-step-intent') }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                {{ t('organization-onboarding-intent-question') }}
              </h2>
              <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('organization-onboarding-intent-hint') }}
              </p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <button v-for="option in intentOptions" :key="option.value" type="button" class="group flex min-h-20 items-start gap-3 rounded-xl border p-3 text-left transition" :class="whiteCardToggleButtonClass(selectedIntent === option.value)" :data-test="`onboarding-intent-${option.value}`" @click="selectedIntent = option.value">
                <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-primary-500"><component :is="option.icon" class="h-5 w-5" /></span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-slate-950 dark:text-white">{{ t(`organization-onboarding-intent-option-${option.value}-label`) }}</span>
                  <span class="mt-1 block text-xs leading-5 text-slate-600 dark:text-slate-300">{{ t(`organization-onboarding-intent-option-${option.value}-desc`) }}</span>
                </span>
              </button>
            </div>
            <div class="flex justify-end border-t border-slate-200 pt-6 dark:border-white/15">
              <button type="button" class="d-btn min-h-12" :class="whiteCardPrimaryButtonClass()" data-test="app-onboarding-continue-intent" :disabled="!selectedIntent" @click="continueFromIntent()">
                {{ t('unified-onboarding-continue-intent') }}<IconArrowRight class="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="flowStep === 'details'">
          <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
            <div class="space-y-6">
              <div>
                <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                  {{ t('app-onboarding-step-details') }}
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ t('app-onboarding-existing-question') }}
                </h2>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  :aria-pressed="existingApp === true"
                  class="group flex min-h-32 items-start gap-4 rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                  :class="whiteCardToggleButtonClass(existingApp === true)"
                  data-test="app-onboarding-existing-yes"
                  @click="existingApp = true"
                >
                  <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white">
                    <IconStore class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-base font-semibold">{{ t('app-onboarding-existing-yes') }}</span>
                    <span
                      class="mt-1 block text-sm leading-6"
                      :class="existingApp === true ? 'text-slate-600 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400'"
                    >
                      {{ t('app-onboarding-existing-yes-helper') }}
                    </span>
                  </span>
                  <IconCheck v-if="existingApp === true" class="h-5 w-5 shrink-0 text-current" />
                </button>
                <button
                  type="button"
                  :aria-pressed="existingApp === false"
                  class="group flex min-h-32 items-start gap-4 rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                  :class="whiteCardToggleButtonClass(existingApp === false)"
                  data-test="app-onboarding-existing-no"
                  @click="existingApp = false"
                >
                  <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-950">
                    <IconAppWindow class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-base font-semibold">{{ t('app-onboarding-existing-no') }}</span>
                    <span
                      class="mt-1 block text-sm leading-6"
                      :class="existingApp === false ? 'text-slate-600 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400'"
                    >
                      {{ t('app-onboarding-existing-no-helper') }}
                    </span>
                  </span>
                  <IconCheck v-if="existingApp === false" class="h-5 w-5 shrink-0 text-current" />
                </button>
              </div>

              <div v-if="existingApp === true" class="space-y-5 border-t border-slate-200 pt-6 dark:border-white/15">
                <div>
                  <p class="text-sm font-semibold text-slate-950 dark:text-white">
                    {{ t('app-onboarding-start-question') }}
                  </p>
                  <div class="mt-3 grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      :aria-pressed="existingAppSetup === 'import'"
                      class="flex min-h-24 items-start gap-3 rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                      :class="whiteCardToggleButtonClass(existingAppSetup === 'import')"
                      @click="existingAppSetup = 'import'"
                    >
                      <IconGlobe class="mt-0.5 h-5 w-5 shrink-0" />
                      <span>
                        <span class="block text-sm font-semibold">{{ t('app-onboarding-mode-import') }}</span>
                        <span class="mt-1 block text-sm leading-6 opacity-75">{{ t('app-onboarding-mode-import-helper') }}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      :aria-pressed="existingAppSetup === 'manual'"
                      class="flex min-h-24 items-start gap-3 rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                      :class="whiteCardToggleButtonClass(existingAppSetup === 'manual')"
                      @click="existingAppSetup = 'manual'"
                    >
                      <IconCode class="mt-0.5 h-5 w-5 shrink-0" />
                      <span>
                        <span class="block text-sm font-semibold">{{ t('app-onboarding-mode-manual') }}</span>
                        <span class="mt-1 block text-sm leading-6 opacity-75">{{ t('app-onboarding-mode-manual-helper') }}</span>
                      </span>
                    </button>
                  </div>
                </div>

                <template v-if="existingAppSetup === 'import'">
                  <div>
                    <label for="app-onboarding-store-url" class="text-sm font-medium text-slate-800 dark:text-slate-200">{{ t('app-onboarding-store-link-label') }}</label>
                    <div class="mt-2 flex flex-col gap-3 sm:flex-row">
                      <input
                        id="app-onboarding-store-url"
                        v-model="storeUrl"
                        class="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                        :placeholder="t('app-onboarding-store-link-placeholder')"
                        type="url"
                      >
                      <button class="d-btn min-h-12 shrink-0" :class="whiteCardSecondaryButtonClass()" :disabled="isImportingStore || !storeUrl" @click="importStoreMetadata()">
                        <IconLoader v-if="isImportingStore" class="h-4 w-4 animate-spin" />
                        <IconSparkles v-else class="h-4 w-4" />
                        <span>{{ t('app-onboarding-store-import-button') }}</span>
                      </button>
                    </div>
                    <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400" aria-live="polite">
                      {{ hasImportedStoreMetadata
                        ? t('app-onboarding-store-imported-help')
                        : t('app-onboarding-store-help') }}
                    </p>
                  </div>
                </template>
              </div>

              <template v-if="canShowAppDetails">
                <div class="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
                  <div class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-slate-200 ring-1 ring-slate-300 dark:bg-slate-800 dark:ring-white/10">
                    <img v-if="iconPreview" :src="iconPreview" :alt="t('app-onboarding-icon-preview-alt')" class="h-full w-full object-cover">
                    <span v-else-if="isResumeIconLoading" class="h-5 w-5 rounded-full border-2 border-primary-500 border-t-transparent animate-spin" :aria-label="t('loading')" />
                    <IconSmartphone v-else class="h-6 w-6 text-slate-400" aria-hidden="true" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-base font-semibold text-slate-950 dark:text-white">
                      {{ appName || t('app-onboarding-preview-placeholder') }}
                    </p>
                    <p class="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {{ generatedAppId }}
                    </p>
                  </div>
                </div>

                <div>
                  <label for="app-onboarding-name" class="text-sm font-medium text-slate-800 dark:text-slate-200">{{ t('app-name') }}</label>
                  <input
                    id="app-onboarding-name"
                    v-model="appName"
                    data-test="app-onboarding-name"
                    class="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                    :placeholder="t('app-onboarding-name-placeholder')"
                    maxlength="100"
                  >
                </div>

                <div>
                  <label for="app-onboarding-app-id" class="text-sm font-medium text-slate-800 dark:text-slate-200">{{ t('app-id') }}</label>
                  <input
                    id="app-onboarding-app-id"
                    :value="manualAppId"
                    class="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 font-mono text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                    :placeholder="t('app-onboarding-appid-placeholder')"
                    @input="onAppIdInput"
                  >
                  <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    {{ existingApp
                      ? t('app-onboarding-appid-help-existing')
                      : t('app-onboarding-appid-help-new') }}
                  </p>
                  <output v-if="appIdFeedback" class="mt-2 block text-sm font-medium text-amber-700 dark:text-amber-300" for="app-onboarding-app-id">
                    {{ appIdFeedback }}
                  </output>
                  <div v-if="appIdSuggestions.length > 0" class="mt-3 flex flex-wrap gap-2">
                    <button
                      v-for="suggestion in appIdSuggestions"
                      :key="suggestion"
                      type="button"
                      class="min-h-9 rounded-full border border-slate-300 bg-white px-3 py-1 font-mono text-xs text-slate-700 transition hover:border-primary-500/40 hover:text-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:text-white"
                      @click="applyAppIdSuggestion(suggestion)"
                    >
                      {{ suggestion }}
                    </button>
                  </div>
                </div>

                <div>
                  <FormKit
                    type="file"
                    :label="t('app-onboarding-icon-label')"
                    accept="image/*"
                    outer-class="mt-0"
                    label-class="text-sm font-medium text-slate-800 dark:text-slate-200"
                    input-class="mt-2 block w-full min-h-11 text-sm text-slate-600 file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:text-sm file:font-medium file:text-slate-700 dark:text-slate-300 dark:file:bg-slate-800 dark:file:text-slate-200"
                    @update:model-value="onSelectIconFormKit"
                  />
                  <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    {{ t('app-onboarding-icon-help') }}
                  </p>
                </div>

                <div v-if="storeScreenshotPreview" class="overflow-hidden rounded-xl border border-slate-200 dark:border-white/15">
                  <img :src="storeScreenshotPreview" :alt="t('app-onboarding-store-screenshot-alt')" class="mx-auto aspect-9/19.5 max-h-48 w-auto object-cover object-top">
                </div>

                <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between dark:border-white/15">
                  <button class="d-btn min-h-12" :class="whiteCardSecondaryButtonClass()" @click="props.preOrg ? (flowStep = 'intent') : router.push('/apps')">
                    {{ props.preOrg ? t('button-back') : t('button-cancel') }}
                  </button>
                  <button
                    class="d-btn min-h-12" :class="whiteCardPrimaryButtonClass()" :disabled="isSubmitting" data-test="app-onboarding-continue"
                    @click="props.preOrg ? continuePreOrgDetails() : createAppRecord()"
                  >
                    <IconLoader v-if="isSubmitting" class="h-4 w-4 animate-spin" />
                    <span v-else>{{ t('app-onboarding-continue') }}</span>
                    <IconArrowRight v-if="!isSubmitting" class="h-4 w-4" />
                  </button>
                </div>
              </template>

              <div class="pt-1">
                <button
                  v-if="!isCliCommandVisible"
                  type="button"
                  class="text-[11px] text-slate-400/70 underline-offset-2 transition hover:text-slate-500 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-500/70 dark:hover:text-slate-400"
                  @click="isCliCommandVisible = true"
                >
                  {{ t('app-onboarding-command-show') }}
                </button>

                <div
                  v-else
                  class="space-y-3 rounded-xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-white/10 dark:bg-slate-950/40"
                >
                  <div class="flex items-start justify-between gap-3">
                    <p class="text-xs leading-5 text-slate-500 dark:text-slate-400">
                      {{ t('app-onboarding-command-help') }}
                    </p>
                    <button
                      type="button"
                      class="shrink-0 text-[11px] text-slate-400 underline-offset-2 transition hover:text-slate-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-500 dark:hover:text-slate-300"
                      @click="isCliCommandVisible = false"
                    >
                      {{ t('app-onboarding-command-hide') }}
                    </button>
                  </div>
                  <div
                    class="group relative cursor-pointer rounded-xl bg-slate-950 p-4 pr-14 ring-1 ring-white/10 transition hover:ring-white/20"
                    role="button"
                    tabindex="0"
                    :aria-label="t('app-onboarding-command-copy')"
                    @click="copyCliCommand"
                    @keydown.enter.prevent="copyCliCommand"
                    @keydown.space.prevent="copyCliCommand"
                  >
                    <code class="block whitespace-pre-wrap break-all text-sm">
                      <span class="text-slate-500">npx</span>
                      <span class="text-sky-300"> @capgo/cli@latest</span>
                      <span class="mr-1 font-bold text-violet-300"> {{ cliSubcommand }}</span>
                      <span class="text-emerald-300"> {{ apiKey ?? '[APIKEY]' }}</span>
                      <template v-for="(arg, index) in cliCommandArgs" :key="`${arg}-${index}`">
                        <span :class="index % 2 === 0 ? 'text-amber-300' : 'text-cyan-300'"> {{ arg }}</span>
                      </template>
                    </code>
                    <IconCopy class="absolute right-4 top-4 h-5 w-5 text-muted-blue-300 transition group-hover:text-white" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="props.preOrg && flowStep === 'organization'" class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
          <div class="space-y-6">
            <div>
              <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                {{ t('unified-onboarding-step-organization') }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                {{ t('organization-onboarding-question') }}
              </h2>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                class="group flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                :class="whiteCardToggleButtonClass(orgMode === 'app-name')"
                data-test="onboarding-mode-app-name"
                @click="orgMode = 'app-name'"
              >
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-white">
                  <IconSmartphone class="h-5 w-5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-base font-semibold">{{ t('organization-onboarding-mode-app-name', { name: appName || t('app-onboarding-preview-placeholder') }) }}</span>
                  <span class="mt-1 block text-sm leading-6 text-slate-500 dark:text-slate-400">
                    {{ t('organization-onboarding-mode-app-name-helper') }}
                  </span>
                </span>
                <IconCheck v-if="orgMode === 'app-name'" class="h-5 w-5 shrink-0 text-primary-500" />
              </button>
              <button
                type="button"
                class="group flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                :class="whiteCardToggleButtonClass(orgMode === 'name')"
                data-test="onboarding-mode-name"
                @click="orgMode = 'name'"
              >
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-950">
                  <IconPencil class="h-5 w-5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-base font-semibold">{{ t('organization-onboarding-mode-name') }}</span>
                  <span class="mt-1 block text-sm leading-6 text-slate-500 dark:text-slate-400">
                    {{ t('organization-onboarding-mode-name-helper') }}
                  </span>
                </span>
                <IconCheck v-if="orgMode === 'name'" class="h-5 w-5 shrink-0 text-primary-500" />
              </button>
            </div>

            <template v-if="canShowOrgDetails">
              <div>
                <label for="onboarding-org-name-input" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {{ t('organization-name') }}
                </label>
                <input
                  id="onboarding-org-name-input"
                  v-model="orgNameInput"
                  type="text"
                  :placeholder="t('organization-name')"
                  data-test="onboarding-org-name"
                  class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                >
              </div>

              <div v-if="existingApp === true">
                <p id="estimated-users-label" class="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                  <IconUsers class="h-4 w-4 text-primary-500" />
                  {{ t('organization-onboarding-existing-users-label') }}
                </p>
                <p id="estimated-users-help" class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  {{ t('organization-onboarding-existing-users-helper') }}
                </p>

                <div
                  id="estimated-users"
                  class="mt-3 grid gap-2 sm:grid-cols-2"
                  role="radiogroup"
                  aria-labelledby="estimated-users-label"
                  aria-describedby="estimated-users-help"
                  data-test="onboarding-estimated-users"
                >
                  <label
                    v-for="(stop, index) in userCountStops"
                    :key="`${stop.planName}-${stop.value}`"
                    class="group cursor-pointer"
                    :data-value="stop.value"
                    data-test="onboarding-estimated-users-option"
                  >
                    <input
                      type="radio"
                      name="estimated-users"
                      class="peer sr-only"
                      :value="index"
                      :checked="isUserCountStopSelected(index)"
                      @change="selectUserCountStop(index)"
                    >
                    <span
                      class="flex min-h-16 items-center justify-between gap-3 rounded-xl border p-3 text-left transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-white dark:peer-focus-visible:ring-offset-slate-900"
                      :class="isUserCountStopSelected(index)
                        ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900'"
                    >
                      <span class="min-w-0">
                        <span class="block text-sm font-semibold">
                          {{ getUserCountStopTitle(stop) }}
                        </span>
                        <span class="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                          {{ t('organization-onboarding-plan-match') }}: {{ stop.planName }}
                        </span>
                      </span>
                      <span
                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition"
                        :class="isUserCountStopSelected(index) ? 'border-primary-500 bg-primary-500 text-white' : 'border-slate-300 bg-white text-transparent group-hover:border-slate-400 dark:border-white/20 dark:bg-slate-900'"
                        aria-hidden="true"
                      >
                        <IconCheck class="h-3.5 w-3.5" />
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between dark:border-white/15">
                <button type="button" class="d-btn min-h-12" :class="whiteCardSecondaryButtonClass()" @click="flowStep = 'details'">
                  {{ t('button-back') }}
                </button>
                <button
                  type="button"
                  class="d-btn min-h-12"
                  :class="whiteCardPrimaryButtonClass()"
                  data-test="onboarding-create-org"
                  :disabled="!canCreatePreOrgOrganization || isSubmitting"
                  @click="createOrganizationAndApp()"
                >
                  <IconLoader v-if="isSubmitting" class="h-4 w-4 animate-spin" />
                  <span v-else>{{ t('unified-onboarding-continue-organization') }}</span>
                  <IconArrowRight v-if="!isSubmitting" class="h-4 w-4" />
                </button>
              </div>
            </template>
          </div>
        </div>

        <div v-else-if="flowStep === 'setup' && createdApp" class="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                {{ t('unified-onboarding-step-setup') }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                {{ setupTitle }}
              </h2>
              <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ setupSubtitle }}
              </p>
            </div>
            <button class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" @click="openDashboard">
              {{ t('app-onboarding-open-dashboard') }}
            </button>
          </div>

          <div
            class="group relative cursor-pointer rounded-2xl bg-slate-950 p-5 pr-14 ring-1 ring-white/10 transition hover:ring-white/20"
            role="button"
            tabindex="0"
            data-test="app-onboarding-command-copy"
            :aria-label="t('app-onboarding-command-copy')"
            @click="copyCliCommand"
            @keydown.enter.prevent="copyCliCommand"
            @keydown.space.prevent="copyCliCommand"
          >
            <code class="block whitespace-pre-wrap break-all text-sm">
              <span class="text-slate-500">npx</span>
              <span class="text-sky-300"> @capgo/cli@latest</span>
              <span class="mr-1 font-bold text-violet-300"> {{ cliSubcommand }}</span>
              <span class="text-emerald-300"> {{ apiKey ?? '[APIKEY]' }}</span>
              <template v-for="(arg, index) in cliCommandArgs" :key="`${arg}-${index}`">
                <span :class="index % 2 === 0 ? 'text-amber-300' : 'text-cyan-300'"> {{ arg }}</span>
              </template>
            </code>
            <IconCopy class="absolute right-4 top-4 h-5 w-5 text-muted-blue-300 transition group-hover:text-white" />
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
              <button class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" @click="copyAiInstructions">
                <IconCopy class="h-4 w-4" />
                {{ t('app-onboarding-ai-help-button') }}
              </button>
            </div>
          </div>

          <div class="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
            <button class="d-btn min-h-11" :class="whiteCardPrimaryButtonClass()" @click="openDashboard">
              {{ t('app-onboarding-install-later') }}
              <IconArrowRight class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div v-else-if="!props.preOrg && flowStep === 'choice' && createdApp" class="space-y-6">
          <div class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95 dark:shadow-2xl dark:shadow-black/30">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                  {{ t('app-onboarding-step-choice') }}
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ t('app-onboarding-choice-title') }}
                </h2>
                <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {{ t('app-onboarding-choice-subtitle') }}
                </p>
              </div>
              <div class="rounded-xl bg-slate-50 px-3 py-2 text-sm dark:border dark:border-white/10 dark:bg-slate-950/90">
                <span class="text-slate-500 dark:text-slate-400">{{ t('app-id') }}</span>
                <span class="ml-2 font-mono font-medium text-slate-950 dark:text-white">{{ createdApp.app_id }}</span>
              </div>
            </div>

            <div class="mt-6 grid gap-4 md:grid-cols-2">
              <button class="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-primary-500/40 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/15 dark:bg-slate-950/90 dark:hover:border-white/30 dark:hover:bg-slate-900" @click="goToInstallStep">
                <div class="flex items-start gap-4">
                  <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-white">
                    <IconTerminal class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="text-sm font-semibold uppercase text-primary-500 dark:text-slate-300">
                      {{ t('app-onboarding-choice-real-badge') }}
                    </span>
                    <span class="mt-2 block text-xl font-semibold text-slate-950 dark:text-white">
                      {{ t('app-onboarding-choice-real-title') }}
                    </span>
                    <span class="mt-2 block text-sm leading-6 text-slate-600 dark:text-slate-300">
                      {{ t('app-onboarding-choice-real-subtitle') }} <span class="font-mono">{{ createdApp.app_id }}</span>.
                    </span>
                  </span>
                  <IconArrowRight class="mt-1 h-5 w-5 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-primary-500" />
                </div>
              </button>

              <button
                class="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:cursor-wait disabled:opacity-70 dark:border-white/15 dark:bg-slate-950/90 dark:hover:border-emerald-400/60 dark:hover:bg-emerald-400/10"
                :disabled="isSeedingDemo"
                @click="seedDemoData"
              >
                <div class="flex items-start gap-4">
                  <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white">
                    <IconPackage class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="text-sm font-semibold uppercase text-emerald-600 dark:text-emerald-300">
                      {{ t('app-onboarding-choice-demo-badge') }}
                    </span>
                    <span class="mt-2 block text-xl font-semibold text-slate-950 dark:text-white">
                      {{ t('app-onboarding-choice-demo-title') }}
                    </span>
                    <span class="mt-2 block text-sm leading-6 text-slate-600 dark:text-slate-300">
                      {{ t('app-onboarding-choice-demo-subtitle') }}
                    </span>
                    <span v-if="isSeedingDemo" class="mt-4 inline-flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                      <IconLoader class="h-4 w-4 animate-spin" />
                      {{ t('app-onboarding-choice-demo-loading') }}
                    </span>
                  </span>
                </div>
              </button>
            </div>
          </div>
        </div>

        <div v-else-if="!props.preOrg && flowStep === 'install' && createdApp">
          <div class="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                  {{ t('app-onboarding-install-badge') }}
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ t('app-onboarding-install-title') }}
                </h2>
                <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {{ t('app-onboarding-install-subtitle') }}
                </p>
              </div>
              <button class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" @click="openDashboard">
                {{ t('app-onboarding-open-dashboard') }}
              </button>
            </div>

            <div
              class="group relative cursor-pointer rounded-2xl bg-slate-950 p-5 pr-14 ring-1 ring-white/10 transition hover:ring-white/20"
              role="button"
              tabindex="0"
              :aria-label="t('app-onboarding-command-copy')"
              @click="copyCliCommand"
              @keydown.enter.prevent="copyCliCommand"
              @keydown.space.prevent="copyCliCommand"
            >
              <code class="block whitespace-pre-wrap break-all text-sm">
                <span class="text-slate-500">npx</span>
                <span class="text-sky-300"> @capgo/cli@latest</span>
                <span class="mr-1 font-bold text-violet-300"> {{ cliSubcommand }}</span>
                <span class="text-emerald-300"> {{ apiKey ?? '[APIKEY]' }}</span>
                <template v-for="(arg, index) in cliCommandArgs" :key="`${arg}-${index}`">
                  <span :class="index % 2 === 0 ? 'text-amber-300' : 'text-cyan-300'"> {{ arg }}</span>
                </template>
              </code>
              <IconCopy class="absolute right-4 top-4 h-5 w-5 text-muted-blue-300 transition group-hover:text-white" />
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
                <button class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" @click="copyAiInstructions">
                  <IconCopy class="h-4 w-4" />
                  {{ t('app-onboarding-ai-help-button') }}
                </button>
              </div>
            </div>

            <div class="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" @click="flowStep = 'choice'">
                {{ t('button-back') }}
              </button>
              <button class="d-btn min-h-11" :class="whiteCardPrimaryButtonClass()" @click="openDashboard">
                {{ t('app-onboarding-install-later') }}
                <IconArrowRight class="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

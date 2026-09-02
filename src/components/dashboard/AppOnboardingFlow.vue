<script setup lang="ts">
import type { Database, Json } from '~/types/supabase.types'
import type {
  OnboardingAnalyticsStep,
  OnboardingCopyEvent,
  OnboardingDetailsEvent,
  OnboardingDetailsEventProperties,
  OnboardingIntent,
  OnboardingInteractionEvent,
  OnboardingInteractionProperties,
  OnboardingStepCompletionProperties,
} from '~/utils/onboardingProgressAnalytics'
import type { OnboardingPersistOptions, OnboardingPersistResult } from '~/utils/onboardingProgressPersistence'
import type { UserOnboardingStatus } from '~/utils/userOnboardingProgress'
import mime from 'mime'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCopy from '~icons/ion/copy-outline'
import IconAppWindow from '~icons/lucide/app-window'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconCheck from '~icons/lucide/check'
import IconChevronDown from '~icons/lucide/chevron-down'
import IconChevronUp from '~icons/lucide/chevron-up'
import IconCompass from '~icons/lucide/compass'
import IconGlobe from '~icons/lucide/globe-2'
import IconInfo from '~icons/lucide/info'
import IconLayers from '~icons/lucide/layers'
import IconLoader from '~icons/lucide/loader-2'
import IconPackage from '~icons/lucide/package'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconSmartphone from '~icons/lucide/smartphone'
import IconSparkles from '~icons/lucide/sparkles'
import IconStore from '~icons/lucide/store'
import IconTerminal from '~icons/lucide/terminal'
import IconTrash from '~icons/lucide/trash-2'
import IconUsers from '~icons/lucide/users-round'
import { preserveAdminDashboardMinimize } from '~/services/adminDashboardPreferences'
import { createDefaultApiKey, findUsablePlainApiKey } from '~/services/apikeys'
import { getCapgoApiErrorCode, invokeCapgoApi } from '~/services/capgoApi'
import { sendOnboardingEvent } from '~/services/onboardingTracking'
import { uploadOrgLogoFile } from '~/services/photos'
import { createSignedImageUrl, getImmediateImageUrl } from '~/services/storage'
import { getLocalConfig, isLocal, useSupabase } from '~/services/supabase'
import {
  MAX_USER_ONBOARDING_WRITE_ATTEMPTS,
  mergeUserOnboardingProgress,
  replaceUserOnboardingIfUnchanged,
  serializeUserOnboardingWrite,
} from '~/services/userOnboardingWriteQueue'
import { useDashboardAppsStore } from '~/stores/dashboardApps'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { isValidAppId } from '~/utils/appId'
import { useBeforeUnloadWarning } from '~/utils/beforeUnloadWarning'
import {
  buildAlternativeAppIds,
  createOnboardingAppWithFallbackIds,
} from '~/utils/onboardingAppCreateHelpers'
import {
  clearOnboardingAppDraft,
  loadOnboardingAppDraft,
} from '~/utils/onboardingAppDraft'
import { onboardingPrimaryButtonClass, onboardingSecondaryButtonClass } from '~/utils/onboardingButtonClasses'
import {
  createOnboardingDetailsFieldDebouncer,
  createOnboardingProgressTracker,
  createOnboardingTelemetryIdentity,
  resolveOnboardingAppIconSource,
} from '~/utils/onboardingProgressAnalytics'
import { createOnboardingProgressPersistence, shouldInitializeOnboardingProgressTracking } from '~/utils/onboardingProgressPersistence'
import { allowOnboardingDashboardExploration, ONBOARDING_DASHBOARD_EXPLORED_EVENT } from '~/utils/onboardingRedirect'
import { slugifyOnboardingSegment } from '~/utils/onboardingSlug'
import {
  buildUserOnboardingProgress,
  clampResumableOnboardingStep,
  parseUserOnboardingProgress,
  shouldPromptOnboardingResume,
} from '~/utils/userOnboardingProgress'
import AppOnboardingIconInput from './AppOnboardingIconInput.vue'
import AppOnboardingWelcome from './AppOnboardingWelcome.vue'
import OrganizationOnboardingInvite from './OrganizationOnboardingInvite.vue'

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
const dashboardAppsStore = useDashboardAppsStore()
const onboardingUserId = computed(() => main.user?.id ?? main.auth?.id ?? null)
const config = getLocalConfig()
const onboardingTelemetry = createOnboardingTelemetryIdentity({ flow: props.preOrg ? 'pre_org' : 'existing_org', supaHost: config.supaHost })
const STORE_ICON_FETCH_TIMEOUT_MS = 10_000
const WELCOME_CANVAS_MEDIA_QUERY = '(min-width: 640px) and (min-height: 640px)'
const removeBeforeUnloadWarning = useBeforeUnloadWarning(Boolean(props.preOrg))

type AppRow = Omit<Database['public']['Tables']['apps']['Row'], 'onboarding'> & {
  onboarding?: unknown
}
type StandardFlowStep = 'details' | 'choice' | 'install' | 'setup'
type PreOrgFlowStep = 'intent' | 'details' | 'organization' | 'setup'
type OnboardingFlowStep = StandardFlowStep | PreOrgFlowStep
type AppDetailsStep = 'name' | 'app_id' | 'icon'
type AppDetailsAnalyticsStep = 'app_name' | 'app_id' | 'app_icon'

const APP_DETAILS_ANALYTICS_STEPS: Record<AppDetailsStep, AppDetailsAnalyticsStep> = {
  name: 'app_name',
  app_id: 'app_id',
  icon: 'app_icon',
}

interface UserCountStop {
  value: number
  label: string
  planName: string
  startingOut?: boolean
}

interface OrganizationWebsitePreview {
  hostname: string
  icon: string | null
  name: string
  website: string
}

const isLoading = ref(true)
const isHydratingOnboarding = ref(true)
const welcomeCanvasEligible = ref(false)
const welcomePending = ref(false)
const showPreOrgWelcome = computed(() => props.preOrg && welcomeCanvasEligible.value && welcomePending.value)
const isSubmitting = ref(false)
const isImportingStore = ref(false)
const isImportingStoreIcon = ref(false)
const isResumeIconLoading = ref(false)
const isSeedingDemo = ref(false)
const isCliCommandVisible = ref(false)
const apiKey = ref<string | null>(null)
const createdApp = ref<AppRow | null>(null)
let pendingGettingStartedAppId: string | null = null
const preOrgCreatedOrganizationId = ref<string | null>(null)
const preOrgShouldInvite = ref(false)
const flowStep = ref<OnboardingFlowStep>('details')
const appDetailsStep = ref<AppDetailsStep>('name')
const showLanguageSelector = computed(() => props.preOrg && !createdApp.value)
const selectedIconFile = ref<File | null>(null)
const localIconPreview = ref('')
const storeIconPreview = ref('')
const storeAppNamePreview = ref('')
const useImportedStoreIcon = ref(false)
const existingApp = ref<boolean | null>(null)
const existingAppSetup = ref<'import' | 'manual' | null>(null)
const appName = ref('')
const storeUrl = ref('')
const iconStoreUrl = ref('')
const importedStoreAppId = ref('')
const manualAppId = ref('')
const appIdSuggestions = ref<string[]>([])
const appIdFeedback = ref('')
const hasEditedAppId = ref(false)
const selectedIntent = ref<OnboardingIntent | null>(null)
const orgNameInput = ref('')
const hasEditedOrgName = ref(false)
const estimatedUsersIndex = ref<number | null>(null)
const isStoreImportOpen = ref(false)
const isStoreIconImportOpen = ref(false)
const isAppDetailsNavigationPending = computed(() => (
  isSubmitting.value || isImportingStore.value || isImportingStoreIcon.value
))
const isOrganizationImportOpen = ref(false)
const isImportingOrganizationWebsite = ref(false)
const organizationWebsiteInput = ref('')
const websitePreview = ref<OrganizationWebsitePreview | null>(null)
const showOrganizationInvite = ref(false)

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
const startingOutUserCountStop: UserCountStop = {
  value: 0,
  label: '0',
  planName: 'Solo',
  startingOut: true,
}
const planNameOrder = ['Solo', 'Maker', 'Team', 'Enterprise'] as const

const localCommand = isLocal(config.supaHost) ? ` --supa-host ${config.supaHost} --supa-anon ${config.supaKey}` : ''
const usesBuilderSetupCommand = computed(() => selectedIntent.value === 'builder')
const cliSubcommand = computed(() => usesBuilderSetupCommand.value ? 'build init' : 'i')
const cliCommand = computed(() => {
  const key = apiKey.value
  if (!key)
    return ''

  if (usesBuilderSetupCommand.value)
    return `npx @capgo/cli@latest build init -a ${key}${localCommand}`

  return `npx @capgo/cli@latest i ${key}${localCommand}`
})
const cliCommandArgs = computed(() => {
  const args: string[] = []

  if (usesBuilderSetupCommand.value && apiKey.value)
    args.push('-a', apiKey.value)

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
  return value === 'choice' ? value : null
})
const canUseStoreImportPreview = computed(() => useImportedStoreIcon.value && !!storeIconPreview.value)
const iconPreview = computed(() => localIconPreview.value || (canUseStoreImportPreview.value ? storeIconPreview.value : '') || '')
const hasImportedStoreMetadata = computed(() => existingAppSetup.value === 'import' && !!(importedStoreAppId.value || storeIconPreview.value || storeAppNamePreview.value))
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
const hasProvidedAppId = computed(() => Boolean(manualAppId.value.trim() || importedStoreAppId.value.trim()))
const appDetailsPrimaryActionLabel = computed(() => {
  if (appDetailsStep.value === 'icon')
    return iconPreview.value ? t('app-onboarding-continue') : t('app-onboarding-skip-icon')

  if (appDetailsStep.value === 'app_id' && !hasProvidedAppId.value)
    return t('app-onboarding-skip-app-id')

  return t('app-onboarding-continue')
})
const appNameInitial = computed(() => Array.from(appName.value.trim())[0]?.toLocaleUpperCase() ?? '')
const selectedAppIdSource = computed<NonNullable<OnboardingDetailsEventProperties['app_id_source']>>(() => {
  if (manualAppId.value.trim())
    return 'manual'
  if (existingAppSetup.value === 'import' && importedStoreAppId.value.trim())
    return 'store'
  return 'generated'
})
const selectedAppIconSource = computed<NonNullable<OnboardingDetailsEventProperties['icon_source']>>(() => {
  return resolveOnboardingAppIconSource({
    canUseStoreImportPreview: canUseStoreImportPreview.value,
    hasSelectedIconFile: Boolean(selectedIconFile.value),
    localIconPreview: localIconPreview.value,
  })
})
const appOnboardingSteps = computed<Array<{ id: OnboardingFlowStep, label: string }>>(() => {
  if (props.preOrg) {
    return [
      { id: 'intent', label: t('unified-onboarding-step-intent') },
      { id: 'details', label: t('app-onboarding-step-details') },
      { id: 'organization', label: t('unified-onboarding-step-organization') },
    ]
  }
  return [
    { id: 'details', label: t('app-onboarding-step-details') },
    { id: 'choice', label: t('app-onboarding-step-choice') },
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
  return [
    startingOutUserCountStop,
    ...(planStops.length === planNameOrder.length ? planStops : fallbackUserCountStops),
  ]
})
const selectedUserCountStop = computed<UserCountStop | null>(() => estimatedUsersIndex.value === null ? null : userCountStops.value[Math.min(estimatedUsersIndex.value, userCountStops.value.length - 1)] ?? null)
const canCreatePreOrgOrganization = computed(() => {
  if (!orgNameInput.value.trim() || isImportingOrganizationWebsite.value)
    return false
  return selectedUserCountStop.value !== null
})

let progressTracker: ReturnType<typeof createOnboardingProgressTracker> | null = null
let pendingVisibilityChanges: Array<{ state: DocumentVisibilityState, occurredAt: number }> = []
let persistFieldsTimer: ReturnType<typeof setTimeout> | undefined
let pendingDashboardExplored = false
let onboardingFlowDisposed = false
let onboardingInitialPersistInFlight = false
const onboardingProgressPersistence = createOnboardingProgressPersistence({
  write: writeOnboardingProgress,
  onError: error => console.error('Failed to persist onboarding progress', error),
})

function trackDetailsEvent(name: OnboardingDetailsEvent, details: OnboardingDetailsEventProperties = {}) {
  if (props.preOrg)
    progressTracker?.trackDetailsEvent(name, analyticsStepFor('details'), details)
}

function trackOrganizationEvent(
  name: OnboardingInteractionEvent,
  details: OnboardingInteractionProperties = {},
) {
  progressTracker?.trackStepEvent(name, 'organization', details)
}

const detailsFieldTracker = createOnboardingDetailsFieldDebouncer((name, step, details) => {
  if (props.preOrg)
    progressTracker?.trackDetailsEvent(name, step, details)
})

function analyticsStepFor(flow: OnboardingFlowStep, detailsStep = appDetailsStep.value): OnboardingAnalyticsStep {
  if (flow === 'details')
    return APP_DETAILS_ANALYTICS_STEPS[detailsStep]
  return flow
}

function trackOnboardingVisibilityChange() {
  const visibilityChange = { state: document.visibilityState, occurredAt: Date.now() }
  if (!progressTracker) {
    if (isHydratingOnboarding.value || onboardingInitialPersistInFlight)
      pendingVisibilityChanges.push(visibilityChange)
    return
  }
  progressTracker.trackVisibilityChange(visibilityChange.state, visibilityChange.occurredAt)
}

function initializeProgressTracking(resumed: boolean) {
  const initialStep: OnboardingAnalyticsStep = showPreOrgWelcome.value ? 'welcome' : analyticsStepFor(flowStep.value)
  const trackedSteps = appOnboardingSteps.value.flatMap<OnboardingAnalyticsStep>((step) => {
    if (step.id === 'details')
      return Object.values(APP_DETAILS_ANALYTICS_STEPS)
    return [step.id]
  })
  if (initialStep === 'welcome')
    trackedSteps.unshift('welcome')

  progressTracker = createOnboardingProgressTracker({
    flow: props.preOrg ? 'pre_org' : 'existing_org',
    resumed,
    steps: trackedSteps,
    supaHost: config.supaHost,
    onboardingAttemptId: onboardingTelemetry.attemptId,
    onboardingRunId: onboardingTelemetry.runId,
  })
  progressTracker.viewStep(initialStep)
  for (const visibilityChange of pendingVisibilityChanges)
    progressTracker.trackVisibilityChange(visibilityChange.state, visibilityChange.occurredAt)
  pendingVisibilityChanges = []
  if (pendingDashboardExplored)
    trackDashboardExplored()
}

function completeAndViewStep(nextStep: OnboardingFlowStep, completionProperties: OnboardingStepCompletionProperties = {}) {
  const previousStep = flowStep.value
  if (previousStep === nextStep)
    return

  const previousAnalyticsStep = analyticsStepFor(previousStep)
  const nextAnalyticsStep = analyticsStepFor(nextStep)
  progressTracker?.completeStep(previousAnalyticsStep, {
    ...completionProperties,
    nextStep: nextAnalyticsStep,
  })
  flowStep.value = nextStep
  progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)
  void persistOnboardingProgress()
}

function viewPreviousStep(nextStep: OnboardingFlowStep) {
  const previousStep = flowStep.value
  if (previousStep === nextStep)
    return

  const previousAnalyticsStep = analyticsStepFor(previousStep)
  const nextAnalyticsStep = analyticsStepFor(nextStep)
  flowStep.value = nextStep
  progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)
  void persistOnboardingProgress()
}

function snapshotOnboardingProgress(status: UserOnboardingStatus = 'in_progress') {
  const flow = props.preOrg ? 'pre_org' : 'existing_org'
  const telemetry = onboardingTelemetry.getProgressMetadata()
  return buildUserOnboardingProgress({
    status,
    step: clampResumableOnboardingStep(flowStep.value, flow),
    flow,
    intent: selectedIntent.value,
    detailsStep: appDetailsStep.value,
    appName: appName.value,
    appId: selectedAppIdSource.value === 'generated' ? '' : generatedAppId.value,
    existingApp: existingApp.value,
    existingAppSetup: existingAppSetup.value,
    storeUrl: storeUrl.value,
    importedStoreAppId: importedStoreAppId.value,
    orgName: orgNameInput.value,
    estimatedUsersIndex: estimatedUsersIndex.value,
    onboardingAttemptId: telemetry.onboardingAttemptId,
    lastRunId: telemetry.lastRunId,
  })
}

async function persistOnboardingProgress(
  status: UserOnboardingStatus = 'in_progress',
  options: OnboardingPersistOptions = {},
) {
  return onboardingProgressPersistence.persist(status, options)
}

function schedulePersistOnboardingProgress() {
  if (isHydratingOnboarding.value || onboardingProgressPersistence.isBlocked() || onboardingProgressPersistence.isAborted())
    return
  window.clearTimeout(persistFieldsTimer)
  persistFieldsTimer = setTimeout(() => {
    void persistOnboardingProgress()
  }, 400)
}

async function writeOnboardingProgress(
  status: UserOnboardingStatus,
  options: OnboardingPersistOptions,
) {
  const userId = onboardingUserId.value
  if (!userId || isHydratingOnboarding.value)
    return 'skipped'

  const authGeneration = main.authGeneration
  return serializeUserOnboardingWrite(userId, async () => {
    if (
      (onboardingFlowDisposed && !options.allowDisposed)
      || onboardingUserId.value !== userId
      || main.authGeneration !== authGeneration
      || isHydratingOnboarding.value
    ) {
      return 'skipped'
    }

    if (main.user?.id !== userId)
      return 'skipped'

    const progress = snapshotOnboardingProgress(status)
    let currentOnboarding = main.user.onboarding
    let latestProfile = main.user

    for (let attempt = 0; attempt < MAX_USER_ONBOARDING_WRITE_ATTEMPTS; attempt++) {
      if (
        onboardingUserId.value !== userId
        || main.authGeneration !== authGeneration
        || (onboardingFlowDisposed && !options.allowDisposed)
      ) {
        return 'skipped'
      }

      const current = parseUserOnboardingProgress(currentOnboarding)
      if (current?.status === 'completed' && status !== 'completed')
        return 'skipped'

      const onboardingWithPreferences = preserveAdminDashboardMinimize(
        progress as unknown as Json,
        currentOnboarding,
        main.isAdmin,
      )
      const onboarding = mergeUserOnboardingProgress(
        onboardingWithPreferences,
        currentOnboarding,
      )
      const { data, error } = await replaceUserOnboardingIfUnchanged(
        userId,
        currentOnboarding,
        onboarding,
      )

      if (error) {
        console.error('Failed to persist onboarding progress', error)
        return 'retryable_failure'
      }

      if (data) {
        if (main.user?.id === userId && main.authGeneration === authGeneration)
          main.user = { ...data, image_url: main.user.image_url }
        return 'persisted'
      }

      const { data: latest, error: latestError } = await supabase
        .from('users')
        .select()
        .eq('id', userId)
        .maybeSingle()
      if (latestError) {
        console.error('Failed to refresh onboarding progress snapshot', latestError)
        return 'retryable_failure'
      }
      if (!latest)
        return status === 'completed' ? 'skipped' : 'conflict'

      latestProfile = latest
      currentOnboarding = latest.onboarding
    }

    if (main.user?.id === userId && main.authGeneration === authGeneration)
      main.user = { ...latestProfile, image_url: main.user.image_url }
    return 'conflict'
  })
}

function resetOnboardingForm() {
  flowStep.value = props.preOrg ? 'intent' : 'details'
  appDetailsStep.value = 'name'
  selectedIntent.value = null
  existingApp.value = props.preOrg ? true : null
  existingAppSetup.value = props.preOrg ? 'manual' : null
  appName.value = ''
  manualAppId.value = ''
  hasEditedAppId.value = false
  orgNameInput.value = ''
  hasEditedOrgName.value = false
  estimatedUsersIndex.value = null
  isStoreImportOpen.value = false
  isStoreIconImportOpen.value = false
  createdApp.value = null
  preOrgCreatedOrganizationId.value = null
  preOrgShouldInvite.value = false
  selectedIconFile.value = null
  if (localIconPreview.value.startsWith('blob:'))
    URL.revokeObjectURL(localIconPreview.value)
  localIconPreview.value = ''
  iconStoreUrl.value = ''
  resetStoreImportState()
}

function showWelcomeOnDesktop() {
  welcomePending.value = Boolean(props.preOrg && welcomeCanvasEligible.value)
}

function continueFromWelcome() {
  const nextStep = flowStep.value
  const nextAnalyticsStep = analyticsStepFor(nextStep)
  progressTracker?.completeStep('welcome', { nextStep: nextAnalyticsStep })
  progressTracker?.viewStep(nextAnalyticsStep, 'welcome')
  welcomePending.value = false
}

function applyOnboardingProgress(progress: ReturnType<typeof parseUserOnboardingProgress>) {
  if (!progress)
    return

  const flow = props.preOrg ? 'pre_org' : 'existing_org'
  flowStep.value = clampResumableOnboardingStep(progress.step, flow)
  if (progress.details_step)
    appDetailsStep.value = progress.details_step
  if (progress.intent)
    selectedIntent.value = progress.intent
  if (progress.existing_app === true || progress.existing_app === false)
    existingApp.value = progress.existing_app
  if (progress.existing_app_setup === 'import' || progress.existing_app_setup === 'manual')
    existingAppSetup.value = progress.existing_app_setup
  if (progress.app_name)
    appName.value = progress.app_name
  if (progress.app_id) {
    manualAppId.value = progress.app_id
    hasEditedAppId.value = true
  }
  if (progress.store_url)
    storeUrl.value = progress.store_url
  if (progress.imported_store_app_id)
    importedStoreAppId.value = progress.imported_store_app_id
  if (progress.org_name) {
    orgNameInput.value = progress.org_name
    hasEditedOrgName.value = true
  }
  if (typeof progress.estimated_users_index === 'number')
    estimatedUsersIndex.value = progress.estimated_users_index
}

function applyDefaultPreOrgDetails() {
  const restoredDraft = restoreDraftState()
  if (!restoredDraft || existingAppSetup.value !== 'import') {
    existingApp.value = true
    existingAppSetup.value = 'manual'
  }
  flowStep.value = 'intent'
}

async function maybeResumeSavedOnboarding() {
  const flow = props.preOrg ? 'pre_org' : 'existing_org'
  const saved = parseUserOnboardingProgress(main.user?.onboarding)

  if (!shouldPromptOnboardingResume(saved, flow) || !saved) {
    if (saved?.status === 'in_progress' && saved.flow === flow) {
      applyOnboardingProgress(saved)
    }
    else {
      applyDefaultPreOrgDetails()
    }
    showWelcomeOnDesktop()
    return false
  }

  const resumableStep = clampResumableOnboardingStep(saved.step, flow)
  onboardingTelemetry.prepareResumeCandidate({
    onboardingAttemptId: saved.onboarding_attempt_id,
    lastRunId: saved.last_run_id,
    savedStep: resumableStep,
    steps: appOnboardingSteps.value.map(step => step.id),
  })
  dialogStore.openDialog({
    title: t('onboarding-resume-title'),
    description: t('onboarding-resume-description'),
    preventAccidentalClose: true,
    buttons: [
      { text: t('onboarding-resume-restart'), id: 'onboarding-resume-restart', role: 'secondary' },
      { text: t('onboarding-resume-continue'), id: 'onboarding-resume-continue', role: 'primary' },
    ],
  })
  onboardingTelemetry.recordResumeDialogViewed()
  await dialogStore.onDialogDismiss()

  if (onboardingFlowDisposed)
    return null

  if (dialogStore.lastButtonRole === 'onboarding-resume-restart') {
    onboardingTelemetry.recordResumeRestarted()
    resetOnboardingForm()
    existingApp.value = true
    existingAppSetup.value = 'manual'
    showWelcomeOnDesktop()
    return false
  }

  if (dialogStore.lastButtonRole !== 'onboarding-resume-continue')
    return null

  onboardingTelemetry.recordResumeContinued()
  applyOnboardingProgress(saved)
  return true
}

function whiteCardToggleButtonClass(active: boolean) {
  return active
    ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 hover:border-primary-500 hover:bg-slate-100 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30 dark:hover:bg-primary-500/30'
    : 'border-slate-200 bg-white text-slate-700 hover:border-primary-500/40 hover:bg-slate-50 hover:text-slate-950 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900 dark:hover:text-white'
}

function whiteCardSecondaryButtonClass() {
  return onboardingSecondaryButtonClass
}

function whiteCardPrimaryButtonClass() {
  return onboardingPrimaryButtonClass
}

function formatUserCount(value: number, plus = false) {
  if (value >= 1_000_000)
    return plus ? '1M+' : '1M'
  if (value >= 1000)
    return `${value / 1000}K`
  return String(value)
}
function getUserCountStopTitle(stop: UserCountStop) {
  if (stop.startingOut)
    return t('organization-onboarding-starting-out')
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
let storeIconImportRun = 0
function cancelPendingStoreImport() {
  storeImportRun += 1
  isImportingStore.value = false
}

function resetStoreImportState() {
  cancelPendingStoreImport()
  cancelPendingStoreIconImport()
  storeUrl.value = ''
  iconStoreUrl.value = ''
  storeIconPreview.value = ''
  storeAppNamePreview.value = ''
  useImportedStoreIcon.value = false
  importedStoreAppId.value = ''
  isImportingStore.value = false
  isStoreImportOpen.value = false
  isStoreIconImportOpen.value = false
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

  const appId = createdApp.value?.app_id
  const existingKey = await findUsablePlainApiKey(supabase, userId, currentOrg.value?.gid, appId)
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
    appId,
  })
  if (createError)
    throw createError

  apiKey.value = typeof data?.key === 'string'
    ? data.key
    : await findUsablePlainApiKey(supabase, claimsUserId, currentOrg.value?.gid, appId)
}

let apiKeyLoadingPromise: Promise<void> | null = null
function loadApiKey() {
  if (apiKey.value)
    return Promise.resolve()

  apiKeyLoadingPromise ??= ensureApiKey().finally(() => {
    apiKeyLoadingPromise = null
  })
  return apiKeyLoadingPromise
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
  if (resumeStep.value === 'choice' && !props.preOrg) {
    flowStep.value = 'choice'
    return true
  }

  pendingGettingStartedAppId = data.app_id
  return true
}

async function importStoreMetadata() {
  const requestedUrl = storeUrl.value.trim()
  if (!requestedUrl)
    return

  cancelPendingStoreIconImport()
  existingApp.value = true
  existingAppSetup.value = 'import'
  trackDetailsEvent('onboarding_store_import_submitted')
  const requestedRun = ++storeImportRun
  isImportingStore.value = true
  try {
    const { data, error } = await invokeCapgoApi('app/store-metadata', {
      method: 'POST',
      body: { url: requestedUrl },
    })

    if (requestedRun !== storeImportRun || existingAppSetup.value !== 'import' || storeUrl.value.trim() !== requestedUrl)
      return

    if (error)
      throw error

    storeAppNamePreview.value = typeof data?.name === 'string' ? data.name.trim() : ''
    if (storeAppNamePreview.value) {
      if (!appName.value.trim())
        appName.value = storeAppNamePreview.value
    }

    let importedIcon = ''
    if (typeof data?.icon_data_url === 'string' && data.icon_data_url.trim())
      importedIcon = data.icon_data_url.trim()
    else if (typeof data?.icon_url === 'string' && data.icon_url.trim())
      importedIcon = data.icon_url.trim()
    storeIconPreview.value = importedIcon
    if (importedIcon) {
      if (!localIconPreview.value)
        useImportedStoreIcon.value = true
    }
    else {
      useImportedStoreIcon.value = false
    }

    importedStoreAppId.value = typeof data?.app_id === 'string' ? data.app_id.trim() : ''

    if (props.preOrg)
      existingApp.value = true

    trackDetailsEvent('onboarding_store_import_succeeded')
  }
  catch (error) {
    if (requestedRun !== storeImportRun || existingAppSetup.value !== 'import' || storeUrl.value.trim() !== requestedUrl)
      return

    console.error('Cannot import store metadata', error)
    trackDetailsEvent('onboarding_store_import_failed')
    toast.error(t('app-onboarding-toast-store-metadata-error'))
  }
  finally {
    if (requestedRun === storeImportRun)
      isImportingStore.value = false
  }
}

function cancelPendingStoreIconImport() {
  storeIconImportRun += 1
  isImportingStoreIcon.value = false
}

async function importStoreIcon() {
  const requestedUrl = iconStoreUrl.value.trim()
  if (!requestedUrl)
    return

  cancelPendingStoreImport()
  trackDetailsEvent('onboarding_store_icon_import_submitted')
  const requestedRun = ++storeIconImportRun
  isImportingStoreIcon.value = true
  try {
    const { data, error } = await invokeCapgoApi('app/store-metadata', {
      method: 'POST',
      body: { url: requestedUrl },
    })

    if (requestedRun !== storeIconImportRun || iconStoreUrl.value.trim() !== requestedUrl)
      return
    if (error)
      throw error

    let importedIcon = ''
    if (typeof data?.icon_data_url === 'string' && data.icon_data_url.trim())
      importedIcon = data.icon_data_url.trim()
    else if (typeof data?.icon_url === 'string' && data.icon_url.trim())
      importedIcon = data.icon_url.trim()
    if (!importedIcon)
      throw new Error('Store metadata did not include an app icon')

    storeIconPreview.value = importedIcon
    storeAppNamePreview.value = typeof data?.name === 'string' && data.name.trim()
      ? data.name.trim()
      : appName.value.trim()
    selectImportedIcon(false)
    isStoreIconImportOpen.value = false
    trackDetailsEvent('onboarding_store_icon_import_succeeded')
  }
  catch (error) {
    if (requestedRun !== storeIconImportRun || iconStoreUrl.value.trim() !== requestedUrl)
      return
    console.error('Cannot import store icon', error)
    trackDetailsEvent('onboarding_store_icon_import_failed')
    toast.error(t('app-onboarding-toast-store-icon-error'))
  }
  finally {
    if (requestedRun === storeIconImportRun)
      isImportingStoreIcon.value = false
  }
}

function toggleStoreImport() {
  isStoreImportOpen.value = !isStoreImportOpen.value
  trackDetailsEvent(isStoreImportOpen.value ? 'onboarding_store_import_shown' : 'onboarding_store_import_hidden')
}

function toggleStoreIconImport() {
  isStoreIconImportOpen.value = !isStoreIconImportOpen.value
  trackDetailsEvent(isStoreIconImportOpen.value ? 'onboarding_store_icon_import_shown' : 'onboarding_store_icon_import_hidden')
}

function toggleOrganizationWebsiteImport() {
  isOrganizationImportOpen.value = !isOrganizationImportOpen.value
  if (isOrganizationImportOpen.value)
    trackOrganizationEvent('onboarding_organization_import_opened')
}

async function importOrganizationWebsite() {
  let website = organizationWebsiteInput.value.trim()
  if (!website) {
    toast.error(t('organization-onboarding-website-invalid'))
    return
  }

  try {
    const normalizedWebsite = /^https?:\/\//i.test(website) ? website : `https://${website}`
    website = new URL(normalizedWebsite).toString()
  }
  catch {
    toast.error(t('organization-onboarding-website-invalid'))
    return
  }

  isImportingOrganizationWebsite.value = true
  trackOrganizationEvent('onboarding_organization_import_submitted')
  try {
    const { data, error } = await invokeCapgoApi('private/website_preview', {
      body: { website },
    })
    if (error || !data) {
      console.error('Failed to import organization website', error)
      toast.error(t('organization-onboarding-website-fetch-failed'))
      trackOrganizationEvent('onboarding_organization_import_failed')
      return
    }

    websitePreview.value = data as OrganizationWebsitePreview
    if (websitePreview.value.name) {
      orgNameInput.value = websitePreview.value.name
      hasEditedOrgName.value = true
    }
    trackOrganizationEvent('onboarding_organization_import_succeeded')
  }
  catch (error) {
    console.error('Failed to import organization website', error)
    toast.error(t('organization-onboarding-website-fetch-failed'))
    trackOrganizationEvent('onboarding_organization_import_failed')
  }
  finally {
    isImportingOrganizationWebsite.value = false
  }
}

function deleteImportedOrganizationDetails() {
  websitePreview.value = null
  organizationWebsiteInput.value = ''
  isOrganizationImportOpen.value = true
}

async function uploadImportedOrganizationLogo(orgId: string) {
  const icon = websitePreview.value?.icon
  if (!icon)
    return

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), STORE_ICON_FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(icon, { signal: controller.signal })
    }
    finally {
      clearTimeout(timeoutId)
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!response.ok || !contentType.startsWith('image/'))
      throw new Error('Imported organization logo is not an image')
    const extension = mime.getExtension(contentType) ?? 'png'
    await uploadOrgLogoFile(orgId, await response.blob(), `${websitePreview.value?.hostname || 'website-logo'}.${extension}`)
  }
  catch (error) {
    console.error('Failed to upload imported organization logo', error)
    toast.error(t('organization-onboarding-imported-logo-failed'))
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
  if (file)
    cancelPendingStoreIconImport()
  if (localIconPreview.value.startsWith('blob:'))
    URL.revokeObjectURL(localIconPreview.value)
  localIconPreview.value = file ? URL.createObjectURL(file) : ''
  if (file)
    useImportedStoreIcon.value = false
  isResumeIconLoading.value = false
  if (file)
    trackDetailsEvent('onboarding_app_icon_picked', { icon_source: 'file' })
}

function clearLocalIconSelection() {
  if (localIconPreview.value.startsWith('blob:'))
    URL.revokeObjectURL(localIconPreview.value)
  selectedIconFile.value = null
  localIconPreview.value = ''
}

function selectImportedIcon(cancelPendingImport = true) {
  if (cancelPendingImport)
    cancelPendingStoreIconImport()
  clearLocalIconSelection()
  useImportedStoreIcon.value = !!storeIconPreview.value
  if (useImportedStoreIcon.value)
    trackDetailsEvent('onboarding_app_icon_import_selected', { icon_source: 'store' })
}

function removeSelectedIcon() {
  const removedIconSource = selectedAppIconSource.value
  cancelPendingStoreIconImport()
  clearLocalIconSelection()
  useImportedStoreIcon.value = false
  if (removedIconSource !== 'none')
    trackDetailsEvent('onboarding_app_icon_removed', { icon_source: removedIconSource })
}

function onIconPickerOpened() {
  trackDetailsEvent('onboarding_app_icon_picker_opened')
}

function onIconPickerOpenFailed() {
  trackDetailsEvent('onboarding_app_icon_picker_open_failed')
}

function onIconPickerClosedWithoutSelection() {
  trackDetailsEvent('onboarding_app_icon_picker_closed_without_selection')
}

function onAppNameInput(event: Event) {
  detailsFieldTracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name', (event.target as HTMLInputElement).value)
}

function onAppIdInput(event: Event) {
  hasEditedAppId.value = true
  manualAppId.value = (event.target as HTMLInputElement).value
  appIdFeedback.value = ''
  appIdSuggestions.value = []
  detailsFieldTracker.schedule('onboarding_app_id_entered', 'app_id', 'app_id', manualAppId.value)
}

function onStoreUrlInput(event: Event) {
  detailsFieldTracker.schedule('onboarding_store_url_entered', 'store_url', 'app_id', (event.target as HTMLInputElement).value)
}

function onIconStoreUrlInput(event: Event) {
  detailsFieldTracker.schedule('onboarding_store_icon_url_entered', 'icon_store_url', 'app_icon', (event.target as HTMLInputElement).value)
}

function openAppIdHelp() {
  trackDetailsEvent('onboarding_app_id_help_opened')
  dialogStore.openDialog({
    title: t('app-onboarding-v2-appid-dialog-title'),
    description: t('app-onboarding-v2-appid-dialog-description'),
    buttons: [
      {
        text: t('close'),
        role: 'primary',
      },
    ],
  })
}

function applyAppIdSuggestion(suggestion: string) {
  hasEditedAppId.value = true
  manualAppId.value = suggestion
  appIdFeedback.value = ''
  appIdSuggestions.value = []
  trackDetailsEvent('onboarding_app_id_suggestion_selected', { app_id_source: 'manual' })
}

function completeAndViewAppDetailsStep(nextDetailsStep: AppDetailsStep, completionProperties: OnboardingStepCompletionProperties = {}) {
  const previousAnalyticsStep = analyticsStepFor('details')
  const nextAnalyticsStep = analyticsStepFor('details', nextDetailsStep)
  progressTracker?.completeStep(previousAnalyticsStep, { ...completionProperties, nextStep: nextAnalyticsStep })
  appDetailsStep.value = nextDetailsStep
  progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)
  schedulePersistOnboardingProgress()
}

function continueFromAppName() {
  if (!appName.value.trim()) {
    toast.error(t('app-onboarding-toast-name-required'))
    return
  }
  if (!props.preOrg && existingApp.value === null) {
    toast.error(t('app-onboarding-toast-existing-required'))
    return
  }

  completeAndViewAppDetailsStep('app_id', { appId: generatedAppId.value, appName: appName.value.trim() })
}

function continueFromAppId() {
  if (!ensureValidAppId())
    return

  completeAndViewAppDetailsStep('icon')
}

function skipAppId() {
  manualAppId.value = ''
  hasEditedAppId.value = false
  appIdFeedback.value = ''
  appIdSuggestions.value = []
  continueFromAppId()
}

function continueFromCurrentAppDetailsStep() {
  if (appDetailsStep.value === 'name') {
    continueFromAppName()
    return
  }
  if (appDetailsStep.value === 'app_id') {
    if (hasProvidedAppId.value)
      continueFromAppId()
    else
      skipAppId()
    return
  }
  finishAppDetails()
}

function viewPreviousAppDetailsStep() {
  const previousDetailsStep = appDetailsStep.value
  const previousAnalyticsStep = analyticsStepFor('details')
  appDetailsStep.value = previousDetailsStep === 'icon' ? 'app_id' : 'name'
  progressTracker?.viewStep(analyticsStepFor('details'), previousAnalyticsStep)
  schedulePersistOnboardingProgress()
}

function finishAppDetails() {
  if (props.preOrg && preOrgCreatedOrganizationId.value) {
    void completePreOrgAppCreation(preOrgCreatedOrganizationId.value, preOrgShouldInvite.value)
  }
  else if (props.preOrg) {
    continuePreOrgDetails()
  }
  else {
    void createAppRecord()
  }
}

function returnToAppIdAfterConflict() {
  const previousAnalyticsStep = analyticsStepFor(flowStep.value)
  flowStep.value = 'details'
  appDetailsStep.value = 'app_id'
  progressTracker?.viewStep('app_id', previousAnalyticsStep)
  schedulePersistOnboardingProgress()
}

async function uploadIcon(appId: string, iconSourceUrl?: string) {
  if (!currentOrg.value?.gid)
    return

  let fileToUpload = selectedIconFile.value
  const iconSource = selectedIconFile.value || (iconSourceUrl && iconSourceUrl === localIconPreview.value) ? 'file' : 'store'

  if (!fileToUpload && iconSourceUrl) {
    try {
      const parsedIconUrl = new URL(iconSourceUrl)
      const isRemoteImage = parsedIconUrl.protocol === 'https:'
      const isInlineImage = parsedIconUrl.protocol === 'data:' && iconSourceUrl.startsWith('data:image/')
      if (!isRemoteImage && !isInlineImage) {
        console.warn('Skipping unsupported icon URL', iconSourceUrl)
      }
      else {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), STORE_ICON_FETCH_TIMEOUT_MS)
        try {
          const response = await fetch(parsedIconUrl.toString(), { signal: controller.signal })
          if (!response.ok)
            throw new Error(`Icon request failed with status ${response.status}`)
          const blob = await response.blob()
          if (!blob.type.startsWith('image/'))
            throw new Error(`Icon response has unsupported content type: ${blob.type || 'unknown'}`)
          fileToUpload = new File([blob], 'store-icon.png', { type: blob.type })
        }
        finally {
          clearTimeout(timeoutId)
        }
      }
    }
    catch (error) {
      console.warn('Cannot fetch remote icon', error)
    }
  }

  if (!fileToUpload) {
    if (iconSourceUrl)
      trackDetailsEvent('onboarding_app_icon_upload_failed', { icon_source: iconSource })
    return
  }

  const iconPath = `org/${currentOrg.value.gid}/${appId}/icon`
  const { error: uploadError } = await supabase.storage
    .from('images')
    .upload(iconPath, fileToUpload, {
      upsert: true,
      contentType: fileToUpload.type || 'image/png',
    })

  if (uploadError) {
    console.error('Cannot upload app icon', uploadError)
    trackDetailsEvent('onboarding_app_icon_upload_failed', { icon_source: iconSource })
    return
  }

  const { error: appUpdateError } = await supabase
    .from('apps')
    .update({ icon_url: iconPath })
    .eq('app_id', appId)

  if (appUpdateError) {
    console.error('Cannot save app icon path', appUpdateError)
    trackDetailsEvent('onboarding_app_icon_upload_failed', { icon_source: iconSource })
    return
  }

  trackDetailsEvent('onboarding_app_icon_uploaded', { icon_source: iconSource })
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
  if (!hasEditedOrgName.value)
    orgNameInput.value = draft.appName.trim()
  manualAppId.value = draft.appId
  hasEditedAppId.value = true
  existingApp.value = draft.existingApp
  existingAppSetup.value = draft.existingAppSetup
  storeUrl.value = draft.storeUrl
  importedStoreAppId.value = draft.importedStoreAppId
  if (draft.storeIconDataUrl) {
    storeIconPreview.value = draft.storeIconDataUrl
    useImportedStoreIcon.value = !draft.iconDataUrl
  }
  if (draft.iconDataUrl)
    localIconPreview.value = draft.iconDataUrl
  return true
}

function continueFromIntent() {
  if (!selectedIntent.value) {
    toast.error(t('organization-onboarding-intent-required'))
    return
  }

  completeAndViewStep('details', { intent: selectedIntent.value })
}

function continuePreOrgDetails() {
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

  // Store publication is unrelated to whether the user already has a mobile project.
  existingApp.value = true

  completeAndViewStep('organization', {
    storeImportUsed: hasImportedStoreMetadata.value,
  })
}

async function createOrganizationAndApp() {
  if (!selectedIntent.value) {
    toast.error(t('organization-onboarding-intent-required'))
    return
  }

  const orgName = orgNameInput.value.trim()
  if (!orgName) {
    toast.error(t('org-name-required'))
    return
  }

  const selectedStop = selectedUserCountStop.value
  if (!selectedStop) {
    toast.error(t('organization-onboarding-user-scale-required'))
    return
  }
  const estimatedMau = selectedStop.value
  const shouldInvite = selectedStop.planName !== 'Solo'

  isSubmitting.value = true
  try {
    const { data, error } = await invokeCapgoApi('organization', {
      method: 'POST',
      body: {
        name: orgName,
        email: main.auth?.email ?? '',
        estimatedMau,
        intent: selectedIntent.value,
        startingOut: selectedStop.startingOut === true,
        website: websitePreview.value?.website,
      },
    })

    if (error || !data?.id) {
      console.error('Error creating organization during unified onboarding', error)
      const errorCode = await getCapgoApiErrorCode(error)
      toast.error(errorCode === '23505'
        ? t('org-with-this-name-exists')
        : t('cannot-create-org'))
      return
    }

    sendOnboardingEvent('onboarding_intent_selected', {
      intent: selectedIntent.value,
      estimated_mau: estimatedMau,
      org_id: data.id,
    })

    try {
      await organizationStore.fetchOrganizations()
      organizationStore.setCurrentOrganization(data.id)
    }
    catch (refreshError) {
      console.error('Failed to refresh organizations after unified onboarding create', refreshError)
      toast.error(t('organization-onboarding-refresh-failed'))
      return
    }

    preOrgCreatedOrganizationId.value = data.id
    preOrgShouldInvite.value = shouldInvite
    await completePreOrgAppCreation(data.id, shouldInvite)
  }
  finally {
    isSubmitting.value = false
  }
}

async function completePreOrgAppCreation(organizationId: string, shouldInvite: boolean) {
  await createAppRecord({ nextStep: 'organization' })

  if (!createdApp.value)
    return

  clearOnboardingAppDraft(onboardingUserId.value)
  await uploadImportedOrganizationLogo(organizationId)
  showOrganizationInvite.value = shouldInvite
  if (shouldInvite)
    trackOrganizationEvent('onboarding_organization_invite_viewed')

  removeBeforeUnloadWarning()

  if (!shouldInvite)
    await goToGettingStarted()
}

function onOrganizationInviteOpened() {
  trackOrganizationEvent('onboarding_organization_invite_opened')
}

function onOrganizationInviteSucceeded() {
  trackOrganizationEvent('onboarding_organization_invite_succeeded')
}

function continueFromOrganizationInvite(invitationCount: number) {
  if (!createdApp.value)
    return

  trackOrganizationEvent('onboarding_organization_invite_continued', {
    invitation_count: invitationCount,
  })
  showOrganizationInvite.value = false
  void goToGettingStarted()
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
  const creationAppIdSource = selectedAppIdSource.value
  const creationIconSource = selectedAppIconSource.value
  let creationFailureTracked = false
  trackDetailsEvent('onboarding_app_creation_started', {
    app_id_source: creationAppIdSource,
    has_icon: creationIconSource !== 'none',
    icon_source: creationIconSource,
  })
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
        creationFailureTracked = true
        trackDetailsEvent('onboarding_app_creation_failed', {
          app_id_source: creationAppIdSource,
          failure_reason: 'all_conflicts',
          has_icon: creationIconSource !== 'none',
          icon_source: creationIconSource,
        })
        appIdSuggestions.value = createResult.suggestions
        appIdFeedback.value = t('app-onboarding-appid-taken-pick-another', {
          appId: createResult.originalAppId,
        })
        returnToAppIdAfterConflict()
        toast.error(appIdFeedback.value)
        return
      }

      creationFailureTracked = true
      trackDetailsEvent('onboarding_app_creation_failed', {
        app_id_source: creationAppIdSource,
        failure_reason: 'request_error',
        has_icon: creationIconSource !== 'none',
        icon_source: creationIconSource,
      })
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

    const restoredLocalIconSource = localIconPreview.value.startsWith('data:image/') ? localIconPreview.value : ''
    const importedIconSource = canUseStoreImportPreview.value ? storeIconPreview.value : ''
    await uploadIcon(appId, restoredLocalIconSource || importedIconSource)
    const { data: refreshed } = await supabase
      .from('apps')
      .select()
      .eq('app_id', appId)
      .single()

    createdApp.value = refreshed ?? responseData
    trackDetailsEvent('onboarding_app_creation_succeeded', {
      app_id_source: creationAppIdSource,
      has_icon: creationIconSource !== 'none',
      icon_source: creationIconSource,
      used_fallback: createResult.wasRetried,
    })
    dashboardAppsStore.upsertApp({
      app_id: appId,
      name: appName.value.trim() || null,
      ownerOrgId: currentOrg.value.gid,
    })
    const completionProperties: OnboardingStepCompletionProperties = {
      appId,
    }
    if (flowStep.value === 'details')
      completionProperties.storeImportUsed = hasImportedStoreMetadata.value
    completeAndViewStep(options?.nextStep ?? 'choice', completionProperties)
  }
  catch (error) {
    console.error('Cannot create onboarding app', error)
    if (!creationFailureTracked) {
      trackDetailsEvent('onboarding_app_creation_failed', {
        app_id_source: creationAppIdSource,
        failure_reason: 'request_error',
        has_icon: creationIconSource !== 'none',
        icon_source: creationIconSource,
      })
    }
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
    const { data, error } = await invokeCapgoApi('app/demo', {
      method: 'POST',
      body: {
        owner_org: currentOrg.value.gid,
        app_id: createdApp.value.app_id,
      },
    })

    if (error || !data?.app_id) {
      throw error
    }

    window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))
    allowOnboardingDashboardExploration(onboardingUserId.value, createdApp.value.app_id)
    dashboardAppsStore.upsertApp({
      app_id: createdApp.value.app_id,
      name: createdApp.value.name ?? null,
      ownerOrgId: currentOrg.value.gid,
    })
    await persistOnboardingProgress('completed')
    router.push(`/app/${encodeURIComponent(createdApp.value.app_id)}/getting-started`)
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

function trackSuccessfulCopy(event: OnboardingCopyEvent) {
  const orgId = currentOrg.value?.gid
  const appId = createdApp.value?.app_id || generatedAppId.value || undefined
  progressTracker?.trackCopyEvent(event, {
    ...(appId ? { app_id: appId } : {}),
    ...(existingApp.value !== null ? { existing_app: existingApp.value } : {}),
    ...(selectedIntent.value ? { intent: selectedIntent.value } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    setup_command: usesBuilderSetupCommand.value ? 'builder' : 'ota',
  })
}

async function copyCliCommand() {
  if (!apiKey.value)
    return

  const copied = await copyText(cliCommand.value)
  if (copied)
    trackSuccessfulCopy('onboarding_cli_command_copied')
}

async function goToGettingStarted() {
  if (!createdApp.value)
    return

  const appId = createdApp.value.app_id
  progressTracker?.completeStep(analyticsStepFor(flowStep.value), { appId })
  await persistOnboardingProgress('completed')
  await router.replace(`/app/${encodeURIComponent(appId)}/getting-started`)
}

function goToInstallStep() {
  if (!createdApp.value)
    return

  isCliCommandVisible.value = false
  void goToGettingStarted()
}

function trackDashboardExplored() {
  if (!progressTracker) {
    pendingDashboardExplored = true
    return
  }
  pendingDashboardExplored = false
  progressTracker?.trackDashboardExplored(createdApp.value?.app_id)
}

onMounted(async () => {
  window.addEventListener(ONBOARDING_DASHBOARD_EXPLORED_EVENT, trackDashboardExplored)
  document.addEventListener('visibilitychange', trackOnboardingVisibilityChange)
  welcomeCanvasEligible.value = window.matchMedia(WELCOME_CANVAS_MEDIA_QUERY).matches
  let resumedFlow = false
  isLoading.value = true
  isHydratingOnboarding.value = true
  try {
    if (props.preOrg) {
      if (resumeAppId.value) {
        await organizationStore.awaitInitialLoad()
        const resumed = await loadResumeApp()
        if (resumed) {
          resumedFlow = true
          void loadApiKey().catch((error) => {
            console.error('Cannot ensure API key', error)
            toast.error(t('app-onboarding-toast-apikey-error'))
          })
          return
        }
      }
      const resumeResult = await maybeResumeSavedOnboarding()
      if (resumeResult === null) {
        onboardingProgressPersistence.abort()
        return
      }
      resumedFlow = resumeResult
      return
    }

    await organizationStore.awaitInitialLoad()
    await main.awaitInitialLoad()

    const resumed = await loadResumeApp()
    resumedFlow = resumed
    if (!resumed) {
      flowStep.value = 'details'
      appDetailsStep.value = 'name'
      existingApp.value = null
      existingAppSetup.value = null
    }

    void loadApiKey().catch((error) => {
      console.error('Cannot ensure API key', error)
      toast.error(t('app-onboarding-toast-apikey-error'))
    })
  }
  finally {
    isHydratingOnboarding.value = false
    let onboardingPersistResult: OnboardingPersistResult = 'skipped'
    if (!onboardingFlowDisposed && !onboardingProgressPersistence.isAborted()) {
      onboardingInitialPersistInFlight = true
      const persistStatus = pendingGettingStartedAppId ? 'completed' : 'in_progress'
      onboardingPersistResult = await persistOnboardingProgress(persistStatus)
      if (onboardingPersistResult === 'retryable_failure' && !onboardingFlowDisposed)
        onboardingPersistResult = await persistOnboardingProgress(persistStatus)
      onboardingInitialPersistInFlight = false
    }
    if (pendingGettingStartedAppId && !onboardingFlowDisposed) {
      await router.replace(`/app/${encodeURIComponent(pendingGettingStartedAppId)}/getting-started`)
      return
    }
    function finishOnboardingMount() {
      if (onboardingFlowDisposed || onboardingProgressPersistence.isAborted())
        return
      isLoading.value = false
      const shouldInitializeProgressTracking = shouldInitializeOnboardingProgressTracking(
        onboardingPersistResult,
        {
          aborted: onboardingProgressPersistence.isAborted(),
          disposed: onboardingFlowDisposed,
        },
      )
      if (shouldInitializeProgressTracking)
        initializeProgressTracking(resumedFlow)
      else
        pendingVisibilityChanges = []
    }
    finishOnboardingMount()
  }
})

onBeforeUnmount(() => {
  onboardingFlowDisposed = true
  window.clearTimeout(persistFieldsTimer)
  window.removeEventListener(ONBOARDING_DASHBOARD_EXPLORED_EVENT, trackDashboardExplored)
  document.removeEventListener('visibilitychange', trackOnboardingVisibilityChange)
  detailsFieldTracker.dispose()
  if (!isHydratingOnboarding.value && !onboardingInitialPersistInFlight && !onboardingProgressPersistence.isBlocked() && !onboardingProgressPersistence.isAborted())
    void persistOnboardingProgress('in_progress', { allowDisposed: true })

  if (localIconPreview.value.startsWith('blob:'))
    URL.revokeObjectURL(localIconPreview.value)
})

watch(existingApp, (value) => {
  if (isHydratingOnboarding.value)
    return
  schedulePersistOnboardingProgress()
  if (props.preOrg) {
    if (value === false)
      estimatedUsersIndex.value = 1
    appIdSuggestions.value = []
    appIdFeedback.value = ''
    return
  }

  if (value !== true)
    existingAppSetup.value = value === false ? 'manual' : null
  if (value !== true) {
    resetStoreImportState()
  }
  if (value === false)
    estimatedUsersIndex.value = 1
  appIdSuggestions.value = []
  appIdFeedback.value = ''
})

watch(existingAppSetup, (value) => {
  if (value === 'manual')
    resetStoreImportState()
})

watch(appName, (value) => {
  if (isHydratingOnboarding.value)
    return
  if (!hasEditedOrgName.value)
    orgNameInput.value = value.trim()
  schedulePersistOnboardingProgress()
}, { immediate: true })

watch([orgNameInput, storeUrl, selectedIntent, existingAppSetup, estimatedUsersIndex, manualAppId, importedStoreAppId], () => {
  schedulePersistOnboardingProgress()
})

watch(appDetailsStep, () => {
  schedulePersistOnboardingProgress()
})

defineExpose({
  persistOnboardingProgress,
})
</script>

<template>
  <AppOnboardingWelcome
    v-if="showPreOrgWelcome && !isLoading"
    @continue="continueFromWelcome"
  />

  <section
    v-else
    class="onboarding-flow-shell h-full min-h-0 overflow-y-auto bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 dark:bg-slate-950"
    :class="{
      'onboarding-flow-app-creation': props.preOrg && (flowStep === 'intent' || flowStep === 'details'),
      'onboarding-flow-intent': props.preOrg && flowStep === 'intent',
      'onboarding-flow-details-name': flowStep === 'details' && appDetailsStep === 'name',
      'onboarding-flow-details-app-id': flowStep === 'details' && appDetailsStep === 'app_id',
      'onboarding-flow-details-icon': flowStep === 'details' && appDetailsStep === 'icon',
    }"
  >
    <div class="mx-auto w-full max-w-3xl">
      <div v-if="isLoading" class="flex min-h-[50vh] items-center justify-center">
        <Spinner size="w-32 h-32" />
      </div>

      <div v-else class="onboarding-flow-content space-y-6">
        <header class="onboarding-flow-header">
          <div class="onboarding-flow-badge inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-700 shadow-sm dark:border-white/15 dark:bg-slate-900/95 dark:text-slate-200">
            <IconSparkles class="h-4 w-4" />
            {{ t('app-onboarding-badge') }}
          </div>
          <h1 class="onboarding-flow-title mt-4 text-2xl font-semibold text-slate-950 sm:text-3xl dark:text-white">
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

        <div v-if="props.preOrg && flowStep === 'intent'" class="onboarding-intent-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
          <div class="onboarding-intent-card-content space-y-6">
            <div class="onboarding-intent-heading">
              <p class="onboarding-intent-eyebrow text-sm font-semibold text-primary-500 dark:text-slate-300">
                {{ t('unified-onboarding-step-intent') }}
              </p>
              <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                {{ t('organization-onboarding-intent-question') }}
              </h2>
              <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('organization-onboarding-intent-hint') }}
              </p>
            </div>
            <div class="onboarding-intent-options grid gap-3 sm:grid-cols-2">
              <button v-for="option in intentOptions" :key="option.value" type="button" class="d-btn onboarding-intent-option group h-auto min-h-20 w-full items-start justify-start gap-3 whitespace-normal rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900" :class="whiteCardToggleButtonClass(selectedIntent === option.value)" :data-test="`onboarding-intent-${option.value}`" @click="selectedIntent = option.value">
                <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-primary-500"><component :is="option.icon" class="h-5 w-5" /></span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-slate-950 dark:text-white">{{ t(`organization-onboarding-intent-option-${option.value}-label`) }}</span>
                  <span class="onboarding-intent-option-description mt-1 block text-xs leading-5 text-slate-600 dark:text-slate-300">{{ t(`organization-onboarding-intent-option-${option.value}-desc`) }}</span>
                </span>
              </button>
            </div>
            <div class="onboarding-intent-actions flex justify-end border-t border-slate-200 pt-6 dark:border-white/15">
              <button type="button" class="d-btn min-h-12" :class="whiteCardPrimaryButtonClass()" data-test="app-onboarding-continue-intent" :disabled="!selectedIntent" @click="continueFromIntent()">
                {{ t('unified-onboarding-continue-intent') }}<IconArrowRight class="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div v-if="flowStep === 'details'">
          <div class="onboarding-details-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
            <div class="onboarding-details-card-content space-y-6">
              <div class="onboarding-details-heading" :class="{ 'onboarding-details-heading-app-id': appDetailsStep === 'app_id' }">
                <p class="onboarding-details-eyebrow text-sm font-semibold text-primary-500 dark:text-slate-300">
                  {{ t('app-onboarding-step-details') }}
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ appDetailsStep === 'name'
                    ? t('app-onboarding-name-step-title')
                    : appDetailsStep === 'app_id'
                      ? t('app-onboarding-app-id-step-title')
                      : t('app-onboarding-icon-step-title') }}
                </h2>
                <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {{ appDetailsStep === 'name'
                    ? t('app-onboarding-name-step-helper')
                    : appDetailsStep === 'app_id'
                      ? t('app-onboarding-app-id-step-helper')
                      : t('app-onboarding-icon-step-helper') }}
                </p>
              </div>

              <div
                v-if="appDetailsStep !== 'icon'"
                class="onboarding-details-preview flex flex-col items-center py-1 text-center"
                :class="{ 'onboarding-details-preview-app-id': appDetailsStep === 'app_id' }"
              >
                <div class="onboarding-details-preview-icon relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-[1.4rem] bg-slate-950 text-white shadow-lg shadow-slate-950/15 ring-1 ring-white/10 dark:bg-white dark:text-slate-950 dark:shadow-black/20">
                  <span class="absolute -right-3 -top-3 h-10 w-10 rounded-full bg-primary-500/90" aria-hidden="true" />
                  <span class="absolute -bottom-4 -left-2 h-11 w-11 rounded-full bg-emerald-400/80" aria-hidden="true" />
                  <span v-if="appNameInitial" class="relative text-2xl font-bold tracking-tight">{{ appNameInitial }}</span>
                  <IconSparkles v-else class="relative h-7 w-7" aria-hidden="true" />
                </div>
                <p class="mt-3 max-w-full truncate text-base font-semibold text-slate-950 dark:text-white">
                  {{ appName.trim() || t('app-onboarding-preview-placeholder') }}
                </p>
                <p v-if="appDetailsStep === 'app_id'" class="mt-1 max-w-full truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                  {{ generatedAppId }}
                </p>
              </div>

              <div v-if="!props.preOrg && appDetailsStep === 'name'" class="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  :aria-pressed="existingApp === true"
                  class="d-btn group h-auto min-h-32 w-full items-start justify-start gap-4 whitespace-normal rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
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
                  class="d-btn group h-auto min-h-32 w-full items-start justify-start gap-4 whitespace-normal rounded-2xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
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

              <div class="contents">
                <div v-if="appDetailsStep === 'icon'" class="onboarding-icon-identity flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
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

                <div v-if="appDetailsStep === 'name'" class="mb-6">
                  <label for="app-onboarding-name" class="text-sm font-medium text-slate-800 dark:text-slate-200">{{ t('app-name') }}</label>
                  <input
                    id="app-onboarding-name"
                    v-model="appName"
                    data-test="app-onboarding-name"
                    class="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                    :placeholder="t('app-onboarding-name-placeholder')"
                    maxlength="100"
                    @input="onAppNameInput"
                  >
                </div>

                <div v-if="appDetailsStep === 'app_id'">
                  <label for="app-onboarding-app-id" class="text-sm font-medium text-slate-800 dark:text-slate-200">{{ t('app-id') }}</label>
                  <input
                    id="app-onboarding-app-id"
                    :value="manualAppId"
                    class="onboarding-app-id-input mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 font-mono text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                    :placeholder="suggestedAppId"
                    @input="onAppIdInput"
                  >
                  <div class="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    <i18n-t keypath="app-onboarding-app-id-generated-helper" tag="span">
                      <template #appId>
                        <code class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-medium text-slate-700 dark:bg-white/10 dark:text-slate-200">{{ suggestedAppId }}</code>
                      </template>
                    </i18n-t>
                    <button
                      v-if="props.preOrg"
                      type="button"
                      class="text-sm font-medium text-primary-500 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      data-test="app-onboarding-appid-learn-more"
                      @click="openAppIdHelp()"
                    >
                      {{ t('app-onboarding-app-id-learn-more') }}
                    </button>
                  </div>
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

                <div v-if="appDetailsStep === 'app_id' && (props.preOrg || existingApp === true)" class="onboarding-store-import mb-6 mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-white/15 dark:bg-slate-950/60">
                  <button
                    type="button"
                    class="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:text-slate-200 dark:hover:bg-slate-900"
                    data-test="app-onboarding-toggle-store-import"
                    :aria-expanded="isStoreImportOpen"
                    aria-controls="app-onboarding-store-import-panel"
                    @click="toggleStoreImport"
                  >
                    <span class="flex items-center gap-2">
                      <IconStore class="h-4 w-4" />
                      {{ t('app-onboarding-v2-store-import-toggle') }}
                    </span>
                    <IconChevronUp v-if="isStoreImportOpen" class="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                    <IconChevronDown v-else class="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                  </button>

                  <div v-if="isStoreImportOpen" id="app-onboarding-store-import-panel" class="space-y-3 border-t border-slate-200 p-4 dark:border-white/15">
                    <label for="app-onboarding-v2-store-url" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                      {{ t('app-onboarding-store-link-label') }}
                    </label>
                    <div class="space-y-3">
                      <input
                        id="app-onboarding-v2-store-url"
                        v-model="storeUrl"
                        class="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                        :placeholder="t('app-onboarding-store-link-placeholder')"
                        type="url"
                        @input="onStoreUrlInput"
                      >
                      <button type="button" class="d-btn min-h-11 w-full sm:w-auto" :class="whiteCardSecondaryButtonClass()" :disabled="isImportingStore || !storeUrl.trim()" @click="importStoreMetadata()">
                        <IconLoader v-if="isImportingStore" class="h-4 w-4 animate-spin" />
                        <IconSparkles v-else class="h-4 w-4" />
                        <span>{{ t('app-onboarding-store-import-button') }}</span>
                      </button>
                    </div>
                    <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400" aria-live="polite">
                      {{ hasImportedStoreMetadata
                        ? t('app-onboarding-store-imported-help')
                        : t('app-onboarding-v2-store-import-help') }}
                    </p>
                  </div>
                </div>

                <div v-if="appDetailsStep === 'icon'">
                  <div v-if="storeIconPreview" class="rounded-2xl border border-slate-200 bg-white p-4 dark:border-white/15 dark:bg-slate-950/70">
                    <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
                      <img :src="storeIconPreview" :alt="t('app-onboarding-imported-icon-alt')" class="h-20 w-20 shrink-0 rounded-2xl border border-slate-200 bg-white object-cover shadow-sm dark:border-white/15">
                      <div class="min-w-0 flex-1">
                        <p class="text-xs font-semibold uppercase tracking-wide text-primary-500">
                          {{ t('app-onboarding-imported-icon-label') }}
                        </p>
                        <p class="mt-1 truncate text-base font-semibold text-slate-950 dark:text-white">
                          {{ storeAppNamePreview || appName }}
                        </p>
                        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                          {{ t('app-onboarding-imported-icon-helper') }}
                        </p>
                      </div>
                      <button
                        type="button"
                        class="d-btn min-h-11 shrink-0"
                        :class="canUseStoreImportPreview ? whiteCardSecondaryButtonClass() : whiteCardPrimaryButtonClass()"
                        :disabled="canUseStoreImportPreview"
                        data-test="app-onboarding-use-imported-icon"
                        @click="selectImportedIcon()"
                      >
                        <IconCheck v-if="canUseStoreImportPreview" class="h-4 w-4" />
                        {{ canUseStoreImportPreview ? t('app-onboarding-imported-icon-selected') : t('app-onboarding-use-imported-icon') }}
                      </button>
                    </div>
                  </div>

                  <div class="onboarding-icon-uploader mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/60">
                    <AppOnboardingIconInput
                      v-model="selectedIconFile"
                      :label="t('app-onboarding-use-different-icon')"
                      :choose-label="t('app-onboarding-icon-choose-file')"
                      :empty-label="t('app-onboarding-icon-no-file-selected')"
                      @picker-closed-without-selection="onIconPickerClosedWithoutSelection"
                      @picker-open-failed="onIconPickerOpenFailed"
                      @picker-opened="onIconPickerOpened"
                      @update:model-value="onSelectIconFormKit"
                    />
                    <p class="onboarding-icon-upload-helper mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                      {{ t('app-onboarding-icon-help') }}
                    </p>
                    <button
                      v-if="iconPreview"
                      type="button"
                      class="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-300 dark:hover:bg-red-500/10"
                      data-test="app-onboarding-remove-icon"
                      @click="removeSelectedIcon"
                    >
                      <IconTrash class="h-4 w-4" />
                      {{ t('app-onboarding-remove-icon') }}
                    </button>
                  </div>

                  <div class="mb-6 mt-5 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 onboarding-icon-store-import dark:border-white/15 dark:bg-slate-950/60">
                    <button
                      type="button"
                      class="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:text-slate-200 dark:hover:bg-slate-900"
                      data-test="app-onboarding-toggle-icon-store-import"
                      :aria-expanded="isStoreIconImportOpen"
                      aria-controls="app-onboarding-icon-store-import-panel"
                      @click="toggleStoreIconImport"
                    >
                      <span class="flex items-center gap-2">
                        <IconStore class="h-4 w-4" />
                        {{ t('app-onboarding-import-icon-only-title') }}
                      </span>
                      <IconChevronUp v-if="isStoreIconImportOpen" class="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                      <IconChevronDown v-else class="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                    </button>

                    <div v-if="isStoreIconImportOpen" id="app-onboarding-icon-store-import-panel" class="space-y-3 border-t border-slate-200 p-4 dark:border-white/15">
                      <p class="text-sm leading-6 text-slate-500 dark:text-slate-400">
                        {{ t('app-onboarding-import-icon-only-helper') }}
                      </p>
                      <div class="space-y-3">
                        <label for="app-onboarding-icon-store-url" class="sr-only">
                          {{ t('app-onboarding-store-link-label') }}
                        </label>
                        <input
                          id="app-onboarding-icon-store-url"
                          v-model="iconStoreUrl"
                          class="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                          :placeholder="t('app-onboarding-store-link-placeholder')"
                          type="url"
                          @input="onIconStoreUrlInput"
                        >
                        <button type="button" class="d-btn min-h-11 w-full sm:w-auto" :class="whiteCardSecondaryButtonClass()" :disabled="isImportingStoreIcon || !iconStoreUrl.trim()" data-test="app-onboarding-import-icon-only" @click="importStoreIcon">
                          <IconLoader v-if="isImportingStoreIcon" class="h-4 w-4 animate-spin" />
                          <IconSparkles v-else class="h-4 w-4" />
                          {{ t('app-onboarding-import-icon-only-button') }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:items-center sm:justify-between onboarding-details-actions dark:border-white/15">
                  <button
                    type="button"
                    class="d-btn min-h-12"
                    :class="whiteCardSecondaryButtonClass()"
                    :disabled="isAppDetailsNavigationPending"
                    @click="appDetailsStep === 'name' ? (props.preOrg ? viewPreviousStep('intent') : router.push('/apps')) : viewPreviousAppDetailsStep()"
                  >
                    {{ appDetailsStep === 'name' && !props.preOrg ? t('button-cancel') : t('button-back') }}
                  </button>
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <button
                      type="button"
                      class="d-btn min-h-12"
                      :class="whiteCardPrimaryButtonClass()"
                      :disabled="isAppDetailsNavigationPending"
                      :data-test="appDetailsStep === 'app_id' && !hasProvidedAppId ? 'app-onboarding-skip-app-id' : 'app-onboarding-continue'"
                      @click="continueFromCurrentAppDetailsStep"
                    >
                      <IconLoader v-if="isSubmitting" class="h-4 w-4 animate-spin" />
                      <span v-else>{{ appDetailsPrimaryActionLabel }}</span>
                      <IconArrowRight v-if="!isSubmitting" class="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div v-if="!props.preOrg && appDetailsStep === 'icon'" class="pt-1">
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
                  <button
                    v-if="apiKey"
                    type="button"
                    class="d-btn group relative h-auto min-h-0 w-full justify-start whitespace-normal rounded-xl border-0 bg-slate-950 p-4 pr-14 text-left font-normal ring-1 ring-white/10 transition hover:bg-slate-950 hover:ring-white/20"
                    :aria-label="t('app-onboarding-command-copy')"
                    @click="copyCliCommand"
                  >
                    <code class="block whitespace-pre-wrap break-all text-sm">
                      <span class="text-slate-500">npx</span>
                      <span class="text-sky-300"> @capgo/cli@latest</span>
                      <span class="font-bold text-violet-300">&nbsp;{{ cliSubcommand }}</span>
                      <span v-if="!usesBuilderSetupCommand" class="text-emerald-300">&nbsp;{{ apiKey }}</span>
                      <template v-for="(arg, index) in cliCommandArgs" :key="`${arg}-${index}`">
                        <span :class="index % 2 === 0 ? 'text-amber-300' : 'text-cyan-300'"> {{ arg }}</span>
                      </template>
                    </code>
                    <IconCopy class="absolute right-4 top-4 h-5 w-5 text-muted-blue-300 transition group-hover:text-white" />
                  </button>
                  <div v-else class="rounded-xl bg-slate-950 p-4 pr-14 ring-1 ring-white/10" role="status">
                    <div class="flex min-h-6 items-center gap-3 text-sm text-slate-300">
                      <Spinner size="w-5 h-5" />
                      <span>{{ t('app-onboarding-command-apikey-loading') }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <template v-else-if="props.preOrg && flowStep === 'organization'">
          <OrganizationOnboardingInvite
            v-if="showOrganizationInvite && createdApp && currentOrg"
            analytics-channel="onboarding-v3"
            :continue-label="t('continue')"
            :organization-id="currentOrg.gid"
            :organization-name="currentOrg.name"
            :tracking-version="3"
            @continue="continueFromOrganizationInvite"
            @invite-opened="onOrganizationInviteOpened"
            @invite-succeeded="onOrganizationInviteSucceeded"
          />
          <div v-else class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/15 dark:bg-slate-900/95">
            <div class="space-y-6">
              <div>
                <p class="text-sm font-semibold text-primary-500 dark:text-slate-300">
                  {{ t('unified-onboarding-step-organization') }}
                </p>
                <h2 class="mt-2 text-2xl font-semibold text-slate-950 dark:text-white">
                  {{ t('unified-onboarding-organization-title') }}
                </h2>
                <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {{ t('unified-onboarding-organization-helper') }}
                </p>
              </div>

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
                  autocomplete="organization"
                  autofocus
                  class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                  @input="hasEditedOrgName = true"
                >
              </div>

              <div class="rounded-xl border border-slate-200 bg-slate-50 dark:border-white/15 dark:bg-slate-950/90">
                <button
                  type="button"
                  class="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold text-slate-800 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:text-slate-200 dark:hover:bg-slate-900"
                  :class="{ 'rounded-b-none': isOrganizationImportOpen }"
                  data-test="onboarding-toggle-organization-import"
                  :aria-expanded="isOrganizationImportOpen"
                  @click="toggleOrganizationWebsiteImport"
                >
                  <span class="flex items-center gap-2">
                    <IconGlobe class="h-4 w-4" />
                    {{ t('organization-onboarding-import-website') }}
                  </span>
                  <IconChevronUp v-if="isOrganizationImportOpen" class="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                  <IconChevronDown v-else class="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                </button>

                <div v-if="isOrganizationImportOpen" class="space-y-4 border-t border-slate-200 p-4 dark:border-white/15">
                  <div>
                    <div class="relative flex items-center gap-2">
                      <label for="onboarding-organization-website" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                        {{ t('organization-onboarding-website-label') }}
                      </label>
                      <span
                        class="group inline-flex rounded-full text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-500"
                        tabindex="0"
                        aria-describedby="onboarding-organization-website-help"
                      >
                        <IconInfo class="h-4 w-4" aria-hidden="true" />
                        <span
                          id="onboarding-organization-website-help"
                          role="tooltip"
                          class="pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-64 max-w-[calc(100vw-4rem)] rounded-lg bg-slate-950 px-3 py-2 text-xs font-normal leading-5 text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100 dark:bg-slate-800"
                        >
                          {{ t('organization-onboarding-website-help') }}
                        </span>
                      </span>
                    </div>
                    <input
                      id="onboarding-organization-website"
                      v-model="organizationWebsiteInput"
                      type="url"
                      placeholder="https://capgo.app"
                      data-test="onboarding-organization-website"
                      :readonly="!!websitePreview"
                      class="d-input mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 read-only:cursor-not-allowed read-only:bg-slate-100 read-only:text-slate-600 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30 dark:read-only:bg-slate-900 dark:read-only:text-slate-300"
                      @input="websitePreview = null"
                    >
                  </div>

                  <template v-if="websitePreview">
                    <p class="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-300" aria-live="polite">
                      <IconCheck class="h-4 w-4 shrink-0" />
                      {{ t('organization-onboarding-website-import-success') }}
                    </p>

                    <div>
                      <p class="text-sm font-medium text-slate-800 dark:text-slate-200">
                        {{ t('organization-onboarding-imported-logo-label') }}
                      </p>
                      <img
                        v-if="websitePreview.icon"
                        :src="websitePreview.icon"
                        :alt="t('organization-onboarding-imported-logo-preview-alt')"
                        class="mt-2 h-16 w-16 rounded-xl border border-slate-200 bg-white object-cover dark:border-white/15 dark:bg-slate-900"
                      >
                      <p v-else class="mt-2 text-sm text-slate-500 dark:text-slate-400">
                        {{ t('organization-onboarding-imported-logo-unavailable') }}
                      </p>
                    </div>

                    <button
                      type="button"
                      class="d-btn min-h-10 border-red-200 bg-white text-red-700 hover:border-red-300 hover:bg-red-50 dark:border-red-500/30 dark:bg-slate-950 dark:text-red-300 dark:hover:bg-red-500/10"
                      data-test="onboarding-delete-imported-organization-details"
                      @click="deleteImportedOrganizationDetails"
                    >
                      <IconTrash class="h-4 w-4" />
                      {{ t('organization-onboarding-delete-imported-details') }}
                    </button>
                  </template>

                  <button
                    v-else
                    type="button"
                    class="d-btn min-h-11 w-full sm:w-auto"
                    :class="whiteCardSecondaryButtonClass()"
                    :disabled="isImportingOrganizationWebsite || !organizationWebsiteInput.trim()"
                    data-test="onboarding-import-organization-website"
                    @click="importOrganizationWebsite"
                  >
                    <IconLoader v-if="isImportingOrganizationWebsite" class="h-4 w-4 animate-spin" />
                    <IconSparkles v-else class="h-4 w-4" />
                    {{ t('organization-onboarding-import-website') }}
                  </button>
                </div>
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
                    :class="{ 'sm:col-span-2': stop.startingOut }"
                    :data-value="stop.value"
                    :data-test="stop.startingOut ? 'onboarding-starting-out' : 'onboarding-estimated-users-option'"
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
                <button type="button" class="d-btn min-h-12" :class="whiteCardSecondaryButtonClass()" @click="viewPreviousStep('details')">
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
            </div>
          </div>
        </template>

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
              <button type="button" class="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-primary-500/40 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-white/15 dark:bg-slate-950/90 dark:hover:border-white/30 dark:hover:bg-slate-900" @click="goToInstallStep">
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
                type="button"
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

        <div v-if="showLanguageSelector" class="flex justify-end pt-2">
          <LangSelector />
        </div>
      </div>
    </div>
  </section>
</template>

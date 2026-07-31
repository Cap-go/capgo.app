<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import IconArrowRight from '~icons/lucide/arrow-right'
import IconBuilding from '~icons/lucide/building-2'
import IconCheck from '~icons/lucide/check'
import IconCompass from '~icons/lucide/compass'
import IconGlobe from '~icons/lucide/globe-2'
import IconLayers from '~icons/lucide/layers'
import IconLoader from '~icons/lucide/loader-2'
import IconPencil from '~icons/lucide/pencil-line'
import IconRefresh from '~icons/lucide/refresh-cw'
import IconSmartphone from '~icons/lucide/smartphone'
import IconSparkles from '~icons/lucide/sparkles'
import IconUpload from '~icons/lucide/upload-cloud'
import IconUserPlus from '~icons/lucide/user-plus'
import IconUsers from '~icons/lucide/users-round'
import IconBack from '~icons/material-symbols/arrow-back-ios-rounded'
import InviteTeammateModal from '~/components/dashboard/InviteTeammateModal.vue'
import { formatNumberValue } from '~/services/formatLocale'
import { createOnboardingAppFromDraft } from '~/services/onboardingAppCreate'
import { uploadOrgLogoFile } from '~/services/photos'
import { pushEvent } from '~/services/posthog'
import { getLocalConfig, useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import { useMainStore } from '~/stores/main'
import { useOrganizationStore } from '~/stores/organization'
import { clearOnboardingAppDraft, loadOnboardingAppDraft } from '~/utils/onboardingAppDraft'

type OnboardingStep = 'details' | 'logo' | 'invite'
type OnboardingMode = 'website' | 'name' | 'app-name' | null

interface InviteTeammateModalRef {
  openDialog: () => void
}

interface SentInvite {
  email: string
  firstName: string
  lastName: string
}

interface WebsitePreview {
  hostname: string
  name: string
  icon: string | null
  website: string
}

interface UserCountStop {
  value: number
  label: string
  planName: string
}

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const supabase = useSupabase()
const main = useMainStore()
const displayStore = useDisplayStore()
const organizationStore = useOrganizationStore()
const { currentOrganization } = storeToRefs(organizationStore)

const step = ref<OnboardingStep>('details')
const mode = ref<OnboardingMode>(null)
const websiteInput = ref('')
const orgNameInput = ref('')
const createdOrgId = ref('')
const isSubmitting = ref(false)
const isUploadingLogo = ref(false)
const isLoadingWebsitePreview = ref(false)
const isLoggingOut = ref(false)
const selectedLogoPreview = ref('')
const sentInvites = ref<SentInvite[]>([])
const websitePreview = ref<WebsitePreview | null>(null)
const inviteModalRef = ref<InviteTeammateModalRef | null>(null)
const logoInputRef = useTemplateRef<HTMLInputElement>('logoInput')
const isAdditionalOrgFlow = ref(false)
const appDraft = ref(loadOnboardingAppDraft(main.user?.id ?? main.auth?.id))
const estimatedUsersIndex = ref<number | null>(null)
const config = getLocalConfig()

// Org-level onboarding intent: what the user wants to do with Capgo first.
// Persisted on the new org (orgs.onboarding jsonb, keyed by `intent`) by the
// function, and mirrored to PostHog for segmentation. Asked once per org.
const selectedIntent = ref<string | null>(null)
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

const onboardingSteps: Array<{ id: OnboardingStep, label: string }> = [
  { id: 'details', label: t('organization-onboarding-step-details') },
  { id: 'logo', label: t('organization-onboarding-step-logo') },
  { id: 'invite', label: t('organization-onboarding-step-invite') },
]

const activeOrgId = computed(() => createdOrgId.value || '')
const activeOrgName = computed(() => {
  if (currentOrganization.value?.gid === activeOrgId.value)
    return currentOrganization.value.name
  return orgNameInput.value.trim() || websitePreview.value?.name || ''
})
const hasSavedLogo = computed(() => currentOrganization.value?.gid === activeOrgId.value && !!currentOrganization.value.logo)
const userCountStops = computed<UserCountStop[]>(() => {
  const planStops = planNameOrder
    .map(planName => main.plans.find(plan => plan.name === planName))
    .flatMap((plan) => {
      if (!plan?.mau)
        return []

      const mau = Number(plan.mau)
      if (!Number.isFinite(mau) || mau <= 0)
        return []

      return [{
        value: mau,
        label: formatUserCount(mau, plan.name === 'Enterprise'),
        planName: plan.name,
      }]
    })

  if (planStops.length === planNameOrder.length) {
    return planStops
  }

  return fallbackUserCountStops.map(stop => ({ ...stop, label: formatUserCount(stop.value, stop.planName === 'Enterprise') }))
})
const selectedUserCountStop = computed<UserCountStop | null>(() => {
  if (estimatedUsersIndex.value === null)
    return null
  return userCountStops.value[Math.min(estimatedUsersIndex.value, userCountStops.value.length - 1)] ?? null
})

const currentStepIndex = computed(() => onboardingSteps.findIndex(entry => entry.id === step.value) + 1)
const stepProgress = computed(() => `${((currentStepIndex.value - 1) / Math.max(onboardingSteps.length - 1, 1)) * 100}%`)

const websiteHostname = computed(() => {
  const value = websiteInput.value.trim()
  if (!value)
    return ''

  try {
    const normalized = /^https?:\/\//.test(value) ? value : `https://${value}`
    return new URL(normalized).hostname.replace(/^www\./, '')
  }
  catch {
    return ''
  }
})

const importedLogoUrl = computed(() => websitePreview.value?.icon ?? '')
const canShowOrgDetails = computed(() => mode.value !== null)
const canCreateOrganization = computed(() => {
  if (!main.auth || isSubmitting.value || isLoadingWebsitePreview.value || !mode.value)
    return false

  return !!orgNameInput.value.trim() && !!selectedUserCountStop.value
})
const hasExistingOrganization = computed(() => organizationStore.organizations.some(org => !org.role.includes('invite')))
const inviteSuccessCount = computed(() => sentInvites.value.length)
const isCompactCreateOrgFlow = computed(() => isAdditionalOrgFlow.value)
const onboardingBadge = computed(() => isCompactCreateOrgFlow.value
  ? t('organization-create-badge')
  : t('organization-onboarding-badge'))
const onboardingTitle = computed(() => isCompactCreateOrgFlow.value
  ? t('organization-create-title')
  : t('organization-onboarding-title'))
const onboardingSubtitle = computed(() => {
  if (isCompactCreateOrgFlow.value)
    return t('organization-create-subtitle')
  if (appDraft.value)
    return t('organization-onboarding-subtitle-after-app')
  return t('organization-onboarding-subtitle')
})

function whiteCardToggleButtonClass(active: boolean) {
  return active
    ? 'border-primary-500 bg-slate-100 text-slate-950 ring-2 ring-primary-500/15 dark:border-primary-500/80 dark:bg-primary-500/25 dark:text-white dark:ring-primary-500/30'
    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-white/15 dark:bg-slate-950/90 dark:text-slate-200 dark:hover:border-white/30 dark:hover:bg-slate-900'
}

function whiteCardSecondaryButtonClass() {
  return 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:opacity-100 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-100 dark:hover:border-white/30 dark:hover:bg-slate-900 dark:disabled:border-white/15 dark:disabled:bg-slate-900 dark:disabled:text-slate-500'
}

function whiteCardPrimaryButtonClass() {
  return 'border-primary-500 bg-primary-500 text-white hover:border-primary-500 hover:bg-primary-500/90 disabled:border-slate-300 disabled:bg-slate-300 disabled:text-white disabled:opacity-100 dark:border-primary-500/90 dark:bg-primary-500 dark:hover:border-primary-500 dark:hover:bg-primary-500/90 dark:disabled:border-white/15 dark:disabled:bg-slate-800 dark:disabled:text-slate-500'
}

function formatUserCount(value: number, plus = false) {
  const formatted = formatNumberValue(value, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 0,
  })
  return plus ? `${formatted}+` : formatted
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

function getInviteDisplayName(invite: SentInvite) {
  const fullName = `${invite.firstName} ${invite.lastName}`.trim()
  return fullName || invite.email
}

function getInviteInitials(invite: SentInvite) {
  const fullName = `${invite.firstName} ${invite.lastName}`.trim()
  if (fullName) {
    return fullName
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase() ?? '')
      .join('')
  }

  return invite.email.slice(0, 2).toUpperCase()
}

function onInviteSuccess(invite: SentInvite) {
  sentInvites.value = [
    invite,
    ...sentInvites.value.filter(entry => entry.email !== invite.email),
  ]
}

function toTitleCaseSegment(segment: string) {
  return segment
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function deriveOrgNameFromWebsite(hostname: string) {
  const primarySegment = hostname.split('.').filter(Boolean)[0] ?? ''
  return toTitleCaseSegment(primarySegment)
}

function isStepDone(stepId: OnboardingStep) {
  const order: OnboardingStep[] = ['details', 'logo', 'invite']
  return order.indexOf(stepId) < order.indexOf(step.value)
}

function isStepActive(stepId: OnboardingStep) {
  return step.value === stepId
}

async function goBack() {
  if (appDraft.value && !isAdditionalOrgFlow.value && step.value === 'details') {
    await router.push('/onboarding/app')
    return
  }

  if (window.history.length > 1) {
    await router.back()
    return
  }

  const fallbackPath = typeof route.query.to === 'string' && route.query.to && !route.query.to.startsWith('/onboarding/')
    ? route.query.to
    : '/login'
  await router.push(fallbackPath)
}

async function logoutFromOnboarding() {
  if (isLoggingOut.value)
    return

  isLoggingOut.value = true

  try {
    clearOnboardingAppDraft(main.user?.id ?? main.auth?.id)
    await main.logout()
    await router.replace('/login')
  }
  catch (error) {
    console.error('Failed to log out from organization onboarding', error)
    toast.error(t('cannot-sign-off'))
  }
  finally {
    isLoggingOut.value = false
  }
}

async function syncRouteQuery(nextStep: OnboardingStep, orgId = createdOrgId.value) {
  await router.replace({
    path: '/onboarding/organization',
    query: {
      ...(orgId ? { org: orgId } : {}),
      ...(typeof route.query.source === 'string' ? { source: route.query.source } : {}),
      ...(typeof route.query.to === 'string' ? { to: route.query.to } : {}),
      step: nextStep,
    },
  })
}

async function hydrateOnboardingFromQuery() {
  await organizationStore.fetchOrganizations()
  isAdditionalOrgFlow.value = typeof route.query.source === 'string'
    ? route.query.source === 'org-switcher'
    : hasExistingOrganization.value

  const queryOrgId = typeof route.query.org === 'string' ? route.query.org : ''
  const queryStep = typeof route.query.step === 'string' ? route.query.step as OnboardingStep : 'details'

  const validatedOrg = queryOrgId
    ? organizationStore.organizations.find(org => org.gid === queryOrgId && !org.role.includes('invite'))
    : null

  if (validatedOrg) {
    createdOrgId.value = queryOrgId
    organizationStore.setCurrentOrganization(queryOrgId)
  }
  else {
    createdOrgId.value = ''
  }

  if (validatedOrg && (queryStep === 'logo' || queryStep === 'invite'))
    step.value = queryStep
  else if (queryStep === 'logo' || queryStep === 'invite')
    await syncRouteQuery('details', '')
}

async function fetchWebsitePreview() {
  if (mode.value !== 'website')
    return null

  if (!websiteHostname.value) {
    toast.error(t('organization-onboarding-website-invalid'))
    return null
  }

  isLoadingWebsitePreview.value = true
  try {
    const { data, error } = await supabase.functions.invoke('private/website_preview', {
      body: {
        website: websiteInput.value.trim(),
      },
    })

    if (error || !data) {
      console.error('Failed to fetch website preview', error)
      toast.error(t('organization-onboarding-website-fetch-failed'))
      return null
    }

    websitePreview.value = data as WebsitePreview
    orgNameInput.value = data.name || deriveNameFromWebsitePreview(data.hostname)
    return websitePreview.value
  }
  finally {
    isLoadingWebsitePreview.value = false
  }
}

function deriveNameFromWebsitePreview(hostname: string) {
  return deriveOrgNameFromWebsite(hostname || websiteHostname.value)
}

async function createOrganization() {
  if (isSubmitting.value || !main.auth)
    return

  if (!mode.value) {
    toast.error(t('organization-onboarding-mode-required'))
    return
  }

  const orgName = orgNameInput.value.trim()
  if (!orgName) {
    toast.error(t('org-name-required'))
    return
  }

  if (!selectedUserCountStop.value) {
    toast.error(t('organization-onboarding-user-scale-required'))
    return
  }

  if (!selectedIntent.value) {
    toast.error(t('organization-onboarding-intent-required'))
    return
  }

  isSubmitting.value = true

  try {
    const normalizedWebsite = mode.value === 'website'
      ? websitePreview.value?.website
      : undefined

    const { data, error } = await supabase.functions.invoke('organization', {
      method: 'POST',
      body: {
        name: orgName,
        email: main.auth.email ?? '',
        estimatedMau: selectedUserCountStop.value.value,
        website: normalizedWebsite,
        intent: selectedIntent.value,
      },
    })

    if (error || !data?.id) {
      console.error('Error creating organization during onboarding', error)
      toast.error(error?.code === '23505'
        ? t('org-with-this-name-exists')
        : t('cannot-create-org'))
      return
    }

    createdOrgId.value = data.id
    toast.success(t('org-created-successfully'))

    try {
      pushEvent('onboarding_intent_selected', config.supaHost, {
        intent: selectedIntent.value,
        estimated_mau: selectedUserCountStop.value?.value ?? null,
        org_id: data.id,
      })
    }
    catch (error) {
      console.error('Failed to track onboarding intent', error)
    }

    try {
      await organizationStore.fetchOrganizations()
      organizationStore.setCurrentOrganization(data.id)
    }
    catch (error) {
      console.error('Failed to refresh organizations after onboarding create', error)
      toast.error(t('organization-onboarding-refresh-failed'))
    }

    if (mode.value === 'website' && importedLogoUrl.value) {
      try {
        const imported = await useImportedLogo()
        if (imported)
          return
      }
      catch (error) {
        console.error('Failed to import logo after organization create', error)
      }
    }

    step.value = 'logo'
    try {
      await syncRouteQuery('logo', data.id)
    }
    catch (error) {
      console.error('Failed to sync onboarding route after create', error)
    }
  }
  finally {
    isSubmitting.value = false
  }
}

async function uploadLogoBlob(blob: Blob, filename?: string) {
  const orgId = activeOrgId.value
  if (!orgId) {
    toast.error(t('organization-not-found'))
    return
  }

  isUploadingLogo.value = true
  try {
    await uploadOrgLogoFile(orgId, blob, filename)
    step.value = 'invite'
    toast.success(t('organization-onboarding-logo-saved'))
    await syncRouteQuery('invite', orgId)
  }
  catch (error) {
    console.error('Failed to upload organization logo during onboarding', error)
    toast.error(t('something-went-wrong-try-again-later'))
  }
  finally {
    isUploadingLogo.value = false
  }
}

async function useImportedLogo() {
  if (!importedLogoUrl.value) {
    toast.error(t('organization-onboarding-imported-logo-unavailable'))
    return false
  }

  try {
    if (importedLogoUrl.value.startsWith('data:')) {
      const [header, payload = ''] = importedLogoUrl.value.split(',', 2)
      const contentType = header.match(/^data:([^;]+)/)?.[1] ?? ''
      if (!contentType.startsWith('image/') || !payload) {
        toast.error(t('organization-onboarding-imported-logo-failed'))
        return false
      }

      const binary = atob(payload)
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
      const blob = new Blob([bytes], { type: contentType })
      await uploadLogoBlob(blob, `${websiteHostname.value || 'website-logo'}.png`)
      return true
    }

    const response = await fetch(importedLogoUrl.value)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!response.ok || !contentType.startsWith('image/')) {
      toast.error(t('organization-onboarding-imported-logo-failed'))
      return false
    }
    const blob = await response.blob()
    await uploadLogoBlob(blob, `${websiteHostname.value || 'website-logo'}.png`)
    return true
  }
  catch (error) {
    console.error('Failed to fetch imported logo', error)
    toast.error(t('organization-onboarding-imported-logo-failed'))
    return false
  }
}

function openLogoPicker() {
  logoInputRef.value?.click()
}

async function onLogoSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return

  if (selectedLogoPreview.value)
    URL.revokeObjectURL(selectedLogoPreview.value)
  selectedLogoPreview.value = URL.createObjectURL(file)
  await uploadLogoBlob(file, file.name)
  input.value = ''
}

async function skipLogo() {
  if (activeOrgId.value)
    organizationStore.setCurrentOrganization(activeOrgId.value)
  step.value = 'invite'
  await syncRouteQuery('invite')
}

function openInviteModal() {
  if (!activeOrgId.value) {
    toast.error(t('organization-not-found'))
    return
  }
  organizationStore.setCurrentOrganization(activeOrgId.value)
  inviteModalRef.value?.openDialog()
}

async function finishOnboarding() {
  const draft = appDraft.value
  const orgId = activeOrgId.value

  try {
    await organizationStore.fetchOrganizations()
    if (orgId)
      organizationStore.setCurrentOrganization(orgId)
  }
  catch (error) {
    console.error('Failed to refresh organizations before finishing onboarding', error)
  }

  if (draft && orgId) {
    isSubmitting.value = true
    try {
      const { app, appIdFeedback } = await createOnboardingAppFromDraft(
        supabase,
        orgId,
        draft,
        activeOrgName.value,
      )
      clearOnboardingAppDraft(main.user?.id ?? main.auth?.id)
      appDraft.value = null
      if (appIdFeedback)
        toast.info(appIdFeedback)
      await router.push(`/app/new?resume=${encodeURIComponent(app.app_id)}&step=choice`)
      return
    }
    catch (error) {
      console.error('Failed to create app from onboarding draft', error)
      toast.error(t('app-onboarding-toast-create-error'))
      return
    }
    finally {
      isSubmitting.value = false
    }
  }

  await router.push('/app/new')
}

watch(mode, (nextMode) => {
  if (nextMode === 'app-name' && appDraft.value)
    orgNameInput.value = appDraft.value.appName
})

watch(() => route.query.step, (nextValue) => {
  if (typeof nextValue !== 'string')
    return

  if (nextValue === 'details') {
    step.value = 'details'
    return
  }

  if ((nextValue === 'logo' || nextValue === 'invite') && createdOrgId.value) {
    step.value = nextValue
    return
  }

  if (nextValue === 'logo' || nextValue === 'invite')
    void syncRouteQuery('details', '')
})

watch([websiteInput, mode], () => {
  if (mode.value !== 'website') {
    websitePreview.value = null
    isLoadingWebsitePreview.value = false
    return
  }

  websitePreview.value = null
})

function applyAppDraftDefaults() {
  if (!appDraft.value || isAdditionalOrgFlow.value)
    return

  if (!mode.value)
    mode.value = 'app-name'

  if (mode.value === 'app-name' && !orgNameInput.value.trim())
    orgNameInput.value = appDraft.value.appName
}

onMounted(async () => {
  if (!main.auth) {
    await router.replace('/login?to=/onboarding/app')
    return
  }

  await organizationStore.fetchOrganizations()
  isAdditionalOrgFlow.value = typeof route.query.source === 'string'
    ? route.query.source === 'org-switcher'
    : organizationStore.organizations.some(org => !org.role.includes('invite'))

  appDraft.value = loadOnboardingAppDraft(main.user?.id ?? main.auth?.id)
  if (!appDraft.value && !isAdditionalOrgFlow.value && typeof route.query.org !== 'string') {
    await router.replace('/onboarding/app')
    return
  }

  displayStore.NavTitle = t('organization-onboarding-title')
  displayStore.defaultBack = appDraft.value ? '/onboarding/app' : '/apps'
  await hydrateOnboardingFromQuery()
  applyAppDraftDefaults()
})

onUnmounted(() => {
  if (selectedLogoPreview.value)
    URL.revokeObjectURL(selectedLogoPreview.value)
})
</script>

<template>
  <section class="h-full min-h-0 overflow-y-auto bg-slate-50 px-4 py-4 text-slate-950 sm:px-5 sm:py-6 lg:px-6 dark:bg-slate-950 dark:text-slate-50">
    <div class="relative mx-auto flex w-full max-w-3xl flex-col gap-4">
      <InviteTeammateModal ref="inviteModalRef" @success="onInviteSuccess" />
      <input
        id="org-logo-input"
        ref="logoInput"
        type="file"
        accept="image/*"
        class="hidden"
        :aria-label="t('change-org-picture')"
        @change="onLogoSelected"
      >

      <div class="flex items-center justify-between gap-3">
        <button
          v-if="hasExistingOrganization"
          type="button"
          class="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
          :aria-label="t('button-back')"
          @click="goBack"
        >
          <IconBack class="h-4 w-4 fill-current" />
          <span>{{ t('button-back') }}</span>
        </button>

        <button
          type="button"
          class="d-btn d-btn-ghost ml-auto min-h-11 text-slate-600 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white"
          data-test="onboarding-logout"
          :aria-label="t('logout')"
          :disabled="isLoggingOut"
          @click="logoutFromOnboarding"
        >
          <IconLoader v-if="isLoggingOut" class="h-4 w-4 animate-spin" />
          <span :class="{ 'sr-only': isLoggingOut }">{{ t('logout') }}</span>
        </button>
      </div>

      <div class="mx-auto w-full max-w-3xl space-y-6">
        <header>
          <div class="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm dark:border-white/15 dark:bg-slate-900/95 dark:text-slate-200">
            <IconSparkles class="h-3.5 w-3.5" />
            {{ onboardingBadge }}
          </div>
          <h1 class="mt-3 text-2xl font-semibold text-slate-950 sm:text-3xl dark:text-white">
            {{ onboardingTitle }}
          </h1>
          <p class="mt-2 text-base leading-6 text-slate-600 dark:text-slate-300">
            {{ onboardingSubtitle }}
          </p>

          <nav class="mt-6" :aria-label="t('organization-onboarding-step-details')">
            <ol class="flex items-center gap-2">
              <li
                v-for="(entry, index) in onboardingSteps"
                :key="entry.id"
                class="flex min-w-0 flex-1 items-center gap-2"
                :aria-current="isStepActive(entry.id) ? 'step' : undefined"
              >
                <span
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                  :class="isStepDone(entry.id) ? 'bg-emerald-500 text-white' : isStepActive(entry.id) ? 'bg-primary-500 text-white' : 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'"
                >
                  <IconCheck v-if="isStepDone(entry.id)" class="h-3.5 w-3.5" />
                  <span v-else>{{ index + 1 }}</span>
                </span>
                <span
                  class="hidden truncate text-sm font-medium sm:block"
                  :class="isStepActive(entry.id) ? 'text-slate-950 dark:text-white' : isStepDone(entry.id) ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-400 dark:text-slate-500'"
                >
                  {{ entry.label }}
                </span>
                <span
                  v-if="index < onboardingSteps.length - 1"
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

        <div v-if="step === 'details'" class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-white/15 dark:bg-slate-900/95">
          <div class="space-y-6">
            <div>
              <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
                {{ t('organization-onboarding-intent-question') }}
              </h2>
              <p class="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('organization-onboarding-intent-hint') }}
              </p>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button
                v-for="option in intentOptions"
                :key="option.value"
                type="button"
                class="group flex min-h-20 items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                :class="whiteCardToggleButtonClass(selectedIntent === option.value)"
                :data-test="`onboarding-intent-${option.value}`"
                @click="selectedIntent = option.value"
              >
                <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-primary-500 dark:bg-primary-500/20">
                  <component :is="option.icon" class="h-5 w-5" />
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold text-slate-950 dark:text-white">
                    {{ t(`organization-onboarding-intent-option-${option.value}-label`) }}
                  </span>
                  <span class="mt-1 block text-xs leading-5 text-slate-600 dark:text-slate-300">
                    {{ t(`organization-onboarding-intent-option-${option.value}-desc`) }}
                  </span>
                </span>
              </button>
            </div>

            <template v-if="selectedIntent">
              <div v-if="appDraft" class="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
                <div class="flex items-center gap-3">
                  <div class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-200 text-sm font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    <span>{{ appDraft.appName.slice(0, 2).toUpperCase() }}</span>
                  </div>
                  <div class="min-w-0">
                    <p class="truncate text-base font-semibold text-slate-950 dark:text-white">
                      {{ appDraft.appName }}
                    </p>
                    <p class="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {{ appDraft.appId }}
                    </p>
                  </div>
                </div>
              </div>

              <div class="border-t border-slate-200 pt-6 dark:border-white/15">
                <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
                  {{ t('organization-onboarding-question') }}
                </h2>
              </div>

              <div class="grid gap-3" :class="appDraft ? 'sm:grid-cols-3' : 'sm:grid-cols-2'">
                <button
                  v-if="appDraft"
                  type="button"
                  class="group flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                  :class="whiteCardToggleButtonClass(mode === 'app-name')"
                  data-test="onboarding-mode-app-name"
                  @click="mode = 'app-name'"
                >
                  <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-white">
                    <IconSmartphone class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-base font-semibold">{{ t('organization-onboarding-mode-app-name', { name: appDraft.appName }) }}</span>
                    <span class="mt-1 block text-sm leading-6 text-slate-500 dark:text-slate-400">
                      {{ t('organization-onboarding-mode-app-name-helper') }}
                    </span>
                  </span>
                  <IconCheck v-if="mode === 'app-name'" class="h-5 w-5 shrink-0 text-primary-500" />
                </button>
                <button
                  type="button"
                  class="group flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
                  :class="whiteCardToggleButtonClass(mode === 'website')"
                  data-test="onboarding-mode-website"
                  @click="mode = 'website'"
                >
                  <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-white">
                    <IconGlobe class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-base font-semibold">{{ t('organization-onboarding-mode-website') }}</span>
                    <span class="mt-1 block text-sm leading-6 text-slate-500 dark:text-slate-400">
                      {{ t('organization-onboarding-mode-website-helper') }}
                    </span>
                  </span>
                  <IconCheck v-if="mode === 'website'" class="h-5 w-5 shrink-0 text-primary-500" />
                </button>
                <button
                  type="button"
                  class="group flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
                  :class="whiteCardToggleButtonClass(mode === 'name')"
                  data-test="onboarding-mode-name"
                  @click="mode = 'name'"
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
                  <IconCheck v-if="mode === 'name'" class="h-5 w-5 shrink-0 text-primary-500" />
                </button>
              </div>

              <div v-if="mode === 'website'" class="space-y-3 border-t border-slate-200 pt-4 dark:border-white/15">
                <div>
                  <label for="onboarding-website-input" class="text-sm font-medium text-slate-800 dark:text-slate-200">
                    {{ t('organization-onboarding-website-label') }}
                  </label>
                  <div class="mt-2 flex flex-col gap-3 sm:flex-row">
                    <input
                      id="onboarding-website-input"
                      v-model="websiteInput"
                      type="url"
                      placeholder="https://capgo.app"
                      data-test="onboarding-website"
                      class="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                    >
                    <button
                      type="button"
                      class="d-btn min-h-11 shrink-0"
                      :class="whiteCardSecondaryButtonClass()"
                      data-test="onboarding-import-website"
                      :disabled="isLoadingWebsitePreview || !websiteInput.trim()"
                      @click="fetchWebsitePreview"
                    >
                      <IconLoader v-if="isLoadingWebsitePreview" class="h-4 w-4 animate-spin" />
                      <IconSparkles v-else class="h-4 w-4" />
                      <span>{{ t('organization-onboarding-import-website') }}</span>
                    </button>
                  </div>
                  <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400" aria-live="polite">
                    {{ websitePreview
                      ? t('organization-onboarding-website-imported')
                      : t('organization-onboarding-website-help') }}
                  </p>
                </div>
              </div>

              <div v-else-if="!mode" class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm leading-6 text-slate-500 dark:border-white/20 dark:bg-slate-950/90 dark:text-slate-400">
                {{ t('organization-onboarding-choice-hint') }}
              </div>

              <template v-if="canShowOrgDetails">
                <div v-if="orgNameInput.trim() || importedLogoUrl" class="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
                  <div class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-200 text-sm font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    <img
                      v-if="importedLogoUrl"
                      :src="importedLogoUrl"
                      :alt="t('organization-onboarding-logo-preview-alt', { name: orgNameInput || t('organization-onboarding-org-placeholder') })"
                      class="h-full w-full object-cover"
                    >
                    <span v-else>{{ (orgNameInput || 'O').slice(0, 2).toUpperCase() }}</span>
                  </div>
                  <div class="min-w-0">
                    <p class="truncate text-base font-semibold text-slate-950 dark:text-white">
                      {{ orgNameInput || t('organization-onboarding-org-placeholder') }}
                    </p>
                    <p v-if="websiteHostname" class="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {{ websiteHostname }}
                    </p>
                  </div>
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
                    class="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/10 sm:text-sm dark:border-white/20 dark:bg-slate-950/90 dark:text-white dark:placeholder:text-slate-500 dark:focus:border-primary-500 dark:focus:ring-primary-500/30"
                  >
                  <p v-if="mode === 'website'" class="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    {{ importedLogoUrl
                      ? t('organization-onboarding-website-name-helper')
                      : t('organization-onboarding-website-name-helper-empty') }}
                  </p>
                </div>

                <div>
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

                <div class="flex flex-col-reverse gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:justify-between dark:border-white/15">
                  <button type="button" class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" @click="goBack">
                    {{ t('cancel') }}
                  </button>
                  <button
                    type="button"
                    class="d-btn min-h-11"
                    :class="whiteCardPrimaryButtonClass()"
                    data-test="onboarding-create-org"
                    :disabled="!canCreateOrganization"
                    @click="createOrganization"
                  >
                    <span v-if="!isSubmitting">
                      {{ isCompactCreateOrgFlow
                        ? t('organization-create-submit')
                        : mode === 'website' && importedLogoUrl
                          ? t('organization-onboarding-continue-invite')
                          : t('organization-onboarding-continue-logo') }}
                    </span>
                    <IconArrowRight v-if="!isSubmitting" class="h-4 w-4" />
                    <IconLoader v-else class="h-4 w-4 animate-spin" />
                  </button>
                </div>
              </template>
            </template>
          </div>
        </div>

        <div v-else-if="step === 'logo'" class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-white/15 dark:bg-slate-900/95">
          <div class="space-y-4">
            <div>
              <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
                {{ t('organization-onboarding-logo-title') }}
              </h2>
              <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('organization-onboarding-logo-subtitle') }}
              </p>
            </div>

            <div class="flex flex-col gap-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4 sm:flex-row sm:items-center dark:border-white/20 dark:bg-slate-950/90">
              <div class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-900 text-xl font-semibold text-white dark:bg-slate-800">
                <img
                  v-if="currentOrganization?.gid === activeOrgId && currentOrganization?.logo"
                  :src="currentOrganization.logo"
                  :alt="t('organization-onboarding-logo-alt', { name: activeOrgName || t('organization-onboarding-org-placeholder') })"
                  class="h-full w-full object-cover"
                >
                <img
                  v-else-if="selectedLogoPreview"
                  :src="selectedLogoPreview"
                  :alt="t('organization-onboarding-logo-preview-alt', { name: activeOrgName || t('organization-onboarding-org-placeholder') })"
                  class="h-full w-full object-cover"
                >
                <span v-else>{{ (activeOrgName || 'O').slice(0, 2).toUpperCase() }}</span>
              </div>
              <div class="min-w-0">
                <div class="text-lg font-semibold text-slate-950 dark:text-white">
                  {{ activeOrgName || t('organization-onboarding-org-placeholder') }}
                </div>
                <div class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                  {{ t('organization-onboarding-logo-helper') }}
                </div>
                <button type="button" class="d-btn mt-3 min-h-10" :class="whiteCardSecondaryButtonClass()" data-test="onboarding-upload-logo" :disabled="isUploadingLogo" @click="openLogoPicker">
                  <IconUpload class="h-4 w-4" />
                  {{ t('organization-onboarding-upload-logo') }}
                </button>
              </div>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                v-if="importedLogoUrl"
                type="button"
                class="d-btn min-h-11"
                :class="whiteCardPrimaryButtonClass()"
                data-test="onboarding-use-imported-logo"
                :disabled="isUploadingLogo"
                @click="useImportedLogo"
              >
                <IconSparkles class="h-4 w-4" />
                {{ t('organization-onboarding-use-imported-logo') }}
              </button>
              <button
                type="button"
                class="d-btn min-h-11"
                :class="hasSavedLogo ? whiteCardPrimaryButtonClass() : whiteCardSecondaryButtonClass()"
                data-test="onboarding-logo-action"
                :disabled="isUploadingLogo"
                @click="skipLogo"
              >
                {{ hasSavedLogo ? t('button-next') : t('skip') }}
                <IconArrowRight v-if="hasSavedLogo" class="h-4 w-4" />
              </button>
            </div>
            <p v-if="hasSavedLogo" class="text-sm font-medium text-emerald-600 dark:text-emerald-300" aria-live="polite">
              {{ t('organization-onboarding-logo-saved') }}
            </p>
          </div>
        </div>

        <div v-else-if="step === 'invite'" class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-white/15 dark:bg-slate-900/95">
          <div class="space-y-4">
            <div>
              <h2 class="text-lg font-semibold text-slate-950 dark:text-white">
                {{ t('organization-onboarding-invite-title') }}
              </h2>
              <p class="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {{ t('organization-onboarding-invite-subtitle') }}
              </p>
            </div>

            <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-white/15 dark:bg-slate-950/90">
              <div class="flex items-start gap-4">
                <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white dark:bg-slate-800">
                  <IconBuilding class="h-5 w-5" />
                </div>
                <div class="min-w-0">
                  <div class="truncate text-base font-semibold text-slate-950 dark:text-white">
                    {{ activeOrgName || t('organization-onboarding-org-placeholder') }}
                  </div>
                  <p class="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
                    {{ inviteSuccessCount > 0
                      ? t('organization-onboarding-invite-success-state')
                      : t('organization-onboarding-invite-empty-state') }}
                  </p>
                </div>
              </div>

              <ul v-if="inviteSuccessCount > 0" class="mt-4 space-y-3">
                <li
                  v-for="invite in sentInvites"
                  :key="invite.email"
                  class="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/15 dark:bg-slate-900/95"
                >
                  <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-500 text-xs font-semibold text-white">
                    {{ getInviteInitials(invite) }}
                  </div>
                  <div class="min-w-0">
                    <div class="truncate text-sm font-semibold text-slate-950 dark:text-white">
                      {{ getInviteDisplayName(invite) }}
                    </div>
                    <div class="truncate text-xs text-slate-500 dark:text-slate-400">
                      {{ invite.email }}
                    </div>
                  </div>
                </li>
              </ul>
            </div>

            <div class="flex flex-wrap gap-2">
              <button type="button" class="d-btn min-h-11" :class="whiteCardPrimaryButtonClass()" data-test="onboarding-invite-users" @click="openInviteModal">
                <IconUserPlus class="h-4 w-4" />
                {{ t('organization-onboarding-open-invite') }}
              </button>
              <button type="button" class="d-btn min-h-11" :class="whiteCardSecondaryButtonClass()" data-test="onboarding-finish" :disabled="isSubmitting" @click="finishOnboarding">
                <IconLoader v-if="isSubmitting" class="h-4 w-4 animate-spin" />
                <template v-else>
                  {{ appDraft ? t('organization-onboarding-finish-setup') : t('organization-onboarding-create-app') }}
                  <IconArrowRight class="h-4 w-4" />
                </template>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<route lang="yaml">
meta:
  middleware: auth
</route>

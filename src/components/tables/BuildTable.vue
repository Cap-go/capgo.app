<script setup lang="ts">
import type { Ref } from 'vue'
import type { TableColumn } from '../comp_def'
import type { Database } from '~/types/database.types'
import { Capacitor } from '@capacitor/core'
import { computed, defineAsyncComponent, h, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconEye from '~icons/heroicons/eye'
import IconDownload from '~icons/lucide/download'
import IconRocket from '~icons/lucide/rocket'
import IconSmartphone from '~icons/lucide/smartphone'
import IconX from '~icons/lucide/x'
import BuilderIntroduction from '~/components/dashboard/BuilderIntroduction.vue'
import BuildLiveProgress from '~/components/dashboard/BuildLiveProgress.vue'
import { hasSupportedBuilderTodoList } from '~/services/builderOnboardingChecklist'
import { dismissBuildNextSteps, isBuildActive, isBuildNextStepsDismissed, latestSucceededBuild, savedBuildState } from '~/services/buildNextSteps'
import { invokeCapgoApi } from '~/services/capgoApi'
import { defaultApiHost, useConsole } from '~/services/console'
import { formatDate } from '~/services/date'
import { rememberSimulator, simulatorConfigured, simulatorEpoch } from '~/services/simulatorSessions'
import { sendEvent } from '~/services/tracking'
import { useDialogV2Store } from '~/stores/dialogv2'
import { useOrganizationStore } from '~/stores/organization'
import { getAppGettingStartedPath } from '~/utils/onboardingRedirect'

const props = defineProps<{
  appId: string
}>()

const emit = defineEmits<{
  'update:showingSteps': [value: boolean]
}>()

type BuildRequest = Database['public']['Tables']['build_requests']['Row']
type Element = BuildRequest
type Platform = 'ios' | 'android'

const { t } = useI18n()
const router = useRouter()
const capgo = useConsole()
const isMobile = Capacitor.isNativePlatform()
const dialogStore = useDialogV2Store()
const offset = 20
const search = ref('')
// Dev-only: `?buildDemo=` opens the live build page with a scripted build (see StepsBuild).
const buildDemo = import.meta.env.DEV && !!useRoute().query.buildDemo
const showSteps = ref(buildDemo)
const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const elements = ref<Element[]>([])
const buildDurations = ref<Record<string, number>>({})
const savedOutputs = ref<Record<string, { url: string, kind: string, expires_at: string }>>({})
// Until the lookup answers, a succeeded build without output is unknown, not "not saved".
const savedOutputsReady = ref(false)
let savedOutputsKey = ''
// The build whose details replace the table (live progress, result, download, error).
const openedBuild = shallowRef<Element | null>(null)
const nextStepsDismissed = ref(isBuildNextStepsDismissed(props.appId))
// While a build can still change on its own, the table refreshes itself.
const REFRESH_MS = 10_000
let refreshTimer: ReturnType<typeof setInterval> | undefined
const savedBuildNow = ref(Date.now())
let savedBuildClock: ReturnType<typeof setInterval> | undefined
const openingJobs = ref<string[]>([])
const isLoading = ref(true)
const currentPage = ref(1)
const total = ref(0)
const totalAllBuilds = ref<number | null>(null)
const canEnableBuilder = ref(false)
const builderAccessReady = ref(false)
const buildCountsReady = ref(false)
let reloadSequence = 0
let dataSequence = 0
const platformBuildCounts = ref<Record<Platform, number>>({ ios: 0, android: 0 })
const organizationStore = useOrganizationStore()
const hasBuilderChecklist = computed(() => hasSupportedBuilderTodoList(organizationStore.getAppByAppId(props.appId)?.onboarding))
const showSetupFlow = computed(() => showSteps.value || (totalAllBuilds.value === 0 && (hasBuilderChecklist.value || builderAccessReady.value)))
const isTableLoading = computed(() => isLoading.value || (elements.value.length === 0 && !buildCountsReady.value) || (totalAllBuilds.value === 0 && !builderAccessReady.value))
const AppOnboardingFlow = defineAsyncComponent(() => import('~/components/dashboard/AppOnboardingFlow.vue'))
const builderEntitlement = computed(() => {
  const org = organizationStore.getOrgByAppId(props.appId)
  return org?.paying ? 'plan' as const : (org?.trial_left ?? 0) > 0 ? 'trial' as const : null
})
const filters = ref({})

const currentBuildsNumber = computed(() => {
  return (currentPage.value - 1) * offset
})

function closeSteps() {
  showSteps.value = false
}

function addOne() {
  showSteps.value = true
}

function onboardingDone() {
  showSteps.value = false
  reload()
}

async function countBuildRequests(platform?: Platform): Promise<number | null> {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId || !props.appId)
    return null

  let query = capgo
    .from('build_requests')
    .select('id', { count: 'exact', head: true })
    .eq('owner_org', orgId)
    .eq('app_id', props.appId)

  if (platform)
    query = query.eq('platform', platform)

  const { count, error } = await query
  if (error) {
    console.error('Error counting build requests:', error)
    return null
  }
  return count ?? 0
}

async function updateOverallBuildsCount(): Promise<void> {
  const sequence = reloadSequence
  const appId = props.appId
  try {
    const [allBuilds, iosBuilds, androidBuilds] = await Promise.all([
      countBuildRequests(),
      countBuildRequests('ios'),
      countBuildRequests('android'),
    ])
    if (!isCurrentLoad(sequence, appId))
      return

    if (allBuilds !== null)
      totalAllBuilds.value = allBuilds

    platformBuildCounts.value = {
      ios: iosBuilds ?? platformBuildCounts.value.ios,
      android: androidBuilds ?? platformBuildCounts.value.android,
    }
  }
  finally {
    if (isCurrentLoad(sequence, appId))
      buildCountsReady.value = true
  }
}

function isCurrentLoad(sequence: number, appId: string) {
  return sequence === reloadSequence && appId === props.appId
}

async function getData(silent = false) {
  // Don't load if organization isn't ready yet
  if (!organizationStore.currentOrganization) {
    return
  }
  const orgId = organizationStore.currentOrganization.gid
  const appId = props.appId
  const sequence = reloadSequence
  const request = ++dataSequence
  const isCurrent = () => request === dataSequence && isCurrentLoad(sequence, appId)

  if (!silent)
    isLoading.value = true
  try {
    let query = capgo
      .from('build_requests')
      .select('*', { count: 'exact' })
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .range(currentBuildsNumber.value, currentBuildsNumber.value + offset - 1)

    if (search.value) {
      query = query.or(`platform.ilike.%${search.value}%,status.ilike.%${search.value}%,builder_job_id.ilike.%${search.value}%`)
    }

    const { data, error, count } = await query
    if (!isCurrent())
      return

    if (error) {
      console.error('Error fetching build requests:', error)
      toast.error(t('error-fetching-builds'))
      return
    }

    const builds = data || []
    const durations = await loadBuildDurations(builds, orgId)
    if (!isCurrent())
      return
    buildDurations.value = durations ?? {}
    if (durations === null)
      toast.error(t('error-fetching-build-durations'))
    elements.value = builds
    total.value = count || 0
    if (isCurrent())
      await loadSavedOutputs(builds, isCurrent, silent)
  }
  catch (error) {
    if (!isCurrent())
      return
    console.error(error)
    toast.error(t('error-fetching-builds'))
  }
  finally {
    if (isCurrent())
      isLoading.value = false
  }
}

async function loadBuildDurations(builds: Element[], orgId: string): Promise<Record<string, number> | null> {
  const jobIds = builds
    .map(build => build.builder_job_id)
    .filter((id): id is string => !!id)

  if (jobIds.length === 0)
    return {}

  // Scope to the current org: build_logs.build_id is only unique per
  // (build_id, org_id), so an unscoped lookup could pick up a colliding
  // row from another org the user can read.
  const { data, error } = await capgo
    .from('build_logs')
    .select('build_id, build_time_unit')
    .eq('org_id', orgId)
    .in('build_id', jobIds)

  if (error) {
    console.error('Error fetching build durations:', error)
    return null
  }

  const durations: Record<string, number> = {}
  for (const log of data ?? []) {
    if (log.build_id != null && log.build_time_unit != null)
      durations[log.build_id] = log.build_time_unit
  }
  return durations
}

async function reload() {
  // Don't reload if organization isn't ready yet
  if (!organizationStore.currentOrganization) {
    return
  }

  currentPage.value = 1
  elements.value = []
  total.value = 0
  buildDurations.value = {}
  savedOutputs.value = {}
  savedOutputsReady.value = false
  savedOutputsKey = ''
  openedBuild.value = null
  nextStepsDismissed.value = isBuildNextStepsDismissed(props.appId)
  platformBuildCounts.value = { ios: 0, android: 0 }
  canEnableBuilder.value = false
  builderAccessReady.value = false
  buildCountsReady.value = false
  isLoading.value = true
  totalAllBuilds.value = null
  const sequence = ++reloadSequence
  const appId = props.appId
  try {
    const loadAccess = async () => {
      try {
        const { data, error } = await invokeCapgoApi<{ canEnable: boolean }>(`app/${encodeURIComponent(appId)}/onboarding/builder`, { method: 'GET' })
        if (isCurrentLoad(sequence, appId))
          canEnableBuilder.value = !error && data?.canEnable === true
      }
      finally {
        if (isCurrentLoad(sequence, appId))
          builderAccessReady.value = true
      }
    }
    await Promise.all([getData(), updateOverallBuildsCount(), loadAccess()])
  }
  catch (error) {
    console.error(error)
    toast.error(t('error-fetching-builds'))
  }
}

function isPlanUpgradeError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase()
  return normalized.includes('concurrent native')
    || normalized.includes('native build concurrency')
    || normalized.includes('/settings/organization/plans')
    || normalized.includes('upgrade plan to continue to build')
}

function showErrorDetails(errorMessage: string | null) {
  if (!errorMessage) {
    toast.error(t('no-error-message'))
    return
  }

  const showUpgrade = isPlanUpgradeError(errorMessage)
  dialogStore.openDialog({
    title: t('build-error-details'),
    size: 'lg',
    buttons: [
      ...(showUpgrade
        ? [{
            text: t('plan-upgrade-v2'),
            id: 'upgrade',
            role: 'primary' as const,
            handler: () => {
              router.push('/settings/organization/plans')
            },
          }]
        : []),
      {
        text: t('close'),
        role: 'cancel',
      },
    ],
  })

  // Wait for dialog to mount, then inject the content
  setTimeout(() => {
    const contentDiv = document.getElementById('dialog-v2-content')
    if (contentDiv) {
      const pre = document.createElement('pre')
      pre.className = 'p-4 overflow-x-auto font-mono text-sm break-words whitespace-pre-wrap bg-gray-100 rounded-md dark:bg-gray-800'
      pre.textContent = errorMessage
      contentDiv.replaceChildren(pre)
    }
  }, 0)
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return 'text-green-600 dark:text-green-400'
    case 'failed':
      return 'text-red-600 dark:text-red-400'
    case 'running':
    case 'in_progress':
      return 'text-blue-600 dark:text-blue-400'
    case 'pending':
      return 'text-yellow-600 dark:text-yellow-400'
    default:
      return 'text-gray-600 dark:text-gray-400'
  }
}

async function loadSavedOutputs(builds: Element[], current: () => boolean, silent = false) {
  const jobIds = builds.filter(build => build.status === 'succeeded' && build.builder_job_id).map(build => build.builder_job_id as string)
  const key = jobIds.join(',')
  // Auto-refresh only asks the builder again when a build newly succeeded.
  if (silent && key === savedOutputsKey)
    return
  if (jobIds.length === 0) {
    savedOutputs.value = {}
    savedOutputsReady.value = true
    savedOutputsKey = key
    return
  }
  try {
    const { data } = await capgo.auth.getSession()
    const token = data.session?.access_token
    if (!token)
      return
    const response = await fetch(`${defaultApiHost}/private/simulator/outputs?app_id=${encodeURIComponent(props.appId)}&job_ids=${encodeURIComponent(jobIds.join(','))}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok)
      return
    const body = await response.json() as { outputs?: Record<string, { url: string, kind: string, expires_at: string }> }
    if (current()) {
      savedOutputs.value = body.outputs ?? {}
      savedOutputsReady.value = true
      savedOutputsKey = key
    }
  }
  catch {
    if (current())
      savedOutputs.value = {}
  }
}

async function openSavedBuild(jobId: string) {
  if (openingJobs.value.includes(jobId))
    return
  const appId = props.appId
  const epoch = simulatorEpoch()
  const output = savedOutputs.value[jobId]
  const tab = window.open('', '_blank')
  if (!output?.expires_at || Date.parse(output.expires_at) <= Date.now()) {
    tab?.close()
    toast.error(t('saved-build-expired'))
    return
  }
  openingJobs.value = [...openingJobs.value, jobId]
  try {
    const { data } = await capgo.auth.getSession()
    const token = data.session?.access_token
    if (!token)
      throw new Error(t('simulator-sign-in'))
    const response = await fetch(`${defaultApiHost}/private/simulator/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ app_id: appId, platform: 'ios', build_job_id: jobId }),
    })
    const payload = await response.json() as { message?: string, error?: string, data?: { id?: string, url?: string, install_error?: string | null } }
    if (!response.ok)
      throw new Error(payload.message || payload.error || t('simulator-did-not-start'))
    const url = payload.data?.url || ''
    if (payload.data?.id && epoch === simulatorEpoch())
      rememberSimulator(appId, { id: payload.data.id, url })
    if (url && tab)
      tab.location.replace(url)
    else
      tab?.close()
    if (payload.data?.install_error)
      toast.error(payload.data.install_error)
  }
  catch (error) {
    tab?.close()
    toast.error(error instanceof Error ? error.message : t('simulator-did-not-start'))
  }
  finally {
    openingJobs.value = openingJobs.value.filter(id => id !== jobId)
  }
}

function savedOutputFor(elem: Element) {
  return elem.builder_job_id ? savedOutputs.value[elem.builder_job_id] : undefined
}

// A simulator button only where it can work: an iOS .ipa, on a server with a simulator host.
function canOpenInSimulator(elem: Element) {
  return savedOutputFor(elem)?.kind === 'ios_ipa' && simulatorConfigured.value !== false
}

function savedBuildCell(elem: Element) {
  const output = savedOutputFor(elem)
  const state = savedOutputsReady.value || output ? savedBuildState(elem, output, savedBuildNow.value) : 'none'
  if (state === 'expired' || state === 'not-saved') {
    return h('span', {
      'class': 'text-xs text-slate-500 dark:text-slate-400',
      'title': t(state === 'expired' ? 'saved-build-expired-hint' : 'saved-build-not-saved-hint'),
      'data-test': `saved-build-${state}`,
    }, t(state === 'expired' ? 'saved-build-expired-short' : 'saved-build-not-saved'))
  }
  if (state !== 'available')
    return h('span', { class: 'text-gray-400 dark:text-gray-600' }, '-')
  const jobId = elem.builder_job_id as string
  const opening = openingJobs.value.includes(jobId)
  const children = [
    h('a', {
      'href': output?.url,
      'target': '_blank',
      'rel': 'noopener',
      'class': 'd-btn d-btn-xs d-btn-primary gap-1 text-white',
      'data-test': 'saved-build-download',
      'onClick': (event: Event) => {
        event.stopPropagation()
        track('Build Next Step Clicked', { action: 'download', source: 'table' })
      },
    }, [h(IconDownload, { class: 'h-3.5 w-3.5' }), t('download-saved-build')]),
  ]
  if (canOpenInSimulator(elem)) {
    children.push(h('button', {
      'type': 'button',
      'class': 'd-btn d-btn-xs d-btn-outline shrink-0',
      'disabled': opening,
      'data-test': 'saved-build-simulator',
      'onClick': (event: Event) => {
        event.stopPropagation()
        track('Build Next Step Clicked', { action: 'simulator', source: 'table' })
        void openSavedBuild(jobId)
      },
    }, opening ? t('simulator-starting') : t('open-in-simulator')))
  }
  return h('div', { class: 'flex items-center gap-2' }, children)
}

function track(event: string, tags: Record<string, string>) {
  const orgId = organizationStore.currentOrganization?.gid
  if (!orgId)
    return
  void sendEvent({
    channel: 'builder',
    event,
    org_id: orgId,
    tracking_version: 2,
    nonPersonTags: { app_id: props.appId, ...tags },
  })
}

function openBuild(elem: Element) {
  openedBuild.value = elem
  track('Build Row Opened', { status: elem.status, platform: elem.platform })
}

function closeBuild() {
  openedBuild.value = null
  void getData(true)
}

function retryBuild() {
  openedBuild.value = null
  addOne()
}

// Shown once the app has a succeeded build, until dismissed on this browser.
const nextStepsBuild = computed<Element | undefined>(() => nextStepsDismissed.value || currentPage.value !== 1 || search.value ? undefined : latestSucceededBuild(elements.value) as Element | undefined)
const nextStepsOutput = computed(() => nextStepsBuild.value ? savedOutputFor(nextStepsBuild.value) : undefined)

function nextStepInstall() {
  track('Build Next Step Clicked', { action: 'install' })
  if (nextStepsBuild.value)
    openBuild(nextStepsBuild.value)
}

function nextStepSimulator() {
  const jobId = nextStepsBuild.value?.builder_job_id
  track('Build Next Step Clicked', { action: 'simulator' })
  if (jobId)
    void openSavedBuild(jobId)
}

function nextStepLiveUpdates() {
  track('Build Next Step Clicked', { action: 'live_updates' })
  router.push({ path: getAppGettingStartedPath(props.appId), query: { showChecklist: '1' } })
}

function dismissNextSteps() {
  track('Build Next Step Clicked', { action: 'dismiss' })
  dismissBuildNextSteps(props.appId)
  nextStepsDismissed.value = true
}

const hasActiveBuild = computed(() => elements.value.some(build => isBuildActive(build.status)))

function stopAutoRefresh() {
  clearInterval(refreshTimer)
  refreshTimer = undefined
}

watch(hasActiveBuild, (active) => {
  stopAutoRefresh()
  if (!active)
    return
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !isLoading.value)
      void getData(true)
  }, REFRESH_MS)
})

function formatDuration(seconds: number | null | undefined): string {
  const safeSeconds = Math.max(0, Math.floor(seconds ?? 0))
  if (safeSeconds < 60)
    return `${safeSeconds}s`

  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  if (minutes < 60)
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

columns.value = [
  {
    label: t('created-at'),
    key: 'created_at',
    onClick: openBuild,
    mobile: true,
    class: 'truncate max-w-32',
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.created_at ?? ''),
  },
  {
    label: t('build-mode'),
    key: 'build_mode',
    onClick: openBuild,
    mobile: true,
    class: 'truncate max-w-32',
    displayFunction: (elem: Element) => {
      const platform = elem.platform || ''
      const mode = elem.build_mode || ''
      return `${platform} ${mode}`.trim() || '-'
    },
  },
  {
    label: t('build-duration'),
    key: 'build_duration',
    onClick: openBuild,
    class: 'truncate max-w-24',
    displayFunction: (elem: Element) => {
      const jobId = elem.builder_job_id
      const duration = jobId ? buildDurations.value[jobId] : undefined
      return duration != null ? formatDuration(duration) : '—'
    },
  },
  {
    label: t('status'),
    key: 'status',
    onClick: openBuild,
    mobile: true,
    class: 'truncate max-w-24',
    renderFunction: (elem: Element) => h('span', { 'title': t('build-row-open'), 'data-test': 'build-row-status' }, elem.status),
  },
  {
    label: t('error'),
    key: 'last_error',
    onClick: openBuild,
    mobile: true,
    class: 'max-w-48',
    displayFunction: (elem: Element) => {
      if (!elem.last_error)
        return '-'
      return elem.last_error.length > 50 ? `${elem.last_error.substring(0, 50)}...` : elem.last_error
    },
  },
  {
    label: t('saved-build'),
    key: 'artifact',
    mobile: true,
    class: 'max-w-48',
    renderFunction: savedBuildCell,
  },
  {
    label: t('updated-at'),
    key: 'updated_at',
    onClick: openBuild,
    class: 'truncate max-w-32',
    displayFunction: (elem: Element) => formatDate(elem.updated_at ?? ''),
  },
]

// Watch props change (app switching) - same pattern as BundleTable
watch(props, async () => {
  await reload()
})

// Ensure totalAllBuilds is populated on initial mount so the setup flow
// renders when the org has no builds yet. watch(props, ...) doesn't fire
// for the initial value, and DataTable's @reload hook only calls getData().
onMounted(async () => {
  savedBuildClock = setInterval(() => {
    savedBuildNow.value = Date.now()
  }, 30_000)
  await organizationStore.awaitInitialLoad()
  await reload()
})

onUnmounted(() => {
  if (savedBuildClock)
    clearInterval(savedBuildClock)
  stopAutoRefresh()
})

watch(() => showSetupFlow.value || !!openedBuild.value, (newValue) => {
  emit('update:showingSteps', newValue)
}, { immediate: true })
</script>

<template>
  <div>
    <AppOnboardingFlow
      v-if="!buildDemo && totalAllBuilds === 0 && hasBuilderChecklist"
      :key="props.appId"
      :setup-app-id="props.appId"
      initial-checklist-path="builder"
      hide-footer
      show-checklist
      onboarding
    />
    <BuilderIntroduction
      v-else-if="!buildDemo && totalAllBuilds === 0 && canEnableBuilder"
      :key="props.appId"
      :app-id="props.appId"
      :entitlement="builderEntitlement"
    />
    <StepsBuild
      v-else-if="showSetupFlow"
      :onboarding="(totalAllBuilds ?? 0) === 0"
      :app-id="props.appId"
      :platform-build-counts="platformBuildCounts"
      :can-close="(totalAllBuilds ?? 0) > 0"
      @done="onboardingDone"
      @close-step="closeSteps()"
    />
    <div v-else-if="openedBuild" data-test="build-detail">
      <BuildLiveProgress
        :key="openedBuild.id"
        :app-id="props.appId"
        :build-id="openedBuild.id"
        :platform="openedBuild.platform === 'ios' ? 'ios' : 'android'"
        closable
        @close="closeBuild"
        @done="closeBuild"
        @retry="retryBuild"
      >
        <template #success-actions>
          <button
            v-if="canOpenInSimulator(openedBuild)"
            type="button"
            class="d-btn d-btn-outline gap-2"
            :disabled="openingJobs.includes(openedBuild.builder_job_id ?? '')"
            data-test="build-detail-simulator"
            @click="track('Build Next Step Clicked', { action: 'simulator', source: 'detail' }); openSavedBuild(openedBuild.builder_job_id ?? '')"
          >
            <IconSmartphone class="h-4 w-4" />
            {{ openingJobs.includes(openedBuild.builder_job_id ?? '') ? t('simulator-starting') : t('open-in-simulator') }}
          </button>
          <p v-else-if="savedOutputFor(openedBuild)?.kind === 'ios_ipa'" class="self-center text-sm text-slate-500 dark:text-slate-400" data-test="build-detail-simulator-unavailable">
            {{ t('simulator-not-configured-hint') }}
          </p>
        </template>
      </BuildLiveProgress>
    </div>
    <div v-else class="flex flex-col gap-6">
      <section
        v-if="nextStepsBuild"
        class="relative p-5 bg-white border shadow-sm rounded-xl border-emerald-300 dark:bg-slate-800/60 dark:border-emerald-500/40"
        data-test="build-next-steps"
      >
        <button
          type="button"
          class="absolute d-btn d-btn-ghost d-btn-sm d-btn-square top-3 right-3"
          :aria-label="t('build-next-steps-dismiss')"
          data-test="build-next-steps-dismiss"
          @click="dismissNextSteps"
        >
          <IconX class="w-4 h-4" />
        </button>
        <h3 class="text-lg font-semibold text-slate-950 dark:text-white">
          {{ t('build-next-steps-title') }}
        </h3>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {{ t('build-next-steps-subtitle', { platform: nextStepsBuild.platform === 'ios' ? t('build-platform-ios') : t('build-platform-android') }) }}
        </p>
        <div class="grid gap-4 mt-4 md:grid-cols-3">
          <div class="flex flex-col items-start gap-2 p-4 border rounded-lg border-slate-200 dark:border-white/10">
            <p class="text-sm text-slate-600 dark:text-slate-300">
              {{ t('build-next-steps-install-hint') }}
            </p>
            <button type="button" class="mt-auto text-white d-btn d-btn-sm d-btn-primary gap-2" data-test="build-next-steps-install" @click="nextStepInstall">
              <IconDownload class="w-4 h-4" />
              {{ t('build-next-steps-install') }}
            </button>
          </div>
          <div v-if="nextStepsOutput?.kind === 'ios_ipa'" class="flex flex-col items-start gap-2 p-4 border rounded-lg border-slate-200 dark:border-white/10">
            <p class="text-sm text-slate-600 dark:text-slate-300">
              {{ simulatorConfigured === false ? t('simulator-not-configured-hint') : t('build-next-steps-simulator-hint') }}
            </p>
            <button
              v-if="simulatorConfigured !== false"
              type="button"
              class="mt-auto d-btn d-btn-sm d-btn-outline gap-2"
              :disabled="openingJobs.includes(nextStepsBuild.builder_job_id ?? '')"
              data-test="build-next-steps-simulator"
              @click="nextStepSimulator"
            >
              <IconSmartphone class="w-4 h-4" />
              {{ openingJobs.includes(nextStepsBuild.builder_job_id ?? '') ? t('simulator-starting') : t('build-next-steps-simulator') }}
            </button>
          </div>
          <div class="flex flex-col items-start gap-2 p-4 border rounded-lg border-slate-200 dark:border-white/10">
            <p class="text-sm text-slate-600 dark:text-slate-300">
              {{ t('build-next-steps-live-updates-hint') }}
            </p>
            <button type="button" class="mt-auto d-btn d-btn-sm d-btn-outline gap-2" data-test="build-next-steps-live-updates" @click="nextStepLiveUpdates">
              <IconRocket class="w-4 h-4" />
              {{ t('build-next-steps-live-updates') }}
            </button>
          </div>
        </div>
      </section>
      <div class="flex flex-col overflow-hidden overflow-y-auto bg-white border shadow-sm md:rounded-xl border-slate-200 dark:bg-slate-800/60 dark:border-white/10" data-test="build-table">
        <DataTable
          v-model:filters="filters"
          v-model:search="search"
          v-model:current-page="currentPage"
          :columns="columns"
          :element-list="elements"
          :is-loading="isTableLoading"
          :search-function="(e: Element, s: string) => e.platform.toLowerCase().includes(s.toLowerCase()) || e.status.toLowerCase().includes(s.toLowerCase())"
          :search-placeholder="t('search-builds')"
          :show-add="!isMobile"
          :total="total"
          :offset="offset"
          @add="addOne()"
          @reset="reload()"
          @reload="getData()"
        >
          <template #status="{ element }">
            <span
              class="font-semibold"
              :class="getStatusColor(element.status)"
            >
              {{ element.status }}
            </span>
          </template>
          <template #last_error="{ element }">
            <div v-if="element.last_error" class="flex items-center gap-2">
              <span class="max-w-xs text-red-600 truncate dark:text-red-400">
                {{ element.last_error.length > 50 ? `${element.last_error.substring(0, 50)}...` : element.last_error }}
              </span>
              <button
                type="button"
                class="p-1 text-gray-500 rounded-md cursor-pointer shrink-0 dark:text-gray-400 hover:text-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                :aria-label="t('build-error-details')"
                @click.stop="showErrorDetails(element.last_error)"
              >
                <IconEye class="w-4 h-4" />
              </button>
              <button
                v-if="isPlanUpgradeError(element.last_error)"
                type="button"
                class="px-2 py-1 text-xs font-semibold text-white rounded-md d-btn d-btn-xs d-btn-primary shrink-0"
                @click.stop="router.push('/settings/organization/plans')"
              >
                {{ t('plan-upgrade-v2') }}
              </button>
            </div>
            <span v-else class="text-gray-400 dark:text-gray-600">-</span>
          </template>
          <template #empty>
            <div class="flex flex-col items-center justify-center p-8">
              <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
                {{ t('no-builds-yet') }}
              </h3>
              <p class="max-w-md text-center text-gray-600 dark:text-gray-400">
                {{ t('no-builds-description') }}
              </p>
            </div>
          </template>
        </DataTable>
      </div>
    </div>
  </div>
</template>

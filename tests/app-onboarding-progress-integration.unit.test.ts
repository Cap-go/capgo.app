// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { URL as NodeUrl } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import AppOnboardingFlow from '../src/components/dashboard/AppOnboardingFlow.vue'

const writerMocks = vi.hoisted(() => ({
  main: {
    auth: { id: 'user-bento-retry' },
    authGeneration: 1,
    isAdmin: false,
    plans: [],
    user: {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      onboarding: {},
    },
  },
  refreshUser: vi.fn(),
  replaceUserOnboardingIfUnchanged: vi.fn(),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('~/services/onboardingTracking', () => ({ sendOnboardingEvent: vi.fn() }))
vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://sb.capgo.app', supaKey: 'anon-key' }),
  isLocal: () => false,
  useSupabase: () => {
    const query = {
      eq: () => query,
      maybeSingle: writerMocks.refreshUser,
      select: () => query,
    }
    return { from: () => query }
  },
}))
vi.mock('~/services/userOnboardingWriteQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/userOnboardingWriteQueue')>()
  return {
    ...actual,
    replaceUserOnboardingIfUnchanged: writerMocks.replaceUserOnboardingIfUnchanged,
  }
})
vi.mock('~/stores/dashboardApps', () => ({ useDashboardAppsStore: () => ({ upsertApp: vi.fn() }) }))
vi.mock('~/stores/dialogv2', () => ({
  useDialogV2Store: () => ({
    lastButtonRole: null,
    onDialogDismiss: vi.fn(async () => undefined),
    openDialog: vi.fn(),
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => writerMocks.main }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: null,
    organizations: [],
    updateAppOnboarding: vi.fn(),
  }),
}))

const onboardingSource = readFileSync(new NodeUrl('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new NodeUrl('../src/components/Sidebar.vue', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string) {
  const startIndex = onboardingSource.indexOf(start)
  const endIndex = onboardingSource.indexOf(end)
  if (startIndex === -1)
    throw new Error(`Missing start marker in AppOnboardingFlow.vue: ${start}`)
  if (endIndex === -1 || endIndex < startIndex)
    throw new Error(`Missing end marker in AppOnboardingFlow.vue: ${end}`)
  return onboardingSource.slice(startIndex, endIndex)
}

function expectSourceOrder(source: string, markers: string[]) {
  let previousIndex = -1
  for (const marker of markers) {
    const index = source.indexOf(marker, previousIndex + 1)
    expect(index, `Expected source marker after previous marker: ${marker}`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
}

describe('app onboarding progress analytics integration', () => {
  it.concurrent('forwards document visibility changes and removes the listener on teardown', () => {
    const visibilityHandler = sourceBetween('function trackOnboardingVisibilityChange()', 'function initializeProgressTracking(')
    expect(visibilityHandler).toContain('const visibilityChange = { state: document.visibilityState, occurredAt: Date.now() }')
    expectSourceOrder(visibilityHandler, [
      'if (!progressTracker)',
      'if (isHydratingOnboarding.value || onboardingInitialPersistInFlight)',
      'pendingVisibilityChanges.push(visibilityChange)',
      'return',
    ])
    expect(visibilityHandler).toContain('progressTracker.trackVisibilityChange(visibilityChange.state, visibilityChange.occurredAt)')
    expect(onboardingSource).toContain(`document.addEventListener('visibilitychange', trackOnboardingVisibilityChange)`)
    expect(onboardingSource).toContain(`document.removeEventListener('visibilitychange', trackOnboardingVisibilityChange)`)

    const initializer = sourceBetween('function initializeProgressTracking(', 'function completeAndViewStep(')
    expectSourceOrder(initializer, [
      'progressTracker.viewStep(initialStep)',
      'for (const visibilityChange of pendingVisibilityChanges)',
      'progressTracker.trackVisibilityChange(visibilityChange.state, visibilityChange.occurredAt)',
      'pendingVisibilityChanges = []',
    ])
  })

  it('preserves server-owned state from the refreshed CAS snapshot on retry', async () => {
    const previousUser = writerMocks.main.user
    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const initialBentoEvents = {
      'cli:command_invoked': {
        details: [{ observed_at: '2026-08-22T10:00:00.000Z' }],
        occurrence_count: 1,
        sent_at: '2026-08-22T10:00:01.000Z',
      },
    }
    const refreshedBentoEvents = {
      'cli:command_invoked': {
        details: [
          { observed_at: '2026-08-22T10:00:00.000Z' },
          { observed_at: '2026-08-22T10:05:00.000Z' },
        ],
        occurrence_count: 2,
        sent_at: '2026-08-22T10:05:01.000Z',
      },
    }
    const initialABTests = {
      new_emails: {
        assigned_at: '2026-08-23T13:15:06.300Z',
        branch: 'A',
      },
    }
    const refreshedABTests = {
      new_emails: {
        assigned_at: '2026-08-23T13:15:06.300Z',
        branch: 'B',
      },
    }
    const initialOnboarding = {
      abtests: initialABTests,
      bento_events: initialBentoEvents,
      future_server_state: { revision: 1 },
    }
    const refreshedOnboarding = {
      abtests: refreshedABTests,
      bento_events: refreshedBentoEvents,
      future_server_state: { revision: 2 },
    }
    writerMocks.refreshUser.mockReset()
    writerMocks.replaceUserOnboardingIfUnchanged.mockReset()
    writerMocks.main.user = {
      id: 'user-bento-retry',
      image_url: 'avatar.png',
      onboarding: initialOnboarding,
    }
    writerMocks.refreshUser.mockResolvedValueOnce({
      data: { ...writerMocks.main.user, onboarding: refreshedOnboarding },
      error: null,
    })
    writerMocks.replaceUserOnboardingIfUnchanged
      .mockResolvedValueOnce({ data: null, error: null })
      .mockImplementation(async (_userId, _expectedOnboarding, onboarding) => ({
        data: { ...writerMocks.main.user, onboarding },
        error: null,
      }))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })
    const container = document.createElement('div')
    const app = createApp(AppOnboardingFlow, { onboarding: true, preOrg: true })
    app.config.warnHandler = () => undefined

    try {
      app.mount(container)
      await vi.waitFor(() => expect(writerMocks.replaceUserOnboardingIfUnchanged).toHaveBeenCalledTimes(2))

      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        abtests: initialABTests,
        bento_events: initialBentoEvents,
        future_server_state: { revision: 1 },
      }))
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[1]).toEqual(refreshedOnboarding)
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
        abtests: refreshedABTests,
        bento_events: refreshedBentoEvents,
        future_server_state: { revision: 2 },
      }))
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[2]?.abtests).not.toEqual(initialABTests)
      expect(writerMocks.replaceUserOnboardingIfUnchanged.mock.calls[1]?.[2]?.bento_events).not.toEqual(initialBentoEvents)
    }
    finally {
      app.unmount()
      writerMocks.main.user = previousUser
      if (matchMediaDescriptor)
        Object.defineProperty(window, 'matchMedia', matchMediaDescriptor)
      else
        Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it.concurrent('initializes tracking once the real initial or resumed step is resolved', () => {
    const analyticsImport = sourceBetween(
      'import {\n  createOnboardingDetailsFieldDebouncer,',
      'import { createOnboardingProgressPersistence',
    )
    expect(analyticsImport).toContain('createOnboardingProgressTracker,')
    expect(analyticsImport).toContain('createOnboardingTelemetryIdentity,')
    expect(analyticsImport).toContain(`} from '~/utils/onboardingProgressAnalytics'`)

    const initializer = sourceBetween('function initializeProgressTracking(', 'function completeAndViewStep(')
    expect(initializer).toContain(`flow: props.preOrg ? 'pre_org' : 'existing_org'`)
    expect(initializer).toContain(`const initialStep: OnboardingAnalyticsStep = showPreOrgWelcome.value ? 'welcome' : analyticsStepFor(flowStep.value)`)
    expect(initializer).toContain('const trackedSteps = appOnboardingSteps.value.flatMap<OnboardingAnalyticsStep>')
    expect(initializer).toContain('return Object.values(APP_DETAILS_ANALYTICS_STEPS)')
    expect(initializer).toContain(`trackedSteps.unshift('welcome')`)
    expect(initializer).toContain(`if (!props.preOrg && resumed && flowStep.value === 'setup')`)
    expect(initializer).toContain(`trackedSteps.push('setup')`)
    expect(initializer).toContain('steps: trackedSteps')
    expect(initializer).toContain('resumed,')
    expect(initializer).toContain('onboardingAttemptId: onboardingTelemetry.attemptId')
    expect(initializer).toContain('onboardingRunId: onboardingTelemetry.runId')
    expect(initializer).toContain('progressTracker.viewStep(initialStep)')
    expect(initializer.match(/\.viewStep\(/g)).toHaveLength(1)

    const resumeDialog = sourceBetween('async function maybeResumeSavedOnboarding()', 'function whiteCardToggleButtonClass(')
    expect(resumeDialog).toContain('onboardingTelemetry.prepareResumeCandidate({')
    expect(resumeDialog).toContain('onboardingTelemetry.recordResumeDialogViewed()')
    expect(resumeDialog).toContain('onboardingTelemetry.recordResumeContinued()')
    expect(resumeDialog).toContain('onboardingTelemetry.recordResumeRestarted()')
    expect(resumeDialog).not.toContain('.viewStep(')
    expectSourceOrder(resumeDialog, [
      'onboardingTelemetry.prepareResumeCandidate({',
      'dialogStore.openDialog({',
      'onboardingTelemetry.recordResumeDialogViewed()',
      'await dialogStore.onDialogDismiss()',
    ])

    const restartCheck = `if (dialogStore.lastButtonRole === 'onboarding-resume-restart')`
    expectSourceOrder(resumeDialog, [
      'await dialogStore.onDialogDismiss()',
      'if (onboardingFlowDisposed)',
      'return null',
      restartCheck,
    ])
    const restartBranchStart = resumeDialog.indexOf(restartCheck)
    const restartBranchEnd = resumeDialog.indexOf('\n  }\n', restartBranchStart)
    expect(restartBranchStart).toBeGreaterThan(resumeDialog.indexOf('await dialogStore.onDialogDismiss()'))
    expect(restartBranchEnd).toBeGreaterThan(restartBranchStart)
    const restartBranch = resumeDialog.slice(restartBranchStart, restartBranchEnd)
    expectSourceOrder(restartBranch, [
      restartCheck,
      'onboardingTelemetry.recordResumeRestarted()',
      'resetOnboardingForm()',
      'return false',
    ])
    const continueCheck = `if (dialogStore.lastButtonRole !== 'onboarding-resume-continue')`
    expectSourceOrder(resumeDialog.slice(restartBranchEnd), [
      continueCheck,
      'return null',
      'onboardingTelemetry.recordResumeContinued()',
      'applyOnboardingProgress(saved)',
      'return true',
    ])
    expect(resumeDialog.match(/return null/g)).toHaveLength(2)

    const resumeLoader = sourceBetween('async function loadResumeApp()', 'async function importStoreMetadata()')
    expect(resumeLoader).not.toContain('initializeProgressTracking')
    expect(resumeLoader).not.toContain('viewStep')

    const mountedFlow = sourceBetween('onMounted(async () => {', 'onBeforeUnmount(() => {')
    expect(onboardingSource).toContain(`import { createOnboardingProgressPersistence, shouldInitializeOnboardingProgressTracking } from '~/utils/onboardingProgressPersistence'`)
    expect(mountedFlow).toContain('let resumedFlow = false')
    expectSourceOrder(mountedFlow, [
      'const resumeResult = await maybeResumeSavedOnboarding()',
      'if (resumeResult === null)',
      'onboardingProgressPersistence.abort()',
      'return',
      'resumedFlow = resumeResult',
    ])
    expect(mountedFlow).toContain('const resumed = await loadResumeApp()')
    expect(mountedFlow).toContain('resumedFlow = resumed')
    expect(mountedFlow).not.toContain('.viewStep(')
    expect(mountedFlow.match(/initializeProgressTracking\(resumedFlow\)/g)).toHaveLength(1)
    expect(mountedFlow.match(/persistOnboardingProgress\(\)/g)).toHaveLength(2)
    const finallyBlock = mountedFlow.slice(mountedFlow.indexOf('finally {'))
    expect(finallyBlock).toContain('initializeProgressTracking(resumedFlow)')
    expectSourceOrder(mountedFlow, [
      'resumedFlow = resumeResult',
      'finally {',
      'isHydratingOnboarding.value = false',
      'await persistOnboardingProgress()',
      'isLoading.value = false',
      'initializeProgressTracking(resumedFlow)',
    ])
  })

  it.concurrent('persists telemetry identity metadata with each progress snapshot', () => {
    const snapshot = sourceBetween('function snapshotOnboardingProgress(', 'async function persistOnboardingProgress(')
    expect(snapshot).toContain('const telemetry = onboardingTelemetry.getProgressMetadata()')
    expect(snapshot).toContain('onboardingAttemptId: telemetry.onboardingAttemptId')
    expect(snapshot).toContain('lastRunId: telemetry.lastRunId')
  })

  it.concurrent('delegates persistence serialization and barriers to the tested controller', () => {
    expect(onboardingSource).toContain(`import type { OnboardingPersistOptions, OnboardingPersistResult } from '~/utils/onboardingProgressPersistence'`)
    expect(onboardingSource).not.toContain(`type OnboardingPersistResult = 'persisted' | 'retryable_failure' | 'conflict' | 'skipped'`)
    expect(onboardingSource).not.toContain('let persistChain')
    expect(onboardingSource).not.toContain('let onboardingMountAborted')
    expect(onboardingSource).not.toContain('let onboardingPersistenceBlocked')
    expect(onboardingSource).toContain('const onboardingProgressPersistence = createOnboardingProgressPersistence({')
    expect(onboardingSource).toContain('replaceUserOnboardingIfUnchanged,')
    expect(onboardingSource).toContain('serializeUserOnboardingWrite,')
    expect(onboardingSource).toContain('write: writeOnboardingProgress,')
    expect(onboardingSource).toContain(`onError: error => console.error('Failed to persist onboarding progress', error),`)

    const persistenceQueue = sourceBetween('async function persistOnboardingProgress(', 'function schedulePersistOnboardingProgress(')
    expect(persistenceQueue).toContain(`status: UserOnboardingStatus = 'in_progress'`)
    expect(persistenceQueue).toContain('options: OnboardingPersistOptions = {}')
    expect(persistenceQueue).toContain('return onboardingProgressPersistence.persist(status, options)')
    expect(persistenceQueue).not.toContain('writeOnboardingProgress(status)')
    expect(persistenceQueue).not.toContain('initializeProgressTracking')

    const writer = sourceBetween('async function writeOnboardingProgress(', 'function resetOnboardingForm(')
    expect(writer).toContain(`if (!userId || isHydratingOnboarding.value)\n    return 'skipped'`)
    expect(writer).toContain('return serializeUserOnboardingWrite(userId, async () => {')
    expect(writer).toContain('main.authGeneration !== authGeneration')
    expect(writer).toContain('(onboardingFlowDisposed && !options.allowDisposed)')
    expect(writer).toContain('attempt < MAX_USER_ONBOARDING_WRITE_ATTEMPTS')
    expect(writer).toContain(`if (current?.status === 'completed' && status !== 'completed')`)
    expect(writer).toContain('await replaceUserOnboardingIfUnchanged(')
    expectSourceOrder(writer, [
      'const onboardingWithPreferences = preserveAdminDashboardMinimize(',
      'const onboarding = mergeUserOnboardingProgress(',
      'await replaceUserOnboardingIfUnchanged(',
    ])
    expectSourceOrder(writer, [
      'if (error) {',
      `console.error('Failed to persist onboarding progress', error)`,
      `return 'retryable_failure'`,
    ])
    expect(writer).toContain('if (data) {')
    expect(writer).toContain('main.user = { ...data, image_url: main.user.image_url }')
    expect(writer).toContain(`return 'persisted'`)
    expect(writer).toContain(`return status === 'completed' ? 'skipped' : 'conflict'`)

    const noRowRefresh = writer.slice(writer.indexOf('const { data: latest, error: latestError }'))
    expect(writer).not.toContain('onboardingProgressPersistence')
    expectSourceOrder(noRowRefresh, [
      'const { data: latest, error: latestError }',
      'if (latestError) {',
      'if (!latest)',
      'currentOnboarding = latest.onboarding',
      `return 'conflict'`,
    ])
    expect(writer.trimEnd().endsWith(`return 'conflict'\n  })\n}`)).toBe(true)
  })

  it.concurrent('initializes tracking after exhausted retryable initial writes while blocking skipped and conflict outcomes', () => {
    expect(onboardingSource).toContain('let onboardingFlowDisposed = false')
    expect(onboardingSource).toContain('let onboardingInitialPersistInFlight = false')
    expect(onboardingSource).not.toContain('pendingProgressTrackingResumed')

    const mountedFlow = sourceBetween('onMounted(async () => {', 'onBeforeUnmount(() => {')
    const persistenceGuard = 'if (!onboardingFlowDisposed && !onboardingProgressPersistence.isAborted()) {'
    const persistenceGuardStart = mountedFlow.indexOf(persistenceGuard)
    const persistenceGuardEnd = mountedFlow.indexOf('\n    }\n', persistenceGuardStart)
    expect(persistenceGuardStart).toBeGreaterThan(mountedFlow.indexOf('isHydratingOnboarding.value = false'))
    expect(persistenceGuardEnd).toBeGreaterThan(persistenceGuardStart)
    const initialPersistence = mountedFlow.slice(persistenceGuardStart, persistenceGuardEnd)
    expect(initialPersistence.match(/persistOnboardingProgress\(\)/g)).toHaveLength(2)
    expect(mountedFlow).toContain('function finishOnboardingMount()')
    expectSourceOrder(mountedFlow, [
      `let onboardingPersistResult: OnboardingPersistResult = 'skipped'`,
      persistenceGuard,
      'onboardingInitialPersistInFlight = true',
      'onboardingPersistResult = await persistOnboardingProgress()',
      `if (onboardingPersistResult === 'retryable_failure' && !onboardingFlowDisposed)`,
      'onboardingPersistResult = await persistOnboardingProgress()',
      'onboardingInitialPersistInFlight = false',
      'if (onboardingFlowDisposed || onboardingProgressPersistence.isAborted())',
      'return',
      'isLoading.value = false',
      'shouldInitializeOnboardingProgressTracking(',
      'aborted: onboardingProgressPersistence.isAborted()',
      'disposed: onboardingFlowDisposed',
      'initializeProgressTracking(resumedFlow)',
      'finishOnboardingMount()',
    ])
    expect(mountedFlow).toContain(`if (shouldInitializeProgressTracking)
        initializeProgressTracking(resumedFlow)`)
    expect(mountedFlow).toContain(`else
        pendingVisibilityChanges = []`)

    const scheduledPersistence = sourceBetween('function schedulePersistOnboardingProgress(', 'async function writeOnboardingProgress(')
    expectSourceOrder(scheduledPersistence, [
      'if (isHydratingOnboarding.value || onboardingProgressPersistence.isBlocked() || onboardingProgressPersistence.isAborted())',
      'return',
      'persistFieldsTimer = setTimeout',
      'void persistOnboardingProgress()',
    ])

    const unmountFlow = sourceBetween('onBeforeUnmount(() => {', 'watch(existingApp,')
    expectSourceOrder(unmountFlow, [
      'onboardingFlowDisposed = true',
      'if (!isHydratingOnboarding.value && !onboardingInitialPersistInFlight && !onboardingProgressPersistence.isBlocked() && !onboardingProgressPersistence.isAborted())',
      `void persistOnboardingProgress('in_progress', { allowDisposed: true })`,
    ])
  })

  it.concurrent('retains the existing intent compatibility event', () => {
    expect(onboardingSource).toContain(`sendOnboardingEvent('onboarding_intent_selected', {`)
  })

  it.concurrent('keeps Maker+ invitations inside the organization progress step', () => {
    expect(onboardingSource).toContain(`createAppRecord({ nextStep: shouldInvite ? 'organization' : 'setup' })`)
    expect(onboardingSource).toContain(`trackOrganizationEvent('onboarding_organization_invite_viewed')`)
    expect(onboardingSource).toContain(`completeAndViewStep('setup', { appId: createdApp.value.app_id })`)
  })

  it.concurrent('keeps the unload warning scoped to unfinished pre-org onboarding', () => {
    expect(onboardingSource).toContain('useBeforeUnloadWarning(Boolean(props.preOrg))')
    const creation = sourceBetween('async function createOrganizationAndApp()', 'async function createAppRecord(')
    expect(creation.indexOf('if (!createdApp.value)')).toBeLessThan(creation.indexOf('removeBeforeUnloadWarning()'))
  })

  it.concurrent('tracks only successful forward transitions with approved context', () => {
    const transitionHelpers = sourceBetween('function completeAndViewStep(', 'function whiteCardToggleButtonClass(')
    expect(transitionHelpers).toContain('progressTracker?.completeStep(previousAnalyticsStep, {')
    expect(transitionHelpers).toContain('nextStep: nextAnalyticsStep,')
    expect(transitionHelpers).toContain('progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)')
    expect(transitionHelpers).toContain('void persistOnboardingProgress()')

    const intentTransition = sourceBetween('function continueFromIntent()', 'function continuePreOrgDetails()')
    expect(intentTransition).toContain(`completeAndViewStep('details', { intent: selectedIntent.value })`)

    const appNameTransition = sourceBetween('function continueFromAppName()', 'function continueFromAppId()')
    expect(appNameTransition).toContain(`completeAndViewAppDetailsStep('app_id', { appId: generatedAppId.value, appName: appName.value.trim() })`)

    const preOrgDetailsTransition = sourceBetween('function continuePreOrgDetails()', 'async function createOrganizationAndApp()')
    expect(preOrgDetailsTransition).toContain(`completeAndViewStep('organization', {`)
    expect(preOrgDetailsTransition).toContain('storeImportUsed: hasImportedStoreMetadata.value')

    const appCreation = sourceBetween('async function createAppRecord(', 'async function seedDemoData()')
    expect(appCreation).toContain('appId,')
    expect(appCreation).toContain('completionProperties.storeImportUsed = hasImportedStoreMetadata.value')
    expect(appCreation).toContain('completeAndViewStep(options?.nextStep ?? \'choice\', completionProperties)')

    const realSetupChoice = sourceBetween('function goToInstallStep()', 'function openDashboard()')
    expect(realSetupChoice).toContain(`completeAndViewStep('install', {`)
    expect(realSetupChoice).toContain('appId: createdApp.value.app_id')
  })

  it.concurrent('reports back navigation as a new view without completing the abandoned step', () => {
    const backNavigation = sourceBetween('function viewPreviousStep(', 'function snapshotOnboardingProgress(')
    expect(backNavigation).not.toContain('completeStep')
    expect(backNavigation).toContain('progressTracker?.viewStep(nextAnalyticsStep, previousAnalyticsStep)')
    expect(onboardingSource).toContain('@click="viewPreviousStep(\'choice\')"')
    expect(onboardingSource).toContain('@click="viewPreviousStep(\'details\')"')
    expect(onboardingSource).toContain(`props.preOrg ? viewPreviousStep('intent') : router.push('/apps')`)
    expect(onboardingSource).not.toContain('@click="flowStep = \'details\'"')
    expect(onboardingSource).not.toContain('@click="flowStep = \'choice\'"')
    expect(onboardingSource).not.toContain(`props.preOrg ? (flowStep = 'intent') : router.push('/apps')`)
  })

  it.concurrent('completes only terminal install or setup exits and leaves demo selection incomplete', () => {
    const demoAction = sourceBetween('async function seedDemoData()', 'async function copyText(')
    expect(demoAction).not.toContain('completeStep')
    expect(demoAction).not.toContain('completeAndViewStep')
    expect(demoAction).toContain('allowOnboardingDashboardExploration')
    expect(demoAction).toContain('/getting-started')

    const dashboardExit = sourceBetween('function openDashboard()', 'onMounted(async () => {')
    expect(dashboardExit).toContain(`if (flowStep.value === 'install' || flowStep.value === 'setup')`)
    expect(dashboardExit).toContain('progressTracker?.completeStep(flowStep.value, {')
    expect(dashboardExit).toContain('appId: createdApp.value.app_id')
    expect(dashboardExit).toContain(`await persistOnboardingProgress('completed')`)
    expect(dashboardExit).toContain('/getting-started')
    expect(dashboardExit.indexOf('completeStep')).toBeLessThan(dashboardExit.indexOf('router.push'))
    expect(dashboardExit).toContain('window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))')
    expect(onboardingSource).toContain('progressTracker?.trackDashboardExplored(createdApp.value?.app_id)')
    expect(onboardingSource).toContain('window.addEventListener(ONBOARDING_DASHBOARD_EXPLORED_EVENT, trackDashboardExplored)')
    expect(onboardingSource).toContain('window.removeEventListener(ONBOARDING_DASHBOARD_EXPLORED_EVENT, trackDashboardExplored)')
    expect(onboardingSource).toContain('pendingDashboardExplored = true')
    expect(onboardingSource).toContain('if (pendingDashboardExplored)')

    const demoExit = sourceBetween('async function seedDemoData()', 'async function copyText(')
    expect(demoExit).toContain('window.dispatchEvent')
    expect(demoExit).toContain('allowOnboardingDashboardExploration')
    expect(demoExit.indexOf('window.dispatchEvent')).toBeLessThan(demoExit.indexOf('allowOnboardingDashboardExploration'))

    const confirmedSidebarExit = sidebarSource.slice(sidebarSource.indexOf('if (requiresOnboardingExplorationConfirmation)'), sidebarSource.indexOf('if (tab.onClick)'))
    expect(confirmedSidebarExit.indexOf(`lastButtonRole !== 'primary'`)).toBeLessThan(confirmedSidebarExit.indexOf('window.dispatchEvent(new Event(ONBOARDING_DASHBOARD_EXPLORED_EVENT))'))
  })
})

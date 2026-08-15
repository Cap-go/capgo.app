import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/components/Sidebar.vue', import.meta.url), 'utf8')

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
  it.concurrent('initializes tracking once the real initial or resumed step is resolved', () => {
    expect(onboardingSource).toContain(`import { createOnboardingDetailsFieldDebouncer, createOnboardingProgressTracker, createOnboardingTelemetryIdentity } from '~/utils/onboardingProgressAnalytics'`)

    const initializer = sourceBetween('function initializeProgressTracking(', 'function completeAndViewStep(')
    expect(initializer).toContain(`flow: props.preOrg ? 'pre_org' : 'existing_org'`)
    expect(initializer).toContain('const trackedSteps = appOnboardingSteps.value.map(step => step.id)')
    expect(initializer).toContain(`if (!props.preOrg && resumed && flowStep.value === 'setup')`)
    expect(initializer).toContain(`trackedSteps.push('setup')`)
    expect(initializer).toContain('steps: trackedSteps')
    expect(initializer).toContain('resumed,')
    expect(initializer).toContain('onboardingAttemptId: onboardingTelemetry.attemptId')
    expect(initializer).toContain('onboardingRunId: onboardingTelemetry.runId')
    expect(initializer).toContain('progressTracker.viewStep(flowStep.value)')
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
    expect(mountedFlow).toContain('let onboardingMountAborted = false')
    expect(mountedFlow).toContain('let resumedFlow = false')
    expectSourceOrder(mountedFlow, [
      'const resumeResult = await maybeResumeSavedOnboarding()',
      'if (resumeResult === null)',
      'onboardingMountAborted = true',
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

  it.concurrent('distinguishes persisted, retryable, conflict, and skipped progress outcomes', () => {
    expect(onboardingSource).toContain(`type OnboardingPersistResult = 'persisted' | 'retryable_failure' | 'conflict' | 'skipped'`)

    const persistenceQueue = sourceBetween('async function persistOnboardingProgress(', 'function schedulePersistOnboardingProgress(')
    const blockedWriteGuard = `if (onboardingPersistenceBlocked && status !== 'completed')`
    expect(persistenceQueue).toContain(`status: UserOnboardingStatus = 'in_progress'`)
    expectSourceOrder(persistenceQueue, [
      blockedWriteGuard,
      `return 'skipped'`,
      'persistChain = persistChain',
    ])
    expect(persistenceQueue.match(/if \(onboardingPersistenceBlocked && status !== 'completed'\)/g)).toHaveLength(2)
    const queuedPersistence = persistenceQueue.slice(persistenceQueue.indexOf('persistChain = persistChain'))
    expectSourceOrder(queuedPersistence, [
      '.then(() => {',
      blockedWriteGuard,
      `return 'skipped'`,
      'return writeOnboardingProgress(status)',
      `return 'retryable_failure'`,
      'return persistChain',
    ])

    const writer = sourceBetween('async function writeOnboardingProgress(', 'function resetOnboardingForm(')
    expect(writer).toContain(`if (!userId || isHydratingOnboarding.value)\n    return 'skipped'`)
    expect(writer).toContain(`if (current?.status === 'completed' && status !== 'completed')\n    return 'skipped'`)
    expectSourceOrder(writer, [
      'if (error) {',
      `console.error('Failed to persist onboarding progress', error)`,
      `return 'retryable_failure'`,
    ])
    expect(writer).toContain('if (data && main.user?.id === userId) {')
    expect(writer).toContain(`main.user = { ...data, image_url: main.user.image_url }\n    return 'persisted'`)
    expect(writer).toContain(`if (status === 'completed' || main.user?.id !== userId)\n    return 'skipped'`)

    const noRowRefresh = writer.slice(writer.indexOf('const { data: latest, error: latestError }'))
    const noRowConflict = writer.slice(writer.indexOf(`if (status === 'completed' || main.user?.id !== userId)`))
    expectSourceOrder(noRowConflict, [
      `return 'skipped'`,
      'onboardingPersistenceBlocked = true',
      'const { data: latest, error: latestError }',
      `return 'conflict'`,
    ])
    expectSourceOrder(noRowRefresh, [
      'const { data: latest, error: latestError }',
      'if (latestError)',
      'if (latest && main.user?.id === userId)',
      `return 'conflict'`,
    ])
    expect(writer.trimEnd().endsWith(`return 'conflict'\n}`)).toBe(true)
  })

  it.concurrent('blocks tracking and later writes after an initial conflict or disposal', () => {
    expect(onboardingSource).toContain('let onboardingFlowDisposed = false')
    expect(onboardingSource).toContain('let onboardingInitialPersistInFlight = false')
    expect(onboardingSource).toContain('let onboardingPersistenceBlocked = false')

    const mountedFlow = sourceBetween('onMounted(async () => {', 'onBeforeUnmount(() => {')
    const persistenceGuard = 'if (!onboardingMountAborted) {'
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
      `if (onboardingPersistResult === 'conflict')`,
      'onboardingPersistenceBlocked = true',
      'onboardingInitialPersistInFlight = false',
      'if (onboardingFlowDisposed)',
      'return',
      'isLoading.value = false',
      '// Unpersisted telemetry identities must not emit onboarding events.',
      `if (!onboardingMountAborted && onboardingPersistResult === 'persisted')`,
      'initializeProgressTracking(resumedFlow)',
      'finishOnboardingMount()',
    ])
    expect(mountedFlow).not.toContain(`onboardingPersistResult === 'skipped'`)

    const scheduledPersistence = sourceBetween('function schedulePersistOnboardingProgress(', 'async function writeOnboardingProgress(')
    expectSourceOrder(scheduledPersistence, [
      'if (isHydratingOnboarding.value || onboardingPersistenceBlocked)',
      'return',
      'persistFieldsTimer = setTimeout',
      'void persistOnboardingProgress()',
    ])

    const unmountFlow = sourceBetween('onBeforeUnmount(() => {', 'watch(existingApp,')
    expectSourceOrder(unmountFlow, [
      'onboardingFlowDisposed = true',
      'if (!isHydratingOnboarding.value && !onboardingInitialPersistInFlight && !onboardingPersistenceBlocked)',
      'void persistOnboardingProgress()',
    ])
  })

  it.concurrent('retains the existing intent compatibility event', () => {
    expect(onboardingSource).toContain(`pushEvent('onboarding_intent_selected', config.supaHost, {`)
  })

  it.concurrent('keeps the unload warning scoped to unfinished pre-org onboarding', () => {
    expect(onboardingSource).toContain('useBeforeUnloadWarning(Boolean(props.preOrg))')
    const creation = sourceBetween('async function createOrganizationAndApp()', 'async function createAppRecord(')
    expect(creation.indexOf('if (!createdApp.value)')).toBeLessThan(creation.indexOf('removeBeforeUnloadWarning()'))
  })

  it.concurrent('tracks only successful forward transitions with approved context', () => {
    const transitionHelpers = sourceBetween('function completeAndViewStep(', 'function whiteCardToggleButtonClass(')
    expect(transitionHelpers).toContain('progressTracker?.completeStep(previousStep, {')
    expect(transitionHelpers).toContain('nextStep,')
    expect(transitionHelpers).toContain('progressTracker?.viewStep(nextStep, previousStep)')
    expect(transitionHelpers).toContain('void persistOnboardingProgress()')

    const intentTransition = sourceBetween('function continueFromIntent()', 'function continuePreOrgDetails()')
    expect(intentTransition).toContain(`completeAndViewStep('details', { intent: selectedIntent.value })`)

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
    const backNavigation = sourceBetween('function viewPreviousStep(', 'function whiteCardToggleButtonClass(')
    expect(backNavigation).not.toContain('completeStep')
    expect(backNavigation).toContain('progressTracker?.viewStep(nextStep, previousStep)')
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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string) {
  return onboardingSource.slice(onboardingSource.indexOf(start), onboardingSource.indexOf(end))
}

describe('app onboarding progress analytics integration', () => {
  it.concurrent('initializes tracking once the real initial or resumed step is resolved', () => {
    expect(onboardingSource).toContain("import { createOnboardingDetailsFieldDebouncer, createOnboardingProgressTracker } from '~/utils/onboardingProgressAnalytics'")

    const initializer = sourceBetween('function initializeProgressTracking(', 'function whiteCardToggleButtonClass(')
    expect(initializer).toContain("flow: props.preOrg ? 'pre_org' : 'existing_org'")
    expect(initializer).toContain('const trackedSteps = appOnboardingSteps.value.map(step => step.id)')
    expect(initializer).toContain("if (!props.preOrg && resumed && flowStep.value === 'setup')")
    expect(initializer).toContain("trackedSteps.push('setup')")
    expect(initializer).toContain('steps: trackedSteps')
    expect(initializer).toContain('resumed,')
    expect(initializer).toContain('progressTracker.viewStep(flowStep.value)')

    const resumeLoader = sourceBetween('async function loadResumeApp()', 'async function importStoreMetadata()')
    expect(resumeLoader).not.toContain('initializeProgressTracking')
    expect(resumeLoader).not.toContain('viewStep')

    const mountedFlow = onboardingSource.slice(onboardingSource.indexOf('onMounted(async () => {'))
    expect(mountedFlow).toContain('let resumedFlow = false')
    expect(mountedFlow).toContain('const resumed = await loadResumeApp()')
    expect(mountedFlow).toContain('resumedFlow = resumed')
    const loadingFinishedIndex = mountedFlow.indexOf('isLoading.value = false')
    const initializationIndex = mountedFlow.indexOf('initializeProgressTracking(resumedFlow)')
    expect(loadingFinishedIndex).toBeGreaterThanOrEqual(0)
    expect(initializationIndex).toBeGreaterThan(loadingFinishedIndex)
  })

  it.concurrent('retains the existing intent compatibility event', () => {
    expect(onboardingSource).toContain("pushEvent('onboarding_intent_selected', config.supaHost, {")
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

    const intentTransition = sourceBetween('function continueFromIntent()', 'function continuePreOrgDetails()')
    expect(intentTransition).toContain("completeAndViewStep('details', { intent: selectedIntent.value })")

    const preOrgDetailsTransition = sourceBetween('function continuePreOrgDetails()', 'async function createOrganizationAndApp()')
    expect(preOrgDetailsTransition).toContain("completeAndViewStep('organization', {")
    expect(preOrgDetailsTransition).toContain('storeImportUsed: hasImportedStoreMetadata.value')

    const appCreation = sourceBetween('async function createAppRecord(', 'async function seedDemoData()')
    expect(appCreation).toContain('appId,')
    expect(appCreation).toContain('completionProperties.storeImportUsed = hasImportedStoreMetadata.value')
    expect(appCreation).toContain('completeAndViewStep(options?.nextStep ?? \'choice\', completionProperties)')

    const realSetupChoice = sourceBetween('function goToInstallStep()', 'function openDashboard()')
    expect(realSetupChoice).toContain("completeAndViewStep('install', {")
    expect(realSetupChoice).toContain('appId: createdApp.value.app_id')
  })

  it.concurrent('reports back navigation as a new view without completing the abandoned step', () => {
    const backNavigation = sourceBetween('function viewPreviousStep(', 'function whiteCardToggleButtonClass(')
    expect(backNavigation).not.toContain('completeStep')
    expect(backNavigation).toContain('progressTracker?.viewStep(nextStep, previousStep)')
    expect(onboardingSource).toContain('@click="viewPreviousStep(\'choice\')"')
    expect(onboardingSource).toContain('@click="viewPreviousStep(\'details\')"')
    expect(onboardingSource).toContain("props.preOrg ? viewPreviousStep('intent') : router.push('/apps')")
    expect(onboardingSource).not.toContain('@click="flowStep = \'details\'"')
    expect(onboardingSource).not.toContain('@click="flowStep = \'choice\'"')
    expect(onboardingSource).not.toContain("props.preOrg ? (flowStep = 'intent') : router.push('/apps')")
  })

  it.concurrent('completes only terminal install or setup exits and leaves demo selection incomplete', () => {
    const demoAction = sourceBetween('async function seedDemoData()', 'async function copyText(')
    expect(demoAction).not.toContain('completeStep')
    expect(demoAction).not.toContain('completeAndViewStep')
    expect(demoAction).toContain('allowOnboardingDashboardExploration')

    const dashboardExit = sourceBetween('function openDashboard()', 'onMounted(async () => {')
    expect(dashboardExit).toContain("if (flowStep.value === 'install' || flowStep.value === 'setup')")
    expect(dashboardExit).toContain('progressTracker?.completeStep(flowStep.value, {')
    expect(dashboardExit).toContain('appId: createdApp.value.app_id')
    expect(dashboardExit.indexOf('completeStep')).toBeLessThan(dashboardExit.indexOf('router.push'))
  })
})

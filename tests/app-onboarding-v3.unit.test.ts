import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const iconInputSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingIconInput.vue', import.meta.url), 'utf8')
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

function sliceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  expect(start, `missing marker: ${startMarker}`).toBeGreaterThan(-1)
  expect(end, `missing or misplaced marker: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('pre-organization onboarding v3', () => {
  it.concurrent('splits app details into name, App ID, and icon screens', () => {
    expect(onboardingSource).toContain("type AppDetailsStep = 'name' | 'app_id' | 'icon'")
    expect(onboardingSource).toContain("const appDetailsStep = ref<AppDetailsStep>('name')")
    expect(onboardingSource).toContain('const hasProvidedAppId = computed(() => Boolean(manualAppId.value.trim() || importedStoreAppId.value.trim()))')
    expect(onboardingSource).toContain("completeAndViewAppDetailsStep('app_id', { appId: generatedAppId.value, appName: appName.value.trim() })")
    expect(onboardingSource).toContain("completeAndViewAppDetailsStep('icon')")
    expect(onboardingSource).toContain(":data-test=\"appDetailsStep === 'app_id' && !hasProvidedAppId ? 'app-onboarding-skip-app-id' : 'app-onboarding-continue'\"")
    expect(onboardingSource).toContain('function skipAppId()')
    expect(onboardingSource).toContain('function continueFromCurrentAppDetailsStep()')
    expect(onboardingSource).toContain('manualAppId.value = \'\'')
    expect(onboardingSource).toContain('continueFromAppId()')
    expect(onboardingSource).not.toContain('@click="skipAppId"')
    expect(onboardingSource).toContain('<div v-if="appDetailsStep === \'name\'" class="mb-6">')
  })

  it.concurrent('validates the generated or entered App ID before either action advances', () => {
    const appIdContinuation = sliceBetween(onboardingSource, 'function continueFromAppId()', 'function viewPreviousAppDetailsStep()')
    expect(appIdContinuation).toContain('if (!ensureValidAppId())')
    expect(appIdContinuation).toContain('function skipAppId()')
    expect(appIdContinuation).toContain('continueFromAppId()')
    expect(onboardingSource).not.toContain('app/availability')
  })

  it.concurrent('keeps the full store import on the App ID screen', () => {
    expect(onboardingSource).toContain('id="app-onboarding-v2-store-url"')
    expect(onboardingSource).toContain("const isStoreImportOpen = ref(false)")
    expect(onboardingSource).toContain('data-test="app-onboarding-toggle-store-import"')
    expect(onboardingSource).toContain('v-if="appDetailsStep === \'app_id\' && (props.preOrg || existingApp === true)"')
    expect(onboardingSource).toContain(':aria-expanded="isStoreImportOpen"')
    expect(onboardingSource).toContain('v-if="isStoreImportOpen" id="app-onboarding-store-import-panel"')
    expect(onboardingSource).toContain("trackDetailsEvent(isStoreImportOpen.value ? 'onboarding_store_import_shown' : 'onboarding_store_import_hidden')")
    expect(onboardingSource).toContain('existingApp.value = true')
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_submitted'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_succeeded'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_failed'")
    expect(onboardingSource).not.toContain("{ store_url: requestedUrl }")
    const storeImport = sliceBetween(onboardingSource, 'id="app-onboarding-v2-store-url"', "<div v-if=\"appDetailsStep === 'icon'\">")
    expect(storeImport).toContain('class="d-btn min-h-11 w-full sm:w-auto"')
  })

  it.concurrent('renders the generated App ID as code without swallowing sentence punctuation', () => {
    expect(onboardingSource).toContain('keypath="app-onboarding-app-id-generated-helper"')
    expect(onboardingSource).toContain('<template #appId>')
    expect(onboardingSource).toContain('<code class="rounded bg-slate-100')
    expect(onboardingSource).toContain('{{ suggestedAppId }}</code>')
  })

  it.concurrent('lets icon re-import change only the selected icon', () => {
    const iconImport = sliceBetween(onboardingSource, 'async function importStoreIcon()', 'function toggleStoreImport()')
    expect(iconImport).toContain("invokeCapgoApi('app/store-metadata'")
    expect(iconImport).toContain('storeIconPreview.value = importedIcon')
    expect(iconImport).toContain('selectImportedIcon(false)')
    expect(onboardingSource).toContain('function cancelPendingStoreIconImport()')
    expect(iconImport).not.toContain('appName.value =')
    expect(iconImport).not.toContain('manualAppId.value =')
    expect(iconImport).not.toContain('importedStoreAppId.value =')
    expect(onboardingSource).toContain('data-test="app-onboarding-use-imported-icon"')
    expect(onboardingSource).toContain('data-test="app-onboarding-remove-icon"')
    expect(onboardingSource).toContain('data-test="app-onboarding-import-icon-only"')
    expect(onboardingSource).toContain("const isStoreIconImportOpen = ref(false)")
    expect(onboardingSource).toContain('data-test="app-onboarding-toggle-icon-store-import"')
    expect(onboardingSource).toContain(':aria-expanded="isStoreIconImportOpen"')
    expect(onboardingSource).toContain('v-if="isStoreIconImportOpen" id="app-onboarding-icon-store-import-panel"')
    expect(onboardingSource).toContain('class="mb-6 mt-5 overflow-hidden rounded-xl')
    const iconImportPanel = sliceBetween(onboardingSource, 'id="app-onboarding-icon-store-import-panel"', '<div class="flex flex-col-reverse gap-3 border-t')
    expect(iconImportPanel).toContain('<div class="space-y-3">')
    expect(iconImportPanel).toContain('class="d-btn min-h-11 w-full sm:w-auto"')
    expect(iconImportPanel).not.toContain('sm:flex-row')
    expect(onboardingSource).not.toContain('v-if="false"')
    expect(onboardingSource).not.toContain('v-if="false && storeScreenshotPreview"')
  })

  it.concurrent('keeps the existing-app choice reachable for existing-organization creation', () => {
    expect(onboardingSource).toContain('v-if="!props.preOrg && appDetailsStep === \'name\'" class="grid gap-3 sm:grid-cols-2"')
    expect(onboardingSource).toContain('existingApp.value = props.preOrg ? true : null')
    expect(onboardingSource).toContain("toast.error(t('app-onboarding-toast-existing-required'))")
    const appChoice = sliceBetween(onboardingSource, 'v-if="!props.preOrg && appDetailsStep === \'name\'"', '<div class="contents">')
    expect(appChoice.match(/class="d-btn group h-auto min-h-32/g)).toHaveLength(2)
  })

  it.concurrent('does not restore a skipped generated App ID as a manual choice', () => {
    expect(onboardingSource).toContain("appId: selectedAppIdSource.value === 'generated' ? '' : generatedAppId.value")
  })

  it.concurrent('tracks every app-details page as a standard onboarding step', () => {
    expect(onboardingSource).toContain("type AppDetailsAnalyticsStep = 'app_name' | 'app_id' | 'app_icon'")
    expect(onboardingSource).toContain("name: 'app_name'")
    expect(onboardingSource).toContain("app_id: 'app_id'")
    expect(onboardingSource).toContain("icon: 'app_icon'")
    expect(onboardingSource).toContain("completeAndViewAppDetailsStep('app_id'")
    expect(onboardingSource).toContain("completeAndViewAppDetailsStep('icon'")
    expect(onboardingSource).not.toContain('onboarding_app_details_step_viewed')
    expect(onboardingSource).not.toContain('onboarding_app_details_step_completed')
  })

  it.concurrent('tracks app creation outcomes after the page-level funnel', () => {
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_creation_started'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_creation_succeeded'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_creation_failed'")
    expect(onboardingSource).toContain('app_id_source: creationAppIdSource')
    expect(onboardingSource).toContain('icon_source: creationIconSource')
    expect(onboardingSource).toContain('used_fallback: createResult.wasRetried')
  })

  it.concurrent('classifies restored draft icon data as a file in creation telemetry', () => {
    const iconSource = sliceBetween(onboardingSource, 'const selectedAppIconSource = computed', 'function createAiHelpPrompt()')
    expect(iconSource).toContain('resolveOnboardingAppIconSource({')
    expect(iconSource).toContain('hasSelectedIconFile: Boolean(selectedIconFile.value)')
    expect(iconSource).toContain('localIconPreview: localIconPreview.value')
  })

  it.concurrent('tracks icon-only store import interactions and outcomes', () => {
    expect(onboardingSource).toContain("'onboarding_store_icon_import_shown' : 'onboarding_store_icon_import_hidden'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_icon_import_submitted'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_icon_import_succeeded'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_icon_import_failed'")
    const resetStoreImportState = sliceBetween(onboardingSource, 'function resetStoreImportState()', 'let resumeIconLoadRun')
    expect(resetStoreImportState).toContain('cancelPendingStoreIconImport()')
    expect(resetStoreImportState).toContain("iconStoreUrl.value = ''")
    expect(resetStoreImportState).toContain('isStoreImportOpen.value = false')
    expect(resetStoreImportState).toContain('isStoreIconImportOpen.value = false')
  })

  it.concurrent('invalidates the opposite import before either store request starts', () => {
    const metadataImport = sliceBetween(onboardingSource, 'async function importStoreMetadata()', 'function cancelPendingStoreIconImport()')
    expect(metadataImport).toContain('cancelPendingStoreIconImport()')
    expect(metadataImport.indexOf('cancelPendingStoreIconImport()')).toBeLessThan(metadataImport.indexOf('const requestedRun = ++storeImportRun'))

    const iconImport = sliceBetween(onboardingSource, 'async function importStoreIcon()', 'function toggleStoreImport()')
    expect(iconImport).toContain('cancelPendingStoreImport()')
    expect(iconImport.indexOf('cancelPendingStoreImport()')).toBeLessThan(iconImport.indexOf('const requestedRun = ++storeIconImportRun'))
  })

  it.concurrent('blocks app-details navigation while either store import is pending', () => {
    expect(onboardingSource).toContain('const isAppDetailsNavigationPending = computed(() => (')
    expect(onboardingSource).toContain('isSubmitting.value || isImportingStore.value || isImportingStoreIcon.value')
    expect(onboardingSource.match(/:disabled="isAppDetailsNavigationPending"/g)).toHaveLength(2)
  })

  it.concurrent('labels the icon action as skip until an icon is provided', () => {
    const iconAction = sliceBetween(onboardingSource, ':data-test="appDetailsStep === \'app_id\'', '<IconArrowRight v-if="!isSubmitting"')
    const primaryActionLabel = sliceBetween(onboardingSource, 'const appDetailsPrimaryActionLabel = computed(() => {', 'const appNameInitial = computed')

    expect(messages['app-onboarding-skip-icon']).toBe('Skip')
    expect(primaryActionLabel).toContain("if (appDetailsStep.value === 'icon')")
    expect(primaryActionLabel).toContain("return iconPreview.value ? t('app-onboarding-continue') : t('app-onboarding-skip-icon')")
    expect(primaryActionLabel).toContain("if (appDetailsStep.value === 'app_id' && !hasProvidedAppId.value)")
    expect(primaryActionLabel).toContain("return t('app-onboarding-skip-app-id')")
    expect(iconAction).toContain('{{ appDetailsPrimaryActionLabel }}')
    expect(iconAction).not.toContain("t('app-onboarding-finish-details')")
  })

  it.concurrent('does not send raw onboarding field values to analytics', () => {
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_app_name_entered', 'app_name', 'app_name'")
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_app_id_entered', 'app_id', 'app_id'")
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_store_url_entered', 'store_url', 'app_id'")
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_store_icon_url_entered', 'icon_store_url', 'app_icon'")
    expect(onboardingSource).toContain('@input="onIconStoreUrlInput"')
    expect(onboardingSource).not.toContain('{ app_name:')
    expect(onboardingSource).not.toContain('{ store_url:')
  })

  it.concurrent('maps the visual details section to page-level analytics steps', () => {
    expect(onboardingSource).toContain('function analyticsStepFor(')
    expect(onboardingSource).toContain('return APP_DETAILS_ANALYTICS_STEPS[detailsStep]')
    expect(onboardingSource).toContain(`const initialStep: OnboardingAnalyticsStep = showPreOrgWelcome.value ? 'welcome' : analyticsStepFor(flowStep.value)`)
    expect(onboardingSource).toContain('progressTracker.viewStep(initialStep)')
    expect(onboardingSource).toContain('const previousAnalyticsStep = analyticsStepFor(previousStep)')
    expect(onboardingSource).toContain('const nextAnalyticsStep = analyticsStepFor(nextStep)')
  })

  it.concurrent('tracks native app icon picker and upload outcomes', () => {
    expect(iconInputSource).toContain("emit('pickerOpened')")
    expect(iconInputSource).toContain("emit('pickerOpenFailed')")
    expect(iconInputSource).toContain("emit('pickerClosedWithoutSelection')")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_icon_picked'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_icon_uploaded'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_icon_upload_failed'")
    expect(onboardingSource).toContain("parsedIconUrl.protocol === 'data:' && iconSourceUrl.startsWith('data:image/')")
    expect(onboardingSource).toContain("const restoredLocalIconSource = localIconPreview.value.startsWith('data:image/')")
    expect(onboardingSource).toContain('await uploadIcon(appId, restoredLocalIconSource || importedIconSource)')
  })

  it.concurrent('opens App ID guidance and tracks only the open action', () => {
    const appIdHelp = sliceBetween(onboardingSource, 'function openAppIdHelp()', 'function applyAppIdSuggestion(')
    expect(appIdHelp).toContain("trackDetailsEvent('onboarding_app_id_help_opened')")
    expect(appIdHelp).toContain('dialogStore.openDialog({')
    expect(appIdHelp).not.toContain('onDialogDismiss')
    expect(onboardingSource).toContain('class="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-6')
    expect(onboardingSource).toContain('keypath="app-onboarding-app-id-generated-helper" tag="span"')
    expect(onboardingSource).toContain("t('app-onboarding-app-id-learn-more')")
  })

  it.concurrent('imports organization details and branches to invitations above Solo', () => {
    expect(onboardingSource).toContain('data-test="onboarding-toggle-organization-import"')
    expect(onboardingSource).toContain('data-test="onboarding-organization-website"')
    expect(onboardingSource).toContain("invokeCapgoApi('private/website_preview'")
    expect(onboardingSource).toContain('!orgNameInput.value.trim() || isImportingOrganizationWebsite.value')
    expect(onboardingSource).toContain('website: websitePreview.value?.website')
    expect(onboardingSource).toContain("selectedStop.planName !== 'Solo'")
    expect(onboardingSource).toContain('<OrganizationOnboardingInvite')
    expect(onboardingSource).toContain("completeAndViewStep('setup', { appId: createdApp.value.app_id })")
  })

  it.concurrent('keeps the organization website tooltip clear of the panel and viewport edges', () => {
    const organizationImport = sliceBetween(onboardingSource, 'id="onboarding-org-name-input"', '<div v-if="existingApp === true">')

    expect(organizationImport).not.toContain('class="overflow-hidden rounded-xl')
    expect(organizationImport).toContain('class="relative flex items-center gap-2"')
    expect(organizationImport).toContain('absolute bottom-full left-0')
    expect(organizationImport).toContain('max-w-[calc(100vw-4rem)]')
    expect(organizationImport).not.toContain('-translate-x-1/2')
  })

  it.concurrent('keeps imported organization details reviewable and removable before creation', () => {
    expect(onboardingSource).toContain(':readonly="!!websitePreview"')
    expect(onboardingSource).toContain('data-test="onboarding-delete-imported-organization-details"')
    expect(onboardingSource).toContain('function deleteImportedOrganizationDetails()')
    expect(onboardingSource).toContain("organizationWebsiteInput.value = ''")
    expect(onboardingSource).toContain("t('organization-onboarding-imported-logo-label')")
    expect(onboardingSource).toContain("t('organization-onboarding-website-import-success')")
    const deletion = sliceBetween(onboardingSource, 'function deleteImportedOrganizationDetails()', 'async function uploadImportedOrganizationLogo(')
    expect(deletion).not.toContain('orgNameInput')
  })

  it.concurrent('captures the starting-out signal separately from the Solo tier', () => {
    expect(onboardingSource).toContain("value: 0")
    expect(onboardingSource).toContain("startingOut: true")
    expect(onboardingSource).toContain("data-test=\"stop.startingOut ? 'onboarding-starting-out' : 'onboarding-estimated-users-option'\"")
    expect(onboardingSource).toContain("{ 'sm:col-span-2': stop.startingOut }")
    expect(onboardingSource).toContain('startingOut: selectedStop.startingOut === true')
  })

  it.concurrent('creates both records before exposing invitations', () => {
    expect(onboardingSource).toContain('async function createOrganizationAndApp()')
    expect(onboardingSource).toContain('async function createAppRecord(')
    const creation = sliceBetween(onboardingSource, 'async function createOrganizationAndApp()', 'async function createAppRecord(')
    expect(creation).toContain('await createAppRecord(')
    expect(creation).toContain('showOrganizationInvite.value = shouldInvite')
    expect(creation.indexOf('await createAppRecord(')).toBeLessThan(creation.indexOf('showOrganizationInvite.value = shouldInvite'))
  })

  it.concurrent('retries only app creation after an App ID conflict created the organization', () => {
    const finishDetails = sliceBetween(onboardingSource, 'function finishAppDetails()', 'function returnToAppIdAfterConflict()')
    expect(finishDetails).toContain('preOrgCreatedOrganizationId.value')
    expect(finishDetails).toContain('completePreOrgAppCreation(preOrgCreatedOrganizationId.value, preOrgShouldInvite.value)')

    const conflictRecovery = sliceBetween(onboardingSource, 'function returnToAppIdAfterConflict()', 'async function uploadIcon(')
    expect(conflictRecovery).toContain("flowStep.value = 'details'")
    expect(conflictRecovery).toContain("appDetailsStep.value = 'app_id'")
    expect(conflictRecovery).toContain("progressTracker?.viewStep('app_id', previousAnalyticsStep)")

    const organizationCreation = sliceBetween(onboardingSource, 'async function createOrganizationAndApp()', 'async function createAppRecord(')
    expect(organizationCreation).toContain('preOrgCreatedOrganizationId.value = data.id')
    expect(organizationCreation).toContain('await completePreOrgAppCreation(data.id, shouldInvite)')
    expect(organizationCreation).toContain("await createAppRecord({ nextStep: shouldInvite ? 'organization' : 'setup' })")

    const appCreation = sliceBetween(onboardingSource, 'async function createAppRecord(', 'async function seedDemoData()')
    expect(appCreation).toContain('returnToAppIdAfterConflict()')
  })

  it.concurrent('shows technical delegation unconditionally on pre-org setup', () => {
    expect(onboardingSource).toContain("flowStep === 'setup' && createdApp")
    expect(onboardingSource).toContain("!props.preOrg && flowStep === 'choice'")
    const setup = sliceBetween(onboardingSource, "flowStep === 'setup' && createdApp", "!props.preOrg && flowStep === 'choice'")
    expect(setup).toContain('<TechnicalTeammateInviteCard')
    expect(setup).toContain('<OnboardingAltSetup')
    expect(setup).toContain(':compressed="compressAltSetup"')
    expect(setup).toContain('@progress="onCliStepsProgress"')
    expect(setup).toContain('analytics-channel="onboarding-v3"')
    expect(setup).toContain(':show-manual-setup-link="false"')
    expect(setup).toContain(':tracking-version="3"')
    expect(setup).toContain("t('onboarding-manual-setup-prefix')")
    expect(setup.indexOf("t('onboarding-manual-setup-prefix')")).toBeLessThan(setup.indexOf('<TechnicalTeammateInviteCard'))
    expect(setup.indexOf('<AppOnboardingCliSteps')).toBeLessThan(setup.indexOf('<TechnicalTeammateInviteCard'))
    expect(setup).not.toContain('selectedUserCountStop')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const iconInputSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingIconInput.vue', import.meta.url), 'utf8')

describe('pre-organization onboarding v3', () => {
  it.concurrent('keeps store import optional and inline for pre-organization onboarding', () => {
    expect(onboardingSource).toContain('data-test="app-onboarding-toggle-store-import"')
    expect(onboardingSource).toContain(':aria-expanded="existingAppSetup === \'import\'"')
    expect(onboardingSource).toContain('id="app-onboarding-v2-store-url"')
    expect(onboardingSource).toContain('// Store publication is unrelated to whether the user already has a mobile project.')
    expect(onboardingSource).toContain('existingApp.value = true')
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_shown')")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_hidden')")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_submitted'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_succeeded'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_store_import_failed'")
    expect(onboardingSource).not.toContain("{ store_url: requestedUrl }")
  })

  it.concurrent('does not send raw onboarding field values to analytics', () => {
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_app_name_entered', 'app_name'")
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_app_id_entered', 'app_id'")
    expect(onboardingSource).toContain("detailsFieldTracker.schedule('onboarding_store_url_entered', 'store_url'")
    expect(onboardingSource).not.toContain('{ app_name:')
    expect(onboardingSource).not.toContain('{ store_url:')
  })

  it.concurrent('tracks native app icon picker and upload outcomes', () => {
    expect(iconInputSource).toContain("emit('pickerOpened')")
    expect(iconInputSource).toContain("emit('pickerOpenFailed')")
    expect(iconInputSource).toContain("emit('pickerClosedWithoutSelection')")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_icon_picked'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_icon_uploaded'")
    expect(onboardingSource).toContain("trackDetailsEvent('onboarding_app_icon_upload_failed'")
    expect(onboardingSource).toContain("parsedIconUrl.protocol === 'data:' && iconSourceUrl.startsWith('data:image/')")
  })

  it.concurrent('opens App ID guidance and tracks only the open action', () => {
    const appIdHelp = onboardingSource.slice(onboardingSource.indexOf('function openAppIdHelp()'), onboardingSource.indexOf('function applyAppIdSuggestion('))
    expect(appIdHelp).toContain("trackDetailsEvent('onboarding_app_id_help_opened')")
    expect(appIdHelp).toContain('dialogStore.openDialog({')
    expect(appIdHelp).not.toContain('onDialogDismiss')
  })

  it.concurrent('imports organization details and branches to invitations above Solo', () => {
    expect(onboardingSource).toContain('data-test="onboarding-toggle-organization-import"')
    expect(onboardingSource).toContain('data-test="onboarding-organization-website"')
    expect(onboardingSource).toContain("invokeCapgoApi('private/website_preview'")
    expect(onboardingSource).toContain('website: websitePreview.value?.website')
    expect(onboardingSource).toContain("selectedUserCountStop.value?.planName !== 'Solo'")
    expect(onboardingSource).toContain('<OrganizationOnboardingInvite')
    expect(onboardingSource).toContain("completeAndViewStep('setup', { appId: createdApp.value.app_id })")
  })

  it.concurrent('creates both records before exposing invitations', () => {
    const creation = onboardingSource.slice(
      onboardingSource.indexOf('async function createOrganizationAndApp()'),
      onboardingSource.indexOf('async function createAppRecord('),
    )
    expect(creation.indexOf('await createAppRecord(')).toBeLessThan(creation.indexOf('showOrganizationInvite.value = shouldInvite'))
  })
})

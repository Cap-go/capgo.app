import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const iconInputSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingIconInput.vue', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string) {
  return onboardingSource.slice(onboardingSource.indexOf(start), onboardingSource.indexOf(end))
}

describe('pre-organization onboarding v2 app details', () => {
  it.concurrent('shows app name and App ID without asking about store publication', () => {
    const detailsTemplate = sourceBetween('<div v-if="flowStep === \'details\'">', '<div v-else-if="props.preOrg && flowStep === \'organization\'"')

    expect(detailsTemplate).toContain('v-if="!props.preOrg"')
    expect(detailsTemplate).toContain('data-test="app-onboarding-name"')
    expect(detailsTemplate).toContain('id="app-onboarding-app-id"')
    expect(onboardingSource).toContain('if (props.preOrg)\n    return true')
  })

  it.concurrent('keeps store import optional and inline for pre-organization onboarding', () => {
    expect(onboardingSource).toContain('data-test="app-onboarding-toggle-store-import"')
    expect(onboardingSource).toContain(':aria-expanded="existingAppSetup === \'import\'"')
    expect(onboardingSource).toContain('id="app-onboarding-v2-store-url"')
    expect(onboardingSource).toContain('// Store publication is unrelated to whether the user already has a mobile project.')
    expect(onboardingSource).toContain('existingApp.value = true')
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_store_import_shown')")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_store_import_hidden')")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_store_import_submitted'")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_store_import_succeeded'")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_store_import_failed'")
  })

  it.concurrent('tracks native app icon picker and upload outcomes', () => {
    expect(iconInputSource).toContain("emit('pickerOpened')")
    expect(iconInputSource).toContain("emit('pickerOpenFailed')")
    expect(iconInputSource).toContain("emit('pickerClosedWithoutSelection')")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_app_icon_picked'")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_app_icon_uploaded'")
    expect(onboardingSource).toContain("trackV2DetailsEvent('onboarding_app_icon_upload_failed'")
  })

  it.concurrent('opens App ID guidance and tracks only the open action', () => {
    const appIdHelp = sourceBetween('function openAppIdHelp()', 'function applyAppIdSuggestion(')
    expect(appIdHelp).toContain("trackV2DetailsEvent('onboarding_app_id_help_opened')")
    expect(appIdHelp).toContain('dialogStore.openDialog({')
    expect(appIdHelp).not.toContain('onDialogDismiss')
  })

  it.concurrent('preserves the existing-organization publication choices', () => {
    expect(onboardingSource).toContain('data-test="app-onboarding-existing-yes"')
    expect(onboardingSource).toContain('data-test="app-onboarding-existing-no"')
    expect(onboardingSource).toContain('v-if="!props.preOrg && existingApp === true"')
  })
})

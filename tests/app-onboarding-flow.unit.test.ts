import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

describe('getting started CLI onboarding accordion', () => {
  it.concurrent('keeps getting started onboarding integration and seven-step CLI translations', async () => {
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
    const accordion = await readFile(new URL('../src/components/dashboard/AppOnboardingCliSteps.vue', import.meta.url), 'utf8')
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    const gettingStarted = await readFile(new URL('../src/pages/app/[app].getting-started.vue', import.meta.url), 'utf8')
    // Getting started always embeds the onboarding setup UI in the dashboard shell.
    expect(gettingStarted).toContain(':setup-app-id="setupFlowAppId"')
    expect(gettingStarted).not.toContain('data-test="getting-started-page"')
    expect(source).toContain('data-test="app-onboarding-dont-show-again"')
    expect(source).toContain('skipOnboardingSplash')
    expect(source).toContain('leaveSplashIfAlreadySetup')
    expect(messages['getting-started-verify']).toBeTruthy()
    expect(messages['getting-started-dont-show-again']).toBeTruthy()
    expect(messages['app-onboarding-dont-show-again']).toBeTruthy()
    expect(source).toContain('reportOnboardingPatch({ source: \'ai\' })')
    expect(source).toContain('body: { onboarding: patch }')
    expect(source).not.toContain('rpc(\'report_app_onboarding_setup\'')
    expect(source).toContain('switched_to_manual')
    expect(accordion).toContain('data-test="app-onboarding-cli-steps"')
    expect(accordion).toContain('getAppOnboardingStepIds')

    // Legacy v1/v2 apps show the same seven OTA steps as every other app.
    expect(accordion).toContain('APP_ONBOARDING_OTA_V1_STEP_IDS')
    for (const id of APP_ONBOARDING_OTA_V1_STEP_IDS)
      expect(messages[`setup-checklist-step-${id}`]).toBeTruthy()
  })
})

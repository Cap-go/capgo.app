import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_V1_STEP_IDS, APP_ONBOARDING_V2_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

describe('getting started CLI onboarding accordion', () => {
  it.concurrent('keeps getting started onboarding integration and legacy CLI translations', async () => {
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
    const accordion = await readFile(new URL('../src/components/dashboard/AppOnboardingCliSteps.vue', import.meta.url), 'utf8')
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    const gettingStarted = await readFile(new URL('../src/pages/app/[app].getting-started.vue', import.meta.url), 'utf8')
    expect(gettingStarted).toContain('data-test="getting-started-verify"')
    expect(gettingStarted).toContain('data-test="getting-started-hide"')
    expect(gettingStarted).toContain('verify_getting_started')
    expect(gettingStarted).toContain('dismiss_getting_started')
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

    for (const id of new Set([...APP_ONBOARDING_V1_STEP_IDS, ...APP_ONBOARDING_V2_STEP_IDS]))
      expect(messages[`app-onboarding-cli-step-${id}`]).toBeTruthy()
  })
})

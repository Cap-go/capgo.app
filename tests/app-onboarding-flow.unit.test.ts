import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

describe('getting started CLI onboarding accordion', () => {
  it.concurrent('shows every CLI step in the getting started accordion', async () => {
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
    const accordion = await readFile(new URL('../src/components/dashboard/AppOnboardingCliSteps.vue', import.meta.url), 'utf8')
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    const gettingStarted = await readFile(new URL('../src/pages/app/[app].getting-started.vue', import.meta.url), 'utf8')
    expect(source).toContain('<AppOnboardingCliSteps')
    expect(source).toContain('<OnboardingAltSetup')
    expect(gettingStarted).toContain('<AppOnboardingCliSteps')
    expect(gettingStarted).toContain('<GettingStartedCicdPanel')
    expect(gettingStarted).toContain('liveUpdateUploadPath')
    expect(source).toContain('reportOnboardingPatch({ source: \'ai\' })')
    expect(source).toContain('switched_to_manual')
    expect(accordion).toContain('data-test="app-onboarding-cli-steps"')
    expect(accordion).toContain('APP_ONBOARDING_STEP_IDS')

    for (const id of APP_ONBOARDING_STEP_IDS)
      expect(messages[`app-onboarding-cli-step-${id}`]).toBeTruthy()
    expect(messages['getting-started-cicd']).toBeTruthy()
    expect(messages['getting-started-cicd-mode-prod_preprod_pr']).toBeTruthy()
    expect(messages['getting-started-self-test-hint']).toBeTruthy()
    expect(messages['app-onboarding-alt-setup-summary']).toBeTruthy()
  })
})

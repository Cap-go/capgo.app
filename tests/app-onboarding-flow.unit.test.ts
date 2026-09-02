import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'

describe('getting started CLI onboarding accordion', () => {
  it.concurrent('shows every CLI step in the getting started accordion', async () => {
    const accordion = await readFile(new URL('../src/components/dashboard/AppOnboardingCliSteps.vue', import.meta.url), 'utf8')
    const panel = await readFile(new URL('../src/components/dashboard/GettingStartedCliPanel.vue', import.meta.url), 'utf8')
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    const gettingStarted = await readFile(new URL('../src/pages/app/[app].getting-started.vue', import.meta.url), 'utf8')
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
    expect(gettingStarted).toContain('<GettingStartedCliPanel')
    expect(gettingStarted).toContain('@progress="onCliInstallProgress"')
    expect(gettingStarted).toContain('<GettingStartedCicdPanel')
    expect(gettingStarted).toContain('liveUpdateUploadPath')
    expect(gettingStarted).toContain('data-test="getting-started-verify"')
    expect(gettingStarted).toContain('data-test="getting-started-hide"')
    expect(gettingStarted).toContain('verify_getting_started')
    expect(gettingStarted).toContain('dismiss_getting_started')
    expect(source).toContain('leaveSplashIfAlreadySetup')
    expect(panel).toContain('p_patch: { source: \'ai\' }')
    expect(messages['getting-started-verify']).toBeTruthy()
    expect(messages['getting-started-dont-show-again']).toBeTruthy()
    expect(messages['app-onboarding-dont-show-again']).toBeTruthy()
    expect(accordion).toContain('data-test="app-onboarding-cli-steps"')
    expect(accordion).toContain('APP_ONBOARDING_STEP_IDS')
    expect(accordion).toContain('progressSignature')
    expect(accordion).not.toContain('deep: true')

    for (const id of APP_ONBOARDING_STEP_IDS)
      expect(messages[`app-onboarding-cli-step-${id}`]).toBeTruthy()
    expect(messages['getting-started-cicd']).toBeTruthy()
    expect(messages['getting-started-cicd-mode-prod_preprod_pr']).toBeTruthy()
    expect(messages['getting-started-self-test-hint']).toBeTruthy()
    expect(messages['app-onboarding-alt-setup-summary']).toBeTruthy()
  })
})

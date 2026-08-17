import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('app onboarding welcome', () => {
  it.concurrent('renders the approved welcome copy and motion affordances', async () => {
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingWelcome.vue', import.meta.url), 'utf8')
    const messages = JSON.parse(await readFile(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

    expect(messages['onboarding-welcome-eyebrow']).toBe('Good to have you here')
    expect(messages['onboarding-welcome-title']).toBe('Welcome to Capgo')
    expect(messages['onboarding-welcome-description']).toBe('You’re a few steps away from the magic of over-the-air updates — and so much more.')
    expect(messages['onboarding-welcome-cta']).toBe('Set up my first update')
    expect(source).toContain('data-test="onboarding-welcome-continue"')
    expect(source).toContain('data-test="onboarding-welcome-brand"')
    expect(source).toContain('src="/favicon.svg"')
    expect(source).toContain('onboarding-welcome-glow-shell')
    expect(source).toContain('onboarding-glow-drift')
    expect(source).not.toContain('conic-gradient')
    expect(source).not.toContain('onboarding-glow-spin')
    expect(source).toContain('onboarding-status-pulse')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
    expect(source).not.toContain('Takes about')
  })

  it.concurrent('shows only for fresh or restarted desktop pre-organization onboarding', async () => {
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
    const resumeFlow = source.slice(
      source.indexOf('async function maybeResumeSavedOnboarding()'),
      source.indexOf('function whiteCardToggleButtonClass('),
    )

    expect(source).toContain('useMediaQuery(\'(min-width: 640px) and (min-height: 640px)\')')
    expect(source).toContain('const showPreOrgWelcome = computed(() => props.preOrg && hasWelcomeCanvas.value && welcomePending.value)')
    expect(source).toContain('welcomePending.value = Boolean(props.preOrg)')
    expect(source).not.toContain('useMediaQuery(\'(min-width: 1024px)\')')
    expect(source).not.toContain('(hover: hover) and (pointer: fine)')
    expect(source).toContain('v-if="showPreOrgWelcome && !isLoading"')
    expect(resumeFlow).toContain('showWelcomeOnDesktop()')

    const restartBranch = resumeFlow.slice(
      resumeFlow.indexOf('if (dialogStore.lastButtonRole === \'onboarding-resume-restart\')'),
      resumeFlow.indexOf('if (dialogStore.lastButtonRole !== \'onboarding-resume-continue\')'),
    )
    expect(restartBranch).toContain('resetOnboardingForm()')
    expect(restartBranch).toContain('showWelcomeOnDesktop()')
    expect(restartBranch.indexOf('resetOnboardingForm()')).toBeLessThan(restartBranch.indexOf('showWelcomeOnDesktop()'))
  })

  it.concurrent('tracks welcome as the first viewed and completed onboarding step', async () => {
    const source = await readFile(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
    const analyticsSource = await readFile(new URL('../src/utils/onboardingProgressAnalytics.ts', import.meta.url), 'utf8')
    const initializeTracking = source.slice(
      source.indexOf('function initializeProgressTracking('),
      source.indexOf('function completeAndViewStep('),
    )
    const continueFromWelcome = source.slice(
      source.indexOf('function continueFromWelcome()'),
      source.indexOf('function applyOnboardingProgress('),
    )

    expect(analyticsSource).toContain(`export type OnboardingAnalyticsStep = 'welcome' | 'intent'`)
    expect(initializeTracking).toContain(`trackedSteps.unshift('welcome')`)
    expect(initializeTracking).toContain(`progressTracker.viewStep(initialStep)`)
    expect(continueFromWelcome).toContain(`completeStep('welcome', { nextStep })`)
    expect(continueFromWelcome).toContain(`viewStep(nextStep, 'welcome')`)
    expect(continueFromWelcome.indexOf(`completeStep('welcome', { nextStep })`)).toBeLessThan(continueFromWelcome.indexOf(`viewStep(nextStep, 'welcome')`))
  })

  it.concurrent('uses the focused naked onboarding layout with persistent account controls', async () => {
    const source = await readFile(new URL('../src/pages/onboarding/app.vue', import.meta.url), 'utf8')

    expect(source).toContain('data-test="onboarding-logout"')
    expect(source).not.toContain('src="/favicon.svg"')
    expect(source).toContain('layout: naked')
  })
})

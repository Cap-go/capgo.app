import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_ONBOARDING_STEP_IDS } from '../supabase/functions/_backend/utils/appOnboarding.ts'
import { buildCapgoOtaCliInitCommand, capgoLocalCliArgs } from '../src/utils/gettingStartedCli.ts'

const panelSource = readFileSync(new URL('../src/components/dashboard/GettingStartedCliPanel.vue', import.meta.url), 'utf8')
const gettingStarted = readFileSync(new URL('../src/pages/app/[app].getting-started.vue', import.meta.url), 'utf8')
const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('getting started CLI setup panel', () => {
  it.concurrent('builds the OTA init command with optional local args', () => {
    expect(capgoLocalCliArgs('http://localhost:54321', 'anon-key', false)).toEqual([])
    expect(capgoLocalCliArgs('http://localhost:54321', 'anon-key', true)).toEqual([
      '--supa-host',
      'http://localhost:54321',
      '--supa-anon',
      'anon-key',
    ])
    expect(buildCapgoOtaCliInitCommand('capgo_key', [])).toEqual({
      subcommand: 'i',
      extraArgs: [],
      command: 'npx @capgo/cli@latest i capgo_key',
    })
    expect(buildCapgoOtaCliInitCommand('capgo_key', ['--supa-host', 'http://localhost']).command)
      .toBe('npx @capgo/cli@latest i capgo_key --supa-host http://localhost')
  })

  it.concurrent('puts CLI, AI, and teammate setup on getting started instead of account onboarding', () => {
    expect(gettingStarted).toContain('<GettingStartedCliPanel')
    expect(gettingStarted).toContain('@progress="onCliInstallProgress"')
    expect(gettingStarted).toContain("step.id !== 'cicd' && step.id !== 'cli_install'")
    expect(panelSource).toContain('data-test="getting-started-cli-panel"')
    expect(panelSource).toContain('data-test="getting-started-cli-command-copy"')
    expect(panelSource).toContain('<AppOnboardingCliSteps')
    expect(panelSource).toContain('<OnboardingAltSetup')
    expect(panelSource).toContain('<TechnicalTeammateInviteCard')
    expect(panelSource).toContain("t('app-onboarding-ai-help-button')")
    expect(panelSource).toContain("t('onboarding-manual-setup-prefix')")
    expect(panelSource.indexOf("t('onboarding-manual-setup-prefix')")).toBeLessThan(panelSource.indexOf('<TechnicalTeammateInviteCard'))
    expect(panelSource.indexOf('<AppOnboardingCliSteps')).toBeLessThan(panelSource.indexOf('<TechnicalTeammateInviteCard'))
    expect(panelSource).toContain("sendOnboardingEvent('onboarding_cli_command_copied'")
    expect(panelSource).toContain("sendOnboardingEvent('onboarding_ai_instructions_copied'")
    expect(panelSource).toContain("report_app_onboarding_setup")
    expect(onboardingSource).not.toContain('<AppOnboardingCliSteps')
    expect(onboardingSource).not.toContain('<OnboardingAltSetup')
    expect(onboardingSource).not.toContain('<TechnicalTeammateInviteCard')
    expect(onboardingSource).not.toContain("flowStep === 'setup' && createdApp")
    expect(onboardingSource).not.toContain('app-onboarding-command-show')
    expect(onboardingSource).not.toContain('void loadApiKey()')
    expect(panelSource).toContain('organizationStore.getOrgByAppId(props.appId)')
    expect(panelSource).toContain('await organizationStore.awaitInitialLoad()')
    expect(onboardingSource).toContain('await goToGettingStarted()')
    expect(panelSource).toContain(':compressed="false"')

    for (const id of APP_ONBOARDING_STEP_IDS)
      expect(messages[`app-onboarding-cli-step-${id}`]).toBeTruthy()
    expect(messages['getting-started-self-test-hint']).toBeTruthy()
    expect(messages['onboarding-next-cli-install-desc']).toContain('AI assistant')
  })
})

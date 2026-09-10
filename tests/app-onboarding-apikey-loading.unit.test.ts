import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const englishMessages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('app onboarding API key loading state', () => {
  it.concurrent('does not render the terminal alternative before an organization exists', () => {
    expect(onboardingSource).toContain('<div v-if="!props.preOrg && appDetailsStep === \'icon\'" class="pt-1">')
  })

  it.concurrent('replaces every incomplete CLI command with the shared loading treatment', () => {
    expect(onboardingSource).not.toContain('{{ apiKey ?? \'[APIKEY]\' }}')
    expect(onboardingSource).toContain('<Spinner')
    expect(onboardingSource).toContain('t(\'app-onboarding-command-apikey-loading\')')
    expect(onboardingSource).not.toMatch(/role="status">\s*<div[^>]*aria-live="polite"/)
  })

  it.concurrent('prevents copying the CLI command until its API key is ready', () => {
    expect(onboardingSource).toContain('if (!apiKey.value)')
  })

  it.concurrent('renders a resumed app without waiting for API key provisioning', () => {
    const resumeLoader = onboardingSource.slice(
      onboardingSource.indexOf('async function loadResumeApp()'),
      onboardingSource.indexOf('async function importStoreMetadata('),
    )
    const mountedFlow = onboardingSource.slice(onboardingSource.indexOf('onMounted(async () => {'))
    const resumeLoadIndex = mountedFlow.indexOf('const resumed = await loadResumeApp()')
    const apiKeyProvisioningIndex = mountedFlow.indexOf('startApiKeyLoading()')

    expect(resumeLoader).not.toContain('ensureApiKey')
    expect(resumeLoadIndex).toBeGreaterThanOrEqual(0)
    expect(apiKeyProvisioningIndex).toBeGreaterThanOrEqual(0)
    expect(resumeLoadIndex).toBeLessThan(apiKeyProvisioningIndex)
    expect(mountedFlow).not.toContain('await loadApiKey()')
  })

  it.concurrent('targets the created app when a stale resume falls back to replacement creation', () => {
    const keyLoader = onboardingSource.slice(
      onboardingSource.indexOf('async function ensureApiKey('),
      onboardingSource.indexOf('async function loadResumeApp()'),
    )

    expect(keyLoader).toContain('const userId = main.user?.id ?? main.auth?.id')
    expect(keyLoader).toContain('const appId = createdApp.value?.app_id')
    expect(keyLoader).not.toContain('resumeAppId.value')
  })

  it.concurrent('retries API key loading from both CLI entry points', () => {
    const showCommand = onboardingSource.slice(
      onboardingSource.indexOf('function showCliCommand()'),
      onboardingSource.indexOf('async function reportOnboardingPatch('),
    )
    const installNavigation = onboardingSource.slice(
      onboardingSource.indexOf('function goToInstallStep()'),
      onboardingSource.indexOf('async function openDashboard()'),
    )

    expect(showCommand).toContain('startApiKeyLoading()')
    expect(installNavigation).toContain('startApiKeyLoading()')
    expect(onboardingSource).toContain('@click="showCliCommand"')
  })

  it.concurrent('renders ready commands as native DaisyUI buttons', () => {
    expect(onboardingSource).toMatch(/<button\s+v-if="apiKey"/)
    expect(onboardingSource).not.toContain(':role="apiKey ? \'button\' : \'status\'"')
  })

  it.concurrent('keeps builder API keys exclusively in the API key flag', () => {
    expect(onboardingSource).toContain('<span v-if="!usesBuilderSetupCommand" class="text-emerald-300">&nbsp;{{ apiKey }}</span>')
  })

  it.concurrent('reuses the shared intent-aware AI setup prompt', () => {
    expect(englishMessages['app-onboarding-command-apikey-loading']).toBe('Creating your secure API key…')
    expect(englishMessages['app-onboarding-ai-help-caption']).toBe('Let your AI assistant guide you through setting up Capgo. Copy the onboarding instructions to get started.')
    expect(onboardingSource).toContain('import { buildCliAiSetupPrompt } from \'~/services/cliAiPrompt\'')
    const promptBuilder = onboardingSource.slice(
      onboardingSource.indexOf('function createAiHelpPrompt()'),
      onboardingSource.indexOf('const appOnboardingSteps'),
    )
    expect(promptBuilder).toContain('return buildCliAiSetupPrompt({')
    expect(promptBuilder).toContain('organizations,')
    expect(promptBuilder).toContain('skippedOrganizations: [],')
    expect(promptBuilder).toContain('selectedIntent.value === \'publish\' ? \'builder\' : selectedIntent.value')
    expect(promptBuilder).not.toContain('t(\'app-onboarding-ai-help-prompt\'')
    expect(englishMessages['app-onboarding-ai-help-prompt']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-status-existing']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-status-new']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-with-key']).toBeUndefined()
    expect(englishMessages['app-onboarding-v2-ai-help-status']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-description']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-title']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-with-key']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-without-key']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-without-key']).toBeUndefined()
  })

  it.concurrent('always includes the API key and tracks successful copy actions', () => {
    const copyHandlerStart = onboardingSource.indexOf('async function copyAiInstructions()')
    const copyHandlerEnd = onboardingSource.indexOf('function goToInstallStep()', copyHandlerStart)
    expect(copyHandlerStart).toBeGreaterThanOrEqual(0)
    expect(copyHandlerEnd).toBeGreaterThan(copyHandlerStart)
    const copyHandler = onboardingSource.slice(copyHandlerStart, copyHandlerEnd)

    expect(copyHandler).toContain('await loadApiKey()')
    expect(copyHandler).toContain('if (!apiKey.value)')
    expect(copyHandler).toContain('await copyText(createAiHelpPrompt())')
    expect(copyHandler).toContain('trackSuccessfulCopy(\'onboarding_ai_instructions_copied\')')
    expect(copyHandler).not.toContain('dialogStore.openDialog({')
    expect(copyHandler).not.toContain('redactedCliCommand')
    expect(onboardingSource).toContain('trackSuccessfulCopy(\'onboarding_cli_command_copied\')')
  })
})

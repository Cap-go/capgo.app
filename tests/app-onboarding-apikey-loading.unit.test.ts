import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('../src/components/dashboard/GettingStartedCliPanel.vue', import.meta.url), 'utf8')
const englishMessages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('app onboarding API key loading state', () => {
  it.concurrent('keeps CLI setup off account onboarding until Getting Started', () => {
    expect(onboardingSource).not.toContain('app-onboarding-command-show')
    expect(onboardingSource).not.toContain("t('app-onboarding-command-apikey-loading')")
    expect(onboardingSource).not.toContain('void loadApiKey()')
    expect(onboardingSource).not.toContain('async function ensureApiKey()')
    expect(onboardingSource).not.toContain('async function copyCliCommand()')
  })

  it.concurrent('replaces every incomplete CLI command with the shared loading treatment', () => {
    expect(panelSource).not.toContain("{{ apiKey ?? '[APIKEY]' }}")
    expect(panelSource).toContain('<Spinner')
    expect(panelSource).toContain("t('app-onboarding-command-apikey-loading')")
    expect(panelSource).not.toMatch(/role="status">\s*<div[^>]*aria-live="polite"/)
  })

  it.concurrent('prevents copying the CLI command until its API key is ready', () => {
    expect(panelSource).toContain('if (!command)')
    expect(panelSource).toContain('if (!apiKey.value)')
  })

  it.concurrent('loads the API key on Getting Started instead of account onboarding', () => {
    const resumeLoader = onboardingSource.slice(
      onboardingSource.indexOf('async function loadResumeApp()'),
      onboardingSource.indexOf('async function importStoreMetadata('),
    )
    const mountedFlow = onboardingSource.slice(onboardingSource.indexOf('onMounted(async () => {'))
    const resumeLoadIndex = mountedFlow.indexOf('const resumed = await loadResumeApp()')

    expect(resumeLoader).not.toContain('ensureApiKey')
    expect(resumeLoadIndex).toBeGreaterThanOrEqual(0)
    expect(mountedFlow).not.toContain('void loadApiKey()')
    expect(mountedFlow).not.toContain('await loadApiKey()')
    expect(panelSource).toContain('void loadApiKey().catch')
    expect(panelSource).toContain("watch(() => organizationStore.getOrgByAppId(props.appId)?.gid")
  })

  it.concurrent('targets the created app when provisioning the Getting Started API key', () => {
    const keyLoader = panelSource.slice(
      panelSource.indexOf('async function ensureApiKey()'),
      panelSource.indexOf('function loadApiKey()'),
    )

    expect(keyLoader).toContain('await organizationStore.awaitInitialLoad()')
    expect(keyLoader).toContain('organizationStore.getOrgByAppId(props.appId)')
    expect(keyLoader).toContain('if (!orgId)')
    expect(keyLoader).toContain('appId: props.appId')
    expect(keyLoader).not.toContain('resumeAppId')
    expect(keyLoader).not.toContain('currentOrganization')
  })

  it.concurrent('renders ready commands as native DaisyUI buttons', () => {
    expect(panelSource).toMatch(/<button\s+v-if="cliParts"/)
    expect(panelSource).not.toContain(':role="apiKey ? \'button\' : \'status\'"')
  })

  it.concurrent('uses the OTA init command on Getting Started', () => {
    expect(panelSource).toContain('buildCapgoOtaCliInitCommand')
    expect(panelSource).not.toContain('build init')
    expect(onboardingSource).not.toContain('build init')
  })

  it.concurrent('provides secure onboarding copy in the English locale', () => {
    expect(englishMessages['app-onboarding-command-apikey-loading']).toBe('Creating your secure API key…')
    expect(englishMessages['app-onboarding-ai-help-caption']).toBe('Let your AI assistant guide you through setting up Capgo. Copy the onboarding instructions to get started.')
    expect(englishMessages['app-onboarding-ai-help-with-key']).toContain('do not repeat the API key in your response')
    expect(englishMessages['app-onboarding-ai-help-prompt']).toContain('3. Help me verify the installation succeeded.\n4. {apiKeyGuidance}')
    expect(englishMessages['app-onboarding-ai-help-copy-description']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-title']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-with-key']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-copy-without-key']).toBeUndefined()
    expect(englishMessages['app-onboarding-ai-help-without-key']).toBeUndefined()
  })

  it.concurrent('always includes the API key and tracks successful copy actions', () => {
    const copyHandlerStart = panelSource.indexOf('async function copyAiInstructions()')
    const copyHandlerEnd = panelSource.indexOf('function onCliStepsProgress(', copyHandlerStart)
    expect(copyHandlerStart).toBeGreaterThanOrEqual(0)
    expect(copyHandlerEnd).toBeGreaterThan(copyHandlerStart)
    const copyHandler = panelSource.slice(copyHandlerStart, copyHandlerEnd)

    expect(copyHandler).toContain('await loadApiKey()')
    expect(copyHandler).toContain('if (!apiKey.value)')
    expect(copyHandler).toContain('await copyText(createAiHelpPrompt())')
    expect(copyHandler).toContain("sendOnboardingEvent('onboarding_ai_instructions_copied'")
    expect(copyHandler).not.toContain('redactedCliCommand')
    expect(panelSource).toContain("sendOnboardingEvent('onboarding_cli_command_copied'")
    expect(onboardingSource).not.toContain("trackSuccessfulCopy('onboarding_cli_command_copied')")
  })
})

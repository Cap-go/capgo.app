import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const englishMessages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('app onboarding API key loading state', () => {
  it.concurrent('does not render the terminal alternative before an organization exists', () => {
    expect(onboardingSource).toContain('<div v-if="!props.preOrg" class="pt-1">')
  })

  it.concurrent('replaces every incomplete CLI command with the shared loading treatment', () => {
    expect(onboardingSource).not.toContain("{{ apiKey ?? '[APIKEY]' }}")
    expect(onboardingSource).toContain('<Spinner')
    expect(onboardingSource).toContain("t('app-onboarding-command-apikey-loading')")
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
    const apiKeyProvisioningIndex = mountedFlow.indexOf('void ensureApiKey().catch')

    expect(resumeLoader).not.toContain('ensureApiKey')
    expect(resumeLoadIndex).toBeGreaterThanOrEqual(0)
    expect(apiKeyProvisioningIndex).toBeGreaterThanOrEqual(0)
    expect(resumeLoadIndex).toBeLessThan(apiKeyProvisioningIndex)
    expect(mountedFlow).not.toContain('await ensureApiKey()')
  })

  it.concurrent('renders ready commands as native DaisyUI buttons', () => {
    expect(onboardingSource).toMatch(/<button\s+v-if="apiKey"/)
    expect(onboardingSource).not.toContain(':role="apiKey ? \'button\' : \'status\'"')
  })

  it.concurrent('keeps builder API keys exclusively in the API key flag', () => {
    expect(onboardingSource).toContain('<span v-if="!usesBuilderSetupCommand" class="text-emerald-300">&nbsp;{{ apiKey }}</span>')
  })

  it.concurrent('provides concise loading copy in the English locale', () => {
    expect(englishMessages['app-onboarding-command-apikey-loading']).toBe('Creating your secure API key…')
  })
})

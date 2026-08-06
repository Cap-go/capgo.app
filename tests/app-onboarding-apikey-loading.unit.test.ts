import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const onboardingSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const englishMessages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8')) as Record<string, string>

describe('app onboarding API key loading state', () => {
  it.concurrent('replaces every incomplete CLI command with the shared loading treatment', () => {
    expect(onboardingSource).not.toContain("{{ apiKey ?? '[APIKEY]' }}")
    expect(onboardingSource.match(/<Spinner size="w-5 h-5" \/>/g)).toHaveLength(3)
    expect(onboardingSource.match(/t\('app-onboarding-command-apikey-loading'\)/g)).toHaveLength(3)
  })

  it.concurrent('prevents copying the CLI command until its API key is ready', () => {
    expect(onboardingSource).toMatch(/async function copyCliCommand\(\) \{\s+if \(!apiKey\.value\)\s+return/)
  })

  it.concurrent('renders ready commands as native DaisyUI buttons', () => {
    expect(onboardingSource.match(/<button\s+v-if="apiKey"/g)).toHaveLength(3)
    expect(onboardingSource).not.toContain(':role="apiKey ? \'button\' : \'status\'"')
  })

  it.concurrent('keeps builder API keys exclusively in the API key flag', () => {
    expect(onboardingSource.match(/<span v-if="!usesBuilderSetupCommand" class="text-emerald-300">&nbsp;\{\{ apiKey \}\}<\/span>/g)).toHaveLength(3)
  })

  it.concurrent('provides concise loading copy in the English locale', () => {
    expect(englishMessages['app-onboarding-command-apikey-loading']).toBe('Creating your secure API key…')
  })
})

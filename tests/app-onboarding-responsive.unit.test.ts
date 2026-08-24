import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const flowSource = readFileSync(new URL('../src/components/dashboard/AppOnboardingFlow.vue', import.meta.url), 'utf8')
const pageSource = readFileSync(new URL('../src/pages/onboarding/app.vue', import.meta.url), 'utf8')
const pageStyles = pageSource.slice(pageSource.indexOf('<style scoped>'), pageSource.indexOf('</style>'))

describe('app-creation onboarding responsive layout', () => {
  it.concurrent('gates every step-specific compact selector behind app creation', () => {
    const stepSelectors = [...pageStyles.matchAll(/:deep\(([^)]*onboarding-flow-(?:intent|details-(?:name|app-id|icon))[^)]*)\)/g)]

    expect(flowSource).toMatch(/'onboarding-flow-app-creation':\s*props\.preOrg/)
    expect(stepSelectors.length).toBeGreaterThan(0)
    expect(stepSelectors.every(([, selector]) => selector.includes('onboarding-flow-app-creation'))).toBe(true)
  })

  it.concurrent('never hides navigation or account actions to make the layout fit', () => {
    expect(pageStyles).not.toMatch(/onboarding-flow-header\s+nav[^}]*display:\s*none/)
    expect(pageStyles).not.toMatch(/onboarding-(?:details|intent)-actions[^}]*display:\s*none/)
    expect(pageStyles).not.toMatch(/onboarding-page-actions[^}]*display:\s*none/)
    expect(pageSource).toContain('data-test="onboarding-logout"')
  })
})

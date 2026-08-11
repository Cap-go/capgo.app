import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const plansSource = readFileSync(new URL('../src/pages/settings/organization/Plans.vue', import.meta.url), 'utf8')

describe('expired trial plans layout', () => {
  it('keeps the credits and premium support banners below the plans', () => {
    const plansIndex = plansSource.indexOf('<!-- Plans Grid -->')
    const creditsIndex = plansSource.indexOf('<CreditsCta')
    const expertSupportIndex = plansSource.indexOf("'expert-service-title'")

    expect(plansIndex).toBeGreaterThanOrEqual(0)
    expect(creditsIndex).toBeGreaterThan(plansIndex)
    expect(expertSupportIndex).toBeGreaterThan(creditsIndex)
  })
})

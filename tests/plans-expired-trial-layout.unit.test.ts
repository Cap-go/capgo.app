import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const plansSource = readFileSync(new URL('../src/pages/settings/organization/Plans.vue', import.meta.url), 'utf8')

describe('expired trial plans layout', () => {
  it('keeps the credits and premium support banners ahead of the plans', () => {
    const creditsIndex = plansSource.indexOf('<CreditsCta')
    const expertSupportIndex = plansSource.indexOf("'expert-service-title'")
    const plansIndex = plansSource.indexOf('<!-- Plans Grid -->')

    expect(creditsIndex).toBeGreaterThanOrEqual(0)
    expect(expertSupportIndex).toBeGreaterThan(creditsIndex)
    expect(plansIndex).toBeGreaterThan(expertSupportIndex)
  })
})

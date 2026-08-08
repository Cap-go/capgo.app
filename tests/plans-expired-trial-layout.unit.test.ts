import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const plansSource = readFileSync(new URL('../src/pages/settings/organization/Plans.vue', import.meta.url), 'utf8')

describe('expired trial plans layout', () => {
  it('keeps the credits and premium support banners ahead of the plans', () => {
    expect(plansSource).not.toContain("showExpiredTrialState ? 'order-2 mt-6' : 'order-0 mb-6'")
    expect(plansSource).not.toContain("showExpiredTrialState ? 'order-1' : 'order-0'")
  })
})

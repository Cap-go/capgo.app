import { readFileSync } from 'node:fs'
import { Liquid } from 'liquidjs'
import { describe, expect, it } from 'vitest'

const suppression = readFileSync(new URL('../docs/bento/trial-email-suppression.liquid', import.meta.url), 'utf8')
const engine = new Liquid()
const route = (tags?: string[]) => engine.parseAndRender(suppression, { visitor: { tags } })

describe('Bento trial send gate', () => {
  it.concurrent.each([
    ['offer=direct'],
    ['offer=direct', 'trial', 'trial7', 'trial-plan:Solo'],
    ['onboarding_disabled'],
    ['customer'],
    ['paying'],
    ['payingMonthly'],
    ['recently_paid'],
    ['plan:Solo'],
    ['plan:Team'],
  ])('ends the session for %j', async (...tags) => {
    expect(await route(tags)).toBe('true')
  })

  it.concurrent.each([
    ['trial'],
    ['trial7'],
    ['trial1'],
    ['trial0'],
    ['trial_expired'],
    ['trial-plan:Solo', 'trial-card-on-file'],
    ['onboarding_intent:builder'],
    ['offer=directly', 'not-plan:Solo'],
  ])('preserves the existing non-suppressed route for %j', async (...tags) => {
    expect(await route(tags)).toBe('false')
  })

  it.concurrent('checks current tags again after a delay', async () => {
    const tags = ['trial-plan:Solo']
    expect(await route(tags)).toBe('false')
    tags.push('offer=direct')
    expect(await route(tags)).toBe('true')
  })

  it.concurrent('keeps the legacy missing-tag behavior explicit', async () => {
    expect(await route()).toBe('false')
    expect(await route([])).toBe('false')
  })
})

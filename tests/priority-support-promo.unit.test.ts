import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  choosePromoVariant,
  consumeGitHubConnectQuery,
  getDailyPromoVariant,
  getUtcPromoDay,
  isPrioritySupportEligible,
  isPrioritySupportTrial,
  resolvePrioritySupportEligibility,
} from '../src/services/prioritySupportPromo'

describe('priority support promotion', () => {
  it.concurrent('uses an unambiguous UTC calendar day as the deterministic seed', () => {
    expect(getUtcPromoDay(new Date('2026-08-02T23:59:59.999Z'))).toBe('2026-8-2')
    expect(getUtcPromoDay(new Date('2026-08-03T00:00:00.000Z'))).toBe('2026-8-3')
    expect(getDailyPromoVariant('2026-8-2')).toBe('builder')
    expect(getDailyPromoVariant('2026-8-3')).toBe('support')
    expect(getDailyPromoVariant('2026-8-2')).toBe(getDailyPromoVariant('2026-8-2'))
  })

  it.concurrent('cancels modal motion and stale open work when accessibility state changes', () => {
    const source = readFileSync(new URL('../src/components/dashboard/PrioritySupportPresentationModal.vue', import.meta.url), 'utf8')
    expect(source).toContain('let slideTransition: gsap.core.Timeline | null = null')
    expect(source).toContain('let entranceTweens: gsap.core.Tween[] = []')
    expect(source).toMatch(/watch\(reduce,[\s\S]*?stopDeckMotion\(true\)/)
    expect(source.match(/stopDeckMotion\(false\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(source).toContain('const generation = ++openGeneration')
    expect(source).toContain('generation !== openGeneration || !props.open')
    expect(source).toMatch(/onUnmounted\(\(\) => \{[\s\S]*?openGeneration\+\+/)
  })

  it.concurrent('waits for both checks, prefers the daily choice, and falls back to the eligible promo', () => {
    expect(choosePromoVariant('support', {
      supportEligible: true,
      builderEligible: true,
      supportReady: true,
      builderReady: false,
    })).toBeNull()
    expect(choosePromoVariant('support', {
      supportEligible: true,
      builderEligible: true,
      supportReady: true,
      builderReady: true,
    })).toBe('support')
    expect(choosePromoVariant('support', {
      supportEligible: false,
      builderEligible: true,
      supportReady: true,
      builderReady: true,
    })).toBe('builder')
    expect(choosePromoVariant('builder', {
      supportEligible: true,
      builderEligible: false,
      supportReady: true,
      builderReady: true,
    })).toBe('support')
  })

  it.concurrent('includes paying and active-trial organizations in the support experience', () => {
    expect(isPrioritySupportEligible({ paying: true, trial_left: 0 })).toBe(true)
    expect(isPrioritySupportEligible({ paying: false, trial_left: 4 })).toBe(true)
    expect(isPrioritySupportEligible({ paying: false, trial_left: 0 })).toBe(false)
    expect(isPrioritySupportTrial({ paying: false, trial_left: 4 })).toBe(true)
    expect(isPrioritySupportTrial({ paying: true, trial_left: 4 })).toBe(false)
  })

  it.concurrent('fails closed without blocking promo arbitration when organization loading rejects', async () => {
    const failure = new Error('organization load failed')
    const onError = vi.fn()
    await expect(resolvePrioritySupportEligibility(
      () => Promise.reject(failure),
      () => ({ paying: true }),
      onError,
    )).resolves.toBe(false)
    expect(onError).toHaveBeenCalledWith(failure)
  })

  it.concurrent('consumes only the GitHub handoff query and preserves unrelated state', () => {
    expect(consumeGitHubConnectQuery({ connect: 'github', from: 'priority-support', tab: 'profile' })).toEqual({
      from: 'priority-support',
      tab: 'profile',
    })
    expect(consumeGitHubConnectQuery({ connect: 'billing', tab: 'profile' })).toBeNull()
  })

  it.concurrent('keeps every imperative story selector connected to template markup', () => {
    const source = readFileSync(new URL('../src/components/dashboard/PrioritySupportStory.vue', import.meta.url), 'utf8')
    const templateStart = source.indexOf('<template>')
    const templateEnd = source.lastIndexOf('</template>')
    expect(templateStart).toBeGreaterThan(-1)
    expect(templateEnd).toBeGreaterThan(templateStart)
    const script = source.slice(0, templateStart)
    const template = source.slice(templateStart, templateEnd + '</template>'.length)
    const selectors = Array.from(script.matchAll(/(?:find<[^>]+>|querySelectorAll<[^>]+>)\('(?<selector>\.pss-[^']+)'\)/g))
      .map(match => match.groups?.selector)
      .filter((selector): selector is string => !!selector)

    expect(selectors.length).toBeGreaterThan(40)
    for (const selector of new Set(selectors))
      expect(template, `${selector} must exist in the story template`).toContain(selector.slice(1))
  })
})

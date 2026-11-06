import { describe, expect, it } from 'vitest'
import { applyDirectOfferBentoTags, buildBillingPlanBentoTags } from '../supabase/functions/_backend/utils/billing_bento_tags.ts'

describe('billing plan Bento tags', () => {
  it.concurrent.each([
    ['uses a distinct tag for the plan being trialed', 'Solo', 'trial', undefined, ['trial-plan:Solo'], []],
    ['replaces the trial-plan tag when the customer starts paying', 'Solo', 'paying', undefined, ['plan:Solo'], ['trial-plan:Solo', 'trial-card-on-file']],
    ['removes every possible trial plan when the customer starts paying', 'Maker', 'paying', ['Solo', 'Maker', 'Team'], ['plan:Maker'], ['trial-plan:Solo', 'trial-plan:Maker', 'trial-plan:Team', 'trial-card-on-file']],
    ['clears trial tags even when the current paid plan is unavailable', null, 'paying', ['Solo', 'Team'], [], ['trial-plan:Solo', 'trial-plan:Team', 'trial-card-on-file']],
    ['does not create a plan tag outside a trial or paid subscription', 'Solo', 'none', undefined, [], []],
  ] as const)('%s', (_label, plan, state, allPlans, segments, deleteSegments) => {
    expect(buildBillingPlanBentoTags(plan, state, allPlans as string[] | undefined)).toEqual({ segments, deleteSegments })
  })

  it.concurrent('tags direct-offer users offer=direct, never adds trial tags and removes legacy ones', () => {
    expect(applyDirectOfferBentoTags(buildBillingPlanBentoTags('Solo', 'trial'), true)).toEqual({
      segments: ['offer=direct'],
      deleteSegments: ['trial-plan:Solo', 'trial', 'trial7', 'trial1', 'trial0', 'trial-card-on-file'],
    })
    expect(applyDirectOfferBentoTags({
      segments: ['capgo', 'onboarded', 'trial', 'trial0'],
      deleteSegments: ['trial7', 'trial1', 'paying'],
    }, true, ['Solo', 'Team'])).toEqual({
      segments: ['capgo', 'onboarded', 'offer=direct'],
      deleteSegments: ['trial7', 'trial1', 'paying', 'trial', 'trial0', 'trial-card-on-file', 'trial-plan:Solo', 'trial-plan:Team'],
    })
  })

  it.concurrent('skips trial tags without touching anything else when the offer is unknown', () => {
    expect(applyDirectOfferBentoTags({
      segments: ['capgo', 'trial', 'trial7', 'trial-plan:Solo'],
      deleteSegments: ['paying'],
    }, null)).toEqual({
      segments: ['capgo'],
      deleteSegments: ['paying'],
    })
  })

  it.concurrent('leaves standard users untouched', () => {
    const tags = buildBillingPlanBentoTags('Solo', 'trial')
    expect(applyDirectOfferBentoTags(tags, false)).toBe(tags)
    expect(applyDirectOfferBentoTags(tags, false)).toEqual({ segments: ['trial-plan:Solo'], deleteSegments: [] })
  })
})

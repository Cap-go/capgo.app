import { describe, expect, it } from 'vitest'
import { buildBillingPlanBentoTags } from '../supabase/functions/_backend/utils/billing_bento_tags.ts'

describe('billing plan Bento tags', () => {
  it.concurrent('uses a distinct tag for the plan being trialed', () => {
    expect(buildBillingPlanBentoTags('Solo', 'trial')).toEqual({
      segments: ['trial-plan:Solo'],
      deleteSegments: [],
    })
  })

  it.concurrent('replaces the trial-plan tag when the customer starts paying', () => {
    expect(buildBillingPlanBentoTags('Solo', 'paying')).toEqual({
      segments: ['plan:Solo'],
      deleteSegments: ['trial-plan:Solo'],
    })
  })

  it.concurrent('removes every possible trial plan when the customer starts paying', () => {
    expect(buildBillingPlanBentoTags('Maker', 'paying', ['Solo', 'Maker', 'Team'])).toEqual({
      segments: ['plan:Maker'],
      deleteSegments: ['trial-plan:Solo', 'trial-plan:Maker', 'trial-plan:Team'],
    })
  })

  it.concurrent('clears trial tags even when the current paid plan is unavailable', () => {
    expect(buildBillingPlanBentoTags(null, 'paying', ['Solo', 'Team'])).toEqual({
      segments: [],
      deleteSegments: ['trial-plan:Solo', 'trial-plan:Team'],
    })
  })

  it.concurrent('does not create a plan tag outside a trial or paid subscription', () => {
    expect(buildBillingPlanBentoTags('Solo', 'none')).toEqual({
      segments: [],
      deleteSegments: [],
    })
  })
})

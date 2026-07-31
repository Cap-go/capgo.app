import { describe, expect, it } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'

describe('stripe billing Bento tag updates', () => {
  it.concurrent('normalizes and deduplicates every billing-linked email', () => {
    const segment = {
      segments: ['capgo', 'paying', 'plan:Solo'],
      deleteSegments: ['trial', 'trial0', 'canceled'],
    }

    expect(stripeEventTestUtils.buildBillingBentoTagUpdates([
      'Owner@Example.com ',
      'owner@example.com',
      'billing@stripe.example',
      null,
      '',
      ' Billing@Stripe.Example ',
      'creator@example.com',
    ], segment)).toEqual([
      { email: 'owner@example.com', segments: segment.segments, deleteSegments: segment.deleteSegments },
      { email: 'billing@stripe.example', segments: segment.segments, deleteSegments: segment.deleteSegments },
      { email: 'creator@example.com', segments: segment.segments, deleteSegments: segment.deleteSegments },
    ])
  })
})

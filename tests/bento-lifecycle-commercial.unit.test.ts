import type { ReadOnlyContext } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import type { Fact } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evidence.ts'
import type { Candidate, LifecycleInput } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { acceptedLifecycleCommercialOffer, isLifecycleCommercialOffer, withLifecycleCommercialMetadata } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/commercial.ts'
import { evaluateLifecycle } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/evaluate.ts'
import { buildLifecycleEvent } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/payload.ts'
import { readAcceptedPurposes } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/source.ts'

const CREATED = '2026-10-17T10:00:00.000Z'
const DONE = '2026-10-17T11:00:00.000Z'
const NOW = '2026-10-17T11:15:00.000Z'
const WEBAPP = 'https://console.capgo.app'

function input(overrides: Partial<LifecycleInput> = {}): LifecycleInput {
  const value: Fact = { id: 'real-value', at: DONE, step: 'test_update', kind: 'value', acknowledgement: 'Applied your update on a device' }
  return {
    now: NOW,
    orgId: '22222222-2222-4222-8222-222222222222',
    orgName: 'Example organization',
    product: 'ota',
    recipientId: '33333333-3333-4333-8333-333333333333',
    email: 'lifecycle@example.com',
    creatorTreatment: true,
    consent: true,
    selected: true,
    shippingIntent: true,
    supportHold: false,
    paused: false,
    evidence: { appId: 'com.example.lifecycle', incarnation: 'current-app', createdAt: CREATED, name: 'Example app', product: 'ota', platform: null, selected: true, healthy: true, activeUntil: null, facts: [value], tasks: { test_update: 'done' }, checklistComplete: true, firstValue: value, fundingBlocked: false },
    sourceHealthy: true,
    state: { enrolledAt: CREATED, lastProgressAt: DONE, appLessSince: null, checklistCompleteAt: DONE, firstValueAt: DONE, batch: { key: 'first-success', incarnation: 'current-app', openedAt: DONE, lastAt: DONE, facts: [value] } },
    accepted: [],
    trialDeadline: null,
    billingHealthy: true,
    paid: false,
    compatibleCredits: false,
    plan: { name: 'Example plan', monthlyPrice: 19, reason: 'Fits your measured usage', includes: 'Updates and builds' },
    ...overrides,
  }
}

const candidate = (branch: string): Candidate => ({ branch, purpose: 'summary:example', context: 'current', priority: 80, expiresAt: '2026-10-18T11:00:00Z' })

describe('optional lifecycle commercial offers', () => {
  it.concurrent.each(['subscription_proposition', 'checklist_complete_purchase', 'first_update_success', 'first_real_success'])('shares the optional offer classification for %s', (branch) => {
    expect(isLifecycleCommercialOffer(input(), branch)).toBe(true)
    expect(withLifecycleCommercialMetadata(input(), candidate(branch)).commercialOffer).toBe(true)
  })

  it.concurrent.each(['progress_digest', 'resumed_progress_digest', 'funding_blocked', 'trial7_ready', 'today_ready', 'expired_ready'])('keeps %s outside the optional commercial offer budget', (branch) => {
    expect(isLifecycleCommercialOffer(input(), branch)).toBe(false)
  })

  it.concurrent.each([
    ['paid coverage', { paid: true }],
    ['compatible credits', { compatibleCredits: true }],
    ['no fitted quote', { plan: null }],
    ['blank plan name', { plan: { name: ' ', monthlyPrice: 19, reason: 'Fit', includes: 'Updates' } }],
    ['invalid plan price', { plan: { name: 'Example', monthlyPrice: Number.NaN, reason: 'Fit', includes: 'Updates' } }],
    ['non-purchasable zero-price quote', { plan: { name: 'Example', monthlyPrice: 0, reason: 'Fit', includes: 'Updates' } }],
  ] satisfies Array<[string, Partial<LifecycleInput>]>)('does not count pure success with %s as a commercial offer', (_label, overrides) => {
    expect(isLifecycleCommercialOffer(input(overrides), 'first_update_success')).toBe(false)
  })

  it.concurrent('marks an unpaid coalesced success as commercial and keeps the server flag out of the Bento contract', () => {
    const current = input()
    const selected = evaluateLifecycle(current)!
    expect(selected).toMatchObject({ branch: 'first_update_success', commercialOffer: true })
    const event = buildLifecycleEvent(current, selected, 'stable-dispatch', WEBAPP)
    expect(event.data.cta_label).toBe('Choose Example plan')
    expect(new URL(String(event.data.continue_url)).pathname).toBe('/settings/organization/plans')
    expect(event.data).not.toHaveProperty('commercialOffer')
    expect(event.data.unique).toEqual({ key: 'stable-dispatch' })
  })

  it.concurrent.each([{ paid: true }, { compatibleCredits: true }])('keeps covered success noncommercial and points to the app’s next useful view (%j)', (coverage) => {
    const current = input(coverage)
    const selected = evaluateLifecycle(current)!
    expect(selected).toMatchObject({ branch: 'first_update_success', commercialOffer: false })
    const event = buildLifecycleEvent(current, selected, 'stable-dispatch', WEBAPP)
    expect(event.data.cta_label).toBe('Open my bundles')
    expect(new URL(String(event.data.continue_url)).pathname).toBe('/app/com.example.lifecycle/bundles')
  })

  it.concurrent('stamps the same flag on explicit readiness asks and retains Trial outside the optional weekly cap', () => {
    const current = input()
    const readyBatch = { ...current, evidence: { ...current.evidence!, firstValue: null }, state: { ...current.state, firstValueAt: null, batch: { ...current.state.batch!, facts: [] } } }
    expect(evaluateLifecycle(readyBatch)).toMatchObject({ branch: 'checklist_complete_purchase', commercialOffer: true })
    expect(evaluateLifecycle({ ...readyBatch, state: { ...readyBatch.state, batch: null } })).toMatchObject({ branch: 'subscription_proposition', commercialOffer: true })
    const trial = { ...readyBatch, now: '2026-10-29T10:00:00Z', trialDeadline: '2026-11-01T10:00:00Z' }
    const selected = evaluateLifecycle(trial)!
    expect(selected).toMatchObject({ branch: 'trial3_ready', commercialOffer: false })
    expect(buildLifecycleEvent(trial, selected, 'trial-dispatch', WEBAPP).data.cta_label).toBe('Choose Example plan')
  })

  it.concurrent('uses accepted server metadata to distinguish commercial success from pure success', async () => {
    const query = vi.fn(async () => [
      { purpose: 'summary:commercial', accepted_at: NOW, context: 'current', product: 'ota', branch: 'first_update_success', commercial_offer: 'true' },
      { purpose: 'summary:paid', accepted_at: NOW, context: 'current', product: 'builder', branch: 'first_real_success', commercial_offer: 'false' },
      { purpose: 'summary:legacy-success', accepted_at: NOW, context: 'current', product: 'builder', branch: 'first_real_success', commercial_offer: null },
    ])
    const accepted = await readAcceptedPurposes({ query } as unknown as ReadOnlyContext, input().orgId)
    expect(accepted.map(item => item.purpose)).toEqual(['summary:commercial', 'success:ota', 'offer:ota', 'summary:paid', 'success:builder', 'summary:legacy-success', 'success:builder'])
    expect(accepted.filter(item => item.purpose === 'offer:builder')).toHaveLength(0)
  })

  it.concurrent('preserves legacy explicit sales aliases but never invents a commercial offer from an unmarked success', () => {
    expect(acceptedLifecycleCommercialOffer('subscription_proposition', undefined)).toBe(true)
    expect(acceptedLifecycleCommercialOffer('checklist_complete_purchase', null)).toBe(true)
    expect(acceptedLifecycleCommercialOffer('first_real_success', undefined)).toBe(false)
    expect(acceptedLifecycleCommercialOffer('first_update_success', false)).toBe(false)
    expect(acceptedLifecycleCommercialOffer('checklist_complete_purchase', 'false')).toBe(false)
  })

  it.concurrent('consumes the accepted commercial success offer purpose so a later standalone offer cannot stack', async () => {
    const current = input()
    const query = vi.fn(async () => [{ purpose: 'summary:first-success', accepted_at: NOW, context: 'current', product: 'ota', branch: 'first_update_success', commercial_offer: 'true' }])
    const accepted = await readAcceptedPurposes({ query } as unknown as ReadOnlyContext, current.orgId)
    expect(evaluateLifecycle({ ...current, now: '2026-10-20T11:15:00Z', state: { ...current.state, batch: null }, accepted })).toBeNull()
  })
})

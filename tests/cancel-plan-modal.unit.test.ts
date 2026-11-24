// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import CancelPlanModal from '../src/components/billing/CancelPlanModal.vue'

const mocks = vi.hoisted(() => ({
  getCancelSaveOffer: vi.fn(),
  cancelSubscriptionWithReason: vi.fn(),
  acceptCancelSaveOffer: vi.fn(),
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../src/services/stripe', () => ({
  CANCEL_REASONS: ['too_expensive', 'missing_features', 'other'],
  FOUNDER_CALL_REASONS: ['missing_features'],
  FOUNDER_CALL_URL: 'https://book.capgo.app/meet-martin',
  getCancelSaveOffer: mocks.getCancelSaveOffer,
  cancelSubscriptionWithReason: mocks.cancelSubscriptionWithReason,
  acceptCancelSaveOffer: mocks.acceptCancelSaveOffer,
  formatStripeAmount: (amount: number) => `$${amount / 100}`,
}))

const offer = {
  id: 'offer_1',
  type: 'discount' as const,
  percentOff: 50,
  durationMonths: 3,
  monthlyAmount: 2900,
  discountedAmount: 1450,
  currency: 'usd',
}

function mountModal(onClose = vi.fn()) {
  const onCanceled = vi.fn()
  const onSaved = vi.fn()
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({
    render: () => h(CancelPlanModal, {
      orgId: 'org_test',
      planName: 'Solo',
      onClose,
      onCanceled,
      onSaved,
    }),
  })
  app.mount(root)
  return { app, root, onClose, onCanceled, onSaved }
}

function shell() {
  return document.body
}

async function pickReason(value = 'too_expensive') {
  const input = shell().querySelector(`[data-test="cancel-reason-${value}"] input`) as HTMLInputElement
  input.click()
  await nextTick()
}

async function submitReason() {
  const button = shell().querySelector('[data-test="cancel-plan-confirm"]') as HTMLButtonElement
  button.click()
  await nextTick()
}

describe('CancelPlanModal loss reminder', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('shows the loss step after the reason form is submitted', async () => {
    mountModal()
    await pickReason()
    await submitReason()
    expect(shell().querySelector('[data-test="cancel-loss-reminder"]')).toBeTruthy()
    const focusTarget = shell().querySelector('[data-test="cancel-loss-reminder"] [tabindex="-1"]')
    await vi.waitFor(() => expect(document.activeElement).toBe(focusTarget))
    expect(shell().querySelector('[data-test="cancel-plan-form"]')).toBeNull()
    expect(mocks.getCancelSaveOffer).not.toHaveBeenCalled()
  })

  it('closes when keep plan is clicked on the loss step', async () => {
    const onClose = vi.fn()
    mountModal(onClose)
    await pickReason()
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-keep-plan"]') as HTMLButtonElement).click()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('loads the offer after continue on the loss step', async () => {
    mocks.getCancelSaveOffer.mockResolvedValue({ offer })
    mountModal()
    await pickReason()
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shell().querySelector('[data-test="cancel-save-offer"]')).toBeTruthy())
    expect(mocks.getCancelSaveOffer).toHaveBeenCalledWith('org_test', 'too_expensive')
    expect(mocks.cancelSubscriptionWithReason).not.toHaveBeenCalled()
  })

  it('cancels when continue is clicked and no offer is available', async () => {
    mocks.getCancelSaveOffer.mockResolvedValue({ offer: null })
    mocks.cancelSubscriptionWithReason.mockResolvedValue({ subscription: null })
    const onCanceled = vi.fn()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp({
      render: () => h(CancelPlanModal, {
        orgId: 'org_test',
        onCanceled,
      }),
    })
    app.mount(root)
    await pickReason()
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(onCanceled).toHaveBeenCalledOnce())
    expect(mocks.cancelSubscriptionWithReason).toHaveBeenCalledWith('org_test', 'too_expensive', '', undefined)
  })

  it('still cancels when declining an eligible offer', async () => {
    mocks.getCancelSaveOffer.mockResolvedValue({ offer })
    mocks.cancelSubscriptionWithReason.mockResolvedValue({ subscription: { cancelAtPeriodEnd: true } })
    const onCanceled = vi.fn()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp({
      render: () => h(CancelPlanModal, {
        orgId: 'org_test',
        onCanceled,
      }),
    })
    app.mount(root)
    await pickReason()
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shell().querySelector('[data-test="cancel-save-offer"]')).toBeTruthy())
    ;(shell().querySelector('[data-test="cancel-offer-decline"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(onCanceled).toHaveBeenCalledOnce())
    expect(mocks.cancelSubscriptionWithReason).toHaveBeenCalledWith('org_test', 'too_expensive', '', offer.id)
  })

  it('switches to credits and passes the comment along', async () => {
    const creditsOffer = { id: 'offer_2', type: 'credits' as const, credits: 29, monthlyAmount: 2900, currency: 'usd' }
    mocks.getCancelSaveOffer.mockResolvedValue({ offer: creditsOffer })
    mocks.acceptCancelSaveOffer.mockResolvedValue({ type: 'credits', credits: 29, subscription: { cancelAtPeriodEnd: true } })
    const { onSaved } = mountModal()
    await pickReason()
    const textarea = shell().querySelector('[data-test="cancel-comment"]') as HTMLTextAreaElement
    textarea.value = ' only one app now '
    textarea.dispatchEvent(new Event('input'))
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shell().querySelector('[data-offer-type="credits"]')).toBeTruthy())
    expect(shell().textContent).toContain('billing-cancel-credits-title')
    ;(shell().querySelector('[data-test="cancel-offer-accept"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(mocks.acceptCancelSaveOffer).toHaveBeenCalledWith('org_test', 'offer_2', 'only one app now')
    expect(mocks.cancelSubscriptionWithReason).not.toHaveBeenCalled()
  })

  it('offers a call with the founder instead of canceling at once', async () => {
    mocks.getCancelSaveOffer.mockResolvedValue({ offer: null })
    mocks.cancelSubscriptionWithReason.mockResolvedValue({ subscription: null })
    const { onCanceled } = mountModal()
    await pickReason('missing_features')
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shell().querySelector('[data-test="cancel-founder-call"]')).toBeTruthy())
    expect((shell().querySelector('[data-test="cancel-founder-book"]') as HTMLAnchorElement).href).toBe('https://book.capgo.app/meet-martin')
    expect(shell().querySelector('[data-test="cancel-offer-accept"]')).toBeNull()
    expect(mocks.cancelSubscriptionWithReason).not.toHaveBeenCalled()
    ;(shell().querySelector('[data-test="cancel-offer-decline"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(onCanceled).toHaveBeenCalledOnce())
  })

  it('shows the founder call next to an offer', async () => {
    mocks.getCancelSaveOffer.mockResolvedValue({ offer })
    mountModal()
    await pickReason('missing_features')
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shell().querySelector('[data-test="cancel-founder-call"]')).toBeTruthy())
    expect(shell().querySelector('[data-test="cancel-offer-accept"]')).toBeTruthy()
  })

  it('does not offer the founder call for price reasons', async () => {
    mocks.getCancelSaveOffer.mockResolvedValue({ offer })
    mountModal()
    await pickReason()
    await submitReason()
    ;(shell().querySelector('[data-test="cancel-loss-continue"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(shell().querySelector('[data-test="cancel-save-offer"]')).toBeTruthy())
    expect(shell().querySelector('[data-test="cancel-founder-call"]')).toBeNull()
  })
})

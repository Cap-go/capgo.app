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
  CANCEL_REASONS: ['too_expensive', 'other'],
  getCancelSaveOffer: mocks.getCancelSaveOffer,
  cancelSubscriptionWithReason: mocks.cancelSubscriptionWithReason,
  acceptCancelSaveOffer: mocks.acceptCancelSaveOffer,
  formatStripeAmount: (amount: number) => `$${amount / 100}`,
}))

const offer = {
  id: 'offer_1',
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

async function pickReason() {
  const input = shell().querySelector('[data-test="cancel-reason-too_expensive"] input') as HTMLInputElement
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
})

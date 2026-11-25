import { describe, expect, it } from 'vitest'
import { bankTransferPlanAlreadyStored, bankTransferProration, bankTransferResetsUnpaidCycle, bankTransferResumeUpdate, buildBankTransferItems, invoiceAcceptsBankTransfer, pickBankTransferSubscription, shouldReissueUnpaidCardInvoice } from '../supabase/functions/_backend/utils/stripe.ts'
import { invoicedSubscriptionGrantsAccessBeforePayment, isBankTransferCurrency } from '../supabase/functions/_backend/utils/transfer_invoice.ts'

describe('yearly bank transfer', () => {
  it('keeps manual invoices paid before the wire and waits for a plans-page bank transfer', () => {
    expect(invoicedSubscriptionGrantsAccessBeforePayment({ status: 'active', collection_method: 'send_invoice' })).toBe(true)
    expect(invoicedSubscriptionGrantsAccessBeforePayment({ status: 'trialing', collection_method: 'charge_automatically' })).toBe(true)
    expect(invoicedSubscriptionGrantsAccessBeforePayment({ status: 'active', collection_method: 'charge_automatically' })).toBe(false)
    expect(invoicedSubscriptionGrantsAccessBeforePayment({
      status: 'active',
      collection_method: 'send_invoice',
      metadata: { capgo_bank_transfer: '1' },
    })).toBe(false)
  })

  it('offers bank transfer in the currencies Stripe can collect', () => {
    expect(['usd', 'eur', 'gbp', 'jpy', 'mxn'].every(isBankTransferCurrency)).toBe(true)
    expect(isBankTransferCurrency('brl')).toBe(false)
  })

  it('reuses an active subscription before a trial', () => {
    expect(pickBankTransferSubscription([
      { id: 'sub_trial', status: 'trialing' },
      { id: 'sub_live', status: 'active' },
    ])).toEqual({ id: 'sub_live', status: 'active' })
    expect(pickBankTransferSubscription([{ id: 'sub_incomplete', status: 'incomplete' }])).toBeNull()
  })

  it('replaces the plan item, keeps one extra MAU item, and invoices only when the price changes', () => {
    const existing = [
      { id: 'si_plan', quantity: 1, price: { id: 'price_month', metadata: { capgo_kind: 'plan' } } },
      { id: 'si_extra', quantity: 2, price: { id: 'price_extra_month', metadata: { capgo_kind: 'extra_mau' } } },
      { id: 'si_old_extra', quantity: 1, price: { id: 'price_extra_old', metadata: { capgo_kind: 'extra_mau' }, lookup_key: 'capgo_extra_mau_old' } },
    ]
    const changed = buildBankTransferItems(existing, [
      { price: 'price_year', quantity: 1 },
      { price: 'price_extra_year', quantity: 4 },
    ])
    expect(changed.changed).toBe(true)
    expect(changed.items).toEqual([
      { id: 'si_plan', price: 'price_year', quantity: 1 },
      { id: 'si_extra', price: 'price_extra_year', quantity: 4 },
      { id: 'si_old_extra', deleted: true },
    ])
    expect(bankTransferProration('active', changed.changed)).toBe('always_invoice')
    expect(bankTransferProration('active', true, true)).toBe('none')
    expect(bankTransferResetsUnpaidCycle('active', true, true)).toBe(true)
    expect(bankTransferResetsUnpaidCycle('trialing', true, true)).toBe(false)
    expect(bankTransferResumeUpdate({ cancel_at_period_end: true, cancel_at: null })).toEqual({
      cancel_at: '',
      cancel_at_period_end: false,
      cancellation_details: { feedback: '', comment: '' },
    })
    expect(bankTransferResumeUpdate({ cancel_at_period_end: false, cancel_at: null })).toEqual({})
    expect(invoiceAcceptsBankTransfer({ collection_method: 'charge_automatically', payment_settings: { payment_method_types: ['card'] } })).toBe(false)
    expect(invoiceAcceptsBankTransfer({ collection_method: 'send_invoice', payment_settings: { payment_method_types: ['card'] } })).toBe(true)
    expect(shouldReissueUnpaidCardInvoice(true, false, false)).toBe(true)
    expect(shouldReissueUnpaidCardInvoice(true, true, false)).toBe(false)
    expect(shouldReissueUnpaidCardInvoice(true, false, true)).toBe(false)
    expect(bankTransferPlanAlreadyStored(
      { productId: 'prod_enterprise', priceId: 'price_year', extraMau: 0 },
      { productId: 'prod_enterprise', priceId: 'price_year', extraMau: 2000 },
    )).toBe(false)
    expect(bankTransferPlanAlreadyStored(
      { productId: 'prod_enterprise', priceId: 'price_year', extraMau: 2000 },
      { productId: 'prod_enterprise', priceId: 'price_year', extraMau: 2000 },
    )).toBe(true)

    const same = buildBankTransferItems(
      [{ id: 'si_plan', quantity: 1, price: { id: 'price_year' } }],
      [{ price: 'price_year', quantity: 1 }],
    )
    expect(same.changed).toBe(false)
    expect(bankTransferProration('active', same.changed)).toBe('none')
    expect(bankTransferProration('trialing', same.changed)).toBe('always_invoice')
  })
})

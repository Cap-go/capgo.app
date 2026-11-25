import { describe, expect, it } from 'vitest'
import { bankTransferInvoiceCoversSubscription, bankTransferInvoiceSettlesUpgrade, bankTransferPaymentState, bankTransferPlanAlreadyStored, bankTransferProration, bankTransferResetsUnpaidCycle, bankTransferResumeUpdate, bankTransferSyncAction, bankTransferSyncDbStatus, buildBankTransferItems, canceledBankTransferKeepsStoredPlan, invoiceAcceptsBankTransfer, invoiceBillLines, invoiceLinePriceQuantities, paidInvoiceMatchesSubscription, pickBankTransferSubscription, shouldReissueUnpaidCardInvoice, subscriptionItemPriceQuantities } from '../supabase/functions/_backend/utils/stripe.ts'
import { invoiceRecordsSelfServeBankTransfer } from '../supabase/functions/_backend/utils/transfer_invoice.ts'
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
    expect(invoiceAcceptsBankTransfer({ collection_method: 'send_invoice', payment_settings: { payment_method_types: ['card'] } })).toBe(false)
    expect(invoiceAcceptsBankTransfer({ collection_method: 'send_invoice', payment_settings: { payment_method_types: ['customer_balance'] } })).toBe(true)
    expect(invoiceRecordsSelfServeBankTransfer({ parent: { subscription_details: { metadata: { capgo_bank_transfer: '1' } } } })).toBe(true)
    expect(invoiceRecordsSelfServeBankTransfer({ metadata: {} })).toBe(false)
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
    const paidLines = invoiceLinePriceQuantities([
      { amount: 39600, quantity: 1, pricing: { price_details: { price: 'price_year' } }, parent: { subscription_item_details: { proration: false } } },
    ])
    const currentItems = subscriptionItemPriceQuantities([{ price: { id: 'price_team' }, quantity: 1 }])
    expect(bankTransferInvoiceCoversSubscription(paidLines, currentItems)).toBe(false)
    expect(bankTransferInvoiceCoversSubscription(paidLines, subscriptionItemPriceQuantities([{ price: { id: 'price_year' }, quantity: 1 }]))).toBe(true)
    expect(invoiceLinePriceQuantities([
      { amount: -1000, quantity: 1, pricing: { price_details: { price: 'price_year' } }, parent: { invoice_item_details: { proration: true } } },
    ])).toEqual([])
    const proration = invoiceBillLines([
      { amount: -10000, quantity: 1, pricing: { price_details: { price: 'price_maker' } }, parent: { subscription_item_details: { proration: true } } },
      { amount: 20000, quantity: 1, pricing: { price_details: { price: 'price_team' } }, parent: { subscription_item_details: { proration: true } } },
    ])
    const team = subscriptionItemPriceQuantities([{ price: { id: 'price_team' }, quantity: 1 }])
    expect(bankTransferInvoiceSettlesUpgrade(proration, team, { priceId: 'price_maker', extraMau: 0 })).toBe(true)
    expect(bankTransferInvoiceSettlesUpgrade(proration, subscriptionItemPriceQuantities([{ price: { id: 'price_enterprise' }, quantity: 1 }]), { priceId: 'price_maker', extraMau: 0 })).toBe(false)
    const extraPrice = { id: 'price_extra', metadata: { capgo_kind: 'extra_mau' } }
    const extraUpgrade = invoiceBillLines([
      { amount: 6000, quantity: 2, pricing: { price_details: { price: 'price_extra' } }, parent: { subscription_item_details: { proration: true } } },
    ])
    const withExtra = subscriptionItemPriceQuantities([{ price: { id: 'price_year' }, quantity: 1 }, { price: extraPrice, quantity: 2 }])
    expect(bankTransferInvoiceSettlesUpgrade(extraUpgrade, withExtra, { priceId: 'price_year', extraMau: 0 })).toBe(true)
    expect(bankTransferInvoiceSettlesUpgrade(extraUpgrade, subscriptionItemPriceQuantities([{ price: { id: 'price_year' }, quantity: 1 }, { price: extraPrice, quantity: 5 }]), { priceId: 'price_year', extraMau: 0 })).toBe(false)
    const reduced = invoiceBillLines([
      { amount: 39600, quantity: 1, pricing: { price_details: { price: 'price_year' } }, parent: { subscription_item_details: { proration: false } } },
      { amount: 3000, quantity: 1, pricing: { price_details: { price: 'price_extra' } }, parent: { subscription_item_details: { proration: false } } },
    ])
    const fewerExtra = subscriptionItemPriceQuantities([{ price: { id: 'price_year' }, quantity: 1 }, { price: extraPrice, quantity: 1 }])
    expect(bankTransferInvoiceSettlesUpgrade(reduced, fewerExtra, { priceId: 'price_year', extraMau: 2000 })).toBe(true)
    const unpaidTransfer = { selfServeBankTransfer: true, status: 'active', latestInvoiceStatus: 'open', subscriptionId: 'sub_1' }
    expect(bankTransferSyncAction(unpaidTransfer, { status: 'succeeded', subscriptionId: 'sub_1' })).toBe('keep_stored_plan')
    expect(bankTransferSyncAction(unpaidTransfer, { status: 'created', subscriptionId: null })).toBe('wait_for_payment')
    expect(bankTransferSyncAction({ ...unpaidTransfer, latestInvoiceStatus: 'paid' }, { status: 'succeeded', subscriptionId: 'sub_1' })).toBe('apply_live')
    expect(bankTransferSyncAction({ ...unpaidTransfer, selfServeBankTransfer: false }, { status: 'succeeded', subscriptionId: 'sub_1' })).toBe('apply_live')
    const canceledUnpaid = { ...unpaidTransfer, status: 'canceled' }
    expect(bankTransferSyncAction(canceledUnpaid, { status: 'created', subscriptionId: null })).toBe('wait_for_payment')
    expect(bankTransferSyncAction(canceledUnpaid, { status: 'succeeded', subscriptionId: 'sub_1' })).toBe('keep_stored_plan')
    expect(bankTransferSyncDbStatus('wait_for_payment', { status: 'canceled' }, 'succeeded', '2999-01-01T00:00:00.000Z')).toBe('canceled')
    expect(bankTransferSyncDbStatus('keep_stored_plan', { status: 'canceled' }, 'canceled', '2999-01-01T00:00:00.000Z')).toBe('succeeded')
    expect(bankTransferSyncDbStatus('keep_stored_plan', { status: 'canceled' }, 'succeeded', '2000-01-01T00:00:00.000Z')).toBe('canceled')
    const currentPlan = subscriptionItemPriceQuantities([{ price: { id: 'price_team' }, quantity: 1 }])
    const oldInvoice = invoiceBillLines([
      { amount: 39600, quantity: 1, pricing: { price_details: { price: 'price_maker' } }, parent: { subscription_item_details: { proration: false } } },
    ])
    const currentInvoice = invoiceBillLines([
      { amount: 94800, quantity: 1, pricing: { price_details: { price: 'price_team' } }, parent: { subscription_item_details: { proration: false } } },
    ])
    expect(paidInvoiceMatchesSubscription(oldInvoice, currentPlan)).toBe(false)
    expect(paidInvoiceMatchesSubscription(currentInvoice, currentPlan)).toBe(true)
    expect(canceledBankTransferKeepsStoredPlan(true, true, false)).toBe(true)
    expect(canceledBankTransferKeepsStoredPlan(true, true, true)).toBe(false)
    expect(canceledBankTransferKeepsStoredPlan(true, false, false)).toBe(false)
    expect(bankTransferPaymentState(true, 'unpaid', false)).toBe('first_invoice_unpaid')
    expect(bankTransferPaymentState(true, 'unpaid', true)).toBe('bank_transfer_due')
    expect(bankTransferPaymentState(true, 'paid', false)).toBe('paid')
    expect(bankTransferPaymentState(false, 'unpaid', false)).toBe('unpaid')

    const same = buildBankTransferItems(
      [{ id: 'si_plan', quantity: 1, price: { id: 'price_year' } }],
      [{ price: 'price_year', quantity: 1 }],
    )
    expect(same.changed).toBe(false)
    expect(bankTransferProration('active', same.changed)).toBe('none')
    expect(bankTransferProration('trialing', same.changed)).toBe('always_invoice')
  })
})

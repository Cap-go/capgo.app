import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findLatestOpenSubscriptionInvoice: vi.fn(),
  getActiveSubscriptionId: vi.fn(),
  lookupActiveSubscriptionId: vi.fn(),
  syncSubscriptionData: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/stripe.ts', () => ({
  findLatestOpenSubscriptionInvoice: mocks.findLatestOpenSubscriptionInvoice,
  getActiveSubscriptionId: mocks.getActiveSubscriptionId,
  lookupActiveSubscriptionId: mocks.lookupActiveSubscriptionId,
  getStripe: vi.fn(),
  syncSubscriptionData: mocks.syncSubscriptionData,
}))

function mockActiveSubscription(subscriptionId: string | null, known = true) {
  mocks.getActiveSubscriptionId.mockResolvedValue(subscriptionId)
  mocks.lookupActiveSubscriptionId.mockResolvedValue({ subscriptionId, known })
}

async function expectSubscriptionLookupUnknown(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    message: 'Subscription payment method is temporarily unknown',
    cause: { error: 'subscription_lookup_unknown' },
  })
}

const {
  createCardSetupIntent,
  getSavedCards,
  parseCancelComment,
  parseCancelFeedback,
  parsePaymentMethodRole,
  payInvoiceWithBackupCard,
  payOpenInvoice,
  removeBackupCard,
  resumeSubscription,
  savePaymentMethodFromIntent,
  scheduleSubscriptionCancel,
} = await import('../supabase/functions/_backend/utils/stripe_in_app.ts')

function createContext() {
  return { get: (key: string) => key === 'requestId' ? 'request-id' : undefined } as any
}

function createStripe() {
  return {
    customers: { retrieve: vi.fn(), update: vi.fn() },
    invoicePayments: { list: vi.fn() },
    invoices: { pay: vi.fn(), retrieve: vi.fn() },
    paymentIntents: { retrieve: vi.fn(), update: vi.fn() },
    paymentMethods: { attach: vi.fn(), detach: vi.fn(), list: vi.fn(), retrieve: vi.fn() },
    setupIntents: { retrieve: vi.fn() },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  }
}

function createBillingContext(stripe = createStripe(), publishableKey = 'pk_test_123') {
  return { customerId: 'cus_123', billingAccount: 'ee' as const, stripe: stripe as any, publishableKey }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockActiveSubscription(null)
})

describe('cancel reason parsing', () => {
  it('accepts Stripe feedback values only', () => {
    expect(parseCancelFeedback('too_expensive')).toBe('too_expensive')
    expect(() => parseCancelFeedback('because')).toThrow()
    expect(() => parseCancelFeedback(undefined)).toThrow()
  })

  it('trims and caps the optional comment', () => {
    expect(parseCancelComment('  ')).toBeUndefined()
    expect(parseCancelComment(undefined)).toBeUndefined()
    expect(parseCancelComment(' Too pricey ')).toBe('Too pricey')
    expect(parseCancelComment('x'.repeat(2000))).toHaveLength(1000)
    expect(() => parseCancelComment(42)).toThrow()
  })
})

describe('scheduleSubscriptionCancel', () => {
  it('cancels at period end and stores the reason on the subscription', async () => {
    const stripe = createStripe()
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockResolvedValue({
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: 1_900_000_000,
      items: { data: [{ current_period_end: 1_900_000_000 }] },
    })

    const summary = await scheduleSubscriptionCancel(createContext(), createBillingContext(stripe), 'missing_features', 'Need SSO')

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at_period_end: true,
      cancellation_details: { feedback: 'missing_features', comment: 'Need SSO' },
    })
    expect(mocks.syncSubscriptionData).toHaveBeenCalledWith(expect.anything(), 'cus_123', 'sub_123')
    expect(summary).toMatchObject({ cancelAtPeriodEnd: true, cancelAt: new Date(1_900_000_000_000).toISOString() })
  })

  it('refuses when there is no active subscription', async () => {
    mockActiveSubscription(null)
    await expect(scheduleSubscriptionCancel(createContext(), createBillingContext(), 'unused')).rejects.toThrow()
  })
})

describe('resumeSubscription', () => {
  it('clears both period-end and dated cancellation', async () => {
    const stripe = createStripe()
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockResolvedValue({ status: 'active', cancel_at_period_end: false, cancel_at: null, items: { data: [] } })

    await resumeSubscription(createContext(), createBillingContext(stripe))

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at: '',
      cancel_at_period_end: false,
      cancellation_details: { feedback: '', comment: '' },
    })
  })
})

describe('without a publishable key', () => {
  it('refuses to start a card form', async () => {
    await expect(createCardSetupIntent(createBillingContext(createStripe(), ''))).rejects.toThrow()
  })

  it('asks for another card instead of an unrunnable 3DS step', async () => {
    const stripe = createStripe()
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.pay.mockRejectedValue(Object.assign(new Error('requires action'), { code: 'invoice_payment_intent_requires_action' }))
    stripe.invoicePayments.list.mockResolvedValue({ data: [{ status: 'open', payment: { payment_intent: 'pi_123' } }] })
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_123', status: 'requires_action', client_secret: 'pi_123_secret' })

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe, ''))).resolves.toMatchObject({ status: 'requires_payment_method' })
  })
})

describe('savePaymentMethodFromIntent', () => {
  it('rejects a SetupIntent that belongs to another customer', async () => {
    const stripe = createStripe()
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_other', status: 'succeeded', payment_method: 'pm_1' })

    await expect(savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123')).rejects.toThrow()
    expect(stripe.customers.update).not.toHaveBeenCalled()
  })

  it('rejects ids that are not Stripe intents', async () => {
    await expect(savePaymentMethodFromIntent(createContext(), createBillingContext(), 'pm_123')).rejects.toThrow()
  })

  it('sets the card as customer and subscription default', async () => {
    const stripe = createStripe()
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_1' })
    stripe.paymentMethods.retrieve.mockResolvedValue({ id: 'pm_1', customer: 'cus_123', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } })
    mockActiveSubscription('sub_123')

    const card = await savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123')

    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled()
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_123', { invoice_settings: { default_payment_method: 'pm_1' } })
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', { default_payment_method: 'pm_1' })
    expect(card).toEqual({ id: 'pm_1', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 })
  })
})

function card(id: string, fingerprint: string, expYear = 2099) {
  return { id, customer: 'cus_123', card: { brand: 'visa', last4: id.slice(-4), exp_month: 4, exp_year: expYear, fingerprint } }
}

function mockSavedCards(stripe: ReturnType<typeof createStripe>, defaultCard: unknown, cards: unknown[]) {
  stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: defaultCard } })
  stripe.paymentMethods.list.mockResolvedValue({ data: cards })
}

describe('backup card', () => {
  it('picks the newest valid card that is not the default', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [card('pm_same', 'fp_main'), card('pm_expired', 'fp_old', 2020), main, card('pm_back', 'fp_back'), card('pm_older', 'fp_older')])

    const cards = await getSavedCards(createContext(), createBillingContext(stripe))

    expect(cards.card?.id).toBe('pm_main')
    expect(cards.backupCard?.id).toBe('pm_back')
  })

  it('uses the subscription card as primary when the customer has no default', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, null, [card('pm_new', 'fp_new'), main])
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockResolvedValue({ default_payment_method: main })

    const cards = await getSavedCards(createContext(), createBillingContext(stripe))

    expect(cards.card?.id).toBe('pm_main')
    expect(cards.backupCard?.id).toBe('pm_new')
  })

  it('pins the current primary when a backup is added without a customer default', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    // The new backup is already attached and listed first.
    mockSavedCards(stripe, null, [card('pm_back', 'fp_back'), main])
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_back' })
    stripe.paymentMethods.retrieve.mockResolvedValue(card('pm_back', 'fp_back'))

    await savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123', 'backup')

    expect(stripe.customers.update).toHaveBeenCalledWith('cus_123', { invoice_settings: { default_payment_method: 'pm_main' } })
  })

  it('makes the card primary when there is nothing to back up', async () => {
    const stripe = createStripe()
    mockSavedCards(stripe, null, [card('pm_back', 'fp_back')])
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_back' })
    stripe.paymentMethods.retrieve.mockResolvedValue(card('pm_back', 'fp_back'))

    await savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123', 'backup')

    expect(stripe.customers.update).toHaveBeenCalledWith('cus_123', { invoice_settings: { default_payment_method: 'pm_back' } })
  })

  it('saves a backup card without changing the default', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [card('pm_back', 'fp_back'), main])
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_back' })
    stripe.paymentMethods.retrieve.mockResolvedValue(card('pm_back', 'fp_back'))

    const saved = await savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123', 'backup')

    expect(saved?.id).toBe('pm_back')
    expect(stripe.customers.update).not.toHaveBeenCalled()
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it('retires the previous backup when a new one is saved', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [card('pm_new', 'fp_new'), main, card('pm_old', 'fp_old')])
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_new' })
    stripe.paymentMethods.retrieve.mockResolvedValue(card('pm_new', 'fp_new'))

    await savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123', 'backup')

    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_old')
  })

  it('rejects the main card as its own backup', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [card('pm_dup', 'fp_main'), main])
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_dup' })
    stripe.paymentMethods.retrieve.mockResolvedValue(card('pm_dup', 'fp_main'))

    await expect(savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123', 'backup')).rejects.toThrow()
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_dup')
  })

  it('removing the backup does not revive an older card', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [card('pm_back', 'fp_back'), main, card('pm_old', 'fp_old')])

    await removeBackupCard(createContext(), createBillingContext(stripe), 'pm_back')

    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_back')
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_old')
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalledWith('pm_main')
  })

  it('never detaches the customer default when the subscription uses another card', async () => {
    const stripe = createStripe()
    const subscriptionCard = card('pm_sub', 'fp_sub')
    const customerDefault = card('pm_cust', 'fp_cust')
    mockSavedCards(stripe, customerDefault, [card('pm_back', 'fp_back'), customerDefault, subscriptionCard])
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockResolvedValue({ default_payment_method: subscriptionCard })

    await removeBackupCard(createContext(), createBillingContext(stripe), 'pm_back')

    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_back')
  })

  it('does not treat the customer default as a removable backup', async () => {
    const stripe = createStripe()
    const subscriptionCard = card('pm_sub', 'fp_sub')
    const customerDefault = card('pm_cust', 'fp_cust')
    mockSavedCards(stripe, customerDefault, [customerDefault, subscriptionCard])
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockResolvedValue({ default_payment_method: subscriptionCard })

    const cards = await getSavedCards(createContext(), createBillingContext(stripe))
    expect(cards.card?.id).toBe('pm_sub')
    expect(cards.backupCard).toBeNull()
    await expect(removeBackupCard(createContext(), createBillingContext(stripe), 'pm_cust')).rejects.toThrow()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('prefers a spare card over the customer default as backup', async () => {
    const stripe = createStripe()
    const subscriptionCard = card('pm_sub', 'fp_sub')
    const customerDefault = card('pm_cust', 'fp_cust')
    mockSavedCards(stripe, customerDefault, [card('pm_back', 'fp_back'), customerDefault, subscriptionCard])
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockResolvedValue({ default_payment_method: subscriptionCard })

    const cards = await getSavedCards(createContext(), createBillingContext(stripe))
    expect(cards.card?.id).toBe('pm_sub')
    expect(cards.backupCard?.id).toBe('pm_back')
  })

  it('only accepts known roles', () => {
    expect(parsePaymentMethodRole(undefined)).toBe('default')
    expect(parsePaymentMethodRole('backup')).toBe('backup')
    expect(() => parsePaymentMethodRole('primary')).toThrow()
  })

  it('refuses to remove the default card', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])

    await expect(removeBackupCard(createContext(), createBillingContext(stripe), 'pm_main')).rejects.toThrow()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('does not retry the backup card that just failed', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])

    await expect(payInvoiceWithBackupCard(createContext(), stripe as any, 'cus_123', 'in_123', { chargeId: 'ch_back', paymentMethodId: 'pm_back' })).resolves.toBe('failed_card_is_backup')
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
  })

  it('scopes the backup charge to the failed charge', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    stripe.invoices.pay.mockResolvedValue({ status: 'paid' })

    await expect(payInvoiceWithBackupCard(createContext(), stripe as any, 'cus_123', 'in_123', { chargeId: 'ch_1', paymentMethodId: 'pm_main' })).resolves.toBe('paid')
    expect(stripe.invoices.pay).toHaveBeenCalledWith('in_123', { payment_method: 'pm_back', off_session: true }, { idempotencyKey: 'capgo-backup-in_123-ch_1' })
  })

  it('reports a backup decline and rethrows other Stripe errors', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    stripe.invoices.pay.mockRejectedValueOnce(Object.assign(new Error('declined'), { type: 'StripeCardError', code: 'card_declined' }))
    await expect(payInvoiceWithBackupCard(createContext(), stripe as any, 'cus_123', 'in_123')).resolves.toBe('declined')

    stripe.invoices.pay.mockRejectedValueOnce(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    await expect(payInvoiceWithBackupCard(createContext(), stripe as any, 'cus_123', 'in_123')).rejects.toThrow('timeout')
  })

  it('hides the backup and refuses removal when the subscription lookup fails', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [card('pm_back', 'fp_back'), main, card('pm_old', 'fp_old')])
    mockActiveSubscription('sub_123')
    stripe.subscriptions.retrieve.mockRejectedValue(new Error('stripe down'))

    const cards = await getSavedCards(createContext(), createBillingContext(stripe))
    expect(cards.card?.id).toBe('pm_main')
    expect(cards.backupCard).toBeNull()

    await expectSubscriptionLookupUnknown(removeBackupCard(createContext(), createBillingContext(stripe), 'pm_back'))
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('refuses backup saves when the subscription lookup is unknown', async () => {
    const stripe = createStripe()
    // No customer default: a guessed first card must not be pinned while lookup is unknown.
    stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: null } })
    stripe.paymentMethods.list.mockResolvedValue({ data: [card('pm_guess', 'fp_guess'), card('pm_sub', 'fp_sub')] })
    mockActiveSubscription(null, false)
    stripe.setupIntents.retrieve.mockResolvedValue({ customer: 'cus_123', status: 'succeeded', payment_method: 'pm_new' })
    stripe.paymentMethods.retrieve.mockResolvedValue({ ...card('pm_new', 'fp_new'), customer: null })

    await expectSubscriptionLookupUnknown(savePaymentMethodFromIntent(createContext(), createBillingContext(stripe), 'seti_123', 'backup'))
    expect(stripe.paymentMethods.attach).not.toHaveBeenCalled()
    expect(stripe.customers.update).not.toHaveBeenCalled()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('refuses to remove a card that could be the subscription default while lookup is unknown', async () => {
    const stripe = createStripe()
    const customerDefault = card('pm_cust', 'fp_cust')
    mockSavedCards(stripe, customerDefault, [card('pm_sub', 'fp_sub'), customerDefault])
    mockActiveSubscription(null, false)

    const cards = await getSavedCards(createContext(), createBillingContext(stripe))
    expect(cards.backupCard).toBeNull()
    await expectSubscriptionLookupUnknown(removeBackupCard(createContext(), createBillingContext(stripe), 'pm_sub'))
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('throws when charging the backup while the subscription lookup is unknown', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    mockActiveSubscription(null, false)

    await expectSubscriptionLookupUnknown(payInvoiceWithBackupCard(createContext(), stripe as any, 'cus_123', 'in_123', { chargeId: 'ch_1' }))
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
  })
})

describe('payOpenInvoice', () => {
  it('reports paid when the saved card succeeds', async () => {
    const stripe = createStripe()
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.pay.mockResolvedValue({ status: 'paid' })

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe))).resolves.toEqual({ status: 'paid' })
  })

  it('returns the PaymentIntent secret when 3DS is required', async () => {
    const stripe = createStripe()
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.pay.mockRejectedValue(Object.assign(new Error('requires action'), { code: 'invoice_payment_intent_requires_action' }))
    stripe.invoicePayments.list.mockResolvedValue({ data: [{ status: 'open', payment: { payment_intent: 'pi_123' } }] })
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_123', status: 'requires_action', client_secret: 'pi_123_secret' })

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe))).resolves.toEqual({
      status: 'requires_action',
      clientSecret: 'pi_123_secret',
      publishableKey: 'pk_test_123',
    })
  })

  it('falls back to the backup card when the default is declined', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.retrieve.mockResolvedValue({ id: 'in_123', status: 'open' })
    stripe.invoices.pay
      .mockRejectedValueOnce(Object.assign(new Error('Your card was declined.'), {
        type: 'StripeCardError',
        code: 'card_declined',
        charge: 'ch_1',
        payment_method: 'pm_main',
      }))
      .mockResolvedValueOnce({ status: 'paid' })

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe))).resolves.toEqual({ status: 'paid' })
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(2)
    expect(stripe.invoices.pay).toHaveBeenNthCalledWith(1, 'in_123')
    expect(stripe.invoices.pay).toHaveBeenNthCalledWith(2, 'in_123', { payment_method: 'pm_back', off_session: true }, { idempotencyKey: 'capgo-backup-in_123-ch_1' })
  })

  it('does not retry Pay now when the declined card is already the backup', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.retrieve.mockResolvedValue({ id: 'in_123', status: 'open' })
    stripe.invoices.pay.mockRejectedValueOnce(Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      code: 'card_declined',
      charge: 'ch_back',
      payment_method: 'pm_back',
    }))

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe))).resolves.toMatchObject({ status: 'requires_payment_method' })
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
  })

  it('does not charge the backup when the default failed for a non-card reason', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.pay.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError', code: 'rate_limit' }))

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe))).resolves.toMatchObject({ status: 'requires_payment_method' })
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
  })

  it('asks for a new card when the saved card is declined', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main])
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.retrieve.mockResolvedValue({ id: 'in_123', status: 'open' })
    stripe.invoices.pay.mockRejectedValue(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' }))

    await expect(payOpenInvoice(createContext(), createBillingContext(stripe))).resolves.toEqual({
      status: 'requires_payment_method',
      message: 'Your card was declined.',
    })
  })

  it('surfaces a temporary subscription lookup failure from Pay now backup fallback', async () => {
    const stripe = createStripe()
    const main = card('pm_main', 'fp_main')
    mockSavedCards(stripe, main, [main, card('pm_back', 'fp_back')])
    mockActiveSubscription(null, false)
    mocks.findLatestOpenSubscriptionInvoice.mockResolvedValue({ id: 'in_123' })
    stripe.invoices.retrieve.mockResolvedValue({ id: 'in_123', status: 'open' })
    stripe.invoices.pay.mockRejectedValueOnce(Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      code: 'card_declined',
      charge: 'ch_1',
      payment_method: 'pm_main',
    }))

    await expectSubscriptionLookupUnknown(payOpenInvoice(createContext(), createBillingContext(stripe)))
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
  })
})

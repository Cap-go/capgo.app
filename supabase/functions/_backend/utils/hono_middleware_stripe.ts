import type Stripe from 'stripe'
import type { Bindings } from './cloudflare.ts'
import type { StripeData } from './stripe.ts'
import { createFactory } from 'hono/factory'
import { simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'
import { extractDataEvent, parseStripeEvent } from './stripe_event.ts'
import { type BillingAccount, DEFAULT_BILLING_ACCOUNT, getStripeWebhookSecret } from './stripe_billing_account.ts'

export interface MiddlewareKeyVariablesStripe {
  Bindings: Bindings
  Variables: {
    stripeEvent?: Stripe.Event
    stripeData?: StripeData
    billingAccount?: BillingAccount
  }
}

export const honoFactory = createFactory<MiddlewareKeyVariablesStripe>()

export function middlewareStripeWebhook(billingAccount: BillingAccount = DEFAULT_BILLING_ACCOUNT) {
  return honoFactory.createMiddleware(async (c, next) => {
    const webhookSecret = getStripeWebhookSecret(c, billingAccount)
    if (!webhookSecret) {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no secret found', billingAccount })
      throw simpleError('webhook_error_no_secret', 'Webhook Error: no secret found', { billing_account: billingAccount })
    }
    const signature = c.req.raw.headers.get('stripe-signature')
    if (!signature) {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no signature', billingAccount })
      throw simpleError('webhook_error_no_signature', 'Webhook Error: no signature', { billing_account: billingAccount })
    }
    const body = await c.req.text()
    const stripeEvent = await parseStripeEvent(c, body, signature, billingAccount)
    const stripeDataEvent = extractDataEvent(c, stripeEvent)
    const stripeData = stripeDataEvent.data
    if (stripeData.customer_id === '') {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no customer found', billingAccount })
      throw simpleError('webhook_error_no_customer', 'Webhook Error: no customer found', { billing_account: billingAccount })
    }
    c.set('stripeEvent', stripeEvent)
    c.set('stripeData', stripeDataEvent)
    c.set('billingAccount', billingAccount)
    await next()
  })
}

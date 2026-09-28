import type Stripe from 'stripe'
import type { Bindings } from './cloudflare.ts'
import type { StripeData } from './stripe.ts'
import type { BillingAccount } from './stripe_billing.ts'
import { createFactory } from 'hono/factory'
import { simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'
import { extractDataEvent, parseStripeEvent } from './stripe_event.ts'
import { getStripeWebhookSecret } from './stripe_billing.ts'

export interface MiddlewareKeyVariablesStripe {
  Bindings: Bindings
  Variables: {
    stripeEvent?: Stripe.Event
    stripeData?: StripeData
    stripeBillingAccount?: BillingAccount
  }
}

export const honoFactory = createFactory<MiddlewareKeyVariablesStripe>()

export function middlewareStripeWebhook(billingAccount: BillingAccount = 'ee') {
  return honoFactory.createMiddleware(async (c, next) => {
    const webhookSecret = getStripeWebhookSecret(c, billingAccount)
    if (!webhookSecret) {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no secret found', billingAccount })
      throw simpleError('webhook_error_no_secret', 'Webhook Error: no secret found')
    }
    const signature = c.req.raw.headers.get('stripe-signature')
    if (!signature) {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no signature', billingAccount })
      throw simpleError('webhook_error_no_signature', 'Webhook Error: no signature')
    }
    const body = await c.req.text()
    const stripeEvent = await parseStripeEvent(c, body, signature, billingAccount)
    const stripeDataEvent = extractDataEvent(c, stripeEvent)
    const stripeData = stripeDataEvent.data
    if (stripeData.customer_id === '') {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no customer found', billingAccount })
      throw simpleError('webhook_error_no_customer', 'Webhook Error: no customer found')
    }
    c.set('stripeEvent', stripeEvent)
    c.set('stripeData', stripeDataEvent)
    c.set('stripeBillingAccount', billingAccount)
    await next()
  })
}

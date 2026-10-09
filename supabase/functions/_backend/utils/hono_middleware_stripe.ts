import type Stripe from 'stripe'
import type { Bindings } from './cloudflare.ts'
import type { StripeData } from './stripe.ts'
import { createFactory } from 'hono/factory'
import { simpleError } from './hono.ts'
import { cloudlog } from './logging.ts'
import { extractDataEvent, parseStripeEvent } from './stripe_event.ts'
import { getEnv } from './utils.ts'

export interface MiddlewareKeyVariablesStripe {
  Bindings: Bindings
  Variables: {
    stripeEvent?: Stripe.Event
    stripeData?: StripeData
  }
}

export const honoFactory = createFactory<MiddlewareKeyVariablesStripe>()

export function middlewareStripeWebhook() {
  return honoFactory.createMiddleware(async (c, next) => {
    if (!getEnv(c, 'STRIPE_WEBHOOK_SECRET')) {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no secret found' })
      throw simpleError('webhook_error_no_secret', 'Webhook Error: no secret found')
    }
    const signature = c.req.raw.headers.get('stripe-signature')
    if (!signature || !getEnv(c, 'STRIPE_WEBHOOK_SECRET')) {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no signature' })
      throw simpleError('webhook_error_no_signature', 'Webhook Error: no signature')
    }
    const body = await c.req.text()
    const stripeEvent = await parseStripeEvent(c, body, signature)
    const stripeDataEvent = extractDataEvent(c, stripeEvent)
    const stripeData = stripeDataEvent.data
    // Refunds are recorded for stats even when the charge has no Stripe customer.
    if (stripeData.customer_id === '' && stripeEvent.type !== 'charge.refunded') {
      cloudlog({ requestId: c.get('requestId'), message: 'Webhook Error: no customer found' })
      throw simpleError('webhook_error_no_customer', 'Webhook Error: no customer found')
    }
    c.set('stripeEvent', stripeEvent)
    c.set('stripeData', stripeDataEvent)
    await next()
  })
}

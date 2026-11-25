import type { Context } from 'hono'
import type Stripe from 'stripe'
import type { BillingAccount } from './stripe_billing.ts'
import { simpleError } from './hono.ts'
import { servicePrincipal, withRlsContext } from './pg_rls.ts'

// Bound contention and keep the transaction alive during Stripe requests. Check the
// connection again before each mutation; never continue after losing serialization.
export async function withBillingProfileLock<T>(c: Context, account: BillingAccount, customerId: string, run: (assertHeld: () => Promise<void>) => Promise<T>) {
  return withRlsContext(c, servicePrincipal, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing-profile:${account}:${customerId}`])
    const deadline = Date.now() + 120_000
    let lost = false
    const heartbeat = setInterval(() => {
      client.query('SELECT 1').catch(() => { lost = true })
    }, 3000)
    const assertHeld = async () => {
      if (lost || Date.now() > deadline)
        throw simpleError('billing_busy', 'Billing settings changed. Please retry.')
      await client.query('SELECT 1')
    }
    try {
      return await run(assertHeld)
    }
    finally {
      clearInterval(heartbeat)
    }
  })
}

export const billingRequestOptions = { timeout: 10_000, maxNetworkRetries: 1 }

// Expiration fails if Checkout won the race and completed. Abort in that case,
// then retry from a fresh subscription scan instead of creating a second charge.
export async function expireBillingCheckouts(stripe: Stripe, customerId: string, assertHeld: () => Promise<void>, mode?: Stripe.Checkout.Session['mode']) {
  let cursor: string | undefined
  do {
    const page = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, billingRequestOptions)
    for (const session of page.data) {
      if (mode && session.mode !== mode)
        continue
      await assertHeld()
      await stripe.checkout.sessions.expire(session.id, {}, billingRequestOptions)
    }
    cursor = page.has_more ? page.data.at(-1)?.id : undefined
  } while (cursor)
}

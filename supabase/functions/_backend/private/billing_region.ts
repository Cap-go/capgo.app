import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { getRequestCountry, getSuggestedBillingAccount, isStripeConfiguredForAccount } from '../utils/stripe_billing.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

// Suggests which Stripe account a new org should use, based on the caller's location.
app.get('/', middlewareAuth, (c) => {
  return c.json({
    country: getRequestCountry(c),
    suggested: getSuggestedBillingAccount(c),
    usAvailable: isStripeConfiguredForAccount(c, 'us'),
  })
})

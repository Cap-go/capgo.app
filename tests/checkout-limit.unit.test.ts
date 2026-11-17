import { expect, it } from 'vitest'
import { isCheckoutAmountLimit } from '../supabase/functions/_backend/utils/checkout_limit'
it.concurrent.each([
  [{ code: 'amount_too_large' }, true],
  [{ message: "The Checkout Session's total amount due must be no more than $999,999.99." }, true],
  [{ message: 'Your card was declined.' }, false],
  [{ code: 'amount_too_small' }, false],
  [null, false],
])('recognizes only a Stripe upper amount limit: %j', (error, expected) => {
  expect(isCheckoutAmountLimit(error)).toBe(expected)
})

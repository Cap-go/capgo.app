// Stripe can omit an error code for Checkout's total-amount validation.
export function isCheckoutAmountLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object')
    return false
  const { code, message } = error as { code?: string, message?: string }
  return code === 'amount_too_large' || (typeof message === 'string' && /Checkout Session.s total amount due must be no more than/i.test(message))
}

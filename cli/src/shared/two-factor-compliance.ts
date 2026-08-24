import { isTransientNetworkError } from './network-error'

export const TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE
  = 'Cannot reach Capgo to verify 2FA compliance. Check your network connection and try again.'

/**
 * User-facing 2FA compliance connectivity failure. Unlike CliUserError, this
 * remains eligible for PostHog `$exception` capture so operational connectivity
 * issues stay visible while the CLI shows a stable recovery message.
 */
export class TwoFactorComplianceNetworkError extends Error {
  constructor(message = TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE) {
    super(message)
    this.name = 'TwoFactorComplianceNetworkError'
  }
}

export function throwTwoFactorComplianceRpcError(error: { message?: string }): void {
  if (isTransientNetworkError(error))
    throw new TwoFactorComplianceNetworkError()

  const detail = error.message ?? 'unknown error'
  throw new Error(`Cannot check 2FA compliance: ${detail}`)
}

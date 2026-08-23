import { CliUserError } from './cli-user-error'
import { isTransientNetworkError } from './network-error'

export const TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE
  = 'Cannot reach Capgo to verify 2FA compliance. Check your network connection and try again.'

export function throwTwoFactorComplianceRpcError(error: { message?: string }): void {
  if (isTransientNetworkError(error))
    throw new CliUserError(TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE)

  const detail = error.message ?? 'unknown error'
  throw new Error(`Cannot check 2FA compliance: ${detail}`)
}

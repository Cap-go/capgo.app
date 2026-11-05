import { log } from '@clack/prompts'
import { capturePosthogException, shouldCapturePosthogException } from '../posthog'
import { isTransientNetworkError } from './network-error'
import { CAPGO_API_RETRY_MAX_ATTEMPTS, invokeCapgoCliApiResultWithRetry } from './retryable-capgo-api-error'

export const TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE
  = 'Cannot reach Capgo to verify 2FA compliance. Check your network connection and try again.'

export const TWO_FACTOR_PREFLIGHT_NETWORK_WARNING
  = 'Could not verify 2FA compliance due to a network error. Continuing — Capgo will still enforce 2FA on this action if required.'

export const TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS = CAPGO_API_RETRY_MAX_ATTEMPTS

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

/** Retries transient transport and retryable 503 failures before the preflight fail-open path runs. */
export async function callTwoFactorComplianceRpcWithRetry<T>(
  rpcCall: () => PromiseLike<{ data: T | null, error: { message?: string } | null }>,
): Promise<{ data: T | null, error: { message?: string } | null }> {
  return invokeCapgoCliApiResultWithRetry(rpcCall)
}

/** Warn, capture telemetry, and let the command continue when the preflight probe is unreachable. */
export async function warnAndContinueTwoFactorPreflightNetworkFailure(
  options: { silent?: boolean, telemetryFunctionName: string },
): Promise<void> {
  if (!options.silent)
    log.warn(TWO_FACTOR_PREFLIGHT_NETWORK_WARNING)

  const networkError = new TwoFactorComplianceNetworkError()
  if (shouldCapturePosthogException(networkError)) {
    await capturePosthogException({
      error: networkError,
      functionName: options.telemetryFunctionName,
      kind: 'unhandled_error',
      status: 0,
    })
  }
}

/** Maps 2FA compliance API transport failures to user-facing errors. */
export function throwTwoFactorComplianceRpcError(error: { message?: string }): void {
  if (isTransientNetworkError(error))
    throw new TwoFactorComplianceNetworkError()

  const detail = error.message ?? 'unknown error'
  throw new Error(`Cannot check 2FA compliance: ${detail}`)
}

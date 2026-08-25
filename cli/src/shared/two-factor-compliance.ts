import { log } from '@clack/prompts'
import { capturePosthogException, shouldCapturePosthogException } from '../posthog'
import { isTransientNetworkError } from './network-error'

export const TWO_FACTOR_COMPLIANCE_NETWORK_MESSAGE
  = 'Cannot reach Capgo to verify 2FA compliance. Check your network connection and try again.'

export const TWO_FACTOR_PREFLIGHT_NETWORK_WARNING
  = 'Could not verify 2FA compliance due to a network error. Continuing — Capgo will still enforce 2FA on this action if required.'

export const TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS = 3

const PREFLIGHT_RETRY_DELAYS_MS = [500, 1000]

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retries transient transport failures before the preflight fail-open path runs. */
export async function callTwoFactorComplianceRpcWithRetry<T>(
  rpcCall: () => PromiseLike<{ data: T | null, error: { message?: string } | null }>,
): Promise<{ data: T | null, error: { message?: string } | null }> {
  let lastResult: { data: T | null, error: { message?: string } | null } = { data: null, error: null }

  for (let attempt = 1; attempt <= TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS; attempt++) {
    lastResult = await rpcCall()
    if (!lastResult.error)
      return lastResult
    if (!isTransientNetworkError(lastResult.error))
      return lastResult
    if (attempt < TWO_FACTOR_PREFLIGHT_MAX_ATTEMPTS)
      await sleep(PREFLIGHT_RETRY_DELAYS_MS[attempt - 1] ?? 1000)
  }

  return lastResult
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

/** Maps Supabase RPC transport failures to user-facing 2FA compliance errors. */
export function throwTwoFactorComplianceRpcError(error: { message?: string }): void {
  if (isTransientNetworkError(error))
    throw new TwoFactorComplianceNetworkError()

  const detail = error.message ?? 'unknown error'
  throw new Error(`Cannot check 2FA compliance: ${detail}`)
}

import { categorizeCliError } from '../analytics/error-category'
import { getHttpErrorStatus } from './http-status'

/**
 * Detect transport-level failures from supabase-js / fetch when an RPC or HTTP
 * call could not reach the server. Uses categorizeCliError as the single source
 * of truth so network/timeout classification stays aligned with telemetry.
 * Also treats 408 / 429 / 5xx on FunctionsHttpError.context as transient so
 * bounded retry + warn paths (e.g. 2FA preflight) can continue.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const category = categorizeCliError(error)
  if (category === 'network_error' || category === 'timeout')
    return true

  const status = getHttpErrorStatus(error)
  if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500))
    return true

  return false
}

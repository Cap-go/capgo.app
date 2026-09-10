import { categorizeCliError } from '../analytics/error-category'

/**
 * HTTP status on FunctionsHttpError lives on error.context (Response), not
 * error.status — categorizeCliError only sees the latter today.
 */
function getContextHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const context = (error as { context?: { status?: unknown } }).context
  return typeof context?.status === 'number' ? context.status : undefined
}

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

  const status = getContextHttpStatus(error)
  if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500))
    return true

  return false
}

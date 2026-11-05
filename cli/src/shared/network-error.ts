import { categorizeCliError } from '../analytics/error-category'

/**
 * Detect transport-level failures when a Capgo API call could not reach the
 * server. Uses categorizeCliError as the single source
 * of truth so network/timeout classification stays aligned with telemetry.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const category = categorizeCliError(error)
  return category === 'network_error' || category === 'timeout'
}

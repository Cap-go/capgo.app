/**
 * Read HTTP status from supabase-js FunctionsHttpError / invoke errors where
 * status lives on `error.context` (Response), not `error.status`.
 */
export function getHttpErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object')
    return undefined
  const context = (error as { context?: { status?: unknown } }).context
  return typeof context?.status === 'number' ? context.status : undefined
}

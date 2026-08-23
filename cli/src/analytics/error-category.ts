export type CliErrorCategory
  = | 'network_error'
    | 'timeout'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'payload_too_large'
    | 'rate_limited'
    | 'validation_error'
    | 'server_error'
    | 'commander'
    | 'unknown'

function getStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (typeof status === 'number')
      return status
  }
  return undefined
}

function getMessage(error: unknown): string {
  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.message)
    if (error.cause instanceof Error)
      parts.push(error.cause.message)
  }
  else if (typeof error === 'string') {
    parts.push(error)
  }
  else if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown }
    if (typeof candidate.message === 'string')
      parts.push(candidate.message)
  }
  return parts.join(' ')
}

/**
 * Maps an arbitrary thrown value to a closed enum so telemetry never leaks
 * error text, paths, or user input. Returns 'unknown' for anything unmatched.
 */
export function categorizeCliError(error: unknown): CliErrorCategory {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('commander.'))
      return 'commander'
  }

  const status = getStatus(error)
  if (status !== undefined) {
    if (status === 401)
      return 'unauthorized'
    if (status === 403)
      return 'forbidden'
    if (status === 404)
      return 'not_found'
    if (status === 413)
      return 'payload_too_large'
    if (status >= 500)
      return 'server_error'
  }

  const message = getMessage(error).toLowerCase()
  if (/econnrefused|econnreset|enotfound|eai_again|fetch failed|failed to fetch|connect timeout|und_err/.test(message))
    return 'network_error'
  if (/timed out|timeout|etimedout|aborted/.test(message))
    return 'timeout'
  if (/invalid|must be|required|not allowed|malformed|validation/.test(message))
    return 'validation_error'

  return 'unknown'
}

/**
 * Maps a non-2xx HTTP status to the same closed enum, for Supabase responses
 * where we have a status code but no thrown Error. Never leaks response bodies.
 */
export function categorizeHttpStatus(status: number): CliErrorCategory {
  if (status === 401)
    return 'unauthorized'
  if (status === 403)
    return 'forbidden'
  if (status === 404)
    return 'not_found'
  if (status === 408 || status === 504)
    return 'timeout'
  if (status === 413)
    return 'payload_too_large'
  if (status === 429)
    return 'rate_limited'
  if (status === 400 || status === 422)
    return 'validation_error'
  if (status >= 500)
    return 'server_error'
  return 'unknown'
}

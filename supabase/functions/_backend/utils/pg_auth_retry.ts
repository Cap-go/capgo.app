import { isTransientPgError } from './pg_errors.ts'

const AUTH_PG_RETRY_BASE_MS = 50
const AUTH_PG_RETRY_JITTER_MS = 40

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * One retry with small jitter for auth-related Postgres lookups on congested Hyperdrive pools.
 */
export async function withAuthPgRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  }
  catch (firstError) {
    if (!isTransientPgError(firstError))
      throw firstError
    const jitter = Math.floor(Math.random() * AUTH_PG_RETRY_JITTER_MS)
    await sleep(AUTH_PG_RETRY_BASE_MS + jitter)
    return await operation()
  }
}

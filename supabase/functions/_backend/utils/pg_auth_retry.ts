import { isTransientPgError } from './pg_errors.ts'

const AUTH_PG_RETRY_BASE_MS = 50
const AUTH_PG_RETRY_JITTER_MS = 40

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function authPgRetryJitterMs() {
  const bytes = new Uint32Array(1)
  crypto.getRandomValues(bytes)
  return bytes[0] % AUTH_PG_RETRY_JITTER_MS
}

/** Jittered delay before reconnecting after a transient pool or Hyperdrive error. */
export async function waitAuthPgRetryJitter(): Promise<void> {
  await sleep(AUTH_PG_RETRY_BASE_MS + authPgRetryJitterMs())
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
    await waitAuthPgRetryJitter()
    return await operation()
  }
}

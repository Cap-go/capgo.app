// Concurrent test files write the same RBAC/org rows through triggers, so Postgres can
// pick one autocommit statement as a deadlock victim. It can also refuse the connection
// when every slot is taken. Neither attempt changed data, so the statement can run again.
const RETRYABLE_SQL_STATES = new Set(['40P01', '40001', '53300'])
export const SQL_MAX_ATTEMPTS = 3
const SQL_CONNECTION_ATTEMPTS = 8

function defaultWait(attempt: number, code?: string) {
  const delay = code === '53300' ? 250 * attempt : 50 * attempt + Math.floor(Math.random() * 50)
  return new Promise<void>(resolve => setTimeout(resolve, delay))
}

export async function retryTransientSqlError<T>(
  run: () => Promise<T>,
  wait: (attempt: number, code?: string) => Promise<void> = defaultWait,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    }
    catch (error) {
      const code = (error as { code?: string } | null)?.code
      const limit = code === '53300' ? SQL_CONNECTION_ATTEMPTS : SQL_MAX_ATTEMPTS
      if (!code || !RETRYABLE_SQL_STATES.has(code) || attempt >= limit)
        throw error
      await wait(attempt, code)
    }
  }
}

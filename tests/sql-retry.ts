// Concurrent test files write the same RBAC/org rows through triggers, so Postgres can
// pick one autocommit statement as a deadlock victim. The victim is fully rolled back,
// so re-running that single statement is safe.
const RETRYABLE_SQL_STATES = new Set(['40P01', '40001'])
export const SQL_MAX_ATTEMPTS = 3

export async function retryTransientSqlError<T>(
  run: () => Promise<T>,
  wait: (attempt: number) => Promise<void> = attempt => new Promise(resolve => setTimeout(resolve, 50 * attempt + Math.floor(Math.random() * 50))),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    }
    catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (!code || !RETRYABLE_SQL_STATES.has(code) || attempt >= SQL_MAX_ATTEMPTS)
        throw error
      await wait(attempt)
    }
  }
}

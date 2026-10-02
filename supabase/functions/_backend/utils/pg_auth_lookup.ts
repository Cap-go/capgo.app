import type { Context } from 'hono'
import { quickError } from './hono.ts'
import { logPgError } from './pg.ts'

export type PgAuthLookupResult<T> =
  | { kind: 'ok', value: T }
  | { kind: 'not_found' }
  | { kind: 'db_error', error: unknown }

export function throwDatabaseUnavailable(c: Context, source: string, error: unknown, moreInfo: Record<string, unknown> = {}): never {
  logPgError(c, source, error)
  quickError(
    503,
    'database_unavailable',
    'Database temporarily unavailable',
    { retryAfterSeconds: 2, ...moreInfo },
    undefined,
    { alert: false },
  )
}

import type { Context } from 'hono'
import { quickError } from './hono.ts'

export type PgAuthLookupResult<T> =
  | { kind: 'ok', value: T }
  | { kind: 'not_found' }
  | { kind: 'db_error', error: unknown }

export function throwDatabaseUnavailable(c: Context, _source: string, _error: unknown, moreInfo: Record<string, unknown> = {}): never {
  quickError(
    503,
    'database_unavailable',
    'Database temporarily unavailable',
    { retryAfterSeconds: 2, ...moreInfo },
    undefined,
    { alert: false },
  )
}

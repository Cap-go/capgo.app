import type { Context } from 'hono'
import type { ConsoleQueryRequest } from '../private/console_query_sql.ts'
import { getRequestCountry } from './request_country.ts'

// First-login profile creation goes through the console's caller-scoped INSERT.
// Do not add defaults to UPDATE/UPSERT: that would overwrite existing countries.
export function defaultUserCountry(c: Context, request: ConsoleQueryRequest): ConsoleQueryRequest {
  if (request.kind !== 'table' || request.name !== 'users')
    return request
  const country = getRequestCountry(c)
  if (!country)
    return request
  const withCountry = (row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      return row
    const profile = row as Record<string, unknown>
    return profile.country == null || profile.country === '' ? { ...profile, country } : profile
  }
  return {
    ...request,
    operations: request.operations.map(operation => operation.method === 'insert'
      ? { ...operation, args: [Array.isArray(operation.args[0]) ? operation.args[0].map(withCountry) : withCountry(operation.args[0]), ...operation.args.slice(1)] }
      : operation),
  }
}

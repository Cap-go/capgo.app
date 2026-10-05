import type { Logger } from 'drizzle-orm/logger'
import { cloudlog } from './logging.ts'

const SENSITIVE_SQL_RE = /\bfind_apikey_by_value\b|\bget_user_id\s*\(|\brbac_check_permission_direct\b/i

function formatParams(params: unknown[]): string {
  const stringifiedParams = params.map((p) => {
    try {
      return JSON.stringify(p)
    }
    catch {
      return String(p)
    }
  })
  return stringifiedParams.length ? ` -- params: [${stringifiedParams.join(', ')}]` : ''
}

/**
 * Drizzle query logger: redact bind parameters for API key lookup SQL.
 */
export class CapgoDrizzleQueryLogger implements Logger {
  logQuery(query: string, params: unknown[]) {
    const paramsSuffix = SENSITIVE_SQL_RE.test(query)
      ? ' -- params: [redacted]'
      : formatParams(params)
    cloudlog({ message: `Query: ${query}${paramsSuffix}` })
  }
}

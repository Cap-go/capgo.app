import type { Context } from 'hono'
import type { JWTClaims } from '../utils/hono.ts'
import type { ConsoleQueryRequest, ConsoleQueryResult } from './console_query_sql.ts'
import { runDbQuery } from '../utils/db.ts'

export { catalogFromPayload, clearPgQueryCatalogCache as clearConsoleQueryCatalogCache, consoleRoleSetupSql, ConsoleQueryRollback, drizzleFrom, finishConsoleQuery, readSqlError, statusForSqlState } from '../utils/pg_query.ts'

// Console reads and writes stay on the primary. RLS calls auth.uid() and other
// functions that logical replicas do not have.
export type ConsoleQuerySession = { role: 'authenticated', claims: JWTClaims } | { role: 'anon' }

export function runConsoleQuery(c: Context, request: ConsoleQueryRequest, session: ConsoleQuerySession): Promise<ConsoleQueryResult> {
  // Hosted Supabase does not make the postgres login a superuser, and
  // SET SESSION AUTHORIZATION requires one. SET LOCAL ROLE is the switch this
  // database already allows: it changes current_user and drops BYPASSRLS.
  // session_user stays the login role. The request role GUC is what
  // user-facing checks must read. Fail closed if the role cannot be assumed.
  return runDbQuery(c, request, session)
}

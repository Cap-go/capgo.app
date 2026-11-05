import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import type { Client, Pool } from 'pg'

type PgHandle = Client | Pool
type AccessMode = 'read only' | 'read write'
const accessModes = new WeakMap<object, AccessMode>()
// Matches withPgTransaction. The postgres role has no idle-in-transaction
// timeout, so a transaction stalled on non-SQL work would otherwise pin its
// Hyperdrive origin connection indefinitely.
export const TRANSACTION_IDLE_TIMEOUT_MS = 15000

// One simple query so an abandoned request after BEGIN cannot leave a Hyperdrive
// origin connection idle in transaction with no timeout (postgres role has none).
export const BEGIN_WRITE_TRANSACTION_SQL = `BEGIN READ WRITE; SET LOCAL idle_in_transaction_session_timeout = ${TRANSACTION_IDLE_TIMEOUT_MS}`

function isDedicatedReadReplica(source: string) {
  return source.startsWith('HYPERDRIVE_CAPGO_READ_') || source === 'local_read_replica'
}

export function readOnlyStartupOptions(source: string, readOnly: boolean) {
  // Only dedicated read pools may carry a session default. A primary Hyperdrive
  // binding may itself point to a transaction pooler, regardless of its name.
  return readOnly && isDedicatedReadReplica(source) ? '-c default_transaction_read_only=on' : undefined
}

export function getPgAccessMode(client: object): AccessMode {
  return accessModes.get(client) ?? 'read write'
}

export function inheritPgAccessMode(owner: object, client: object) {
  accessModes.set(client, getPgAccessMode(owner))
}

export function setPgAccessMode<T extends PgHandle>(db: T, readOnly: boolean): T {
  // Primary fallback reads stay plain queries. Pinning a BEGIN READ ONLY across
  // the request held one Hyperdrive origin connection per in-flight request and
  // exhausted the primary pool. Writers declare READ WRITE explicitly instead, so
  // a leaked session default can no longer turn them read-only.
  accessModes.set(db, readOnly ? 'read only' : 'read write')
  return db
}

export function configureTransactionAccessMode<T extends NodePgDatabase>(database: T, client: object): T {
  const transaction = database.transaction.bind(database)
  database.transaction = (run, config) => {
    const mode = getPgAccessMode(client)
    if (mode === 'read only' && config?.accessMode === 'read write')
      return Promise.reject(new Error('Cannot start a read-write transaction on a read-only client'))
    return transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = ${TRANSACTION_IDLE_TIMEOUT_MS}`))
      return run(tx)
    }, { ...config, accessMode: mode === 'read only' ? mode : config?.accessMode ?? mode })
  }
  return database
}

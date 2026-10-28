/** Test doubles for checkoutPgClient/releasePgClient (non-Hyperdrive Pool path). */
export async function checkoutPgClient(pg: { connect: () => Promise<unknown> }) {
  return await pg.connect()
}

export function releasePgClient(
  _pg: unknown,
  client: { release?: (error?: boolean | Error) => void } | null | undefined,
  error?: boolean | Error,
): void {
  if (client && 'release' in client)
    client.release?.(error)
}

/** Mirrors production beginWriteTransaction for unit mocks that replace utils/pg. */
export async function beginWriteTransaction(client: { query: (queryText: string) => Promise<unknown> }) {
  await client.query('BEGIN')
}

/** True for plain BEGIN and the production bounded BEGIN batch. */
export function isBeginTransactionSql(sql: unknown): boolean {
  const text = String(sql)
  return text === 'BEGIN' || text.startsWith('BEGIN READ WRITE') || text.startsWith('BEGIN READ ONLY') || text.startsWith('BEGIN;')
}

/** Mirrors production withPgTransaction (checkout, BEGIN, COMMIT or ROLLBACK, release) on the doubles above. */
export async function withPgTransaction<T>(pg: { connect: () => Promise<unknown> }, run: (client: any) => Promise<T>): Promise<T> {
  const client = await checkoutPgClient(pg) as { query: (queryText: string) => Promise<unknown>, release?: (error?: boolean | Error) => void }
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  }
  catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
  finally {
    releasePgClient(pg, client)
  }
}

/** Shapes rows the way pg_rls queryJson reads them back (`SELECT to_json(q.*) AS row`). */
export function jsonRows(rows: unknown[]) {
  return { rowCount: rows.length, rows: rows.map(row => ({ row })) }
}

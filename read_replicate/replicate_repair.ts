// Repair a live read replica after its subscription lost changes (for example
// a replication slot invalidated with wal_removed and recreated at the current
// WAL position). Instead of truncating and reloading tables, it compares every
// row by primary key and an md5 of its columns, then fixes only the rows that
// differ, while the subscription keeps streaming:
//
// - missing on the replica: inserted (rows the stream never delivered);
// - different: overwritten with the source row (updates the stream missed);
// - only on the replica: deleted (deletes the stream missed).
//
// Tables are compared page by page in primary-key order (keyset pagination on
// typed keys), so memory holds one page plus the differences. Differences are
// then re-read on the source, the source WAL position is recorded, and the
// repair waits until the subscriber has applied that position before
// re-reading the replica. A row still missing after that was committed before
// the recorded position, so the stream will never deliver it: inserting it
// cannot collide with a later streamed INSERT. Fixes commit in batches of
// BATCH keys; readers never see an empty table.
//
// Dry run by default. Usage (via read_replicate/replicate_repair.sh):
//   bun run readreplicate:repair [--apply] [--tables a,b] [--skip a,b]
// --unsubscribed skips the subscription checks (local tests only).
import process from 'node:process'
import type { ClientConfig } from 'pg'
import { Client } from 'pg'

const DEFAULT_SKIP = ['delta_files', 'version_files']
const PAGE = 20_000
const BATCH = 1000
const CATCH_UP_TIMEOUT_MS = 120_000

interface KeyColumn { name: string, type: string, collatable: boolean }
interface TableInfo { table: string, columns: string[], pk: KeyColumn[] }
// Primary-key values as text, in key order.
type Key = string[]
interface Row { k: Key, h: string }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean)
}

const unsubscribed = process.argv.includes('--unsubscribed')

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

// psql accepts URLs whose password holds unencoded characters such as "?";
// pg's URL parser does not. Split credentials at the last "@" instead.
export function connectionConfig(url: string): ClientConfig {
  const match = /^postgres(?:ql)?:\/\/(.*)@([^@/]+)\/([^?]*)(?:\?(.*))?$/s.exec(url)
  if (!match)
    throw new Error('unsupported connection string (expected postgresql://user:password@host:port/db)')
  const [, credentials, hostPort, database, query = ''] = match
  const colon = credentials.indexOf(':')
  const portSeparator = hostPort.lastIndexOf(':')
  const params = new Map(query.split('&').filter(Boolean).map((pair) => {
    const equals = pair.indexOf('=')
    return [pair.slice(0, equals), decode(pair.slice(equals + 1))] as const
  }))
  const sslmode = params.get('sslmode') ?? 'prefer'
  return {
    user: decode(colon >= 0 ? credentials.slice(0, colon) : credentials),
    password: colon >= 0 ? decode(credentials.slice(colon + 1)) : undefined,
    host: portSeparator >= 0 ? hostPort.slice(0, portSeparator) : hostPort,
    port: portSeparator >= 0 ? Number(hostPort.slice(portSeparator + 1)) : 5432,
    database: decode(database) || 'postgres',
    ssl: sslmode === 'disable' ? false : { rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca' },
    connectionTimeoutMillis: params.has('connect_timeout') ? Number(params.get('connect_timeout')) * 1000 : 15_000,
  }
}

async function connect(url: string | undefined, label: string): Promise<Client> {
  if (!url)
    throw new Error(`${label} URL is not set`)
  const client = new Client({ ...connectionConfig(url), application_name: 'capgo_replica_repair' })
  await client.connect()
  // Same text output on both sides, so row hashes compare.
  await client.query(`SET TimeZone = 'UTC'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres';
    SET extra_float_digits = 1; SET bytea_output = 'hex'; SET statement_timeout = 0`)
  return client
}

async function columns(client: Client, table: string): Promise<string[]> {
  const result = await client.query<{ attname: string }>(
    `SELECT attname FROM pg_catalog.pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`,
    [`public.${table}`],
  )
  return result.rows.map(row => row.attname)
}

async function tableInfo(source: Client, replica: Client, table: string): Promise<TableInfo> {
  const replicaColumns = new Set(await columns(replica, table))
  const shared = (await columns(source, table)).filter(column => replicaColumns.has(column)).sort()
  const pk = await source.query<{ name: string, type: string, collatable: boolean }>(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attcollation <> 0 AS collatable
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [`public.${table}`],
  )
  if (!pk.rows.length || pk.rows.some(column => !shared.includes(column.name)))
    throw new Error(`${table}: needs a primary key present on both sides`)
  return { table, columns: shared, pk: pk.rows }
}

function id(client: Client, name: string) {
  return client.escapeIdentifier(name)
}

// Text keys sort with the C collation on both sides: the two servers may use
// different default collations, and paging must see the same order.
function keyTerm(client: Client, column: KeyColumn, expression = id(client, column.name)) {
  return column.collatable ? `${expression} COLLATE "C"` : expression
}

function selectList(client: Client, info: TableInfo) {
  const key = `ARRAY[${info.pk.map(column => `${id(client, column.name)}::text`).join(', ')}]`
  const row = `ROW(${info.columns.map(column => id(client, column)).join(', ')})::text`
  return `${key} AS k, md5(${row}) AS h`
}

// (pk...) compared to $offset.. as typed values, usable by the primary key index.
function keyCompare(client: Client, info: TableInfo, op: string, offset: number) {
  const left = info.pk.map(column => keyTerm(client, column)).join(', ')
  const right = info.pk.map((column, index) => keyTerm(client, column, `$${offset + index}::${column.type}`)).join(', ')
  return `(${left}) ${op} (${right})`
}

function orderBy(client: Client, info: TableInfo) {
  return info.pk.map(column => keyTerm(client, column)).join(', ')
}

async function page(client: Client, info: TableInfo, after: Key | null, upTo: Key | null, limit: number | null): Promise<Row[]> {
  const where: string[] = []
  const params: string[] = []
  if (after) {
    where.push(keyCompare(client, info, '>', params.length + 1))
    params.push(...after)
  }
  if (upTo) {
    where.push(keyCompare(client, info, '<=', params.length + 1))
    params.push(...upTo)
  }
  const result = await client.query<Row>(
    `SELECT ${selectList(client, info)} FROM public.${id(client, info.table)}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${orderBy(client, info)} ${limit ? `LIMIT ${limit}` : ''}`,
    params,
  )
  return result.rows
}

// Rows for an explicit key list, joined through the primary key index.
function keyJoin(client: Client, info: TableInfo, alias: string) {
  const definition = info.pk.map(column => `${id(client, column.name)} ${column.type}`).join(', ')
  const columnsList = info.pk.map(column => `${alias}.${id(client, column.name)}`).join(', ')
  const keyColumns = info.pk.map(column => `keys.${id(client, column.name)}`).join(', ')
  return `(${columnsList}) IN (SELECT ${keyColumns} FROM json_to_recordset($1::json) AS keys (${definition}))`
}

function keysJson(info: TableInfo, keys: Key[]) {
  return JSON.stringify(keys.map(key => Object.fromEntries(info.pk.map((column, index) => [column.name, key[index]]))))
}

async function rowsFor(client: Client, info: TableInfo, keys: Key[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (let offset = 0; offset < keys.length; offset += BATCH) {
    const result = await client.query<Row>(
      `SELECT ${selectList(client, info)} FROM public.${id(client, info.table)} AS t WHERE ${keyJoin(client, info, 't')}`,
      [keysJson(info, keys.slice(offset, offset + BATCH))],
    )
    for (const row of result.rows)
      found.set(JSON.stringify(row.k), row.h)
  }
  return found
}

function compare(source: Row[], replica: Row[], differing: Key[]) {
  const replicaHashes = new Map(replica.map(row => [JSON.stringify(row.k), row.h]))
  for (const row of source) {
    const key = JSON.stringify(row.k)
    if (replicaHashes.get(key) !== row.h)
      differing.push(row.k)
    replicaHashes.delete(key)
  }
  for (const key of replicaHashes.keys())
    differing.push(JSON.parse(key) as Key)
}

// Every key whose row differs or exists on one side only.
async function differingKeys(source: Client, replica: Client, info: TableInfo): Promise<Key[]> {
  const differing: Key[] = []
  let after: Key | null = null
  let compared = 0
  for (;;) {
    const sourceRows = await page(source, info, after, null, PAGE)
    if (sourceRows.length < PAGE) {
      // Last page: the replica tail beyond it, paged as well.
      let replicaAfter = after
      const tail: Row[] = []
      for (;;) {
        const replicaRows = await page(replica, info, replicaAfter, null, PAGE)
        tail.push(...replicaRows)
        if (replicaRows.length < PAGE)
          break
        replicaAfter = replicaRows.at(-1)!.k
      }
      compare(sourceRows, tail, differing)
      return differing
    }
    const upTo = sourceRows.at(-1)!.k
    compare(sourceRows, await page(replica, info, after, upTo, null), differing)
    after = upTo
    compared += sourceRows.length
    console.log(`[${info.table}] compared ${compared} rows, ${differing.length} differ so far`)
  }
}

async function waitForSubscriber(source: Client, replica: Client, lsn: string) {
  const subscription = await replica.query<{ slot: string }>(`SELECT subslotname AS slot FROM pg_catalog.pg_subscription WHERE subenabled LIMIT 1`)
  const slot = subscription.rows[0]?.slot
  if (!slot)
    throw new Error('no enabled subscription on the replica')
  const deadline = Date.now() + CATCH_UP_TIMEOUT_MS
  for (;;) {
    const state = await source.query<{ caught_up: boolean | null }>(
      `SELECT confirmed_flush_lsn >= $1::pg_lsn AS caught_up FROM pg_catalog.pg_replication_slots WHERE slot_name = $2`,
      [lsn, slot],
    )
    if (state.rows[0]?.caught_up)
      return
    if (Date.now() > deadline)
      throw new Error(`subscriber did not apply ${lsn} within ${CATCH_UP_TIMEOUT_MS / 1000} s`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function repair(source: Client, replica: Client, table: string, apply: boolean) {
  const info = await tableInfo(source, replica, table)
  const candidates = await differingKeys(source, replica, info)
  if (!candidates.length) {
    console.log(`[${table}] in sync`)
    return
  }

  // Source first, then its WAL position: every row it returned was committed
  // before that position. Once the subscriber has applied it, whatever still
  // differs is a change the stream lost.
  const sourceHashes = await rowsFor(source, info, candidates)
  if (!unsubscribed) {
    const position = await source.query<{ lsn: string }>('SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn')
    await waitForSubscriber(source, replica, position.rows[0].lsn)
  }
  const replicaHashes = await rowsFor(replica, info, candidates)
  const upsert: Key[] = []
  const remove: Key[] = []
  for (const key of candidates) {
    const text = JSON.stringify(key)
    const sourceHash = sourceHashes.get(text)
    if (sourceHash === undefined) {
      if (replicaHashes.has(text))
        remove.push(key)
    }
    else if (replicaHashes.get(text) !== sourceHash) {
      upsert.push(key)
    }
  }
  console.log(`[${table}] ${upsert.length} rows to insert or overwrite, ${remove.length} rows to delete${apply ? '' : ' (dry run)'}`)
  if (!apply)
    return

  const quotedTable = `public.${id(replica, table)}`
  const columnList = info.columns.map(column => id(replica, column)).join(', ')
  const pkList = info.pk.map(column => id(replica, column.name)).join(', ')
  const updates = info.columns.filter(column => !info.pk.some(key => key.name === column))
  const onConflict = updates.length
    ? `DO UPDATE SET ${updates.map(column => `${id(replica, column)} = EXCLUDED.${id(replica, column)}`).join(', ')}`
    : 'DO NOTHING'

  for (let offset = 0; offset < remove.length; offset += BATCH) {
    const keys = remove.slice(offset, offset + BATCH)
    // Still absent on the source right now: a key re-inserted meanwhile is
    // left to the stream.
    const present = await rowsFor(source, info, keys)
    const gone = keys.filter(key => !present.has(JSON.stringify(key)))
    if (gone.length)
      await replica.query(`DELETE FROM ${quotedTable} AS t WHERE ${keyJoin(replica, info, 't')}`, [keysJson(info, gone)])
  }
  for (let offset = 0; offset < upsert.length; offset += BATCH) {
    const keys = upsert.slice(offset, offset + BATCH)
    // Current source rows, as text: parsed into JavaScript, numeric and bigint
    // values would lose precision. Keys deleted since are skipped.
    const rows = await source.query<{ rows: string | null }>(
      `SELECT json_agg(t)::text AS rows FROM (SELECT ${info.columns.map(column => `t.${id(source, column)}`).join(', ')}
       FROM public.${id(source, table)} AS t WHERE ${keyJoin(source, info, 't')}) AS t`,
      [keysJson(info, keys)],
    )
    if (!rows.rows[0]?.rows)
      continue
    await replica.query(
      `INSERT INTO ${quotedTable} (${columnList}) OVERRIDING SYSTEM VALUE
       SELECT ${columnList} FROM json_populate_recordset(NULL::${quotedTable}, $1::json)
       ON CONFLICT (${pkList}) ${onConflict}`,
      [rows.rows[0].rows],
    )
  }

  const touched = [...upsert, ...remove]
  const [sourceAfter, replicaAfter] = await Promise.all([rowsFor(source, info, touched), rowsFor(replica, info, touched)])
  const still = touched.filter(key => sourceAfter.get(JSON.stringify(key)) !== replicaAfter.get(JSON.stringify(key))).length
  console.log(`[${table}] repaired; ${still} rows still differ (changed during the repair; rerun to settle)`)
}

const CONCURRENCY = 6

// Each table gets its own pair of connections so tables repair in parallel.
async function repairTable(table: string, apply: boolean) {
  const source = await connect(process.env.SOURCE_DB_URL, 'SOURCE_DB_URL')
  const replica = await connect(process.env.REPLICA_TARGET_DB_URL, 'REPLICA_TARGET_DB_URL')
  const started = Date.now()
  try {
    await repair(source, replica, table, apply)
    console.log(`[${table}] done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  finally {
    await source.end()
    await replica.end()
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const replica = await connect(process.env.REPLICA_TARGET_DB_URL, 'REPLICA_TARGET_DB_URL')
  try {
    const requested = list(arg('--tables'))
    const skip = new Set(arg('--skip') === undefined ? DEFAULT_SKIP : list(arg('--skip')))
    // Only tables the subscription has finished copying: a table still in its
    // initial sync is filled by the sync worker.
    const ready = await replica.query<{ relname: string }>(
      `SELECT c.relname FROM pg_catalog.pg_subscription_rel AS r
       JOIN pg_catalog.pg_class AS c ON c.oid = r.srrelid
       JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND r.srsubstate = 'r' ORDER BY c.relname`,
    )
    const readyTables = ready.rows.map(row => row.relname)
    const tables = (requested.length ? requested : readyTables).filter(table => !skip.has(table))
    const queue = tables.filter((table) => {
      if (unsubscribed || readyTables.includes(table))
        return true
      console.log(`[${table}] skipped: not a subscribed table in state r`)
      return false
    })
    const started = Date.now()
    const failures: string[] = []
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let table = queue.shift(); table; table = queue.shift()) {
        await repairTable(table, apply).catch((error: unknown) => {
          failures.push(table)
          console.error(`[${table}] failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }))
    console.log(`All tables in ${((Date.now() - started) / 1000).toFixed(1)} s${failures.length ? `; failed: ${failures.join(', ')}` : ''}`)
    if (failures.length)
      process.exitCode = 1
  }
  finally {
    await replica.end()
  }
}

if (import.meta.main)
  await main()

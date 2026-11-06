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
// Each server returns one checksum per bucket of rows (4,096 buckets by md5 of
// the key) from one sequential scan; only rows of differing buckets are then
// compared, so memory and transfer stay proportional to the differences. Differences are
// then re-read on the source, the source WAL position is recorded, and the
// repair waits until the subscriber has applied that position before
// re-reading the replica. A row still missing after that was committed before
// the recorded position, so the stream will never deliver it: inserting it
// cannot collide with a later streamed INSERT. Each table's fixes commit in
// one transaction; readers never see an empty table.
//
// Dry run by default. Usage (via read_replicate/replicate_repair.sh):
//   bun run readreplicate:repair [--apply] [--tables a,b] [--skip a,b]
// --unsubscribed skips the subscription checks (local tests only).
import process from 'node:process'
import type { ClientConfig } from 'pg'
import { Client } from 'pg'

const DEFAULT_SKIP = ['delta_files', 'version_files']
const BATCH = 1000
const CATCH_UP_TIMEOUT_MS = 120_000

interface KeyColumn { name: string, type: string }
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
  // libpq treats sslrootcert=system without sslmode as verify-full.
  const sslmode = params.get('sslmode') ?? (params.get('sslrootcert') === 'system' ? 'verify-full' : 'prefer')
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
  try {
    // Same text output on both sides, so row hashes compare.
    await client.query(`SET TimeZone = 'UTC'; SET DateStyle = 'ISO, YMD'; SET IntervalStyle = 'postgres';
      SET extra_float_digits = 1; SET bytea_output = 'hex'; SET statement_timeout = 0`)
  }
  catch (error) {
    await client.end().catch(() => {})
    throw error
  }
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
  const shared = (await columns(source, table))
    .filter(column => replicaColumns.has(column))
    .sort((a, b) => a.localeCompare(b))
  const pk = await source.query<KeyColumn>(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
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

function ids(client: Client, names: string[], prefix = '') {
  return names.map(name => prefix + id(client, name)).join(', ')
}

function pkNames(info: TableInfo) {
  return info.pk.map(column => column.name)
}

function tableSql(client: Client, info: TableInfo) {
  return `public.${id(client, info.table)}`
}

function rowTextSql(client: Client, names: string[]) {
  return `ROW(${ids(client, names)})::text`
}

function selectList(client: Client, info: TableInfo) {
  const keyText = pkNames(info).map(name => `${id(client, name)}::text`).join(', ')
  return `ARRAY[${keyText}] AS k, md5(${rowTextSql(client, info.columns)}) AS h`
}

// Rows for an explicit key list, joined through the primary key index.
function keyJoin(client: Client, info: TableInfo, alias: string) {
  const definition = info.pk.map(column => `${id(client, column.name)} ${column.type}`).join(', ')
  const tableKeys = ids(client, pkNames(info), `${alias}.`)
  const listKeys = ids(client, pkNames(info), 'keys.')
  return `(${tableKeys}) IN (SELECT ${listKeys} FROM json_to_recordset($1::json) AS keys (${definition}))`
}

function keysJson(info: TableInfo, keys: Key[]) {
  return JSON.stringify(keys.map(key => Object.fromEntries(info.pk.map((column, index) => [column.name, key[index]]))))
}

function batches<T>(items: T[]): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < items.length; offset += BATCH)
    result.push(items.slice(offset, offset + BATCH))
  return result
}

async function rowsForBatch(client: Client, info: TableInfo, keys: Key[]): Promise<Row[]> {
  const result = await client.query<Row>(
    `SELECT ${selectList(client, info)} FROM ${tableSql(client, info)} AS t WHERE ${keyJoin(client, info, 't')}`,
    [keysJson(info, keys)],
  )
  return result.rows
}

async function rowsFor(client: Client, info: TableInfo, keys: Key[]): Promise<Map<string, string>> {
  const pages = await Promise.all(batches(keys).map(batch => rowsForBatch(client, info, batch)))
  return new Map(pages.flat().map(row => [JSON.stringify(row.k), row.h]))
}

function compare(source: Row[], replica: Row[]): Key[] {
  const differing: Key[] = []
  const replicaHashes = new Map(replica.map(row => [JSON.stringify(row.k), row.h]))
  for (const row of source) {
    const key = JSON.stringify(row.k)
    if (replicaHashes.get(key) !== row.h)
      differing.push(row.k)
    replicaHashes.delete(key)
  }
  for (const key of replicaHashes.keys())
    differing.push(JSON.parse(key) as Key)
  return differing
}

const BUCKETS = 4096

// Same bucket for a key on both servers: derived from md5 of its text.
function bucketSql(client: Client, info: TableInfo) {
  const keyHash = `md5(${rowTextSql(client, pkNames(info))})`
  return `(('x' || substr(${keyHash}, 1, 8))::bit(32)::bigint % ${BUCKETS})::int`
}

// One sequential scan: row count and an order-independent checksum per bucket.
async function bucketSums(client: Client, info: TableInfo): Promise<Map<number, string>> {
  const rowHash = `md5(${rowTextSql(client, info.columns)})`
  const result = await client.query<{ b: number, n: string, s: string }>(
    `SELECT b, count(*)::text AS n, sum(('x' || substr(h, 1, 15))::bit(60)::bigint::numeric)::text AS s
     FROM (SELECT ${bucketSql(client, info)} AS b, ${rowHash} AS h FROM ${tableSql(client, info)}) AS rows
     GROUP BY b`,
  )
  return new Map(result.rows.map(r => [r.b, `${r.n}:${r.s}`]))
}

async function bucketRows(client: Client, info: TableInfo, buckets: number[]): Promise<Row[]> {
  const result = await client.query<Row>(
    `SELECT ${selectList(client, info)} FROM ${tableSql(client, info)} WHERE ${bucketSql(client, info)} = ANY ($1::int[])`,
    [buckets],
  )
  return result.rows
}

// Every key whose row differs or exists on one side only: compare bucket
// checksums from both servers in parallel, then rows of differing buckets only.
async function differingKeys(source: Client, replica: Client, info: TableInfo): Promise<Key[]> {
  const [sourceSums, replicaSums] = await Promise.all([bucketSums(source, info), bucketSums(replica, info)])
  const buckets = new Set<number>()
  for (const [bucket, sum] of sourceSums) {
    if (replicaSums.get(bucket) !== sum)
      buckets.add(bucket)
  }
  for (const bucket of replicaSums.keys()) {
    if (!sourceSums.has(bucket))
      buckets.add(bucket)
  }
  console.log(`[${info.table}] ${buckets.size} of ${BUCKETS} buckets differ`)
  if (!buckets.size)
    return []
  const list = [...buckets]
  const [sourceRows, replicaRows] = await Promise.all([bucketRows(source, info, list), bucketRows(replica, info, list)])
  return compare(sourceRows, replicaRows)
}

async function subscriberCaughtUp(source: Client, slot: string, lsn: string) {
  const state = await source.query<{ caught_up: boolean | null }>(
    'SELECT confirmed_flush_lsn >= $1::pg_lsn AS caught_up FROM pg_catalog.pg_replication_slots WHERE slot_name = $2',
    [lsn, slot],
  )
  return state.rows[0]?.caught_up === true
}

async function waitForSubscriber(source: Client, replica: Client, lsn: string) {
  const subscription = await replica.query<{ slot: string }>('SELECT subslotname AS slot FROM pg_catalog.pg_subscription WHERE subenabled LIMIT 1')
  const slot = subscription.rows[0]?.slot
  if (!slot)
    throw new Error('no enabled subscription on the replica')
  const deadline = Date.now() + CATCH_UP_TIMEOUT_MS
  while (!(await subscriberCaughtUp(source, slot, lsn))) {
    if (Date.now() > deadline)
      throw new Error(`subscriber did not apply ${lsn} within ${CATCH_UP_TIMEOUT_MS / 1000} s`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

// Classify candidates after the subscriber has applied everything the source
// had committed when it was read: what still differs is what the stream lost.
async function lostChanges(source: Client, replica: Client, info: TableInfo, candidates: Key[]) {
  const sourceHashes = await rowsFor(source, info, candidates)
  if (!unsubscribed) {
    const position = await source.query<{ lsn: string }>('SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn')
    await waitForSubscriber(source, replica, position.rows[0].lsn)
  }
  const replicaHashes = await rowsFor(replica, info, candidates)
  const replace: Key[] = []
  const remove: Key[] = []
  for (const key of candidates) {
    const text = JSON.stringify(key)
    const sourceHash = sourceHashes.get(text)
    if (sourceHash === undefined && replicaHashes.has(text))
      remove.push(key)
    else if (sourceHash !== undefined && replicaHashes.get(text) !== sourceHash)
      replace.push(key)
  }
  return { replace, remove }
}

// Current source rows as JSON text: parsed into JavaScript, numeric and bigint
// values would lose precision. Keys deleted since are absent.
async function sourceRowsJson(source: Client, info: TableInfo, keys: Key[]): Promise<string | null> {
  const result = await source.query<{ rows: string | null }>(
    `SELECT json_agg(t)::text AS rows FROM (SELECT ${ids(source, info.columns, 't.')}
     FROM ${tableSql(source, info)} AS t WHERE ${keyJoin(source, info, 't')}) AS t`,
    [keysJson(info, keys)],
  )
  return result.rows[0]?.rows ?? null
}

// One transaction per table. Stale versions of replaced rows are deleted
// before the current ones are inserted, so a unique value moving between two
// rows (for example the public channel of an app) is released first.
// Readers keep seeing the old rows until COMMIT.
async function writeFixes(source: Client, replica: Client, info: TableInfo, replace: Key[], remove: Key[]) {
  // Still absent on the source right now: a key re-inserted meanwhile is left
  // to the stream.
  const present = await rowsFor(source, info, remove)
  const gone = remove.filter(key => !present.has(JSON.stringify(key)))
  const rowsJson = await Promise.all(batches(replace).map(batch => sourceRowsJson(source, info, batch)))
  const target = tableSql(replica, info)
  const columnList = ids(replica, info.columns)

  await replica.query('BEGIN')
  try {
    for (const batch of batches([...gone, ...replace]))
      await replica.query(`DELETE FROM ${target} AS t WHERE ${keyJoin(replica, info, 't')}`, [keysJson(info, batch)])
    for (const json of rowsJson.filter(Boolean)) {
      await replica.query(
        `INSERT INTO ${target} (${columnList}) OVERRIDING SYSTEM VALUE
         SELECT ${columnList} FROM json_populate_recordset(NULL::${target}, $1::json)`,
        [json],
      )
    }
    await replica.query('COMMIT')
  }
  catch (error) {
    await replica.query('ROLLBACK')
    throw error
  }
}

async function repair(source: Client, replica: Client, table: string, apply: boolean) {
  const info = await tableInfo(source, replica, table)
  const candidates = await differingKeys(source, replica, info)
  if (!candidates.length) {
    console.log(`[${table}] in sync`)
    return
  }
  const { replace, remove } = await lostChanges(source, replica, info, candidates)
  const mode = apply ? '' : ' (dry run)'
  console.log(`[${table}] ${replace.length} rows to insert or overwrite, ${remove.length} rows to delete${mode}`)
  if (!apply || (!replace.length && !remove.length))
    return

  await writeFixes(source, replica, info, replace, remove)
  const touched = [...replace, ...remove]
  const [sourceAfter, replicaAfter] = await Promise.all([rowsFor(source, info, touched), rowsFor(replica, info, touched)])
  const still = touched.filter(key => sourceAfter.get(JSON.stringify(key)) !== replicaAfter.get(JSON.stringify(key))).length
  console.log(`[${table}] repaired; ${still} rows still differ (changed during the repair; rerun to settle)`)
}

const CONCURRENCY = 6

// Each table gets its own pair of connections so tables repair in parallel.
async function repairTable(table: string, apply: boolean) {
  const started = Date.now()
  let source: Client | undefined
  let replica: Client | undefined
  try {
    source = await connect(process.env.SOURCE_DB_URL, 'SOURCE_DB_URL')
    replica = await connect(process.env.REPLICA_TARGET_DB_URL, 'REPLICA_TARGET_DB_URL')
    await repair(source, replica, table, apply)
    console.log(`[${table}] done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
  finally {
    await Promise.all([source?.end(), replica?.end()])
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
    const failed = failures.length ? `; failed: ${failures.join(', ')}` : ''
    console.log(`All tables in ${((Date.now() - started) / 1000).toFixed(1)} s${failed}`)
    if (failures.length)
      process.exitCode = 1
  }
  finally {
    await replica.end()
  }
}

if (import.meta.main)
  await main()

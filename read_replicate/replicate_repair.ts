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
// Candidates are re-read after a short wait, so a row the stream is applying
// right now is left to the stream. Readers never see an empty table: each
// table's fixes commit in one transaction.
//
// Dry run by default. Usage (via read_replicate/replicate_repair.sh):
//   bun run readreplicate:repair [--apply] [--tables a,b] [--skip a,b]
// --unsubscribed skips the subscription state check (local tests only).
import process from 'node:process'
import { Client } from 'pg'

const DEFAULT_SKIP = ['delta_files', 'version_files']
const BATCH = 1000
const SETTLE_MS = 3000

interface TableInfo { columns: string[], pk: string[] }
type Hashes = Map<string, string>

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean)
}

async function connect(url: string | undefined, label: string): Promise<Client> {
  if (!url)
    throw new Error(`${label} URL is not set`)
  const client = new Client({ connectionString: url, application_name: 'capgo_replica_repair' })
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
  const pk = await source.query<{ attname: string }>(
    `SELECT a.attname FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary
     ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [`public.${table}`],
  )
  const pkColumns = pk.rows.map(row => row.attname)
  if (!pkColumns.length || pkColumns.some(column => !shared.includes(column)))
    throw new Error(`${table}: needs a primary key present on both sides`)
  return { columns: shared, pk: pkColumns }
}

function rowSql(client: Client, names: string[]): string {
  return `ROW(${names.map(name => client.escapeIdentifier(name)).join(', ')})::text`
}

async function hashes(client: Client, table: string, info: TableInfo, keys?: string[]): Promise<Hashes> {
  const key = rowSql(client, info.pk)
  const filter = keys ? `WHERE ${key} = ANY ($1::text[])` : ''
  const result = await client.query<{ k: string, h: string }>(
    `SELECT ${key} AS k, md5(${rowSql(client, info.columns)}) AS h FROM public.${client.escapeIdentifier(table)} ${filter}`,
    keys ? [keys] : [],
  )
  return new Map(result.rows.map(row => [row.k, row.h]))
}

function diff(source: Hashes, replica: Hashes) {
  const upsert: string[] = []
  const remove: string[] = []
  for (const [key, hash] of source) {
    if (replica.get(key) !== hash)
      upsert.push(key)
  }
  for (const key of replica.keys()) {
    if (!source.has(key))
      remove.push(key)
  }
  return { upsert, remove }
}

async function repair(source: Client, replica: Client, table: string, apply: boolean) {
  const info = await tableInfo(source, replica, table)
  const first = diff(await hashes(source, table, info), await hashes(replica, table, info))
  if (!first.upsert.length && !first.remove.length) {
    console.log(`[${table}] in sync`)
    return
  }

  // Leave rows the stream is applying right now to the stream.
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
  const candidates = [...first.upsert, ...first.remove]
  const { upsert, remove } = diff(await hashes(source, table, info, candidates), await hashes(replica, table, info, candidates))
  console.log(`[${table}] ${upsert.length} rows to insert or overwrite, ${remove.length} rows to delete${apply ? '' : ' (dry run)'}`)
  if (!apply || (!upsert.length && !remove.length))
    return

  const quotedTable = `public.${replica.escapeIdentifier(table)}`
  const columnList = info.columns.map(column => replica.escapeIdentifier(column)).join(', ')
  const pkList = info.pk.map(column => replica.escapeIdentifier(column)).join(', ')
  const updates = info.columns.filter(column => !info.pk.includes(column))
  const onConflict = updates.length
    ? `DO UPDATE SET ${updates.map(column => `${replica.escapeIdentifier(column)} = EXCLUDED.${replica.escapeIdentifier(column)}`).join(', ')}`
    : 'DO NOTHING'

  await replica.query('BEGIN')
  try {
    if (remove.length)
      await replica.query(`DELETE FROM ${quotedTable} WHERE ${rowSql(replica, info.pk)} = ANY ($1::text[])`, [remove])
    for (let offset = 0; offset < upsert.length; offset += BATCH) {
      const keys = upsert.slice(offset, offset + BATCH)
      // As text: parsed into JavaScript, numeric and bigint values would lose
      // precision before reaching the replica.
      const rows = await source.query<{ rows: string | null }>(
        `SELECT json_agg(t)::text AS rows FROM (SELECT ${columnList} FROM public.${source.escapeIdentifier(table)} WHERE ${rowSql(source, info.pk)} = ANY ($1::text[])) AS t`,
        [keys],
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
    await replica.query('COMMIT')
  }
  catch (error) {
    await replica.query('ROLLBACK')
    throw error
  }

  const after = diff(await hashes(source, table, info, candidates), await hashes(replica, table, info, candidates))
  console.log(`[${table}] repaired; ${after.upsert.length + after.remove.length} rows still differ (changed during the repair; rerun to settle)`)
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
      if (process.argv.includes('--unsubscribed') || readyTables.includes(table))
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

await main()

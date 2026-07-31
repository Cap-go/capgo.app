import type { CloudSqlDataApiResponse } from '../read_replicate/cloud_sql_data_api_response.ts'
import type {
  ReadReplicaSchemaSyncClient,
  ReadReplicaSchemaSyncPlan,
  ReadReplicaSchemaSyncStatement,
} from '../read_replicate/schema_additive_sync.ts'
import type { SchemaCompatibilityIssue } from '../read_replicate/schema_compatibility.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { assertCloudSqlDataApiResponseSucceeded } from '../read_replicate/cloud_sql_data_api_response.ts'
import { planReadReplicaSchemaSync } from '../read_replicate/schema_additive_sync.ts'
import {
  READ_REPLICA_SCHEMA_CATALOG_SQL,
  readReplicaSchemaCatalog,
  REPLICA_TABLES,
  stableStringify,
} from '../read_replicate/schema_catalog.ts'
import { readReplicaSchemaCatalogFromMigrations } from '../read_replicate/schema_catalog_from_migrations.ts'
import { readReplicaSubscriberCompatibilityIssues } from '../read_replicate/schema_compatibility.ts'

interface BunSubprocess {
  exitCode: number | null
  exited: Promise<number>
  kill: () => void
  stderr: ReadableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
}

interface BunRuntime {
  spawn: (command: string[], options: unknown) => BunSubprocess
}

interface DataApiResponse extends CloudSqlDataApiResponse {
  results?: Array<{
    columns?: Array<{ name?: string }>
    partialResult?: boolean
    rows?: Array<{ values?: Array<{ value?: string, nullValue?: boolean }> }>
  }>
}

interface GoogleDataApiConfig {
  project: string
  instance: string
  database: string
}

const bunRuntime = (globalThis as unknown as { Bun: BunRuntime }).Bun
const DEFAULT_SYNC_MAX_SECONDS = 30 * 60
const CATALOG_QUERY_BUFFER_MS = 5000
const GOOGLE_DATA_API_MAX_SECONDS = 30
const GOOGLE_DATA_API_PROCESS_GRACE_SECONDS = 5
const GOOGLE_DATA_API_REQUEST_LIMIT_BYTES = 500_000
const GOOGLE_DATA_API_REQUEST_METADATA_BUFFER_BYTES = 1_024
const GOOGLE_DATA_API_RESPONSE_LIMIT_BYTES = 10_000_000
const IMPORT_CLEANUP_MAX_SECONDS = 60
const POSTGRES_IMPORT_USER = 'postgres'
const GCS_IMPORT_BUCKET = 'capgo-read-replica-schema-import-394818'
// Included in Capgo release scope so replica schema sync fixes cut deploy tags.
const GOOGLE_READ_REPLICA: GoogleDataApiConfig = {
  project: 'capgo-394818',
  instance: 'eu-2',
  database: 'postgres',
}
async function main(): Promise<void> {
  const deadline = Date.now() + DEFAULT_SYNC_MAX_SECONDS * 1000
  const dryRun = process.argv.includes('--dry-run')
  console.log(
    'Building the read-replica schema catalog from local migrations through Tinbase/PGlite...',
  )
  const expected = await readReplicaSchemaCatalogFromMigrations()
  const replica = googleDataApiClient(GOOGLE_READ_REPLICA, deadline)
  const actual = await readReplicaSchemaCatalog(replica)
  const plan = planReadReplicaSchemaSync(expected, actual)

  // Both checks run before the SQL object is uploaded or Cloud SQL is asked to
  // import anything. The import receives this exact already-reviewed plan.
  assertGoogleReadReplicaSchemaPlan(plan)
  const preflightIssues = preflightCompatibilityIssues(expected, actual, plan)
  if (preflightIssues.length) {
    throw new Error(
      `Read-replica schema preflight found residual drift: ${stableStringify(preflightIssues)}`,
    )
  }

  if (dryRun) {
    console.log('Read-replica schema dry run result:')
    console.log(stableStringify({
      statements: plan.statements.map(({ kind, table, name }) => ({ kind, table, name })),
      skipped: plan.skipped,
    }))
    return
  }

  if (plan.statements.length) {
    const applyPlan = replica.applyReadReplicaSchemaPlan
    if (!applyPlan) {
      throw new Error(
        'Cloud SQL schema reconciliation requires a server-side plan importer.',
      )
    }
    await applyPlan(plan)
  }

  const finalActual = await readReplicaSchemaCatalog(replica)
  const issues = readReplicaSubscriberCompatibilityIssues(expected, finalActual)
  const result = {
    applied: plan.statements.map(({ kind, table, name }) => ({ kind, table, name })),
    skipped: plan.skipped,
  }

  if (issues.length) {
    console.error(
      '::error title=Read-replica schema did not converge::Cloud SQL server-side import completed with residual drift.',
    )
    console.error(
      stableStringify({ error: 'schema_not_converged', ...result, issues }),
    )
    process.exitCode = 1
    return
  }

  console.log('Read-replica Cloud SQL server-side import result:')
  console.log(stableStringify({ ...result, issues }))
  console.log(
    'Read replica accepts the schema derived from local migrations before primary migrations.',
  )
}

export function preflightCompatibilityIssues(
  expected: unknown,
  actual: unknown,
  plan: ReadReplicaSchemaSyncPlan,
): SchemaCompatibilityIssue[] {
  return readReplicaSubscriberCompatibilityIssues(expected, actual).filter(issue =>
    !plan.statements.some(statement => statementResolvesCompatibilityIssue(statement, issue)),
  )
}

function statementResolvesCompatibilityIssue(
  statement: ReadReplicaSchemaSyncStatement,
  issue: SchemaCompatibilityIssue,
): boolean {
  switch (issue.kind) {
    case 'column':
    case 'constraint':
      return statement.kind === issue.kind
        && issue.object === `${statement.table}.${statement.name}`
    case 'type':
    case 'sequence':
    case 'function':
      return statement.kind === issue.kind && issue.object === statement.name
    case 'index':
      return (
        (statement.kind === 'index'
          || statement.kind === 'invalid_index'
          || statement.kind === 'drop_index')
        && issue.object === statement.name
      )
    default:
      return false
  }
}

function googleDataApiClient(
  config: GoogleDataApiConfig,
  deadline: number,
): ReadReplicaSchemaSyncClient {
  const { project, instance, database } = config

  return {
    assertCanApplyReadReplicaSchemaPlan(plan) {
      assertGoogleReadReplicaSchemaPlan(plan)
    },
    async applyReadReplicaSchemaPlan(plan) {
      const {
        preIndexAtomicStatements,
        indexStatements,
        postIndexAtomicStatements,
      } = partitionReadReplicaImportStatements(plan.statements)
      // Columns/types/sequences first, then indexes, then USING INDEX attaches.
      // Index DDL is imported outside BEGIN/COMMIT and without CONCURRENTLY
      // because Cloud SQL managed SQL import is transactional.
      if (preIndexAtomicStatements.length) {
        await importReadReplicaSchemaTransaction(
          config,
          renderReadReplicaImportTransaction(preIndexAtomicStatements),
          deadline,
        )
      }
      if (indexStatements.length) {
        await importReadReplicaSchemaTransaction(
          config,
          renderReadReplicaIndexImport(indexStatements),
          deadline,
        )
      }
      if (postIndexAtomicStatements.length) {
        await importReadReplicaSchemaTransaction(
          config,
          renderReadReplicaImportTransaction(postIndexAtomicStatements),
          deadline,
        )
      }
    },
    async query(queryText: string, values?: unknown[]) {
      // The Data API has no session affinity and rejects requests over 0.5 MB or
      // responses over 10 MB. It is only used for bounded selected-schema reads.
      if (
        queryText.startsWith('SET statement_timeout')
        || queryText === 'RESET statement_timeout'
      ) {
        return { rows: [] }
      }

      assertGoogleDataApiCatalogQuery(queryText)
      const sql = renderCatalogQueryWithStaticValues(queryText, values)
      return {
        rows: dataApiRows(
          await executeGoogleSql(project, instance, database, sql, deadline),
        ),
      }
    },
  }
}

export function assertGoogleReadReplicaSchemaPlan(
  plan: ReadReplicaSchemaSyncPlan,
): void {
  const skipped = plan.skipped[0]
  if (skipped) {
    throw new Error(
      `Cloud SQL server-side import cannot reconcile skipped ${skipped.kind} ${skipped.table}.${skipped.name} (${skipped.reason}) before primary migrations.`,
    )
  }

  for (const statement of plan.statements)
    assertGoogleReadReplicaSchemaStatement(statement)
}

function assertGoogleReadReplicaSchemaStatement(
  statement: ReadReplicaSchemaSyncStatement,
): void {
  if (statement.sql.includes(';') || statement.sql.includes('\0')) {
    throw new Error(
      `Cloud SQL server-side import rejected unsafe ${statement.kind} ${statement.table}.${statement.name}.`,
    )
  }

  switch (statement.kind) {
    case 'column':
      assertSelectedReplicaTable(statement)
      assertColumnStatement(statement)
      return
    case 'constraint':
      assertSelectedReplicaTable(statement)
      assertConstraintStatement(statement)
      return
    case 'type':
      assertTypeStatement(statement)
      return
    case 'sequence':
      assertSequenceStatement(statement)
      return
    case 'index':
    case 'invalid_index':
    case 'drop_index':
      assertSelectedReplicaTable(statement)
      assertIndexStatement(statement)
      return
    default:
      throw new Error(
        `Cloud SQL server-side import cannot atomically apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
      )
  }
}

function assertColumnStatement(statement: ReadReplicaSchemaSyncStatement): void {
  const prefix = `ALTER TABLE public.${quoteSqlIdentifier(statement.table)} ADD COLUMN IF NOT EXISTS ${quoteSqlIdentifier(statement.name)} `
  if (
    !isSafeIdentifier(statement.name)
    || !statement.sql.startsWith(prefix)
    || !isSafeSchemaFragment(statement.sql.slice(prefix.length))
  ) {
    throw new Error(
      `Cloud SQL server-side import cannot atomically apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
    )
  }
}

function assertConstraintStatement(statement: ReadReplicaSchemaSyncStatement): void {
  const expected = `ALTER TABLE public.${quoteSqlIdentifier(statement.table)} ADD CONSTRAINT ${quoteSqlIdentifier(statement.name)} `
  const primaryKey = `PRIMARY KEY USING INDEX ${quoteSqlIdentifier(statement.name)}`
  const unique = `UNIQUE USING INDEX ${quoteSqlIdentifier(statement.name)}`
  const tail = statement.sql.slice(expected.length)
  if (
    !isSafeQuotedIdentifier(statement.name)
    || !statement.sql.startsWith(expected)
    || (tail !== primaryKey && tail !== unique)
  ) {
    throw new Error(
      `Cloud SQL server-side import cannot atomically apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
    )
  }
}

function assertTypeStatement(statement: ReadReplicaSchemaSyncStatement): void {
  const identifier = quoteSqlIdentifier(statement.name)
  const createPrefix = `CREATE TYPE public.${identifier} AS `
  const alterPrefix = `ALTER TYPE public.${identifier} ADD `
  const validCreate = statement.sql.startsWith(createPrefix)
    && isSafeTypeDefinition(statement.sql.slice(createPrefix.length))
  const validAlter = statement.sql.startsWith(alterPrefix)
    && isSafeTypeAlteration(statement.sql.slice(alterPrefix.length))
  if (
    statement.table !== 'public'
    || !isSafeIdentifier(statement.name)
    || (!validCreate && !validAlter)
  ) {
    throw new Error(
      `Cloud SQL server-side import cannot atomically apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
    )
  }
}

function assertSequenceStatement(statement: ReadReplicaSchemaSyncStatement): void {
  const identifier = quoteSqlIdentifier(statement.name)
  const createPrefix = `CREATE SEQUENCE IF NOT EXISTS public.${identifier} `
  const alterPrefix = `ALTER SEQUENCE public.${identifier} `
  const options = statement.sql.startsWith(createPrefix)
    ? statement.sql.slice(createPrefix.length)
    : statement.sql.startsWith(alterPrefix)
      ? statement.sql.slice(alterPrefix.length)
      : undefined
  if (
    statement.table !== 'public'
    || !isSafeIdentifier(statement.name)
    || !options
    || !isSafeSequenceOptions(options)
  ) {
    throw new Error(
      `Cloud SQL server-side import cannot atomically apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
    )
  }
}

function assertSelectedReplicaTable(statement: ReadReplicaSchemaSyncStatement): void {
  if (!REPLICA_TABLES.includes(statement.table as never)) {
    throw new Error(
      `Cloud SQL server-side import rejected non-subscriber table ${statement.table}.`,
    )
  }
}

function isIndexImportStatement(
  statement: ReadReplicaSchemaSyncStatement,
): boolean {
  return (
    statement.kind === 'index'
    || statement.kind === 'invalid_index'
    || statement.kind === 'drop_index'
  )
}

export function partitionReadReplicaImportStatements(
  statements: readonly ReadReplicaSchemaSyncStatement[],
): {
  preIndexAtomicStatements: ReadReplicaSchemaSyncStatement[]
  indexStatements: ReadReplicaSchemaSyncStatement[]
  postIndexAtomicStatements: ReadReplicaSchemaSyncStatement[]
} {
  const preIndexAtomicStatements: ReadReplicaSchemaSyncStatement[] = []
  const indexStatements: ReadReplicaSchemaSyncStatement[] = []
  const postIndexAtomicStatements: ReadReplicaSchemaSyncStatement[] = []
  for (const statement of statements) {
    if (isIndexImportStatement(statement))
      indexStatements.push(statement)
    else if (statement.kind === 'constraint')
      postIndexAtomicStatements.push(statement)
    else
      preIndexAtomicStatements.push(statement)
  }
  return {
    preIndexAtomicStatements,
    indexStatements,
    postIndexAtomicStatements,
  }
}

function assertIndexStatement(statement: ReadReplicaSchemaSyncStatement): void {
  if (!isSafeQuotedIdentifier(statement.name)) {
    throw new Error(
      `Cloud SQL server-side import cannot apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
    )
  }

  const quotedName = quoteSqlIdentifier(statement.name)
  const quotedTable = quoteSqlIdentifier(statement.table)
  const createPrefix = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quotedName} ON public.${quotedTable} `
  const createUniquePrefix = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${quotedName} ON public.${quotedTable} `
  const dropSql = `DROP INDEX CONCURRENTLY IF EXISTS public.${quotedName}`
  const reindexSql = `REINDEX INDEX CONCURRENTLY public.${quotedName}`

  if (statement.kind === 'drop_index') {
    if (statement.sql !== dropSql) {
      throw new Error(
        `Cloud SQL server-side import cannot apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
      )
    }
    return
  }

  if (statement.kind === 'invalid_index') {
    if (statement.sql !== reindexSql) {
      throw new Error(
        `Cloud SQL server-side import cannot apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
      )
    }
    return
  }

  const createTail = statement.sql.startsWith(createPrefix)
    ? statement.sql.slice(createPrefix.length)
    : statement.sql.startsWith(createUniquePrefix)
      ? statement.sql.slice(createUniquePrefix.length)
      : undefined
  if (!createTail || !isSafeSchemaFragment(createTail)) {
    throw new Error(
      `Cloud SQL server-side import cannot apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
    )
  }
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_]\w*$/u.test(value)
}

function isSafeQuotedIdentifier(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}

function isSafeSchemaFragment(value: string): boolean {
  return /^[\w .()[\],:'"{}+\-=<>!]+$/u.test(value)
}

function isSafeTypeDefinition(value: string): boolean {
  return (
    (value.startsWith('ENUM (') || value.startsWith('('))
    && value.endsWith(')')
    && /^[\w .()[\],:'"{}+\-=<>!\\]+$/u.test(value)
  )
}

function isSafeTypeAlteration(value: string): boolean {
  return (
    (value.startsWith('VALUE IF NOT EXISTS ') || value.startsWith('ATTRIBUTE '))
    && /^[\w .()[\],:'"{}+\-=<>!\\]+$/u.test(value)
  )
}

function isSafeSequenceOptions(value: string): boolean {
  const match = /^AS (?:smallint|integer|bigint) START WITH -?\d+ INCREMENT BY -?\d+ MINVALUE -?\d+ MAXVALUE -?\d+ CACHE \d+ (?:CYCLE|NO CYCLE) (?:OWNED BY NONE|OWNED BY public\."([A-Za-z_]\w*)"\."[A-Za-z_]\w*")$/u.exec(value)
  if (!match)
    return false

  return !match[1] || REPLICA_TABLES.includes(match[1] as never)
}

export function assertGoogleDataApiCatalogQuery(queryText: string): void {
  if (queryText !== READ_REPLICA_SCHEMA_CATALOG_SQL) {
    throw new Error(
      'Cloud SQL Data API schema adapter only permits selected-schema catalog reads outside the server-side import.',
    )
  }
}

export function renderReadReplicaImportTransaction(
  statements: readonly ReadReplicaSchemaSyncStatement[],
): string {
  if (!statements.length) {
    throw new Error(
      'Read-replica server-side import requires at least one reviewed statement',
    )
  }

  for (const statement of statements) {
    if (isIndexImportStatement(statement)) {
      throw new Error(
        `Cloud SQL server-side import cannot atomically apply ${statement.kind} ${statement.table}.${statement.name} before primary migrations.`,
      )
    }
    assertGoogleReadReplicaSchemaStatement(statement)
  }

  return `BEGIN;\n${statements.map(statement => statement.sql).join(';\n')};\nCOMMIT;`
}

export function renderReadReplicaIndexImport(
  statements: readonly ReadReplicaSchemaSyncStatement[],
): string {
  if (!statements.length) {
    throw new Error(
      'Read-replica server-side index import requires at least one reviewed statement',
    )
  }

  for (const statement of statements) {
    if (!isIndexImportStatement(statement)) {
      throw new Error(
        `Cloud SQL server-side index import rejected non-index ${statement.kind} ${statement.table}.${statement.name}.`,
      )
    }
    assertGoogleReadReplicaSchemaStatement(statement)
  }

  // Cloud SQL managed SQL import is transactional, so strip CONCURRENTLY.
  // Keep planner statements validated as CONCURRENTLY above.
  return `${statements.map(statement => renderCloudSqlIndexStatement(statement.sql)).join(';\n')};`
}

function renderCloudSqlIndexStatement(sql: string): string {
  return sql
    .replace(/^CREATE UNIQUE INDEX CONCURRENTLY /u, 'CREATE UNIQUE INDEX ')
    .replace(/^CREATE INDEX CONCURRENTLY /u, 'CREATE INDEX ')
    .replace(/^DROP INDEX CONCURRENTLY /u, 'DROP INDEX ')
    .replace(/^REINDEX INDEX CONCURRENTLY /u, 'REINDEX INDEX ')
}

async function importReadReplicaSchemaTransaction(
  config: GoogleDataApiConfig,
  sql: string,
  deadline: number,
): Promise<void> {
  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'capgo-read-replica-schema-'),
  )
  const object = `schema-${randomUUID()}.sql`
  const uri = `gs://${GCS_IMPORT_BUCKET}/${object}`
  let uploaded = false
  let operationError: unknown

  try {
    const localSqlPath = join(workingDirectory, 'schema.sql')
    await writeFile(localSqlPath, sql, { mode: 0o600 })
    await runGcloudCommand(
      [
        'gcloud',
        'storage',
        'cp',
        localSqlPath,
        uri,
        '--quiet',
      ],
      deadline,
      'Upload the reviewed read-replica schema transaction',
    )
    uploaded = true
    await runGcloudCommand(
      [
        'gcloud',
        'sql',
        'import',
        'sql',
        config.instance,
        uri,
        `--project=${config.project}`,
        `--database=${config.database}`,
        `--user=${POSTGRES_IMPORT_USER}`,
        '--quiet',
      ],
      deadline,
      'Run the Cloud SQL server-side schema import',
    )
  }
  catch (error) {
    operationError = error
    throw error
  }
  finally {
    try {
      if (uploaded) {
        await runGcloudCommand(
          [
            'gcloud',
            'storage',
            'rm',
            uri,
            '--quiet',
          ],
          Date.now() + IMPORT_CLEANUP_MAX_SECONDS * 1000,
          'Remove the temporary read-replica schema object',
        )
      }
    }
    catch (cleanupError) {
      const message = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError)
      if (operationError)
        console.error(`::warning title=Temporary import object cleanup failed::${message}`)
      else
        throw cleanupError
    }
    finally {
      await rm(workingDirectory, { force: true, recursive: true })
    }
  }
}
async function runGcloudCommand(
  command: string[],
  deadline: number,
  operation: string,
): Promise<void> {
  const timeoutMs = remainingBudgetMs(deadline, operation)
  let child: BunSubprocess | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  try {
    const childProcess = bunRuntime.spawn(command, {
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    })
    child = childProcess
    timeout = setTimeout(() => {
      timedOut = true
      childProcess.kill()
    }, timeoutMs)
    const [exitCode, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ])
    if (timedOut)
      throw new Error(`${operation} exceeded the remaining release time budget.`)
    if (exitCode !== 0)
      throw new Error(`${operation} failed: ${commandOutput(stderr || stdout)}`)
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
    if (child?.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}

async function executeGoogleSql(
  project: string,
  instance: string,
  database: string,
  sql: string,
  deadline: number,
): Promise<DataApiResponse> {
  assertDataApiRequestFitsLimit(database, sql)

  let child: BunSubprocess | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  try {
    const commandTimeoutMs = Math.min(
      remainingBudgetMs(deadline, 'read the selected schema catalog'),
      (GOOGLE_DATA_API_MAX_SECONDS + GOOGLE_DATA_API_PROCESS_GRACE_SECONDS)
      * 1000,
    )
    const command = bunRuntime.spawn(
      [
        'gcloud',
        'sql',
        'instances',
        'execute-sql',
        instance,
        `--project=${project}`,
        `--database=${database}`,
        `--sql=${sql}`,
        '--format=json',
        '--partial_result_mode=FAIL_PARTIAL_RESULT',
        '--quiet',
      ],
      { stdout: 'pipe', stderr: 'pipe', env: process.env },
    )
    child = command
    timeout = setTimeout(() => {
      timedOut = true
      command.kill()
    }, commandTimeoutMs)

    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ])
    if (timedOut) {
      throw new Error(
        `Cloud SQL Data API command exceeded its ${GOOGLE_DATA_API_MAX_SECONDS}-second SQL limit.`,
      )
    }
    if (exitCode !== 0)
      throw dataApiCommandError(stderr || stdout)
    const response = JSON.parse(stdout) as DataApiResponse
    assertCloudSqlDataApiResponseSucceeded(
      response,
      dataApiCommandError,
    )
    assertCompleteDataApiResponse(response)
    return response
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
    if (child?.exitCode === null) {
      child.kill()
      await child.exited
    }
  }
}

function assertDataApiRequestFitsLimit(database: string, sql: string): void {
  const payloadBytes = new TextEncoder().encode(
    JSON.stringify({
      database,
      partialResultMode: 'FAIL_PARTIAL_RESULT',
      sqlStatement: sql,
    }),
  ).byteLength
  const maximumPayloadBytes
    = GOOGLE_DATA_API_REQUEST_LIMIT_BYTES
      - GOOGLE_DATA_API_REQUEST_METADATA_BUFFER_BYTES

  if (payloadBytes > maximumPayloadBytes) {
    throw new Error(
      `Cloud SQL Data API SQL payload is ${payloadBytes} bytes and exceeds the safe ${maximumPayloadBytes}-byte budget below its 0.5 MB request limit. Keep the selected schema catalog bounded.`,
    )
  }
}

function assertCompleteDataApiResponse(response: DataApiResponse): void {
  if (response.results?.some(result => result.partialResult)) {
    throw new Error(
      `Cloud SQL Data API returned a partial result. It refuses catalog responses at or above its ${GOOGLE_DATA_API_RESPONSE_LIMIT_BYTES / 1_000_000} MB limit.`,
    )
  }
}

function dataApiRows(response: DataApiResponse): Record<string, any>[] {
  const result = response.results?.[0]
  const columns = result?.columns ?? []
  return (result?.rows ?? []).map((row) => {
    const mapped: Record<string, any> = {}
    for (const [index, column] of columns.entries()) {
      const value = row.values?.[index]
      if (!column.name)
        continue
      if (value?.nullValue) {
        mapped[column.name] = null
        continue
      }
      mapped[column.name]
        = column.name === 'catalog' && value?.value
          ? JSON.parse(value.value)
          : value?.value
    }
    return mapped
  })
}

function renderCatalogQueryWithStaticValues(
  queryText: string,
  values: unknown[] | undefined,
): string {
  const parameters = values ?? []
  if (parameters.length !== 5) {
    throw new Error(
      'Read-replica schema catalog requires five selected-schema parameter arrays.',
    )
  }
  let sql = queryText
  for (const [index, value] of parameters.entries()) {
    const placeholder = `$${index + 1}::text[]`
    if (!sql.includes(placeholder)) {
      throw new Error(
        'Read-replica schema catalog query did not contain its expected parameter placeholders.',
      )
    }
    sql = sql.replaceAll(placeholder, postgresTextArray(value))
  }
  return sql
}

function postgresTextArray(value: unknown): string {
  if (
    !Array.isArray(value)
    || !value.every(entry => typeof entry === 'string')
  ) {
    throw new Error(
      'Read-replica schema catalog parameters must be arrays of selected object names.',
    )
  }
  return `ARRAY[${value.map(quoteSqlText).join(', ')}]::text[]`
}

function quoteSqlText(value: string): string {
  if (value.includes('\0')) {
    throw new Error(
      'Read-replica schema catalog parameters cannot contain null bytes.',
    )
  }
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function quoteSqlIdentifier(value: string): string {
  if (!isSafeQuotedIdentifier(value))
    throw new Error('Read-replica schema identifier must be valid')

  return `"${value.replaceAll('"', '""')}"`
}

function remainingBudgetMs(deadline: number, operation: string): number {
  const remainingMs = deadline - Date.now() - CATALOG_QUERY_BUFFER_MS
  if (remainingMs <= 0) {
    throw new Error(
      `Read-replica schema sync exceeded max duration before it could ${operation}.`,
    )
  }
  return remainingMs
}

function dataApiCommandError(value: string): Error {
  const output = commandOutput(value)
  if (
    /0\.5\s*mb|request.*(?:size|limit)|payload.*(?:size|limit)/i.test(output)
  ) {
    return new Error(
      'Cloud SQL Data API rejected the SQL request at its 0.5 MB request limit. Keep the selected schema catalog bounded.',
    )
  }
  if (
    /10\s*mb|partial.?result|response.*(?:size|limit)|result.*(?:size|limit)/i.test(
      output,
    )
  ) {
    return new Error(
      'Cloud SQL Data API rejected the response at its 10 MB response limit. Keep the selected schema catalog bounded.',
    )
  }
  return new Error(`Cloud SQL Data API query failed: ${output}`)
}

function commandOutput(value: string): string {
  const message = value.trim().replaceAll(/\s+/g, ' ')
  return message ? message.slice(0, 4096) : 'no diagnostic output'
}

if (import.meta.main) {
  try {
    await main()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`::error title=Read-replica schema sync failed::${message}`)
    process.exitCode = 1
  }
}

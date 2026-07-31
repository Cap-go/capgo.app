import type { Queryable } from './schema_catalog.ts'
import type { SchemaCompatibilityIssue } from './schema_compatibility.ts'
import {
  readReplicaSchemaCatalog,
  REPLICA_FUNCTIONS,
  REPLICA_TABLES,
} from './schema_catalog.ts'
import { readReplicaSchemaCompatibilityIssues } from './schema_compatibility.ts'

interface SchemaColumn {
  table: string
  name: string
  type: string
  notNull: boolean
  default: string | null
  identity: string
  generated: string
}

interface SchemaConstraint {
  table: string
  name: string
  type: 'c' | 'p' | 'u'
  definition: string
  valid?: boolean
}

interface SchemaIndex {
  table: string
  name: string
  definition: string
  valid: boolean
  constraintOwned?: boolean
}

interface SchemaCompositeAttribute {
  position: number
  name: string
  type: string
}

interface SchemaType {
  name: string
  kind: string
  definition: unknown
}

interface TypeSyncPlan {
  statements: string[]
  reason: string | null
}

interface SchemaSequence {
  name: string
  type: string
  start: string
  increment: string
  min: string
  max: string
  cache: string
  cycle: boolean
  ownedTable: string | null
  ownedColumn: string | null
}

interface SchemaFunction {
  name: string
  arguments: string
  definition: string
}

interface SchemaTable {
  name: string
}

interface SchemaCatalog {
  columns?: SchemaColumn[]
  constraints?: SchemaConstraint[]
  functions?: SchemaFunction[]
  indexes?: SchemaIndex[]
  sequences?: SchemaSequence[]
  tables?: SchemaTable[]
  types?: SchemaType[]
}

type SyncStatementKind
  = | 'column'
    | 'constraint'
    | 'function'
    | 'index'
    | 'invalid_index'
    | 'drop_index'
    | 'sequence'
    | 'type'

type SyncObjectKind = 'column' | 'constraint' | 'function' | 'index' | 'sequence' | 'type'

export interface ReadReplicaSchemaSyncStatement {
  kind: SyncStatementKind
  table: string
  name: string
  sql: string
}

export interface ReadReplicaSchemaSyncClient extends Queryable {
  assertCanApplyReadReplicaSchemaPlan?: (
    plan: ReadReplicaSchemaSyncPlan,
  ) => void
  applyReadReplicaSchemaPlan?: (
    plan: ReadReplicaSchemaSyncPlan,
  ) => Promise<void>
}

interface SkippedChange {
  kind: SyncObjectKind
  table: string
  name: string
  reason: string
}

export interface ReadReplicaSchemaSyncPlan {
  statements: ReadReplicaSchemaSyncStatement[]
  skipped: SkippedChange[]
}

export type AdditiveSchemaSyncPlan = ReadReplicaSchemaSyncPlan

export interface ReadReplicaSchemaSyncResult {
  applied: Array<Omit<ReadReplicaSchemaSyncStatement, 'sql'>>
  skipped: SkippedChange[]
}

export type AdditiveSchemaSyncResult = ReadReplicaSchemaSyncResult

export interface ReadReplicaSchemaSyncOptions {
  statementTimeoutMs?: number
  maxDurationMs?: number
  deadline?: number
}

export type AdditiveSchemaSyncOptions = ReadReplicaSchemaSyncOptions

export interface ReadReplicaSchemaReconciliationResult
  extends ReadReplicaSchemaSyncResult {
  issues: SchemaCompatibilityIssue[]
}
const SAFE_IDENTIFIER_RE = /^[A-Z_]\w*$/i
const SAFE_SQL_FRAGMENT_RE = /^[\w .()[\],:'"{}+\-=<>!]+$/
const REPLICA_TABLE_SET = new Set<string>(REPLICA_TABLES)
const REPLICA_FUNCTION_SET = new Set<string>(REPLICA_FUNCTIONS)
const DEFAULT_SCHEMA_SYNC_STATEMENT_TIMEOUT_MS = 550_000
const DEFAULT_SCHEMA_SYNC_MAX_DURATION_MS = 585_000
const SCHEMA_SYNC_RESPONSE_BUFFER_MS = 5_000

export function planReadReplicaSchemaSync(
  expected: unknown,
  actual: unknown,
): ReadReplicaSchemaSyncPlan {
  const expectedCatalog = assertSchemaCatalog(expected)
  const actualCatalog = assertSchemaCatalog(actual)
  const actualTables = new Set(
    (actualCatalog.tables ?? []).map(table => table.name),
  )
  const actualColumnsByKey = new Map(
    (actualCatalog.columns ?? []).map(column => [columnKey(column), column]),
  )
  const actualIndexByName = new Map(
    (actualCatalog.indexes ?? []).map(index => [index.name, index]),
  )
  const expectedIndexByName = new Map(
    (expectedCatalog.indexes ?? []).map(index => [index.name, index]),
  )
  const actualConstraintsByKey = new Map(
    (actualCatalog.constraints ?? []).map(constraint => [
      constraintKey(constraint),
      constraint,
    ]),
  )
  const expectedConstraintsByKey = new Map(
    (expectedCatalog.constraints ?? []).map(constraint => [
      constraintKey(constraint),
      constraint,
    ]),
  )
  const actualFunctionsByKey = new Map(
    (actualCatalog.functions ?? []).map(fn => [functionKey(fn), fn]),
  )
  const actualTypesByName = new Map(
    (actualCatalog.types ?? []).map(type => [type.name, type]),
  )
  const skippedColumnsByTable = new Map<string, Set<string>>()
  const statements: ReadReplicaSchemaSyncStatement[] = []
  const skipped: SkippedChange[] = []

  for (const type of expectedCatalog.types ?? []) {
    if (typeMatches(type, actualTypesByName.get(type.name)))
      continue

    const typeSync = planTypeSync(type, actualTypesByName.get(type.name))
    if (typeSync.reason) {
      skipped.push({
        kind: 'type',
        table: 'public',
        name: type.name,
        reason: typeSync.reason,
      })
      continue
    }

    for (const sql of typeSync.statements) {
      statements.push({
        kind: 'type',
        table: 'public',
        name: type.name,
        sql,
      })
    }
  }

  for (const fn of expectedCatalog.functions ?? []) {
    if (functionMatches(fn, actualFunctionsByKey.get(functionKey(fn))))
      continue

    const sql = buildCreateOrReplaceFunctionStatement(fn)
    if (!sql) {
      skipped.push({
        kind: 'function',
        table: 'public',
        name: functionKey(fn),
        reason: 'unsupported_function_reconciliation',
      })
      continue
    }

    statements.push({
      kind: 'function',
      table: 'public',
      name: functionKey(fn),
      sql,
    })
  }

  for (const sequence of expectedCatalog.sequences ?? []) {
    const actualSequence = (actualCatalog.sequences ?? []).find(
      candidate => candidate.name === sequence.name,
    )
    if (sequenceMatches(sequence, actualCatalog.sequences ?? []))
      continue

    const sql = actualSequence
      ? buildAlterSequenceStatement(sequence, actualTables)
      : buildCreateSequenceStatement(sequence, actualTables)
    if (!sql) {
      skipped.push({
        kind: 'sequence',
        table: 'public',
        name: sequence.name,
        reason: 'unsupported_sequence_reconciliation',
      })
      continue
    }

    statements.push({
      kind: 'sequence',
      table: 'public',
      name: sequence.name,
      sql,
    })
  }

  for (const column of expectedCatalog.columns ?? []) {
    const actualColumn = actualColumnsByKey.get(columnKey(column))
    if (!actualColumn) {
      const addColumnSql = buildAddColumnStatement(column, actualTables)
      if (!addColumnSql) {
        trackSkippedColumn(skippedColumnsByTable, column)
        skipped.push({
          kind: 'column',
          table: column.table,
          name: column.name,
          reason: 'unsupported_additive_column',
        })
        continue
      }

      statements.push({
        kind: 'column',
        table: column.table,
        name: column.name,
        sql: addColumnSql,
      })
      continue
    }

    if (actualColumn.notNull !== column.notNull) {
      // Tightening or loosening an existing subscriber column before the
      // publisher changes can reject replicated rows. Leave it for a proven
      // publisher-compatible transition rather than risk stopping replication.
      skipped.push({
        kind: 'column',
        table: column.table,
        name: column.name,
        reason: 'pre_primary_column_nullability',
      })
    }
  }

  for (const index of expectedCatalog.indexes ?? []) {
    const actualIndex = actualIndexByName.get(index.name)
    if (indexMatches(index, actualIndex))
      continue

    if (hasUnresolvedColumnDependency(index, skippedColumnsByTable)) {
      skipped.push({
        kind: 'index',
        table: index.table,
        name: index.name,
        reason: 'unresolved_column_dependency',
      })
      continue
    }

    if (
      actualIndex?.constraintOwned !== undefined
      && actualIndex.constraintOwned
    ) {
      skipped.push({
        kind: 'index',
        table: index.table,
        name: index.name,
        reason: 'constraint_owned_index',
      })
      continue
    }

    if (actualIndex && actualIndex.table !== index.table) {
      skipped.push({
        kind: 'index',
        table: index.table,
        name: index.name,
        reason: 'index_name_conflict',
      })
      continue
    }

    if (actualIndex && actualIndex.definition !== index.definition) {
      const dropIndexSql = buildDropIndexStatement(actualIndex, actualTables)
      if (!dropIndexSql) {
        skipped.push({
          kind: 'index',
          table: index.table,
          name: index.name,
          reason:
            actualIndex.constraintOwned === undefined
              ? 'unknown_index_ownership'
              : 'unsupported_index_replacement',
        })
        continue
      }
      statements.push({
        kind: 'drop_index',
        table: actualIndex.table,
        name: actualIndex.name,
        sql: dropIndexSql,
      })
    }
    else if (actualIndex) {
      const reindexSql = buildReindexIndexStatement(index, actualTables)
      if (!reindexSql) {
        skipped.push({
          kind: 'index',
          table: index.table,
          name: index.name,
          reason:
            actualIndex.constraintOwned === undefined
              ? 'unknown_index_ownership'
              : 'unsupported_additive_index',
        })
        continue
      }

      statements.push({
        kind: 'invalid_index',
        table: index.table,
        name: index.name,
        sql: reindexSql,
      })
      continue
    }

    const addIndexSql = buildCreateIndexStatement(index, actualTables)
    if (!addIndexSql) {
      skipped.push({
        kind: 'index',
        table: index.table,
        name: index.name,
        reason: 'unsupported_additive_index',
      })
      continue
    }

    statements.push({
      kind: 'index',
      table: index.table,
      name: index.name,
      sql: addIndexSql,
    })
  }
  for (const constraint of expectedCatalog.constraints ?? []) {
    // Publisher CHECK constraints do not need to exist on a read-only logical
    // subscriber. Creating them here can only add avoidable replica writes.
    if (constraint.type === 'c')
      continue

    const actualConstraint = actualConstraintsByKey.get(
      constraintKey(constraint),
    )
    if (constraintMatches(constraint, actualConstraint))
      continue

    if (actualConstraint) {
      skipped.push({
        kind: 'constraint',
        table: constraint.table,
        name: constraint.name,
        reason: 'constraint_conflict',
      })
      continue
    }

    const expectedIndex = expectedIndexByName.get(constraint.name)
    const actualIndex = expectedIndex
      ? actualIndexByName.get(expectedIndex.name)
      : undefined
    const sql = buildAttachConstraintStatement(
      constraint,
      expectedIndex,
      actualIndex,
      actualTables,
    )
    if (!sql) {
      skipped.push({
        kind: 'constraint',
        table: constraint.table,
        name: constraint.name,
        reason: 'unsupported_key_constraint',
      })
      continue
    }

    statements.push({
      kind: 'constraint',
      table: constraint.table,
      name: constraint.name,
      sql,
    })
  }

  for (const constraint of actualCatalog.constraints ?? []) {
    if (expectedConstraintsByKey.has(constraintKey(constraint)))
      continue

    skipped.push({
      kind: 'constraint',
      table: constraint.table,
      name: constraint.name,
      reason: 'unexpected_constraint',
    })
  }

  for (const index of actualCatalog.indexes ?? []) {
    if (expectedIndexByName.has(index.name))
      continue

    const dropIndexSql = buildDropIndexStatement(index, actualTables)
    if (!dropIndexSql) {
      skipped.push({
        kind: 'index',
        table: index.table,
        name: index.name,
        reason:
          index.constraintOwned === undefined
            ? 'unknown_index_ownership'
            : 'constraint_owned_index',
      })
      continue
    }

    statements.push({
      kind: 'drop_index',
      table: index.table,
      name: index.name,
      sql: dropIndexSql,
    })
  }

  return { statements, skipped }
}

export const planReadReplicaAdditiveSchemaSync = planReadReplicaSchemaSync

export async function applyReadReplicaSchemaSync(
  client: ReadReplicaSchemaSyncClient,
  expected: unknown,
  options: ReadReplicaSchemaSyncOptions = {},
): Promise<ReadReplicaSchemaSyncResult> {
  const deadline = options.deadline ?? (
    Date.now()
    + positiveIntegerOrDefault(
      options.maxDurationMs,
      DEFAULT_SCHEMA_SYNC_MAX_DURATION_MS,
    )
  )
  assertTimeRemaining(deadline, 'read the subscriber schema catalog')
  const actual = await readReplicaSchemaCatalog(client)
  assertTimeRemaining(deadline, 'plan subscriber schema reconciliation')
  const plan = planReadReplicaSchemaSync(expected, actual)
  const statementTimeoutMs = positiveIntegerOrDefault(
    options.statementTimeoutMs,
    DEFAULT_SCHEMA_SYNC_STATEMENT_TIMEOUT_MS,
  )
  const applyPlan = client.applyReadReplicaSchemaPlan
  const assertPlan = client.assertCanApplyReadReplicaSchemaPlan
  if (applyPlan && !assertPlan) {
    throw new Error(
      'Transactional read-replica schema execution must preflight the whole reconciliation plan before applying schema changes',
    )
  }
  assertPlan?.(plan)

  try {
    if (applyPlan) {
      if (plan.statements.length) {
        assertTimeRemaining(deadline, 'apply the transactional subscriber schema plan')
        await applyPlan(plan)
        assertTimeRemaining(deadline, 'finish the transactional subscriber schema plan')
      }
    }
    else {
      for (const statement of plan.statements) {
        await setStatementTimeoutForRemainingBudget(
          client,
          statementTimeoutMs,
          deadline,
          statement,
        )
        await client.query(statement.sql)
        assertTimeRemaining(
          deadline,
          `finish ${statement.kind} ${statement.table}.${statement.name}`,
        )
      }
    }
  }
  finally {
    await client.query('RESET statement_timeout')
  }

  assertTimeRemaining(deadline, 'read the post-DDL subscriber schema catalog')
  const finalActual = await readReplicaSchemaCatalog(client)
  assertTimeRemaining(deadline, 'validate applied subscriber schema changes')
  assertAppliedStatementsVisible(plan.statements, expected, finalActual)

  return {
    applied: plan.statements.map(({ kind, table, name }) => ({
      kind,
      table,
      name,
    })),
    skipped: plan.skipped,
  }
}
export const applyReadReplicaAdditiveSchemaSync = applyReadReplicaSchemaSync

export async function reconcileReadReplicaSchema(
  master: Queryable,
  replica: ReadReplicaSchemaSyncClient,
  options: ReadReplicaSchemaSyncOptions = {},
): Promise<ReadReplicaSchemaReconciliationResult> {
  const deadline = options.deadline ?? (
    Date.now()
    + positiveIntegerOrDefault(
      options.maxDurationMs,
      DEFAULT_SCHEMA_SYNC_MAX_DURATION_MS,
    )
  )
  assertTimeRemaining(deadline, 'read the primary schema catalog')
  const expected = await readReplicaSchemaCatalog(master)
  assertTimeRemaining(deadline, 'reconcile the subscriber schema')
  const result = await applyReadReplicaSchemaSync(replica, expected, {
    ...options,
    deadline,
  })
  assertTimeRemaining(deadline, 'read the final primary schema catalog')
  const finalExpected = await readReplicaSchemaCatalog(master)
  assertTimeRemaining(deadline, 'read the final subscriber schema catalog')
  const finalActual = await readReplicaSchemaCatalog(replica)
  assertTimeRemaining(deadline, 'compare the final selected schemas')

  return {
    ...result,
    issues: readReplicaSchemaCompatibilityIssues(finalExpected, finalActual),
  }
}

function assertAppliedStatementsVisible(
  applied: readonly ReadReplicaSchemaSyncStatement[],
  expected: unknown,
  actual: unknown,
): void {
  const remaining = new Set(
    planReadReplicaSchemaSync(expected, actual).statements.map(statementKey),
  )
  const unavailable = applied.filter(statement =>
    remaining.has(statementKey(statement)),
  )
  if (!unavailable.length)
    return

  throw new Error(
    `Read-replica schema sync did not persist ${unavailable.map(statement => `${statement.kind} ${statement.table}.${statement.name}`).join(', ')}`,
  )
}

function statementKey(
  statement: Pick<ReadReplicaSchemaSyncStatement, 'kind' | 'table' | 'name'>,
): string {
  const kind = statement.kind === 'invalid_index' ? 'index' : statement.kind
  return `${kind}:${statement.table}.${statement.name}`
}

function indexMatches(
  expected: SchemaIndex,
  actual: SchemaIndex | undefined,
): boolean {
  return (
    actual?.table === expected.table
    && actual.valid
    && actual.definition === expected.definition
  )
}

async function setStatementTimeoutForRemainingBudget(
  client: Queryable,
  maxStatementTimeoutMs: number,
  deadline: number,
  statement: ReadReplicaSchemaSyncStatement,
): Promise<void> {
  const remainingMs = deadline - Date.now() - SCHEMA_SYNC_RESPONSE_BUFFER_MS
  if (remainingMs <= 0) {
    throw new Error(
      `Read-replica schema sync exceeded max duration before ${statement.kind} ${statement.table}.${statement.name}`,
    )
  }

  await client.query(
    `SET statement_timeout = ${Math.min(maxStatementTimeoutMs, remainingMs)}`,
  )
}

function assertTimeRemaining(deadline: number, action: string): void {
  if (Date.now() >= deadline) {
    throw new Error(
      `Read-replica schema sync exceeded max duration before it could ${action}`,
    )
  }
}

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return fallback

  return Math.trunc(value)
}

function assertSchemaCatalog(value: unknown): SchemaCatalog {
  if (!value || typeof value !== 'object')
    throw new Error('Expected read-replica schema catalog JSON object')

  const catalog = value as SchemaCatalog
  for (const collection of [
    'columns',
    'constraints',
    'functions',
    'indexes',
    'sequences',
    'tables',
    'types',
  ] as const) {
    if (catalog[collection] && !Array.isArray(catalog[collection]))
      throw new Error(`Read-replica schema catalog ${collection} must be an array`)
  }

  for (const column of catalog.columns ?? []) assertSchemaColumn(column)
  for (const constraint of catalog.constraints ?? [])
    assertSchemaConstraint(constraint)
  for (const fn of catalog.functions ?? []) assertSchemaFunction(fn)
  for (const index of catalog.indexes ?? []) assertSchemaIndex(index)
  for (const sequence of catalog.sequences ?? []) assertSchemaSequence(sequence)
  for (const table of catalog.tables ?? []) assertSchemaTable(table)
  for (const type of catalog.types ?? []) assertSchemaType(type)
  return catalog
}

function assertSchemaColumn(value: unknown): asserts value is SchemaColumn {
  const column = assertCatalogObject(value, 'columns') as Partial<SchemaColumn>
  if (
    typeof column.table !== 'string'
    || typeof column.name !== 'string'
    || typeof column.type !== 'string'
  ) {
    throw new TypeError(
      'Read-replica schema catalog columns must include string table, name, and type',
    )
  }
  if (typeof column.notNull !== 'boolean') {
    throw new TypeError(
      'Read-replica schema catalog columns must include boolean notNull',
    )
  }
  if (column.default !== null && typeof column.default !== 'string') {
    throw new Error(
      'Read-replica schema catalog column defaults must be strings or null',
    )
  }
  if (
    typeof column.identity !== 'string'
    || typeof column.generated !== 'string'
  ) {
    throw new TypeError(
      'Read-replica schema catalog columns must include string identity and generated fields',
    )
  }
}

function assertSchemaConstraint(
  value: unknown,
): asserts value is SchemaConstraint {
  const constraint = assertCatalogObject(
    value,
    'constraints',
  ) as Partial<SchemaConstraint>
  if (
    typeof constraint.table !== 'string'
    || typeof constraint.name !== 'string'
    || typeof constraint.definition !== 'string'
    || !isConstraintType(constraint.type)
  ) {
    throw new TypeError(
      'Read-replica schema catalog constraints must include table, name, type, and definition',
    )
  }
  if (constraint.valid !== undefined && typeof constraint.valid !== 'boolean') {
    throw new TypeError(
      'Read-replica schema catalog constraint valid must be boolean when present',
    )
  }
}

function assertSchemaFunction(value: unknown): asserts value is SchemaFunction {
  const fn = assertCatalogObject(value, 'functions') as Partial<SchemaFunction>
  if (
    typeof fn.name !== 'string'
    || typeof fn.arguments !== 'string'
    || typeof fn.definition !== 'string'
  ) {
    throw new TypeError(
      'Read-replica schema catalog functions must include name, arguments, and definition',
    )
  }
}

function assertSchemaIndex(value: unknown): asserts value is SchemaIndex {
  const index = assertCatalogObject(value, 'indexes') as Partial<SchemaIndex>
  if (
    typeof index.table !== 'string'
    || typeof index.name !== 'string'
    || typeof index.definition !== 'string'
  ) {
    throw new TypeError(
      'Read-replica schema catalog indexes must include string table, name, and definition',
    )
  }
  if (typeof index.valid !== 'boolean') {
    throw new TypeError(
      'Read-replica schema catalog indexes must include boolean valid',
    )
  }
  if (
    index.constraintOwned !== undefined
    && typeof index.constraintOwned !== 'boolean'
  ) {
    throw new Error(
      'Read-replica schema catalog indexes constraintOwned must be boolean when present',
    )
  }
}

function assertSchemaSequence(value: unknown): asserts value is SchemaSequence {
  const sequence = assertCatalogObject(
    value,
    'sequences',
  ) as Partial<SchemaSequence>
  const textFields = [
    sequence.name,
    sequence.type,
    sequence.start,
    sequence.increment,
    sequence.min,
    sequence.max,
    sequence.cache,
  ]
  if (textFields.some(field => typeof field !== 'string')) {
    throw new TypeError(
      'Read-replica schema catalog sequences must include string structural fields',
    )
  }
  if (typeof sequence.cycle !== 'boolean') {
    throw new TypeError(
      'Read-replica schema catalog sequences must include boolean cycle',
    )
  }
  if (
    (sequence.ownedTable !== null && typeof sequence.ownedTable !== 'string')
    || (sequence.ownedColumn !== null && typeof sequence.ownedColumn !== 'string')
  ) {
    throw new TypeError(
      'Read-replica schema catalog sequences must include nullable ownership fields',
    )
  }
}

function assertSchemaTable(value: unknown): asserts value is SchemaTable {
  const table = assertCatalogObject(value, 'tables') as Partial<SchemaTable>
  if (typeof table.name !== 'string') {
    throw new TypeError(
      'Read-replica schema catalog tables must include string names',
    )
  }
}

function assertSchemaType(value: unknown): asserts value is SchemaType {
  const type = assertCatalogObject(value, 'types') as Partial<SchemaType>
  if (typeof type.name !== 'string' || typeof type.kind !== 'string') {
    throw new TypeError(
      'Read-replica schema catalog types must include string name and kind',
    )
  }
  if (type.kind === 'e') {
    if (
      !Array.isArray(type.definition)
      || !type.definition.every(label => typeof label === 'string')
      || new Set(type.definition).size !== type.definition.length
    ) {
      throw new TypeError(
        'Read-replica enum types must include unique string labels',
      )
    }
    return
  }
  if (type.kind !== 'c')
    return

  if (!Array.isArray(type.definition)) {
    throw new TypeError(
      'Read-replica composite types must include attribute definitions',
    )
  }

  const names = new Set<string>()
  const positions = new Set<number>()
  for (const value of type.definition) {
    assertSchemaCompositeAttribute(value)
    if (names.has(value.name) || positions.has(value.position)) {
      throw new TypeError(
        'Read-replica composite types must include unique attributes',
      )
    }
    names.add(value.name)
    positions.add(value.position)
  }
}

function assertSchemaCompositeAttribute(
  value: unknown,
): asserts value is SchemaCompositeAttribute {
  const attribute = assertCatalogObject(
    value,
    'types',
  ) as Partial<SchemaCompositeAttribute>
  if (
    typeof attribute.position !== 'number'
    || !Number.isSafeInteger(attribute.position)
    || attribute.position <= 0
    || typeof attribute.name !== 'string'
    || typeof attribute.type !== 'string'
  ) {
    throw new TypeError(
      'Read-replica composite type attributes must include position, name, and type',
    )
  }
}

function assertCatalogObject(value: unknown, collection: string): object {
  if (!value || typeof value !== 'object') {
    throw new Error(
      `Read-replica schema catalog ${collection} must contain objects`,
    )
  }

  return value
}

function typeMatches(
  expected: SchemaType,
  actual: SchemaType | undefined,
): boolean {
  if (!actual || actual.kind !== expected.kind)
    return false

  return JSON.stringify(actual.definition) === JSON.stringify(expected.definition)
}

function planTypeSync(
  expected: SchemaType,
  actual: SchemaType | undefined,
): TypeSyncPlan {
  if (!isSafeIdentifier(expected.name))
    return { statements: [], reason: 'unsafe_type_name' }
  if (!actual) {
    const statement = buildCreateTypeStatement(expected)
    return statement
      ? { statements: [statement], reason: null }
      : { statements: [], reason: 'unsupported_type_creation' }
  }
  if (actual.kind !== expected.kind)
    return { statements: [], reason: 'type_kind_conflict' }
  if (expected.kind === 'e')
    return planEnumTypeSync(expected, actual)
  if (expected.kind === 'c')
    return planCompositeTypeSync(expected, actual)

  return { statements: [], reason: 'unsupported_type_reconciliation' }
}

function buildCreateTypeStatement(type: SchemaType): string | null {
  if (type.kind === 'e') {
    const labels = enumLabels(type)
    const values = labels && quoteEnumValues(labels)
    if (!values?.length)
      return null

    return `CREATE TYPE public.${quoteIdent(type.name)} AS ENUM (${values.join(', ')})`
  }
  if (type.kind !== 'c')
    return null

  const attributes = compositeTypeAttributes(type)
  if (!attributes?.length || !hasSequentialCompositePositions(attributes))
    return null

  const definitions = compositeAttributeDefinitions(attributes)
  if (!definitions)
    return null

  return `CREATE TYPE public.${quoteIdent(type.name)} AS (${definitions.join(', ')})`
}

function planEnumTypeSync(
  expected: SchemaType,
  actual: SchemaType,
): TypeSyncPlan {
  const expectedLabels = enumLabels(expected)
  const actualLabels = enumLabels(actual)
  if (!expectedLabels || !actualLabels) {
    return { statements: [], reason: 'unsupported_enum_reconciliation' }
  }
  if (!isEnumPrefix(actualLabels, expectedLabels)) {
    return { statements: [], reason: 'unsafe_enum_reconciliation' }
  }

  const values = quoteEnumValues(expectedLabels.slice(actualLabels.length))
  if (!values)
    return { statements: [], reason: 'unsupported_enum_reconciliation' }

  return {
    statements: values.map(
      value => `ALTER TYPE public.${quoteIdent(expected.name)} ADD VALUE IF NOT EXISTS ${value}`,
    ),
    reason: null,
  }
}

function planCompositeTypeSync(
  expected: SchemaType,
  actual: SchemaType,
): TypeSyncPlan {
  const expectedAttributes = compositeTypeAttributes(expected)
  const actualAttributes = compositeTypeAttributes(actual)
  if (!expectedAttributes || !actualAttributes) {
    return { statements: [], reason: 'unsupported_composite_reconciliation' }
  }
  if (
    !hasSequentialCompositePositions(expectedAttributes)
    || !hasSequentialCompositePositions(actualAttributes)
    || !isCompositePrefix(actualAttributes, expectedAttributes)
  ) {
    return { statements: [], reason: 'unsafe_composite_reconciliation' }
  }

  const definitions = compositeAttributeDefinitions(
    expectedAttributes.slice(actualAttributes.length),
  )
  if (!definitions) {
    return { statements: [], reason: 'unsupported_composite_reconciliation' }
  }

  return {
    statements: definitions.map(
      definition => `ALTER TYPE public.${quoteIdent(expected.name)} ADD ATTRIBUTE ${definition}`,
    ),
    reason: null,
  }
}

function enumLabels(type: SchemaType): string[] | null {
  if (
    type.kind !== 'e'
    || !Array.isArray(type.definition)
    || !type.definition.every(label => typeof label === 'string')
  ) {
    return null
  }

  return type.definition as string[]
}

function compositeTypeAttributes(
  type: SchemaType,
): SchemaCompositeAttribute[] | null {
  if (
    type.kind !== 'c'
    || !Array.isArray(type.definition)
    || !type.definition.every(isSchemaCompositeAttribute)
  ) {
    return null
  }

  return type.definition as SchemaCompositeAttribute[]
}

function isSchemaCompositeAttribute(
  value: unknown,
): value is SchemaCompositeAttribute {
  if (!value || typeof value !== 'object')
    return false

  const attribute = value as Partial<SchemaCompositeAttribute>
  return (
    typeof attribute.position === 'number'
    && Number.isSafeInteger(attribute.position)
    && attribute.position > 0
    && typeof attribute.name === 'string'
    && typeof attribute.type === 'string'
  )
}

function isEnumPrefix(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length <= expected.length
    && actual.every((label, index) => label === expected[index])
}

function isCompositePrefix(
  actual: readonly SchemaCompositeAttribute[],
  expected: readonly SchemaCompositeAttribute[],
): boolean {
  return actual.length <= expected.length
    && actual.every((attribute, index) => {
      const expectedAttribute = expected[index]
      return attribute.position === expectedAttribute.position
        && attribute.name === expectedAttribute.name
        && attribute.type === expectedAttribute.type
    })
}

function hasSequentialCompositePositions(
  attributes: readonly SchemaCompositeAttribute[],
): boolean {
  return attributes.every(
    (attribute, index) => attribute.position === index + 1,
  )
}

function compositeAttributeDefinitions(
  attributes: readonly SchemaCompositeAttribute[],
): string[] | null {
  const definitions: string[] = []
  for (const attribute of attributes) {
    if (!isSafeIdentifier(attribute.name) || !isSafeSqlFragment(attribute.type))
      return null

    definitions.push(`${quoteIdent(attribute.name)} ${attribute.type}`)
  }

  return definitions
}

function quoteEnumValues(values: readonly string[]): string[] | null {
  const quotedValues: string[] = []
  for (const value of values) {
    if (value.includes('\0'))
      return null

    quotedValues.push(
      `E'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\'\'')}'`,
    )
  }

  return quotedValues
}

function buildAddColumnStatement(
  column: SchemaColumn,
  actualTables: Set<string>,
): string | null {
  if (!isSafeReplicaTable(column.table, actualTables))
    return null
  if (!isSafeIdentifier(column.name))
    return null
  if (column.identity || column.generated)
    return null
  if (!isSafeSqlFragment(column.type))
    return null
  if (
    column.default !== null
    && (!isSafeSqlFragment(column.default)
      || !isSafeConstantDefault(column.default))
  ) {
    return null
  }
  if (
    column.notNull
    && (column.default === null || isNullDefault(column.default))
  ) {
    return null
  }

  const defaultSql
    = column.default === null ? '' : ` DEFAULT ${column.default}`
  const notNullSql = column.notNull ? ' NOT NULL' : ''
  return `ALTER TABLE ${quoteQualifiedTable(column.table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(column.name)} ${column.type}${defaultSql}${notNullSql}`
}

function buildCreateIndexStatement(
  index: SchemaIndex,
  actualTables: Set<string>,
): string | null {
  if (!isSafeReplicaTable(index.table, actualTables))
    return null
  if (!isSafeQuotedIdentifier(index.name))
    return null
  if (!isSafeSchemaDefinition(index.definition))
    return null

  const parsedDefinition = parseCreateIndexDefinition(index.definition)
  if (!parsedDefinition)
    return null

  const { unique, indexName, tableName, indexTail } = parsedDefinition
  if (indexName !== index.name || tableName !== index.table)
    return null

  return `CREATE ${unique}INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteQualifiedTable(index.table)} ${indexTail}`
}
function buildAttachConstraintStatement(
  constraint: SchemaConstraint,
  expectedIndex: SchemaIndex | undefined,
  actualIndex: SchemaIndex | undefined,
  actualTables: Set<string>,
): string | null {
  if (
    (constraint.type !== 'p' && constraint.type !== 'u')
    || !isSafeReplicaTable(constraint.table, actualTables)
    || !isSafeQuotedIdentifier(constraint.name)
    || !expectedIndex
    || expectedIndex.name !== constraint.name
    || expectedIndex.table !== constraint.table
    || expectedIndex.constraintOwned !== true
  ) {
    return null
  }
  if (
    actualIndex
    && (
      actualIndex.table !== constraint.table
      || actualIndex.constraintOwned !== false
    )
  ) {
    return null
  }
  if (
    !actualIndex
    || !indexMatches(expectedIndex, actualIndex)
  ) {
    if (!buildCreateIndexStatement(expectedIndex, actualTables))
      return null
  }

  const kind = constraint.type === 'p' ? 'PRIMARY KEY' : 'UNIQUE'
  return `ALTER TABLE ${quoteQualifiedTable(constraint.table)} ADD CONSTRAINT ${quoteIdent(constraint.name)} ${kind} USING INDEX ${quoteIdent(expectedIndex.name)}`
}

function buildCreateOrReplaceFunctionStatement(
  fn: SchemaFunction,
): string | null {
  const expectedPrefix = `CREATE OR REPLACE FUNCTION public.${fn.name}(`
  if (
    !REPLICA_FUNCTION_SET.has(fn.name)
    || !isSafeIdentifier(fn.name)
    || fn.arguments.includes('\0')
    || !fn.definition.startsWith(expectedPrefix)
    || fn.definition.includes('\0')
  ) {
    return null
  }

  return fn.definition
}

function buildCreateSequenceStatement(
  sequence: SchemaSequence,
  actualTables: Set<string>,
): string | null {
  if (!isSafeQuotedIdentifier(sequence.name))
    return null

  const options = buildSequenceOptions(sequence, actualTables)
  if (!options)
    return null

  return `CREATE SEQUENCE IF NOT EXISTS public.${quoteIdent(sequence.name)} ${options}`
}

function buildAlterSequenceStatement(
  sequence: SchemaSequence,
  actualTables: Set<string>,
): string | null {
  if (!isSafeQuotedIdentifier(sequence.name))
    return null

  const options = buildSequenceOptions(sequence, actualTables)
  if (!options)
    return null

  return `ALTER SEQUENCE public.${quoteIdent(sequence.name)} ${options}`
}

function buildSequenceOptions(
  sequence: SchemaSequence,
  actualTables: Set<string>,
): string | null {
  if (!isSafeSequenceDataType(sequence.type))
    return null
  for (const value of [
    sequence.start,
    sequence.increment,
    sequence.min,
    sequence.max,
    sequence.cache,
  ]) {
    if (!isSafeSequenceNumber(value))
      return null
  }

  const ownedBy = buildSequenceOwnership(sequence, actualTables)
  if (!ownedBy)
    return null

  const cycle = sequence.cycle ? 'CYCLE' : 'NO CYCLE'
  return `AS ${sequence.type} START WITH ${sequence.start} INCREMENT BY ${sequence.increment} MINVALUE ${sequence.min} MAXVALUE ${sequence.max} CACHE ${sequence.cache} ${cycle} ${ownedBy}`
}

function buildSequenceOwnership(
  sequence: SchemaSequence,
  actualTables: Set<string>,
): string | null {
  if (sequence.ownedTable === null && sequence.ownedColumn === null)
    return 'OWNED BY NONE'
  if (
    typeof sequence.ownedTable !== 'string'
    || typeof sequence.ownedColumn !== 'string'
    || !isSafeReplicaTable(sequence.ownedTable, actualTables)
    || !isSafeIdentifier(sequence.ownedColumn)
  ) {
    return null
  }

  return `OWNED BY ${quoteQualifiedTable(sequence.ownedTable)}.${quoteIdent(sequence.ownedColumn)}`
}

function isSafeSequenceDataType(value: string): boolean {
  return value === 'smallint' || value === 'integer' || value === 'bigint'
}

function isSafeSequenceNumber(value: string): boolean {
  return /^-?\d+$/.test(value)
}

function buildDropIndexStatement(
  index: SchemaIndex,
  actualTables: Set<string>,
): string | null {
  if (index.constraintOwned !== false)
    return null
  if (!isSafeReplicaTable(index.table, actualTables))
    return null
  if (!isSafeQuotedIdentifier(index.name))
    return null

  return `DROP INDEX CONCURRENTLY IF EXISTS public.${quoteIdent(index.name)}`
}

function buildReindexIndexStatement(
  index: SchemaIndex,
  actualTables: Set<string>,
): string | null {
  if (
    !isSafeReplicaTable(index.table, actualTables)
    || !isSafeQuotedIdentifier(index.name)
  ) {
    return null
  }

  return `REINDEX INDEX CONCURRENTLY public.${quoteIdent(index.name)}`
}

function parseCreateIndexDefinition(
  definition: string,
): {
  unique: string
  indexName: string
  tableName: string
  indexTail: string
} | null {
  let rest = definition
  if (!rest.startsWith('CREATE '))
    return null
  rest = rest.slice('CREATE '.length)

  const unique = rest.startsWith('UNIQUE ') ? 'UNIQUE ' : ''
  if (unique)
    rest = rest.slice(unique.length)

  if (!rest.startsWith('INDEX '))
    return null
  rest = rest.slice('INDEX '.length)

  const parsedIndexName = parseSqlIdentifier(rest)
  if (!parsedIndexName)
    return null
  rest = parsedIndexName.rest.trimStart()

  const tablePrefix = 'ON public.'
  if (!rest.startsWith(tablePrefix))
    return null
  rest = rest.slice(tablePrefix.length)

  const parsedTableName = parseSqlIdentifier(rest)
  if (!parsedTableName)
    return null
  rest = parsedTableName.rest.trimStart()
  if (!rest)
    return null

  return {
    unique,
    indexName: parsedIndexName.identifier,
    tableName: parsedTableName.identifier,
    indexTail: rest,
  }
}

function parseSqlIdentifier(value: string): {
  identifier: string
  rest: string
} | null {
  if (value.startsWith('"')) {
    let identifier = ''
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] !== '"') {
        identifier += value[index]
        continue
      }
      if (value[index + 1] === '"') {
        identifier += '"'
        index += 1
        continue
      }
      return { identifier, rest: value.slice(index + 1) }
    }
    return null
  }

  const match = /^([A-Z_]\w*)/i.exec(value)
  if (!match)
    return null

  return {
    identifier: match[1],
    rest: value.slice(match[1].length),
  }
}

function isSafeReplicaTable(table: string, actualTables: Set<string>): boolean {
  return (
    REPLICA_TABLE_SET.has(table)
    && actualTables.has(table)
    && isSafeIdentifier(table)
  )
}

function trackSkippedColumn(
  skippedColumnsByTable: Map<string, Set<string>>,
  column: SchemaColumn,
): void {
  const tableColumns
    = skippedColumnsByTable.get(column.table) ?? new Set<string>()
  tableColumns.add(column.name)
  skippedColumnsByTable.set(column.table, tableColumns)
}

function hasUnresolvedColumnDependency(
  index: SchemaIndex,
  skippedColumnsByTable: Map<string, Set<string>>,
): boolean {
  const skippedColumns = skippedColumnsByTable.get(index.table)
  if (!skippedColumns?.size)
    return false

  const parsedDefinition = parseCreateIndexDefinition(index.definition)
  if (!parsedDefinition)
    return false

  for (const column of skippedColumns) {
    if (indexTailReferencesColumn(parsedDefinition.indexTail, column))
      return true
  }

  return false
}

function indexTailReferencesColumn(indexTail: string, column: string): boolean {
  return (
    indexTail.includes(quoteIdent(column))
    || new RegExp(
      `(^|[^A-Za-z0-9_"])${escapeRegExp(column)}($|[^A-Za-z0-9_"])`,
    ).test(indexTail)
  )
}

function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_RE.test(value)
}

function isSafeQuotedIdentifier(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

function isSafeSqlFragment(value: string): boolean {
  return (
    SAFE_SQL_FRAGMENT_RE.test(value)
    && !value.includes(';')
    && !value.includes('--')
    && !value.includes('/*')
    && !value.includes('*/')
  )
}

function isSafeSchemaDefinition(value: string): boolean {
  return (
    value.length > 0
    && !value.includes('\0')
    && !value.includes(';')
    && !value.includes('--')
    && !value.includes('/*')
    && !value.includes('*/')
  )
}

function isConstraintType(value: unknown): value is SchemaConstraint['type'] {
  return value === 'c' || value === 'p' || value === 'u'
}

function constraintMatches(
  expected: SchemaConstraint,
  actual: SchemaConstraint | undefined,
): boolean {
  return (
    constraintShapeMatches(expected, actual)
    && (expected.valid === undefined || actual?.valid === undefined || expected.valid === actual.valid)
  )
}

function constraintShapeMatches(
  expected: SchemaConstraint,
  actual: SchemaConstraint | undefined,
): boolean {
  return (
    actual?.table === expected.table
    && actual.type === expected.type
    && actual.definition === expected.definition
  )
}

function functionMatches(
  expected: SchemaFunction,
  actual: SchemaFunction | undefined,
): boolean {
  return actual?.definition === expected.definition
}

function sequenceMatches(
  expected: SchemaSequence,
  actualSequences: readonly SchemaSequence[],
): boolean {
  const actual = actualSequences.find(sequence => sequence.name === expected.name)
  return (
    actual?.type === expected.type
    && actual.start === expected.start
    && actual.increment === expected.increment
    && actual.min === expected.min
    && actual.max === expected.max
    && actual.cache === expected.cache
    && actual.cycle === expected.cycle
    && actual.ownedTable === expected.ownedTable
    && actual.ownedColumn === expected.ownedColumn
  )
}

function isSafeConstantDefault(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '(')
      continue

    const previous = previousNonWhitespace(value, index)
    if (previous && (isIdentifierChar(previous) || previous === '"'))
      return false
  }

  return true
}

function previousNonWhitespace(value: string, index: number): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!isWhitespace(value[cursor]))
      return value[cursor]
  }

  return null
}

function isWhitespace(value: string): boolean {
  return (
    value === ' '
    || value === '\n'
    || value === '\r'
    || value === '\t'
    || value === '\f'
  )
}

function isIdentifierChar(value: string): boolean {
  return (
    value === '_'
    || (value >= 'A' && value <= 'Z')
    || (value >= 'a' && value <= 'z')
    || (value >= '0' && value <= '9')
  )
}

function isNullDefault(value: string): boolean {
  return /^NULL\b/i.test(value)
}
function quoteQualifiedTable(table: string): string {
  return `public.${quoteIdent(table)}`
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function columnKey(column: Pick<SchemaColumn, 'table' | 'name'>): string {
  return `${column.table}.${column.name}`
}

function constraintKey(
  constraint: Pick<SchemaConstraint, 'table' | 'name'>,
): string {
  return `${constraint.table}.${constraint.name}`
}

function functionKey(
  fn: Pick<SchemaFunction, 'name' | 'arguments'>,
): string {
  return `${fn.name}(${fn.arguments})`
}

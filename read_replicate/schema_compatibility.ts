import { stableJson } from './schema_json.ts'

interface SchemaColumn {
  table: string
  name: string
  position: number
  type: string
  notNull: boolean
  default: string | null
  identity: string
  generated: string
}

interface SchemaConstraint {
  table: string
  name: string
  type: string
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

interface SchemaTable {
  name: string
  kind: string
  reloptions: unknown
}

interface SchemaType {
  name: string
  kind: string
  definition: unknown
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

interface SchemaCatalog {
  version?: number
  columns?: SchemaColumn[]
  constraints?: SchemaConstraint[]
  indexes?: SchemaIndex[]
  tables?: SchemaTable[]
  types?: SchemaType[]
  sequences?: SchemaSequence[]
  functions?: SchemaFunction[]
}

export interface SchemaCompatibilityIssue {
  kind: 'catalog_version' | 'column' | 'constraint' | 'function' | 'index' | 'sequence' | 'table' | 'type'
  object: string
  reason: string
}

// Strict comparison is retained for snapshot tooling. The release gate below is
// directional because PostgreSQL logical subscribers may deliberately retain
// columns and supporting objects that the publisher has already dropped.
export function readReplicaSchemaCompatibilityIssues(expected: unknown, actual: unknown): SchemaCompatibilityIssue[] {
  return readReplicaSchemaCompatibilityIssuesInternal(expected, actual, false)
}

// A logical subscriber must accept every publisher column, but it can safely
// retain nullable or default-backed legacy columns until the publisher removes
// them. This is the compatibility relation used before primary migrations.
export function readReplicaSubscriberCompatibilityIssues(expected: unknown, actual: unknown): SchemaCompatibilityIssue[] {
  return readReplicaSchemaCompatibilityIssuesInternal(expected, actual, true)
}

function readReplicaSchemaCompatibilityIssuesInternal(
  expected: unknown,
  actual: unknown,
  allowSafeSubscriberOnlyObjects: boolean,
): SchemaCompatibilityIssue[] {
  const expectedCatalog = assertSchemaCatalog(expected, 'expected')
  const actualCatalog = assertSchemaCatalog(actual, 'actual')
  const issues: SchemaCompatibilityIssue[] = []

  if (expectedCatalog.version !== actualCatalog.version) {
    issues.push({
      kind: 'catalog_version',
      object: 'catalog',
      reason: `expected version ${expectedCatalog.version ?? 'missing'}, found ${actualCatalog.version ?? 'missing'}`,
    })
  }

  compareTables(expectedCatalog, actualCatalog, issues)
  compareColumns(expectedCatalog, actualCatalog, issues, allowSafeSubscriberOnlyObjects)
  compareConstraints(expectedCatalog, actualCatalog, issues)
  compareIndexes(expectedCatalog, actualCatalog, issues, allowSafeSubscriberOnlyObjects)
  compareTypes(expectedCatalog, actualCatalog, issues, allowSafeSubscriberOnlyObjects)
  compareSequences(expectedCatalog, actualCatalog, issues, allowSafeSubscriberOnlyObjects)
  compareFunctions(expectedCatalog, actualCatalog, issues, allowSafeSubscriberOnlyObjects)

  return issues
}

function compareTables(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  issues: SchemaCompatibilityIssue[],
): void {
  const expectedTables = new Map((expected.tables ?? []).map(table => [table.name, table]))
  const actualTables = new Map((actual.tables ?? []).map(table => [table.name, table]))

  for (const expectedTable of expected.tables ?? []) {
    const actualTable = actualTables.get(expectedTable.name)
    if (!actualTable) {
      issues.push({ kind: 'table', object: expectedTable.name, reason: 'missing required table' })
      continue
    }
    if (actualTable.kind !== expectedTable.kind)
      issues.push({ kind: 'table', object: expectedTable.name, reason: `expected kind ${expectedTable.kind}, found ${actualTable.kind}` })
  }
  for (const actualTable of actual.tables ?? []) {
    if (!expectedTables.has(actualTable.name))
      issues.push({ kind: 'table', object: actualTable.name, reason: 'unexpected table' })
  }
}

function compareColumns(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  const expectedColumns = new Map((expected.columns ?? []).map(column => [columnKey(column), column]))
  const actualColumns = new Map((actual.columns ?? []).map(column => [columnKey(column), column]))

  compareExpectedColumns(expected.columns ?? [], actualColumns, issues)
  compareSubscriberOnlyColumns(
    actual.columns ?? [],
    expectedColumns,
    issues,
    allowSafeSubscriberOnlyObjects,
  )
}

function compareExpectedColumns(
  expectedColumns: SchemaColumn[],
  actualColumns: Map<string, SchemaColumn>,
  issues: SchemaCompatibilityIssue[],
): void {
  for (const expectedColumn of expectedColumns) {
    const key = columnKey(expectedColumn)
    const actualColumn = actualColumns.get(key)
    if (!actualColumn) {
      issues.push({ kind: 'column', object: key, reason: 'missing required column' })
      continue
    }

    compareMatchingColumns(expectedColumn, actualColumn, issues)
  }
}

function compareMatchingColumns(
  expectedColumn: SchemaColumn,
  actualColumn: SchemaColumn,
  issues: SchemaCompatibilityIssue[],
): void {
  const key = columnKey(expectedColumn)
  if (actualColumn.type !== expectedColumn.type) {
    issues.push({
      kind: 'column',
      object: key,
      reason: `expected type ${expectedColumn.type}, found ${actualColumn.type}`,
    })
  }
  if (actualColumn.notNull !== expectedColumn.notNull) {
    issues.push({
      kind: 'column',
      object: key,
      reason: expectedColumn.notNull
        ? 'publisher is NOT NULL while subscriber accepts NULL'
        : 'subscriber is NOT NULL while publisher accepts NULL',
    })
  }
  if (actualColumn.identity !== expectedColumn.identity) {
    issues.push({
      kind: 'column',
      object: key,
      reason: `expected identity kind ${displayValue(expectedColumn.identity)}, found ${displayValue(actualColumn.identity)}`,
    })
  }
  if (actualColumn.generated !== expectedColumn.generated) {
    issues.push({
      kind: 'column',
      object: key,
      reason: `expected generated kind ${displayValue(expectedColumn.generated)}, found ${displayValue(actualColumn.generated)}`,
    })
  }
}

function compareSubscriberOnlyColumns(
  actualColumns: SchemaColumn[],
  expectedColumns: Map<string, SchemaColumn>,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  for (const actualColumn of actualColumns) {
    const key = columnKey(actualColumn)
    if (expectedColumns.has(key))
      continue
    if (allowSafeSubscriberOnlyObjects && subscriberOnlyColumnCanAcceptPublisherRows(actualColumn))
      continue
    issues.push({
      kind: 'column',
      object: key,
      reason: allowSafeSubscriberOnlyObjects
        ? 'subscriber-only column can reject replicated rows'
        : 'unexpected column',
    })
  }
}

function compareConstraints(expected: SchemaCatalog, actual: SchemaCatalog, issues: SchemaCompatibilityIssue[]): void {
  const expectedConstraints = new Map((expected.constraints ?? []).map(constraint => [constraintKey(constraint), constraint]))
  const actualConstraints = new Map((actual.constraints ?? []).map(constraint => [constraintKey(constraint), constraint]))

  for (const expectedConstraint of expected.constraints ?? []) {
    const key = constraintKey(expectedConstraint)
    const actualConstraint = actualConstraints.get(key)
    if (expectedConstraint.type === 'c') {
      if (
        actualConstraint
        && (
          actualConstraint.type !== 'c'
          || actualConstraint.definition !== expectedConstraint.definition
        )
      ) {
        issues.push({ kind: 'constraint', object: key, reason: 'subscriber CHECK constraint differs' })
      }
      continue
    }

    if (!actualConstraint) {
      issues.push({ kind: 'constraint', object: key, reason: 'missing required constraint' })
      continue
    }

    if (actualConstraint.type !== expectedConstraint.type) {
      issues.push({
        kind: 'constraint',
        object: key,
        reason: `expected type ${expectedConstraint.type}, found ${actualConstraint.type}`,
      })
    }
    if (actualConstraint.definition !== expectedConstraint.definition)
      issues.push({ kind: 'constraint', object: key, reason: 'constraint definition differs' })
    if (expectedConstraint.valid !== undefined || actualConstraint.valid !== undefined) {
      if (actualConstraint.valid !== expectedConstraint.valid) {
        issues.push({
          kind: 'constraint',
          object: key,
          reason: `expected valid ${displayValue(expectedConstraint.valid)}, found ${displayValue(actualConstraint.valid)}`,
        })
      }
    }
  }

  for (const actualConstraint of actual.constraints ?? []) {
    const key = constraintKey(actualConstraint)
    if (!expectedConstraints.has(key))
      issues.push({ kind: 'constraint', object: key, reason: 'unexpected constraint' })
  }
}

function compareIndexes(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  const expectedIndexes = new Map((expected.indexes ?? []).map(index => [index.name, index]))
  const actualIndexes = new Map((actual.indexes ?? []).map(index => [index.name, index]))

  compareExpectedIndexes(expected.indexes ?? [], actualIndexes, issues)
  compareSubscriberOnlyIndexes(
    actual.indexes ?? [],
    expectedIndexes,
    issues,
    allowSafeSubscriberOnlyObjects,
  )
}

function compareExpectedIndexes(
  expectedIndexes: SchemaIndex[],
  actualIndexes: Map<string, SchemaIndex>,
  issues: SchemaCompatibilityIssue[],
): void {
  for (const expectedIndex of expectedIndexes) {
    const actualIndex = actualIndexes.get(expectedIndex.name)
    if (!actualIndex) {
      issues.push({ kind: 'index', object: expectedIndex.name, reason: 'missing required index' })
      continue
    }

    compareMatchingIndexes(expectedIndex, actualIndex, issues)
  }
}

function compareMatchingIndexes(
  expectedIndex: SchemaIndex,
  actualIndex: SchemaIndex,
  issues: SchemaCompatibilityIssue[],
): void {
  if (actualIndex.table !== expectedIndex.table) {
    issues.push({
      kind: 'index',
      object: expectedIndex.name,
      reason: `expected table ${expectedIndex.table}, found ${actualIndex.table}`,
    })
  }
  if (actualIndex.definition !== expectedIndex.definition)
    issues.push({ kind: 'index', object: expectedIndex.name, reason: 'index definition differs' })
  if (actualIndex.valid !== expectedIndex.valid) {
    issues.push({
      kind: 'index',
      object: expectedIndex.name,
      reason: expectedIndex.valid && !actualIndex.valid
        ? 'index is invalid'
        : `expected valid ${displayValue(expectedIndex.valid)}, found ${displayValue(actualIndex.valid)}`,
    })
  }
  if (indexConstraintOwnershipDiffers(expectedIndex, actualIndex)) {
    issues.push({
      kind: 'index',
      object: expectedIndex.name,
      reason: `expected constraintOwned ${displayValue(expectedIndex.constraintOwned)}, found ${displayValue(actualIndex.constraintOwned)}`,
    })
  }
}

function indexConstraintOwnershipDiffers(
  expectedIndex: SchemaIndex,
  actualIndex: SchemaIndex,
): boolean {
  return expectedIndex.constraintOwned !== undefined
    && actualIndex.constraintOwned !== undefined
    && actualIndex.constraintOwned !== expectedIndex.constraintOwned
}

function compareSubscriberOnlyIndexes(
  actualIndexes: SchemaIndex[],
  expectedIndexes: Map<string, SchemaIndex>,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  for (const actualIndex of actualIndexes) {
    if (expectedIndexes.has(actualIndex.name))
      continue
    if (allowSafeSubscriberOnlyObjects && subscriberOnlyIndexCannotRejectPublisherRows(actualIndex))
      continue
    issues.push({
      kind: 'index',
      object: actualIndex.name,
      reason: allowSafeSubscriberOnlyObjects
        ? 'subscriber-only unique index can reject replicated rows'
        : 'unexpected index adds storage and write cost',
    })
  }
}
function compareTypes(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  const expectedTypes = new Map((expected.types ?? []).map(type => [type.name, type]))
  const actualTypes = new Map((actual.types ?? []).map(type => [type.name, type]))

  for (const expectedType of expected.types ?? []) {
    const actualType = actualTypes.get(expectedType.name)
    if (!actualType) {
      issues.push({ kind: 'type', object: expectedType.name, reason: 'missing required type' })
      continue
    }
    if (actualType.kind !== expectedType.kind) {
      issues.push({
        kind: 'type',
        object: expectedType.name,
        reason: `expected kind ${expectedType.kind}, found ${actualType.kind}`,
      })
      continue
    }
    if (!sameValue(actualType.definition, expectedType.definition))
      issues.push({ kind: 'type', object: expectedType.name, reason: 'type definition differs' })
  }

  if (allowSafeSubscriberOnlyObjects)
    return

  for (const actualType of actual.types ?? []) {
    if (!expectedTypes.has(actualType.name))
      issues.push({ kind: 'type', object: actualType.name, reason: 'unexpected type' })
  }
}

function compareSequences(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  const expectedSequences = new Map((expected.sequences ?? []).map(sequence => [sequence.name, sequence]))
  const actualSequences = new Map((actual.sequences ?? []).map(sequence => [sequence.name, sequence]))
  const fields = [
    ['type', 'type'],
    ['start', 'start'],
    ['increment', 'increment'],
    ['min', 'min'],
    ['max', 'max'],
    ['cache', 'cache'],
    ['cycle', 'cycle'],
    ['ownedTable', 'owned table'],
    ['ownedColumn', 'owned column'],
  ] as const

  for (const expectedSequence of expected.sequences ?? []) {
    const actualSequence = actualSequences.get(expectedSequence.name)
    if (!actualSequence) {
      issues.push({ kind: 'sequence', object: expectedSequence.name, reason: 'missing required sequence' })
      continue
    }

    for (const [field, label] of fields) {
      if (actualSequence[field] !== expectedSequence[field]) {
        issues.push({
          kind: 'sequence',
          object: expectedSequence.name,
          reason: `expected ${label} ${displayValue(expectedSequence[field])}, found ${displayValue(actualSequence[field])}`,
        })
      }
    }
  }

  if (allowSafeSubscriberOnlyObjects)
    return

  for (const actualSequence of actual.sequences ?? []) {
    if (!expectedSequences.has(actualSequence.name))
      issues.push({ kind: 'sequence', object: actualSequence.name, reason: 'unexpected sequence' })
  }
}

function compareFunctions(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
  issues: SchemaCompatibilityIssue[],
  allowSafeSubscriberOnlyObjects: boolean,
): void {
  const expectedFunctions = new Map((expected.functions ?? []).map(fn => [functionKey(fn), fn]))
  const actualFunctions = new Map((actual.functions ?? []).map(fn => [functionKey(fn), fn]))

  for (const expectedFunction of expected.functions ?? []) {
    const key = functionKey(expectedFunction)
    const actualFunction = actualFunctions.get(key)
    if (!actualFunction) {
      issues.push({ kind: 'function', object: key, reason: 'missing required function overload' })
      continue
    }
    if (actualFunction.definition !== expectedFunction.definition)
      issues.push({ kind: 'function', object: key, reason: 'function definition differs' })
  }

  if (allowSafeSubscriberOnlyObjects)
    return

  for (const actualFunction of actual.functions ?? []) {
    const key = functionKey(actualFunction)
    if (!expectedFunctions.has(key))
      issues.push({ kind: 'function', object: key, reason: 'unexpected function overload' })
  }
}
function subscriberOnlyColumnCanAcceptPublisherRows(column: SchemaColumn): boolean {
  return !column.notNull || hasNonNullDefault(column.default)
}

function hasNonNullDefault(defaultValue: string | null): boolean {
  if (defaultValue === null)
    return false

  const normalized = defaultValue.trim().toUpperCase()
  return normalized !== 'NULL' && !/^NULL::[A-Z0-9_." ]+$/u.test(normalized)
}

function subscriberOnlyIndexCannotRejectPublisherRows(index: SchemaIndex): boolean {
  return index.constraintOwned !== true && !/^CREATE\s+UNIQUE\s+INDEX\b/iu.test(index.definition)
}

function assertSchemaCatalog(value: unknown, label: string): SchemaCatalog {
  if (!value || typeof value !== 'object')
    throw new Error(`Expected ${label} read-replica schema catalog JSON object`)

  const catalog = value as SchemaCatalog
  for (const collection of ['columns', 'constraints', 'functions', 'indexes', 'sequences', 'tables', 'types'] as const) {
    if (catalog[collection] !== undefined && !Array.isArray(catalog[collection]))
      throw new Error(`Read-replica schema catalog ${collection} must be an array`)
  }
  return catalog
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function columnKey(column: Pick<SchemaColumn, 'table' | 'name'>): string {
  return `${column.table}.${column.name}`
}

function constraintKey(constraint: Pick<SchemaConstraint, 'table' | 'name'>): string {
  return `${constraint.table}.${constraint.name}`
}

function functionKey(fn: Pick<SchemaFunction, 'name' | 'arguments'>): string {
  return `${fn.name}(${fn.arguments})`
}

function displayValue(value: unknown): string {
  if (value === undefined)
    return 'missing'
  if (value === null)
    return 'null'
  if (value === '')
    return 'none'
  if (typeof value === 'string')
    return value
  return stableJson(value)
}

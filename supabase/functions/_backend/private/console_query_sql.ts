// Compiles the console's recorded PostgREST builder calls into parameterized SQL.
// Identifiers are allowlisted by shape and quoted; values stay in placeholders.
// `count: 'estimated'` is executed as an exact count: a planner estimate changes
// as the table grows and breaks the console pager, while each page is already
// scoped to one app or organization.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const JSON_PATH = /^([a-z_][a-z0-9_]*)->>(([a-z_][a-z0-9_]*)|"([^"]+)")$/
const MAX_ROWS = 1000

// Column filters widen integers and similar types. Comparisons accept that.
// RPC arguments cannot reuse these casts: PostgreSQL resolves an explicit
// ::bigint against an integer parameter as a different function.
const CAST_BY_UDT: Record<string, string> = {
  uuid: 'uuid',
  text: 'text',
  varchar: 'varchar',
  bpchar: 'text',
  int2: 'bigint',
  int4: 'bigint',
  int8: 'bigint',
  bool: 'boolean',
  boolean: 'boolean',
  jsonb: 'jsonb',
  json: 'jsonb',
  timestamptz: 'timestamptz',
  timestamp: 'timestamptz',
  date: 'date',
  numeric: 'numeric',
  float4: 'numeric',
  float8: 'numeric',
  _text: 'text[]',
  _varchar: 'text[]',
  _uuid: 'uuid[]',
  _int2: 'bigint[]',
  _int4: 'bigint[]',
  _int8: 'bigint[]',
}

const RPC_ARGUMENT_CAST: Record<string, string> = {
  bpchar: 'bpchar',
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  json: 'json',
  timestamp: 'timestamp',
  _varchar: 'varchar[]',
  _int2: 'smallint[]',
  _int4: 'integer[]',
  _int8: 'bigint[]',
}

// Longest first so `not.cd` wins over `not` and values may contain later dots.
const FILTER_OPERATORS = [
  'not.ilike',
  'not.like',
  'not.neq',
  'not.gte',
  'not.lte',
  'not.eq',
  'not.gt',
  'not.lt',
  'not.in',
  'not.is',
  'not.cs',
  'not.cd',
  'not.ov',
  'ilike',
  'like',
  'neq',
  'gte',
  'lte',
  'eq',
  'gt',
  'lt',
  'is',
  'in',
  'cs',
  'cd',
  'ov',
]

const OPERATOR_ALIASES: Record<string, string> = {
  eq: 'eq',
  neq: 'neq',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  like: 'like',
  ilike: 'ilike',
  is: 'is',
  in: 'in',
  cs: 'cs',
  cd: 'cd',
  ov: 'ov',
  contains: 'cs',
  containedBy: 'cd',
  overlaps: 'ov',
}

export interface QueryColumn {
  name: string
  udt: string
}

export interface QueryForeignKey {
  name: string
  sourceTable: string
  sourceColumn: string
  targetTable: string
  targetColumn: string
  /** True when the source columns are covered by a primary or unique key. */
  unique: boolean
}

export interface QueryFunction {
  name: string
  argNames: string[]
  argTypes: string[]
  returnsSet: boolean
  returnsComposite: boolean
  /** Trailing input arguments that have SQL defaults. Callers may omit them. */
  defaultCount: number
}

export interface QueryCatalog {
  columns: Map<string, QueryColumn[]>
  foreignKeys: QueryForeignKey[]
  functions: QueryFunction[]
}

export interface CatalogFunctionRow {
  name: string
  returns_set: boolean
  arg_count: number
  arg_names: unknown
  arg_modes: unknown
  return_kind: string
  arg_types: unknown
  default_count?: unknown
}

// node-pg leaves name[] and "char"[] as text (`{varchar}`, `{i}`, `{}`).
// text[] arrives as a real array. Both have to become the same string list.
export function readPgTextArray(value: unknown): string[] | null {
  if (value == null)
    return null
  if (Array.isArray(value))
    return value.map(item => item == null ? '' : String(item))
  if (typeof value !== 'string')
    return null
  const literal = value.trim()
  if (!literal.startsWith('{') || !literal.endsWith('}'))
    return null
  const body = literal.slice(1, -1)
  if (!body)
    return []
  const items: string[] = []
  let index = 0
  while (index < body.length) {
    if (body[index] === '"') {
      let token = ''
      index += 1
      while (index < body.length) {
        const char = body[index]
        if (char === '\\') {
          token += body[index + 1] ?? ''
          index += 2
          continue
        }
        if (char === '"') {
          if (body[index + 1] === '"') {
            token += '"'
            index += 2
            continue
          }
          index += 1
          break
        }
        token += char
        index += 1
      }
      items.push(token)
    }
    else {
      const end = body.indexOf(',', index)
      const stop = end === -1 ? body.length : end
      const token = body.slice(index, stop)
      items.push(token === 'NULL' ? '' : token)
      index = stop
    }
    if (body[index] === ',')
      index += 1
  }
  return items
}

function inputArgNames(names: string[], modes: string[] | null, argCount: number): string[] {
  // Null modes means every argument is an input. An empty mode list is the same.
  if (!modes?.length)
    return names.slice(0, argCount)
  const inputs: string[] = []
  for (let index = 0; index < modes.length; index++) {
    const mode = modes[index]
    if (mode === 'i' || mode === 'b' || mode === 'v')
      inputs.push(names[index] ?? '')
  }
  return inputs
}

function defaultCountOf(value: unknown, argCount: number): number {
  const count = Number(value ?? 0)
  if (!Number.isInteger(count) || count <= 0)
    return 0
  return Math.min(count, argCount)
}

export function functionFromCatalogRow(row: CatalogFunctionRow): QueryFunction | null {
  const argNames = inputArgNames(readPgTextArray(row.arg_names) ?? [], readPgTextArray(row.arg_modes), Number(row.arg_count))
  const argTypes = readPgTextArray(row.arg_types) ?? []
  if (argNames.length !== argTypes.length)
    return null
  const returnsSet = row.returns_set === true
  // RETURNS TABLE is a set of record (typtype p). A one-column alias keeps only
  // the first column, so the row has to be read as a composite.
  const returnsComposite = row.return_kind === 'c' || (returnsSet && row.return_kind === 'p')
  return {
    name: row.name,
    argNames,
    argTypes,
    returnsSet,
    returnsComposite,
    defaultCount: defaultCountOf(row.default_count, argNames.length),
  }
}

export interface ConsoleQueryOperation {
  method: string
  args: unknown[]
}

export interface ConsoleQueryRequest {
  kind: 'table' | 'rpc'
  name: string
  args: unknown[]
  operations: ConsoleQueryOperation[]
}

export interface CompiledConsoleQuery {
  text: string
  values: unknown[]
  cardinality: 'many' | 'one' | 'maybe'
  head: boolean
  count: boolean
  kind: 'table' | 'rpc'
  returnsSet: boolean
  // Write with no .select(), count, or head. PostgREST return=minimal: data is null.
  minimal?: boolean
}

export interface ConsoleQueryFailure {
  message: string
  code: string
  details: string | null
}

export interface ConsoleQueryResult {
  data: unknown
  error: ConsoleQueryFailure | null
  count: number | null
  status: number
}

export class ConsoleQueryError extends Error {
  readonly code: string
  readonly status: number
  readonly details: string | null

  constructor(code: string, message: string, status = 400, details: string | null = null) {
    super(message)
    this.name = 'ConsoleQueryError'
    this.code = code
    this.status = status
    this.details = details
  }
}

interface EmbedLink {
  alias: string
  inner: boolean
  toOne: boolean
  childTable: string
  parentColumn: string
  childColumn: string
  fields: SelectField[]
}

interface SelectField {
  kind: 'column' | 'embed'
  name: string
  column?: string
  embed?: EmbedLink
}

class Params {
  readonly values: unknown[] = []

  add(value: unknown, cast: string): string {
    this.values.push(value)
    return `$${this.values.length}::${cast}`
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new ConsoleQueryError(code, message, status)
}

function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name))
    fail('PGRST100', 'Invalid identifier')
  return `"${name}"`
}

function sqlString(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function castOf(udt: string): string {
  const cast = CAST_BY_UDT[udt]
  if (cast)
    return cast
  if (IDENTIFIER.test(udt))
    return udt
  fail('PGRST100', 'Unsupported column type')
}

function argumentCast(udt: string): string {
  return RPC_ARGUMENT_CAST[udt] ?? castOf(udt)
}

function arrayCast(udt: string): string {
  const cast = castOf(udt)
  if (cast.endsWith('[]'))
    return cast
  return `${cast}[]`
}

function isJsonUdt(udt: string): boolean {
  return udt === 'json' || udt === 'jsonb'
}

function tableColumns(catalog: QueryCatalog, table: string): QueryColumn[] {
  const columns = catalog.columns.get(table)
  if (!columns)
    fail('42P01', `Could not find the table '${table}'`)
  return columns
}

function columnByName(columns: QueryColumn[], name: string): QueryColumn {
  const column = columns.find(item => item.name === name)
  if (!column)
    fail('42703', `column '${name}' does not exist`)
  return column
}

function splitTop(input: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  // PostgREST quotes a filter value with double quotes. An apostrophe in a
  // name such as O'Reilly is a literal character, not a quote.
  let quoted = false
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          index++
          continue
        }
        quoted = false
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '(')
      depth++
    else if (char === ')')
      depth--
    else if (char === separator && depth === 0) {
      parts.push(input.slice(start, index))
      start = index + 1
    }
  }
  parts.push(input.slice(start))
  return parts
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed.slice(1, -1).replaceAll('""', '"')
  return trimmed
}

function jsonbLiteral(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value)
      return value
    }
    catch {
      return JSON.stringify(value)
    }
  }
  return JSON.stringify(value)
}

function parseEmbedHead(head: string): { alias: string, relation: string, inner: boolean, constraint?: string } {
  const trimmed = head.trim()
  const colon = trimmed.indexOf(':')
  const alias = colon === -1 ? trimmed.split('!')[0] : trimmed.slice(0, colon)
  const relationAndHints = colon === -1 ? trimmed : trimmed.slice(colon + 1)
  const [relation, ...hints] = relationAndHints.split('!')
  if (!IDENTIFIER.test(alias.trim()) || !relation || !IDENTIFIER.test(relation.trim()))
    fail('PGRST100', 'Invalid embed')
  const constraint = hints.map(hint => hint.trim()).filter(hint => hint && hint !== 'inner')
  if (constraint.length > 1)
    fail('PGRST100', 'Invalid embed hint')
  return {
    alias: alias.trim(),
    relation: relation.trim(),
    inner: hints.some(hint => hint.trim() === 'inner'),
    constraint: constraint[0],
  }
}

function resolveEmbed(catalog: QueryCatalog, parent: string, relation: string, constraint: string | undefined): Omit<EmbedLink, 'alias' | 'inner' | 'fields'> {
  const keys = catalog.foreignKeys
  let match: QueryForeignKey | undefined
  if (constraint) {
    const found = keys.filter(key => key.name === constraint && (key.sourceTable === parent || key.targetTable === parent))
    if (found.length !== 1)
      fail('PGRST201', `Could not embed because the relationship '${constraint}' was not found on '${parent}'`)
    match = found[0]
  }
  else {
    const byColumn = keys.filter(key => key.sourceTable === parent && key.sourceColumn === relation)
    const byTarget = keys.filter(key => key.sourceTable === parent && key.targetTable === relation)
    const byReverse = keys.filter(key => key.targetTable === parent && key.sourceTable === relation)
    const found = byColumn.length ? byColumn : byTarget.length ? byTarget : byReverse
    if (found.length === 0)
      fail('PGRST200', `Could not find a relationship between '${parent}' and '${relation}'`)
    if (found.length > 1)
      fail('PGRST201', `Could not embed because more than one relationship was found for '${relation}' on '${parent}'`)
    match = found[0]
  }
  if (match.sourceTable === parent) {
    return {
      toOne: true,
      childTable: match.targetTable,
      parentColumn: match.sourceColumn,
      childColumn: match.targetColumn,
    }
  }
  return {
    toOne: match.unique,
    childTable: match.sourceTable,
    parentColumn: match.targetColumn,
    childColumn: match.sourceColumn,
  }
}

function parseSelectFields(catalog: QueryCatalog, table: string, input: string): { star: boolean, fields: SelectField[] } {
  const columns = tableColumns(catalog, table)
  const fields: SelectField[] = []
  let star = false
  for (const part of splitTop(input, ',')) {
    const trimmed = part.trim()
    if (!trimmed)
      continue
    if (trimmed === '*') {
      star = true
      continue
    }
    const open = trimmed.indexOf('(')
    if (open !== -1) {
      if (!trimmed.endsWith(')'))
        fail('PGRST100', 'Invalid embed')
      const head = parseEmbedHead(trimmed.slice(0, open))
      const link = resolveEmbed(catalog, table, head.relation, head.constraint)
      const nested = parseSelectFields(catalog, link.childTable, trimmed.slice(open + 1, -1))
      const nestedFields = nested.star
        ? [{ kind: 'column' as const, name: '*', column: '*' }, ...nested.fields.filter(field => field.kind === 'embed')]
        : nested.fields
      fields.push({
        kind: 'embed',
        name: head.alias,
        embed: { ...link, alias: head.alias, inner: head.inner, fields: nestedFields },
      })
      continue
    }
    if (trimmed.includes(':')) {
      const [alias, column] = trimmed.split(':')
      if (!alias || !column || !IDENTIFIER.test(alias.trim()) || !IDENTIFIER.test(column.trim()))
        fail('PGRST100', 'Invalid select')
      columnByName(columns, column.trim())
      fields.push({ kind: 'column', name: alias.trim(), column: column.trim() })
      continue
    }
    if (!IDENTIFIER.test(trimmed))
      fail('PGRST100', 'Invalid select')
    columnByName(columns, trimmed)
    fields.push({ kind: 'column', name: trimmed, column: trimmed })
  }
  return { star, fields }
}

function embedByAlias(fields: SelectField[], alias: string): EmbedLink | undefined {
  for (const field of fields) {
    if (field.kind === 'embed' && field.embed?.alias === alias)
      return field.embed
  }
  return undefined
}

interface QueryTarget {
  expression: string
  udt: string
  existsFrom?: string
}

function resolveTarget(catalog: QueryCatalog, table: string, parentAlias: string, fields: SelectField[], reference: string): QueryTarget {
  const jsonPath = JSON_PATH.exec(reference)
  if (jsonPath) {
    const column = columnByName(tableColumns(catalog, table), jsonPath[1])
    if (!isJsonUdt(column.udt))
      fail('42703', `column '${jsonPath[1]}' is not json`)
    const key = jsonPath[3] ?? jsonPath[4]
    if (!key)
      fail('PGRST100', 'Invalid json path')
    return { expression: `(${parentAlias}.${quoteIdent(column.name)}->>${sqlString(key)})`, udt: 'text' }
  }
  const dotted = reference.split('.')
  if (dotted.length > 2)
    fail('PGRST100', 'Nested filters only support one relationship')
  if (dotted.length === 2) {
    const embed = embedByAlias(fields, dotted[0])
    if (!embed || !IDENTIFIER.test(dotted[1]))
      fail('PGRST201', `Could not find the relationship '${dotted[0]}' in the selection`)
    columnByName(tableColumns(catalog, embed.childTable), dotted[1])
    const childAlias = 'ef'
    return {
      expression: `${childAlias}.${quoteIdent(dotted[1])}`,
      udt: columnByName(tableColumns(catalog, embed.childTable), dotted[1]).udt,
      existsFrom: `"public".${quoteIdent(embed.childTable)} AS ${childAlias} WHERE ${childAlias}.${quoteIdent(embed.childColumn)} = ${parentAlias}.${quoteIdent(embed.parentColumn)} AND `,
    }
  }
  if (!IDENTIFIER.test(reference))
    fail('PGRST100', 'Invalid identifier')
  const column = columnByName(tableColumns(catalog, table), reference)
  return { expression: `${parentAlias}.${quoteIdent(column.name)}`, udt: column.udt }
}

function predicateSql(params: Params, target: QueryTarget, operator: string, value: unknown, negate: boolean): string {
  let sql: string
  if (operator === 'is' || (value === null && (operator === 'eq' || operator === 'neq'))) {
    const literal = value === null || value === 'null'
      ? 'NULL'
      : value === true || value === 'true'
        ? 'TRUE'
        : value === false || value === 'false'
          ? 'FALSE'
          : null
    if (!literal)
      fail('PGRST100', 'Invalid is filter')
    const positive = operator === 'neq' ? 'IS NOT' : 'IS'
    sql = `${target.expression} ${positive} ${literal}`
  }
  else if (operator === 'in') {
    const items = Array.isArray(value) ? value : [value]
    sql = `${target.expression} = ANY(${params.add(items, arrayCast(target.udt))})`
  }
  else {
    const comparison: Record<string, string> = {
      eq: '=',
      neq: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
      like: 'LIKE',
      ilike: 'ILIKE',
      cs: '@>',
      cd: '<@',
      ov: '&&',
    }
    const token = comparison[operator]
    if (!token)
      fail('PGRST100', 'Unsupported filter')
    const cast = castOf(target.udt)
    const bound = cast === 'jsonb' ? jsonbLiteral(value) : value
    sql = `${target.expression} ${token} ${params.add(bound, cast)}`
  }
  if (negate)
    sql = `NOT (${sql})`
  if (target.existsFrom)
    sql = `EXISTS (SELECT 1 FROM ${target.existsFrom}${sql})`
  return sql
}

function normalizeOperator(operator: string): { operator: string, negate: boolean } {
  const lowered = operator.trim()
  const negated = lowered.startsWith('not.')
  const name = negated ? lowered.slice(4) : lowered
  const resolved = OPERATOR_ALIASES[name]
  if (!resolved)
    fail('PGRST100', 'Unsupported filter')
  return { operator: resolved, negate: negated }
}

function parseFilterValue(operator: string, raw: string): unknown {
  if (operator === 'in') {
    const body = raw.trim().startsWith('(') && raw.trim().endsWith(')') ? raw.trim().slice(1, -1) : raw
    if (body.trim() === '')
      return []
    return splitTop(body, ',').map(item => unquote(item))
  }
  const value = unquote(raw)
  if ((operator === 'is' || operator === 'eq' || operator === 'neq') && value === 'null')
    return null
  if (operator === 'is' && (value === 'true' || value === 'false'))
    return value === 'true'
  return value
}

function parseLogic(expression: string): { type: 'and' | 'or' | 'not-and' | 'not-or', inner: string } | { type: 'predicate', expression: string } {
  const trimmed = expression.trim()
  const groups = [
    ['and(', 'and'],
    ['or(', 'or'],
    ['not.and(', 'not-and'],
    ['not.or(', 'not-or'],
  ] as const
  for (const [prefix, type] of groups) {
    if (trimmed.startsWith(prefix) && trimmed.endsWith(')'))
      return { type, inner: trimmed.slice(prefix.length, -1) }
  }
  return { type: 'predicate', expression: trimmed }
}

function splitPredicate(expression: string): { field: string, operator: string, value: string } {
  for (let index = 0; index < expression.length; index++) {
    if (expression[index] !== '.')
      continue
    const rest = expression.slice(index + 1)
    for (const operator of FILTER_OPERATORS) {
      const boundary = rest[operator.length]
      if (!rest.startsWith(operator) || (boundary !== undefined && boundary !== '.'))
        continue
      const field = expression.slice(0, index)
      if (!field || field.endsWith('>') || field.includes('('))
        continue
      return {
        field,
        operator,
        value: boundary === undefined ? '' : rest.slice(operator.length + 1),
      }
    }
  }
  fail('PGRST100', 'Invalid filter')
}

function compileLogic(catalog: QueryCatalog, table: string, parentAlias: string, fields: SelectField[], params: Params, expression: string): string {
  const parsed = parseLogic(expression)
  if (parsed.type === 'predicate') {
    if (!parsed.expression)
      fail('PGRST100', 'Invalid filter')
    const predicate = splitPredicate(parsed.expression)
    const operator = normalizeOperator(predicate.operator)
    const target = resolveTarget(catalog, table, parentAlias, fields, predicate.field)
    return predicateSql(params, target, operator.operator, parseFilterValue(operator.operator, predicate.value), operator.negate)
  }
  const joiner = parsed.type === 'or' || parsed.type === 'not-or' ? ' OR ' : ' AND '
  const parts = splitTop(parsed.inner, ',').map(part => part.trim()).filter(Boolean)
  if (!parts.length)
    fail('PGRST100', 'Invalid filter')
  const sql = `(${parts.map(part => compileLogic(catalog, table, parentAlias, fields, params, part)).join(joiner)})`
  return parsed.type === 'not-and' || parsed.type === 'not-or' ? `NOT ${sql}` : sql
}

function optionsOf(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null)
    return {}
  if (typeof value !== 'object' || Array.isArray(value))
    fail('PGRST100', 'Invalid query options')
  return value as Record<string, unknown>
}

function rejectEmbeddedModifier(options: Record<string, unknown>) {
  if (typeof options.foreignTable === 'string' || typeof options.referencedTable === 'string')
    fail('PGRST100', 'Filtering or ordering an embedded table this way is not supported')
}

function writeRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : [value]
  if (!rows.length || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))
    fail('PGRST100', 'Invalid write body')
  const keys = Object.keys(rows[0] as Record<string, unknown>).sort((left, right) => left.localeCompare(right))
  if (!keys.length)
    fail('PGRST100', 'Invalid write body')
  for (const row of rows) {
    const rowKeys = Object.keys(row as Record<string, unknown>).sort((left, right) => left.localeCompare(right))
    if (rowKeys.length !== keys.length || rowKeys.some((key, index) => key !== keys[index]))
      fail('PGRST100', 'Write rows must have the same columns')
  }
  return rows as Record<string, unknown>[]
}

function projectionSql(catalog: QueryCatalog, table: string, parentAlias: string, star: boolean, fields: SelectField[], sequence: { next: number }): string {
  const columns = tableColumns(catalog, table)
  const pieces: string[] = []
  if (!star) {
    for (const field of fields) {
      if (field.kind === 'column' && field.column && field.column !== '*') {
        columnByName(columns, field.column)
        pieces.push(`${sqlString(field.name)}, ${parentAlias}.${quoteIdent(field.column)}`)
      }
    }
  }
  for (const field of fields) {
    if (field.kind !== 'embed' || !field.embed)
      continue
    const embed = field.embed
    const childAlias = `e${sequence.next++}`
    const childStar = embed.fields.some(item => item.column === '*') || embed.fields.length === 0
    const childJson = projectionSql(catalog, embed.childTable, childAlias, childStar, embed.fields.filter(item => item.column !== '*'), sequence)
    const where = `${childAlias}.${quoteIdent(embed.childColumn)} = ${parentAlias}.${quoteIdent(embed.parentColumn)}`
    const subquery = embed.toOne
      ? `(SELECT ${childJson} FROM "public".${quoteIdent(embed.childTable)} AS ${childAlias} WHERE ${where})`
      : `COALESCE((SELECT jsonb_agg(${childJson}) FROM "public".${quoteIdent(embed.childTable)} AS ${childAlias} WHERE ${where}), '[]'::jsonb)`
    pieces.push(`${sqlString(embed.alias)}, ${subquery}`)
  }
  if (star) {
    const row = `to_jsonb(${parentAlias})`
    if (!pieces.length)
      return row
    return `${row} || jsonb_build_object(${pieces.join(', ')})`
  }
  if (!pieces.length)
    fail('PGRST100', 'Empty select')
  return `jsonb_build_object(${pieces.join(', ')})`
}

function innerSql(parentAlias: string, fields: SelectField[]): string[] {
  const clauses: string[] = []
  for (const field of fields) {
    if (field.kind !== 'embed' || !field.embed?.inner)
      continue
    const embed = field.embed
    clauses.push(`EXISTS (SELECT 1 FROM "public".${quoteIdent(embed.childTable)} AS ei WHERE ei.${quoteIdent(embed.childColumn)} = ${parentAlias}.${quoteIdent(embed.parentColumn)})`)
  }
  return clauses
}

function orderSql(catalog: QueryCatalog, table: string, parentAlias: string, column: string, options: Record<string, unknown>): string {
  if (!IDENTIFIER.test(column))
    fail('PGRST100', 'Invalid identifier')
  columnByName(tableColumns(catalog, table), column)
  const direction = options.ascending === false ? 'DESC' : 'ASC'
  let nulls = ''
  if (options.nullsFirst === true)
    nulls = ' NULLS FIRST'
  else if (options.nullsFirst === false)
    nulls = ' NULLS LAST'
  return `${parentAlias}.${quoteIdent(column)} ${direction}${nulls}`
}

function valueSql(params: Params, udt: string, value: unknown, cast = castOf(udt)): string {
  if (value === null)
    return 'NULL'
  // Write bodies and RPC args are JSON values. A string must stay a JSON string.
  // Filter predicates keep jsonbLiteral, because PostgREST filter text is raw JSON.
  if (isJsonUdt(udt))
    return params.add(JSON.stringify(value), cast)
  return params.add(value, cast)
}

function conflictColumns(columns: QueryColumn[], value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim())
    fail('PGRST100', 'Upsert requires onConflict')
  const names = value.split(',').map(name => name.trim())
  if (!names.length || names.some(name => !IDENTIFIER.test(name)))
    fail('PGRST100', 'Invalid onConflict')
  for (const name of names)
    columnByName(columns, name)
  return names
}

function compileTable(catalog: QueryCatalog, request: ConsoleQueryRequest): CompiledConsoleQuery {
  if (!IDENTIFIER.test(request.name))
    fail('PGRST100', 'Invalid identifier')
  const columns = tableColumns(catalog, request.name)
  const params = new Params()
  let verb: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let selectText: string | null = null
  let count = false
  let head = false
  let cardinality: CompiledConsoleQuery['cardinality'] = 'many'
  const filters: string[] = []
  const orderSpecs: { column: string, options: Record<string, unknown> }[] = []
  let limit: number | null = null
  let offset = 0
  let rows: Record<string, unknown>[] | null = null
  let onConflict: string[] | null = null
  let ignoreDuplicates = false
  let star = true
  let fields: SelectField[] = []

  const rememberSelect = (args: unknown[]) => {
    const text = typeof args[0] === 'string' ? args[0] : '*'
    selectText = text
    const parsed = parseSelectFields(catalog, request.name, text)
    star = parsed.star || text.trim() === '*' || text.trim() === ''
    fields = parsed.fields
    const options = optionsOf(args[1])
    count = options.count === 'exact' || options.count === 'estimated' || options.count === 'planned'
    head = options.head === true
  }

  for (const operation of request.operations) {
    if (operation.method === 'select')
      rememberSelect(operation.args)
  }

  for (const operation of request.operations) {
    const args = operation.args
    if (operation.method === 'throwOnError' || operation.method === 'select')
      continue
    if (operation.method === 'insert' || operation.method === 'update' || operation.method === 'upsert' || operation.method === 'delete') {
      if (verb !== 'select')
        fail('PGRST100', 'Only one write is supported')
      verb = operation.method
      if (operation.method !== 'delete')
        rows = writeRows(args[0])
      const options = optionsOf(args[1])
      if (typeof options.onConflict === 'string')
        onConflict = conflictColumns(columns, options.onConflict)
      ignoreDuplicates = options.ignoreDuplicates === true
      if (options.count === 'exact' || options.count === 'estimated' || options.count === 'planned')
        count = true
      if (options.head === true)
        head = true
      continue
    }
    if (operation.method === 'single') {
      cardinality = 'one'
      continue
    }
    if (operation.method === 'maybeSingle') {
      cardinality = 'maybe'
      continue
    }
    if (operation.method === 'limit') {
      if (typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0)
        fail('PGRST100', 'Invalid limit')
      limit = args[0]
      continue
    }
    if (operation.method === 'range') {
      if (typeof args[0] !== 'number' || typeof args[1] !== 'number' || !Number.isInteger(args[0]) || !Number.isInteger(args[1]) || args[0] < 0 || args[1] < args[0])
        fail('PGRST100', 'Invalid range')
      offset = args[0]
      limit = args[1] - args[0] + 1
      continue
    }
    if (operation.method === 'order') {
      if (typeof args[0] !== 'string')
        fail('PGRST100', 'Invalid order')
      const options = optionsOf(args[1])
      rejectEmbeddedModifier(options)
      orderSpecs.push({ column: args[0], options })
      continue
    }
    if (operation.method === 'or') {
      if (typeof args[0] !== 'string')
        fail('PGRST100', 'Invalid filter')
      rejectEmbeddedModifier(optionsOf(args[1]))
      filters.push(compileLogic(catalog, request.name, 't', fields, params, `or(${args[0]})`))
      continue
    }
    if (operation.method === 'match') {
      const match = optionsOf(args[0])
      for (const [column, value] of Object.entries(match))
        filters.push(predicateSql(params, resolveTarget(catalog, request.name, 't', fields, column), 'eq', value, false))
      continue
    }
    if (operation.method === 'filter' || operation.method === 'not') {
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string')
        fail('PGRST100', 'Invalid filter')
      const operator = normalizeOperator(args[1])
      const target = resolveTarget(catalog, request.name, 't', fields, args[0])
      // .in() from the builder is already an array. filter/not pass the PostgREST
      // text form, so "(5,6,7)" is a list rather than one element.
      const value = operator.operator === 'in' && typeof args[2] === 'string'
        ? parseFilterValue('in', args[2])
        : args[2]
      filters.push(predicateSql(params, target, operator.operator, value, operator.negate || operation.method === 'not'))
      continue
    }
    const operator = OPERATOR_ALIASES[operation.method]
    if (!operator || typeof args[0] !== 'string')
      fail('PGRST100', 'Unsupported filter')
    rejectEmbeddedModifier(optionsOf(args[2]))
    filters.push(predicateSql(params, resolveTarget(catalog, request.name, 't', fields, args[0]), operator, args[1], false))
  }

  if (selectText === null && verb === 'select') {
    star = true
    fields = []
  }
  const where = [...innerSql('t', fields), ...filters]
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  // Writes page from "written w". Ordering by t there is not in scope.
  const orderAlias = verb === 'select' ? 't' : 'w'
  const order = orderSpecs.length
    ? ` ORDER BY ${orderSpecs.map(item => orderSql(catalog, request.name, orderAlias, item.column, item.options)).join(', ')}`
    : ''
  const rowLimit = Math.min(limit ?? (cardinality === 'many' ? MAX_ROWS : 2), MAX_ROWS)
  const limitSql = head ? '' : ` LIMIT ${rowLimit}${offset > 0 ? ` OFFSET ${offset}` : ''}`

  if (verb === 'select') {
    const json = projectionSql(catalog, request.name, 't', star, fields, { next: 1 })
    const from = `"public".${quoteIdent(request.name)} AS t${whereSql}`
    if (head) {
      return { text: `SELECT count(*)::bigint AS total_count FROM ${from}`, values: params.values, cardinality, head, count, kind: 'table', returnsSet: false }
    }
    if (count) {
      return {
        text: `SELECT page.row, totals.total_count FROM (SELECT count(*)::bigint AS total_count FROM ${from}) totals LEFT JOIN LATERAL (SELECT ${json} AS row FROM ${from}${order}${limitSql}) page ON true`,
        values: params.values,
        cardinality,
        head,
        count,
        kind: 'table',
        returnsSet: false,
      }
    }
    return {
      text: `SELECT ${json} AS row FROM ${from}${order}${limitSql}`,
      values: params.values,
      cardinality,
      head,
      count,
      kind: 'table',
      returnsSet: false,
    }
  }

  if (!rows && verb !== 'delete')
    fail('PGRST100', 'Invalid write body')
  // RETURNING applies SELECT RLS. A write that did not ask for rows, a count,
  // or a head must not do that, or an insert allowed by INSERT policy fails
  // when the caller cannot select the new row. That is PostgREST return=minimal.
  const returnRows = selectText !== null || count || head
  const returning = returnRows ? ' RETURNING *' : ''
  let writing: string
  if (verb === 'delete') {
    writing = `DELETE FROM "public".${quoteIdent(request.name)} AS t${whereSql}${returning}`
  }
  else if (verb === 'update') {
    const assignments = Object.keys(rows![0]).map((key) => {
      if (!IDENTIFIER.test(key))
        fail('PGRST100', 'Invalid identifier')
      const column = columnByName(columns, key)
      return `${quoteIdent(key)} = ${valueSql(params, column.udt, rows![0][key])}`
    })
    writing = `UPDATE "public".${quoteIdent(request.name)} AS t SET ${assignments.join(', ')}${whereSql}${returning}`
  }
  else {
    const keys = Object.keys(rows![0])
    for (const key of keys) {
      if (!IDENTIFIER.test(key))
        fail('PGRST100', 'Invalid identifier')
      columnByName(columns, key)
    }
    const tuples = rows!.map(row => `(${keys.map(key => valueSql(params, columnByName(columns, key).udt, row[key])).join(', ')})`)
    let conflict = ''
    if (verb === 'upsert') {
      if (!onConflict)
        fail('PGRST100', 'Upsert requires onConflict')
      const updates = keys.filter(key => !onConflict!.includes(key))
      const action = ignoreDuplicates
        ? 'DO NOTHING'
        : `DO UPDATE SET ${(updates.length ? updates : onConflict).map(key => `${quoteIdent(key)} = EXCLUDED.${quoteIdent(key)}`).join(', ')}`
      conflict = ` ON CONFLICT (${onConflict.map(key => quoteIdent(key)).join(', ')}) ${action}`
    }
    writing = `INSERT INTO "public".${quoteIdent(request.name)} (${keys.map(key => quoteIdent(key)).join(', ')}) VALUES ${tuples.join(', ')}${conflict}${returning}`
  }
  if (!returnRows) {
    return {
      text: writing,
      values: params.values,
      cardinality,
      head: false,
      count: false,
      kind: 'table',
      returnsSet: false,
      minimal: true,
    }
  }
  const returned = projectionSql(catalog, request.name, 'w', selectText === null || star, selectText === null ? [] : fields, { next: 1 })
  const page = head
    ? ''
    : `SELECT ${returned} AS row FROM written w${order}${limitSql}`
  if (head) {
    return {
      text: `WITH written AS (${writing}) SELECT count(*)::bigint AS total_count FROM written`,
      values: params.values,
      cardinality,
      head,
      count: true,
      kind: 'table',
      returnsSet: false,
    }
  }
  if (count) {
    return {
      text: `WITH written AS (${writing}) SELECT page.row, totals.total_count FROM (SELECT count(*)::bigint AS total_count FROM written) totals LEFT JOIN LATERAL (${page}) page ON true`,
      values: params.values,
      cardinality,
      head,
      count,
      kind: 'table',
      returnsSet: false,
    }
  }
  return {
    text: `WITH written AS (${writing}) ${page}`,
    values: params.values,
    cardinality,
    head,
    count,
    kind: 'table',
    returnsSet: false,
  }
}

// Defaults are a suffix of the input arguments. A call matches when every
// required name is present and every provided name belongs to the function.
// Two matches is ambiguous, the same way PostgREST refuses to pick one.
function rpcMatchesCall(fn: QueryFunction, name: string, keys: string[]): boolean {
  if (fn.name !== name || fn.argNames.length !== fn.argTypes.length)
    return false
  const optionalCount = Math.min(Math.max(fn.defaultCount ?? 0, 0), fn.argNames.length)
  const requiredCount = fn.argNames.length - optionalCount
  for (let index = 0; index < requiredCount; index++) {
    if (!keys.includes(fn.argNames[index]))
      return false
  }
  return keys.every(key => fn.argNames.includes(key))
}

function pageLimit(args: unknown[]): number {
  if (typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0)
    fail('PGRST100', 'Invalid limit')
  return args[0]
}

function pageRange(args: unknown[]): { limit: number, offset: number } {
  if (typeof args[0] !== 'number' || typeof args[1] !== 'number' || !Number.isInteger(args[0]) || !Number.isInteger(args[1]) || args[0] < 0 || args[1] < args[0])
    fail('PGRST100', 'Invalid range')
  return { offset: args[0], limit: args[1] - args[0] + 1 }
}

// Limit the function output before jsonb_agg. A LIMIT on the aggregate query
// only limits the one aggregated row, which drops the page the console asked for.
function setReturningSql(call: string, composite: boolean, limit: number | null, offset: number): string {
  const aggregate = composite ? 'jsonb_agg(to_jsonb(q))' : 'jsonb_agg(to_jsonb(q.val))'
  // Same ceiling as table reads. PostgREST also stops at max-rows.
  const rowLimit = Math.min(limit ?? MAX_ROWS, MAX_ROWS)
  const page = ` LIMIT ${rowLimit}${offset > 0 ? ` OFFSET ${offset}` : ''}`
  const source = composite
    ? `SELECT * FROM ${call} AS q${page}`
    : `SELECT val FROM ${call} AS q(val)${page}`
  return `SELECT COALESCE((SELECT ${aggregate} FROM (${source}) AS q), '[]'::jsonb) AS data`
}

function compileRpc(catalog: QueryCatalog, request: ConsoleQueryRequest): CompiledConsoleQuery {
  if (!IDENTIFIER.test(request.name))
    fail('PGRST100', 'Invalid identifier')
  const params = new Params()
  let cardinality: CompiledConsoleQuery['cardinality'] = 'many'
  let limit: number | null = null
  let offset = 0
  for (const operation of request.operations) {
    if (operation.method === 'throwOnError')
      continue
    if (operation.method === 'single') {
      cardinality = 'one'
      continue
    }
    if (operation.method === 'maybeSingle') {
      cardinality = 'maybe'
      continue
    }
    if (operation.method === 'limit') {
      limit = pageLimit(operation.args)
      continue
    }
    if (operation.method === 'range') {
      const page = pageRange(operation.args)
      limit = page.limit
      offset = page.offset
      continue
    }
    fail('PGRST100', 'Unsupported RPC modifier')
  }
  const args = request.args[0] === undefined ? {} : optionsOf(request.args[0])
  const keys = Object.keys(args)
  const matches = catalog.functions.filter(fn => rpcMatchesCall(fn, request.name, keys))
  if (matches.length !== 1)
    fail('PGRST202', `Could not find the function public.${request.name}(${keys.join(', ')})`)
  const fn = matches[0]
  const callArgs: string[] = []
  for (let index = 0; index < fn.argNames.length; index++) {
    const name = fn.argNames[index]
    if (!keys.includes(name))
      continue
    callArgs.push(`${quoteIdent(name)} => ${valueSql(params, fn.argTypes[index], args[name], argumentCast(fn.argTypes[index]))}`)
  }
  const call = `public.${quoteIdent(fn.name)}(${callArgs.join(', ')})`
  if (!fn.returnsSet) {
    if (limit != null || offset > 0)
      fail('PGRST100', 'Unsupported RPC modifier')
    return { text: `SELECT to_jsonb(${call}) AS data`, values: params.values, cardinality, head: false, count: false, kind: 'rpc', returnsSet: false }
  }
  return {
    text: setReturningSql(call, fn.returnsComposite, limit, offset),
    values: params.values,
    cardinality,
    head: false,
    count: false,
    kind: 'rpc',
    returnsSet: true,
  }
}

export function compileConsoleQuery(catalog: QueryCatalog, request: ConsoleQueryRequest): CompiledConsoleQuery {
  if (request.kind === 'rpc')
    return compileRpc(catalog, request)
  if (request.kind === 'table')
    return compileTable(catalog, request)
  fail('PGRST100', 'Invalid query')
}

function normalizeJson(value: unknown): unknown {
  if (typeof value !== 'string')
    return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
    return value
  try {
    return JSON.parse(trimmed)
  }
  catch {
    return value
  }
}

function readCount(rows: Array<Record<string, unknown>>): number | null {
  if (!rows.length || !Object.prototype.hasOwnProperty.call(rows[0], 'total_count') || rows[0].total_count == null)
    return null
  const value = Number(rows[0].total_count)
  return Number.isFinite(value) ? value : null
}

function missingRow(found: number): ConsoleQueryResult {
  const noun = found === 1 ? 'row' : 'rows'
  return {
    data: null,
    error: {
      code: 'PGRST116',
      message: 'JSON object requested, multiple (or no) rows returned',
      details: `The result contains ${found} ${noun}`,
    },
    count: null,
    status: 406,
  }
}

export function shapeConsoleQueryResult(compiled: CompiledConsoleQuery, rows: Array<Record<string, unknown>>): ConsoleQueryResult {
  if (compiled.minimal)
    return { data: null, error: null, count: null, status: 200 }
  const total = compiled.count || compiled.head ? readCount(rows) : null
  if (compiled.head)
    return { data: null, error: null, count: total, status: 200 }
  if (compiled.kind === 'rpc' && !compiled.returnsSet) {
    // node-pg already decodes jsonb. Parsing a string again turns a JSON string
    // that looks like an object into an object.
    const value = rows.length ? (rows[0]?.data ?? null) : null
    if (compiled.cardinality === 'one' && value == null)
      return missingRow(0)
    if (compiled.cardinality === 'maybe' && value == null)
      return { data: null, error: null, count: total, status: 200 }
    return { data: value, error: null, count: total, status: 200 }
  }
  const rpcData = compiled.kind === 'rpc' ? normalizeJson(rows[0]?.data) : null
  const list = compiled.kind === 'rpc'
    ? (Array.isArray(rpcData) ? rpcData : [])
    : rows.map(row => normalizeJson(row.row)).filter(row => row != null)
  const found = total ?? list.length
  if (compiled.cardinality === 'one') {
    if (found !== 1)
      return missingRow(found)
    return { data: list[0] ?? null, error: null, count: total, status: 200 }
  }
  if (compiled.cardinality === 'maybe') {
    if (found > 1)
      return missingRow(found)
    return { data: list[0] ?? null, error: null, count: total, status: 200 }
  }
  return { data: list, error: null, count: total, status: 200 }
}

export function consoleQueryFailure(error: ConsoleQueryError): ConsoleQueryResult {
  return {
    data: null,
    error: { message: error.message, code: error.code, details: error.details },
    count: null,
    status: error.status,
  }
}

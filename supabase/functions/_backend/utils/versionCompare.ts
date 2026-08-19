export const VERSION_COMPARE_OPS = ['eq', 'gt', 'gte', 'lt', 'lte'] as const
export type VersionCompareOp = typeof VERSION_COMPARE_OPS[number]

export interface VersionCompareFilter {
  op: VersionCompareOp
  value: string
}

const MAX_VERSION_PARTS = 4
const VERSION_DIGIT_RE = /\d{1,9}/

function firstNumber(part: string): number | null {
  const match = part.match(VERSION_DIGIT_RE)
  if (!match)
    return null
  const parsed = Number.parseInt(match[0]!, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Split a version string on `.` and keep the first integer in each segment.
 * `14`, `14.0.1`, and `Android 14` all parse. Missing digits in a segment become 0.
 */
export function parseVersionParts(value: string | undefined): number[] | null {
  const trimmed = value?.trim()
  if (!trimmed)
    return null

  const parts = trimmed.split('.').slice(0, MAX_VERSION_PARTS).map((part) => {
    const parsed = firstNumber(part)
    return parsed === null ? 0 : parsed
  })

  if (!parts.some(part => part !== 0) && !/\d/.test(trimmed))
    return null

  return parts.length ? parts : null
}

export function parseVersionCompareFilter(
  op: VersionCompareOp | undefined,
  value: string | undefined,
): VersionCompareFilter | undefined {
  if (!op || !VERSION_COMPARE_OPS.includes(op))
    return undefined
  const parts = parseVersionParts(value)
  if (!parts)
    return undefined
  return { op, value: value!.trim() }
}

/**
 * Compare `deviceVersion` to the filter using only as many dotted parts as the
 * user typed. `gte 14` matches 14, 14.0.1, and 15. `lte 14` also matches 14.0.1.
 */
export function compareVersionPrefix(deviceVersion: string | null | undefined, filter: VersionCompareFilter): boolean {
  const filterParts = parseVersionParts(filter.value)
  if (!filterParts)
    return false
  const deviceParts = parseVersionParts(deviceVersion ?? '') ?? [0]
  const n = filterParts.length
  for (let i = 0; i < n; i++) {
    const left = deviceParts[i] ?? 0
    const right = filterParts[i]!
    if (left === right)
      continue
    if (filter.op === 'eq')
      return false
    if (filter.op === 'gt' || filter.op === 'gte')
      return left > right
    return left < right
  }
  return filter.op === 'eq' || filter.op === 'gte' || filter.op === 'lte'
}

function pgPartExpr(column: string, index: number): string {
  return `COALESCE(NULLIF(SUBSTRING(split_part(${column}, '.', ${index}) FROM '[0-9]{1,9}'), '')::bigint, 0)`
}

function cfPartExpr(column: string, index: number): string {
  return `toUInt32OrZero(splitByChar('.', ${column})[${index}])`
}

function partExpr(column: string, index: number, dialect: 'pg' | 'cf'): string {
  return dialect === 'pg' ? pgPartExpr(column, index) : cfPartExpr(column, index)
}

/**
 * SQL predicate for prefix version compare. `column` must be a trusted identifier.
 * Filter parts are integers, so they are interpolated safely.
 */
export function buildVersionCompareSql(
  column: string,
  filter: VersionCompareFilter | undefined,
  dialect: 'pg' | 'cf',
): string {
  if (!filter)
    return ''
  const parts = parseVersionParts(filter.value)
  if (!parts?.length)
    return '1 = 0'

  const lastOp = filter.op === 'gt' || filter.op === 'lt'
    ? (filter.op === 'gt' ? '>' : '<')
    : (filter.op === 'eq' ? '=' : filter.op === 'gte' ? '>=' : '<=')

  if (filter.op === 'eq') {
    return parts
      .map((part, i) => `${partExpr(column, i + 1, dialect)} = ${part}`)
      .join(' AND ')
  }

  const branches: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const equalPrefix = parts
      .slice(0, i)
      .map((part, prefixIndex) => `${partExpr(column, prefixIndex + 1, dialect)} = ${part}`)
    const isLast = i === parts.length - 1
    const cmp = isLast
      ? `${partExpr(column, i + 1, dialect)} ${lastOp} ${parts[i]}`
      : `${partExpr(column, i + 1, dialect)} ${filter.op === 'gt' || filter.op === 'gte' ? '>' : '<'} ${parts[i]}`
    const branch = [...equalPrefix, cmp].join(' AND ')
    branches.push(equalPrefix.length ? `(${branch})` : branch)
  }
  return branches.length === 1 ? branches[0]! : `(${branches.join(' OR ')})`
}

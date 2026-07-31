export interface AnalyticsEngineSqlLintIssue {
  rule: string
  message: string
}

interface AnalyticsEngineSqlLintRule {
  id: string
  test: (sql: string) => boolean
  message: string
}

export const ANALYTICS_ENGINE_SQL_LINT_RULES: AnalyticsEngineSqlLintRule[] = [
  {
    id: 'no-count-star',
    test: sql => /\bCOUNT\s*\(\s*\*\s*\)/i.test(sql),
    message: 'Analytics Engine SQL requires COUNT() or COUNT(DISTINCT column), not COUNT(*)',
  },
  {
    id: 'no-case-in-argmax',
    test: sql => /\bargMax\s*\([^)]*CASE\s+WHEN/i.test(sql),
    message: 'CASE WHEN inside argMax is unsupported by Analytics Engine SQL',
  },
  {
    id: 'no-join',
    test: sql => /\bJOIN\b/i.test(sql),
    message: 'JOIN clauses are unsupported by Analytics Engine SQL',
  },
  {
    id: 'no-multiif',
    test: sql => /\bmultiIf\b/i.test(sql),
    message: 'multiIf is unsupported by Analytics Engine SQL; use nested if() instead',
  },
  {
    id: 'no-to-string',
    test: sql => /\btoString\s*\(/i.test(sql),
    message: 'toString is unsupported by Analytics Engine SQL; use a supported formatter instead',
  },
  {
    id: 'no-concat',
    test: sql => /\bconcat\s*\(/i.test(sql),
    message: 'concat is unsupported by Analytics Engine SQL; group the dimensions instead',
  },
  {
    id: 'no-select-alias-dependency',
    test: sql => /\bif\(\s*(?:installs|failures|fails)\s*\+/i.test(sql),
    message: 'Analytics Engine SQL cannot reference SELECT aliases inside other projected expressions',
  },
  {
    id: 'no-from-table-alias',
    test: sql => /\b(?:FROM|JOIN)\s+[\w.]+\s+(?:AS\s+)?[a-z]\w*\s+(?:,|WHERE|LEFT|RIGHT|INNER|JOIN|GROUP|ORDER|LIMIT|$)/i.test(sql),
    message: 'Table aliases in FROM/JOIN are unsupported by Analytics Engine SQL',
  },
]

export function lintAnalyticsEngineSql(sql: string): AnalyticsEngineSqlLintIssue[] {
  const normalized = sql.trim()
  if (!normalized)
    return []

  return ANALYTICS_ENGINE_SQL_LINT_RULES
    .filter(rule => rule.test(normalized))
    .map(rule => ({ rule: rule.id, message: rule.message }))
}

export function assertAnalyticsEngineSqlValid(sql: string, queryName?: string): void {
  const issues = lintAnalyticsEngineSql(sql)
  if (issues.length === 0)
    return

  const prefix = queryName ? `[${queryName}] ` : ''
  const details = issues.map(issue => `${issue.rule}: ${issue.message}`).join('; ')
  throw new Error(`${prefix}Invalid Analytics Engine SQL: ${details}`)
}

const CLOUDFLARE_ANALYTICS_SQL_URL = 'https://api.cloudflare.com/client/v4/accounts'

export function prepareAnalyticsEngineSqlForLiveValidation(sql: string): string | null {
  const trimmed = sql.trim()
  if (!trimmed)
    return null

  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(trimmed))
    return null

  if (/\bLIMIT\s+\d+/i.test(trimmed))
    return trimmed

  return `${trimmed}\nLIMIT 1`
}

export interface AnalyticsEngineSqlLiveValidationResult {
  ok: true
}

export interface AnalyticsEngineSqlLiveValidationFailure {
  ok: false
  status: number
  body: string
}

export async function validateAnalyticsEngineSqlLive(
  accountId: string,
  token: string,
  sql: string,
  preparedSql?: string,
): Promise<AnalyticsEngineSqlLiveValidationResult | AnalyticsEngineSqlLiveValidationFailure> {
  const prepared = preparedSql ?? prepareAnalyticsEngineSqlForLiveValidation(sql)
  if (!prepared)
    return { ok: true }

  const response = await fetch(`${CLOUDFLARE_ANALYTICS_SQL_URL}/${accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: prepared,
    signal: AbortSignal.timeout(30000),
  })

  const body = await response.text()
  if (!response.ok)
    return { ok: false, status: response.status, body }

  return { ok: true }
}

export function hasAnalyticsEngineLiveValidationConfig(): boolean {
  return Boolean(process.env.CF_ANALYTICS_TOKEN && process.env.CF_ACCOUNT_ANALYTICS_ID)
}

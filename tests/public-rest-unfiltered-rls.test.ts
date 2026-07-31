import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_ALL, executeSQL, fetchTestRequest, getAuthHeaders, SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils.ts'

interface RestProbeRow {
  table_name: string
  probe_column: string
}

const restRelationProbeSql = `
WITH rest_relations AS (
  SELECT c.oid, c.relname AS table_name
  FROM pg_class c
  INNER JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
),
primary_key_columns AS (
  SELECT DISTINCT ON (i.indrelid) i.indrelid, a.attname
  FROM pg_index i
  INNER JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indisprimary
  ORDER BY i.indrelid, array_position(i.indkey, a.attnum)
),
first_columns AS (
  SELECT DISTINCT ON (attrelid) attrelid, attname
  FROM pg_attribute
  WHERE attnum > 0
    AND NOT attisdropped
  ORDER BY attrelid, attnum
)
SELECT rest_relations.table_name, COALESCE(primary_key_columns.attname, first_columns.attname) AS probe_column
FROM rest_relations
LEFT JOIN primary_key_columns ON primary_key_columns.indrelid = rest_relations.oid
LEFT JOIN first_columns ON first_columns.attrelid = rest_relations.oid
WHERE COALESCE(primary_key_columns.attname, first_columns.attname) IS NOT NULL
ORDER BY rest_relations.table_name
`

const coreUnfilteredRestTables = [
  'app_versions',
  'apps',
  'channels',
  'devices',
  'manifest',
  'org_users',
  'orgs',
]

const riskySelectPolicySql = `
WITH exposed_select_policies AS (
  SELECT
    c.relname AS table_name,
    p.polname AS policy_name,
    pg_get_expr(p.polqual, p.polrelid) AS using_expr,
    regexp_replace(COALESCE(pg_get_expr(p.polqual, p.polrelid), ''), '\\s+', ' ', 'g') AS normalized_expr
  FROM pg_policy p
  INNER JOIN pg_class c ON c.oid = p.polrelid
  INNER JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND p.polcmd IN ('r', '*')
    AND (
      has_table_privilege('anon', c.oid, 'SELECT')
      OR has_table_privilege('authenticated', c.oid, 'SELECT')
    )
)
SELECT table_name, policy_name, using_expr
FROM exposed_select_policies
WHERE COALESCE(using_expr, '') ~ $1
  AND NOT (
    table_name = 'app_versions'
    AND policy_name = 'Allow for auth, api keys (read+)'
    AND position('CASE WHEN' in normalized_expr) > 0
    AND position('request.method' in normalized_expr) > 0
    AND position('PATCH' in normalized_expr) > 0
    AND position('THEN' in normalized_expr) > 0
    AND position('ELSE' in normalized_expr) > position('THEN' in normalized_expr)
    AND position('rbac_check_permission_request' in normalized_expr) > position('THEN' in normalized_expr)
    AND position('rbac_check_permission_request' in normalized_expr) < position('ELSE' in normalized_expr)
    AND position('app_versions_readable_app_ids' in substring(normalized_expr from position('ELSE' in normalized_expr))) > 0
    AND position('rbac_check_permission_request' in substring(normalized_expr from position('ELSE' in normalized_expr))) = 0
  )
ORDER BY table_name, policy_name
`
const statementLevelSelectPolicySql = `
SELECT
  c.relname AS table_name,
  p.polname AS policy_name,
  pg_get_expr(p.polqual, p.polrelid) AS using_expr
FROM pg_policy p
INNER JOIN pg_class c ON c.oid = p.polrelid
INNER JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND p.polcmd IN ('r', '*')
  AND (
    has_table_privilege('anon', c.oid, 'SELECT')
    OR has_table_privilege('authenticated', c.oid, 'SELECT')
  )
ORDER BY c.relname, p.polname
`

const leadingIndexColumnSql = `
WITH index_columns AS (
  SELECT
    t.relname AS table_name,
    i.relname AS index_name,
    array_agg(a.attname ORDER BY x.ordinality) AS columns
  FROM pg_class t
  INNER JOIN pg_namespace n ON n.oid = t.relnamespace
  INNER JOIN pg_index ix ON ix.indrelid = t.oid
  INNER JOIN pg_class i ON i.oid = ix.indexrelid
  INNER JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON true
  INNER JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
  WHERE n.nspname = 'public'
    AND ix.indisvalid
    AND ix.indisready
  GROUP BY t.relname, i.relname
)
SELECT DISTINCT table_name, columns[1] AS column_name
FROM index_columns
WHERE columns[1] IS NOT NULL
`

const statementLevelHelperFilterRegex = /(?:\b([a-zA-Z_]\w*)|\(([a-zA-Z_]\w*)\)::text)\s*=\s*ANY\s*\(.*?SELECT\s+([a-zA-Z_]\w*)\(\)/g

function getAnonHeaders() {
  if (!SUPABASE_BASE_URL || !SUPABASE_ANON_KEY)
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for unfiltered REST RLS tests')

  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  }
}

function getInvalidApiKeyHeaders() {
  return {
    ...getAnonHeaders(),
    capgkey: randomUUID(),
  }
}

function getValidApiKeyHeaders() {
  return {
    ...getAnonHeaders(),
    capgkey: APIKEY_TEST_ALL,
  }
}

async function getAuthenticatedHeaders() {
  return {
    ...getAnonHeaders(),
    ...await getAuthHeaders(),
  }
}

async function getAuthenticatedWithInvalidApiKeyHeaders() {
  return {
    ...await getAuthenticatedHeaders(),
    capgkey: randomUUID(),
  }
}

type RestProbeMode = 'selected limit' | 'bare range'

function buildRestProbeRequest(probe: RestProbeRow, headers: Record<string, string>, mode: RestProbeMode) {
  if (mode === 'bare range') {
    return {
      url: `${SUPABASE_BASE_URL}/rest/v1/${encodeURIComponent(probe.table_name)}`,
      headers: {
        ...headers,
        'Range': '0-0',
        'Range-Unit': 'items',
      },
    }
  }

  const params = new URLSearchParams({
    select: probe.probe_column,
    limit: '1',
  })

  return {
    url: `${SUPABASE_BASE_URL}/rest/v1/${encodeURIComponent(probe.table_name)}?${params.toString()}`,
    headers,
  }
}

async function fetchRestProbe(probe: RestProbeRow, headers: Record<string, string>, mode: RestProbeMode) {
  const request = buildRestProbeRequest(probe, headers, mode)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetchTestRequest(
      request.url,
      { headers: request.headers, signal: controller.signal },
    )
    const body = await response.text()

    return { response, body }
  }
  finally {
    clearTimeout(timeout)
  }
}

describe('public REST unfiltered RLS regression guard', () => {
  it('does not run direct per-row identity helpers in exposed SELECT policies', async () => {
    const riskyRows = await executeSQL(riskySelectPolicySql, [
      '\\m(check_min_rights|get_identity|get_identity_org_allowed|get_identity_org_appid|get_user_main_org_id_by_app_id|is_member_of_org|is_current_user_group_member|rbac_check_permission|rbac_check_permission_request|app_versions_has_app_permission|is_user_org_admin|is_user_app_admin|user_has_role_in_app|user_has_app_update_user_roles)\\M',
    ])

    expect(riskyRows.map((row: any) => ({
      table: row.table_name,
      policy: row.policy_name,
      using: row.using_expr,
    }))).toEqual([])
  })

  it('keeps statement-level helper policy filters backed by leading indexes', async () => {
    const [policyRows, indexRows] = await Promise.all([
      executeSQL(statementLevelSelectPolicySql),
      executeSQL(leadingIndexColumnSql),
    ])
    const leadingIndexColumns = new Set(indexRows.map((row: any) => `${row.table_name}.${row.column_name}`))
    const missingIndexes: Array<{ table: string, policy: string, column: string, helper: string }> = []

    for (const row of policyRows) {
      const usingExpr = String(row.using_expr ?? '').replace(/\s+/g, ' ')
      const matches = usingExpr.matchAll(statementLevelHelperFilterRegex)

      for (const match of matches) {
        const column = match[1] ?? match[2]
        const helper = match[3]
        const indexKey = `${row.table_name}.${column}`

        if (!leadingIndexColumns.has(indexKey)) {
          missingIndexes.push({
            table: row.table_name,
            policy: row.policy_name,
            column,
            helper,
          })
        }
      }
    }

    expect(missingIndexes).toEqual([])
  })

  it.concurrent('keeps app-version helpers stable for statement-level RLS', async () => {
    const rows = await executeSQL(`
      SELECT proname, provolatile
      FROM pg_proc
      WHERE oid IN (
        'public.app_versions_readable_app_ids()'::regprocedure,
        'public.readable_app_version_ids()'::regprocedure
      )
      ORDER BY proname
    `)

    expect(rows).toEqual([
      { proname: 'app_versions_readable_app_ids', provolatile: 's' },
      { proname: 'readable_app_version_ids', provolatile: 's' },
    ])
  })

  it('does not raise or timeout on unfiltered reads for every public REST relation', async () => {
    const probes = await executeSQL(restRelationProbeSql) as RestProbeRow[]
    const probedTables = new Set(probes.map(probe => probe.table_name))
    const missingCoreTables = coreUnfilteredRestTables.filter(table => !probedTables.has(table))

    expect(missingCoreTables).toEqual([])

    const scenarios = [
      { name: 'anonymous', headers: getAnonHeaders() },
      { name: 'invalid API key', headers: getInvalidApiKeyHeaders() },
      { name: 'authenticated', headers: await getAuthenticatedHeaders() },
      { name: 'authenticated with invalid API key', headers: await getAuthenticatedWithInvalidApiKeyHeaders() },
      { name: 'valid API key', headers: getValidApiKeyHeaders() },
    ]

    const probeModes: RestProbeMode[] = ['selected limit', 'bare range']
    const failures: string[] = []

    for (let index = 0; index < probes.length; index += 4) {
      const batch = probes.slice(index, index + 4)
      const results = await Promise.all(batch.flatMap(probe => scenarios.flatMap(scenario => probeModes.map(async (mode) => {
        try {
          const { response, body } = await fetchRestProbe(probe, scenario.headers, mode)

          if (response.status >= 500)
            return `${probe.table_name} ${scenario.name} ${mode}: ${response.status} ${body}`
        }
        catch (error) {
          return `${probe.table_name} ${scenario.name} ${mode}: ${(error as Error).message}`
        }

        return null
      }))))

      failures.push(...results.filter((result): result is string => result !== null))
    }

    expect(failures).toEqual([])
  })
})

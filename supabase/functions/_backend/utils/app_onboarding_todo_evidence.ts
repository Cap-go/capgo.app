import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { getAppOnboardingStepIds, hasSupportedOtaTodoList, parseAppOnboarding } from './appOnboarding.ts'
import { escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'

const ANALYTICS_GROUP_SIZE = 5
const ANALYTICS_CONCURRENCY = 4
const SET_PAIR_LIMIT = 50
const MAX_EXACT_SET_QUERIES = 5
const MAX_ANALYTICS_QUERY_BYTES = 8 * 1024
const ANALYTICS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000
const ANALYTICS_QUERY_TIMEOUT_MS = 5_000

export interface TodoEvidenceCandidate {
  appId: string
  createdAt: string
  onboarding: unknown
  ownerOrg: string
}

export interface TodoEvidenceNeeds {
  channel: boolean
  device: boolean
  bundle: boolean
  update: boolean
}

export interface TodoEvidenceResult {
  channel: Set<string>
  device: Set<string>
  bundle: Set<string>
  update: Set<string>
  errors: Array<{ source: 'device' | 'update', appIds: string[], message: string }>
  truncated: string[]
}

type EvidenceDatabase = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>
type AnalyticsRow = Record<string, unknown>
type AnalyticsReader = (query: string, signal?: AbortSignal) => Promise<AnalyticsRow[]>

export interface TodoEvidenceOptions {
  now?: Date
  runQuery?: AnalyticsReader
}

const EMPTY_NEEDS: TodoEvidenceNeeds = { channel: false, device: false, bundle: false, update: false }

export function getTodoEvidenceNeeds(onboarding: unknown): TodoEvidenceNeeds {
  const current = parseAppOnboarding(onboarding)
  if (current.outcome === 'skipped' || current.outcome === 'completed' || ![1, 2, 3, 4].includes(current.todo_list_version))
    return { ...EMPTY_NEEDS }
  const stepIds = getAppOnboardingStepIds(current.todo_list_version, current.ota_todo_list_version)
  if (!stepIds.includes('add_channel'))
    return { ...EMPTY_NEEDS }
  const pending = (id: 'add_channel' | 'run_device' | 'upload_bundle' | 'test_update') => current.steps[id]?.status !== 'done'
  const ota = hasSupportedOtaTodoList(current)
  return {
    channel: pending('add_channel'),
    device: ota && pending('run_device'),
    bundle: ota && pending('upload_bundle'),
    update: ota && pending('test_update'),
  }
}

export async function loadTodoEvidenceCandidates(database: EvidenceDatabase, appIds: string[]): Promise<TodoEvidenceCandidate[]> {
  if (appIds.length === 0)
    return []
  const { rows } = await database.execute<{ app_id: string, created_at: Date | string | null, onboarding: unknown, owner_org: string }>(sql`
    SELECT app_id, created_at, onboarding, owner_org
    FROM public.apps
    WHERE app_id = ANY(${sql.param(appIds)}::varchar[])
    ORDER BY app_id
  `)
  return rows.map(row => ({
    appId: row.app_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ?? '',
    onboarding: row.onboarding,
    ownerOrg: row.owner_org,
  }))
}

function groupsOfFive(candidates: TodoEvidenceCandidate[]): TodoEvidenceCandidate[][] {
  const groups: TodoEvidenceCandidate[][] = []
  for (let i = 0; i < candidates.length; i += ANALYTICS_GROUP_SIZE)
    groups.push(candidates.slice(i, i + ANALYTICS_GROUP_SIZE))
  return groups
}

function sqlQuoted(value: string): string {
  return `'${escapeSqlString(value)}'`
}

function validTimestamp(value: unknown): number | null {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'string' && value.trim() ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

function lowerBound(candidates: TodoEvidenceCandidate[], floorMs: number): string {
  const oldestCreatedMs = Math.min(...candidates.map(candidate => validTimestamp(candidate.createdAt) ?? floorMs))
  return formatDateCF(new Date(Math.max(oldestCreatedMs, floorMs)))
}

export function buildTodoDeviceQuery(candidates: TodoEvidenceCandidate[], floorMs: number): string {
  const ids = candidates.map(candidate => sqlQuoted(candidate.appId)).join(', ')
  return `SELECT index1 AS app_id, max(timestamp) AS last_device_at FROM device_info
WHERE index1 IN (${ids}) AND blob1 != ''
  AND timestamp >= toDateTime('${lowerBound(candidates, floorMs)}')
GROUP BY index1 LIMIT ${ANALYTICS_GROUP_SIZE}`
}

export function buildTodoSetQuery(candidates: TodoEvidenceCandidate[], floorMs: number): string {
  const ids = candidates.map(candidate => sqlQuoted(candidate.appId)).join(', ')
  return `SELECT index1 AS app_id, blob3 AS version_name, max(timestamp) AS last_set_at
FROM app_log
WHERE index1 IN (${ids}) AND blob2 = 'set' AND blob1 != ''
  AND blob3 != '' AND blob3 NOT IN ('builtin', 'unknown')
  AND timestamp >= toDateTime('${lowerBound(candidates, floorMs)}')
GROUP BY index1, blob3
ORDER BY last_set_at DESC LIMIT ${SET_PAIR_LIMIT}`
}

function buildExactSetQuery(candidate: TodoEvidenceCandidate, names: Set<string>, floorMs: number): string {
  const versions = [...names].map(sqlQuoted).join(', ')
  return `SELECT blob3 AS version_name, max(timestamp) AS last_set_at
FROM app_log
WHERE index1 = ${sqlQuoted(candidate.appId)} AND blob2 = 'set' AND blob1 != ''
  AND blob3 != '' AND blob3 IN (${versions})
  AND timestamp >= toDateTime('${lowerBound([candidate], floorMs)}')
GROUP BY blob3 ORDER BY last_set_at DESC LIMIT 1`
}

async function runBounded(tasks: Array<() => Promise<void>>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(ANALYTICS_CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      await task()
    }
  }))
}

export async function gatherTodoEvidence(
  c: Context,
  database: EvidenceDatabase,
  candidates: TodoEvidenceCandidate[],
  options: TodoEvidenceOptions = {},
): Promise<TodoEvidenceResult> {
  const result: TodoEvidenceResult = {
    channel: new Set(),
    device: new Set(),
    bundle: new Set(),
    update: new Set(),
    errors: [],
    truncated: [],
  }
  const distinct = [...new Map(candidates.map(candidate => [candidate.appId, candidate])).values()]
  const needs = new Map(distinct.map(candidate => [candidate.appId, getTodoEvidenceNeeds(candidate.onboarding)]))
  const channelCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.channel)
  const bundleCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.bundle)
  const deviceCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.device)
  const updateCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.update)

  if (channelCandidates.length) {
    const { rows } = await database.execute<{ app_id: string }>(sql`
      SELECT DISTINCT app_id FROM public.channels
      WHERE app_id = ANY(${sql.param(channelCandidates.map(candidate => candidate.appId))}::varchar[])
    `)
    for (const row of rows)
      result.channel.add(row.app_id)
  }

  if (bundleCandidates.length) {
    const { rows } = await database.execute<{ app_id: string }>(sql`
      SELECT pending.app_id
      FROM pg_catalog.unnest(${sql.param(bundleCandidates.map(candidate => candidate.appId))}::varchar[]) AS pending(app_id)
      WHERE EXISTS (
        SELECT 1 FROM public.app_versions v
        WHERE v.app_id = pending.app_id
          AND v.deleted IS FALSE
          AND v.name NOT IN ('builtin', 'unknown')
          AND v.storage_provider <> 'revert_to_builtin'
          AND (
            v.manifest_count > 0 OR COALESCE(v.external_url, '') <> '' OR EXISTS (
              SELECT 1 FROM public.app_versions_meta vm WHERE vm.id = v.id AND vm.size > 0
            )
          )
      )
    `)
    for (const row of rows)
      result.bundle.add(row.app_id)
  }

  const now = options.now ?? new Date()
  const floorMs = now.getTime() - ANALYTICS_LOOKBACK_MS
  const runQuery: AnalyticsReader = options.runQuery ?? ((query, signal) => runQueryToCFA<AnalyticsRow>(c, query, signal))
  async function queryCloudflare(query: string): Promise<AnalyticsRow[]> {
    if (new TextEncoder().encode(query).length > MAX_ANALYTICS_QUERY_BYTES)
      throw new Error('Analytics Engine query exceeds 8 KB')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ANALYTICS_QUERY_TIMEOUT_MS)
    try {
      return await runQuery(query, controller.signal)
    }
    finally {
      clearTimeout(timeout)
    }
  }
  const tasks: Array<() => Promise<void>> = []
  const saturatedGroups: TodoEvidenceCandidate[][] = []
  const observedPairs: Array<{ app_id: string, version_name: string }> = []

  function recordError(source: 'device' | 'update', group: TodoEvidenceCandidate[], error: unknown) {
    result.errors.push({ source, appIds: group.map(candidate => candidate.appId), message: error instanceof Error ? error.message : String(error) })
  }

  for (const group of groupsOfFive(deviceCandidates)) {
    tasks.push(async () => {
      try {
        const rows = await queryCloudflare(buildTodoDeviceQuery(group, floorMs))
        const byId = new Map(group.map(candidate => [candidate.appId, candidate]))
        for (const row of rows) {
          if (typeof row.app_id !== 'string')
            continue
          const candidate = byId.get(row.app_id)
          const eventMs = validTimestamp(row.last_device_at)
          if (candidate && eventMs !== null && eventMs >= Math.max(validTimestamp(candidate.createdAt) ?? floorMs, floorMs))
            result.device.add(candidate.appId)
        }
      }
      catch (error) {
        recordError('device', group, error)
      }
    })
  }

  for (const group of groupsOfFive(updateCandidates)) {
    tasks.push(async () => {
      try {
        const rows = await queryCloudflare(buildTodoSetQuery(group, floorMs))
        const byId = new Map(group.map(candidate => [candidate.appId, candidate]))
        for (const row of rows) {
          if (typeof row.app_id !== 'string' || typeof row.version_name !== 'string' || !row.version_name)
            continue
          const candidate = byId.get(row.app_id)
          const eventMs = validTimestamp(row.last_set_at)
          if (!candidate || eventMs === null || eventMs < Math.max(validTimestamp(candidate.createdAt) ?? floorMs, floorMs))
            continue
          observedPairs.push({ app_id: candidate.appId, version_name: row.version_name })
        }
        if (rows.length >= SET_PAIR_LIMIT)
          saturatedGroups.push(group)
      }
      catch (error) {
        recordError('update', group, error)
      }
    })
  }
  await runBounded(tasks)

  // The grouped result is capped at 50 pairs per five apps. Verify only the
  // returned pairs through the existing (app_id, name) index, rather than
  // enumerating every version of every app on every cron pass.
  if (observedPairs.length) {
    const pairs = [...new Map(observedPairs.map(pair => [`${pair.app_id}\u0000${pair.version_name}`, pair])).values()]
    const { rows } = await database.execute<{ app_id: string }>(sql`
      SELECT DISTINCT observed.app_id
      FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
        AS observed(app_id varchar, version_name varchar)
      INNER JOIN public.app_versions v
        ON v.app_id = observed.app_id AND v.name = observed.version_name
      WHERE v.storage_provider <> 'revert_to_builtin'
    `)
    for (const row of rows)
      result.update.add(row.app_id)
  }

  const exactTasks: Array<() => Promise<void>> = []
  const fallbackCandidates = saturatedGroups.flat().filter(candidate => !result.update.has(candidate.appId))
  // Rotate the fixed five-query budget so a repeatedly saturated group cannot
  // starve the same apps on every ten-minute pass.
  const rotation = fallbackCandidates.length ? (Math.floor(now.getTime() / 600_000) * MAX_EXACT_SET_QUERIES) % fallbackCandidates.length : 0
  const rotatedFallback = [...fallbackCandidates.slice(rotation), ...fallbackCandidates.slice(0, rotation)]
  const selectedFallback = rotatedFallback.slice(0, MAX_EXACT_SET_QUERIES)
  result.truncated.push(...rotatedFallback.slice(MAX_EXACT_SET_QUERIES).map(candidate => candidate.appId))
  const versionNames = new Map<string, Set<string>>()
  if (selectedFallback.length) {
    const { rows } = await database.execute<{ app_id: string, version_name: string }>(sql`
      SELECT app_id, name AS version_name FROM public.app_versions
      WHERE app_id = ANY(${sql.param(selectedFallback.map(candidate => candidate.appId))}::varchar[])
        AND name <> '' AND name NOT IN ('builtin', 'unknown')
        AND storage_provider <> 'revert_to_builtin'
    `)
    for (const row of rows) {
      const names = versionNames.get(row.app_id) ?? new Set<string>()
      names.add(row.version_name)
      versionNames.set(row.app_id, names)
    }
  }
  for (const candidate of selectedFallback) {
    const names = versionNames.get(candidate.appId)
    if (!names?.size)
      continue
    const query = buildExactSetQuery(candidate, names, floorMs)
    if (new TextEncoder().encode(query).length > MAX_ANALYTICS_QUERY_BYTES) {
      result.truncated.push(candidate.appId)
      continue
    }
    exactTasks.push(async () => {
      try {
        const rows = await queryCloudflare(query)
        for (const row of rows) {
          const eventMs = validTimestamp(row.last_set_at)
          if (typeof row.version_name === 'string' && names.has(row.version_name)
            && eventMs !== null && eventMs >= Math.max(validTimestamp(candidate.createdAt) ?? floorMs, floorMs)) {
            result.update.add(candidate.appId)
          }
        }
      }
      catch (error) {
        recordError('update', [candidate], error)
      }
    })
  }
  await runBounded(exactTasks)
  return result
}

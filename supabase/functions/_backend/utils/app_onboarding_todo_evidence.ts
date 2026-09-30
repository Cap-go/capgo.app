import type { Context } from 'hono'
import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { getAppOnboardingStepIds, hasSupportedOtaTodoList, parseAppOnboarding } from './appOnboarding.ts'
import { escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'

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
}

type EvidenceDatabase = Pick<ReturnType<typeof getDrizzleClient>, 'execute'>
interface AnalyticsRow extends Record<string, unknown> {
  app_id?: unknown
  last_event_at?: unknown
}
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

function sqlQuoted(value: string): string {
  return `'${escapeSqlString(value)}'`
}

function validTimestamp(value: unknown): number | null {
  let timestamp = Number.NaN
  if (value instanceof Date)
    timestamp = value.getTime()
  else if (typeof value === 'string' && value.trim())
    timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function lowerBound(candidates: TodoEvidenceCandidate[], floorMs: number): string {
  const oldestCreatedMs = Math.min(...candidates.map(candidate => validTimestamp(candidate.createdAt) ?? floorMs))
  return formatDateCF(new Date(Math.max(oldestCreatedMs, floorMs)))
}

export function buildTodoDeviceQuery(candidates: TodoEvidenceCandidate[], floorMs: number): string {
  const ids = candidates.map(candidate => sqlQuoted(candidate.appId)).join(', ')
  return `SELECT index1 AS app_id, max(timestamp) AS last_event_at FROM device_info
WHERE index1 IN (${ids}) AND blob1 != ''
  AND timestamp >= toDateTime('${lowerBound(candidates, floorMs)}')
GROUP BY index1 LIMIT ${candidates.length}`
}

export function buildTodoSetQuery(candidates: TodoEvidenceCandidate[], floorMs: number): string {
  const ids = candidates.map(candidate => sqlQuoted(candidate.appId)).join(', ')
  return `SELECT index1 AS app_id, max(timestamp) AS last_event_at
FROM app_log
WHERE index1 IN (${ids}) AND blob2 = 'set' AND blob1 != ''
  AND blob3 != '' AND blob3 NOT IN ('builtin', 'unknown')
  AND timestamp >= toDateTime('${lowerBound(candidates, floorMs)}')
GROUP BY index1 LIMIT ${candidates.length}`
}

async function collectChannelEvidence(database: EvidenceDatabase, candidates: TodoEvidenceCandidate[], result: TodoEvidenceResult) {
  if (!candidates.length)
    return
  const { rows } = await database.execute<{ app_id: string }>(sql`
    SELECT DISTINCT app_id FROM public.channels
    WHERE app_id = ANY(${sql.param(candidates.map(candidate => candidate.appId))}::varchar[])
  `)
  for (const row of rows)
    result.channel.add(row.app_id)
}

async function collectBundleEvidence(database: EvidenceDatabase, candidates: TodoEvidenceCandidate[], result: TodoEvidenceResult) {
  if (!candidates.length)
    return
  const { rows } = await database.execute<{ app_id: string }>(sql`
    SELECT pending.app_id
    FROM pg_catalog.unnest(${sql.param(candidates.map(candidate => candidate.appId))}::varchar[]) AS pending(app_id)
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

async function queryCloudflare(runQuery: AnalyticsReader, query: string): Promise<AnalyticsRow[]> {
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

function recordCloudflareError(result: TodoEvidenceResult, source: 'device' | 'update', candidates: TodoEvidenceCandidate[], error: unknown) {
  result.errors.push({ source, appIds: candidates.map(candidate => candidate.appId), message: error instanceof Error ? error.message : String(error) })
}

async function collectAnalyticsEvidence(
  candidates: TodoEvidenceCandidate[],
  runQuery: AnalyticsReader,
  floorMs: number,
  result: TodoEvidenceResult,
  source: 'device' | 'update',
) {
  if (!candidates.length)
    return
  try {
    const query = source === 'device' ? buildTodoDeviceQuery(candidates, floorMs) : buildTodoSetQuery(candidates, floorMs)
    const rows = await queryCloudflare(runQuery, query)
    const byId = new Map(candidates.map(candidate => [candidate.appId, candidate]))
    const found = source === 'device' ? result.device : result.update
    for (const row of rows) {
      if (typeof row.app_id !== 'string')
        continue
      const candidate = byId.get(row.app_id)
      const eventMs = validTimestamp(row.last_event_at)
      if (candidate && eventMs !== null && eventMs >= Math.max(validTimestamp(candidate.createdAt) ?? floorMs, floorMs))
        found.add(candidate.appId)
    }
  }
  catch (error) {
    recordCloudflareError(result, source, candidates, error)
  }
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
  }
  const distinct = [...new Map(candidates.map(candidate => [candidate.appId, candidate])).values()]
  const needs = new Map(distinct.map(candidate => [candidate.appId, getTodoEvidenceNeeds(candidate.onboarding)]))
  const channelCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.channel)
  const bundleCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.bundle)
  const deviceCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.device)
  const updateCandidates = distinct.filter(candidate => needs.get(candidate.appId)?.update)

  await collectChannelEvidence(database, channelCandidates, result)
  await collectBundleEvidence(database, bundleCandidates, result)

  const now = options.now ?? new Date()
  const floorMs = now.getTime() - ANALYTICS_LOOKBACK_MS
  const runQuery: AnalyticsReader = options.runQuery ?? ((query, signal) => runQueryToCFA<AnalyticsRow>(c, query, signal))
  await Promise.all([
    collectAnalyticsEvidence(deviceCandidates, runQuery, floorMs, result, 'device'),
    collectAnalyticsEvidence(updateCandidates, runQuery, floorMs, result, 'update'),
  ])
  return result
}

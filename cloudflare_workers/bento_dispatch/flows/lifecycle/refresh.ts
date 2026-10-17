import type { QueryClient, ReadOnlyContext } from '../../contracts.ts'
import type { Product, VerifiedAppOutcomes } from './evidence.ts'
import { recordFlowEvent } from '../../../../supabase/functions/_backend/utils/bento_flow_audit.ts'
import { nextLifecycleEvaluation } from './cadence.ts'
import { evaluateLifecycle } from './evaluate.ts'
import { reconcileProgress } from './progress.ts'
import { loadLifecycleInput, timestamp } from './source.ts'
import { iso, ms } from './types.ts'

export interface VerifiedSnapshot extends VerifiedAppOutcomes {
  otaDeviceAt?: string | null
  otaBundleAt?: string | null
  otaUploadId?: string | null
  fundingDeniedAt?: string | null
}
interface DueJourney { org_id: string, product: Product, revision: string | number, refresh_claim_token: string }
export type AnalyticsReader = (query: string) => Promise<Array<Record<string, string>>>
const quoted = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\'\'')}'`
const cfTime = (value: string) => new Date(value).toISOString().slice(0, 19).replace('T', ' ')
function analyticsTime(value: string | undefined) {
  if (!value)
    return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  return Number.isFinite(ms(normalized)) ? iso(ms(normalized)) : null
}

export function buildLifecycleAnalyticsQuery(apps: Array<{ appId: string, createdAt: string }>, kind: 'device' | 'value', now: string) {
  if (!apps.length || apps.length > 20)
    throw new Error('Invalid lifecycle analytics batch')
  const floor = ms(now) - 90 * 24 * 60 * 60 * 1000
  const bounds = apps.map(app => `(index1 = ${quoted(app.appId)} AND timestamp >= toDateTime(${quoted(cfTime(iso(Math.max(ms(app.createdAt), floor))))}))`).join(' OR ')
  const query = kind === 'device'
    ? `SELECT index1 AS app_id, max(timestamp) AS observed_at FROM device_info WHERE (${bounds}) AND blob1 != '' GROUP BY index1 LIMIT ${apps.length}`
    : `SELECT index1 AS app_id, min(timestamp) AS observed_at, blob3 AS version FROM app_log WHERE (${bounds}) AND blob2 = 'set' AND blob1 != '' AND blob3 NOT IN ('', 'builtin', 'unknown') GROUP BY index1, blob3 ORDER BY observed_at DESC LIMIT 2001`
  if (new TextEncoder().encode(query).length > 8 * 1024)
    throw new Error('Lifecycle analytics query too large')
  return query
}

async function databaseOutcomes(read: ReadOnlyContext, app: { app_id: string, id: string, created_at: string }, product: Product, platform: string | null): Promise<VerifiedSnapshot> {
  if (product === 'ota') {
    const [bundle] = await read.query<{ id: string | number, created_at: string | Date }>(`
      SELECT v.id, v.created_at FROM public.app_versions v
      WHERE v.app_id = $1 AND v.created_at >= $2::timestamptz AND v.deleted IS FALSE
        AND v.name NOT IN ('builtin', 'unknown') AND v.storage_provider <> 'revert_to_builtin'
        AND NOT EXISTS (SELECT 1 FROM public.onboarding_demo_data demo WHERE demo.app_id = v.app_id
          AND demo.relation_name = 'app_versions' AND demo.row_key = v.id::text)
        AND (v.manifest_count > 0 OR COALESCE(v.external_url, '') <> '' OR EXISTS (
          SELECT 1 FROM public.app_versions_meta meta WHERE meta.id = v.id AND meta.size > 0))
      ORDER BY v.created_at, v.id LIMIT 1`, [app.app_id, app.created_at])
    return { otaBundleAt: timestamp(bundle?.created_at), otaUploadId: bundle ? String(bundle.id) : null }
  }
  const [outcome] = await read.query<{ id: string, completed_at: string | Date }>(`
    SELECT br.id, br.completed_at FROM public.build_requests br
    WHERE br.app_id = $1 AND br.created_at >= $2::timestamptz AND br.platform = $3
      AND br.status IN ('succeeded', 'released') AND br.completed_at >= br.created_at
      AND COALESCE(br.builder_job_id, '') NOT LIKE 'demo-job-%'
      AND br.upload_url NOT LIKE 'https://demo-builds.example.com/%'
      AND br.upload_session_key NOT LIKE 'demo-session-%'
      AND NOT EXISTS (SELECT 1 FROM public.onboarding_demo_data demo WHERE demo.app_id = br.app_id
        AND demo.relation_name = 'build_requests' AND demo.row_key = br.id::text)
    ORDER BY br.created_at, br.id LIMIT 1`, [app.app_id, app.created_at, platform])
  const [running] = await read.query<{ running: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM public.build_requests br WHERE app_id = $1 AND created_at >= $2::timestamptz
      AND COALESCE(br.builder_job_id, '') NOT LIKE 'demo-job-%' AND br.upload_session_key NOT LIKE 'demo-session-%'
      AND br.upload_url NOT LIKE 'https://demo-builds.example.com/%'
      AND NOT EXISTS (SELECT 1 FROM public.onboarding_demo_data demo WHERE demo.app_id = br.app_id
        AND demo.relation_name = 'build_requests' AND demo.row_key = br.id::text)
      AND platform = $3 AND status IN ('pending', 'queued', 'building', 'running')
      AND created_at > CURRENT_TIMESTAMP - INTERVAL '6 hours') AS running`, [app.app_id, app.created_at, platform])
  return { builderJobId: outcome?.id ?? null, builderSucceededAt: timestamp(outcome?.completed_at), demoApp: false, runningUntil: running?.running ? iso(Date.now() + 10 * 60 * 1000) : null }
}

// At most twenty org/product rows per cron, with a due-time index and leased
// SKIP LOCKED claims. Provider reads are batched; no primary plugin path writes.
export async function refreshLifecycleJourneys(db: QueryClient, runAnalytics: AnalyticsReader | null, now = () => new Date().toISOString()) {
  const deadline = Date.now() + 35_000
  const due = await db.query<DueJourney>(`WITH due AS (
    SELECT org_id, product FROM public.bento_lifecycle_journeys
    WHERE next_evaluation_at <= CURRENT_TIMESTAMP
      AND (refresh_claim_until IS NULL OR refresh_claim_until <= CURRENT_TIMESTAMP)
    ORDER BY next_evaluation_at, org_id, product LIMIT 20 FOR UPDATE SKIP LOCKED
  ) UPDATE public.bento_lifecycle_journeys j SET refresh_claim_until = CURRENT_TIMESTAMP + INTERVAL '120 seconds', refresh_claim_token = pg_catalog.gen_random_uuid()
    FROM due WHERE j.org_id = due.org_id AND j.product = due.product RETURNING j.org_id, j.product, j.revision, j.refresh_claim_token`)
  const read: ReadOnlyContext = { query: async (sql, values) => (await db.query(sql, values)).rows as never }
  const loaded = []
  for (const item of due.rows) {
    if (Date.now() >= deadline - 10_000)
      break
    loaded.push(await loadLifecycleInput(read, item.org_id, item.product))
  }
  const otaApps = loaded.flatMap(item => item?.row.app && item.input.product === 'ota'
    ? [{ appId: item.row.app.app_id, createdAt: iso(Math.max(ms(item.row.app.created_at), ms(item.capturedAt))) }]
    : [])
  let healthy = otaApps.length === 0
  let devices: Array<Record<string, string>> = []
  let values: Array<Record<string, string>> = []
  if (otaApps.length && runAnalytics) {
    const results = await Promise.allSettled([
      runAnalytics(buildLifecycleAnalyticsQuery(otaApps, 'device', now())),
      runAnalytics(buildLifecycleAnalyticsQuery(otaApps, 'value', now())),
    ])
    healthy = results.every(result => result.status === 'fulfilled')
    if (results[0].status === 'fulfilled')
      devices = results[0].value
    if (results[1].status === 'fulfilled')
      values = results[1].value
    if (values.length >= 2001)
      healthy = false
  }
  let refreshed = 0
  for (const current of loaded) {
    if (!current || Date.now() >= deadline - 10_000)
      continue
    const token = due.rows.find(item => item.org_id === current.input.orgId && item.product === current.input.product)!.refresh_claim_token
    const { input, row } = current
    const app = row.app
    if (app && row.captured_at) {
      const outcomes = await databaseOutcomes(read, app, input.product, input.evidence?.platform ?? null)
      const device = devices.find(item => item.app_id === app.app_id)
      const appValues = values.filter(item => item.app_id === app.app_id).slice(0, 2000)
      if (input.product === 'ota') {
        outcomes.otaDeviceAt = analyticsTime(device?.observed_at)
        if (appValues.length) {
          const [bundle] = await read.query<{ id: string | number, observed_at: string | Date }>(`SELECT v.id, signal.observed_at
            FROM pg_catalog.jsonb_to_recordset($2::jsonb) AS signal(version text, observed_at timestamptz)
            JOIN public.app_versions v ON v.app_id = $1 AND v.name = signal.version
            WHERE v.created_at >= $3::timestamptz AND v.created_at <= signal.observed_at AND v.deleted IS FALSE
              AND v.storage_provider <> 'revert_to_builtin'
              AND (v.manifest_count > 0 OR COALESCE(v.external_url, '') <> '' OR EXISTS (
                SELECT 1 FROM public.app_versions_meta meta WHERE meta.id = v.id AND meta.size > 0))
              AND NOT EXISTS (SELECT 1 FROM public.onboarding_demo_data demo WHERE demo.app_id = v.app_id AND demo.relation_name = 'app_versions' AND demo.row_key = v.id::text)
            ORDER BY signal.observed_at, v.id LIMIT 1`, [app.app_id, JSON.stringify(appValues.map(value => ({ version: value.version, observed_at: analyticsTime(value.observed_at) }))), app.created_at])
          if (bundle) {
            outcomes.otaAppliedAt = timestamp(bundle.observed_at)
            outcomes.otaBundleId = String(bundle.id)
            outcomes.demoApp = false
          }
        }
      }
      await db.query(`UPDATE public.bento_lifecycle_app_observations obs SET verified = obs.verified || $4::jsonb,
        verified_at = CURRENT_TIMESTAMP, healthy = $5
        WHERE obs.org_id = $1::uuid AND obs.product = $2 AND obs.app_incarnation = $3::uuid
          AND EXISTS (SELECT 1 FROM public.apps a JOIN public.bento_lifecycle_journeys j ON j.org_id = a.owner_org AND j.product = $2
            WHERE a.id = obs.app_incarnation AND a.owner_org = obs.org_id AND j.refresh_claim_token = $6::uuid)`, [input.orgId, input.product, app.id, JSON.stringify(outcomes), input.product === 'builder' || healthy, token])
    }
    const fresh = await loadLifecycleInput(read, input.orgId, input.product)
    if (!fresh || fresh.revision !== current.revision)
      continue
    const freshFacts = fresh.input.evidence?.facts.filter(fact => !fresh.seenFacts.includes(fact.id) && ms(fact.at) >= Math.max(ms(fresh.capturedAt), ms(timestamp(fresh.row.acknowledged_before)) || 0)) ?? []
    const state = reconcileProgress(fresh.input.state, fresh.input.evidence, freshFacts, fresh.input.now, fresh.input.accepted, crypto.randomUUID())
    if (!fresh.input.evidence && fresh.row.any_app)
      state.appLessSince = null
    fresh.input.state = state
    const candidate = evaluateLifecycle(fresh.input)
    // Fence changes that committed while gathering analytics. A late response
    // cannot write old-incarnation context into a replacement journey.
    await db.query('BEGIN')
    try {
      const saved = await db.query(`UPDATE public.bento_lifecycle_journeys SET state = $4::jsonb, candidate = $5::jsonb,
      next_evaluation_at = $7::timestamptz, refresh_claim_until = NULL, refresh_claim_token = NULL
      WHERE org_id = $1::uuid AND product = $2 AND revision = $3 AND refresh_claim_token = $6::uuid RETURNING org_id`, [input.orgId, input.product, fresh.revision, JSON.stringify(state), JSON.stringify(candidate), token, nextLifecycleEvaluation(fresh.input, candidate)])
      if (!saved.rowCount) {
        await db.query('ROLLBACK')
        continue
      }
      if (app) {
        await db.query(`UPDATE public.bento_lifecycle_app_observations SET seen_facts =
        ARRAY(SELECT DISTINCT fact FROM pg_catalog.unnest(seen_facts || $4::text[]) AS f(fact))
        WHERE org_id = $1::uuid AND product = $2 AND app_incarnation = $3::uuid`, [input.orgId, input.product, app.id, fresh.input.evidence?.facts.map(fact => fact.id) ?? []])
      }
      await db.query('COMMIT')
    }
    catch (error) {
      await db.query('ROLLBACK')
      throw error
    }
    if (fresh.input.creatorTreatment && fresh.input.email) {
      await recordFlowEvent(db, { flowKey: 'lifecycle:v2:org', contextKey: input.orgId, recipientKey: `org:${input.orgId}`, email: fresh.input.email, tag: 'flow:started', reason: 'original_creator_enrolled', details: { orgId: input.orgId, product: input.product } })
    }
    refreshed++
  }
  return refreshed
}

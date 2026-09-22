import type { Context } from 'hono'
import type { z } from 'zod'
import type { onboardingRefreshBody } from './app_onboarding_refresh.ts'
import type { TodoEvidenceResult } from './app_onboarding_todo_evidence.ts'
import type { AppOnboardingPatch, AppOnboardingStepHistoryChange } from './appOnboarding.ts'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { getDrizzleClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { buildAppOnboardingStepPosthogEvent } from './app_onboarding_posthog.ts'
import { gatherTodoEvidence, getTodoEvidenceNeeds, loadTodoEvidenceCandidates } from './app_onboarding_todo_evidence.ts'
import { appendAppOnboardingStepHistory, applyAppOnboardingPatch, getAppOnboardingStepHistoryChanges, parseAppOnboarding } from './appOnboarding.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { trackPosthogEventBatch } from './posthog.ts'
import { backgroundTask } from './utils.ts'

type Database = Pick<ReturnType<typeof getDrizzleClient>, 'execute' | 'transaction'>
type Body = z.infer<typeof onboardingRefreshBody>

interface LockedApp extends Record<string, unknown> {
  app_id: string
  onboarding: unknown
  owner_org: string
}

interface StepEvent {
  appId: string
  orgId: string
  onboarding: unknown
  changes: AppOnboardingStepHistoryChange[]
}

function positiveTodoPatch(row: LockedApp, evidence: TodoEvidenceResult, at: string): AppOnboardingPatch {
  const needs = getTodoEvidenceNeeds(row.onboarding)
  const patch: AppOnboardingPatch = { steps: {} }
  if (needs.channel && evidence.channel.has(row.app_id))
    patch.steps!.add_channel = { status: 'done', at }
  if (needs.device && evidence.device.has(row.app_id))
    patch.steps!.run_device = { status: 'done', at }
  if (needs.bundle && evidence.bundle.has(row.app_id))
    patch.steps!.upload_bundle = { status: 'done', at }
  if (needs.update && evidence.update.has(row.app_id))
    patch.steps!.test_update = { status: 'done', at }
  return patch
}

export async function refreshAppOnboardingTodoBatch(
  c: Context<MiddlewareKeyVariables>,
  database: Database,
  body: Body,
  options: { gatherEvidence?: typeof gatherTodoEvidence } = {},
) {
  const candidates = await loadTodoEvidenceCandidates(database, body.appIds)
  if (!candidates.length)
    return { updated: 0, steps: 0, cfErrors: 0, cfTruncated: 0 }

  // Evidence can involve network requests. Never hold app row locks while
  // waiting for Analytics Engine; recheck the row after acquiring the lock.
  const evidence = await (options.gatherEvidence ?? gatherTodoEvidence)(c, database, candidates)
  for (const error of evidence.errors) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'onboarding todo evidence query failed', source: error.source, appIds: error.appIds, error: error.message })
  }
  if (evidence.truncated.length)
    cloudlog({ requestId: c.get('requestId'), message: 'onboarding todo evidence query truncated', appIds: evidence.truncated })

  const positiveIds = [...new Set([...evidence.channel, ...evidence.device, ...evidence.bundle, ...evidence.update])].sort((a, b) => a.localeCompare(b))
  if (!positiveIds.length)
    return { updated: 0, steps: 0, cfErrors: evidence.errors.length, cfTruncated: evidence.truncated.length }

  const events = await database.transaction(async (tx) => {
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout', '8s', true),
      pg_catalog.set_config('lock_timeout', '5s', true)
    `)
    const { rows } = await tx.execute<LockedApp>(sql`
      SELECT app_id, onboarding, owner_org FROM public.apps
      WHERE app_id = ANY(${sql.param(positiveIds)}::varchar[])
      ORDER BY app_id FOR UPDATE
    `)
    const changed: StepEvent[] = []
    const updates: Array<{ app_id: string, onboarding: Record<string, unknown> }> = []
    for (const row of rows) {
      const at = new Date().toISOString()
      const patch = positiveTodoPatch(row, evidence, at)
      if (!Object.keys(patch.steps!).length)
        continue

      const merged = applyAppOnboardingPatch(row.onboarding, patch, () => at)
      const onboarding = appendAppOnboardingStepHistory(row.onboarding, merged, patch, () => at)
      const changes = getAppOnboardingStepHistoryChanges(row.onboarding, onboarding, patch)
      updates.push({ app_id: row.app_id, onboarding })
      changed.push({ appId: row.app_id, orgId: row.owner_org, onboarding, changes })
    }
    if (updates.length) {
      await tx.execute(sql`
        UPDATE public.apps AS app
        SET onboarding = updated.onboarding, updated_at = now()
        FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
          AS updated(app_id varchar, onboarding jsonb)
        WHERE app.app_id = updated.app_id
      `)
      await tx.execute(sql`
        SELECT public.try_complete_pending_onboarding_if_setup_done(changed.app_id)
        FROM pg_catalog.unnest(${sql.param(updates.map(update => update.app_id))}::varchar[]) AS changed(app_id)
      `)
    }
    return changed
  })

  const stepCount = events.reduce((sum, event) => sum + event.changes.length, 0)
  if (stepCount) {
    const payloads = events.flatMap(event => event.changes.map(change => buildAppOnboardingStepPosthogEvent({
      appId: event.appId,
      change,
      orgId: event.orgId,
      setup: parseAppOnboarding(event.onboarding),
      system: true,
    })))
    await backgroundTask(c, trackPosthogEventBatch(c, payloads))
  }
  return { updated: events.length, steps: stepCount, cfErrors: evidence.errors.length, cfTruncated: evidence.truncated.length }
}

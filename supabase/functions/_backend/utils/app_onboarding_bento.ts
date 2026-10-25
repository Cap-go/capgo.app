import type { Context } from 'hono'
import type { AppOnboardingStepHistoryChange } from './appOnboarding.ts'
import type { AppOnboardingMutationResult } from './appOnboardingMutation.ts'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { BentoTrackingPayload } from './tracking.ts'
import { sql } from 'drizzle-orm'
import { buildBuilderOnboardingBentoEvent } from './builder_onboarding_recovery.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import { sendEventToTracking } from './tracking.ts'
import { backgroundTask } from './utils.ts'

interface MilestoneInput {
  appId: string
  orgId: string
  appName: string | null
  orgName: string
}

export function buildAppUpdatedBentoEvent(input: MilestoneInput): BentoTrackingPayload {
  return {
    cron: '* * * * *',
    event: 'app:updated',
    preferenceKey: 'onboarding',
    uniqId: `app:updated:${input.appId}`,
    data: { org_id: input.orgId, org_name: input.orgName, app_name: input.appName },
  }
}

export function buildAppOnboardingMilestoneBentoEvent(input: MilestoneInput & { change: AppOnboardingStepHistoryChange }): BentoTrackingPayload | undefined {
  if (input.change.status !== 'done')
    return undefined
  if (input.change.stepId === 'test_update')
    return buildAppUpdatedBentoEvent(input)
  const platform = /^builder\.(ios|android)\.successful_cloud_build$/.exec(input.change.stepId)?.[1]
  if (!platform)
    return undefined
  return buildBuilderOnboardingBentoEvent({ ...input, appName: input.appName ?? undefined, event: 'Builder Onboarding Step', step: 'build-complete', platform })
}

type CommittedHistory = Pick<AppOnboardingMutationResult, 'appId' | 'orgId' | 'historyChanges'>

async function sendCommittedMilestones(c: Context<MiddlewareKeyVariables>, committed: CommittedHistory[]) {
  const milestones = committed.flatMap(result => result.historyChanges.flatMap((change) => {
    const bento = buildAppOnboardingMilestoneBentoEvent({ ...result, change, appName: '', orgName: '' })
    return bento ? [{ appId: result.appId, orgId: result.orgId, change }] : []
  }))
  if (!milestones.length)
    return

  const pgClient = await getPgClient(c, true)
  let names
  try {
    const { rows } = await getDrizzleClient(pgClient).execute<{
      app_id: string
      owner_org: string
      app_name: string | null
      org_name: string
    }>(sql`
      SELECT app.app_id, app.owner_org, app.name AS app_name, org.name AS org_name
      FROM public.apps AS app JOIN public.orgs AS org ON org.id = app.owner_org
      WHERE app.app_id = ANY(${sql.param([...new Set(milestones.map(event => event.appId))])}::varchar[])
    `)
    names = new Map(rows.map(row => [row.app_id, row]))
  }
  finally {
    await closeClient(c, pgClient)
  }
  await Promise.all(milestones.map(async ({ appId, orgId, change }) => {
    const row = names.get(appId)
    if (!row || row.owner_org !== orgId)
      return
    const bento = buildAppOnboardingMilestoneBentoEvent({ appId, orgId, change, appName: row.app_name, orgName: row.org_name })!
    await sendEventToTracking(c, {
      channel: 'app-onboarding',
      event: bento.event,
      groups: { organization: orgId },
      sentToBento: true,
      bento,
    }, { posthog: false, background: false })
  }))
}

// Only committed history changes may send lifecycle emails.
export async function emitCommittedAppOnboardingBento(c: Context<MiddlewareKeyVariables>, committed: CommittedHistory[]) {
  await backgroundTask(c, sendCommittedMilestones(c, committed).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'onboarding milestone Bento send failed', error: serializeError(error) })
  }))
}

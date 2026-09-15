import type { Context } from 'hono'
import type { AppOnboardingStepId } from './appOnboarding.ts'
import { inArray } from 'drizzle-orm'
import { APP_ONBOARDING_V1_STEP_IDS, parseAppOnboarding } from './appOnboarding.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'
import * as schema from './postgres_schema.ts'

export interface FrontendOnboardingCliChecklistCoverage {
  linked_apps: number
  active_apps: number
  unavailable_apps: number
  steps: Array<{
    step_id: AppOnboardingStepId
    done: number
    skipped: number
    done_percent: number
  }>
}

interface AppChecklistRow {
  appId: string
  onboarding: unknown
}

function uniqueAppIds(appIds: readonly string[]): string[] {
  return [...new Set(appIds.map(appId => appId.trim()).filter(Boolean))]
}

export function buildFrontendOnboardingCliChecklistCoverage(
  linkedAppIds: readonly string[],
  rows: readonly AppChecklistRow[],
): FrontendOnboardingCliChecklistCoverage {
  const linkedIds = new Set(uniqueAppIds(linkedAppIds))
  const currentApps = new Map(rows
    .filter(row => linkedIds.has(row.appId))
    .map(row => [row.appId, parseAppOnboarding(row.onboarding)]))
  const activeApps = new Map([...currentApps]
    .filter(([, onboarding]) => onboarding.todo_list_version === 1))
  const unavailableApps = linkedIds.size - currentApps.size

  const steps = APP_ONBOARDING_V1_STEP_IDS.map((stepId) => {
    const states = [...activeApps.values()].map(app => app.steps[stepId]?.status)
    const done = states.filter(status => status === 'done').length
    const skipped = states.filter(status => status === 'skipped').length
    return {
      step_id: stepId,
      done,
      skipped,
      done_percent: activeApps.size === 0 ? 0 : done / activeApps.size * 100,
    }
  })

  return {
    linked_apps: activeApps.size + unavailableApps,
    active_apps: activeApps.size,
    unavailable_apps: unavailableApps,
    steps,
  }
}

export async function getFrontendOnboardingCliChecklistCoverage(
  c: Context,
  linkedAppIds: readonly string[],
): Promise<FrontendOnboardingCliChecklistCoverage> {
  const appIds = uniqueAppIds(linkedAppIds)
  if (appIds.length === 0)
    return buildFrontendOnboardingCliChecklistCoverage([], [])

  const pgClient = getPgClient(c, true)
  try {
    const rows = await getDrizzleClient(pgClient)
      .select({ appId: schema.apps.app_id, onboarding: schema.apps.onboarding })
      .from(schema.apps)
      .where(inArray(schema.apps.app_id, appIds))
    return buildFrontendOnboardingCliChecklistCoverage(appIds, rows)
  }
  finally {
    await closeClient(c, pgClient)
  }
}

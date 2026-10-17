import type { Context } from 'hono'
import { isLifecycleV2Creator, validLifecycleTreatment } from './lifecycle_v2_cohort.ts'
import { cloudlog } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { existInEnv, getEnv } from './utils.ts'

export const LIFECYCLE_V2_CONTRACT = 'new-emails-v2-2026-10-17'

const REQUIRED_SETTINGS = {
  BENTO_EVENT_DISPATCH_ENABLED: 'true',
  BENTO_LIFECYCLE_V2_SENDER_CONTRACT: LIFECYCLE_V2_CONTRACT,
  BENTO_LIFECYCLE_V2_LEGACY_HANDOFF: LIFECYCLE_V2_CONTRACT,
} as const

const LEGACY_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'org:created',
  'app:created',
  'app:updated',
  'app:onboarding_ready',
  'app:ai_instructions_copied',
  'user:need_onboarding',
  'builder_onboarding_started',
  'builder_onboarding_completed',
])

export function isLegacyLifecycleEvent(eventName: string): boolean {
  return LEGACY_LIFECYCLE_EVENTS.has(eventName)
}

export const isLifecycleV2Treatment = validLifecycleTreatment

/**
 * Read-only handoff for internal email producers, never plugin request paths.
 * The immutable creator and journey lookups are bounded by their org/user keys.
 * Missing provenance, deleted creators, unknown readiness and database errors
 * retain legacy delivery; this helper never creates an experiment assignment.
 */
export async function shouldUseLifecycleV2(c: Context, orgId: string): Promise<boolean> {
  if (!orgId)
    return false

  const settings: Record<string, string> = {}
  const missing: string[] = []
  for (const [key, expected] of Object.entries(REQUIRED_SETTINGS)) {
    if (!existInEnv(c, key)) {
      missing.push(key)
      continue
    }
    settings[key] = getEnv(c, key).trim()
    if (settings[key] !== expected)
      return false
  }

  let pg: Awaited<ReturnType<typeof getPgClient>> | undefined
  try {
    pg = await getPgClient(c)
    if (missing.length) {
      const result = await pg.query<{ name: string, decrypted_secret: string }>(
        'SELECT name, decrypted_secret FROM vault.decrypted_secrets WHERE name = ANY($1::text[])',
        [missing],
      )
      for (const row of result.rows)
        settings[row.name] = row.decrypted_secret?.trim()
    }
    if (Object.entries(REQUIRED_SETTINGS).some(([key, expected]) => settings[key] !== expected))
      return false

    const result = await pg.query<{ onboarding: unknown, created_at: string | Date, created_via_invite: boolean | null }>(
      `SELECT users.onboarding, users.created_at, users.created_via_invite
       FROM public.org_lifecycle_creators AS creators
       JOIN public.users AS users ON users.id = creators.original_creator_id
       WHERE creators.org_id = $1::uuid
         AND EXISTS (
           SELECT 1 FROM public.bento_lifecycle_journeys AS journeys
           WHERE journeys.org_id = creators.org_id AND journeys.support_hold IS FALSE
         )
       LIMIT 1`,
      [orgId],
    )
    const row = result.rows[0]
    return !!row && isLifecycleV2Creator(row.onboarding, row.created_at, row.created_via_invite)
  }
  catch {
    cloudlog({ requestId: c.get('requestId'), message: 'Lifecycle v2 handoff unavailable; retaining legacy delivery' })
    return false
  }
  finally {
    if (pg)
      await closeClient(c, pg)
  }
}

function isLegacyTrialTag(tag: string): boolean {
  return ['trial', 'trial7', 'trial1', 'trial0'].includes(tag) || tag.startsWith('trial-plan:')
}

/**
 * Bento tags are person-scoped, so do not delete a tag that another org still
 * needs. The explicit handoff setting attests that existing legacy sessions
 * are excluded separately, including recipients belonging to control orgs.
 */
export function withoutLegacyTrialTriggers<T extends { segments: string[], deleteSegments: string[] }>(tags: T): T {
  return {
    ...tags,
    segments: tags.segments.filter(tag => !isLegacyTrialTag(tag)),
    deleteSegments: tags.deleteSegments.filter(tag => !isLegacyTrialTag(tag)),
  }
}

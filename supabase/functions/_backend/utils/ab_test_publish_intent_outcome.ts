import type { Context } from 'hono'
import { AB_TESTS_CONFIG } from './ab_tests.ts'
import { closeClient, getPgClient } from './pg.ts'

export const ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES = [
  'selected_publish',
  'selected_another_intent',
  'no_selection_yet',
] as const

export type AdminABTestPublishIntentOutcomeName = typeof ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES[number]

export interface AdminABTestPublishIntentOutcomeRow {
  inferred_people?: number | string
  outcome: string | null
  people: number | string
}

export interface AdminABTestPublishIntentOutcomeCount {
  count: number
  outcome: AdminABTestPublishIntentOutcomeName
}

export interface AdminABTestPublishIntentOutcome {
  inferred_from_organization: number
  outcomes: AdminABTestPublishIntentOutcomeCount[]
  total: number
}

const OTHER_ONBOARDING_INTENTS = ['ota', 'builder', 'both', 'exploring'] as const
const ONBOARDING_INTENTS = ['publish', ...OTHER_ONBOARDING_INTENTS] as const
const PUBLISH_INTENT_TEST = 'webnativeapp_publish_intent'
const DEVELOPMENT_ENVIRONMENT_TEST = 'webnativeapp_development_environment'

function isOutcome(value: string | null): value is AdminABTestPublishIntentOutcomeName {
  return value !== null && (ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES as readonly string[]).includes(value)
}

function readCount(value: number | string): number | null {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function treatmentAssignment(testName: string): string {
  const test = AB_TESTS_CONFIG[testName]
  if (!test)
    throw new Error(`Missing A/B test configuration for ${testName}`)

  return JSON.stringify({
    [testName]: { branch: test.treatment_branch },
  })
}

export function buildAdminABTestPublishIntentOutcome(
  rows: AdminABTestPublishIntentOutcomeRow[],
): AdminABTestPublishIntentOutcome {
  const counts = new Map<AdminABTestPublishIntentOutcomeName, number>()
  let inferredFromOrganization = 0

  for (const row of rows) {
    const count = readCount(row.people)
    const inferredCount = readCount(row.inferred_people ?? 0)
    if (!isOutcome(row.outcome) || count === null || inferredCount === null || inferredCount > count)
      continue
    counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + count)
    inferredFromOrganization += inferredCount
  }

  const outcomes = ADMIN_AB_TEST_PUBLISH_INTENT_OUTCOMES.map(outcome => ({
    outcome,
    count: counts.get(outcome) ?? 0,
  }))

  return {
    inferred_from_organization: inferredFromOrganization,
    outcomes,
    total: outcomes.reduce((sum, outcome) => sum + outcome.count, 0),
  }
}

export async function getAdminABTestPublishIntentOutcome(c: Context): Promise<AdminABTestPublishIntentOutcome> {
  const pgClient = getPgClient(c, true)
  try {
    const result = await pgClient.query<AdminABTestPublishIntentOutcomeRow>(
      `WITH exposed_users AS (
         SELECT
           user_account.id,
           user_account.onboarding ->> 'intent' AS user_intent
         FROM public.users AS user_account
         WHERE (user_account.onboarding -> 'abtests') @> $1::jsonb
            OR (user_account.onboarding -> 'abtests') @> $2::jsonb
       ), resolved_users AS (
         SELECT
           COALESCE(exposed_user.user_intent, inferred_organization.intent) AS intent,
           exposed_user.user_intent IS NULL
             AND inferred_organization.intent IS NOT NULL AS inferred_from_organization
         FROM exposed_users AS exposed_user
         LEFT JOIN LATERAL (
           SELECT min(organization.onboarding ->> 'intent') AS intent
           FROM public.orgs AS organization
           WHERE exposed_user.user_intent IS NULL
             AND organization.created_by = exposed_user.id
             AND organization.onboarding ->> 'intent' = ANY($3::text[])
           HAVING count(DISTINCT organization.onboarding ->> 'intent') = 1
         ) AS inferred_organization ON exposed_user.user_intent IS NULL
       )
       SELECT
         CASE
           WHEN resolved_user.intent = 'publish'
             THEN 'selected_publish'
           WHEN resolved_user.intent = ANY($4::text[])
             THEN 'selected_another_intent'
           ELSE 'no_selection_yet'
         END AS outcome,
         count(*)::bigint AS people,
         count(*) FILTER (WHERE resolved_user.inferred_from_organization)::bigint AS inferred_people
       FROM resolved_users AS resolved_user
       GROUP BY 1`,
      [
        treatmentAssignment(PUBLISH_INTENT_TEST),
        treatmentAssignment(DEVELOPMENT_ENVIRONMENT_TEST),
        ONBOARDING_INTENTS,
        OTHER_ONBOARDING_INTENTS,
      ],
    )

    return buildAdminABTestPublishIntentOutcome(result.rows)
  }
  finally {
    await closeClient(c, pgClient)
  }
}

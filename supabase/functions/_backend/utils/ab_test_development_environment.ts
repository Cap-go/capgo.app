import type { Context } from 'hono'
import { AB_TESTS_CONFIG } from './ab_tests.ts'
import { closeClient, getPgClient } from './pg.ts'

export const ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES = [
  'ai_assistant',
  'hosted_builder',
  'other',
  'hand_coded',
  'no_selection_yet',
] as const

export type AdminABTestDevelopmentEnvironmentOutcomeName = typeof ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES[number]

const DEVELOPMENT_ENVIRONMENT_INTENTS = ['publish', 'builder', 'ota', 'both', 'exploring', 'no_selection_yet'] as const

interface AdminABTestDevelopmentEnvironmentIntent {
  outcomes: { outcome: typeof DEVELOPMENT_ENVIRONMENT_INTENTS[number], count: number }[]
  total: number
}

export interface AdminABTestDevelopmentEnvironmentRow {
  outcome: string | null
  intent?: string | null
  people: number | string
}

export interface AdminABTestDevelopmentEnvironment {
  outcomes: { outcome: AdminABTestDevelopmentEnvironmentOutcomeName, count: number }[]
  total: number
}

const DEVELOPMENT_ENVIRONMENT_TEST = 'webnativeapp_development_environment'
const DEVELOPMENT_ENVIRONMENTS = ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES.filter(outcome => outcome !== 'no_selection_yet')

function readCount(value: number | string): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^\d+$/.test(value))) {
    throw new Error('Invalid development environment count')
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Invalid development environment count')
  return count
}

export function buildAdminABTestDevelopmentEnvironment(rows: AdminABTestDevelopmentEnvironmentRow[]): AdminABTestDevelopmentEnvironment {
  const counts = new Map<AdminABTestDevelopmentEnvironmentOutcomeName, number>()
  let total = 0
  for (const row of rows) {
    if (!(ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES as readonly unknown[]).includes(row.outcome))
      throw new Error('Invalid development environment outcome')
    const outcome = row.outcome as AdminABTestDevelopmentEnvironmentOutcomeName
    const count = readCount(row.people)
    total += count
    if (!Number.isSafeInteger(total))
      throw new Error('Development environment total exceeds safe integer range')
    counts.set(outcome, (counts.get(outcome) ?? 0) + count)
  }
  return {
    total,
    outcomes: ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES.map(outcome => ({
      outcome,
      count: counts.get(outcome) ?? 0,
    })),
  }
}

function buildEnvironmentIntents(rows: AdminABTestDevelopmentEnvironmentRow[], environment: AdminABTestDevelopmentEnvironmentOutcomeName): AdminABTestDevelopmentEnvironmentIntent {
  const counts = new Map<typeof DEVELOPMENT_ENVIRONMENT_INTENTS[number], number>()
  let total = 0
  for (const row of rows) {
    if (row.outcome !== environment)
      continue
    if (!(DEVELOPMENT_ENVIRONMENT_INTENTS as readonly unknown[]).includes(row.intent))
      throw new Error('Invalid development environment intent')
    const intent = row.intent as typeof DEVELOPMENT_ENVIRONMENT_INTENTS[number]
    const count = readCount(row.people)
    total += count
    if (!Number.isSafeInteger(total))
      throw new Error('Development environment intent total exceeds safe integer range')
    counts.set(intent, (counts.get(intent) ?? 0) + count)
  }
  return {
    total,
    outcomes: DEVELOPMENT_ENVIRONMENT_INTENTS.map(outcome => ({ outcome, count: counts.get(outcome) ?? 0 })),
  }
}

export async function getAdminABTestDevelopmentEnvironment(c: Context): Promise<AdminABTestDevelopmentEnvironment & {
  hosted_builder_intents: AdminABTestDevelopmentEnvironmentIntent
  development_environment_intents: Record<AdminABTestDevelopmentEnvironmentOutcomeName, AdminABTestDevelopmentEnvironmentIntent>
}> {
  const pgClient = await getPgClient(c, true)
  try {
    const test = AB_TESTS_CONFIG[DEVELOPMENT_ENVIRONMENT_TEST]
    if (!test)
      throw new Error(`Missing A/B test configuration for ${DEVELOPMENT_ENVIRONMENT_TEST}`)

    // Assignment cohort, not question exposure: later onboarding versions retain C.
    // One indexed replica scan serves both charts, with at most 5 x 6 grouped rows.
    // Each user contributes once; switching groups needs no additional database query.
    const result = await pgClient.query<AdminABTestDevelopmentEnvironmentRow>(
      `SELECT
         CASE
           WHEN user_account.onboarding ->> 'development_environment' = ANY($2::text[])
             THEN user_account.onboarding ->> 'development_environment'
           ELSE 'no_selection_yet'
         END AS outcome,
         CASE
           WHEN user_account.onboarding ->> 'intent' = ANY($3::text[])
             THEN user_account.onboarding ->> 'intent'
           ELSE 'no_selection_yet'
         END AS intent,
         count(*)::bigint AS people
       FROM public.users AS user_account
       WHERE (user_account.onboarding -> 'abtests') @> $1::jsonb
       GROUP BY 1, 2`,
      [
        JSON.stringify({ [DEVELOPMENT_ENVIRONMENT_TEST]: { branch: test.treatment_branch } }),
        DEVELOPMENT_ENVIRONMENTS,
        DEVELOPMENT_ENVIRONMENT_INTENTS.filter(intent => intent !== 'no_selection_yet'),
      ],
    )
    const intents = Object.fromEntries(ADMIN_AB_TEST_DEVELOPMENT_ENVIRONMENT_OUTCOMES.map(environment => [environment, buildEnvironmentIntents(result.rows, environment)])) as Record<AdminABTestDevelopmentEnvironmentOutcomeName, AdminABTestDevelopmentEnvironmentIntent>
    return {
      ...buildAdminABTestDevelopmentEnvironment(result.rows),
      hosted_builder_intents: intents.hosted_builder,
      development_environment_intents: intents,
    }
  }
  finally {
    await closeClient(c, pgClient)
  }
}

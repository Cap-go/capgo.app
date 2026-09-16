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

export interface AdminABTestDevelopmentEnvironmentRow {
  outcome: string | null
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

export async function getAdminABTestDevelopmentEnvironment(c: Context): Promise<AdminABTestDevelopmentEnvironment> {
  const pgClient = getPgClient(c, true)
  try {
    const test = AB_TESTS_CONFIG[DEVELOPMENT_ENVIRONMENT_TEST]
    if (!test)
      throw new Error(`Missing A/B test configuration for ${DEVELOPMENT_ENVIRONMENT_TEST}`)

    // Assignment cohort, not question exposure: later onboarding versions retain C.
    // The indexed JSON containment predicate keeps one record per user; no org inference.
    const result = await pgClient.query<AdminABTestDevelopmentEnvironmentRow>(
      `SELECT
         CASE
           WHEN user_account.onboarding ->> 'development_environment' = ANY($2::text[])
             THEN user_account.onboarding ->> 'development_environment'
           ELSE 'no_selection_yet'
         END AS outcome,
         count(*)::bigint AS people
       FROM public.users AS user_account
       WHERE (user_account.onboarding -> 'abtests') @> $1::jsonb
       GROUP BY 1`,
      [
        JSON.stringify({ [DEVELOPMENT_ENVIRONMENT_TEST]: { branch: test.treatment_branch } }),
        DEVELOPMENT_ENVIRONMENTS,
      ],
    )
    return buildAdminABTestDevelopmentEnvironment(result.rows)
  }
  finally {
    await closeClient(c, pgClient)
  }
}

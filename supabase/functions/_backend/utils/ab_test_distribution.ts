import type { Context } from 'hono'
import type { ABTestConfig } from './ab_tests.ts'
import { AB_TESTS_CONFIG } from './ab_tests.ts'
import { closeClient, getPgClient } from './pg.ts'

export interface AdminABTestDistributionRow {
  assignments: number | string
  branch: string | null
  test_name: string
}

export interface AdminABTestDistributionBranch {
  branch: string
  count: number
  label: string
  percentage: number
}

export interface AdminABTestDistribution {
  branches: AdminABTestDistributionBranch[]
  label: string
  test_name: string
  total: number
}

function readCount(value: number | string): number | null {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function percentage(count: number, total: number): number {
  if (total === 0)
    return 0
  return Math.round((count / total) * 1_000) / 10
}

export function buildAdminABTestDistribution(
  rows: AdminABTestDistributionRow[],
  config: Record<string, ABTestConfig> = AB_TESTS_CONFIG,
): AdminABTestDistribution[] {
  const counts = new Map<string, number>()

  for (const row of rows) {
    const test = config[row.test_name]
    const count = readCount(row.assignments)
    if (!test || !row.branch || !test.branches[row.branch] || count === null)
      continue
    counts.set(`${row.test_name}:${row.branch}`, count)
  }

  return Object.entries(config).map(([testName, test]) => {
    const branchNames = [test.treatment_branch, test.control_branch]
    const branchCounts = branchNames.map(branch => counts.get(`${testName}:${branch}`) ?? 0)
    const total = branchCounts.reduce((sum, count) => sum + count, 0)

    return {
      test_name: testName,
      label: test.label,
      total,
      branches: branchNames.map((branch, index) => ({
        branch,
        label: test.branches[branch].label,
        count: branchCounts[index],
        percentage: percentage(branchCounts[index], total),
      })),
    }
  })
}

export async function getAdminABTestDistribution(c: Context): Promise<AdminABTestDistribution[]> {
  const testNames = Object.keys(AB_TESTS_CONFIG)
  if (testNames.length === 0)
    return []

  const pgClient = getPgClient(c, true)
  try {
    const result = await pgClient.query<AdminABTestDistributionRow>(
      `SELECT
         assignment.test_name,
         assignment.value ->> 'branch' AS branch,
         count(*)::bigint AS assignments
       FROM public.users AS user_account
       CROSS JOIN LATERAL jsonb_each(
         CASE
           WHEN jsonb_typeof(user_account.onboarding -> 'abtests') = 'object'
             THEN user_account.onboarding -> 'abtests'
           ELSE '{}'::jsonb
         END
       ) AS assignment(test_name, value)
       WHERE assignment.test_name = ANY($1::text[])
         AND jsonb_typeof(assignment.value) = 'object'
       GROUP BY assignment.test_name, assignment.value ->> 'branch'`,
      [testNames],
    )

    return buildAdminABTestDistribution(result.rows)
  }
  finally {
    await closeClient(c, pgClient)
  }
}

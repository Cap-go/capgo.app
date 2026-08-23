import type { Database } from './supabase.types.ts'
import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import rawABTestsConfig from './ab_tests.json' with { type: 'json' }
import { syncBentoSubscriberTags } from './bento.ts'
import { quickError } from './hono.ts'
import { closeClient, getPgClient } from './pg.ts'

export type ABTestAudience = 'all' | 'self_signup'
export type ABTestBranch = 'A' | 'B'

export interface ABTestConfig {
  audience: ABTestAudience
  branch_a_percentage: number
  branches: Record<ABTestBranch, { bento_tag: string }>
}

export interface ABTestAssignment {
  assigned_at: string
  branch: ABTestBranch
}

type ABTestsConfig = Record<string, ABTestConfig>
type AssignmentUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite'>
type SyncUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite' | 'id'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidConfig(testName?: string): never {
  throw new Error(`Invalid A/B test configuration${testName ? ` for ${testName}` : ''}`)
}

export function validateABTestsConfig(value: unknown): ABTestsConfig {
  if (!isRecord(value))
    invalidConfig()

  const config: ABTestsConfig = {}
  const branchATags = new Set<string>()
  const branchBTags = new Set<string>()
  for (const [testName, entry] of Object.entries(value)) {
    if (!testName.trim() || !isRecord(entry))
      invalidConfig(testName)

    const audience = entry.audience
    const percentage = entry.branch_a_percentage
    const branches = entry.branches
    if ((audience !== 'all' && audience !== 'self_signup')
      || typeof percentage !== 'number'
      || !Number.isInteger(percentage)
      || percentage < 0
      || percentage > 100
      || !isRecord(branches)
      || !isRecord(branches.A)
      || !isRecord(branches.B)) {
      invalidConfig(testName)
    }

    const branchATag = branches.A.bento_tag
    const branchBTag = branches.B.bento_tag
    if (typeof branchATag !== 'string'
      || typeof branchBTag !== 'string'
      || !branchATag.trim()
      || !branchBTag.trim()
      || branchATag === branchBTag
      || branchBTags.has(branchATag)
      || branchATags.has(branchBTag)) {
      invalidConfig(testName)
    }
    branchATags.add(branchATag)
    branchBTags.add(branchBTag)

    config[testName] = {
      audience,
      branch_a_percentage: percentage,
      branches: {
        A: { bento_tag: branchATag },
        B: { bento_tag: branchBTag },
      },
    }
  }

  return config
}

export const AB_TESTS_CONFIG = validateABTestsConfig(rawABTestsConfig)

export function createABTestAssignments(
  user: AssignmentUser,
  config = AB_TESTS_CONFIG,
  random = Math.random,
  now = () => new Date(),
): Record<string, ABTestAssignment> {
  const assignments: Record<string, ABTestAssignment> = {}
  let assignedAt: string | undefined

  for (const [testName, test] of Object.entries(config)) {
    if (test.audience === 'self_signup' && user.created_via_invite)
      continue

    assignedAt ??= now().toISOString()
    assignments[testName] = {
      assigned_at: assignedAt,
      branch: random() * 100 < test.branch_a_percentage ? 'A' : 'B',
    }
  }

  return assignments
}

function readPersistedAssignments(value: unknown, testNames: string[]) {
  if (!isRecord(value))
    quickError(500, 'ab_test_assignment_failed', 'A/B test assignment failed')

  const assignments: Record<string, ABTestAssignment> = {}
  for (const testName of testNames) {
    const assignment = value[testName]
    if (!isRecord(assignment)
      || typeof assignment.assigned_at !== 'string'
      || (assignment.branch !== 'A' && assignment.branch !== 'B')) {
      quickError(500, 'ab_test_assignment_failed', 'A/B test assignment failed', { testName })
    }
    assignments[testName] = {
      assigned_at: assignment.assigned_at,
      branch: assignment.branch,
    }
  }
  return assignments
}

async function persistABTestAssignments(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
  candidates: Record<string, ABTestAssignment>,
) {
  const pgPool = getPgClient(c)
  let persisted: unknown
  try {
    const pgClient = await pgPool.connect()
    try {
      const result = await pgClient.query<{ abtests: unknown }>(
        `UPDATE public.users
         SET onboarding = COALESCE(onboarding, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
             'abtests',
             $2::jsonb || CASE
               WHEN pg_catalog.jsonb_typeof(onboarding->'abtests') = 'object'
                 THEN onboarding->'abtests'
               ELSE '{}'::jsonb
             END
           )
         WHERE id = $1::uuid
         RETURNING onboarding->'abtests' AS abtests`,
        [userId, JSON.stringify(candidates)],
      )
      persisted = result.rows[0]?.abtests
    }
    finally {
      pgClient.release(true)
    }
  }
  finally {
    await closeClient(c, pgPool)
  }

  return readPersistedAssignments(persisted, Object.keys(candidates))
}

export async function syncNewUserABTests(
  c: Context<MiddlewareKeyVariables>,
  email: string,
  user: SyncUser,
) {
  const candidates = createABTestAssignments(user)
  const testNames = Object.keys(candidates)
  if (testNames.length === 0)
    return

  const assignments = await persistABTestAssignments(c, user.id, candidates)
  const segments: string[] = []
  const deleteSegments: string[] = []
  for (const testName of testNames) {
    const branch = assignments[testName].branch
    const oppositeBranch: ABTestBranch = branch === 'A' ? 'B' : 'A'
    segments.push(AB_TESTS_CONFIG[testName].branches[branch].bento_tag)
    deleteSegments.push(AB_TESTS_CONFIG[testName].branches[oppositeBranch].bento_tag)
  }

  const result = await syncBentoSubscriberTags(c, { email, segments, deleteSegments })
  if (result === false)
    quickError(500, 'bento_ab_test_delivery_failed', 'Bento A/B test delivery failed')
}

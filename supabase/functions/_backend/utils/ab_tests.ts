import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import rawABTestsConfig from './ab_tests.json' with { type: 'json' }
import { syncBentoSubscriberTags } from './bento.ts'
import { quickError } from './hono.ts'
import { closeClient, getPgClient } from './pg.ts'

export type ABTestAudience = 'all' | 'self_signup'
export type ABTestBranch = 'A' | 'B' | 'C' | 'D'

export interface ABTestConfig {
  audience: ABTestAudience
  branches: Record<string, { bento_tag: string }>
  control_branch: ABTestBranch
  treatment_branch: ABTestBranch
  treatment_percentage: number
}

export interface ABTestAssignment {
  assigned_at: string
  branch: ABTestBranch
}

type ABTestsConfig = Record<string, ABTestConfig>
type AssignmentUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite'>
type SyncUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite' | 'id'>
const AB_TEST_BRANCHES = ['A', 'B', 'C', 'D'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidConfig(testName?: string): never {
  throw new Error(`Invalid A/B test configuration${testName ? ` for ${testName}` : ''}`)
}

function isABTestBranch(value: unknown): value is ABTestBranch {
  return typeof value === 'string' && (AB_TEST_BRANCHES as readonly string[]).includes(value)
}

export function validateABTestsConfig(value: unknown): ABTestsConfig {
  if (!isRecord(value))
    invalidConfig()

  const config: ABTestsConfig = {}
  const bentoTags = new Set<string>()
  for (const [testName, entry] of Object.entries(value)) {
    if (!testName.trim() || !isRecord(entry))
      invalidConfig(testName)

    const audience = entry.audience
    const percentage = entry.treatment_percentage
    const treatmentBranch = entry.treatment_branch
    const controlBranch = entry.control_branch
    const branches = entry.branches
    if ((audience !== 'all' && audience !== 'self_signup')
      || typeof percentage !== 'number'
      || !Number.isInteger(percentage)
      || percentage < 0
      || percentage > 100
      || !isRecord(branches)
      || !isABTestBranch(treatmentBranch)
      || !isABTestBranch(controlBranch)
      || treatmentBranch === controlBranch
      || Object.keys(branches).length !== 2
      || !isRecord(branches[treatmentBranch])
      || !isRecord(branches[controlBranch])) {
      invalidConfig(testName)
    }

    const treatmentTag = branches[treatmentBranch].bento_tag
    const controlTag = branches[controlBranch].bento_tag
    if (typeof treatmentTag !== 'string'
      || typeof controlTag !== 'string'
      || !treatmentTag.trim()
      || !controlTag.trim()
      || treatmentTag === controlTag
      || bentoTags.has(treatmentTag)
      || bentoTags.has(controlTag)) {
      invalidConfig(testName)
    }
    bentoTags.add(treatmentTag)
    bentoTags.add(controlTag)

    config[testName] = {
      audience,
      control_branch: controlBranch,
      treatment_branch: treatmentBranch,
      treatment_percentage: percentage,
      branches: {
        [treatmentBranch]: { bento_tag: treatmentTag },
        [controlBranch]: { bento_tag: controlTag },
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
      branch: random() * 100 < test.treatment_percentage ? test.treatment_branch : test.control_branch,
    }
  }

  return assignments
}

function readPersistedAssignments(value: unknown, testNames: string[]) {
  if (!isRecord(value))
    quickError(500, 'ab_test_assignment_failed', 'A/B test assignment failed')

  const assignments: Record<string, ABTestAssignment> = {}
  for (const testName of testNames) {
    const test = AB_TESTS_CONFIG[testName]
    const assignment = value[testName]
    const branch = isRecord(assignment) ? assignment.branch : undefined
    if (!test
      || !isRecord(assignment)
      || typeof assignment.assigned_at !== 'string'
      || !isABTestBranch(branch)
      || (branch !== test.treatment_branch && branch !== test.control_branch)) {
      quickError(500, 'ab_test_assignment_failed', 'A/B test assignment failed', { testName })
    }
    assignments[testName] = {
      assigned_at: assignment.assigned_at,
      branch,
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

export async function getOrCreateUserABTests(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
) {
  const pgPool = getPgClient(c)
  let user: AssignmentUser | undefined
  try {
    const pgClient = await pgPool.connect()
    try {
      const result = await pgClient.query<AssignmentUser>(
        `SELECT created_via_invite
         FROM public.users
         WHERE id = $1::uuid
         LIMIT 1`,
        [userId],
      )
      user = result.rows[0]
    }
    finally {
      pgClient.release(true)
    }
  }
  finally {
    await closeClient(c, pgPool)
  }

  if (!user)
    quickError(404, 'user_not_found', 'User not found')

  const candidates = createABTestAssignments(user)
  if (Object.keys(candidates).length === 0)
    return {}

  return await persistABTestAssignments(c, userId, candidates)
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
    const test = AB_TESTS_CONFIG[testName]
    const branch = assignments[testName].branch
    const oppositeBranch = branch === test.treatment_branch ? test.control_branch : test.treatment_branch
    segments.push(test.branches[branch].bento_tag)
    deleteSegments.push(test.branches[oppositeBranch].bento_tag)
  }

  const result = await syncBentoSubscriberTags(c, { email, segments, deleteSegments })
  if (result === false)
    quickError(500, 'bento_ab_test_delivery_failed', 'Bento A/B test delivery failed')
}

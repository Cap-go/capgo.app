import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { sql } from 'drizzle-orm'
import rawABTestsConfig from './ab_tests.json' with { type: 'json' }
import { syncBentoSubscriberTags } from './bento.ts'
import { quickError } from './hono.ts'
import { cloudlogErr } from './logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from './pg.ts'

export type ABTestAudience = 'all' | 'self_signup'
export type ABTestBranch = 'A' | 'B' | 'C' | 'D'
export const AB_TEST_INTENTS = ['ota', 'builder', 'both', 'exploring', 'publish'] as const
export type ABTestIntent = typeof AB_TEST_INTENTS[number]

export interface ABTestConfig {
  audience: ABTestAudience
  intents?: ABTestIntent[]
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
type AssignmentAudienceUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite'> & { intent?: unknown }
type AssignmentUser = AssignmentAudienceUser & Record<string, unknown> & { abtests: unknown }
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

function isABTestIntent(value: unknown): value is ABTestIntent {
  return typeof value === 'string' && (AB_TEST_INTENTS as readonly string[]).includes(value)
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
    const intents = entry.intents
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
    if (intents !== undefined
      && (!Array.isArray(intents)
        || intents.length === 0
        || !intents.every(isABTestIntent)
        || new Set(intents).size !== intents.length)) {
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
      ...(intents === undefined ? {} : { intents: [...intents] }),
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

function isEligibleForTest(user: AssignmentAudienceUser, test: ABTestConfig) {
  if (test.audience === 'self_signup' && user.created_via_invite)
    return false
  return test.intents === undefined
    || (isABTestIntent(user.intent) && test.intents.includes(user.intent))
}

export function createABTestAssignments(
  user: AssignmentAudienceUser,
  config = AB_TESTS_CONFIG,
  random = Math.random,
  now = () => new Date(),
): Record<string, ABTestAssignment> {
  const assignments: Record<string, ABTestAssignment> = {}
  let assignedAt: string | undefined

  for (const [testName, test] of Object.entries(config)) {
    if (!isEligibleForTest(user, test))
      continue

    assignedAt ??= now().toISOString()
    assignments[testName] = {
      assigned_at: assignedAt,
      branch: random() * 100 < test.treatment_percentage ? test.treatment_branch : test.control_branch,
    }
  }

  return assignments
}

function readExistingAssignments(value: unknown, testNames: string[]) {
  const storedAssignments = isRecord(value) ? value : {}
  const assignments: Record<string, ABTestAssignment> = {}
  const missing: string[] = []
  for (const testName of testNames) {
    const test = AB_TESTS_CONFIG[testName]
    const assignment = storedAssignments[testName]
    if (assignment === undefined) {
      missing.push(testName)
      continue
    }
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
  return { assignments, missing }
}

function readPersistedAssignments(value: unknown, testNames: string[]) {
  const existing = readExistingAssignments(value, testNames)
  if (existing.missing.length > 0)
    quickError(500, 'ab_test_assignment_failed', 'A/B test assignment failed', { testNames: existing.missing })
  return existing.assignments
}

function eligibleTestNames(user: AssignmentAudienceUser) {
  return Object.entries(AB_TESTS_CONFIG)
    .filter(([, test]) => isEligibleForTest(user, test))
    .map(([testName]) => testName)
}

function ineligibleAssignedTestNames(value: unknown, user: AssignmentAudienceUser) {
  const storedAssignments = isRecord(value) ? value : {}
  return Object.entries(AB_TESTS_CONFIG)
    .filter(([testName, test]) => test.intents !== undefined
      && storedAssignments[testName] !== undefined
      && !isEligibleForTest(user, test))
    .map(([testName]) => testName)
}

function configForTests(testNames: string[]): ABTestsConfig {
  return Object.fromEntries(testNames.map(testName => [testName, AB_TESTS_CONFIG[testName]]))
}

async function readAssignmentUser(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
): Promise<AssignmentUser | undefined> {
  const pgPool = getPgClient(c, true)
  try {
    const pgClient = await pgPool.connect()
    try {
      const result = await pgClient.query<AssignmentUser>(
        `SELECT created_via_invite,
                onboarding->>'intent' AS intent,
                onboarding->'abtests' AS abtests
         FROM public.users
         WHERE id = $1::uuid
         LIMIT 1`,
        [userId],
      )
      return result.rows[0]
    }
    finally {
      pgClient.release(true)
    }
  }
  finally {
    await closeClient(c, pgPool)
  }
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

async function syncCreatedABTestTags(
  c: Context<MiddlewareKeyVariables>,
  email: unknown,
  created: Record<string, ABTestAssignment>,
) {
  if (typeof email !== 'string' || !email.trim() || Object.keys(created).length === 0)
    return

  const segments: string[] = []
  const deleteSegments: string[] = []
  for (const [testName, assignment] of Object.entries(created)) {
    const test = AB_TESTS_CONFIG[testName]
    const oppositeBranch = assignment.branch === test.treatment_branch ? test.control_branch : test.treatment_branch
    segments.push(test.branches[assignment.branch].bento_tag)
    deleteSegments.push(test.branches[oppositeBranch].bento_tag)
  }

  const result = await syncBentoSubscriberTags(c, {
    deleteSegments,
    email: email.trim().toLowerCase(),
    segments,
  })
  if (result === false) {
    cloudlogErr({
      message: 'on-demand A/B Bento sync failed',
      requestId: c.get('requestId'),
    })
  }
}

export async function getOrCreateUserABTests(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
) {
  let replicaUser: AssignmentUser | undefined
  try {
    replicaUser = await readAssignmentUser(c, userId)
  }
  catch {
    replicaUser = undefined
  }
  if (replicaUser) {
    const testNames = eligibleTestNames(replicaUser)
    const existing = readExistingAssignments(replicaUser.abtests, testNames)
    const revoked = ineligibleAssignedTestNames(replicaUser.abtests, replicaUser)
    if (existing.missing.length === 0 && revoked.length === 0)
      return existing.assignments
  }

  const pgPool = getPgClient(c, false)
  let result: {
    assignments: Record<string, ABTestAssignment>
    created: Record<string, ABTestAssignment>
    email?: string | null
    revoked: string[]
  }
  try {
    const drizzle = getDrizzleClient(pgPool)
    result = await drizzle.transaction(async (tx) => {
      const lockedUserResult = await tx.execute<AssignmentUser & { email?: string | null }>(sql`
        SELECT created_via_invite,
               email,
               onboarding->>'intent' AS intent,
               onboarding->'abtests' AS abtests
        FROM public.users
        WHERE id = ${userId}::uuid
        FOR UPDATE
      `)
      const user = lockedUserResult.rows[0]
      if (!user)
        quickError(404, 'user_not_found', 'User not found')

      const testNames = eligibleTestNames(user)
      const existing = readExistingAssignments(user.abtests, testNames)
      const revoked = ineligibleAssignedTestNames(user.abtests, user)
      if (existing.missing.length === 0 && revoked.length === 0) {
        return {
          assignments: existing.assignments,
          created: {} as Record<string, ABTestAssignment>,
          email: user.email,
          revoked,
        }
      }

      const candidates = createABTestAssignments(user, configForTests(existing.missing))
      const retainedAssignments = isRecord(user.abtests) ? { ...user.abtests } : {}
      for (const testName of revoked)
        delete retainedAssignments[testName]
      const nextAssignments = { ...retainedAssignments, ...candidates }
      const updateResult = await tx.execute<{ abtests?: unknown }>(sql`
        UPDATE public.users
        SET onboarding = COALESCE(onboarding, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'abtests',
            ${JSON.stringify(nextAssignments)}::jsonb
          )
        WHERE id = ${userId}::uuid
        RETURNING onboarding->'abtests' AS abtests
      `)
      const updated = updateResult.rows[0]
      return {
        assignments: readPersistedAssignments(updated?.abtests, testNames),
        created: candidates,
        email: user.email,
        revoked,
      }
    })
  }
  finally {
    await closeClient(c, pgPool)
  }
  await syncCreatedABTestTags(c, result.email, result.created)
  return result.assignments
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

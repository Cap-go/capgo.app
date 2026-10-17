import type { Context } from 'hono'
import type { ABTestAssignment, AssignmentAudienceUser } from './ab_test_allocation.ts'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { sql } from 'drizzle-orm'
import { createABTestAssignments as allocateABTests, isABTestBranch, isProspectiveUser, isRecord, resolveABTestAssignments, validateABTestsConfig } from './ab_test_allocation.ts'
import rawABTestsConfig from './ab_tests.json' with { type: 'json' }
import { syncBentoSubscriberTags } from './bento.ts'
import { quickError } from './hono.ts'
import { cloudlogErr } from './logging.ts'
import { checkoutPgClient, closeClient, getDrizzleClient, getPgClient, releasePgClient } from './pg.ts'
import { backgroundTask } from './utils.ts'

export { AB_TEST_INTENTS, validateABTestsConfig } from './ab_test_allocation.ts'
export type { ABTestAssignment, ABTestAudience, ABTestBranch, ABTestConfig, ABTestIntent } from './ab_test_allocation.ts'

interface ABTestBentoSyncState {
  cleanup_emails: string[]
  email?: string
  pending: boolean
}

type AssignmentUser = AssignmentAudienceUser & Record<string, unknown> & { abtests: unknown }
type SyncUser = Pick<Database['public']['Tables']['users']['Row'], 'created_via_invite' | 'id'>
const BENTO_AB_TEST_SYNC_MAX_ATTEMPTS = 3
const BENTO_AB_TEST_SYNC_TIMEOUT_MS = 5_000

function normalizeEmail(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined
}

function readBentoSyncState(value: unknown): ABTestBentoSyncState {
  const record = isRecord(value) ? value : {}
  const cleanupEmails = Array.isArray(record.cleanup_emails)
    ? record.cleanup_emails.map(normalizeEmail).filter((email): email is string => email !== undefined)
    : []
  const email = normalizeEmail(record.email)
  return {
    cleanup_emails: [...new Set(cleanupEmails)],
    ...(email ? { email } : {}),
    pending: record.pending === true || cleanupEmails.length > 0,
  }
}

function needsBentoSync(user: AssignmentUser, state: ABTestBentoSyncState) {
  const email = normalizeEmail(user.email)
  return state.pending || (state.email !== undefined && state.email !== email)
}

export const AB_TESTS_CONFIG = validateABTestsConfig(rawABTestsConfig)

export function createABTestAssignments(user: AssignmentAudienceUser, config = AB_TESTS_CONFIG, random = Math.random, now = () => new Date()) {
  return allocateABTests(user, config, random, now)
}

function hasIntentGatedTests() {
  return Object.values(AB_TESTS_CONFIG).some(test => test.intents !== undefined
    || test.treatment_percentage_by_intent !== undefined || test.required_assignments_by_intent !== undefined
    || test.required_assignments !== undefined || test.enroll_new_users_after !== undefined)
}

function enrollmentsForSignup(user: AssignmentUser) {
  const enrolled = Array.isArray(user.abtests_enrolled) ? user.abtests_enrolled.filter((name): name is string => typeof name === 'string') : []
  for (const [name, test] of Object.entries(AB_TESTS_CONFIG)) {
    if (test.enroll_new_users_after !== undefined && isProspectiveUser(user.created_at, test.enroll_new_users_after)
      && (test.audience === 'all' || !user.created_via_invite) && !enrolled.includes(name)) {
      enrolled.push(name)
    }
  }
  return enrolled
}

async function readAssignmentUser(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
): Promise<AssignmentUser | undefined> {
  const pgPool = await getPgClient(c, true)
  try {
    const pgClient = await checkoutPgClient(pgPool)
    try {
      const result = await pgClient.query<AssignmentUser>(
        `SELECT id, created_at, created_via_invite,
                email,
                onboarding->'abtests_bento_sync' AS abtests_bento_sync,
                onboarding->'abtests_enrolled' AS abtests_enrolled,
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
      releasePgClient(pgPool, pgClient, true)
    }
  }
  finally {
    await closeClient(c, pgPool)
  }
}

function buildBentoTagUpdate(user: AssignmentUser) {
  const email = normalizeEmail(user.email)
  if (!email)
    return undefined

  const storedAssignments = isRecord(user.abtests) ? user.abtests : {}
  const segments: string[] = []
  const deleteSegments: string[] = []

  const eligibleAssignments = resolveABTestAssignments(user, user.abtests, AB_TESTS_CONFIG, undefined, undefined, false).assignments
  for (const [testName, test] of Object.entries(AB_TESTS_CONFIG)) {
    const storedAssignment = storedAssignments[testName]
    const branch = isRecord(storedAssignment) ? storedAssignment.branch : undefined
    const isCurrentBranch = isABTestBranch(branch)
      && (branch === test.treatment_branch || branch === test.control_branch)
    if (test.treatment_percentage === 0 && !Object.values(test.treatment_percentage_by_intent ?? {}).some(value => value > 0) && !isCurrentBranch)
      continue
    if (!isCurrentBranch || eligibleAssignments[testName] === undefined) {
      deleteSegments.push(
        test.branches[test.treatment_branch].bento_tag,
        test.branches[test.control_branch].bento_tag,
      )
      continue
    }

    const oppositeBranch = branch === test.treatment_branch ? test.control_branch : test.treatment_branch
    segments.push(test.branches[branch].bento_tag)
    deleteSegments.push(test.branches[oppositeBranch].bento_tag)
  }

  return {
    deleteSegments,
    email,
    segments,
  }
}

function sameBentoTagUpdate(
  left: ReturnType<typeof buildBentoTagUpdate>,
  right: ReturnType<typeof buildBentoTagUpdate>,
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameBentoSyncState(left: ABTestBentoSyncState, right: ABTestBentoSyncState) {
  const normalize = (state: ABTestBentoSyncState) => ({
    cleanup_emails: [...state.cleanup_emails].sort((left, right) => left.localeCompare(right)),
    email: state.email,
    pending: state.pending,
  })
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function buildBentoTagCleanup(email: string) {
  return {
    deleteSegments: Object.values(AB_TESTS_CONFIG).flatMap(test => [
      test.branches[test.treatment_branch].bento_tag,
      test.branches[test.control_branch].bento_tag,
    ]),
    email,
    segments: [],
  }
}

async function reconcileBentoSyncState(
  drizzle: ReturnType<typeof getDrizzleClient>,
  userId: string,
  previousState: ABTestBentoSyncState,
  cleanedEmails: Set<string>,
  expectedTagUpdate?: ReturnType<typeof buildBentoTagUpdate>,
) {
  return await drizzle.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
    const currentUserResult = await tx.execute<AssignmentUser & { email?: string | null }>(sql`
      SELECT id, created_at, created_via_invite,
             onboarding->'abtests_bento_sync' AS abtests_bento_sync,
                onboarding->'abtests_enrolled' AS abtests_enrolled,
             email,
             onboarding->>'intent' AS intent,
             onboarding->'abtests' AS abtests
      FROM public.users
      WHERE id = ${userId}::uuid
      FOR UPDATE
    `)
    const user = currentUserResult.rows[0]
    if (!user)
      return undefined

    const storedState = isRecord(user.abtests_bento_sync)
      ? readBentoSyncState(user.abtests_bento_sync)
      : previousState
    const email = normalizeEmail(user.email)
    const cleanupEmails = new Set(storedState.cleanup_emails.filter(item => !cleanedEmails.has(item)))
    if (storedState.email && storedState.email !== email && !cleanedEmails.has(storedState.email))
      cleanupEmails.add(storedState.email)

    const currentTagUpdate = buildBentoTagUpdate(user)
    const complete = cleanupEmails.size === 0
      && (currentTagUpdate === undefined
        || (expectedTagUpdate !== undefined && sameBentoTagUpdate(expectedTagUpdate, currentTagUpdate)))
    const state: ABTestBentoSyncState = {
      cleanup_emails: [...cleanupEmails],
      ...(email ? { email } : {}),
      pending: !complete,
    }
    if (!sameBentoSyncState(state, storedState)) {
      await tx.execute(sql`
        UPDATE public.users
        SET onboarding = COALESCE(onboarding, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'abtests_bento_sync',
            ${JSON.stringify(state)}::jsonb
          )
        WHERE id = ${userId}::uuid
      `)
    }
    return { complete, state, user }
  })
}

type BentoSyncSnapshot = NonNullable<Awaited<ReturnType<typeof reconcileBentoSyncState>>>

interface BentoTagSyncContext {
  c: Context<MiddlewareKeyVariables>
  drizzle: ReturnType<typeof getDrizzleClient>
  userId: string
  cleanedEmails: Set<string>
  signal: AbortSignal
  strict: boolean
}

async function deliverBentoTagUpdate(
  context: BentoTagSyncContext,
  update: NonNullable<ReturnType<typeof buildBentoTagUpdate>>,
  failureMessage: string,
) {
  const result = await syncBentoSubscriberTags(context.c, update, context.signal)
  if (result === true)
    return true
  if (context.strict && result === false)
    throw new Error('Bento A/B test delivery failed')
  cloudlogErr({ message: failureMessage, requestId: context.c.get('requestId') })
  return false
}

async function advanceBentoTagSync(context: BentoTagSyncContext, snapshot: BentoSyncSnapshot) {
  const { drizzle, userId, cleanedEmails } = context
  const cleanupEmail = snapshot.state.cleanup_emails.find(email => !cleanedEmails.has(email))
  if (cleanupEmail) {
    const accepted = await deliverBentoTagUpdate(context, buildBentoTagCleanup(cleanupEmail), 'on-demand A/B Bento email cleanup failed')
    if (!accepted)
      return undefined
    cleanedEmails.add(cleanupEmail)
    // Persist accepted cleanup before spending more of the bounded budget.
    return reconcileBentoSyncState(drizzle, userId, snapshot.state, cleanedEmails)
  }

  const tagUpdate = buildBentoTagUpdate(snapshot.user)
  if (!tagUpdate) {
    await reconcileBentoSyncState(drizzle, userId, snapshot.state, cleanedEmails)
    return undefined
  }
  const accepted = await deliverBentoTagUpdate(context, tagUpdate, 'on-demand A/B Bento sync failed')
  if (!accepted)
    return undefined
  return reconcileBentoSyncState(drizzle, userId, snapshot.state, cleanedEmails, tagUpdate)
}

async function syncCurrentUserABTestTags(
  c: Context<MiddlewareKeyVariables>,
  drizzle: ReturnType<typeof getDrizzleClient>,
  userId: string,
  initialState: ABTestBentoSyncState,
  strict = false,
) {
  try {
    const context: BentoTagSyncContext = {
      c,
      drizzle,
      userId,
      strict,
      signal: AbortSignal.timeout(BENTO_AB_TEST_SYNC_TIMEOUT_MS),
      cleanedEmails: new Set<string>(),
    }
    let snapshot = await reconcileBentoSyncState(drizzle, userId, initialState, context.cleanedEmails)
    for (let attempt = 0; snapshot && attempt < BENTO_AB_TEST_SYNC_MAX_ATTEMPTS; attempt++) {
      if (snapshot.complete)
        return
      snapshot = await advanceBentoTagSync(context, snapshot)
    }
    if (strict && snapshot && !snapshot.complete)
      throw new Error('Bento A/B test delivery failed')
  }
  catch (error) {
    if (strict)
      throw error
    cloudlogErr({
      error,
      message: 'on-demand A/B Bento reconciliation failed',
      requestId: c.get('requestId'),
    })
  }
}

async function reconcileUserABTests(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
  signup = false,
) {
  let replicaUser: AssignmentUser | undefined
  if (!signup && !hasIntentGatedTests()) {
    try {
      replicaUser = await readAssignmentUser(c, userId)
    }
    catch {
      replicaUser = undefined
    }
  }
  if (replicaUser) {
    const existing = resolveABTestAssignments({ ...replicaUser, id: userId }, replicaUser.abtests, AB_TESTS_CONFIG)
    const bentoSyncState = readBentoSyncState(replicaUser.abtests_bento_sync)
    if (!existing.changed && !needsBentoSync(replicaUser, bentoSyncState))
      return existing.assignments
  }

  const pgPool = await getPgClient(c, false)
  let closeInFinally = true
  let result: {
    assignments: Record<string, ABTestAssignment>
    bentoSyncState: ABTestBentoSyncState
    needsBentoSync: boolean
  }
  try {
    const drizzle = getDrizzleClient(pgPool)
    result = await drizzle.transaction(async (tx) => {
      const lockedUserResult = await tx.execute<AssignmentUser & { email?: string | null }>(sql`
        SELECT id, created_at, created_via_invite,
               onboarding->'abtests_bento_sync' AS abtests_bento_sync,
                onboarding->'abtests_enrolled' AS abtests_enrolled,
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

      const enrolled = signup ? enrollmentsForSignup(user) : user.abtests_enrolled
      const existing = resolveABTestAssignments({ ...user, id: userId, abtests_enrolled: enrolled }, user.abtests, AB_TESTS_CONFIG)
      // Reconcile even when the assignment is unchanged: an app can predate
      // intent selection or treatment assignment. SQL rechecks all safeguards.
      const reconcileDoubleIntentApps = async (assignments: Record<string, ABTestAssignment>) => {
        if (user.created_via_invite === false && (user.intent === 'both' || user.intent === 'exploring')
          && assignments.todo_list_v4_double_intent?.branch === 'A') {
          await tx.execute(sql`SELECT public.reconcile_double_intent_app_onboarding(${userId}::uuid)`)
        }
      }
      const enrollmentChanged = signup && JSON.stringify(enrolled) !== JSON.stringify(user.abtests_enrolled ?? [])
      const bentoSyncState = readBentoSyncState(user.abtests_bento_sync)
      if (!existing.changed && !enrollmentChanged) {
        await reconcileDoubleIntentApps(existing.assignments)
        return {
          assignments: existing.assignments,
          bentoSyncState,
          needsBentoSync: needsBentoSync(user, bentoSyncState),
        }
      }

      const nextAssignments = existing.nextAssignments
      const email = normalizeEmail(user.email)
      const cleanupEmails = new Set(bentoSyncState.cleanup_emails)
      if (bentoSyncState.email && bentoSyncState.email !== email)
        cleanupEmails.add(bentoSyncState.email)
      const nextBentoSyncState: ABTestBentoSyncState = {
        cleanup_emails: [...cleanupEmails],
        ...(email ? { email } : {}),
        pending: existing.changed || needsBentoSync(user, bentoSyncState),
      }
      const updateResult = await tx.execute<{ abtests?: unknown }>(sql`
        UPDATE public.users
        SET onboarding = COALESCE(onboarding, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'abtests',
            ${JSON.stringify(nextAssignments)}::jsonb,
            'abtests_enrolled',
            ${JSON.stringify(enrolled ?? [])}::jsonb,
            'abtests_bento_sync',
            ${JSON.stringify(nextBentoSyncState)}::jsonb
          )
        WHERE id = ${userId}::uuid
        RETURNING onboarding->'abtests' AS abtests
      `)
      const updated = updateResult.rows[0]
      const assignments = updated?.abtests === undefined
        ? quickError(500, 'ab_test_assignment_failed', 'A/B test assignment failed')
        : resolveABTestAssignments({ ...user, id: userId, abtests_enrolled: enrolled }, updated.abtests, AB_TESTS_CONFIG, undefined, undefined, false).assignments
      await reconcileDoubleIntentApps(assignments)
      return {
        assignments,
        bentoSyncState: nextBentoSyncState,
        needsBentoSync: nextBentoSyncState.pending,
      }
    })
    if (result.needsBentoSync) {
      closeInFinally = false
      const task = (async () => {
        try {
          await syncCurrentUserABTestTags(c, drizzle, userId, result.bentoSyncState, signup)
        }
        finally {
          await closeClient(c, pgPool)
        }
      })()
      if (signup)
        await task
      else
        await backgroundTask(c, task)
      return result.assignments
    }
  }
  finally {
    if (closeInFinally)
      await closeClient(c, pgPool)
  }
  return result.assignments
}

export async function getOrCreateUserABTests(c: Context<MiddlewareKeyVariables>, userId: string) {
  return reconcileUserABTests(c, userId)
}

export async function syncNewUserABTests(
  c: Context<MiddlewareKeyVariables>,
  _email: string,
  user: SyncUser,
) {
  await reconcileUserABTests(c, user.id, true)
}

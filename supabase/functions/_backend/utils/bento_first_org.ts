import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { syncBentoSubscriberTags, trackBentoEvent, unsubscribeBento } from './bento.ts'
import { quickError } from './hono.ts'
import { closeClient, getPgClient } from './pg.ts'

export const BENTO_AWAITING_FIRST_ORG_TAG = 'onboarding:awaiting_first_org'
// Permanent safety opt-out: never remove this tag. The Bento recovery workflow
// must require it to be absent immediately before sending a recovery email.
export const BENTO_FIRST_ORG_RECOVERY_SUPPRESSED_TAG = 'onboarding:first_org_recovery_suppressed'
export const BENTO_REGISTERED_WITHOUT_ORG_EVENT = 'user:registered_without_org'
export const BENTO_JOINED_ORG_EVENT = 'user:joined_org'

const BENTO_DELETED_USER_OPERATION_TIMEOUT_MS = 2_000
const BENTO_DELETED_USER_OPERATION_TIMED_OUT = Symbol('bento-deleted-user-operation-timed-out')

interface CurrentRoleBinding {
  email: string | null
  granted_at: Date
  id: string
  is_active: boolean
  is_direct: boolean
  org_id: string | null
  principal_id: string
  principal_type: string
  scope_type: string
}

export interface FirstOrgRegistrationState {
  has_active_direct_org_access: boolean
  user_is_recovery_eligible: boolean
}

export function normalizeBentoEmail(email: string) {
  return email.trim().toLowerCase()
}

function ensureBentoDelivery(result: boolean | undefined, operation: string) {
  if (result === false)
    quickError(500, 'bento_lifecycle_delivery_failed', 'Bento lifecycle delivery failed', { operation })
}

async function runDeletedUserBentoOperation<T>(operation: string, promise: Promise<T>) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      promise,
      new Promise<typeof BENTO_DELETED_USER_OPERATION_TIMED_OUT>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(BENTO_DELETED_USER_OPERATION_TIMED_OUT),
          BENTO_DELETED_USER_OPERATION_TIMEOUT_MS,
        )
      }),
    ])
    if (result === BENTO_DELETED_USER_OPERATION_TIMED_OUT)
      throw new Error(`${operation} timed out`)
    return result
  }
  finally {
    if (timeoutId !== undefined)
      clearTimeout(timeoutId)
  }
}

async function setAwaitingFirstOrgTag(c: Context, email: string, awaiting: boolean) {
  const result = await syncBentoSubscriberTags(c, {
    email,
    segments: awaiting ? [BENTO_AWAITING_FIRST_ORG_TAG] : [],
    deleteSegments: awaiting ? [] : [BENTO_AWAITING_FIRST_ORG_TAG],
  })
  ensureBentoDelivery(result, awaiting ? 'add_awaiting_first_org_tag' : 'remove_awaiting_first_org_tag')
}

export async function syncBentoFirstOrgOnEmailChange(c: Context, oldEmail: string, newEmail: string) {
  const aliases = [...new Set([oldEmail, newEmail].map(normalizeBentoEmail).filter(Boolean))]
  return await syncBentoSubscriberTags(c, aliases.map(email => ({
    email,
    segments: [BENTO_FIRST_ORG_RECOVERY_SUPPRESSED_TAG],
    deleteSegments: [BENTO_AWAITING_FIRST_ORG_TAG],
  })))
}

export async function suppressAndUnsubscribeDeletedUserRecovery(c: Context, email: string) {
  let suppressionResult: boolean | undefined
  let suppressionError: unknown
  let suppressionThrew = false
  try {
    suppressionResult = await runDeletedUserBentoOperation(
      'suppress deleted user recovery',
      syncBentoFirstOrgOnEmailChange(c, email, email),
    )
  }
  catch (error) {
    suppressionError = error
    suppressionThrew = true
  }

  // Submit unsubscribe after suppression for an identity that is already
  // scheduled for deletion, even if suppression delivery throws.
  let unsubscribeResult: boolean | undefined
  let unsubscribeError: unknown
  let unsubscribeThrew = false
  try {
    unsubscribeResult = await runDeletedUserBentoOperation(
      'unsubscribe deleted user recovery',
      unsubscribeBento(c, email),
    )
  }
  catch (error) {
    unsubscribeError = error
    unsubscribeThrew = true
  }

  if (suppressionThrew)
    throw suppressionError
  if (unsubscribeThrew)
    throw unsubscribeError
  ensureBentoDelivery(suppressionResult, 'suppress_deleted_user_recovery')
  ensureBentoDelivery(unsubscribeResult, 'unsubscribe_deleted_user_recovery')
}

async function reconcileFirstOrgStateAfterBentoMutation(
  c: Context,
  pgPool: ReturnType<typeof getPgClient>,
  userId: string,
  email: string,
) {
  const state = await getFirstOrgDatabaseState(pgPool, userId)
  if (!state.user_is_recovery_eligible)
    await suppressAndUnsubscribeDeletedUserRecovery(c, email)
  return state
}

async function runBentoMutationWithFirstOrgReconciliation(
  c: Context,
  pgPool: ReturnType<typeof getPgClient>,
  userId: string,
  email: string,
  mutate: () => Promise<void>,
) {
  let mutationSucceeded = false
  let mutationError: unknown
  try {
    await mutate()
    mutationSucceeded = true
  }
  catch (error) {
    mutationError = error
  }

  // Reconcile even after an ambiguous provider failure: Bento may have
  // accepted the mutation before Capgo lost the response.
  const state = await reconcileFirstOrgStateAfterBentoMutation(c, pgPool, userId, email)
  if (!mutationSucceeded)
    throw mutationError
  return state
}

async function getFirstOrgDatabaseState(pgPool: ReturnType<typeof getPgClient>, userId: string) {
  const pgClient = await pgPool.connect()
  try {
    const result = await pgClient.query<FirstOrgRegistrationState>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM public.users AS users
           WHERE users.id = $1::uuid
             AND NOT EXISTS (
               SELECT 1
               FROM public.to_delete_accounts AS deleted
               WHERE deleted.account_id = users.id
             )
         ) AS user_is_recovery_eligible,
         EXISTS (
           SELECT 1
           FROM public.role_bindings
           WHERE principal_type = 'user'
             AND principal_id = $1::uuid
             AND scope_type = 'org'
             AND org_id IS NOT NULL
             AND is_direct IS TRUE
             AND (expires_at IS NULL OR expires_at > pg_catalog.now())
         ) AS has_active_direct_org_access`,
      [userId],
    )
    return result.rows[0] ?? {
      has_active_direct_org_access: false,
      user_is_recovery_eligible: false,
    }
  }
  finally {
    // General-backend Pools are request-scoped and closeClient intentionally
    // does not end them in workerd. Destroy the checked-out socket at the query
    // boundary so it cannot survive across Bento I/O or request teardown.
    pgClient.release(true)
  }
}

export async function prepareNewUserProvisioning(
  c: Context<MiddlewareKeyVariables>,
  user: Database['public']['Tables']['users']['Row'],
) {
  const email = normalizeBentoEmail(user.email)
  const pgPool = getPgClient(c)
  try {
    const state = await getFirstOrgDatabaseState(pgPool, user.id)
    if (!state.user_is_recovery_eligible) {
      await suppressAndUnsubscribeDeletedUserRecovery(c, email)
      return false
    }
    return true
  }
  finally {
    await closeClient(c, pgPool)
  }
}

export async function syncBentoFirstOrgOnUserCreate(
  c: Context<MiddlewareKeyVariables>,
  user: Database['public']['Tables']['users']['Row'],
) {
  const email = normalizeBentoEmail(user.email)
  const pgPool = getPgClient(c)
  try {
    // Provisioning can overlap account deletion. Read before lifecycle work
    // and reconcile after each terminal mutation so recovery stays fail closed.
    const postProvisionState = await getFirstOrgDatabaseState(pgPool, user.id)
    if (!postProvisionState.user_is_recovery_eligible) {
      await suppressAndUnsubscribeDeletedUserRecovery(c, email)
      return
    }
    if (user.created_via_invite || postProvisionState.has_active_direct_org_access) {
      await runBentoMutationWithFirstOrgReconciliation(
        c,
        pgPool,
        user.id,
        email,
        async () => await setAwaitingFirstOrgTag(c, email, false),
      )
      return
    }

    const finalState = await runBentoMutationWithFirstOrgReconciliation(
      c,
      pgPool,
      user.id,
      email,
      async () => await setAwaitingFirstOrgTag(c, email, true),
    )
    if (!finalState.user_is_recovery_eligible)
      return
    if (finalState.has_active_direct_org_access) {
      await runBentoMutationWithFirstOrgReconciliation(
        c,
        pgPool,
        user.id,
        email,
        async () => await setAwaitingFirstOrgTag(c, email, false),
      )
      return
    }

    // This read deliberately follows the final registration-side Bento
    // mutation. If deletion committed first, suppress and unsubscribe here;
    // if it commits later, the queued deletion worker submits cleanup afterward.
    const settledState = await runBentoMutationWithFirstOrgReconciliation(
      c,
      pgPool,
      user.id,
      email,
      async () => {
        const result = await trackBentoEvent(c, email, {
          user_id: user.id,
          registered_at: user.created_at,
          created_via_invite: false,
        }, BENTO_REGISTERED_WITHOUT_ORG_EVENT)
        ensureBentoDelivery(result, 'registered_without_org_event')
      },
    )
    if (settledState.user_is_recovery_eligible && settledState.has_active_direct_org_access) {
      await runBentoMutationWithFirstOrgReconciliation(
        c,
        pgPool,
        user.id,
        email,
        async () => await setAwaitingFirstOrgTag(c, email, false),
      )
    }
  }
  finally {
    await closeClient(c, pgPool)
  }
}

export async function syncBentoFirstOrgOnRoleBindingWrite(
  c: Context<MiddlewareKeyVariables>,
  roleBindingId: string,
) {
  const pgPool = getPgClient(c)
  try {
    let binding: CurrentRoleBinding | undefined
    const pgClient = await pgPool.connect()
    try {
      const result = await pgClient.query<CurrentRoleBinding>(
        `SELECT
           binding.id,
           binding.principal_type,
           binding.principal_id,
           binding.scope_type,
           binding.org_id,
           binding.granted_at,
           binding.is_direct,
           (binding.expires_at IS NULL OR binding.expires_at > pg_catalog.now()) AS is_active,
           users.email
         FROM public.role_bindings AS binding
         LEFT JOIN public.users AS users
           ON users.id = binding.principal_id
         WHERE binding.id = $1::uuid
         LIMIT 1`,
        [roleBindingId],
      )
      binding = result.rows[0]
    }
    finally {
      // See hasActiveDirectOrgAccess: destroy this request-scoped socket before
      // the handler crosses the network boundary into Bento.
      pgClient.release(true)
    }

    if (
      !binding
      || binding.principal_type !== 'user'
      || binding.scope_type !== 'org'
      || !binding.org_id
      || binding.is_direct !== true
      || binding.is_active !== true
      || !binding.email
    ) {
      return
    }

    const email = normalizeBentoEmail(binding.email)
    const preMutationState = await getFirstOrgDatabaseState(pgPool, binding.principal_id)
    if (!preMutationState.user_is_recovery_eligible) {
      await suppressAndUnsubscribeDeletedUserRecovery(c, email)
      return
    }

    await runBentoMutationWithFirstOrgReconciliation(
      c,
      pgPool,
      binding.principal_id,
      email,
      async () => {
        await setAwaitingFirstOrgTag(c, email, false)
        const result = await trackBentoEvent(c, email, {
          user_id: binding.principal_id,
          org_id: binding.org_id,
          role_binding_id: binding.id,
          joined_at: binding.granted_at.toISOString(),
        }, BENTO_JOINED_ORG_EVENT)
        ensureBentoDelivery(result, 'joined_org_event')
      },
    )
  }
  finally {
    await closeClient(c, pgPool)
  }
}

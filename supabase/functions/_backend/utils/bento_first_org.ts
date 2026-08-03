import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { syncBentoSubscriberTags, trackBentoEvent } from './bento.ts'
import { quickError } from './hono.ts'
import { closeClient, getPgClient } from './pg.ts'

export const BENTO_AWAITING_FIRST_ORG_TAG = 'onboarding:awaiting_first_org'
export const BENTO_REGISTERED_WITHOUT_ORG_EVENT = 'user:registered_without_org'
export const BENTO_JOINED_ORG_EVENT = 'user:joined_org'

type PgClient = ReturnType<typeof getPgClient>

interface CurrentRoleBinding {
  email: string | null
  granted_at: string
  id: string
  is_active: boolean
  is_direct: boolean
  org_id: string | null
  principal_id: string
  principal_type: string
  scope_type: string
}

function normalizedEmail(email: string) {
  return email.trim().toLowerCase()
}

function ensureBentoDelivery(result: boolean | undefined, operation: string) {
  if (result === false)
    quickError(500, 'bento_lifecycle_delivery_failed', 'Bento lifecycle delivery failed', { operation })
}

async function setAwaitingFirstOrgTag(c: Context, email: string, awaiting: boolean) {
  const result = await syncBentoSubscriberTags(c, {
    email,
    segments: awaiting ? [BENTO_AWAITING_FIRST_ORG_TAG] : [],
    deleteSegments: awaiting ? [] : [BENTO_AWAITING_FIRST_ORG_TAG],
  })
  ensureBentoDelivery(result, awaiting ? 'add_awaiting_first_org_tag' : 'remove_awaiting_first_org_tag')
}

async function hasActiveDirectOrgAccess(pgClient: PgClient, userId: string) {
  const result = await pgClient.query<{ id: string }>(
    `SELECT id
     FROM public.role_bindings
     WHERE principal_type = 'user'
       AND principal_id = $1::uuid
       AND scope_type = 'org'
       AND org_id IS NOT NULL
       AND is_direct IS TRUE
       AND (expires_at IS NULL OR expires_at > pg_catalog.now())
     LIMIT 1`,
    [userId],
  )
  return result.rows.length > 0
}

export async function syncBentoFirstOrgOnUserCreate(
  c: Context<MiddlewareKeyVariables>,
  user: Database['public']['Tables']['users']['Row'],
) {
  const email = normalizedEmail(user.email)

  if (user.created_via_invite) {
    await setAwaitingFirstOrgTag(c, email, false)
    return
  }

  const pgClient = getPgClient(c)
  try {
    if (await hasActiveDirectOrgAccess(pgClient, user.id)) {
      await setAwaitingFirstOrgTag(c, email, false)
      return
    }

    await setAwaitingFirstOrgTag(c, email, true)

    if (await hasActiveDirectOrgAccess(pgClient, user.id)) {
      await setAwaitingFirstOrgTag(c, email, false)
      return
    }

    const result = await trackBentoEvent(c, email, {
      user_id: user.id,
      registered_at: user.created_at,
      created_via_invite: false,
    }, BENTO_REGISTERED_WITHOUT_ORG_EVENT)
    ensureBentoDelivery(result, 'registered_without_org_event')
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export async function syncBentoFirstOrgOnRoleBindingWrite(
  c: Context<MiddlewareKeyVariables>,
  roleBindingId: string,
) {
  const pgClient = getPgClient(c)
  let binding: CurrentRoleBinding | undefined
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
    await closeClient(c, pgClient)
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

  const email = normalizedEmail(binding.email)
  await setAwaitingFirstOrgTag(c, email, false)
  const result = await trackBentoEvent(c, email, {
    user_id: binding.principal_id,
    org_id: binding.org_id,
    role_binding_id: binding.id,
    joined_at: binding.granted_at,
  }, BENTO_JOINED_ORG_EVENT)
  ensureBentoDelivery(result, 'joined_org_event')
}

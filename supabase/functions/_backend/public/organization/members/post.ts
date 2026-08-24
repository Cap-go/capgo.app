import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../../utils/hono.ts'
import type { Database } from '../../../utils/supabase.types.ts'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { safeParseSchema } from '../../../utils/schema_validation.ts'
import { BRES, simpleError } from '../../../utils/hono.ts'
import { cloudlog } from '../../../utils/logging.ts'
import { closeClient, getPgClient } from '../../../utils/pg.ts'
import { checkPermission } from '../../../utils/rbac.ts'

const rbacInviteRoles = ['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin'] as const

type RbacInviteRole = (typeof rbacInviteRoles)[number]

const inviteRoleAliases: Record<string, RbacInviteRole> = {
  read: 'org_member',
  upload: 'org_member',
  write: 'org_member',
  admin: 'org_admin',
  super_admin: 'org_super_admin',
  invite_read: 'org_member',
  invite_upload: 'org_member',
  invite_write: 'org_member',
  invite_admin: 'org_admin',
  invite_super_admin: 'org_super_admin',
}

const allowedInviteRoles = [...rbacInviteRoles, ...Object.keys(inviteRoleAliases)]
const allowedInviteRoleSet = new Set<string>(allowedInviteRoles)
const rbacInviteRoleSet = new Set<string>(rbacInviteRoles)
const inviteTypeSchema = z.enum(allowedInviteRoles as [string, ...string[]])

const inviteBodySchema = z.object({
  orgId: z.string(),
  email: z.email(),
  invite_type: inviteTypeSchema,
})

interface PgTransactionClient {
  query: <TRow = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rowCount?: number | null, rows: TRow[] }>
  release: () => void
}

export function normalizeInviteRole(inviteType: string): RbacInviteRole | null {
  if (!allowedInviteRoleSet.has(inviteType))
    return null

  if (rbacInviteRoleSet.has(inviteType))
    return inviteType as RbacInviteRole

  return inviteRoleAliases[inviteType]
}

export async function post(c: Context<MiddlewareKeyVariables>, bodyRaw: unknown, _apikey: Database['public']['Tables']['apikeys']['Row']) {
  const bodyParsed = safeParseSchema(inviteBodySchema, bodyRaw)
  if (!bodyParsed.success) {
    throw simpleError('invalid_body', 'Invalid body', { error: bodyParsed.error })
  }
  const body = bodyParsed.data

  // Auth context is already set by middlewareKey
  if (!(await checkPermission(c, 'org.invite_user', { orgId: body.orgId }))) {
    throw simpleError('cannot_access_organization', 'You can\'t access this organization', { orgId: body.orgId })
  }

  const effectiveApikey = _apikey?.key ?? c.get('capgkey')
  if (!effectiveApikey) {
    throw simpleError('not_authorized', 'Not authorized')
  }

  const rbacRoleName = normalizeInviteRole(body.invite_type)

  if (!rbacRoleName)
    throw simpleError('invalid_body', 'Invalid invite type', { invite_type: body.invite_type })

  // API-key PostgREST clients run as anon, so this checked endpoint calls
  // invite_user_to_org_rbac via Postgres (not service-role Supabase SDK) after
  // revoking anon execute. Mirrors organization/post.ts: set capgkey in
  // request.headers inside a transaction so the SECURITY DEFINER RPC sees it.
  const pgPool = getPgClient(c)
  let dbClient: PgTransactionClient | null = null
  let transactionStarted = false
  try {
    dbClient = await pgPool.connect() as PgTransactionClient
    await dbClient.query('BEGIN')
    transactionStarted = true
    await dbClient.query(
      'SELECT set_config($1, $2, true)',
      ['request.headers', JSON.stringify({ capgkey: effectiveApikey })],
    )
    const result = await dbClient.query<{ invite_user_to_org_rbac: string }>(
      'SELECT public.invite_user_to_org_rbac($1::varchar, $2::uuid, $3::text) AS invite_user_to_org_rbac',
      [body.email, body.orgId, rbacRoleName],
    )
    const data = result.rows[0]?.invite_user_to_org_rbac
    if (!data || data !== 'OK') {
      throw simpleError('error_inviting_user_to_organization', 'Error inviting user to organization', { data })
    }
    await dbClient.query('COMMIT')
    transactionStarted = false
  }
  catch (error) {
    if (dbClient && transactionStarted) {
      await dbClient.query('ROLLBACK').catch(() => {})
    }
    if (error instanceof HTTPException)
      throw error
    throw simpleError('error_inviting_user_to_organization', 'Error inviting user to organization', { error })
  }
  finally {
    dbClient?.release()
    closeClient(c, pgPool)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'User invited to organization', data: { email: body.email, org_id: body.orgId } })
  return c.json(BRES)
}

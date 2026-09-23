import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { canCallerAssignOrgRole } from '../utils/rbac.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { emptySupabase, supabaseClient } from '../utils/supabase.ts'
import { normalizeInviteRole } from '../public/organization/members/post.ts'

const orgIdSchema = z.uuid()
const rbacOrgRoleSchema = z.enum(['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin'])

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

const normalizedEmailSchema = z.string().transform(normalizeEmail).pipe(z.email())
const normalizedEmailStringSchema = z.string().transform(normalizeEmail).pipe(z.string().min(1))

const inviteBodySchema = z.object({
  email: normalizedEmailSchema,
  org_id: orgIdSchema,
  role_name: z.string().min(1),
})

const rescindBodySchema = z.object({
  email: normalizedEmailStringSchema,
  org_id: orgIdSchema,
})

const memberRoleBodySchema = z.object({
  org_id: orgIdSchema,
  user_id: orgIdSchema,
  role_name: rbacOrgRoleSchema,
})

const acceptBodySchema = z.object({
  org_id: orgIdSchema,
})

const declineBodySchema = z.object({
  org_id: orgIdSchema.optional(),
  org_ids: z.array(orgIdSchema).min(1).optional(),
}).superRefine((body, ctx) => {
  if (!body.org_id && (!body.org_ids || body.org_ids.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      message: 'org_id or org_ids is required',
      path: ['org_id'],
    })
  }
})

const inviteRoleBodySchema = z.object({
  org_id: orgIdSchema,
  role_name: rbacOrgRoleSchema,
  is_tmp: z.boolean(),
  user_id: orgIdSchema.optional(),
  email: normalizedEmailStringSchema.optional(),
}).superRefine((body, ctx) => {
  if (body.is_tmp) {
    if (!body.email) {
      ctx.addIssue({
        code: 'custom',
        message: 'email is required for tmp invites',
        path: ['email'],
      })
    }
    return
  }

  if (!body.user_id) {
    ctx.addIssue({
      code: 'custom',
      message: 'user_id is required for org user invites',
      path: ['user_id'],
    })
  }
})

function parseOrgId(orgId: string | undefined): string {
  const trimmed = orgId?.trim()
  if (!trimmed)
    throw simpleError('missing_params', 'org_id is required')
  const parsed = orgIdSchema.safeParse(trimmed)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid org_id')
  return parsed.data
}

function getAuthedSupabase(c: Parameters<typeof supabaseClient>[0]) {
  const authorization = c.get('authorization')
  if (!authorization)
    throw simpleError('not_authorized', 'Not authorized')
  return supabaseClient(c, authorization)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', useCors)

app.get('/', middlewareAuth, async (c) => {
  const orgId = parseOrgId(c.req.query('org_id'))
  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('get_org_members_rbac', { p_org_id: orgId })

  if (error)
    throw simpleError('members_list_error', error.message)

  return c.json(data ?? [])
})

app.post('/invite', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = inviteBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  const roleName = normalizeInviteRole(parsed.data.role_name)
  if (!roleName)
    throw simpleError('invalid_body', 'Invalid role_name', { role_name: parsed.data.role_name })

  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('invite_user_to_org_rbac', {
    email: parsed.data.email,
    org_id: parsed.data.org_id,
    role_name: roleName,
  })

  if (error)
    throw simpleError('invite_error', error.message)

  return c.json({ code: data ?? '' })
})

app.post('/rescind', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = rescindBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('rescind_invitation', {
    email: parsed.data.email,
    org_id: parsed.data.org_id,
  })

  if (error)
    throw simpleError('rescind_error', error.message)

  return c.json({ code: data ?? '' })
})

app.patch('/member-role', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = memberRoleBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('update_org_member_role', {
    p_org_id: parsed.data.org_id,
    p_user_id: parsed.data.user_id,
    p_new_role_name: parsed.data.role_name,
  })

  if (error)
    throw simpleError('member_role_error', error.message)

  if (data !== 'OK')
    throw simpleError('member_role_error', typeof data === 'string' ? data : 'Unexpected member role response')

  return c.json({ status: 'ok' })
})

app.patch('/invite-role', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = inviteRoleBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  if (parsed.data.is_tmp && !await canCallerAssignOrgRole(c, parsed.data.org_id, parsed.data.role_name)) {
    throw quickError(403, 'not_authorized', 'Not authorized', { org_id: parsed.data.org_id })
  }

  const supabase = getAuthedSupabase(c)
  const { data, error } = parsed.data.is_tmp
    ? await supabase.rpc('update_tmp_invite_role_rbac', {
        p_org_id: parsed.data.org_id,
        p_email: parsed.data.email!,
        p_new_role_name: parsed.data.role_name,
      })
    : await supabase.rpc('update_org_invite_role_rbac', {
        p_org_id: parsed.data.org_id,
        p_user_id: parsed.data.user_id!,
        p_new_role_name: parsed.data.role_name,
      })

  if (error)
    throw simpleError('invite_role_error', error.message)

  if (data !== 'OK')
    throw simpleError('invite_role_error', typeof data === 'string' ? data : 'Unexpected invite role response')

  return c.json({ status: 'ok' })
})

app.post('/accept', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = acceptBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  const supabase = getAuthedSupabase(c)
  const { data, error } = await supabase.rpc('accept_invitation_to_org', {
    org_id: parsed.data.org_id,
  })

  if (error)
    throw simpleError('accept_error', error.message)

  if (data !== 'OK')
    throw simpleError('accept_error', typeof data === 'string' ? data : 'Unexpected accept response')

  return c.json({ status: 'ok' })
})

app.post('/decline', middlewareAuth, async (c) => {
  const body = await parseBody<unknown>(c)
  const parsed = declineBodySchema.safeParse(body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid body', { error: parsed.error.message })

  const auth = c.get('auth')
  const userId = auth?.userId
  if (!userId)
    throw simpleError('not_authorized', 'Not authorized')

  const orgIds = parsed.data.org_ids ?? (parsed.data.org_id ? [parsed.data.org_id] : [])
  const pgPool = getPgClient(c)
  const dbClient = await pgPool.connect()
  let transactionOpen = false
  try {
    await dbClient.query('BEGIN')
    transactionOpen = true
    for (const orgId of orgIds)
      await dbClient.query('SELECT public.lock_rbac_orgs($1::uuid)', [orgId])

    const deleted = await dbClient.query(
      `
        DELETE FROM public.org_users
        WHERE user_id = $1::uuid
          AND org_id = ANY($2::uuid[])
          AND app_id IS NULL
          AND channel_id IS NULL
          AND is_invite IS TRUE
        RETURNING org_id
      `,
      [userId, orgIds],
    )
    if ((deleted.rowCount ?? 0) < 1)
      throw simpleError('decline_error', 'NO_INVITE')

    await dbClient.query('COMMIT')
  }
  catch (error) {
    if (transactionOpen)
      await dbClient.query('ROLLBACK').catch(() => {})
    throw error
  }
  finally {
    dbClient.release()
    closeClient(c, pgPool)
  }

  return c.json({ status: 'ok' })
})

app.get('/magic-invite', async (c) => {
  const lookup = c.req.query('lookup')?.trim()
  if (!lookup)
    throw simpleError('missing_params', 'lookup is required')

  const supabase = emptySupabase(c)
  const { data, error } = await supabase.rpc('get_invite_by_magic_lookup', { lookup }).maybeSingle()

  if (error)
    throw simpleError('magic_invite_error', error.message)

  if (!data)
    return c.json(null, 404)

  return c.json(data)
})

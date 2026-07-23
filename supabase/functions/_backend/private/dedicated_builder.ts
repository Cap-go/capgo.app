import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { type } from 'arktype'
import { safeParseSchema } from '../utils/ark_validation.ts'
import {
  countActiveDedicatedBuilds,
  getDedicatedBuilderForOrg,
  publicDedicatedBuilderView,
} from '../utils/dedicated_builder.ts'
import { sendDiscordAlert } from '../utils/discord.ts'
import { BRES, createHono, middlewareAuth, parseBody, quickError, simpleError, useCors } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { sendEventToTracking } from '../utils/tracking.ts'
import { version } from '../utils/version.ts'

const uuidSchema = type('string.uuid')

const requestBodySchema = type({
  'org_id': 'string.uuid',
  'use_case?': 'string <= 2000',
  'monthly_builds_estimate?': 'number.integer >= 0',
  'platforms?': 'string[]',
})

const patchBodySchema = type({
  'allow_shared_fallback?': 'boolean',
  'cancel?': 'boolean',
})

const ALLOWED_PLATFORMS = new Set(['ios', 'android'])

export const app = createHono('', version)

app.use('*', useCors)

async function requireReadBilling(c: Context<MiddlewareKeyVariables>, orgId: string) {
  const allowed = await checkPermission(c, 'org.read_billing' as any, { orgId })
  if (!allowed)
    throw quickError(403, 'not_authorized', 'Not authorized to view dedicated builder')
}

async function requireUpdateBilling(c: Context<MiddlewareKeyVariables>, orgId: string) {
  const allowed = await checkPermission(c, 'org.update_billing' as any, { orgId })
  if (!allowed)
    throw quickError(403, 'not_authorized', 'Not authorized to manage dedicated builder')
}

function normalizePlatforms(platforms: string[] | undefined): string[] {
  if (!platforms || platforms.length === 0)
    return ['ios', 'android']

  const normalized = [...new Set(platforms.map(p => p.trim().toLowerCase()).filter(Boolean))]
  if (normalized.length === 0)
    return ['ios', 'android']

  for (const platform of normalized) {
    if (!ALLOWED_PLATFORMS.has(platform))
      throw simpleError('invalid_body', `Unsupported platform "${platform}". Allowed: ios, android`)
  }
  return normalized
}

async function loadOrgName(c: Context<MiddlewareKeyVariables>, orgId: string): Promise<string> {
  const { data } = await supabaseAdmin(c)
    .from('orgs')
    .select('name')
    .eq('id', orgId)
    .maybeSingle()
  return data?.name ?? orgId
}

async function notifyDedicatedBuilderRequested(
  c: Context<MiddlewareKeyVariables>,
  input: {
    orgId: string
    orgName: string
    userId: string
    useCase: string | null
    monthlyBuildsEstimate: number | null
    platforms: string[]
  },
) {
  try {
    await sendDiscordAlert(c, {
      content: '🏗️ **Dedicated builder requested**',
      embeds: [
        {
          title: 'Dedicated native builder request',
          color: 0x119EFF,
          fields: [
            { name: 'Organization', value: `${input.orgName}\n\`${input.orgId}\``, inline: false },
            { name: 'Requested by', value: `\`${input.userId}\``, inline: true },
            { name: 'Platforms', value: input.platforms.join(', ') || 'ios, android', inline: true },
            {
              name: 'Monthly builds estimate',
              value: input.monthlyBuildsEstimate != null ? String(input.monthlyBuildsEstimate) : 'not provided',
              inline: true,
            },
            {
              name: 'Use case',
              value: (input.useCase?.trim() || 'not provided').slice(0, 1000),
              inline: false,
            },
          ],
        },
      ],
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to send dedicated builder Discord alert',
      error: (error as Error)?.message,
    })
  }

  try {
    await sendEventToTracking(c, {
      event: 'Dedicated Builder Requested',
      channel: 'build-lifecycle',
      icon: '🏗️',
      notify: false,
      user_id: input.userId,
      groups: { organization: input.orgId },
      tags: {
        org_id: input.orgId,
        platforms: input.platforms.join(','),
        ...(input.monthlyBuildsEstimate != null
          ? { monthly_builds_estimate: input.monthlyBuildsEstimate }
          : {}),
      },
    })
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'Failed to track dedicated builder request',
      error: (error as Error)?.message,
    })
  }
}

// GET /private/dedicated_builder/:orgId
app.get('/:orgId', middlewareAuth, async (c) => {
  const orgIdResult = uuidSchema(c.req.param('orgId'))
  if (orgIdResult instanceof type.errors)
    throw simpleError('invalid_org_id', 'Invalid organization id')

  const orgId = orgIdResult
  await requireReadBilling(c, orgId)

  const row = await getDedicatedBuilderForOrg(c, orgId)
  if (!row)
    return c.json({ dedicated_builder: null }, 200)

  const activeDedicatedBuilds = await countActiveDedicatedBuilds(c, orgId)
  return c.json({
    dedicated_builder: publicDedicatedBuilderView(row, activeDedicatedBuilds),
  }, 200)
})

// POST /private/dedicated_builder — request a dedicated builder
app.post('/', middlewareAuth, async (c) => {
  const auth = c.get('auth')!
  const body = await parseBody<unknown>(c)
  const parsed = safeParseSchema(requestBodySchema, body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid request body', { body, parsed })

  const orgId = parsed.data.org_id
  await requireUpdateBilling(c, orgId)

  const platforms = normalizePlatforms(parsed.data.platforms)
  const useCase = parsed.data.use_case?.trim() || null
  const monthlyBuildsEstimate = parsed.data.monthly_builds_estimate ?? null

  const existing = await getDedicatedBuilderForOrg(c, orgId)
  if (existing && existing.status !== 'cancelled') {
    throw quickError(409, 'dedicated_builder_exists', 'A dedicated builder request already exists for this organization', {
      status: existing.status,
    })
  }

  let row
  if (existing?.status === 'cancelled') {
    const { data, error } = await supabaseAdmin(c)
      .from('dedicated_builders')
      .update({
        status: 'requested',
        requested_by: auth.userId,
        use_case: useCase,
        monthly_builds_estimate: monthlyBuildsEstimate,
        platforms,
        allow_shared_fallback: true,
        pool_id: null,
        worker_name: null,
        worker_status: 'unknown',
        worker_current_job_id: null,
        worker_last_seen_at: null,
        activated_at: null,
        suspended_at: null,
        cancelled_at: null,
      })
      .eq('id', existing.id)
      .select('*')
      .single()

    if (error || !data) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to re-request dedicated builder', error })
      throw simpleError('internal_error', 'Unable to request dedicated builder')
    }
    row = data
  }
  else {
    const { data, error } = await supabaseAdmin(c)
      .from('dedicated_builders')
      .insert({
        org_id: orgId,
        status: 'requested',
        requested_by: auth.userId,
        use_case: useCase,
        monthly_builds_estimate: monthlyBuildsEstimate,
        platforms,
        allow_shared_fallback: true,
      })
      .select('*')
      .single()

    if (error || !data) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to create dedicated builder request', error })
      throw simpleError('internal_error', 'Unable to request dedicated builder')
    }
    row = data
  }

  const orgName = await loadOrgName(c, orgId)
  await notifyDedicatedBuilderRequested(c, {
    orgId,
    orgName,
    userId: auth.userId,
    useCase,
    monthlyBuildsEstimate,
    platforms,
  })

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Dedicated builder requested',
    org_id: orgId,
    dedicated_builder_id: row.id,
  })

  return c.json({
    dedicated_builder: publicDedicatedBuilderView(row, 0),
  }, 200)
})

async function cancelDedicatedBuilderRequest(
  c: Context<MiddlewareKeyVariables>,
  existing: NonNullable<Awaited<ReturnType<typeof getDedicatedBuilderForOrg>>>,
) {
  if (existing.status !== 'requested' && existing.status !== 'provisioning') {
    throw quickError(400, 'cannot_cancel', 'Only requested or provisioning dedicated builders can be cancelled from the console')
  }

  const { data, error } = await supabaseAdmin(c)
    .from('dedicated_builders')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', existing.id)
    .select('*')
    .single()

  if (error || !data) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to cancel dedicated builder', error })
    throw simpleError('internal_error', 'Unable to cancel dedicated builder request')
  }

  return c.json({
    dedicated_builder: publicDedicatedBuilderView(data, 0),
    ...BRES,
  }, 200)
}

async function updateDedicatedBuilderFallback(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  existing: NonNullable<Awaited<ReturnType<typeof getDedicatedBuilderForOrg>>>,
  allowSharedFallback: boolean,
) {
  if (existing.status !== 'active' && existing.status !== 'provisioning' && existing.status !== 'requested') {
    throw quickError(400, 'invalid_status', 'Fallback can only be changed while the dedicated builder is active or pending')
  }

  const { data, error } = await supabaseAdmin(c)
    .from('dedicated_builders')
    .update({
      allow_shared_fallback: allowSharedFallback,
    })
    .eq('id', existing.id)
    .select('*')
    .single()

  if (error || !data) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to update dedicated builder fallback', error })
    throw simpleError('internal_error', 'Unable to update dedicated builder')
  }

  const activeDedicatedBuilds = await countActiveDedicatedBuilds(c, orgId)
  return c.json({
    dedicated_builder: publicDedicatedBuilderView(data, activeDedicatedBuilds),
    ...BRES,
  }, 200)
}

// PATCH /private/dedicated_builder/:orgId — toggle fallback or cancel a pending request
app.patch('/:orgId', middlewareAuth, async (c) => {
  const orgIdResult = uuidSchema(c.req.param('orgId'))
  if (orgIdResult instanceof type.errors)
    throw simpleError('invalid_org_id', 'Invalid organization id')

  const orgId = orgIdResult
  await requireUpdateBilling(c, orgId)

  const body = await parseBody<unknown>(c)
  const parsed = safeParseSchema(patchBodySchema, body)
  if (!parsed.success)
    throw simpleError('invalid_body', 'Invalid request body', { body, parsed })

  if (parsed.data.allow_shared_fallback === undefined && parsed.data.cancel === undefined)
    throw simpleError('invalid_body', 'Nothing to update')

  const existing = await getDedicatedBuilderForOrg(c, orgId)
  if (!existing)
    throw quickError(404, 'not_found', 'No dedicated builder found for this organization')

  if (parsed.data.cancel)
    return cancelDedicatedBuilderRequest(c, existing)

  if (parsed.data.allow_shared_fallback !== undefined)
    return updateDedicatedBuilderFallback(c, orgId, existing, parsed.data.allow_shared_fallback)

  throw simpleError('invalid_body', 'Nothing to update')
})

import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { cloudflareCustomHostname, customDomainConfig, customDomainInstructions, hostnameSchema } from '../utils/custom-domains.ts'
import { BRES, createHono, parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient, withPgTransaction } from '../utils/pg.ts'
import { requireEnterprisePlan } from '../utils/plan-gating.ts'
import { checkPermission } from '../utils/rbac.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)
app.use('*', useCors)
app.use('*', middlewareAuth)

async function authorize(c: Context<MiddlewareKeyVariables>) {
  const orgId = c.req.param('orgId')
  if (!orgId || !z.uuid().safeParse(orgId).success)
    quickError(400, 'invalid_org_id', 'Invalid organization ID')
  if (!await checkPermission(c, 'org.update_settings', { orgId }))
    quickError(403, 'not_authorized', 'Not authorized')
  return orgId
}

app.get('/:orgId', async (c) => {
  const orgId = await authorize(c)
  const pool = getPgClient(c)
  try {
    const { rows } = await pool.query<{ provider_id: string }>('SELECT provider_id FROM public.org_custom_domains WHERE org_id = $1', [orgId])
    if (!rows[0])
      return c.json({ domain: null })
    const host = await cloudflareCustomHostname(c, 'GET', rows[0].provider_id)
    return c.json({ domain: customDomainInstructions(host!, customDomainConfig(c).target) })
  }
  finally {
    closeClient(c, pool)
  }
})

app.post('/:orgId', async (c) => {
  const orgId = await authorize(c)
  await requireEnterprisePlan(c, orgId, 'Custom domains')
  const body = await parseBody<{ hostname?: string }>(c)
  const parsed = hostnameSchema.safeParse(body.hostname)
  if (!parsed.success)
    return quickError(400, 'invalid_hostname', 'Enter a hostname such as updates.example.com, without a URL or wildcard.')
  const config = customDomainConfig(c)
  const pool = getPgClient(c)
  let createdId: string | undefined
  try {
    const result = await withPgTransaction(pool, async (client) => {
      // Serialize create/delete for this org without scanning other tenants.
      await client.query('SELECT id FROM public.orgs WHERE id = $1 FOR UPDATE', [orgId])
      const existing = await client.query('SELECT org_id FROM public.org_custom_domains WHERE org_id = $1', [orgId])
      if (existing.rows.length)
        quickError(409, 'custom_domain_exists', 'Remove the existing domain before adding another.')
      // Reserve the unique hostname before calling Cloudflare to prevent tenant races.
      // Availability is public DNS information; report only a conflict, never the owning org.
      const reserved = await client.query('INSERT INTO public.org_custom_domains (org_id, hostname) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING org_id', [orgId, parsed.data])
      if (!reserved.rows.length)
        quickError(409, 'custom_domain_exists', 'This hostname is unavailable.')
      const host = await cloudflareCustomHostname(c, 'POST', '', parsed.data)
      createdId = host!.id
      await client.query('UPDATE public.org_custom_domains SET provider_id = $2 WHERE org_id = $1', [orgId, createdId])
      return customDomainInstructions(host!, config.target)
    })
    return c.json({ domain: result })
  }
  catch (error) {
    if (createdId) {
      await cloudflareCustomHostname(c, 'DELETE', createdId).catch(cleanupError => cloudlogErr({ requestId: c.get('requestId'), message: 'Custom hostname rollback cleanup failed', error: cleanupError }))
    }
    throw error
  }
  finally {
    closeClient(c, pool)
  }
})

app.delete('/:orgId', async (c) => {
  // Allow cleanup after an Enterprise downgrade.
  const orgId = await authorize(c)
  const pool = getPgClient(c)
  try {
    await withPgTransaction(pool, async (client) => {
      await client.query('SELECT id FROM public.orgs WHERE id = $1 FOR UPDATE', [orgId])
      const { rows } = await client.query<{ provider_id: string }>('SELECT provider_id FROM public.org_custom_domains WHERE org_id = $1 FOR UPDATE', [orgId])
      if (rows[0]?.provider_id)
        await cloudflareCustomHostname(c, 'DELETE', rows[0].provider_id)
      await client.query('DELETE FROM public.org_custom_domains WHERE org_id = $1', [orgId])
    })
    return c.json(BRES)
  }
  finally {
    closeClient(c, pool)
  }
})

import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { verifyDnsTxtRecord } from '../../utils/dns-verification.ts'
import { createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlog } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { requireEnterprisePlan } from '../../utils/plan-gating.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'

const bodySchema = z.object({
  provider_id: z.uuid(),
})

export const app = createHono('', version)

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const auth = c.get('auth')
  if (!auth) {
    return quickError(401, 'not_authorized', 'Not authorized')
  }

  const rawBody = await parseBody<{ provider_id?: string }>(c)

  const validation = safeParseSchema(bodySchema, { provider_id: rawBody.provider_id })
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }

  const { provider_id } = validation.data
  const requestId = c.get('requestId')

  const admin = supabaseAdmin(c)

  const { data: provider, error: providerError } = await (admin as any)
    .from('sso_providers')
    .select('id, org_id, domain, dns_verification_token, status')
    .eq('id', provider_id)
    .single()

  if (providerError || !provider) {
    cloudlog({ requestId, context: 'verify-dns - provider not found', provider_id })
    return quickError(404, 'provider_not_found', 'SSO provider not found')
  }

  const allowed = await checkPermission(c, 'org.update_settings' as any, { orgId: provider.org_id })
  if (!allowed) {
    return quickError(403, 'not_authorized', 'Not authorized')
  }

  await requireEnterprisePlan(c, provider.org_id)

  const result = await verifyDnsTxtRecord(provider.domain, provider.dns_verification_token)

  if (result.error) {
    cloudlog({ requestId, context: 'verify-dns - DNS lookup error', error: result.error, domain: provider.domain })
    return c.json({ verified: false, message: `DNS verification failed: ${result.error}` })
  }

  if (result.verified) {
    const pgClient = getPgClient(c)
    try {
      const updateResult = await pgClient.query(
        `UPDATE sso_providers 
         SET status = 'verified', dns_verified_at = NOW() 
         WHERE id = $1 AND status = 'pending_verification'
         RETURNING id`,
        [provider_id],
      )

      if (updateResult.rowCount === 0) {
        cloudlog({ requestId, context: 'verify-dns - update error', provider_id })
        return quickError(500, 'update_failed', 'DNS verified but failed to update provider status')
      }
    }
    finally {
      closeClient(c, pgClient)
    }

    cloudlog({ requestId, context: 'verify-dns - verified', domain: provider.domain, provider_id })
    return c.json({ verified: true, message: 'DNS verification successful' })
  }

  cloudlog({ requestId, context: 'verify-dns - not verified', domain: provider.domain, provider_id })
  return c.json({
    verified: false,
    message: `DNS TXT record not found. Add: _capgo-sso.${provider.domain} → ${provider.dns_verification_token}`,
  })
})

import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'

export interface PrelinkUsersRequest {
  provider_id: string
  org_id: string
  domain: string
}

interface PrelinkCandidate {
  user_id: string
  email: string | null
  email_identity_id: string
}

export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.fr',
  'yahoo.co.uk',
  'outlook.com',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'gmx.com',
  'gmx.de',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
])

/**
 * Masks an email address for logging purposes, showing only the first character
 * of the local part and the domain. Example: "j***@example.com"
 */
function maskEmail(email: string | undefined | null): string | undefined {
  if (!email?.includes('@'))
    return undefined
  const [localPart, domainPart] = email.split('@', 2)
  if (!localPart || !domainPart)
    return undefined
  const maskedLocal = `${localPart.charAt(0)}***`
  return `${maskedLocal}@${domainPart}`
}

/**
 * Remove a specific identity from a user via the GoTrue admin REST API.
 * The Supabase JS SDK GoTrueAdminApi does not expose identity deletion,
 * so we call the endpoint directly with the service role key.
 */
async function adminDeleteIdentity(c: Context<MiddlewareKeyVariables>, userId: string, identityId: string): Promise<{ error: string | null }> {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const serviceRoleKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  const url = `${supabaseUrl}/auth/v1/admin/users/${userId}/identities/${identityId}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      if (res.status === 404) {
        return fallbackDeleteEmailIdentity(c, userId, identityId)
      }
      const body = await res.text().catch(() => 'unknown')
      return { error: `HTTP ${res.status}: ${body}` }
    }

    return { error: null }
  }
  catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { error: 'Request timed out after 5s' }
    }
    return { error: err instanceof Error ? err.message : String(err) }
  }
  finally {
    clearTimeout(timeout)
  }
}

async function fallbackDeleteEmailIdentity(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
  identityId: string,
): Promise<{ error: string | null }> {
  const pgClient = getPgClient(c)

  try {
    // Local/self-hosted Supabase builds can lack the GoTrue admin identity-delete
    // route. Mirror the intended effect by removing the email identity and clearing
    // the password hash so password auth no longer works.
    const result = await pgClient.query<{ deleted_identity_id: string }>(
      `
        with deleted_identity as (
          delete from auth.identities
          where id = $1
            and user_id = $2
            and provider = 'email'
          returning user_id, id as deleted_identity_id
        ),
        updated_user as (
          update auth.users
          set encrypted_password = null,
              updated_at = now()
          where id in (select user_id from deleted_identity)
          returning id
        )
        select deleted_identity_id
        from deleted_identity
        where exists (select 1 from updated_user)
      `,
      [identityId, userId],
    )

    if ((result.rowCount ?? 0) === 0) {
      return { error: 'Fallback identity unlink did not modify any rows' }
    }

    return { error: null }
  }
  catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  finally {
    await closeClient(c, pgClient)
  }
}

async function getOrgPrelinkCandidates(
  c: Context<MiddlewareKeyVariables>,
  orgId: string,
  domain: string,
): Promise<PrelinkCandidate[]> {
  const pgClient = getPgClient(c)

  try {
    const result = await pgClient.query<PrelinkCandidate>(
      `
        select distinct on (ou.user_id)
          ou.user_id,
          au.email,
          ai.id as email_identity_id
        from public.org_users ou
        inner join auth.users au
          on au.id = ou.user_id
        inner join auth.identities ai
          on ai.user_id = au.id
         and ai.provider = 'email'
        where ou.org_id = $1
          and au.email is not null
          and lower(split_part(au.email, '@', 2)) = $2
        order by ou.user_id, ai.created_at desc nulls last, ai.id
      `,
      [orgId, domain],
    )

    return result.rows
  }
  finally {
    await closeClient(c, pgClient)
  }
}

export async function runPrelinkUsers(
  c: Context<MiddlewareKeyVariables>,
  rawBody: PrelinkUsersRequest,
): Promise<{ processed: number, linked: number, error_count: number }> {
  if (!rawBody.provider_id || !rawBody.org_id || !rawBody.domain) {
    throw simpleError('invalid_body', 'Missing required fields: provider_id, org_id, domain')
  }

  const { provider_id, org_id, domain } = rawBody
  const requestId = c.get('requestId')

  const normalizedDomain = domain.toLowerCase().trim()

  if (PUBLIC_EMAIL_DOMAINS.has(normalizedDomain)) {
    cloudlogErr({ requestId, message: 'BLOCKED: prelink attempted on public email domain', domain: normalizedDomain, providerId: provider_id })
    quickError(400, 'public_domain_blocked', 'Cannot prelink users on public email domains')
  }

  const admin = supabaseAdmin(c)

  const { data: providerCheck, error: providerCheckError } = await (admin as any)
    .from('sso_providers')
    .select('id, org_id, domain, status')
    .eq('id', provider_id)
    .single()

  if (providerCheckError || !providerCheck) {
    cloudlogErr({ requestId, message: 'Provider not found for prelink', providerId: provider_id, error: providerCheckError })
    quickError(404, 'provider_not_found', 'SSO provider not found')
  }

  if (providerCheck.org_id !== org_id) {
    cloudlogErr({ requestId, message: 'Org mismatch: provider does not belong to requested org', providerId: provider_id, requestOrgId: org_id, providerOrgId: providerCheck.org_id })
    quickError(403, 'org_mismatch', 'SSO provider does not belong to the specified organization')
  }

  if (providerCheck.status !== 'active') {
    cloudlog({ requestId, message: 'Provider not active, cannot prelink', providerId: provider_id, status: providerCheck.status })
    quickError(400, 'provider_not_active', 'SSO provider must be active before prelinking users')
  }

  if (providerCheck.domain?.toLowerCase().trim() !== normalizedDomain) {
    cloudlogErr({ requestId, message: 'Domain mismatch between request and provider', requestDomain: normalizedDomain, providerDomain: providerCheck.domain })
    quickError(400, 'domain_mismatch', 'Requested domain does not match provider domain')
  }

  let errorCount = 0
  let linked = 0

  const candidates = await getOrgPrelinkCandidates(c, org_id, normalizedDomain)

  for (const candidate of candidates) {
    try {
      const { error: deleteError } = await adminDeleteIdentity(
        c,
        candidate.user_id,
        candidate.email_identity_id,
      )

      if (deleteError) {
        cloudlogErr({ requestId, message: 'Failed to unlink password identity', userId: candidate.user_id, error: deleteError })
        errorCount++
        continue
      }

      linked++
      cloudlog({
        requestId,
        message: 'Unlinked password identity for SSO migration',
        userId: candidate.user_id,
        emailMasked: maskEmail(candidate.email),
        domain,
        providerId: provider_id,
      })
    }
    catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      cloudlogErr({ requestId, message: 'Error processing user during prelink', userId: candidate.user_id, error: errMsg })
      errorCount++
    }
  }

  cloudlog({
    requestId,
    message: 'SSO pre-linking complete',
    providerId: provider_id,
    domain,
    processed: candidates.length,
    linked,
    errorCount,
  })

  return {
    processed: candidates.length,
    linked,
    error_count: errorCount,
  }
}

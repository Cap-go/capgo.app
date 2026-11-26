import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getPgClient } from '../../utils/pg.ts'

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
 * Remove a user's email identity and clear their password hash, so password
 * sign-in stops working. GoTrue has no admin route to delete one identity
 * (only the user-level unlink, which needs the user's own session), so this
 * writes the auth tables directly.
 */
async function deleteEmailIdentity(
  c: Context<MiddlewareKeyVariables>,
  userId: string,
  identityId: string,
): Promise<{ error: string | null }> {
  const pgClient = await getPgClient(c)

  try {
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
      return { error: 'Identity unlink did not modify any rows' }
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
  const pgClient = await getPgClient(c)

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

  let providerCheck: { id: string, org_id: string, domain: string | null, status: string } | undefined
  let providerCheckError: unknown = null
  const pgClient = await getPgClient(c)
  try {
    const result = await pgClient.query<{ id: string, org_id: string, domain: string | null, status: string }>(
      'SELECT id, org_id, domain, status FROM public.sso_providers WHERE id = $1',
      [provider_id],
    )
    providerCheck = result.rows[0]
  }
  catch (error) {
    providerCheckError = error
  }
  finally {
    await closeClient(c, pgClient)
  }

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
      const { error: deleteError } = await deleteEmailIdentity(
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

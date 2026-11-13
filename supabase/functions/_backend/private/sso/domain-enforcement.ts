import type { Context } from 'hono'
import { queryJson, withRlsContext } from '../../utils/pg_rls.ts'

export async function querySsoEnforcementByDomain(
  c: Context,
  domain: string,
): Promise<{ data: { org_id: string, enforce_sso: boolean }[] | null, error: Error | null }> {
  try {
    const data = await withRlsContext(c, { kind: 'anon' }, client =>
      queryJson<{ org_id: string, enforce_sso: boolean }>(client, 'SELECT * FROM public.get_sso_enforcement_by_domain(p_domain => $1)', [domain]))
    return { data, error: null }
  }
  catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export async function isEmailDomainSsoEnforced(c: Context, email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.toLowerCase().trim()
  if (!domain)
    return false

  const { data, error } = await querySsoEnforcementByDomain(c, domain)
  if (error)
    throw error

  return data?.[0]?.enforce_sso === true
}

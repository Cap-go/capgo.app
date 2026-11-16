export const MAX_CUSTOM_DOMAINS = 1000
// Same production project as deploy:supabase:prod; snippets only target production.
const PRODUCTION_PROJECT_REF = 'xvwzpoazmxkqosrdewyv'
export const CUSTOM_DOMAINS_SQL = `SELECT coalesce(json_agg(domains), '[]'::json) AS domains
FROM (
  SELECT hostname, (provider_id IS NOT NULL AND provider_route_id IS NOT NULL) AS provisioned
  FROM public.org_custom_domains ORDER BY hostname LIMIT ${MAX_CUSTOM_DOMAINS + 1}
) AS domains`

export function validateCustomDomains(domains: readonly string[]): string[] {
  if (domains.length > MAX_CUSTOM_DOMAINS)
    throw new Error('Production custom-domain inventory exceeds the deployment limit')
  for (const hostname of domains) {
    if (typeof hostname !== 'string' || hostname.length > 253
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
      || hostname === 'capgo.app' || hostname.endsWith('.capgo.app'))
      throw new Error('Production custom-domain inventory contains an invalid hostname')
  }
  return [...new Set(domains)].sort()
}

export async function loadProductionCustomDomains({ token, fetcher = fetch }: {
  token: string
  fetcher?: typeof fetch
}): Promise<string[]> {
  if (!token)
    throw new Error('Set SUPABASE_ACCESS_TOKEN to read production custom domains')
  let response: Response
  try {
    response = await fetcher(`https://api.supabase.com/v1/projects/${PRODUCTION_PROJECT_REF}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: CUSTOM_DOMAINS_SQL, read_only: true }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  }
  catch {
    throw new Error('Unable to read production custom domains')
  }
  if (!response.ok)
    throw new Error(`Production custom-domain query failed (HTTP ${response.status})`)
  const data: unknown = await response.json().catch(() => null)
  if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0]?.domains))
    throw new Error('Invalid production custom-domain response')
  const rows: unknown[] = data[0].domains
  const names = rows.map((row) => {
    if (!row || typeof row !== 'object' || !('hostname' in row) || typeof row.hostname !== 'string'
      || !('provisioned' in row) || row.provisioned !== true)
      throw new Error('Production custom-domain inventory contains an incomplete registration')
    return row.hostname
  })
  return validateCustomDomains(names)
}

// Recognize only unconditional host-equality alternatives. A hostname inside
// an AND, NOT, regex, or string must not count as a complete routing rule.
function unconditionalHosts(expression: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let firstGroupEnd = -1
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '"' || (expression[i] === 'r' && /^r#*"/.test(expression.slice(i)))) {
      const raw = /^r(#*)"/.exec(expression.slice(i))
      const close = raw ? `"${raw[1]}` : '"'
      i += raw ? raw[0].length : 1
      while (i < expression.length && !expression.startsWith(close, i)) {
        if (!raw && expression[i] === '\\') i++
        i++
      }
      if (i >= expression.length)
        throw new Error('Cannot safely parse the live plugin snippet expression')
      i += close.length - 1
      continue
    }
    if (expression[i] === '(') depth++
    if (expression[i] === ')') {
      depth--
      if (depth === 0 && firstGroupEnd === -1) firstGroupEnd = i
    }
    if (depth < 0)
      throw new Error('Cannot safely parse the live plugin snippet expression')
    const separator = depth === 0 ? /^\s+or\s+/.exec(expression.slice(i)) : null
    if (separator) {
      parts.push(expression.slice(start, i).trim())
      i += separator[0].length - 1
      start = i + 1
    }
  }
  if (depth !== 0)
    throw new Error('Cannot safely parse the live plugin snippet expression')
  if (parts.length)
    return [...parts, expression.slice(start).trim()].flatMap(unconditionalHosts)
  if (expression.startsWith('(') && firstGroupEnd === expression.length - 1)
    return unconditionalHosts(expression.slice(1, -1).trim())
  const match = /^http\.host\s+eq\s+"([a-z0-9.-]+)"$/.exec(expression)
  return match ? [match[1]] : []
}

export function includeCustomDomains(expression: string, domains: readonly string[]): { expression: string, added: number } {
  const names = validateCustomDomains(domains)
  const existing = new Set(unconditionalHosts(expression.trim()))
  const missing = names.filter(host => !existing.has(host))
  if (!missing.length)
    return { expression, added: 0 }
  const updated = `(${expression}) or ${missing.map(host => `(http.host eq "${host}")`).join(' or ')}`
  if (updated.length > 4096)
    throw new Error('Custom-domain routing would exceed the 4096-character expression limit')
  return { expression: updated, added: missing.length }
}

import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { createHono, quickError, useCors } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_jwt.ts'
import { cloudlog } from '../../utils/logging.ts'
import { getEnv } from '../../utils/utils.ts'
import { version } from '../../utils/version.ts'

export const app = createHono('', version)

app.use('*', useCors)
app.use('*', middlewareAuth)

function isLocalHost(host: string | undefined): boolean {
  return !!host && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?$/i.test(host)
}

function isLocalSupabaseUrl(url: string): boolean {
  if (url.includes('kong:8000'))
    return true

  try {
    return isLocalHost(new URL(url).host)
  }
  catch {
    return false
  }
}

function getPublicSupabaseUrl(c: Context<MiddlewareKeyVariables>): string {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL').replace(/\/$/, '')
  const isLocalSupabase = isLocalSupabaseUrl(supabaseUrl)
  let forwardedHost = c.req.header('X-Forwarded-Host')
  const forwardedPort = c.req.header('X-Forwarded-Port')
  const forwardedProto = c.req.header('X-Forwarded-Proto')?.split(',')[0]?.trim()
  const hostHeader = c.req.header('Host')
  const isLocalRequest = isLocalSupabase || isLocalHost(forwardedHost) || isLocalHost(hostHeader)

  if (isLocalSupabase && forwardedHost && !forwardedHost.includes(':')) {
    const hostPort = hostHeader?.includes(':') ? hostHeader.split(':').pop() : undefined
    const portToUse = forwardedPort || hostPort
    if (portToUse)
      forwardedHost = `${forwardedHost}:${portToUse}`
  }

  // Use SUPABASE_URL as source of truth on non-local hosts (production/preprod/custom domains).
  // Keep local request hosts (tests/dev) to preserve runtime-local expectations.
  if (!isLocalSupabase)
    return supabaseUrl

  if (forwardedHost)
    return `${forwardedProto || (isLocalRequest ? 'http' : 'https')}://${forwardedHost}`

  if (hostHeader)
    return `${isLocalRequest ? 'http' : 'https'}://${hostHeader}`

  return supabaseUrl
}

app.get('/', (c: Context<MiddlewareKeyVariables>) => {
  const auth = c.get('auth')
  const requestId = c.get('requestId')
  if (!auth) {
    cloudlog({ requestId, message: 'Unauthorized request to sp-metadata — no auth context', auth })
    return quickError(401, 'not_authorized', 'Not authorized')
  }

  const supabaseUrl = getPublicSupabaseUrl(c)

  const metadataUrl = `${supabaseUrl}/auth/v1/sso/saml/metadata`
  return c.json({
    acs_url: `${supabaseUrl}/auth/v1/sso/saml/acs`,
    entity_id: metadataUrl,
    sp_metadata_url: metadataUrl,
    nameid_format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  })
})

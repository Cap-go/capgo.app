import type { Context } from 'hono'
import { z } from 'zod'
import { safeParseSchema } from '../../utils/schema_validation.ts'
import { CacheHelper } from '../../utils/cache.ts'
import { createHono, parseBody, quickError, simpleError, useCors } from '../../utils/hono.ts'
import { cloudlog } from '../../utils/logging.ts'
import { getClientIP } from '../../utils/rate_limit.ts'
import { emptySupabase } from '../../utils/supabase.ts'
import { version } from '../../utils/version.ts'

// Rate limiting: 10 requests per minute per IP
const RATE_LIMIT_WINDOW_SECONDS = 60
const RATE_LIMIT_MAX_REQUESTS = 10
const RATE_LIMIT_CACHE_PATH = '/.sso-check-domain-rate'

interface RateLimitCounter {
  count: number
  resetAt: number
}

async function checkDomainRateLimit(c: Context): Promise<boolean> {
  const ip = getClientIP(c)

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(RATE_LIMIT_CACHE_PATH, { ip })
  const existing = await cacheHelper.matchJson<RateLimitCounter>(cacheKey)

  const now = Date.now()
  const inWindow = existing && existing.resetAt > now
  const count = inWindow ? existing.count + 1 : 1
  const resetAt = inWindow ? existing.resetAt : now + RATE_LIMIT_WINDOW_SECONDS * 1000

  await cacheHelper.putJson(cacheKey, { count, resetAt } satisfies RateLimitCounter, Math.max(1, Math.ceil((resetAt - now) / 1000)))

  if (count > RATE_LIMIT_MAX_REQUESTS) {
    cloudlog({ requestId: c.get('requestId'), message: 'check-domain rate limited', ip, count })
    return true
  }

  return false
}

const bodySchema = z.object({
  email: z.email(),
})

export const app = createHono('', version)

app.use('/', useCors)

app.post('/', async (c) => {
  const rateLimited = await checkDomainRateLimit(c)
  if (rateLimited) {
    return quickError(429, 'rate_limited', 'Too many requests, please try again later')
  }

  const rawBody = await parseBody<{ email?: string }>(c)

  const validation = safeParseSchema(bodySchema, { email: rawBody.email })
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }

  const { email } = validation.data

  // Extract domain from email
  const domain = email.split('@')[1]?.toLowerCase().trim()
  if (!domain) {
    return quickError(400, 'invalid_email', 'Email must contain a domain')
  }

  const supabase = emptySupabase(c)
  const requestId = c.get('requestId')

  try {
    const [
      { data: enforcementData, error: enforcementError },
      { data: legacyData, error: legacyError },
    ] = await Promise.all([
      (supabase.rpc as any)('get_sso_enforcement_by_domain', { p_domain: domain }),
      (supabase.rpc as any)('check_domain_sso', { p_domain: domain }),
    ])

    if (enforcementError || legacyError) {
      cloudlog({
        requestId,
        context: 'check_domain - query error',
        domain,
        enforcementError: enforcementError?.message,
        legacyError: legacyError?.message,
      })
      return quickError(500, 'query_error', 'Failed to check domain')
    }

    const enforcementRow = Array.isArray(enforcementData) ? enforcementData[0] : enforcementData
    const legacyRow = Array.isArray(legacyData) ? legacyData[0] : legacyData

    if (!enforcementRow && !legacyRow) {
      cloudlog({ requestId, context: 'check_domain - no SSO provider found', domain })
      return c.json({ has_sso: false })
    }

    cloudlog({
      requestId,
      context: 'check_domain - SSO provider found',
      domain,
      enforce_sso: enforcementRow?.enforce_sso,
      provider_id: legacyRow?.provider_id,
      org_id: enforcementRow?.org_id ?? legacyRow?.org_id,
    })

    return c.json({
      has_sso: true,
      enforce_sso: enforcementRow?.enforce_sso === true,
    })
  }
  catch (err) {
    cloudlog({ requestId, context: 'check_domain - unexpected error', error: String(err), domain })
    return quickError(500, 'internal_error', 'Internal server error')
  }
})

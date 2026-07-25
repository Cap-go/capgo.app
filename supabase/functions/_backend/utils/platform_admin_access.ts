import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from './hono.ts'
import { middlewareAPISecret, quickError } from './hono.ts'
import { getClaimsFromJWT } from './hono_jwt.ts'
import { cloudlogErr } from './logging.ts'
import { supabaseClient } from './supabase.ts'

type PlatformAdminContext = Context<MiddlewareKeyVariables, any, any>

export async function validatePlatformAdminOrApiSecret(
  c: PlatformAdminContext,
  options: {
    logPrefix: string
    forbiddenMessage: string
  },
) {
  const apiSecret = c.req.header('apisecret')

  if (apiSecret) {
    await middlewareAPISecret(c, async () => {})
    return
  }

  const authorization = c.req.header('authorization')
  if (!authorization) {
    throw quickError(401, 'no_authorization', 'Authorization header or apisecret is required')
  }

  const claims = await getClaimsFromJWT(c, authorization)
  if (!claims?.sub) {
    cloudlogErr({ requestId: c.get('requestId'), message: `${options.logPrefix}_invalid_jwt` })
    throw quickError(401, 'invalid_jwt', 'Invalid JWT')
  }

  c.set('authorization', authorization)
  c.set('auth', {
    userId: claims.sub,
    authType: 'jwt',
    apikey: null,
    jwt: authorization,
  })

  const userClient = supabaseClient(c, authorization)
  const { data: isAdmin, error: adminError } = await userClient.rpc('is_platform_admin')
  if (adminError) {
    cloudlogErr({ requestId: c.get('requestId'), message: `${options.logPrefix}_is_admin_error`, error: adminError })
    throw quickError(500, 'is_admin_error', 'Unable to verify admin rights')
  }

  if (!isAdmin) {
    cloudlogErr({ requestId: c.get('requestId'), message: `${options.logPrefix}_not_admin`, userId: claims.sub })
    throw quickError(403, 'not_admin', options.forbiddenMessage)
  }
}

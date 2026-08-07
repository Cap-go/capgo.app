import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { resolveCliUsageIdentity, trackCliUsage } from '../utils/cli_usage.ts'
import { useCors } from '../utils/hono.ts'
import { existInEnv, getEnv, isStripeConfigured } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.get('/', async (c) => {
  const cliVersion = c.req.header('x-cli-version') ?? ''
  if (cliVersion) {
    const capgkey = c.req.header('capgkey') ?? c.req.header('x-api-key') ?? undefined
    const identity = await resolveCliUsageIdentity(c, capgkey)
    trackCliUsage(c, {
      cli_version: cliVersion,
      command: c.req.header('x-cli-command') ?? '',
      node_version: c.req.header('x-cli-node') ?? '',
      os_platform: c.req.header('x-cli-os') ?? '',
      apikey_id: identity.apikey_id,
      org_id: identity.org_id,
      source: 'config',
      api_version: c.req.header('capgo_api') ?? '',
    })
  }

  return c.json({
    supaHost: existInEnv(c, 'SUPABASE_REPLICATE_URL') ? getEnv(c, 'SUPABASE_REPLICATE_URL') : getEnv(c, 'SUPABASE_URL'),
    supbaseId: getEnv(c, 'SUPABASE_URL')?.split('//')[1].split('.')[0].split(':')[0],
    supaKey: getEnv(c, 'SUPABASE_ANON_KEY'),
    stripeEnabled: isStripeConfigured(c),
  })
})

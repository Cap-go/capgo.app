import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { hasCliUsageIngest, resolveCliUsageIdentity, trackCliUsage } from '../utils/cli_usage.ts'
import { MIN_CLI_VERSION, MIN_CLI_VERSION_REASON } from '../utils/cliMinVersion.ts'
import { useCors } from '../utils/hono.ts'
import { isLegacySdkCli, notifyLegacyCliUpgrade } from '../utils/legacy_cli_notice.ts'
import { backgroundTask, existInEnv, getEnv, isStripeConfigured } from '../utils/utils.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.get('/', async (c) => {
  const cliVersion = c.req.header('x-cli-version') ?? ''
  const capgkey = c.req.header('capgkey') ?? c.req.header('x-api-key') ?? undefined
  // CLIs up to 8.90.0 read the database through PostgREST: ask their owner to upgrade, off the response path.
  if (capgkey && isLegacySdkCli(cliVersion))
    backgroundTask(c, notifyLegacyCliUpgrade(c, { capgkey, cliVersion }))
  if (cliVersion && hasCliUsageIngest(c)) {
    const event = {
      cli_version: cliVersion,
      command: c.req.header('x-cli-command') ?? '',
      node_version: c.req.header('x-cli-node') ?? '',
      os_platform: c.req.header('x-cli-os') ?? '',
      source: 'config' as const,
      api_version: c.req.header('capgo_api') ?? '',
    }
    // Keep /private/config fast: resolve apikey identity off the response path.
    backgroundTask(c, (async () => {
      const identity = await resolveCliUsageIdentity(c, capgkey)
      await trackCliUsage(c, {
        ...event,
        apikey_id: identity.apikey_id,
        org_id: identity.org_id,
      })
    })())
  }

  return c.json({
    supaHost: existInEnv(c, 'SUPABASE_REPLICATE_URL') ? getEnv(c, 'SUPABASE_REPLICATE_URL') : getEnv(c, 'SUPABASE_URL'),
    supbaseId: getEnv(c, 'SUPABASE_URL')?.split('//')[1]?.split('.')[0]?.split(':')[0] ?? '',
    supaKey: getEnv(c, 'SUPABASE_ANON_KEY'),
    stripeEnabled: isStripeConfigured(c),
    // Deprecated response-shape compatibility for released clients; current UI uses build-time flags.
    minCliVersion: MIN_CLI_VERSION,
    minCliVersionReason: MIN_CLI_VERSION_REASON,
    // finalize_bundle_upload was removed; keep false so released CLIs use the version-update path.
    useNewFinalizeBundleUpload: false,
  })
})

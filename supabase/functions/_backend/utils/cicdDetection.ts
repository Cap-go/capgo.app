import type { Context } from 'hono'
import { cloudlog } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { backgroundTask } from './utils.ts'

/** Sent by @capgo/cli when it runs in CI: the CI name (ci-info), or `ci` when unknown. */
export const CLI_CI_HEADER = 'x-cli-ci'

export type CicdProduct = 'ota' | 'builder'

/** Printable ASCII only, capped like the database column it lands in. */
export function readCliCiProvider(value: string | null | undefined): string | null {
  const provider = value?.trim().slice(0, 64) ?? ''
  return provider && /^[\x20-\x7E]+$/.test(provider) ? provider : null
}

/**
 * Marks the CI/CD onboarding step done for this app the first time a bundle
 * upload or build request comes from CI, or uses a key the CI/CD guide created.
 * Runs after the response; failures only log, they never fail the upload.
 */
export function recordCicdDeploy(
  c: Context,
  input: { appId: unknown, product: CicdProduct, apikeyRbacId?: string | null },
) {
  if (typeof input.appId !== 'string' || !input.appId)
    return
  const appId = input.appId
  const provider = readCliCiProvider(c.req.header(CLI_CI_HEADER))
  // Without CI evidence only a guide key can match, and only API key requests carry one.
  if (!provider && !input.apikeyRbacId)
    return
  return backgroundTask(c, (async () => {
    try {
      const pg = await getPgClient(c)
      try {
        const result = await pg.query<{ recorded: boolean }>(
          'SELECT public.record_app_cicd_deploy($1, $2, $3::uuid, $4) AS recorded',
          [appId, input.product, input.apikeyRbacId ?? null, provider],
        )
        if (result.rows[0]?.recorded)
          cloudlog({ requestId: c.get('requestId'), message: 'cicd_deploy_detected', app_id: appId, product: input.product, provider })
      }
      finally {
        closeClient(c, pg)
      }
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'cicd_deploy_record_failed', app_id: appId, product: input.product, error })
    }
  })())
}

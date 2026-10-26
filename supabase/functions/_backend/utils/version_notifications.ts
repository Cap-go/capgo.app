import type { Context } from 'hono'
import { closeClient, getPgClient } from './pg.ts'

/** Check the exact queued entity, independently of the app's onboarding state. */
export async function shouldSkipVersionNotifications(c: Context, appId: string, versionId: number, deploymentId?: number): Promise<boolean> {
  // Read the primary: replica lag must not make a newly created version look absent.
  const client = await getPgClient(c)
  try {
    // The stable function bypasses Hyperdrive caching without evaluating the unused CTE.
    const { rows } = await client.query<{ skip_notifications: boolean }>(`
      WITH capgo_fresh_read AS (SELECT now())
      SELECT (
        COALESCE(v.deleted, false) OR v.deleted_at IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.onboarding_demo_data demo
          WHERE demo.app_id = v.app_id
            AND demo.relation_name = 'app_versions'
            AND demo.row_key = v.id::text
        )
        OR EXISTS (
          SELECT 1 FROM public.onboarding_demo_data demo
          WHERE demo.app_id = v.app_id
            AND demo.relation_name = 'deploy_history'
            AND demo.row_key = $3::bigint::text
        )
        OR CASE
          WHEN v.storage_provider = 'r2'
            AND v.r2_path IS NULL AND v.external_url IS NULL
            AND v.checksum IS NULL AND v.session_key IS NULL
          THEN COALESCE((
            SELECT bool_and(COALESCE(starts_with(paths.s3_path, 'demo/' || v.app_id || '/'), false))
            FROM (
              SELECT m.s3_path FROM public.manifest m WHERE m.app_version_id = v.id
              UNION ALL
              SELECT entry.s3_path FROM pg_catalog.unnest(v.manifest) entry
            ) paths
          ), false)
          ELSE false
        END
      ) AS skip_notifications
      FROM public.app_versions v
      WHERE v.id = $1 AND v.app_id = $2
        AND ($3::bigint IS NULL OR EXISTS (
          SELECT 1 FROM public.deploy_history deployment
          WHERE deployment.id = $3 AND deployment.app_id = v.app_id
            AND deployment.version_id = v.id
        ))
    `, [versionId, appId, deploymentId ?? null])

    // Demo reset removes both the entity and its provenance. Old queue messages
    // for removed entities must not resurrect milestone notifications.
    return rows[0]?.skip_notifications ?? true
  }
  finally {
    await closeClient(c, client)
  }
}

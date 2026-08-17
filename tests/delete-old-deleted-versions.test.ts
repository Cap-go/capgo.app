import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getCanonicalAppVersionR2Path } from '../supabase/functions/_backend/utils/app_version_r2_path.ts'
import {
  ORG_ID_CRON_QUEUE,
  POSTGRES_URL,
  resetAndSeedAppData,
  resetAppData,
  STRIPE_CUSTOMER_ID_CRON_QUEUE,
} from './test-utils.ts'

const cleanupAppId = `com.deleted.versions.${randomUUID().slice(0, 8)}`

async function rollbackAndRelease(client: PoolClient) {
  try {
    await client.query('ROLLBACK')
  }
  finally {
    client.release()
  }
}

describe('delete_old_deleted_versions', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({
      connectionString: POSTGRES_URL,
      max: 3,
      idleTimeoutMillis: 2000,
    })
    await resetAndSeedAppData(cleanupAppId, {
      orgId: ORG_ID_CRON_QUEUE,
      stripeCustomerId: STRIPE_CUSTOMER_ID_CRON_QUEUE,
    })
  })

  afterAll(async () => {
    await resetAppData(cleanupAppId)
    await pool.end()
  })

  it.concurrent('permanently deletes only versions soft-deleted for at least 90 days', async () => {
    const staleName = `stale-${randomUUID()}`
    const freshName = `fresh-${randomUUID()}`
    const activeName = `active-${randomUUID()}`
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      await client.query(
        `
        INSERT INTO public.app_versions (
          app_id,
          name,
          owner_org,
          deleted,
          deleted_at,
          storage_provider
        )
        VALUES
          ($1, $2, $5, true, pg_catalog.now() - INTERVAL '90 days 1 second', 'r2'),
          ($1, $3, $5, true, pg_catalog.now() - INTERVAL '89 days', 'r2'),
          ($1, $4, $5, false, pg_catalog.now() - INTERVAL '120 days', 'r2')
        `,
        [cleanupAppId, staleName, freshName, activeName, ORG_ID_CRON_QUEUE],
      )

      await client.query('SELECT public.delete_old_deleted_versions()')

      const remaining = await client.query<{ name: string }>(
        `
        SELECT name
        FROM public.app_versions
        WHERE app_id = $1
          AND name = ANY($2::varchar[])
        ORDER BY name
        `,
        [cleanupAppId, [staleName, freshName, activeName]],
      )

      expect(remaining.rows.map(row => row.name)).toEqual([activeName, freshName].sort())
    }
    finally {
      await rollbackAndRelease(client)
    }
  })

  it.concurrent('keeps stale deleted versions until bundle and manifest cleanup is complete', async () => {
    const cleanName = `clean-${randomUUID()}`
    const manifestPendingName = `manifest-pending-${randomUUID()}`
    const bundlePendingName = `bundle-pending-${randomUUID()}`
    const manifestSignalPendingName = `manifest-signal-pending-${randomUUID()}`
    const client = await pool.connect()

    const cleanR2Path = getCanonicalAppVersionR2Path(ORG_ID_CRON_QUEUE, cleanupAppId, cleanName)
    const manifestPendingR2Path = getCanonicalAppVersionR2Path(ORG_ID_CRON_QUEUE, cleanupAppId, manifestPendingName)
    const bundlePendingR2Path = getCanonicalAppVersionR2Path(ORG_ID_CRON_QUEUE, cleanupAppId, bundlePendingName)
    const manifestSignalPendingR2Path = getCanonicalAppVersionR2Path(ORG_ID_CRON_QUEUE, cleanupAppId, manifestSignalPendingName)

    try {
      await client.query('BEGIN')
      const inserted = await client.query<{ id: string, name: string }>(
        `
        INSERT INTO public.app_versions (
          app_id,
          name,
          owner_org,
          deleted,
          deleted_at,
          r2_path,
          storage_provider,
          manifest_count
        )
        VALUES
          ($1, $2, $6, true, pg_catalog.now() - INTERVAL '91 days', $7, 'r2', 0),
          ($1, $3, $6, true, pg_catalog.now() - INTERVAL '91 days', $8, 'r2', 1),
          ($1, $4, $6, true, pg_catalog.now() - INTERVAL '91 days', $9, 'r2', 0),
          ($1, $5, $6, true, pg_catalog.now() - INTERVAL '91 days', $10, 'r2', 1)
        RETURNING id, name
        `,
        [
          cleanupAppId,
          cleanName,
          manifestPendingName,
          bundlePendingName,
          manifestSignalPendingName,
          ORG_ID_CRON_QUEUE,
          cleanR2Path,
          manifestPendingR2Path,
          bundlePendingR2Path,
          manifestSignalPendingR2Path,
        ],
      )
      const ids = Object.fromEntries(inserted.rows.map(row => [row.name, row.id]))

      await client.query(
        `
        INSERT INTO public.app_versions_meta (
          app_id,
          checksum,
          size,
          id,
          owner_org
        )
        VALUES
          ($1, 'clean-checksum', 0, $2, $6),
          ($1, 'manifest-pending-checksum', 0, $3, $6),
          ($1, 'bundle-pending-checksum', 64, $4, $6),
          ($1, 'manifest-signal-pending-checksum', 0, $5, $6)
        `,
        [
          cleanupAppId,
          ids[cleanName],
          ids[manifestPendingName],
          ids[bundlePendingName],
          ids[manifestSignalPendingName],
          ORG_ID_CRON_QUEUE,
        ],
      )

      await client.query(
        `
        INSERT INTO public.manifest (
          app_version_id,
          file_name,
          s3_path,
          file_hash,
          file_size
        )
        VALUES ($1, 'delta.js', 'cleanup/delta.js', 'delta-hash', 12)
        `,
        [ids[manifestPendingName]],
      )

      const signalOnlyManifestRowsBefore = await client.query<{ count: string }>(
        `
        SELECT COUNT(*) AS count
        FROM public.manifest
        WHERE app_version_id = $1
        `,
        [ids[manifestSignalPendingName]],
      )

      await client.query('SELECT public.delete_old_deleted_versions()')

      const remaining = await client.query<{ name: string }>(
        `
        SELECT name
        FROM public.app_versions
        WHERE app_id = $1
          AND name = ANY($2::varchar[])
        ORDER BY name
        `,
        [cleanupAppId, [cleanName, manifestPendingName, bundlePendingName, manifestSignalPendingName]],
      )
      const manifestRows = await client.query<{ count: string }>(
        `
        SELECT COUNT(*) AS count
        FROM public.manifest
        WHERE app_version_id = $1
        `,
        [ids[manifestPendingName]],
      )

      expect(remaining.rows.map(row => row.name)).toEqual([bundlePendingName, manifestPendingName, manifestSignalPendingName].sort())
      expect(manifestRows.rows[0].count).toBe('1')
      expect(signalOnlyManifestRowsBefore.rows[0].count).toBe('0')
    }
    finally {
      await rollbackAndRelease(client)
    }
  })

  it.concurrent('keeps the deleted-version cleanup cron task enabled daily', async () => {
    const result = await pool.query<{
      description: string
      enabled: boolean
      run_at_hour: number
      run_at_minute: number
      run_at_second: number
      target: string
      task_type: string
    }>(
      `
      SELECT
        description,
        enabled,
        run_at_hour,
        run_at_minute,
        run_at_second,
        target,
        task_type::text AS task_type
      FROM public.cron_tasks
      WHERE name = 'delete_old_versions'
      `,
    )

    expect(result.rows).toEqual([{
      description: 'Permanently delete app versions 90 days after soft delete',
      enabled: true,
      run_at_hour: 3,
      run_at_minute: 0,
      run_at_second: 0,
      target: 'public.delete_old_deleted_versions()',
      task_type: 'function',
    }])
  })
})

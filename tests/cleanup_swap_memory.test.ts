import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupPostgresClient, executeSQL } from './test-utils.ts'

describe('swap memory cleanup functions', () => {
  afterAll(async () => {
    await cleanupPostgresClient()
  })


  it('cleanup_queue_messages skips queues whose archive tables are missing', async () => {
    const queueName = `cleanup_missing_${randomUUID().slice(0, 8)}`
    await executeSQL(
      `INSERT INTO pgmq.meta (queue_name, is_partitioned, is_unlogged)
       VALUES ($1, false, false)`,
      [queueName],
    )

    try {
      await expect(executeSQL(`SELECT public.cleanup_queue_messages()`)).resolves.toBeTruthy()
    }
    finally {
      await executeSQL(`DELETE FROM pgmq.meta WHERE queue_name = $1`, [queueName])
    }
  })

  it('cleanup_queue_messages deletes archived rows older than 2 days in batches', async () => {
    const marker = `swap-cleanup-${randomUUID()}`
    const baseMsgId = BigInt(Date.now()) * 1000n

    await executeSQL(
      `INSERT INTO pgmq.a_on_version_update (msg_id, read_ct, enqueued_at, archived_at, vt, message)
       VALUES
         ($1, 0, now() - interval '10 days', now() - interval '10 days', now(), $3::jsonb),
         ($2, 0, now() - interval '1 hour', now() - interval '1 hour', now(), $4::jsonb)`,
      [
        (baseMsgId + 1n).toString(),
        (baseMsgId + 2n).toString(),
        JSON.stringify({ marker, age: 'old' }),
        JSON.stringify({ marker, age: 'fresh' }),
      ],
    )

    await executeSQL(`SELECT public.cleanup_queue_messages()`)

    const rows = await executeSQL(
      `SELECT message->>'age' AS age
       FROM pgmq.a_on_version_update
       WHERE message->>'marker' = $1
       ORDER BY age`,
      [marker],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.age).toBe('fresh')

    await executeSQL(
      `DELETE FROM pgmq.a_on_version_update WHERE message->>'marker' = $1`,
      [marker],
    )
  })

  it('cleanup_net_http_response truncates net._http_response', async () => {
    const id = BigInt(Date.now()) * 1000n + 7n
    await executeSQL(
      `INSERT INTO net._http_response (id, status_code, content, created)
       VALUES ($1, 200, 'swap-cleanup-test', now())`,
      [id.toString()],
    )

    await executeSQL(`SELECT public.cleanup_net_http_response()`)

    const rows = await executeSQL(
      `SELECT count(*)::int AS n FROM net._http_response`,
    )
    expect(rows[0]?.n).toBe(0)
  })

  it('null_migrated_app_version_manifests clears fully migrated dual-storage arrays', async () => {
    const appId = `com.swap.nullmanifest.${randomUUID().slice(0, 8)}`
    const orgRows = await executeSQL(
      `SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`,
    )
    const orgId = orgRows[0]?.id as string
    expect(orgId).toBeTruthy()

    await executeSQL(
      `INSERT INTO public.apps (app_id, name, icon_url, owner_org)
       VALUES ($1, 'swap-null-manifest', '', $2::uuid)`,
      [appId, orgId],
    )

    const versionRows = await executeSQL(
      `INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider, manifest, manifest_count)
       VALUES (
         $1,
         $2,
         $3::uuid,
         'r2',
         ARRAY[ROW('index.html', 'apps/test/index.html', 'abc123')::public.manifest_entry],
         1
       )
       RETURNING id`,
      [appId, `1.0.0-${randomUUID().slice(0, 8)}`, orgId],
    )
    const versionId = versionRows[0]?.id as number
    expect(versionId).toBeTruthy()

    await executeSQL(
      `INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash)
       VALUES ($1, 'index.html', 'apps/test/index.html', 'abc123')`,
      [versionId],
    )

    await executeSQL(`SELECT public.null_migrated_app_version_manifests()`)

    const after = await executeSQL(
      `SELECT manifest IS NULL AS is_null, manifest_count
       FROM public.app_versions
       WHERE id = $1`,
      [versionId],
    )
    expect(after[0]?.is_null).toBe(true)
    expect(after[0]?.manifest_count).toBe(1)

    await executeSQL(`DELETE FROM public.manifest WHERE app_version_id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
  })

  it('audit_log_trigger strips fat app_versions fields', async () => {
    const appId = `com.swap.auditfat.${randomUUID().slice(0, 8)}`
    const orgRows = await executeSQL(
      `SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`,
    )
    const orgId = orgRows[0]?.id as string

    await executeSQL(
      `INSERT INTO public.apps (app_id, name, icon_url, owner_org)
       VALUES ($1, 'swap-audit', '', $2::uuid)`,
      [appId, orgId],
    )

    const versionRows = await executeSQL(
      `INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider, comment)
       VALUES ($1, $2, $3::uuid, 'r2-direct', 'before')
       RETURNING id`,
      [appId, `1.0.0-${randomUUID().slice(0, 8)}`, orgId],
    )
    const versionId = versionRows[0]?.id as number

    await executeSQL(
      `UPDATE public.app_versions
       SET
         comment = 'after',
         manifest = ARRAY[ROW('a.js', 'apps/a.js', 'hash')::public.manifest_entry],
         native_packages = ARRAY['{"name":"cordova-plugin"}'::jsonb]
       WHERE id = $1`,
      [versionId],
    )

    const logs = await executeSQL(
      `SELECT new_record, changed_fields
       FROM public.audit_logs
       WHERE table_name = 'app_versions'
         AND record_id = $1
         AND operation = 'UPDATE'
       ORDER BY id DESC
       LIMIT 1`,
      [String(versionId)],
    )

    expect(logs).toHaveLength(1)
    expect(logs[0]?.new_record?.manifest).toBeUndefined()
    expect(logs[0]?.new_record?.native_packages).toBeUndefined()
    expect(logs[0]?.new_record?.comment).toBe('after')
    expect(logs[0]?.changed_fields).toContain('comment')
    // Fat payloads stay stripped, but field names remain for upload-time history.
    expect(logs[0]?.changed_fields).toContain('manifest')
    expect(logs[0]?.changed_fields).toContain('native_packages')

    await executeSQL(`DELETE FROM public.audit_logs WHERE record_id = $1 AND table_name = 'app_versions'`, [String(versionId)])
    await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
  })

  async function seedAuditAppVersion(appId: string, orgId: string) {
    await executeSQL(
      `INSERT INTO public.apps (app_id, name, icon_url, owner_org)
       VALUES ($1, 'swap-audit-skip', '', $2::uuid)`,
      [appId, orgId],
    )
    const versionRows = await executeSQL(
      `INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider, comment)
       VALUES ($1, $2, $3::uuid, 'r2-direct', 'seed')
       RETURNING id`,
      [appId, `1.0.0-${randomUUID().slice(0, 8)}`, orgId],
    )
    return versionRows[0]?.id as number
  }

  async function clearVersionAudits(versionId: number) {
    await executeSQL(
      `DELETE FROM public.audit_logs
       WHERE table_name = 'app_versions' AND record_id = $1`,
      [String(versionId)],
    )
  }

  it('audit_log_trigger skips dual-storage migrate finalize', async () => {
    const appId = `com.swap.auditskip.${randomUUID().slice(0, 8)}`
    const orgId = (await executeSQL(`SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`))[0]?.id as string
    const versionId = await seedAuditAppVersion(appId, orgId)

    await executeSQL(
      `UPDATE public.app_versions
       SET manifest = ARRAY[ROW('a.js', 'apps/a.js', 'hash')::public.manifest_entry]
       WHERE id = $1`,
      [versionId],
    )
    await clearVersionAudits(versionId)

    await executeSQL(
      `INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash)
       VALUES ($1, 'a.js', 'apps/a.js', 'hash')`,
      [versionId],
    )
    await executeSQL(
      `UPDATE public.app_versions
       SET manifest = NULL, manifest_count = 1, updated_at = now()
       WHERE id = $1`,
      [versionId],
    )

    const logs = await executeSQL(
      `SELECT id FROM public.audit_logs
       WHERE table_name = 'app_versions' AND record_id = $1 AND operation = 'UPDATE'`,
      [String(versionId)],
    )
    expect(logs).toHaveLength(0)

    await executeSQL(`DELETE FROM public.manifest WHERE app_version_id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
  })

  it('audit_log_trigger skips r2_path and storage_provider bookkeeping', async () => {
    const appId = `com.swap.auditpath.${randomUUID().slice(0, 8)}`
    const orgId = (await executeSQL(`SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`))[0]?.id as string
    const versionId = await seedAuditAppVersion(appId, orgId)
    await clearVersionAudits(versionId)

    await executeSQL(
      `UPDATE public.app_versions
       SET r2_path = 'apps/test/bundle.zip', updated_at = now()
       WHERE id = $1`,
      [versionId],
    )
    await executeSQL(
      `UPDATE public.app_versions
       SET storage_provider = 'r2', updated_at = now()
       WHERE id = $1`,
      [versionId],
    )

    const logs = await executeSQL(
      `SELECT id, changed_fields FROM public.audit_logs
       WHERE table_name = 'app_versions' AND record_id = $1 AND operation = 'UPDATE'`,
      [String(versionId)],
    )
    expect(logs).toHaveLength(0)

    await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
  })

  it('audit_log_trigger still records soft-delete', async () => {
    const appId = `com.swap.auditdel.${randomUUID().slice(0, 8)}`
    const orgId = (await executeSQL(`SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`))[0]?.id as string
    const versionId = await seedAuditAppVersion(appId, orgId)
    await clearVersionAudits(versionId)

    await executeSQL(
      `UPDATE public.app_versions
       SET deleted = true, deleted_at = now(), updated_at = now()
       WHERE id = $1`,
      [versionId],
    )

    const logs = await executeSQL(
      `SELECT changed_fields FROM public.audit_logs
       WHERE table_name = 'app_versions' AND record_id = $1 AND operation = 'UPDATE'
       ORDER BY id DESC LIMIT 1`,
      [String(versionId)],
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]?.changed_fields).toContain('deleted')

    await executeSQL(`DELETE FROM public.audit_logs WHERE record_id = $1 AND table_name = 'app_versions'`, [String(versionId)])
    await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
  })

  it('null_migrated_app_version_manifests skips partially migrated arrays, async () => {
    const appId = `com.swap.partialmanifest.${randomUUID().slice(0, 8)}`
    const orgRows = await executeSQL(
      `SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`,
    )
    const orgId = orgRows[0]?.id as string

    await executeSQL(
      `INSERT INTO public.apps (app_id, name, icon_url, owner_org)
       VALUES ($1, 'swap-partial-manifest', '', $2::uuid)`,
      [appId, orgId],
    )

    const versionRows = await executeSQL(
      `INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider, manifest, manifest_count)
       VALUES (
         $1,
         $2,
         $3::uuid,
         'r2',
         ARRAY[
           ROW('index.html', 'apps/test/index.html', 'abc123')::public.manifest_entry,
           ROW('main.js', 'apps/test/main.js', 'def456')::public.manifest_entry
         ],
         2
       )
       RETURNING id`,
      [appId, `1.0.0-${randomUUID().slice(0, 8)}`, orgId],
    )
    const versionId = versionRows[0]?.id as number

    // Only one of two files migrated.
    await executeSQL(
      `INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash)
       VALUES ($1, 'index.html', 'apps/test/index.html', 'abc123')`,
      [versionId],
    )

    await executeSQL(`SELECT public.null_migrated_app_version_manifests()`)

    const after = await executeSQL(
      `SELECT manifest IS NULL AS is_null, cardinality(manifest) AS n
       FROM public.app_versions
       WHERE id = $1`,
      [versionId],
    )
    expect(after[0]?.is_null).toBe(false)
    expect(after[0]?.n).toBe(2)

    await executeSQL(`DELETE FROM public.manifest WHERE app_version_id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
    await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
  })

  it('null_migrated_app_version_manifests works when org requires encryption', async () => {
    const appId = `com.swap.encnull.${randomUUID().slice(0, 8)}`
    const orgRows = await executeSQL(
      `SELECT id FROM public.orgs ORDER BY created_at LIMIT 1`,
    )
    const orgId = orgRows[0]?.id as string

    await executeSQL(
      `INSERT INTO public.apps (app_id, name, icon_url, owner_org)
       VALUES ($1, 'swap-enc-null', '', $2::uuid)`,
      [appId, orgId],
    )

    // Create an unencrypted ready bundle while enforcement is off.
    const versionRows = await executeSQL(
      `INSERT INTO public.app_versions (app_id, name, owner_org, storage_provider, session_key, manifest, manifest_count)
       VALUES (
         $1,
         $2,
         $3::uuid,
         'r2',
         NULL,
         ARRAY[ROW('index.html', 'apps/test/index.html', 'abc123')::public.manifest_entry],
         1
       )
       RETURNING id`,
      [appId, `1.0.0-${randomUUID().slice(0, 8)}`, orgId],
    )
    const versionId = versionRows[0]?.id as number

    await executeSQL(
      `INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash)
       VALUES ($1, 'index.html', 'apps/test/index.html', 'abc123')`,
      [versionId],
    )

    try {
      await executeSQL(
        `UPDATE public.orgs SET enforce_encrypted_bundles = true WHERE id = $1::uuid`,
        [orgId],
      )

      await executeSQL(`SELECT public.null_migrated_app_version_manifests()`)

      const after = await executeSQL(
        `SELECT manifest IS NULL AS is_null FROM public.app_versions WHERE id = $1`,
        [versionId],
      )
      expect(after[0]?.is_null).toBe(true)
    }
    finally {
      await executeSQL(
        `UPDATE public.orgs SET enforce_encrypted_bundles = false WHERE id = $1::uuid`,
        [orgId],
      )
      await executeSQL(`DELETE FROM public.manifest WHERE app_version_id = $1`, [versionId])
      await executeSQL(`DELETE FROM public.app_versions WHERE id = $1`, [versionId])
      await executeSQL(`DELETE FROM public.apps WHERE app_id = $1`, [appId])
    }
  })


  it('app_versions_manifest_present_idx exists as valid partial index on id', async () => {
    const rows = await executeSQL(
      `SELECT
         i.indisvalid,
         pg_get_indexdef(idx.oid) AS indexdef
       FROM pg_catalog.pg_class AS idx
       JOIN pg_catalog.pg_namespace AS ns ON ns.oid = idx.relnamespace
       JOIN pg_catalog.pg_index AS i ON i.indexrelid = idx.oid
       WHERE ns.nspname = 'public'
         AND idx.relname = 'app_versions_manifest_present_idx'
         AND i.indrelid = 'public.app_versions'::regclass`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.indisvalid).toBe(true)
    expect(String(rows[0]?.indexdef)).toContain('(id)')
    expect(String(rows[0]?.indexdef).toLowerCase()).toContain('manifest is not null')
  })


})

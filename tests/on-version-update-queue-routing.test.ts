import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

const pool = new Pool({
  connectionString: POSTGRES_URL,
  max: 1,
  idleTimeoutMillis: 2000,
})

const APP_ID = 'com.demo.app'
const VERSION_NAME = `queue-routing-${randomUUID().slice(0, 8)}`

describe('on_version_update queue routing trigger', () => {
  let versionId: number | null = null
  let ownerOrg: string | null = null

  beforeAll(async () => {
    const app = await pool.query<{ owner_org: string }>(
      'SELECT owner_org FROM public.apps WHERE app_id = $1 LIMIT 1',
      [APP_ID],
    )
    ownerOrg = app.rows[0]?.owner_org ?? null
    expect(ownerOrg).toBeTruthy()

    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO public.app_versions (
        app_id, name, owner_org, storage_provider, r2_path, manifest, manifest_count
      ) VALUES (
        $1, $2, $3, 'r2', $4,
        ARRAY(
          SELECT ROW(e.file_name, e.s3_path, e.file_hash)::public.manifest_entry
          FROM jsonb_to_recordset($5::jsonb) AS e(file_name text, s3_path text, file_hash text)
        ),
        2
      ) RETURNING id`,
      [
        APP_ID,
        VERSION_NAME,
        ownerOrg,
        `orgs/${ownerOrg}/apps/${APP_ID}/${VERSION_NAME}.zip`,
        JSON.stringify([
          { file_name: 'index.html', s3_path: 'a/index.html', file_hash: 'abc' },
          { file_name: 'app.js', s3_path: 'a/app.js', file_hash: 'def' },
        ]),
      ],
    )
    versionId = inserted.rows[0]?.id ?? null
    expect(versionId).toBeTruthy()

    // Drain any messages created by the insert trigger before the update assertion.
    await pool.query('DELETE FROM pgmq.q_on_version_create WHERE message->\'payload\'->\'record\'->>\'name\' = $1', [VERSION_NAME])
    await pool.query('DELETE FROM pgmq.q_on_version_update WHERE message->\'payload\'->\'record\'->>\'name\' = $1', [VERSION_NAME])
  })

  afterAll(async () => {
    if (versionId) {
      await pool.query('DELETE FROM pgmq.q_on_version_update WHERE message->\'payload\'->\'record\'->>\'id\' = $1', [String(versionId)])
      await pool.query('DELETE FROM pgmq.q_on_version_create WHERE message->\'payload\'->\'record\'->>\'id\' = $1', [String(versionId)])
      await pool.query('DELETE FROM public.app_versions WHERE id = $1', [versionId])
    }
    await pool.end()
  })

  it('enqueues cloudflare-routed update messages without inline manifests', async () => {
    expect(versionId).toBeTruthy()

    await pool.query(
      `UPDATE public.app_versions
       SET comment = $2, updated_at = now()
       WHERE id = $1`,
      [versionId, `routing-${Date.now()}`],
    )

    const queued = await pool.query<{ message: {
      function_name: string
      function_type: string
      payload: {
        record: { id: number, name: string, manifest?: unknown }
        old_record: { manifest?: unknown }
      }
    } }>(
      `SELECT message
       FROM pgmq.q_on_version_update
       WHERE message->'payload'->'record'->>'id' = $1
       ORDER BY msg_id DESC
       LIMIT 1`,
      [String(versionId)],
    )

    expect(queued.rows).toHaveLength(1)
    const message = queued.rows[0]!.message
    expect(message.function_name).toBe('on_version_update')
    expect(message.function_type).toBe('cloudflare')
    expect(message.payload.record.name).toBe(VERSION_NAME)
    expect(message.payload.record).not.toHaveProperty('manifest')
    expect(message.payload.old_record).not.toHaveProperty('manifest')
  })
})

import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { executeSQL, getAuthHeaders, getEndpointUrl, ORG_ID, ORG_ID_2 } from './test-utils'

it.concurrent('returns bundle removals and their exact count through the console API', async () => {
  const appId = `com.test.audit.history.${randomUUID().replaceAll('-', '')}`
  const headers = await getAuthHeaders()
  await executeSQL(`
    INSERT INTO public.audit_logs (table_name, record_id, operation, org_id, old_record, changed_fields, created_at)
    VALUES
      ('channels', 'first', 'UPDATE', $1, jsonb_build_object('app_id', $3::text, 'version', 97001), ARRAY['version'], '2026-01-01'),
      ('channels', 'second', 'UPDATE', $1, jsonb_build_object('app_id', $3::text, 'version', 97001), ARRAY['version'], '2026-01-02'),
      ('channels', 'hidden', 'UPDATE', $2, jsonb_build_object('app_id', $3::text, 'version', 97001), ARRAY['version'], '2026-01-03')
  `, [ORG_ID, ORG_ID_2, appId])
  try {
    const query = async (args: { p_ascending?: boolean, p_channel_ids?: string[] } = {}) => {
      const response = await fetch(getEndpointUrl('/private/console/query'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'rpc',
          name: 'get_bundle_channel_removals',
          args: [{ p_app_id: appId, p_version_id: 97001, p_limit: 1, ...args }],
          operations: [],
        }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const [descending, ascending, filtered] = await Promise.all([
      query(),
      query({ p_ascending: true }),
      query({ p_channel_ids: ['first'] }),
    ])
    expect(descending).toMatchObject({ error: null, data: { count: 2, data: [{ record_id: 'second' }] } })
    expect(ascending).toMatchObject({ error: null, data: { count: 2, data: [{ record_id: 'first' }] } })
    expect(filtered).toMatchObject({ error: null, data: { count: 1, data: [{ record_id: 'first' }] } })
  }
  finally {
    await executeSQL('DELETE FROM public.audit_logs WHERE old_record->>\'app_id\' = $1', [appId])
  }
})

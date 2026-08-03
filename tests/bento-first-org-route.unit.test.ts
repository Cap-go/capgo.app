import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'

describe('first-organization lifecycle trigger route', () => {
  it('mounts /on_user_org_access on the Cloudflare trigger router', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/triggers/on_user_org_access', {
      body: JSON.stringify({
        old_record: null,
        record: { id: '33333333-3333-4333-8333-333333333333' },
        schema: 'public',
        table: 'role_bindings',
        type: 'INSERT',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }))

    expect(response.status).not.toBe(404)
  })

  it('registers the same route in the Supabase trigger router', async () => {
    const source = await readFile(new URL('../supabase/functions/triggers/index.ts', import.meta.url), 'utf8')

    expect(source).toContain("appGlobal.route('/on_user_org_access', on_user_org_access)")
  })
})

import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDirectApiKeyWithBindings,
  executeSQL,
  fetchTestRequest,
  getAuthHeaders,
  POSTGRES_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_ID,
  USER_ID_2,
  withAnonymousCapgkey,
} from './test-utils.ts'

const suffix = randomUUID().replaceAll('-', '')
const appId = `com.bundlelist.order.${suffix}`
const seedApp = `${appId}.seed`
const deniedApp = `${appId}.denied`
const org = randomUUID()
const deniedOrg = randomUUID()
const pool = new Pool({ connectionString: POSTGRES_URL, max: 4 })
let key = ''
let keyId: number | undefined
let authHeaders: Record<string, string>

function expectedNames(deleted: boolean, offset = 0) {
  return Array.from({ length: 40 }, (_, i) => i + 1).reverse()
    .filter(i => (i % 5 === 0) === deleted)
    .slice(offset, offset + 5)
    .map(i => `ordered-${String(i).padStart(3, '0')}`)
}

async function page(deleted: boolean, offset = 0, identity: 'key' | 'user' | 'anon' | 'invalid' = 'key', app = appId) {
  const headers: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    ...(identity === 'user' ? authHeaders : {}),
    ...(identity === 'key' ? { capgkey: key } : identity === 'invalid' ? { capgkey: randomUUID() } : {}),
  }
  const response = await fetchTestRequest(`${SUPABASE_BASE_URL}/rest/v1/app_versions?select=*&app_id=eq.${app}&deleted=eq.${deleted}&order=created_at.desc&limit=5&offset=${offset}`, { headers })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  return JSON.parse(body) as Array<{ name: string, app_id: string, deleted: boolean }>
}

beforeAll(async () => {
  for (const [app, orgId, userId] of [[seedApp, org, USER_ID], [deniedApp, deniedOrg, USER_ID_2]]) {
    await executeSQL('SELECT public.reset_and_seed_app_data($1,$2::uuid,$3::uuid,NULL,$4,NULL)', [app, orgId, userId, `cus_bundlelist_${randomUUID().replaceAll('-', '')}`])
  }
  await executeSQL(`INSERT INTO public.apps(app_id,icon_url,user_id,name,owner_org)
    VALUES ($1,'',$2::uuid,'Ordered bundles',$3::uuid)`, [appId, USER_ID, org])
  await executeSQL(`INSERT INTO public.app_versions(app_id,name,owner_org,user_id,created_at,deleted)
    SELECT $1,'ordered-'||lpad(i::text,3,'0'),$2::uuid,$3::uuid,
      TIMESTAMPTZ '2026-01-01' + i * INTERVAL '1 second',i%5=0 FROM generate_series(1,40) i`, [appId, org, USER_ID])
  const apiKey = await createDirectApiKeyWithBindings({ userId: USER_ID, key: randomUUID(), name: `bundlelist-${suffix}`, orgId: org, roleName: 'org_admin' })
  if (!apiKey.key)
    throw new Error('Bundle-list API key was not created')
  key = apiKey.key
  keyId = apiKey.id
  authHeaders = await getAuthHeaders()
})

afterAll(async () => {
  if (keyId != null)
    await executeSQL('DELETE FROM public.apikeys WHERE id=$1', [keyId])
  for (const app of [appId, seedApp, deniedApp])
    await executeSQL('SELECT public.reset_app_data($1)', [app])
  await executeSQL('DELETE FROM public.orgs WHERE id=ANY($1::uuid[])', [[org, deniedOrg]])
  await pool.end()
})

describe('bundle-list filter and chronological paging', () => {
  for (const deleted of [false, true]) {
    for (const offset of [0, 5]) {
      it.concurrent(`pages deleted=${deleted} bundles at offset ${offset} through PostgREST`, async () => {
        const rows = await page(deleted, offset)
        expect(rows.map(row => row.name)).toEqual(expectedNames(deleted, offset))
        expect(rows.every(row => row.app_id === appId && row.deleted === deleted)).toBe(true)
      })
    }
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      it.concurrent(`keeps parameterized deleted=${deleted} reads correct with ${mode}`, async () => {
        const rows = await withAnonymousCapgkey(pool, key, async (client) => {
          await client.query(`SET LOCAL plan_cache_mode=${mode}`)
          return (await client.query({
            name: `bundle_list_${mode}`,
            text: `WITH q AS (SELECT * FROM public.app_versions WHERE app_id=$1 AND deleted=$4 ORDER BY created_at DESC LIMIT $2 OFFSET $3)
              SELECT pg_catalog.to_json(q.*) AS row FROM q`,
            values: [appId, 5, 5, deleted],
          })).rows
        })
        expect(rows.map(row => row.row.name)).toEqual(expectedNames(deleted, 5))
      })
    }
  }

  it.concurrent('preserves authenticated user access', async () => {
    const rows = await page(false, 0, 'user')
    expect(rows.map(row => row.name)).toEqual(expectedNames(false))
  })

  for (const identity of ['anon', 'invalid'] as const) {
    it.concurrent(`keeps ${identity} callers from reading bundles`, async () => {
      expect(await page(false, 0, identity)).toEqual([])
    })
  }

  it.concurrent('keeps a valid API key scoped to its organization', async () => {
    expect(await page(false, 0, 'key', deniedApp)).toEqual([])
  })
})

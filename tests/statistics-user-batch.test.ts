import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, executeSQL, USER_PASSWORD_HASH } from './test-utils.ts'

// /statistics/user batches the reads of every app an API key can see. Its answer must stay the
// same as merging the per-app statistics (what the endpoint computed app by app before), which
// /statistics/app/:app_id still computes for one app at a time.

const DAYS = 10
const testId = randomUUID().slice(0, 8)
const userId = randomUUID()
const email = `stats-user-batch-${testId}@capgo.app`
const orgA = randomUUID() // key bound at org level (org_super_admin)
const orgB = randomUUID() // key bound at org level (org_admin)
const orgC = randomUUID() // key bound to one app only: no org read, per-app metrics path
const apiKey = randomUUID()
const appPrefix = `com.stats.userbatch.${testId}`
const apps = [
  { appId: `${appPrefix}.a1`, orgId: orgA, ageDays: 30 },
  { appId: `${appPrefix}.a2`, orgId: orgA, ageDays: 29 },
  { appId: `${appPrefix}.b1`, orgId: orgB, ageDays: 28 },
  { appId: `${appPrefix}.b2`, orgId: orgB, ageDays: 27 },
  { appId: `${appPrefix}.c1`, orgId: orgC, ageDays: 26 },
  { appId: `${appPrefix}.c2`, orgId: orgC, ageDays: 25 }, // not visible to the key
]
const keyAppIds = apps.filter(app => app.appId !== `${appPrefix}.c2`).map(app => app.appId)

interface StatEntry {
  date: string
  mau: number
  storage: number
  storage_byte_hours: number
  bandwidth: number
  build_time_seconds: number
  get?: number
}

function utcDay(offset: number) {
  const day = new Date()
  day.setUTCHours(0, 0, 0, 0)
  day.setUTCDate(day.getUTCDate() + offset)
  return day.toISOString().slice(0, 10)
}

const from = utcDay(-(DAYS - 1))
const to = utcDay(1)

async function bindKey(rbacId: string, roleName: string, scope: 'org' | 'app', orgId: string, appId?: string) {
  await executeSQL(
    `INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct)
     SELECT 'apikey', $1::uuid, roles.id, $3, $4::uuid,
       (SELECT apps.id FROM public.apps WHERE apps.app_id = $5),
       $6::uuid, 'statistics user batch test', true
     FROM public.roles
     WHERE roles.name = $2 AND roles.scope_type = $3`,
    [rbacId, roleName, scope, orgId, appId ?? null, userId],
  )
}

async function getJson<T>(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
  })
  const body = await response.json() as T
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body
}

// Same merge as the /statistics/user handler: sum every metric per date.
function mergePerApp(perApp: StatEntry[][]) {
  return Array.from(perApp.flat().reduce((acc, curr) => {
    const current = acc.get(curr.date)
    if (current) {
      current.mau += curr.mau
      current.storage += curr.storage
      current.storage_byte_hours += curr.storage_byte_hours
      current.bandwidth += curr.bandwidth
      current.build_time_seconds += curr.build_time_seconds
    }
    else {
      acc.set(curr.date, { ...curr })
    }
    return acc
  }, new Map<string, StatEntry>()).values())
}

describe('[GET] /statistics/user batches per-app reads', () => {
  beforeAll(async () => {
    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       VALUES ($1::uuid, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)`,
      [userId, email, USER_PASSWORD_HASH],
    )
    await executeSQL(
      `INSERT INTO public.users (id, email, first_name, last_name) VALUES ($1::uuid, $2, 'Stats', 'Batch')`,
      [userId, email],
    )
    for (const orgId of [orgA, orgB, orgC]) {
      await executeSQL(
        `INSERT INTO public.orgs (id, name, management_email, created_by) VALUES ($1::uuid, $2, $3, $4::uuid)`,
        [orgId, `Stats user batch ${orgId}`, email, userId],
      )
    }
    for (const app of apps) {
      await executeSQL(
        `INSERT INTO public.apps (app_id, icon_url, name, last_version, owner_org, user_id, created_at, updated_at)
         VALUES ($1, '', $1, '1.0.0', $2::uuid, $3::uuid, NOW() - make_interval(days => $4), NOW())`,
        [app.appId, app.orgId, userId, app.ageDays],
      )
    }

    // Distinct daily values per app, so a value read for the wrong app shows up in the totals.
    for (const [index, app] of apps.entries()) {
      const base = (index + 1) * 1000
      await executeSQL(
        `INSERT INTO public.daily_mau (app_id, date, mau)
         SELECT $1, (CURRENT_DATE - day)::date, $2 + day FROM generate_series(0, $3) AS day`,
        [app.appId, base, DAYS - 2],
      )
      await executeSQL(
        `INSERT INTO public.daily_bandwidth (app_id, date, bandwidth)
         SELECT $1, (CURRENT_DATE - day)::date, ($2 + day) * 1024 FROM generate_series(0, $3) AS day`,
        [app.appId, base, DAYS - 2],
      )
      await executeSQL(
        `INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, storage_byte_hours)
         SELECT $1, $2::uuid, (CURRENT_DATE - day)::date, (CURRENT_DATE - day)::date, ($3 + day) * 24 FROM generate_series(1, $4) AS day`,
        [app.appId, app.orgId, base, DAYS - 2],
      )
      const [version] = await executeSQL<{ id: number }>(
        `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
         VALUES ($1, '1.0.0', $2::uuid, $3::uuid, 'r2') RETURNING id`,
        [app.appId, app.orgId, userId],
      )
      await executeSQL(
        `INSERT INTO public.app_versions_meta (id, app_id, owner_org, checksum, size)
         VALUES ($1, $2, $3::uuid, 'statsbatch', $4)`,
        [version.id, app.appId, app.orgId, base * 1_000_000],
      )
    }

    const [key] = await executeSQL<{ rbac_id: string }>(
      `INSERT INTO public.apikeys (user_id, key, name) VALUES ($1::uuid, $2, 'stats user batch') RETURNING rbac_id`,
      [userId, apiKey],
    )
    await bindKey(key.rbac_id, 'org_super_admin', 'org', orgA)
    await bindKey(key.rbac_id, 'org_admin', 'org', orgB)
    await bindKey(key.rbac_id, 'app_reader', 'app', orgC, `${appPrefix}.c1`)
  }, 120_000)

  afterAll(async () => {
    const orgIds = [orgA, orgB, orgC]
    const appIds = apps.map(app => app.appId)
    await executeSQL('DELETE FROM public.apikeys WHERE key = $1', [apiKey])
    await executeSQL(`DELETE FROM public.role_bindings WHERE principal_type = 'apikey' AND org_id = ANY($1::uuid[])`, [orgIds])
    await executeSQL('DELETE FROM public.app_versions_meta WHERE app_id = ANY($1::varchar[])', [appIds])
    await executeSQL('DELETE FROM public.app_versions WHERE app_id = ANY($1::varchar[])', [appIds])
    for (const table of ['daily_mau', 'daily_bandwidth', 'daily_storage_hourly'])
      await executeSQL(`DELETE FROM public.${table} WHERE app_id = ANY($1::varchar[])`, [appIds])
    await executeSQL('DELETE FROM public.app_metrics_cache WHERE org_id = ANY($1::uuid[])', [orgIds])
    await executeSQL('DELETE FROM public.apps WHERE app_id = ANY($1::varchar[])', [appIds])
    await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [orgIds])
    await executeSQL('DELETE FROM public.users WHERE id = $1::uuid', [userId])
    await executeSQL('DELETE FROM auth.users WHERE id = $1::uuid', [userId])
  }, 120_000)

  it('sees the multi-org app set the key can read', async () => {
    const visible = await executeSQL<{ app_id: string }>(
      `SELECT app_id FROM public.apps WHERE app_id LIKE $1 ORDER BY created_at DESC`,
      [`${appPrefix}.%`],
    )
    expect(visible.map(row => row.app_id)).toHaveLength(apps.length)

    // App-scoped bindings do not grant org read: orgC must take the per-app metrics path.
    const [access] = await executeSQL<{ org_read: boolean }>(
      `SELECT public.rbac_check_permission_direct(public.rbac_perm_org_read(), $1::uuid, $2::uuid, NULL::varchar, NULL::bigint, $3) AS org_read`,
      [userId, orgC, apiKey],
    )
    expect(access.org_read).toBe(false)
  })

  it.each([false, true])('matches the merged per-app statistics (noAccumulate=%s)', async (noAccumulate) => {
    const query = `from=${from}&to=${to}&noAccumulate=${noAccumulate}`
    // Same order as get_accessible_apps_for_apikey_v2 (created_at DESC).
    const orderedAppIds = [...keyAppIds].reverse()

    const batched = await getJson<StatEntry[]>(`/statistics/user?${query}`)
    const perApp = await Promise.all(orderedAppIds.map(appId => getJson<StatEntry[]>(`/statistics/app/${appId}?${query}`)))
    const batchedAgain = await getJson<StatEntry[]>(`/statistics/user?${query}`)

    expect(batched).toHaveLength(DAYS)
    expect(batched).toEqual(batchedAgain)
    expect(batched).toEqual(mergePerApp(perApp))

    // The data is really there, including the app reached only through an app binding.
    const c1 = perApp[orderedAppIds.indexOf(`${appPrefix}.c1`)]
    expect(c1.some(entry => entry.mau > 0)).toBe(true)
    expect(c1.some(entry => entry.bandwidth > 0)).toBe(true)
    expect(batched.some(entry => entry.storage > 0)).toBe(true)
    expect(batched.some(entry => entry.storage_byte_hours > 0)).toBe(true)
  }, 60_000)

  it('rejects a date range over the limit with date_range_too_large', async () => {
    const response = await fetch(`${BASE_URL}/statistics/user?from=2000-01-01&to=2026-01-01`, {
      headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
    })
    const body = await response.json() as { error: string, moreInfo?: { maxDays?: number } }
    expect(response.status).toBe(400)
    expect(body.error).toBe('date_range_too_large')
    expect(body.moreInfo?.maxDays).toBe(400)
  })
})

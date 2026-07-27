import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  getAuthHeaders,
  getSupabaseClient,
  USER_EMAIL,
  USER_ID,
} from './test-utils.ts'

// PostgREST max_rows is 1000. Org dashboards return apps × days; a single-app
// RPC filters in SQL and stays under the limit, so app pages look fine while
// the all-apps org dashboard silently loses later app_ids (and their bandwidth).
const DAYS = 30
const QUIET_APPS = 40 // 40 × 30 = 1200 rows > 1000
const expectedBandwidth = 5_242_880
const orgId = randomUUID()
const testPrefix = `org.bw.page.${randomUUID().slice(0, 8)}`
const quietAppPrefix = `com.${testPrefix}.aaa.`
const busyAppId = `com.${testPrefix}.zzz.busy`

function rangeDates() {
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (DAYS - 1))
  // getDaysBetweenDates(from, to) is exclusive of `to`, so put bandwidth on a
  // day that is inside the generated graph day indexes (not the end date).
  const bandwidthDate = new Date(start)
  bandwidthDate.setUTCDate(bandwidthDate.getUTCDate() + 10)
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    bandwidthDate: bandwidthDate.toISOString().slice(0, 10),
  }
}

async function seedQuietApps(count: number) {
  await executeSQL(
    `
    INSERT INTO public.apps (app_id, icon_url, name, last_version, owner_org, user_id, created_at, updated_at)
    SELECT
      $1 || lpad(i::text, 3, '0'),
      '',
      'Quiet org bandwidth app ' || i::text,
      '1.0.0',
      $2::uuid,
      $3::uuid,
      NOW() - INTERVAL '90 days',
      NOW() - INTERVAL '90 days'
    FROM generate_series(1, $4::integer) AS i
    `,
    [quietAppPrefix, orgId, USER_ID, count],
  )
}

describe('org dashboard bandwidth pagination', () => {
  const { startDate, endDate, bandwidthDate } = rangeDates()

  beforeAll(async () => {
    // created_by bootstraps org_users + org_super_admin role_bindings
    await getSupabaseClient().from('orgs').insert({
      created_by: USER_ID,
      id: orgId,
      management_email: USER_EMAIL,
      name: `Org Bandwidth Pagination ${orgId}`,
      updated_at: new Date().toISOString(),
    }).throwOnError()

    await seedQuietApps(QUIET_APPS)

    await getSupabaseClient().from('apps').insert({
      app_id: busyAppId,
      created_at: new Date().toISOString(),
      icon_url: '',
      last_version: '1.0.0',
      name: 'Busy org bandwidth app',
      owner_org: orgId,
      updated_at: new Date().toISOString(),
      user_id: USER_ID,
    }).throwOnError()

    await getSupabaseClient().from('daily_bandwidth').upsert({
      app_id: busyAppId,
      date: bandwidthDate,
      bandwidth: expectedBandwidth,
    }, {
      onConflict: 'app_id,date',
    }).throwOnError()

    await getSupabaseClient().from('app_metrics_cache').delete().eq('org_id', orgId)
  }, 120_000)

  afterAll(async () => {
    await getSupabaseClient().from('daily_bandwidth').delete().eq('app_id', busyAppId)
    await getSupabaseClient().from('app_metrics_cache').delete().eq('org_id', orgId)
    await executeSQL(`DELETE FROM public.apps WHERE app_id LIKE $1`, [`${quietAppPrefix}%`])
    await getSupabaseClient().from('apps').delete().eq('app_id', busyAppId)
    await getSupabaseClient().from('role_bindings').delete().eq('org_id', orgId)
    await getSupabaseClient().from('org_users').delete().eq('org_id', orgId)
    await getSupabaseClient().from('orgs').delete().eq('id', orgId)
  }, 120_000)

  it('proves unpaginated org metrics drop the late busy app under max_rows', async () => {
    const { data, error } = await getSupabaseClient()
      .rpc('get_app_metrics', {
        org_id: orgId,
        start_date: startDate,
        end_date: endDate,
      })
      .order('app_id', { ascending: true })
      .order('date', { ascending: true })
      .range(0, 999)

    expect(error).toBeNull()
    expect(data?.length).toBe(1000)
    expect(data?.some(row => row.app_id === busyAppId)).toBe(false)

    const { data: appOnly, error: appError } = await getSupabaseClient().rpc('get_app_metrics' as any, {
      p_org_id: orgId,
      p_app_id: busyAppId,
      p_start_date: startDate,
      p_end_date: endDate,
    })

    expect(appError).toBeNull()
    const busyRow = (appOnly as any[])?.find(row => row.app_id === busyAppId && row.date === bandwidthDate)
    expect(busyRow?.bandwidth).toBe(expectedBandwidth)
  }, 60_000)

  it('returns busy-app bandwidth on org dashboard and app dashboard', async () => {
    const authHeaders = await getAuthHeaders()

    const orgRes = await fetch(
      `${BASE_URL}/statistics/org/${orgId}?from=${startDate}&to=${endDate}&breakdown=true&noAccumulate=true`,
      { method: 'GET', headers: authHeaders },
    )
    const orgBody = await orgRes.json() as { global: any[], byApp: any[] }
    expect(orgRes.status, JSON.stringify(orgBody)).toBe(200)

    const orgBandwidth = (orgBody.global ?? []).reduce((sum, row) => sum + Number(row.bandwidth ?? 0), 0)
    expect(orgBandwidth).toBe(expectedBandwidth)
    expect((orgBody.byApp ?? []).some(row =>
      row.app_id === busyAppId && Number(row.bandwidth ?? 0) === expectedBandwidth,
    )).toBe(true)

    const appRes = await fetch(
      `${BASE_URL}/statistics/app/${busyAppId}?from=${startDate}&to=${endDate}&noAccumulate=true`,
      { method: 'GET', headers: authHeaders },
    )
    const appBody = await appRes.json() as any[]
    expect(appRes.status, JSON.stringify(appBody)).toBe(200)
    const appBandwidth = (appBody ?? []).reduce((sum, row) => sum + Number(row.bandwidth ?? 0), 0)
    expect(appBandwidth).toBe(expectedBandwidth)
  }, 120_000)
})

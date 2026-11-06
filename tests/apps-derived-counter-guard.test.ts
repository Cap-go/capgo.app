import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  fetchTestRequest,
  getAuthHeaders,
  getEndpointUrl,
  resetAndSeedAppData,
  resetAppData,
  SUPABASE_ANON_KEY,
  USER_ID,
} from './test-utils.ts'

if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for apps counter guard tests')

const id = randomUUID().replaceAll('-', '').slice(0, 12)
const APPNAME = `com.app.counterguard.${id}`
const INSERT_APP_ID = `${APPNAME}.insert`
const DEVICE_ID = `counter-guard-${id}`
const testOrgId = randomUUID()
const testStripeCustomerId = `cus_counter_guard_${id}`

interface AppCounters {
  channel_device_count: number
  manifest_bundle_count: number
}

async function readCounters(): Promise<AppCounters> {
  const [row] = await executeSQL<{ channel_device_count: string, manifest_bundle_count: string }>(
    'SELECT channel_device_count, manifest_bundle_count FROM public.apps WHERE app_id = $1',
    [APPNAME],
  )
  if (!row)
    throw new Error(`App ${APPNAME} not found`)
  return {
    channel_device_count: Number(row.channel_device_count),
    manifest_bundle_count: Number(row.manifest_bundle_count),
  }
}

function restHeaders(authHeaders: Record<string, string>) {
  return {
    ...authHeaders,
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  }
}

async function parseJson(response: Response) {
  const text = await response.text()
  return text ? JSON.parse(text) as unknown : null
}

async function patchApp(authHeaders: Record<string, string>, body: Record<string, unknown>) {
  const response = await fetchTestRequest(getEndpointUrl(`/rest/v1/apps?app_id=eq.${APPNAME}`), {
    method: 'PATCH',
    headers: restHeaders(authHeaders),
    body: JSON.stringify(body),
  })
  return { response, data: await parseJson(response) }
}

describe('apps derived counter guard', () => {
  let authHeaders: Record<string, string>

  beforeAll(async () => {
    authHeaders = await getAuthHeaders()
    await resetAndSeedAppData(APPNAME, {
      orgId: testOrgId,
      userId: USER_ID,
      stripeCustomerId: testStripeCustomerId,
    })
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.channel_devices WHERE app_id = $1 AND device_id = $2', [APPNAME, DEVICE_ID])
    await executeSQL('DELETE FROM public.apps WHERE app_id = $1', [INSERT_APP_ID])
    await resetAppData(APPNAME)
    await executeSQL('DELETE FROM public.org_users WHERE org_id = $1::uuid', [testOrgId])
    await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [testOrgId])
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [testStripeCustomerId])
  }, 60000)

  it('app admin cannot change channel_device_count or manifest_bundle_count through PostgREST', async () => {
    const before = await readCounters()
    const newName = `Counter guard ${id}`

    const { response, data } = await patchApp(authHeaders, {
      name: newName,
      channel_device_count: before.channel_device_count + 50,
      manifest_bundle_count: before.manifest_bundle_count + 50,
    })

    expect(response.status, JSON.stringify(data)).toBe(200)
    expect(Array.isArray(data) ? data : []).toHaveLength(1)
    const [row] = data as Array<AppCounters & { name: string }>
    expect(row.name).toBe(newName)
    expect(Number(row.channel_device_count)).toBe(before.channel_device_count)
    expect(Number(row.manifest_bundle_count)).toBe(before.manifest_bundle_count)

    expect(await readCounters()).toEqual(before)
  })

  it('app admin cannot seed counters when inserting an app through PostgREST', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/rest/v1/apps'), {
      method: 'POST',
      headers: { ...restHeaders(authHeaders), Prefer: 'return=minimal' },
      body: JSON.stringify({
        app_id: INSERT_APP_ID,
        name: `Counter guard insert ${id}`,
        icon_url: '',
        owner_org: testOrgId,
        user_id: USER_ID,
        channel_device_count: 50,
        manifest_bundle_count: 50,
      }),
    })
    const data = await parseJson(response)

    expect(response.status, JSON.stringify(data)).toBe(201)
    const [row] = await executeSQL<{ channel_device_count: string, manifest_bundle_count: string }>(
      'SELECT channel_device_count, manifest_bundle_count FROM public.apps WHERE app_id = $1',
      [INSERT_APP_ID],
    )
    expect(Number(row?.channel_device_count)).toBe(0)
    expect(Number(row?.manifest_bundle_count)).toBe(0)
  })

  it('channel_device_count still follows channel_devices changes', async () => {
    const before = await readCounters()

    await executeSQL(
      `INSERT INTO public.channel_devices (channel_id, app_id, device_id, owner_org)
       SELECT id, app_id, $2, owner_org
       FROM public.channels
       WHERE app_id = $1
       ORDER BY id
       LIMIT 1`,
      [APPNAME, DEVICE_ID],
    )
    await executeSQL('SELECT public.process_channel_device_counts_queue(1000)')

    expect((await readCounters()).channel_device_count).toBe(before.channel_device_count + 1)
  })
})

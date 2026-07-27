import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_NAME, BASE_URL, fetchTestRequest, getSupabaseClient, headers, resetAndSeedAppData, resetAndSeedAppDataStats, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID()
const APPNAME_DEVICE = `${APP_NAME}.d.${id}`

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME_DEVICE)
  await resetAndSeedAppDataStats(APPNAME_DEVICE)
}, 60_000)
afterAll(async () => {
  await resetAppData(APPNAME_DEVICE)
  await resetAppDataStats(APPNAME_DEVICE)
})

describe.concurrent('[GET] /device operations', () => {
  it.concurrent('all devices', async () => {
    const params = new URLSearchParams({ app_id: APPNAME_DEVICE })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })

    const data = await response.json<{ data: unknown[], nextCursor?: string, hasMore: boolean }>()
    expect(response.status).toBe(200)
    expect(Array.isArray(data.data)).toBe(true)
    expect(typeof data.hasMore).toBe('boolean')
  })

  it.concurrent('specific device', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      device_id: '00000000-0000-0000-0000-000000000000',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })

    const data = await response.json<{ device_id: string }>()
    expect(response.status).toBe(200)
    expect(data.device_id).toBe('00000000-0000-0000-0000-000000000000')
  })

  it.concurrent('invalid app_id', async () => {
    const params = new URLSearchParams({ app_id: 'invalid_app' })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })

  it.concurrent('invalid device_id', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      device_id: 'invalid_device',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    await response.arrayBuffer()
    expect(response.status).toBe(404)
  })
})


describe('[GET] /device updated_at filter and order', () => {
  it('filters devices by updated_at greater than ISO date', async () => {
    const supabase = getSupabaseClient()
    const pastDeviceId = randomUUID().toLowerCase()
    const futureDeviceId = randomUUID().toLowerCase()
    const cutoff = new Date('2026-01-01T00:00:00.000Z')

    const { error: insertError } = await supabase.from('devices').upsert([
      {
        app_id: APPNAME_DEVICE,
        device_id: pastDeviceId,
        platform: 'ios',
        plugin_version: '6.0.0',
        os_version: '17.0',
        version_build: '1.0.0',
        version_name: '1.0.0',
        is_prod: true,
        is_emulator: false,
        updated_at: '2025-06-01T00:00:00.000Z',
      },
      {
        app_id: APPNAME_DEVICE,
        device_id: futureDeviceId,
        platform: 'android',
        plugin_version: '6.0.0',
        os_version: '14',
        version_build: '1.0.0',
        version_name: '1.0.0',
        is_prod: true,
        is_emulator: false,
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ])
    expect(insertError).toBeNull()

    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      updated_at: cutoff.toISOString(),
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    const data = await response.json<{ data: { device_id: string, updated_at: string }[], error?: string }>()
    expect(response.status).toBe(200)
    expect(data.error).toBeUndefined()
    expect(data.data.some(device => device.device_id === futureDeviceId)).toBe(true)
    expect(data.data.some(device => device.device_id === pastDeviceId)).toBe(false)
    expect(data.data.every(device => new Date(device.updated_at).getTime() > cutoff.getTime())).toBe(true)
  })

  it('sorts devices by updated_at desc', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      order: 'desc',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    const data = await response.json<{ data: { updated_at: string }[], error?: string }>()
    expect(response.status).toBe(200)
    expect(data.error).toBeUndefined()
    expect(data.data.length).toBeGreaterThan(1)
    for (let i = 1; i < data.data.length; i++) {
      expect(new Date(data.data[i - 1].updated_at).getTime()).toBeGreaterThanOrEqual(new Date(data.data[i].updated_at).getTime())
    }
  })

  it('rejects invalid updated_at filter', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      updated_at: 'not-a-date',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    const data = await response.json<{ error?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_updated_at')
  })

  it('rejects non-calendar ISO updated_at values', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      updated_at: '2024-02-31T00:00:00.000Z',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    const data = await response.json<{ error?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_updated_at')
  })

  it('rejects invalid order', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      order: 'sideways',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    const data = await response.json<{ error?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_order')
  })

  it('ignores list-only params when fetching a specific device', async () => {
    const params = new URLSearchParams({
      app_id: APPNAME_DEVICE,
      device_id: '00000000-0000-0000-0000-000000000000',
      order: 'sideways',
      updated_at: 'not-a-date',
      limit: '1.5',
    })
    const response = await fetch(`${BASE_URL}/device?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    const data = await response.json<{ device_id?: string, error?: string }>()
    expect(response.status).toBe(200)
    expect(data.device_id).toBe('00000000-0000-0000-0000-000000000000')
  })
})

describe('[POST] /device operations', () => {
  it('link device', async () => {
    const deviceId = randomUUID().toLowerCase()
    const { data: betaChannel, error: betaChannelError } = await getSupabaseClient()
      .from('channels')
      .select('name')
      .eq('app_id', APPNAME_DEVICE)
      .eq('name', 'beta')
      .single()

    expect(betaChannelError).toBeNull()
    expect(betaChannel?.name).toBe('beta')

    let response = await fetch(`${BASE_URL}/device`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME_DEVICE,
        device_id: deviceId,
        channel: 'beta',
      }),
    })

    if (response.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 1100))
      response = await fetchTestRequest(`${BASE_URL}/device`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          app_id: APPNAME_DEVICE,
          device_id: deviceId,
          channel: 'beta',
        }),
      })
    }

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
    // TODO: fix this test
    // // Then, get the device and verify channel is returned
    // const params = new URLSearchParams({
    //   app_id: APPNAME_DEVICE,
    //   device_id: deviceId,
    // })
    // const getResponse = await fetch(`${BASE_URL}/device?${params.toString()}`, {
    //   method: 'GET',
    //   headers,
    // })

    // const data2 = await getResponse.json<{ device_id: string, channel?: string }>()
    // console.log(data2)
    // expect(getResponse.status).toBe(200)
    // expect(data2.device_id).toBe(deviceId)
    // expect(data2.channel).toBe('beta')
  })

  it.concurrent('invalid app_id', async () => {
    const response = await fetch(`${BASE_URL}/device`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'invalid_app',
        device_id: 'test_device',
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })

  it.concurrent('invalid version_id', async () => {
    const response = await fetch(`${BASE_URL}/device`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME_DEVICE,
        device_id: 'test_device',
        version_id: '1.0.0',
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })
})

describe('[DELETE] /device operations', () => {
  it('unlink device', async () => {
    // Use the device ID that was linked in the POST test
    const deviceId = '11111111-1111-1111-1111-111111111111'
    const response = await fetchTestRequest(`${BASE_URL}/device`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        device_id: deviceId,
        app_id: APPNAME_DEVICE,
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })

  it.concurrent('invalid device_id', async () => {
    const response = await fetch(`${BASE_URL}/device`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        device_id: 'invalid_device',
        app_id: APPNAME_DEVICE,
      }),
    })
    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })
})

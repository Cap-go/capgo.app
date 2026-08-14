import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, getSupabaseClient, headers, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.app.c.${id}`

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})
afterEach(async () => {
  await getSupabaseClient()
    .from('channels')
    .update({ update_package: 'all' })
    .eq('app_id', APPNAME)
    .eq('name', 'production')
    .throwOnError()
})
afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
})

describe('[GET] /channel operations', () => {
  it('get channels', async () => {
    const params = new URLSearchParams({ app_id: APPNAME })
    const response = await fetch(`${BASE_URL}/channel?${params.toString()}`, {
      method: 'GET',
      headers,
    })

    const data = await response.json()
    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
  })

  it('get specific channel', async () => {
    const params = new URLSearchParams({ app_id: APPNAME, channel: 'production' })
    const response = await fetch(`${BASE_URL}/channel?${params.toString()}`, {
      method: 'GET',
      headers,
    })

    const data = await response.json<{ name: string }>()
    expect(response.status).toBe(200)
    expect(data.name).toBe('production')
  })

  it('invalid app_id', async () => {
    const params = new URLSearchParams({ app_id: 'invalid_app' })
    const response = await fetch(`${BASE_URL}/channel?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })
})

describe('[POST] /channel operations', () => {
  it('create channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'test_channel',
        public: true,
      }),
    })
    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })

  it('update channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        disableAutoUpdateUnderNative: false,
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })

  it('update channel package mode', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        updatePackage: 'zip',
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')

    const getResponse = await fetch(`${BASE_URL}/channel?${new URLSearchParams({ app_id: APPNAME, channel: 'production' }).toString()}`, {
      method: 'GET',
      headers,
    })
    const channel = await getResponse.json<{ updatePackage: string }>()
    expect(getResponse.status).toBe(200)
    expect(channel.updatePackage).toBe('zip')
  })

  it('invalid app_id', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'invalid_app',
        channel: 'test_channel',
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })
})

describe('[DELETE] /channel operations', () => {
  it('invalid channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        channel: 'invalid_channel',
        app_id: APPNAME,
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })

  it('delete channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        channel: 'production',
        app_id: APPNAME,
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })
})

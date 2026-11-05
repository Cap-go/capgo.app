import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { APP_NAME, getBaseData, getEndpointUrl, getSupabaseClient, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID()
const APP_NAME_KEY_ID = `${APP_NAME}.${id}`
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'
const TOO_LONG_KEY_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' // 26 characters, limit is 20

// [endpoint, extra body fields, key_id sent by a new client]
const endpoints = [
  ['/updates', {}, 'MIIB'],
  ['/stats', { action: 'set' }, 'TEST'],
  ['/channel_self', {}, 'CHAN'],
] as const

beforeAll(async () => {
  await resetAndSeedAppData(APP_NAME_KEY_ID)
})

afterAll(async () => {
  await resetAppData(APP_NAME_KEY_ID)
  await resetAppDataStats(APP_NAME_KEY_ID)
})

function postPlugin(path: string, deviceId: string, extra: Record<string, unknown>) {
  const baseData = getBaseData(APP_NAME_KEY_ID)
  baseData.device_id = deviceId
  return fetch(getEndpointUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...baseData, ...extra }),
  })
}

async function getDeviceKeyId(deviceId: string) {
  const { data } = await getSupabaseClient()
    .from('devices')
    .select('*')
    .eq('app_id', APP_NAME_KEY_ID)
    .eq('device_id', deviceId)
    .maybeSingle() as { data: any }
  return data?.key_id
}

describe.skipIf(USE_CLOUDFLARE)('e2E: plugin endpoints with key_id', () => {
  it.each(endpoints)('%s accepts a request WITHOUT key_id (old client)', async (path, extra) => {
    const deviceId = randomUUID().toLowerCase()
    const response = await postPlugin(path, deviceId, extra)

    expect(response.status).toBe(200)
    expect(await getDeviceKeyId(deviceId)).toBeNull()
  })

  it.each(endpoints)('%s accepts and stores key_id (new client)', async (path, extra, keyId) => {
    const deviceId = randomUUID().toLowerCase()
    const response = await postPlugin(path, deviceId, { ...extra, key_id: keyId })

    expect(response.status).toBe(200)
    expect(await getDeviceKeyId(deviceId)).toBe(keyId)
  })

  it.each(endpoints)('%s rejects key_id longer than 20 characters', async (path, extra) => {
    const response = await postPlugin(path, randomUUID().toLowerCase(), { ...extra, key_id: TOO_LONG_KEY_ID })

    expect(response.status).toBe(400)
  })

  it('/updates updates key_id on key rotation', async () => {
    const deviceId = randomUUID().toLowerCase()
    await postPlugin('/updates', deviceId, { key_id: 'KEY1' })
    await postPlugin('/updates', deviceId, { key_id: 'KEY2' })

    expect(await getDeviceKeyId(deviceId)).toBe('KEY2')
  })

  it.each([
    ['WITHOUT key_id (old client)', undefined],
    ['WITH key_id (new client)', 'GETS'],
  ])('/channel_self accepts a GET request %s', async (_name, keyId) => {
    const baseData = getBaseData(APP_NAME_KEY_ID)
    const params = new URLSearchParams()
    params.append('app_id', baseData.app_id!)
    params.append('platform', baseData.platform!)
    params.append('is_emulator', baseData.is_emulator!.toString())
    params.append('is_prod', baseData.is_prod!.toString())
    if (keyId)
      params.append('key_id', keyId)

    const response = await fetch(`${getEndpointUrl('/channel_self')}?${params}`, {
      method: 'GET',
    })

    expect(response.status).toBe(200)
  })
})

describe.skipIf(!USE_CLOUDFLARE)('e2E: Cloudflare plugin endpoints with key_id', () => {
  it.each(endpoints)('returns %s success without persisting key_id', async (path, extra, keyId) => {
    const deviceId = randomUUID().toLowerCase()
    const response = await postPlugin(path, deviceId, { ...extra, key_id: keyId })

    expect(response.status).toBe(200)
    const { count, error } = await getSupabaseClient()
      .from('devices')
      .select('*', { count: 'exact', head: true })
      .eq('app_id', APP_NAME_KEY_ID)
      .eq('device_id', deviceId)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })
})

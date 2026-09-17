import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  APP_NAME,
  getEndpointUrl,
  getSupabaseClient,
  headers,
  resetAndSeedAppData,
  resetAppData,
  resetAppDataStats,
} from './test-utils.ts'

const id = randomUUID()
const APP_NAME_CLI = `${APP_NAME}.${id}`

describe('device_data_collection via PUT /app (CLI app set)', () => {
  const supabase = getSupabaseClient()

  beforeAll(async () => {
    await resetAndSeedAppData(APP_NAME_CLI)
  })

  afterAll(async () => {
    await resetAppData(APP_NAME_CLI)
    await resetAppDataStats(APP_NAME_CLI)
  })

  it('disables one field without resetting the others', async () => {
    await supabase
      .from('apps')
      .update({
        device_data_collection: {
          country: true,
          platform: false,
          os_version: true,
          plugin_version: true,
          version_build: true,
          is_emulator: true,
          is_prod: true,
          install_source: true,
        },
      })
      .eq('app_id', APP_NAME_CLI)

    const response = await fetch(`${getEndpointUrl('/app')}/${APP_NAME_CLI}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        device_data_collection: { country: false },
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { device_data_collection: Record<string, boolean> }
    expect(data.device_data_collection).toMatchObject({
      country: false,
      platform: false,
      plugin_version: true,
    })
  })

  it('lets GET read the stored collection flags', async () => {
    const response = await fetch(`${getEndpointUrl('/app')}/${APP_NAME_CLI}`, {
      method: 'GET',
      headers,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { device_data_collection?: Record<string, boolean> }
    expect(data.device_data_collection).toEqual(expect.objectContaining({
      country: expect.any(Boolean),
      platform: expect.any(Boolean),
    }))
  })
})

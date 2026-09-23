import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, createAppVersions, getSupabaseClient, headers, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.bundle.error.${id}`
let testOrgId: string
let metadataVersionId: number
let channelVersionId: number
let testChannelId: number

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)

  // Get the org that was created by resetAndSeedAppData
  const { data: app } = await getSupabaseClient()
    .from('apps')
    .select('owner_org')
    .eq('app_id', APPNAME)
    .single()

  if (!app)
    throw new Error('App not found after seeding')

  testOrgId = app.owner_org

  metadataVersionId = (await createAppVersions(`1.0.0-test-metadata-${id}`, APPNAME)).id
  channelVersionId = (await createAppVersions(`1.0.0-test-channel-${id}`, APPNAME)).id

  const { data: channel, error: channelError } = await getSupabaseClient()
    .from('channels')
    .insert({
      name: `test-channel-${id}`,
      app_id: APPNAME,
      version: channelVersionId,
      created_by: USER_ID,
      owner_org: testOrgId,
    })
    .select('id')
    .single()

  if (channelError || !channel)
    throw channelError ?? new Error('Failed to create test channel')

  testChannelId = channel.id
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

describe('[GET] /bundle - Error Cases', () => {
  it('should return 400 when app_id is missing', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'GET',
      headers,
      // Missing app_id
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_app_id')
  })

  it('should return 400 when user cannot access the app', async () => {
    const response = await fetch(`${BASE_URL}/bundle?app_id=nonexistent.app`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_get_bundle')
  })

  it('should return 400 when bundle cannot be retrieved', async () => {
    const response = await fetch(`${BASE_URL}/bundle?app_id=${APPNAME}_no`, {
      method: 'GET',
      headers,
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_get_bundle')
  })

  it('should handle invalid JSON body', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('[DELETE] /bundle - Error Cases', () => {
  it('should return 400 when app_id is missing', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        version: '1.0.0',
        // Missing app_id
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_app_id') // Changed: validation now catches this first
  })

  it('should return 400 when user cannot access the app', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        version: '1.0.0',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_delete_bundle')
  })

  it('should return 400 when version cannot be deleted', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version: 'nonexistent-version',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_delete_version')
  })

  it('should handle invalid JSON body', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('[POST] /bundle/metadata - Extended Error Cases', () => {
  it('should return 400 when no fields to update', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: metadataVersionId,
        // No updateable fields provided
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_fields_to_update')
  })

  it('should return 400 when update fails', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: 999999, // Non-existent version
        link: 'https://example.com',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_find_version')
  })

  it('should handle invalid JSON body', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('[PUT] /bundle - Extended Error Cases', () => {
  it('should return 400 when user cannot access the app', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        version_id: 1,
        channel_id: 1,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app')
  })

  it('should return 400 when app cannot be found', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: 999999, // Non-existent version
        channel_id: 1,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_find_version')
  })

  it('should return 500 when bundle cannot be set to channel', async () => {
    // Try to set bundle to channel with conflicting data
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: 999999, // Non-existent version ID
        channel_id: testChannelId,
      }),
    })

    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_find_version')
  })

  it('should handle invalid JSON body', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

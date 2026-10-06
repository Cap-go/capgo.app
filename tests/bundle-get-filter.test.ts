import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  createAppVersions,
  createDirectApiKeyWithBindings,
  getSupabaseClient,
  headers,
  ORG_ID_2,
  resetAndSeedAppData,
  resetAppData,
  USER_ID_2,
} from './test-utils.ts'

const fixtureId = randomUUID()
const APP_A = `com.test.bundle.lookup.a.${fixtureId}`
const APP_B = `com.test.bundle.lookup.b.${fixtureId}`
const VERSION_NAME = `9.8.7-lookup-${fixtureId}`

let versionIdOnA: number
let deniedHeaders: Record<string, string>
let deniedKeyId: number

async function getBundles(query: Record<string, string>, requestHeaders = headers) {
  const params = new URLSearchParams(query)
  const response = await fetch(`${BASE_URL}/bundle?${params.toString()}`, {
    method: 'GET',
    headers: requestHeaders,
  })
  const data = await response.json()
  return { response, data }
}

beforeAll(async () => {
  await resetAndSeedAppData(APP_A)
  await resetAndSeedAppData(APP_B)

  const version = await createAppVersions(VERSION_NAME, APP_A)
  versionIdOnA = version.id

  const deniedKey = await createDirectApiKeyWithBindings({
    userId: USER_ID_2,
    key: randomUUID(),
    name: `bundle-lookup-denied-${fixtureId}`,
    orgId: ORG_ID_2,
    roleName: 'org_admin',
  })
  if (!deniedKey.key)
    throw new Error('Failed to create denied API key')

  deniedKeyId = deniedKey.id
  deniedHeaders = {
    'Content-Type': 'application/json',
    capgkey: deniedKey.key,
  }
})

afterAll(async () => {
  await resetAppData(APP_A)
  await resetAppData(APP_B)
  if (deniedKeyId)
    await getSupabaseClient().from('apikeys').delete().eq('id', deniedKeyId)
})

describe('[GET] /bundle version and id filters', () => {
  it.concurrent('returns one bundle when version exists on the app', async () => {
    const { response, data } = await getBundles({ app_id: APP_A, version: VERSION_NAME })
    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect((data as { id: number, name: string }[])[0].id).toBe(versionIdOnA)
    expect((data as { name: string }[])[0].name).toBe(VERSION_NAME)
  })

  it.concurrent('returns empty array when version does not exist', async () => {
    const { response, data } = await getBundles({
      app_id: APP_A,
      version: `missing-${fixtureId}`,
    })
    expect(response.status).toBe(200)
    expect(data).toEqual([])
  })

  it.concurrent('returns empty array when version exists on another app', async () => {
    const { response, data } = await getBundles({ app_id: APP_B, version: VERSION_NAME })
    expect(response.status).toBe(200)
    expect(data).toEqual([])
  })

  it.concurrent('returns one bundle when id exists on the app', async () => {
    const { response, data } = await getBundles({
      app_id: APP_A,
      id: String(versionIdOnA),
    })
    expect(response.status).toBe(200)
    expect(data).toHaveLength(1)
    expect((data as { id: number }[])[0].id).toBe(versionIdOnA)
  })

  it.concurrent('rejects API key without access to the app', async () => {
    const { response, data } = await getBundles({ app_id: APP_A, version: VERSION_NAME }, deniedHeaders)
    expect(response.status).toBe(400)
    expect((data as { error: string }).error).toBe('cannot_get_bundle')
  })

  it.concurrent('keeps unpaginated list paging behavior unchanged', async () => {
    const { response, data } = await getBundles({ app_id: APP_A, page: '99' })
    expect(response.status).toBe(200)
    expect(data).toEqual([])
  })
})

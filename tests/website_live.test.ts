import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchTestRequest, getSupabaseClient, PLUGIN_BASE_URL, resetAndSeedAppData, resetAppData } from './test-utils.ts'

const id = randomUUID()
const CLASSIC_APP = `com.wl.classic.${id}`
const WEBSITE_APP = `com.wl.website.${id}`
const WEBSITE_URL = 'https://app.example.com/'

function fetchWebsiteLive(appId: string) {
  const url = new URL(`${PLUGIN_BASE_URL}/website_live`)
  url.searchParams.set('app_id', appId)
  return fetchTestRequest(url.toString(), { method: 'GET' })
}

beforeAll(async () => {
  await Promise.all([resetAndSeedAppData(CLASSIC_APP), resetAndSeedAppData(WEBSITE_APP)])
  const { error } = await getSupabaseClient()
    .from('apps')
    .update({ update_mode: 'website', website_url: WEBSITE_URL })
    .eq('app_id', WEBSITE_APP)
  if (error)
    throw error
})

afterAll(async () => {
  await Promise.all([resetAppData(CLASSIC_APP), resetAppData(WEBSITE_APP)])
})

describe('[GET] /website_live', () => {
  it('allows a Website Live app and returns its website', async () => {
    const response = await fetchWebsiteLive(WEBSITE_APP)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('s-maxage=')
    await expect(response.json()).resolves.toEqual({
      allowed: true,
      mode: 'website',
      website_url: WEBSITE_URL,
      check_interval_seconds: 600,
    })
  })

  it('sends classic apps back to the full Capgo flow', async () => {
    const response = await fetchWebsiteLive(CLASSIC_APP)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ allowed: false, mode: 'capgo', reason: 'full_capgo' })
  })

  it('answers unknown apps like classic apps', async () => {
    const response = await fetchWebsiteLive(`com.wl.unknown.${id}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ allowed: false, mode: 'capgo', reason: 'full_capgo' })
  })

  it('rejects an invalid app id', async () => {
    const response = await fetchWebsiteLive('not an app id')
    expect(response.status).toBe(400)
  })
})

describe('apps website mode constraints', () => {
  it('requires a website URL in website mode', async () => {
    const { error } = await getSupabaseClient()
      .from('apps')
      .update({ update_mode: 'website', website_url: null })
      .eq('app_id', CLASSIC_APP)
    expect(error?.code).toBe('23514')
  })

  it('rejects non https website URLs', async () => {
    const { error } = await getSupabaseClient()
      .from('apps')
      .update({ website_url: 'http://app.example.com' })
      .eq('app_id', CLASSIC_APP)
    expect(error?.code).toBe('23514')
  })
})

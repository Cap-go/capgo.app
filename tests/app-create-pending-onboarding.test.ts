import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ALL,
  BASE_URL,
  getSupabaseClient,
  ORG_ID,
  resetAppData,
  USER_ID,
} from './test-utils.ts'

const USE_CLOUDFLARE = process.env.USE_CLOUDFLARE_WORKERS === 'true'
// Cloudflare workers can resolve freshly created API keys against a lagging replica.
// This coverage targets the Supabase edge create/complete path used by the CLI.
const describeBackend = describe.skipIf(USE_CLOUDFLARE)

describeBackend('app create with leftover pending onboarding app', () => {
  const pendingAppId = `com.test.pending.onboarding.${randomUUID()}`
  const newAppId = `com.test.create.with.pending.${randomUUID()}`

  afterAll(async () => {
    await resetAppData(pendingAppId)
    await resetAppData(newAppId)
  })

  it('allows API keys to create a new app while a pending onboarding app exists', async () => {
    const supabase = getSupabaseClient()

    const { error: pendingError } = await supabase.from('apps').insert({
      app_id: pendingAppId,
      name: 'Pending onboarding leftover',
      icon_url: '',
      owner_org: ORG_ID,
      user_id: USER_ID,
      need_onboarding: true,
      created_from_onboarding: true,
    })
    expect(pendingError, JSON.stringify(pendingError)).toBeNull()

    const createResponse = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        owner_org: ORG_ID,
        app_id: newAppId,
        name: `App ${newAppId}`,
        icon: '',
        need_onboarding: false,
        created_from_onboarding: true,
      }),
    })
    const createBody = await createResponse.json().catch(() => null)
    expect(createResponse.status, JSON.stringify(createBody)).toBe(200)
    expect((createBody as { app_id?: string }).app_id).toBe(newAppId)

    const completeResponse = await fetch(`${BASE_URL}/app/${pendingAppId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        need_onboarding: false,
      }),
    })
    const completeBody = await completeResponse.json().catch(() => null)
    expect(completeResponse.status, JSON.stringify(completeBody)).toBe(200)
    expect((completeBody as { need_onboarding?: boolean }).need_onboarding).toBe(false)
  })
})

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BASE_URL, fetchTestRequest, getAuthHeaders, ORG_ID } from './test-utils.ts'

describe('private/stripe_past_due', () => {
  it.concurrent('returns the past-due state for a billing member', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/stripe_past_due`, {
      method: 'POST',
      headers: await getAuthHeaders(),
      body: JSON.stringify({ orgId: ORG_ID }),
    })
    const data = await response.json() as { past_due?: unknown, invoice?: unknown }
    expect(response.status, JSON.stringify(data)).toBe(200)
    expect(typeof data.past_due).toBe('boolean')
    expect(Object.keys(data).sort()).toEqual(['invoice', 'past_due'])
  })

  it.concurrent('rejects orgs the caller is not a member of', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/stripe_past_due`, {
      method: 'POST',
      headers: await getAuthHeaders(),
      body: JSON.stringify({ orgId: randomUUID() }),
    })
    const data = await response.json() as { error?: string }
    expect(response.ok).toBe(false)
    expect(data.error).toBe('not_authorized')
  })

  it.concurrent('rejects a missing orgId', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/stripe_past_due`, {
      method: 'POST',
      headers: await getAuthHeaders(),
      body: JSON.stringify({}),
    })
    const data = await response.json() as { error?: string }
    expect(response.ok).toBe(false)
    expect(data.error).toBe('invalid_body')
  })
})

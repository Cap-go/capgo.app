import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BASE_URL, fetchTestRequest, getAuthHeaders, ORG_ID } from './test-utils.ts'

async function postPastDue(body: Record<string, unknown>) {
  const response = await fetchTestRequest(`${BASE_URL}/private/stripe_past_due`, {
    method: 'POST',
    headers: await getAuthHeaders(),
    body: JSON.stringify(body),
  })
  return { response, data: await response.json() as { past_due?: unknown, invoice?: unknown, error?: string } }
}

describe('private/stripe_past_due', () => {
  it.concurrent('returns the past-due state for a billing member', async () => {
    const { response, data } = await postPastDue({ orgId: ORG_ID })
    expect(response.status, JSON.stringify(data)).toBe(200)
    expect(typeof data.past_due).toBe('boolean')
    expect(Object.keys(data).sort()).toEqual(['invoice', 'past_due'])
  })

  it.concurrent.each([
    ['orgs the caller is not a member of', { orgId: randomUUID() }, 'not_authorized'],
    ['a missing orgId', {}, 'invalid_body'],
  ])('rejects %s', async (_label, body, error) => {
    const { response, data } = await postPastDue(body)
    expect(response.ok).toBe(false)
    expect(data.error).toBe(error)
  })
})

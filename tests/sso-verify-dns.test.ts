import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fetchTestRequest, getAuthHeaders, getEndpointUrl } from './test-utils.ts'

let authHeaders: Record<string, string>

beforeAll(async () => {
  authHeaders = await getAuthHeaders()
})

describe('[POST] /private/sso/verify-dns', () => {
  it('should return 404 for non-existent provider', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/sso/verify-dns'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ provider_id: randomUUID() }),
    })

    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('provider_not_found')
  })

  it('should return 401 without authentication', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/sso/verify-dns'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider_id: randomUUID() }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })
})

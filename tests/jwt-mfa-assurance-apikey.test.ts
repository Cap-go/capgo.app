import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  orgApiKeyBindings,
  ORG_ID_JWT_MFA_EDGE,
  USER_EMAIL_JWT_MFA_EDGE,
  USER_PASSWORD,
} from './test-utils.ts'

describe('JWT MFA assurance on /apikey create', () => {
  it('rejects MFA-enrolled users with password-only aal1 sessions', async () => {
    const headers = await getAuthHeadersForCredentials(USER_EMAIL_JWT_MFA_EDGE, USER_PASSWORD)
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `mfa-blocked-${randomUUID()}`,
        bindings: orgApiKeyBindings(ORG_ID_JWT_MFA_EDGE, 'org_admin'),
      }),
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(403)
    expect(data.error).toBe('mfa_required')
  })

  it('allows users without MFA at aal1', async () => {
    const headers = await getAuthHeaders()
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `no-mfa-${randomUUID()}`,
        bindings: orgApiKeyBindings(),
      }),
    })

    const data = await response.json() as { id?: number }
    expect(response.status).toBe(200)
    expect(typeof data.id).toBe('number')

    if (data.id) {
      await executeSQL(`DELETE FROM public.apikeys WHERE id = $1`, [data.id])
    }
  })
})

import { beforeAll, describe, expect, it } from 'vitest'
import type { AdminSecurityUpdatesTrackingResponse } from '../supabase/functions/_backend/utils/security_advisory_admin_tracking.ts'
import {
  fetchTestRequest,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getEndpointUrl,
  USER_ADMIN_EMAIL,
} from './test-utils.ts'

describe('[GET] /private/admin_security_updates/tracking', () => {
  let adminHeaders: Record<string, string>

  beforeAll(async () => {
    adminHeaders = await getAuthHeadersForCredentials(USER_ADMIN_EMAIL, 'adminadmin')
  })

  it.concurrent('rejects unauthenticated requests', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/admin_security_updates/tracking'), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(401)
  })

  it.concurrent('rejects non-platform-admin users', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/admin_security_updates/tracking'), {
      method: 'GET',
      headers: await getAuthHeaders(),
    })
    expect(response.status).toBe(403)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('not_admin')
  })

  it('returns tracking payload for platform admins', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/admin_security_updates/tracking'), {
      method: 'GET',
      headers: adminHeaders,
    })
    if (response.status !== 200) {
      const errBody = await response.text()
      throw new Error(`Expected 200, got ${response.status}: ${errBody}`)
    }
    const data = await response.json() as AdminSecurityUpdatesTrackingResponse
    expect(Array.isArray(data.patches)).toBe(true)
    expect(data.patches.length).toBeGreaterThan(0)
    expect(typeof data.opt_in.users_opted_in).toBe('number')
    expect(Array.isArray(data.advisories)).toBe(true)
    expect(data.advisories[0]?.email).toBeTruthy()
    expect(data.advisories[0]?.adoption).toBeTruthy()
    expect(data.adoption_scope.method).toBe('bundle_reported_packages')
    expect(data.adoption_scope.apps_total).toBeGreaterThan(0)
    expect(typeof data.adoption_scope.note).toBe('string')
    expect(typeof data.advisories[0]?.adoption.apps_relevant).toBe('number')
  })
})

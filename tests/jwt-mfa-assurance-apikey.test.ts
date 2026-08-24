import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  ORG_ID_JWT_MFA_EDGE,
  orgApiKeyBindings,
  USER_EMAIL_JWT_MFA_EDGE,
  USER_ID_JWT_MFA_EDGE,
  USER_PASSWORD,
} from './test-utils.ts'

const MFA_EDGE_FACTOR_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

async function enrollVerifiedMfaFactor() {
  await executeSQL(
    `
    INSERT INTO auth.mfa_factors (
      id,
      user_id,
      friendly_name,
      factor_type,
      status,
      created_at,
      updated_at
    )
    VALUES (
      $1::uuid,
      $2::uuid,
      'JWT MFA Edge Test TOTP',
      'totp'::auth.factor_type,
      'verified'::auth.factor_status,
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
    `,
    [MFA_EDGE_FACTOR_ID, USER_ID_JWT_MFA_EDGE],
  )
}

async function cleanupVerifiedMfaFactor() {
  await executeSQL(`DELETE FROM auth.mfa_factors WHERE user_id = $1::uuid`, [USER_ID_JWT_MFA_EDGE])
}

async function deleteApiKeyById(id: number | undefined) {
  if (typeof id !== 'number') {
    return
  }

  try {
    await executeSQL(`DELETE FROM public.apikeys WHERE id = $1`, [id])
  }
  catch (error) {
    console.error(`Failed to delete test API key ${id}:`, error)
  }
}

afterEach(async () => {
  await cleanupVerifiedMfaFactor()
})

describe('jwt MFA assurance on /apikey create', () => {
  it('rejects MFA-enrolled users with password-only aal1 sessions', async () => {
    const headers = await getAuthHeadersForCredentials(USER_EMAIL_JWT_MFA_EDGE, USER_PASSWORD)
    await enrollVerifiedMfaFactor()
    let createdKeyId: number | undefined

    try {
      const response = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `mfa-blocked-${randomUUID()}`,
          bindings: orgApiKeyBindings(ORG_ID_JWT_MFA_EDGE, 'org_admin'),
        }),
      })

      const data = await response.json() as { error?: string, id?: number }
      createdKeyId = data.id
      expect(response.status).toBe(403)
      expect(data.error).toBe('mfa_required')
    }
    finally {
      await deleteApiKeyById(createdKeyId)
    }
  })

  it('allows users without MFA at aal1', async () => {
    const headers = await getAuthHeaders()
    let createdKeyId: number | undefined

    try {
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
      createdKeyId = data.id
    }
    finally {
      await deleteApiKeyById(createdKeyId)
    }
  })
})

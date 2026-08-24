import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  orgApiKeyBindings,
} from './test-utils.ts'

const MFA_EDGE_USER_ID = 'f8e7d6c5-b4a3-4291-8f7e-6d5c4b3a2910'
const MFA_EDGE_ORG_ID = 'a9b8c7d6-e5f4-4321-9876-543210fedcba'
const MFA_EDGE_EMAIL = 'jwt-mfa-edge-apikey@test.local'
const MFA_EDGE_PASSWORD = 'testtest'
const PASSWORD_HASH = '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi'

async function setupMfaEdgeUser() {
  await executeSQL(
    `
    INSERT INTO auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      created_at,
      updated_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change
    )
    VALUES (
      $1::uuid,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      $2,
      $3,
      NOW(),
      NOW(),
      NOW(),
      '',
      '',
      '',
      ''
    )
    ON CONFLICT (id) DO NOTHING
    `,
    [MFA_EDGE_USER_ID, MFA_EDGE_EMAIL, PASSWORD_HASH],
  )

  await executeSQL(
    `
    INSERT INTO public.orgs (id, owner, created_at, updated_at, name, email)
    VALUES ($1::uuid, $2::uuid, NOW(), NOW(), 'JWT MFA Edge Test Org', $3)
    ON CONFLICT (id) DO NOTHING
    `,
    [MFA_EDGE_ORG_ID, MFA_EDGE_USER_ID, MFA_EDGE_EMAIL],
  )

  await executeSQL(
    `
    INSERT INTO public.org_users (org_id, user_id, role, created_at, updated_at)
    VALUES ($1::uuid, $2::uuid, public.rbac_role_org_super_admin(), NOW(), NOW())
    ON CONFLICT DO NOTHING
    `,
    [MFA_EDGE_ORG_ID, MFA_EDGE_USER_ID],
  )

  await executeSQL(
    `
    INSERT INTO public.role_bindings (
      org_id,
      principal_id,
      principal_type,
      role_id,
      scope_type
    )
    SELECT
      $1::uuid,
      $2::uuid,
      public.rbac_principal_user(),
      r.id,
      public.rbac_scope_org()
    FROM public.roles r
    WHERE r.name = public.rbac_role_org_super_admin()
    ON CONFLICT DO NOTHING
    `,
    [MFA_EDGE_ORG_ID, MFA_EDGE_USER_ID],
  )

  await executeSQL(
    `
    DELETE FROM auth.mfa_factors
    WHERE user_id = $1::uuid
    `,
    [MFA_EDGE_USER_ID],
  )

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
      'Edge MFA Test TOTP',
      'totp'::auth.factor_type,
      'verified'::auth.factor_status,
      NOW(),
      NOW()
    )
    `,
    [randomUUID(), MFA_EDGE_USER_ID],
  )
}

async function cleanupMfaEdgeUser() {
  await executeSQL(`DELETE FROM public.apikeys WHERE user_id = $1::uuid`, [MFA_EDGE_USER_ID])
  await executeSQL(`DELETE FROM public.role_bindings WHERE principal_id = $1::uuid`, [MFA_EDGE_USER_ID])
  await executeSQL(`DELETE FROM public.org_users WHERE user_id = $1::uuid`, [MFA_EDGE_USER_ID])
  await executeSQL(`DELETE FROM public.orgs WHERE id = $1::uuid`, [MFA_EDGE_ORG_ID])
  await executeSQL(`DELETE FROM auth.mfa_factors WHERE user_id = $1::uuid`, [MFA_EDGE_USER_ID])
  await executeSQL(`DELETE FROM auth.users WHERE id = $1::uuid`, [MFA_EDGE_USER_ID])
}

beforeAll(async () => {
  await setupMfaEdgeUser()
})

afterAll(async () => {
  await cleanupMfaEdgeUser()
})

describe('JWT MFA assurance on /apikey create', () => {
  it('rejects MFA-enrolled users with password-only aal1 sessions', async () => {
    const headers = await getAuthHeadersForCredentials(MFA_EDGE_EMAIL, MFA_EDGE_PASSWORD)
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `mfa-blocked-${randomUUID()}`,
        bindings: orgApiKeyBindings(MFA_EDGE_ORG_ID, 'org_admin'),
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

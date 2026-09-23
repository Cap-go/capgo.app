import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getEndpointUrl, getSupabaseClient } from './test-utils.ts'

const createdUserIds: string[] = []

afterAll(async () => {
  const admin = getSupabaseClient()
  await Promise.allSettled(createdUserIds.map(id => admin.auth.admin.deleteUser(id)))
})

function buildRegisterPayload(overrides: Record<string, unknown> = {}) {
  const id = randomUUID()
  return {
    email: `auth-register-${id}@example.com`,
    password: 'Password123!',
    first_name: 'Jane',
    last_name: 'Doe',
    registration_device_type: 'desktop',
    registration_os: 'macOS',
    registration_browser: 'Safari',
    ...overrides,
  }
}

async function postRegister(body: Record<string, unknown>) {
  return fetch(getEndpointUrl('/auth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /auth/register', () => {
  it('creates a user and returns session tokens', async () => {
    const payload = buildRegisterPayload()
    const response = await postRegister(payload)
    expect(response.status).toBe(200)

    const body = await response.json() as {
      user: { id: string }
      session: { access_token: string, refresh_token: string }
    }
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(body.session.access_token).toBeTruthy()
    expect(body.session.refresh_token).toBeTruthy()
    createdUserIds.push(body.user.id)

    const admin = getSupabaseClient()
    const { data: profile, error: profileError } = await admin
      .from('users')
      .select('email, first_name, last_name')
      .eq('id', body.user.id)
      .single()
    expect(profileError).toBeNull()
    expect(profile).toEqual({
      email: payload.email,
      first_name: payload.first_name,
      last_name: payload.last_name,
    })

    const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(body.user.id)
    expect(authUserError).toBeNull()
    expect(authUser.user?.user_metadata).toMatchObject({
      first_name: payload.first_name,
      last_name: payload.last_name,
      registration_device_type: payload.registration_device_type,
      registration_os: payload.registration_os,
      registration_browser: payload.registration_browser,
    })
  })

  it('returns invalid_request for malformed payloads', async () => {
    const response = await postRegister({
      email: 'not-an-email',
      password: 'short',
      first_name: '',
      last_name: '',
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('invalid_request')
  })

  it('returns account_deleted for deleted-account emails', async () => {
    const response = await postRegister(buildRegisterPayload({ email: 'deleted@capgo.app' }))
    expect(response.status).toBe(403)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('account_deleted')
    expect(body.message).toContain('support@capgo.app')
  })

  it('returns email_exists for an already registered email', async () => {
    const response = await postRegister(buildRegisterPayload({ email: 'test@capgo.app' }))
    expect(response.status).toBe(409)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('email_exists')
    expect(body.message).toBe('User already registered')
  })
})

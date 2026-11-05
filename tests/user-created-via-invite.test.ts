import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { executeSQL, USER_PASSWORD_HASH } from './test-utils.ts'

describe('users.created_via_invite', () => {
  it.concurrent.each([
    ['defaults to false for normal inserts (self-signup semantics)', undefined, false],
    ['can be explicitly set true for invite-created accounts', true, true],
  ])('%s', async (_label, createdViaInvite, expected) => {
    const userId = randomUUID()
    const email = `user-created-via-invite-${randomUUID()}@test.com`

    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [userId, email, USER_PASSWORD_HASH],
    )

    await executeSQL(
      createdViaInvite === undefined
        ? `INSERT INTO public.users (id, email) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`
        : `INSERT INTO public.users (id, email, created_via_invite) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, created_via_invite = EXCLUDED.created_via_invite`,
      createdViaInvite === undefined ? [userId, email] : [userId, email, createdViaInvite],
    )

    const rows = await executeSQL(
      'SELECT created_via_invite FROM public.users WHERE id = $1',
      [userId],
    )
    expect(rows[0]?.created_via_invite).toBe(expected)
  })
})

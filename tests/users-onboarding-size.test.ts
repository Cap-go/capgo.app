import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, USER_PASSWORD_HASH } from './test-utils.ts'

describe('users.onboarding size constraint', () => {
  const userId = randomUUID()
  const email = `users-onboarding-size-${randomUUID()}@test.com`

  beforeAll(async () => {
    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)`,
      [userId, email, USER_PASSWORD_HASH],
    )

    await executeSQL(
      `INSERT INTO public.users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [userId, email],
    )
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.users WHERE id = $1', [userId])
    await executeSQL('DELETE FROM auth.users WHERE id = $1', [userId])
  })

  it('allows onboarding JSON up to the 65,536-byte constraint ceiling', async () => {
    const constraints = await executeSQL<{ definition: string }>(
      `SELECT pg_get_constraintdef(pg_constraint.oid) AS definition
       FROM pg_constraint
       JOIN pg_class ON pg_class.oid = pg_constraint.conrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
       WHERE pg_namespace.nspname = 'public'
         AND pg_class.relname = 'users'
         AND pg_constraint.conname = 'users_onboarding_valid'`,
    )
    const normalizedDefinition = constraints[0]?.definition.replace(/\s+/g, ' ')

    expect(normalizedDefinition).toContain('octet_length((onboarding)::text) <= 65536')

    const accepted = await executeSQL<{ payload: string }>(
      `UPDATE public.users
       SET onboarding = jsonb_build_object('payload', $2::text)
       WHERE id = $1
       RETURNING onboarding ->> 'payload' AS payload`,
      [userId, 'a'.repeat(65_521)],
    )

    expect(accepted[0]?.payload).toHaveLength(65_521)

    await expect(executeSQL(
      `UPDATE public.users
       SET onboarding = jsonb_build_object('payload', $2::text)
       WHERE id = $1`,
      [userId, 'b'.repeat(65_522)],
    )).rejects.toMatchObject({ code: '23514' })
  })
})

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, USER_PASSWORD_HASH } from './test-utils.ts'

describe('WebNative onboarding schema constraints', () => {
  const userId = randomUUID()
  const orgId = randomUUID()
  const email = `webnative-onboarding-schema-${randomUUID()}@test.com`

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
    await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
    await executeSQL('DELETE FROM public.users WHERE id = $1', [userId])
    await executeSQL('DELETE FROM auth.users WHERE id = $1', [userId])
  })

  it('accepts publish intent and a supported development environment', async () => {
    const users = await executeSQL<{ onboarding: Record<string, unknown> }>(
      `UPDATE public.users
       SET onboarding = jsonb_build_object(
         'status', 'in_progress',
         'step', 'intent',
         'flow', 'pre_org',
         'development_environment', 'hosted_builder',
         'intent', 'publish'
       )
       WHERE id = $1
       RETURNING onboarding`,
      [userId],
    )
    expect(users[0]?.onboarding).toMatchObject({
      development_environment: 'hosted_builder',
      intent: 'publish',
    })

    const orgs = await executeSQL<{ onboarding: Record<string, unknown> }>(
      `INSERT INTO public.orgs (id, name, management_email, created_by, onboarding)
       VALUES ($1, $2, $3, $4, jsonb_build_object('intent', 'publish'))
       RETURNING onboarding`,
      [orgId, `WebNative schema ${orgId}`, email, userId],
    )
    expect(orgs[0]?.onboarding).toEqual({ intent: 'publish' })
  })

  it('rejects unsupported onboarding values', async () => {
    await expect(executeSQL(
      `UPDATE public.users
       SET onboarding = jsonb_build_object('development_environment', 'unsupported')
       WHERE id = $1`,
      [userId],
    )).rejects.toMatchObject({ code: '23514' })

    await expect(executeSQL(
      `UPDATE public.orgs
       SET onboarding = jsonb_build_object('intent', 'unsupported')
       WHERE id = $1`,
      [orgId],
    )).rejects.toMatchObject({ code: '23514' })
  })
})

import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { Hono } from 'hono/tiny'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordUserBentoEvent } from '../supabase/functions/_backend/utils/user_bento_events.ts'
import { executeSQL, POSTGRES_URL, USER_PASSWORD_HASH } from './test-utils.ts'

interface OnboardingRow {
  onboarding: {
    bento_events: Record<string, unknown>
    preserved: { marker: string }
  }
}

const ENV_KEYS = [
  'BENTO_PUBLISHABLE_KEY',
  'BENTO_SECRET_KEY',
  'BENTO_SITE_UUID',
  'CAPGO_PREVENT_BACKGROUND_FUNCTIONS',
  'SUPABASE_DB_URL',
] as const

describe('user Bento event JSONB patch', () => {
  const userId = randomUUID()
  const email = `user-bento-jsonb-${randomUUID()}@test.com`

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

  async function recordLogin() {
    const previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    process.env.SUPABASE_DB_URL = POSTGRES_URL
    process.env.CAPGO_PREVENT_BACKGROUND_FUNCTIONS = 'true'
    process.env.BENTO_PUBLISHABLE_KEY = 'test'
    process.env.BENTO_SECRET_KEY = 'test'
    process.env.BENTO_SITE_UUID = 'test'
    globalWithEdgeRuntime.EdgeRuntime = undefined

    try {
      const app = new Hono<{ Bindings: Record<string, string> }>()
      app.post('/', async (c) => {
        await recordUserBentoEvent(c, {
          observedAt: '2026-08-22T10:00:00.000Z',
          sourceEvent: 'User CLI login',
          userId,
        })
        return c.json({ status: 'ok' })
      })
      const response = await app.request('http://local/', { method: 'POST' }, {
        BENTO_PUBLISHABLE_KEY: 'test',
        BENTO_SECRET_KEY: 'test',
        BENTO_SITE_UUID: 'test',
        CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
        SUPABASE_DB_URL: POSTGRES_URL,
      })
      expect(response.status).toBe(200)
    }
    finally {
      for (const key of ENV_KEYS) {
        const previous = previousEnv[key]
        if (previous === undefined)
          delete process.env[key]
        else
          process.env[key] = previous
      }
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  }

  async function setOnboarding(bentoEvents: unknown) {
    await executeSQL(
      `UPDATE public.users
       SET onboarding = jsonb_build_object(
         'preserved', jsonb_build_object('marker', 'top-level'),
         'bento_events', $2::jsonb
       )
       WHERE id = $1`,
      [userId, JSON.stringify(bentoEvents)],
    )
  }

  async function readOnboarding() {
    const rows = await executeSQL<OnboardingRow>(
      'SELECT onboarding FROM public.users WHERE id = $1',
      [userId],
    )
    return rows[0]!.onboarding
  }

  it.each([
    ['JSON null', null],
    ['array', [{ private: 'array-value' }]],
    ['string', 'private-string-value'],
    ['number', 42],
  ])('replaces malformed %s bento_events with an object patch', async (_label, malformed) => {
    await setOnboarding(malformed)

    await recordLogin()

    const onboarding = await readOnboarding()
    expect(onboarding.preserved).toEqual({ marker: 'top-level' })
    expect(onboarding.bento_events).toEqual({
      'cli:login_successful': {
        details: [{
          observed_at: '2026-08-22T10:00:00.000Z',
          source_event: 'User CLI login',
        }],
        occurrence_count: 1,
      },
    })
  })

  it('preserves existing object-shaped event entries when patching a different key', async () => {
    const existing = {
      occurrence_count: 7,
      details: [{ source: 'existing-entry' }],
      sent_at: '2026-08-22T09:00:00.000Z',
    }
    await setOnboarding({ 'existing:event': existing })

    await recordLogin()

    const onboarding = await readOnboarding()
    expect(onboarding.preserved).toEqual({ marker: 'top-level' })
    expect(onboarding.bento_events['existing:event']).toEqual(existing)
    expect(onboarding.bento_events['cli:login_successful']).toEqual({
      details: [{
        observed_at: '2026-08-22T10:00:00.000Z',
        source_event: 'User CLI login',
      }],
      occurrence_count: 1,
    })
  })
})

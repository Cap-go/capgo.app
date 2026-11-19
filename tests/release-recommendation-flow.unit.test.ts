import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as PGlite | null }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: async () => true }))
vi.mock('../supabase/functions/_backend/utils/plan-gating.ts', () => ({ requirePaidPlan: async () => {} }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: async () => state.db, closeClient: () => {} }))
vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  apikeyPrincipal: () => ({}),
  withRlsContext: async (_c: unknown, _p: unknown, fn: (db: PGlite) => unknown) => fn(state.db!),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ getEnv: () => '', isValidAppId: (s: string) => s.includes('.') }))
const { recommendRelease } = await import('../supabase/functions/_backend/public/bundle/recommend.ts')

it('runs a recommendation HTTP flow against PostgreSQL and accounts for valid and invalid AI responses', async () => {
  const db = new PGlite()
  state.db = db
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.orgs (id uuid PRIMARY KEY);
      CREATE TABLE public.apps (app_id text, owner_org uuid);
      CREATE TABLE public.app_versions (id bigint, app_id text, name text, comment text, min_update_version text);
      INSERT INTO public.orgs VALUES ('00000000-0000-4000-8000-000000000001');
      INSERT INTO public.apps VALUES ('com.example.release', '00000000-0000-4000-8000-000000000001');
      INSERT INTO public.app_versions VALUES (1, 'com.example.release', '1.2.3', 'Previous release', '1.0.0');`)
    await db.exec(await readFile(new URL('../supabase/migrations/20261114013028_ai_release_usage.sql', import.meta.url), 'utf8'))
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify({ nextVersion: '1.2.4', level: 'patch', reason: 'Fix', changelog: '- Fixed rendering' }) })
    // The router parses JSON before handing it to the command handler.
    const router = new Hono()
    router.post('/', async c => recommendRelease(c as never, await c.req.json(), { key: 'fake' } as never))
    const request = () => router.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'com.example.release', changelog: true, context: { source: 'local', commits: 'fix: rendering', changes: 'index.ts', tags: '1.2.3', truncated: false } }),
    }, { AI: { run } })
    const first = await request()
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ nextVersion: '1.2.4', changelog: '- Fixed rendering' })
    expect(JSON.parse(run.mock.calls[0][1].messages[1].content).history).toEqual([{ name: '1.2.3', comment: 'Previous release', min_update_version: '1.0.0' }])
    await db.exec("INSERT INTO public.app_versions VALUES (2, 'com.example.release', '1.2.4', '', '1.0.0')")
    expect((await request()).status).toBe(502)
    const counts = await db.query('SELECT requests::int, successes::int, failures::int, changelog_requests::int FROM public.ai_release_usage_daily')
    expect(counts.rows).toEqual([{ requests: 2, successes: 1, failures: 1, changelog_requests: 2 }])
  }
  finally {
    await db.close()
    state.db = null
  }
}, 30000)

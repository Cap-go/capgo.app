import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('keeps concurrent usage counts durable, private, constrained and scoped by owner', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.orgs (id uuid PRIMARY KEY);
      CREATE TABLE public.app_versions (id bigint, app_id text);
      INSERT INTO public.orgs VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');`)
    await db.exec(await readFile(new URL('../supabase/migrations/20261111212918_ai_release_usage.sql', import.meta.url), 'utf8'))
    const insert = `INSERT INTO public.ai_release_usage_daily (day, org_id, app_id, requests, changelog_requests)
      VALUES ('2026-11-11', $1::uuid, 'com.example.release', 1, 1)
      ON CONFLICT (day, org_id, app_id) DO UPDATE SET requests = public.ai_release_usage_daily.requests + 1,
      changelog_requests = public.ai_release_usage_daily.changelog_requests + 1`
    const org = '00000000-0000-4000-8000-000000000001'
    await Promise.all(Array.from({ length: 20 }, () => db.query(insert, [org])))
    await db.query(insert, ['00000000-0000-4000-8000-000000000002'])
    expect((await db.query<{ requests: number }>('SELECT requests::int FROM public.ai_release_usage_daily WHERE org_id = $1', [org])).rows[0].requests).toBe(20)
    await expect(db.exec('UPDATE public.ai_release_usage_daily SET successes = requests + 1')).rejects.toThrow()
    await db.exec('SET ROLE anon')
    await expect(db.exec('SELECT * FROM public.ai_release_usage_daily')).rejects.toThrow(/permission denied/)
    await db.exec('RESET ROLE; SET ROLE authenticated')
    await expect(db.exec('SELECT * FROM public.ai_release_usage_daily')).rejects.toThrow(/permission denied/)
    await db.exec('RESET ROLE; SET ROLE service_role')
    expect((await db.query('SELECT * FROM public.ai_release_usage_daily')).rows.length).toBe(2)
    await db.exec('RESET ROLE')
    const columns = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_release_usage_daily'")).rows.map(r => r.column_name)
    expect(columns).toEqual(['day', 'org_id', 'app_id', 'requests', 'successes', 'failures', 'changelog_requests'])
  }
  finally {
    await db.close()
  }
}, 30000)

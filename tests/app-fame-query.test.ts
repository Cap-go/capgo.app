import { randomUUID } from 'node:crypto'
import { Hono } from 'hono/tiny'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAdminFamousApps } from '../supabase/functions/_backend/utils/pg.ts'
import {
  executeSQL,
  POSTGRES_URL,
  USER_ID,
  withAuthenticatedUser,
} from './test-utils.ts'

const fixtureId = randomUUID()
const orgId = randomUUID()
const famousAppId = `com.test.fame.iconic.${fixtureId.slice(0, 8)}`
const nicheAppId = `com.test.fame.niche.${fixtureId.slice(0, 8)}`
const capgoDemoAppId = `app.capgo.famehide.${fixtureId.slice(0, 8)}`
const leakedAppId = `com.test.fame.leaked.${fixtureId.slice(0, 8)}`
const customerId = `cus_fame_${fixtureId.replaceAll('-', '').slice(0, 20)}`

describe('app fame reporting and scheduling', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL })

    await executeSQL(`
      INSERT INTO public.stripe_info (customer_id, status, product_id, trial_at, is_good_plan)
      VALUES ($1, 'succeeded', 'prod_LQIregjtNduh4q', now() + interval '15 days', true)
    `, [customerId])
    await executeSQL(`
      INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5)
    `, [orgId, USER_ID, `Fame Org ${fixtureId}`, `fame-${fixtureId}@capgo.app`, customerId])
    await executeSQL(`
      INSERT INTO public.apps (app_id, name, icon_url, owner_org)
      VALUES
        ($1, 'National Bank', 'https://example.com/bank.png', $5::uuid),
        ($2, 'Local Utility', 'https://example.com/util.png', $5::uuid),
        ($3, 'Capgo Brightness', 'https://example.com/capgo.png', $5::uuid),
        ($4, 'Leaked Startup', 'https://example.com/leak.png', $5::uuid)
    `, [famousAppId, nicheAppId, capgoDemoAppId, leakedAppId, orgId])
    await executeSQL(`
      INSERT INTO public.app_fame (
        app_id, fame_score, confidence, tier, category, known_as, summary, model
      ) VALUES
        ($1, 94, 82, 'iconic', 'finance', 'National Bank', 'Major national consumer bank.', 'test-model'),
        ($2, 38, 60, 'niche', 'utilities', 'Local Utility', 'Regional utility with little public fame.', 'test-model'),
        ($3, 100, 90, 'iconic', 'software', 'Capgo', 'Internal plugin demo.', 'test-model'),
        ($4, 100, 90, 'iconic', '90-100', 'Leaked Startup', 'Iconic global consumer brand.', 'test-model')
    `, [famousAppId, nicheAppId, capgoDemoAppId, leakedAppId])
  })

  afterAll(async () => {
    await executeSQL(`DELETE FROM public.apps WHERE app_id = ANY($1::text[])`, [[famousAppId, nicheAppId, capgoDemoAppId, leakedAppId]])
    await executeSQL(`DELETE FROM public.orgs WHERE id = $1::uuid`, [orgId])
    await executeSQL(`DELETE FROM public.stripe_info WHERE customer_id = $1`, [customerId])
    await pool.end()
  })

  it('returns AI-scored apps ranked by fame, not device count', async () => {
    const app = new Hono<{ Bindings: { SUPABASE_DB_URL: string } }>()
    app.get('/', async c => c.json(await getAdminFamousApps(c, {
      search: fixtureId.slice(0, 8),
      min_score: 0,
      limit: 50,
      offset: 0,
    })))
    const response = await app.request('http://local/', undefined, { SUPABASE_DB_URL: POSTGRES_URL })

    expect(response.status).toBe(200)
    const data = await response.json() as {
      apps: Array<{ app_id: string, fame_score: number, tier: string, known_as: string | null, icon_url: string | null }>
      iconic_count: number
      famous_count: number
      notable_count: number
    }

    const famous = data.apps.find(app => app.app_id === famousAppId)
    const niche = data.apps.find(app => app.app_id === nicheAppId)
    expect(famous?.fame_score).toBe(94)
    expect(famous?.tier).toBe('iconic')
    expect(famous?.known_as).toBe('National Bank')
    expect(niche?.fame_score).toBe(38)

    const famousIndex = data.apps.findIndex(app => app.app_id === famousAppId)
    const nicheIndex = data.apps.findIndex(app => app.app_id === nicheAppId)
    expect(famousIndex).toBeGreaterThanOrEqual(0)
    expect(nicheIndex).toBeGreaterThan(famousIndex)
    expect(famous?.icon_url).toBe('https://example.com/bank.png')
    expect(niche?.icon_url).toBe('https://example.com/util.png')
  })

  it('filters by minimum fame score', async () => {
    const app = new Hono<{ Bindings: { SUPABASE_DB_URL: string } }>()
    app.get('/', async c => c.json(await getAdminFamousApps(c, {
      min_score: 80,
      search: famousAppId,
      limit: 50,
      offset: 0,
    })))
    const response = await app.request('http://local/', undefined, { SUPABASE_DB_URL: POSTGRES_URL })

    expect(response.status).toBe(200)
    const data = await response.json() as {
      apps: Array<{ app_id: string }>
    }
    expect(data.apps.some(app => app.app_id === famousAppId)).toBe(true)
    expect(data.apps.some(app => app.app_id === nicheAppId)).toBe(false)
  })

  it('hides Capgo plugin demos and leaked rubric scores from the famous list', async () => {
    const app = new Hono<{ Bindings: { SUPABASE_DB_URL: string } }>()
    app.get('/', async c => c.json(await getAdminFamousApps(c, {
      min_score: 80,
      search: fixtureId.slice(0, 8),
      limit: 50,
      offset: 0,
    })))
    const response = await app.request('http://local/', undefined, { SUPABASE_DB_URL: POSTGRES_URL })

    expect(response.status).toBe(200)
    const data = await response.json() as {
      apps: Array<{ app_id: string }>
    }
    const appIds = data.apps.map(app => app.app_id)
    expect(appIds).toContain(famousAppId)
    expect(appIds).not.toContain(capgoDemoAppId)
    expect(appIds).not.toContain(leakedAppId)
  })

  it('hides app_fame from authenticated users through RLS', async () => {
    await expect(withAuthenticatedUser(pool, USER_ID, async (client) => {
      await client.query(
        'SELECT app_id FROM public.app_fame WHERE app_id = $1',
        [famousAppId],
      )
    })).rejects.toThrow(/permission denied/)
  })

  it('registers fame scoring in cron_tasks for process_all_cron_tasks', async () => {
    const tasks = await executeSQL(`
      SELECT name, task_type, target
      FROM public.cron_tasks
      WHERE name IN ('cron_app_fame', 'app_fame_queue')
      ORDER BY name
    `) as Array<{ name: string, task_type: string, target: string }>

    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'app_fame_queue', task_type: 'function_queue' }),
      expect.objectContaining({ name: 'cron_app_fame', task_type: 'queue', target: 'cron_app_fame' }),
    ]))

    const queues = await executeSQL(`
      SELECT queue_name
      FROM pgmq.list_queues()
      WHERE queue_name = 'cron_app_fame'
    `) as Array<{ queue_name: string }>
    expect(queues).toEqual([{ queue_name: 'cron_app_fame' }])
  })
})

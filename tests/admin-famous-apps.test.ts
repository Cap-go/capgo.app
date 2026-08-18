import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  fetchTestRequest,
  getAuthHeadersForCredentials,
  POSTGRES_URL,
  USER_ADMIN_EMAIL,
  USER_ID,
  withAuthenticatedUser,
} from './test-utils.ts'

const fixtureId = randomUUID()
const orgId = randomUUID()
const famousAppId = `com.test.fame.iconic.${fixtureId.slice(0, 8)}`
const nicheAppId = `com.test.fame.niche.${fixtureId.slice(0, 8)}`
const customerId = `cus_fame_${fixtureId.replaceAll('-', '').slice(0, 20)}`

const INSIGHTS_START = '2026-04-01T00:00:00.000Z'
const INSIGHTS_END = '2026-04-30T23:59:59.000Z'

describe('admin famous apps', () => {
  let adminHeaders: Record<string, string>
  let pool: Pool

  beforeAll(async () => {
    adminHeaders = await getAuthHeadersForCredentials(USER_ADMIN_EMAIL, 'adminadmin')
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
        ($1, 'National Bank', 'https://example.com/bank.png', $3::uuid),
        ($2, 'Local Utility', 'https://example.com/util.png', $3::uuid)
    `, [famousAppId, nicheAppId, orgId])
    await executeSQL(`
      INSERT INTO public.app_fame (
        app_id, fame_score, confidence, tier, category, known_as, summary, model
      ) VALUES
        ($1, 94, 82, 'iconic', 'finance', 'National Bank', 'Major national consumer bank.', 'test-model'),
        ($2, 38, 60, 'niche', 'utilities', 'Local Utility', 'Regional utility with little public fame.', 'test-model')
    `, [famousAppId, nicheAppId])
  })

  afterAll(async () => {
    await executeSQL(`DELETE FROM public.apps WHERE app_id = ANY($1::text[])`, [[famousAppId, nicheAppId]])
    await executeSQL(`DELETE FROM public.orgs WHERE id = $1::uuid`, [orgId])
    await executeSQL(`DELETE FROM public.stripe_info WHERE customer_id = $1`, [customerId])
    await pool.end()
  })

  it('returns AI-scored apps ranked by fame, not device count', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'famous_apps',
        start_date: INSIGHTS_START,
        end_date: INSIGHTS_END,
        search: fixtureId.slice(0, 8),
        min_score: 0,
        limit: 50,
        offset: 0,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        apps: Array<{ app_id: string, fame_score: number, tier: string, known_as: string | null }>
        iconic_count: number
        famous_count: number
        notable_count: number
      }
    }

    expect(payload.success).toBe(true)
    const famous = payload.data.apps.find(app => app.app_id === famousAppId)
    const niche = payload.data.apps.find(app => app.app_id === nicheAppId)
    expect(famous?.fame_score).toBe(94)
    expect(famous?.tier).toBe('iconic')
    expect(famous?.known_as).toBe('National Bank')
    expect(niche?.fame_score).toBe(38)

    const famousIndex = payload.data.apps.findIndex(app => app.app_id === famousAppId)
    const nicheIndex = payload.data.apps.findIndex(app => app.app_id === nicheAppId)
    expect(famousIndex).toBeGreaterThanOrEqual(0)
    expect(nicheIndex).toBeGreaterThan(famousIndex)
  })

  it('filters by minimum fame score', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'famous_apps',
        start_date: INSIGHTS_START,
        end_date: INSIGHTS_END,
        min_score: 80,
        search: famousAppId,
        limit: 50,
        offset: 0,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      data: { apps: Array<{ app_id: string }> }
    }
    expect(payload.data.apps.some(app => app.app_id === famousAppId)).toBe(true)
    expect(payload.data.apps.some(app => app.app_id === nicheAppId)).toBe(false)
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

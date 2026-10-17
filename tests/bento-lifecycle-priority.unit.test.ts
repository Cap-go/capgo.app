import type { EligibleUser, QueryClient, ReadOnlyContext } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import { randomUUID } from 'node:crypto'
import { createPgliteEngine, Database } from 'tinbase'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimLifecycleBudget } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/budget.ts'
import { hasHigherPrioritySibling } from '../cloudflare_workers/bento_dispatch/flows/lifecycle/priority.ts'

let db: Database
let client: QueryClient
let read: ReadOnlyContext

beforeAll(async () => {
  db = await Database.create(await createPgliteEngine())
  await db.exec(`CREATE TABLE public.bento_lifecycle_journeys(org_id uuid, product text, revision bigint,
    candidate jsonb, next_evaluation_at timestamptz, PRIMARY KEY(org_id,product));
    CREATE TABLE public.bento_event_dispatches(flow_key text, context_key text, recipient_key text, tag text,
      status text, attempt_count int, claim_until timestamptz, last_attempt_at timestamptz, event_at timestamptz, details jsonb);`)
  client = { query: async (sql, values) => db.query(sql, values) } as QueryClient
  read = { query: async (sql, values) => (await db.query(sql, values)).rows } as ReadOnlyContext
}, 30_000)

afterAll(async () => db?.close())

async function select(orgId: string, product: 'ota' | 'builder', priority = 40): Promise<EligibleUser> {
  const candidate = { purpose: `${product}:purpose`, branch: 'setup_progress', context: 'current', priority, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  await db.query(`INSERT INTO public.bento_lifecycle_journeys VALUES($1,$2,1,$3::jsonb,CURRENT_TIMESTAMP)`, [orgId, product, JSON.stringify(candidate)])
  return { flowKey: 'lifecycle:v2:org', contextKey: orgId, recipientKey: `org:${orgId}`, email: 'priority@example.com', tag: candidate.purpose, action: 'send', reason: candidate.branch, metadata: { orgId, product, recipientId: randomUUID(), revision: 1, ...candidate } }
}

describe('current sibling priority arbitration', () => {
  it('rechecks priority at claim when a Trial candidate arrives after optional selection', async () => {
    const orgId = randomUUID()
    const selected = await select(orgId, 'builder')
    expect(await claimLifecycleBudget(client, selected)).toBe(true)
    await select(orgId, 'ota', 100)
    expect(await hasHigherPrioritySibling(read, orgId, 'builder', 40)).toBe(true)
    expect(await claimLifecycleBudget(client, selected)).toBe(false)
    expect((await db.query('SELECT * FROM public.bento_event_dispatches')).rows).toEqual([])
  })

  it('lets OTA win equal priority and ignores exhausted or accepted sibling purposes', async () => {
    const orgId = randomUUID()
    const builder = await select(orgId, 'builder')
    const ota = await select(orgId, 'ota')
    expect(await claimLifecycleBudget(client, builder)).toBe(false)
    expect(await claimLifecycleBudget(client, ota)).toBe(true)
    await db.query(`INSERT INTO public.bento_event_dispatches(flow_key,context_key,recipient_key,tag,status,attempt_count)
      VALUES($1,$2,$3,$4,'failed',5)`, [ota.flowKey, ota.contextKey, ota.recipientKey, ota.tag])
    expect(await claimLifecycleBudget(client, builder)).toBe(true)
    await db.query(`UPDATE public.bento_event_dispatches SET status='accepted',attempt_count=1 WHERE context_key=$1`, [orgId])
    expect(await hasHigherPrioritySibling(read, orgId, 'builder', 40)).toBe(false)
  })

  it('counts a success with a plan CTA toward the optional commercial cap while keeping Trial available', async () => {
    const orgId = randomUUID()
    const selected = await select(orgId, 'ota')
    selected.metadata.commercialOffer = true
    await db.query(`INSERT INTO public.bento_event_dispatches(flow_key,context_key,recipient_key,tag,status,attempt_count,last_attempt_at,event_at,details)
      VALUES($1,$2,$3,'summary:previous-success','accepted',1,CURRENT_TIMESTAMP-INTERVAL '2 days',CURRENT_TIMESTAMP-INTERVAL '2 days',$4::jsonb)`, [selected.flowKey, orgId, selected.recipientKey, JSON.stringify({ metadata: { orgId, recipientId: selected.metadata.recipientId, branch: 'first_update_success', commercialOffer: true } })])
    expect(await claimLifecycleBudget(client, selected)).toBe(false)
    const trial = await select(orgId, 'builder', 100)
    trial.tag = 'trial:deadline'
    trial.metadata.purpose = trial.tag
    trial.metadata.branch = 'today_ready'
    await db.query(`UPDATE public.bento_lifecycle_journeys SET candidate=$2::jsonb WHERE org_id=$1 AND product='builder'`, [orgId, JSON.stringify(trial.metadata)])
    expect(await claimLifecycleBudget(client, trial)).toBe(true)
  })

  it('measures the daily limit from confirmed acceptance rather than the earlier provider attempt', async () => {
    const orgId = randomUUID()
    const selected = await select(orgId, 'ota')
    await db.query(`INSERT INTO public.bento_event_dispatches(flow_key,context_key,recipient_key,tag,status,attempt_count,last_attempt_at,event_at,details)
      VALUES($1,$2,$3,'summary:just-inside-day','accepted',1,CURRENT_TIMESTAMP-INTERVAL '24 hours 10 seconds',
        CURRENT_TIMESTAMP-INTERVAL '23 hours 59 minutes 55 seconds',$4::jsonb)`, [selected.flowKey, orgId, selected.recipientKey, JSON.stringify({ metadata: { orgId, recipientId: selected.metadata.recipientId, branch: 'progress_digest' } })])
    expect(await claimLifecycleBudget(client, selected)).toBe(false)
  })
})

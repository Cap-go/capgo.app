import type { PoolClient } from 'pg'
import type { DispatchRecord, EligibleUser, RunRecord } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { DispatchStore } from '../cloudflare_workers/bento_dispatch/store.ts'
import { cleanupPostgresClient, executeSQL, POSTGRES_URL, USER_ID } from './test-utils.ts'

const pool = new Pool({ connectionString: POSTGRES_URL, max: 12 })

afterAll(async () => {
  await pool.end()
  await cleanupPostgresClient()
})

interface Actor {
  client: PoolClient
  store: DispatchStore
  run: RunRecord
}

interface Selection {
  priority?: number
  purpose?: string
  branch?: string
  context?: string
  recipientId?: string
  email?: string
  incarnation?: string
}

function fixture() {
  const fixtureId = randomUUID()
  const orgIds: string[] = []
  const evaluationKeys: string[] = []
  const clients: PoolClient[] = []

  async function org() {
    const id = randomUUID()
    orgIds.push(id)
    // The existing seed owner is read only. Every mutable org/journey/event
    // belongs exclusively to this fixture, with synthetic recipient metadata.
    await executeSQL(`INSERT INTO public.orgs(id,name,management_email,created_by)
      VALUES($1,$2,$3,$4)`, [id, `Lifecycle storage fixture ${id}`, `lifecycle-store-${id}@example.com`, USER_ID])
    return id
  }

  async function actor(): Promise<Actor> {
    const key = `test:lifecycle-store:${fixtureId}:${evaluationKeys.length}`
    evaluationKeys.push(key)
    const client = await pool.connect()
    clients.push(client)
    const store = new DispatchStore(client)
    const queued = await store.schedule(key, 1)
    expect(queued).not.toBeNull()
    expect(await store.markEnqueued(queued!.id, queued!.enqueue_claim_token!)).toBe(true)
    const run = await store.claimRun({ version: 1, evaluationKey: key, runId: queued!.id })
    expect(run).not.toBeNull()
    return { client, store, run: run! }
  }

  async function prepare(orgId: string, product: 'ota' | 'builder', options: Selection = {}): Promise<EligibleUser> {
    const recipientId = options.recipientId ?? randomUUID()
    const incarnation = options.incarnation ?? randomUUID()
    const candidate = {
      purpose: options.purpose ?? 'recovery:24h',
      branch: options.branch ?? 'setup_recovery_24h',
      context: options.context ?? `${product}:${incarnation}:unfinished`,
      priority: options.priority ?? 40,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }
    // Direct internal storage fixtures intentionally bypass cohort/evidence
    // evaluation, covered separately by lifecycle schema and evaluator suites.
    const [journey] = await executeSQL<{ revision: string }>(`INSERT INTO public.bento_lifecycle_journeys
      (org_id,product,selected_app_incarnation,candidate) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(org_id,product) DO UPDATE SET selected_app_incarnation=EXCLUDED.selected_app_incarnation,
        candidate=EXCLUDED.candidate,revision=bento_lifecycle_journeys.revision+1
      RETURNING revision`, [orgId, product, incarnation, JSON.stringify(candidate)])
    return {
      flowKey: 'lifecycle:v2:org',
      contextKey: orgId,
      recipientKey: `org:${orgId}`,
      email: options.email ?? `lifecycle-recipient-${recipientId}@example.com`,
      tag: candidate.purpose,
      action: 'send',
      reason: candidate.branch,
      metadata: { orgId, product, recipientId, revision: Number(journey!.revision), appIncarnation: incarnation, ...candidate },
    }
  }

  async function start(sender: Actor, user: EligibleUser) {
    await sender.store.recordFlowEvent(sender.run, user, 'flow:started', 'storage_fixture_enrolled')
  }

  async function history(orgId: string, recipientId: string, daysAgo: number, purpose: string) {
    await executeSQL(`INSERT INTO public.bento_event_dispatches
      (flow_key,context_key,recipient_key,tag,email,status,event_at,last_attempt_at,attempt_count,details)
      VALUES('lifecycle:v2:org',$1,$2,$3,'historical-recipient@example.com','accepted',
        CURRENT_TIMESTAMP-($4*INTERVAL '1 day'),CURRENT_TIMESTAMP-($4*INTERVAL '1 day'),1,$5::jsonb)`, [
      orgId,
      `org:${orgId}`,
      purpose,
      daysAgo,
      JSON.stringify({ reason: 'fixture_accepted', metadata: { orgId, recipientId, product: 'ota', branch: 'setup_progress' } }),
    ])
  }

  async function events(orgId: string) {
    return executeSQL(`SELECT * FROM public.bento_event_dispatches
      WHERE context_key=$1 AND tag NOT IN ('flow:started','flow:ended') ORDER BY tag`, [orgId])
  }

  async function expire(event: DispatchRecord) {
    await executeSQL(`UPDATE public.bento_event_dispatches SET claim_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1`, [event.id])
  }

  async function cleanup() {
    try {
      await executeSQL(`DELETE FROM public.bento_event_dispatches WHERE context_key=ANY($1::text[])
        OR details->'metadata'->>'orgId'=ANY($1::text[])`, [orgIds])
      await executeSQL('DELETE FROM public.bento_evaluation_runs WHERE evaluation_key=ANY($1::text[])', [evaluationKeys])
      await executeSQL('DELETE FROM public.orgs WHERE id=ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.stripe_info WHERE customer_id=ANY($1::text[])', [orgIds.map(id => `pending_${id}`)])
    }
    finally {
      for (const client of clients)
        client.release()
    }
  }

  return { org, actor, prepare, start, history, events, expire, cleanup }
}

async function parallelClaims(actors: Actor[], users: EligibleUser[]) {
  // Settle both connections before fixture cleanup, including on an unexpected
  // PostgreSQL failure. These are independent transactions on separate sockets.
  const results = await Promise.allSettled(actors.map((actor, index) => actor.store.claimEvent(actor.run, users[index]!)))
  return results.map((result) => {
    if (result.status === 'rejected')
      throw result.reason
    return result.value
  })
}

describe('lifecycle PostgreSQL dispatch claims', () => {
  it.concurrent('defers an already selected optional touch when a higher priority sibling arrives before claim', async () => {
    const f = fixture()
    try {
      const orgId = await f.org()
      const actor = await f.actor()
      const optional = await f.prepare(orgId, 'builder', { purpose: 'summary:optional', branch: 'progress_digest' })
      await f.start(actor, optional)
      const trial = await f.prepare(orgId, 'ota', { purpose: 'trial:deadline', branch: 'today_ready', priority: 100 })
      expect(await actor.store.claimEvent(actor.run, optional)).toBeNull()
      expect(await f.events(orgId)).toEqual([])
      const claim = await actor.store.claimEvent(actor.run, trial)
      expect(claim).not.toBeNull()
      expect((await f.events(orgId)).map(row => row.tag)).toEqual(['trial:deadline'])
    }
    finally { await f.cleanup() }
  })

  it.concurrent('claims only one product for an organization and enforces its accepted daily collision limit', async () => {
    const f = fixture()
    try {
      const orgId = await f.org()
      const actors = await Promise.all([f.actor(), f.actor()])
      expect(actors[0].client).not.toBe(actors[1].client)
      const users = [
        await f.prepare(orgId, 'ota', { recipientId: randomUUID() }),
        await f.prepare(orgId, 'builder', { recipientId: randomUUID() }),
      ]
      await Promise.all(actors.map((actor, index) => f.start(actor, users[index]!)))
      const claims = await parallelClaims(actors, users)
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect((await f.events(orgId)).map(row => row.status)).toEqual(['sending'])
      const winner = claims.findIndex(Boolean)
      expect(await actors[winner]!.store.acceptEvent(actors[winner]!.run, claims[winner]!, users[winner]!)).toBe(true)
      const loser = winner === 0 ? 1 : 0
      const deferred = await f.prepare(orgId, loser === 0 ? 'ota' : 'builder', { recipientId: String(users[loser]!.metadata.recipientId) })
      expect(await actors[loser]!.store.claimEvent(actors[loser]!.run, deferred)).toBeNull()
      expect((await f.events(orgId)).map(row => ({ status: row.status, attempts: row.attempt_count }))).toEqual([{ status: 'accepted', attempts: 1 }])
    }
    finally { await f.cleanup() }
  })

  it.concurrent('claims only one organization for the same recipient across separate database connections', async () => {
    const f = fixture()
    try {
      const orgIds = await Promise.all([f.org(), f.org()])
      const actors = await Promise.all([f.actor(), f.actor()])
      const recipientId = randomUUID()
      const users = await Promise.all(orgIds.map(orgId => f.prepare(orgId, 'ota', { recipientId })))
      await Promise.all(actors.map((actor, index) => f.start(actor, users[index]!)))
      const claims = await parallelClaims(actors, users)
      expect(claims.filter(Boolean)).toHaveLength(1)
      const events = (await Promise.all(orgIds.map(f.events))).flat()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ status: 'sending', attempt_count: 1 })
      expect(events[0].details.metadata.recipientId).toBe(recipientId)
    }
    finally { await f.cleanup() }
  })

  it.concurrent('blocks a fourth optional touch while retaining Trial follow-ups under the same daily limit', async () => {
    const f = fixture()
    try {
      const orgId = await f.org()
      const actor = await f.actor()
      const recipientId = randomUUID()
      for (const daysAgo of [2, 3, 4])
        await f.history(orgId, recipientId, daysAgo, `progress:historical-${daysAgo}`)
      const optional = await f.prepare(orgId, 'ota', { recipientId, purpose: 'progress:new-batch', branch: 'setup_progress' })
      await f.start(actor, optional)
      expect(await actor.store.claimEvent(actor.run, optional)).toBeNull()
      expect(await f.events(orgId)).toHaveLength(3)
      const trial = await f.prepare(orgId, 'ota', { recipientId, purpose: 'trial:deadline', branch: 'trial_deadline' })
      const claim = await actor.store.claimEvent(actor.run, trial)
      expect(claim).not.toBeNull()
      expect(await actor.store.acceptEvent(actor.run, claim!, trial)).toBe(true)
      const anotherTrial = await f.prepare(orgId, 'ota', { recipientId, purpose: 'trial:post-trial', branch: 'trial_post_trial' })
      expect(await actor.store.claimEvent(actor.run, anotherTrial)).toBeNull()
      const events = await f.events(orgId)
      expect(events).toHaveLength(4)
      expect(events.find(row => row.tag === 'trial:deadline')).toMatchObject({ status: 'accepted', attempt_count: 1 })
      expect(events.some(row => row.tag === 'progress:new-batch' || row.tag === 'trial:post-trial')).toBe(false)
    }
    finally { await f.cleanup() }
  })

  it.concurrent('never sends an accepted purpose again after recipient, app and variant changes', async () => {
    const f = fixture()
    try {
      const orgId = await f.org()
      const actor = await f.actor()
      const original = await f.prepare(orgId, 'ota')
      await f.start(actor, original)
      const accepted = await actor.store.claimEvent(actor.run, original)
      expect(accepted).not.toBeNull()
      expect(await actor.store.acceptEvent(actor.run, accepted!, original)).toBe(true)
      const replacement = await f.prepare(orgId, 'ota', {
        purpose: original.tag,
        branch: 'setup_resumed',
        recipientId: randomUUID(),
        email: 'replacement-recipient@example.com',
        incarnation: randomUUID(),
      })
      expect(replacement.metadata.context).not.toBe(original.metadata.context)
      expect(await actor.store.claimEvent(actor.run, replacement)).toBeNull()
      const events = await f.events(orgId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ id: accepted!.id, email: original.email, status: 'accepted', attempt_count: 1 })
      expect(events[0].details.metadata).toEqual(original.metadata)
    }
    finally { await f.cleanup() }
  })

  it.concurrent('refreshes failed retry recipient, email, incarnation, context and variant within the same five-attempt purpose', async () => {
    const f = fixture()
    try {
      const orgId = await f.org()
      const actor = await f.actor()
      let selected = await f.prepare(orgId, 'ota')
      await f.start(actor, selected)
      let claim = await actor.store.claimEvent(actor.run, selected)
      expect(claim).not.toBeNull()
      const dispatchId = claim!.id
      expect(await actor.store.failEvent(actor.run, claim!, selected, 'provider_timeout')).toBe(true)
      for (let attempt = 2; attempt <= 5; attempt++) {
        await f.expire(claim!)
        const oldClaim = claim!
        const oldSelection = selected
        selected = await f.prepare(orgId, 'ota', {
          purpose: oldSelection.tag,
          branch: attempt % 2 === 0 ? 'setup_resumed' : 'setup_progress',
          recipientId: randomUUID(),
          email: `retry-recipient-${attempt}@example.com`,
          incarnation: randomUUID(),
        })
        claim = await actor.store.claimEvent(actor.run, selected)
        expect(claim).toMatchObject({ id: dispatchId, attempt_count: attempt, email: selected.email, status: 'sending' })
        const [stored] = await f.events(orgId)
        expect(stored.details.metadata).toEqual(selected.metadata)
        expect(stored.details.metadata.context).not.toBe(oldSelection.metadata.context)
        expect(stored.details.metadata.recipientId).not.toBe(oldSelection.metadata.recipientId)
        expect(await actor.store.acceptEvent(actor.run, oldClaim, oldSelection)).toBe(false)
        expect(await actor.store.failEvent(actor.run, claim!, selected, 'provider_rejected')).toBe(true)
      }
      await f.expire(claim!)
      const exhausted = await f.prepare(orgId, 'ota', { purpose: selected.tag, email: 'sixth-attempt@example.com' })
      expect(await actor.store.claimEvent(actor.run, exhausted)).toBeNull()
      const events = await f.events(orgId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ id: dispatchId, status: 'failed', attempt_count: 5, email: selected.email })
      expect(events[0].details.metadata).toEqual(selected.metadata)
    }
    finally { await f.cleanup() }
  })
})

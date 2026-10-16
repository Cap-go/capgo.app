import type { EligibleUser, Evaluation } from '../cloudflare_workers/bento_dispatch/contracts.ts'
import { describe, expect, it, vi } from 'vitest'
import { buildEligibilityAudit } from '../cloudflare_workers/bento_dispatch/audit.ts'
import { bentoFlows } from '../cloudflare_workers/bento_dispatch/bentoFlows.ts'
import { processDispatchJob } from '../cloudflare_workers/bento_dispatch/consumer.ts'
import { invitationEvaluation, resolveInvitation } from '../cloudflare_workers/bento_dispatch/flows/invitations.ts'
import { buildInvitationEvent, parseDispatchJob } from '../cloudflare_workers/bento_dispatch/operations.ts'
import { publishDispatchJobs } from '../cloudflare_workers/bento_dispatch/scheduler.ts'
import { messageBytes, parsePostHogMessage, POSTHOG_MESSAGE_MAX_BYTES } from '../supabase/functions/_backend/utils/posthog_queue.ts'

const key = 'org:invite_new_user_reminder_1'
const job = { version: 1 as const, evaluationKey: key, runId: '11111111-1111-4111-8111-111111111111' }
const user: EligibleUser = { flowKey: 'org:invitation', contextKey: '33333333-3333-4333-8333-333333333333', recipientKey: 'email:invitee@example.com', email: 'invitee@example.com', tag: key, action: 'send', reason: 'first_reminder_due', metadata: { startId: '22222222-2222-4222-8222-222222222222' } }
const invitation = { email: 'invitee@example.com', org_id: '55555555-5555-4555-8555-555555555555', org_name: '<img src=x>\nTeam', org_admin_name: 'Someone & Team', first_name: '<b>Invitee</b>', last_name: '', invite_magic_string: 'secret+token', is_new_user: true }

function harness() {
  const order: string[] = []
  const run = { id: job.runId, evaluation_key: key, execution_claim_token: '44444444-4444-4444-8444-444444444444', eligible_users: null, evaluated_at: null, pending_audit: [], result: {} }
  const store = {
    claimRun: vi.fn().mockResolvedValue(run),
    readOnly: vi.fn(async (fn: (ctx: unknown) => unknown) => fn(Object.freeze({ query: vi.fn() }))),
    saveSelection: vi.fn(async () => { order.push('snapshot') }),
    flushRunAudit: vi.fn(async () => { order.push('analytics') }),
    completeRun: vi.fn(async () => { order.push('complete') }),
    failRun: vi.fn(),
  }
  const evaluation: Evaluation = { key, everyMinutes: 1, findEligibleUsers: vi.fn(async (ctx) => {
    expect(Object.keys(ctx)).toEqual(['query'])
    return [user]
  }), handleEligibleUsers: vi.fn(async () => {
    order.push('handler')
    return { accepted: 1 }
  }) }
  return { store, evaluation, order }
}

describe('bento evaluation contracts', () => {
  it('uses four independently registered minutely evaluations and identifier-only messages', () => {
    expect(Object.values(bentoFlows).map(flow => flow.everyMinutes)).toEqual([1, 1, 1, 1])
    expect(parseDispatchJob(job)).toEqual(job)
    for (const input of [null, [], { ...job, partition: 0 }, { ...job, operation: key }, { ...job, evaluationKey: 'unknown' }, { ...job, runId: 'invalid' }])
      expect(() => parseDispatchJob(input)).toThrow('Invalid dispatch job')
  })

  it('publishes only claimed due evaluations and preserves their durable run UUID on retry', async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) }
    const store = { schedule: vi.fn().mockResolvedValueOnce({ id: job.runId, enqueue_claim_token: 'claim' }).mockResolvedValue(null), markEnqueued: vi.fn(), publicationFailed: vi.fn() }
    await publishDispatchJobs(queue, store, bentoFlows)
    expect(queue.send).toHaveBeenCalledExactlyOnceWith(job)
    expect(store.markEnqueued).toHaveBeenCalledWith(job.runId, 'claim')
  })

  it('attempts independent evaluations after a failed publication', async () => {
    const queue = { send: vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined) }
    const store = { schedule: vi.fn().mockResolvedValue({ id: job.runId, enqueue_claim_token: 'claim' }), markEnqueued: vi.fn(), publicationFailed: vi.fn() }
    await expect(publishDispatchJobs(queue, store, bentoFlows)).rejects.toThrow('Queue publication failed')
    expect(queue.send).toHaveBeenCalledTimes(4)
    expect(store.publicationFailed).toHaveBeenCalledOnce()
  })
})

describe('selection audit ordering and preservation', () => {
  it('saves the whole snapshot and completes analytics handoff before invoking the handler', async () => {
    const h = harness()
    await processDispatchJob(job, h.store as never, {} as never, h.evaluation)
    expect(h.order).toEqual(['snapshot', 'analytics', 'handler', 'complete', 'analytics'])
    expect(h.store.saveSelection).toHaveBeenCalledWith(expect.anything(), [user], expect.any(Array))
  })

  it('never reaches mutation phase when eligibility analytics cannot be queued', async () => {
    const h = harness()
    h.store.flushRunAudit.mockRejectedValue(new Error('unavailable'))
    await expect(processDispatchJob(job, h.store as never, {} as never, h.evaluation)).rejects.toThrow()
    expect(h.store.saveSelection).toHaveBeenCalledOnce()
    expect(h.evaluation.handleEligibleUsers).not.toHaveBeenCalled()
    expect(h.store.failRun).toHaveBeenCalledOnce()
  })

  it('records a safe finder failure phase for diagnosis', async () => {
    const h = harness()
    vi.mocked(h.evaluation.findEligibleUsers).mockRejectedValue(new Error('private raw error'))
    await expect(processDispatchJob(job, h.store as never, {} as never, h.evaluation)).rejects.toThrow()
    expect(h.store.failRun).toHaveBeenCalledWith(expect.anything(), 'finder')
  })

  it('records handler failure without completing the run', async () => {
    const h = harness()
    vi.mocked(h.evaluation.handleEligibleUsers).mockRejectedValue(new Error('private raw error'))
    await expect(processDispatchJob(job, h.store as never, {} as never, h.evaluation)).rejects.toThrow()
    expect(h.store.failRun).toHaveBeenCalledWith(expect.anything(), 'handler')
    expect(h.store.completeRun).not.toHaveBeenCalled()
  })

  it('reuses saved selection on a crashed run and does not rerun its finder', async () => {
    const h = harness()
    h.store.claimRun.mockResolvedValue({ id: job.runId, eligible_users: [user], evaluated_at: new Date().toISOString(), result: {} } as never)
    await processDispatchJob(job, h.store as never, {} as never, h.evaluation)
    expect(h.evaluation.findEligibleUsers).not.toHaveBeenCalled()
    expect(h.store.saveSelection).not.toHaveBeenCalled()
    expect(h.evaluation.handleEligibleUsers).toHaveBeenCalledWith(expect.anything(), [user])
  })

  it('does no finder or handler work for a duplicate with a live execution claim', async () => {
    const h = harness()
    h.store.claimRun.mockResolvedValue(null as never)
    expect(await processDispatchJob(job, h.store as never, {} as never, h.evaluation)).toEqual({ duplicate: true })
    expect(h.evaluation.findEligibleUsers).not.toHaveBeenCalled()
    expect(h.evaluation.handleEligibleUsers).not.toHaveBeenCalled()
  })

  it('reports and completes even an empty cohort', async () => {
    const h = harness()
    vi.mocked(h.evaluation.findEligibleUsers).mockResolvedValue([])
    await processDispatchJob(job, h.store as never, {} as never, h.evaluation)
    expect(h.store.saveSelection).toHaveBeenCalledWith(expect.anything(), [], expect.arrayContaining([expect.any(Object)]))
    expect(h.store.completeRun).toHaveBeenCalledOnce()
  })

  it('splits a large complete list into numbered valid events that reconstruct without truncation', () => {
    const users = Array.from({ length: 2500 }, (_, i) => ({ ...user, recipientKey: `email:recipient-${i}@example.com`, metadata: { note: '漢字'.repeat(100) } }))
    const events = buildEligibilityAudit(job.runId, key, users)
    expect(events.length).toBeGreaterThan(1)
    expect(events.every(event => messageBytes(event) <= POSTHOG_MESSAGE_MAX_BYTES && parsePostHogMessage(event))).toBe(true)
    const reconstructed = JSON.parse(`[${events.map(event => JSON.stringify(event.payload.nonPersonTags!.eligible_users).slice(1, -1)).join(',')}]`)
    expect(reconstructed).toEqual(users)
    expect(events.map(event => event.payload.nonPersonTags!.part)).toEqual(events.map((_, i) => i + 1))
    expect(events.every(event => event.payload.nonPersonTags!.parts === events.length)).toBe(true)
    expect(new Set(events.map(event => event.event_id)).size).toBe(events.length)
  })
})

it('preserves deeply nested metadata using a depth-safe analytics fragment', () => {
  const nested = { child: { child: { child: { child: { child: { label: 'domain-value' } } } } } }
  const selected = { ...user, metadata: { nested } }
  const events = buildEligibilityAudit(job.runId, key, [selected])
  expect(events.every(event => parsePostHogMessage(event))).toBe(true)
  expect(events[0]!.payload.nonPersonTags!.encoding).toBe('json-fragment')
  expect(JSON.parse(events.map(event => event.payload.nonPersonTags!.eligible_user_json).join(''))).toEqual(selected)
})

it('rejects token-bearing URLs even inside deeply nested metadata', () => {
  const selected = { ...user, metadata: { child: { child: { child: { child: { url: 'https://console.example.com/invitation?invite_magic_string=private-value' } } } } } }
  expect(() => buildEligibilityAudit(job.runId, key, [selected])).toThrow('Unsafe flow metadata')
})

it('preserves one oversized recipient through explicitly numbered JSON fragments', () => {
  const large = { ...user, metadata: { note: '漢字'.repeat(100000) } }
  const events = buildEligibilityAudit(job.runId, key, [large])
  expect(events.length).toBeGreaterThan(1)
  expect(events.every(event => parsePostHogMessage(event))).toBe(true)
  const restored = JSON.parse(events.map(event => event.payload.nonPersonTags!.eligible_user_json).join(''))
  expect(restored).toEqual(large)
  expect(new Set(events.map(event => event.payload.nonPersonTags!.fragment_id)).size).toBe(1)
})

describe('invitation reminder payloads', () => {
  it('escapes body values, keeps plain subject text and encodes the current token', () => {
    const event = buildInvitationEvent({ id: '22222222-2222-4222-8222-222222222222', tag: key }, invitation, 'https://console.example.com/')
    expect(event.data).toMatchObject({ org_name: '&lt;img src=x&gt;\nTeam', org_name_subject: '<img src=x> Team', org_admin_name: 'Someone &amp; Team', invited_first_name: '&lt;b&gt;Invitee&lt;/b&gt;', invite_link: 'https://console.example.com/invitation?invite_magic_string=secret%2Btoken' })
  })
  it.each(['http://console.example.com', 'javascript:alert(1)', 'https://user:password@console.example.com', 'https://console.example.com/?secret=1'])('rejects unsafe webapp URL %s', (url) => {
    expect(() => buildInvitationEvent({ id: 'id', tag: key }, invitation, url)).toThrow('Invalid webapp URL')
  })
})

describe('invitation source identity validation', () => {
  it.each([null, 42, false, {}, [], '', 'not-a-uuid'])('skips invalid source identity %j before querying', async (startId) => {
    const ctx = { query: vi.fn().mockResolvedValue([]) }
    const selected = { ...user, metadata: { startId } }
    expect(await resolveInvitation(ctx, selected, 'new', 1, 'https://console.example.com')).toEqual({ action: 'skip', reason: 'invalid_start_id' })
    expect(ctx.query).not.toHaveBeenCalled()
  })
  it('defaults omitted cadence options and accepts an explicit registry cadence', () => {
    expect(invitationEvaluation('new', 1).everyMinutes).toBe(1)
    expect(invitationEvaluation('new', 1, { everyMinutes: 5 }).everyMinutes).toBe(5)
  })
})

it('preserves native-recipient and fragmented-recipient ordering across multipart reports', () => {
  const first = { ...user, contextKey: 'first' }
  const large = { ...user, contextKey: 'large', metadata: { note: '😀漢字'.repeat(50000) } }
  const last = { ...user, contextKey: 'last' }
  const reports = buildEligibilityAudit(job.runId, key, [first, large, last])
  expect(reports.every(report => parsePostHogMessage(report))).toBe(true)
  expect(reports[0]!.payload.nonPersonTags!.eligible_users).toEqual([first])
  expect(reports.at(-1)!.payload.nonPersonTags!.eligible_users).toEqual([last])
  const middle = reports.slice(1, -1)
  expect(middle.every(report => report.payload.nonPersonTags!.encoding === 'json-fragment')).toBe(true)
  expect(JSON.parse(middle.map(report => report.payload.nonPersonTags!.eligible_user_json).join(''))).toEqual(large)
  expect(reports.map(report => report.payload.nonPersonTags!.part)).toEqual(reports.map((_, index) => index + 1))
  expect(reports.every(report => report.payload.nonPersonTags!.parts === reports.length)).toBe(true)
})

it('packs native lists up to the reserved byte boundary and starts a new part for one extra byte', () => {
  const first = { ...user, contextKey: 'first' }
  const second = { ...user, contextKey: 'second', metadata: { note: '' } }
  const empty = buildEligibilityAudit(job.runId, key, [])[0]!
  Object.assign(empty.payload.nonPersonTags!, { eligible_count: 2, part: 999999999, parts: 999999999 })
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  const padding = POSTHOG_MESSAGE_MAX_BYTES - messageBytes(empty) - bytes(first) - bytes(second) - 1
  second.metadata.note = 'a'.repeat(padding)
  const packed = buildEligibilityAudit(job.runId, key, [first, second])
  expect(packed).toHaveLength(1)
  expect(packed[0]!.payload.nonPersonTags!.eligible_users).toEqual([first, second])
  second.metadata.note += 'a'
  const split = buildEligibilityAudit(job.runId, key, [first, second])
  expect(split).toHaveLength(2)
  expect(split.flatMap(part => part.payload.nonPersonTags!.eligible_users)).toEqual([first, second])
  expect(split.every(part => parsePostHogMessage(part))).toBe(true)
})

it('counts UTF-8 and escaped JSON bytes when crossing the native-list boundary', () => {
  const first = { ...user, metadata: { note: '漢字😀\n"'.repeat(100) } }
  const second = { ...user, contextKey: 'second', metadata: { note: '' } }
  const empty = buildEligibilityAudit(job.runId, key, [])[0]!
  Object.assign(empty.payload.nonPersonTags!, { eligible_count: 2, part: 999999999, parts: 999999999 })
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  const padding = POSTHOG_MESSAGE_MAX_BYTES - messageBytes(empty) - bytes(first) - bytes(second) - 1
  second.metadata.note = 'a'.repeat(padding)
  expect(buildEligibilityAudit(job.runId, key, [first, second])).toHaveLength(1)
  second.metadata.note = `😀${second.metadata.note.slice(1)}`
  const parts = buildEligibilityAudit(job.runId, key, [first, second])
  expect(parts).toHaveLength(2)
  expect(parts.flatMap(part => part.payload.nonPersonTags!.eligible_users)).toEqual([first, second])
  expect(parts.every(part => messageBytes(part) <= POSTHOG_MESSAGE_MAX_BYTES && parsePostHogMessage(part))).toBe(true)
})

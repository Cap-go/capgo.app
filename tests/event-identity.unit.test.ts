import { describe, expect, it } from 'vitest'
import { acceptEventIdentity, isValidClientEventId } from '../supabase/functions/_backend/utils/event_identity.ts'

const acceptedAt = Date.parse('2026-10-06T10:00:00Z')
const clientEventId = '031c6527-7d90-442d-9abd-17f442067e20'
const input = { actorId: 'actor-a', orgId: 'org-a', clientEventId, acceptedAt }

describe('accepted event identity', () => {
  it('keeps canonical identity stable across requests while scoping it to actor and verified org', async () => {
    const first = await acceptEventIdentity(input)
    expect((await acceptEventIdentity({ ...input, acceptedAt: acceptedAt + 1000 })).event_id).toBe(first.event_id)
    expect((await acceptEventIdentity({ ...input, clientEventId: clientEventId.toUpperCase() })).event_id).toBe(first.event_id)
    const otherScopes = await Promise.all([
      acceptEventIdentity({ ...input, actorId: 'actor-b' }),
      acceptEventIdentity({ ...input, orgId: 'org-b' }),
      acceptEventIdentity({ ...input, orgId: undefined }),
    ])
    expect(new Set([first.event_id, ...otherScopes.map(value => value.event_id)]).size).toBe(4)
    expect(isValidClientEventId(first.event_id)).toBe(true)
    expect(first.event_id).not.toBe(clientEventId)
    expect(first.client_event_id).toBe(clientEventId)
  })

  it('generates independent fallback IDs and server timing for old clients', async () => {
    const first = await acceptEventIdentity({ actorId: 'actor-a', acceptedAt })
    const second = await acceptEventIdentity({ actorId: 'actor-a', acceptedAt })
    expect(first.event_id).not.toBe(second.event_id)
    expect(isValidClientEventId(first.client_event_id)).toBe(true)
    expect((await acceptEventIdentity({ actorId: 'actor-a', clientEventId: first.client_event_id, acceptedAt })).event_id).toBe(first.event_id)
    expect(first).toMatchObject({ id_source: 'server', timestamp_source: 'server', accepted_at: new Date(acceptedAt).toISOString(), occurred_at: new Date(acceptedAt).toISOString() })
  })

  it.each([acceptedAt - 1000, new Date(acceptedAt - 1000).toISOString()])('preserves reasonable client time %s', async (timestamp) => {
    expect(await acceptEventIdentity({ ...input, timestamp })).toMatchObject({ occurred_at: new Date(acceptedAt - 1000).toISOString(), timestamp_source: 'client' })
  })

  it('accepts explicit ISO offsets without changing the instant', async () => {
    expect(await acceptEventIdentity({ ...input, timestamp: '2026-10-06T12:00:00+02:00' })).toMatchObject({ occurred_at: new Date(acceptedAt).toISOString(), timestamp_source: 'client' })
  })

  it.each([
    '2026-10-06T10:00:00',
    '2026-10-06T10:00:00Z\n',
    '2026-10-06T24:00:00Z',
    '2026-10-06T10:00:00+25:00',
    '2026-02-30T10:00:00Z',
    '2026-09-31T10:00:00+02:00',
  ])('replaces timezone-free or invalid calendar/time values: %s', async (timestamp) => {
    // Keep normalized calendar dates within the allowed age window so this
    // asserts validation rather than merely observing age clamping.
    const reference = timestamp.includes('2026-02') ? Date.parse('2026-03-02T10:00:00Z') : acceptedAt
    expect(await acceptEventIdentity({ ...input, acceptedAt: reference, timestamp })).toMatchObject({ occurred_at: new Date(reference).toISOString(), timestamp_source: 'server' })
  })

  it.each([null, true, {}, '', 'invalid', Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1])('replaces malformed timestamp %s with acceptance time', async (timestamp) => {
    expect(await acceptEventIdentity({ ...input, timestamp })).toMatchObject({ occurred_at: new Date(acceptedAt).toISOString(), timestamp_source: 'server' })
  })

  it.each([0, acceptedAt + 301_000, acceptedAt - 31 * 86400_000])('clamps unreasonable timestamp %s', async (timestamp) => {
    expect(await acceptEventIdentity({ ...input, timestamp })).toMatchObject({ occurred_at: new Date(acceptedAt).toISOString(), timestamp_source: 'clamped' })
  })

  it.each([null, 123, '', 'not-a-uuid', `${clientEventId}\n`, '0'.repeat(100_000)])('rejects invalid supplied ID', (id) => {
    expect(isValidClientEventId(id)).toBe(false)
  })
})

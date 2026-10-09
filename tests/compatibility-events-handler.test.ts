import { beforeEach, describe, expect, it, vi } from 'vitest'

const PKG_V6 = [{ name: '@capacitor/core', version: '6.0.0' }]
const PKG_V7 = [{ name: '@capacitor/core', version: '7.0.0' }]

// app_versions rows the handler will load by id.
const appVersions: Record<number, { id: number, name: string, native_packages: unknown[] | null }> = {
  600: { id: 600, name: '6.0.0', native_packages: PKG_V6 },
  700: { id: 700, name: '7.0.0', native_packages: PKG_V7 },
}

const { eventStore, dedupKey, supabaseAdmin } = vi.hoisted(() => {
  const store: any[] = []
  const key = (r: any) => [r.app_id, r.channel_id, r.platform, r.current_version_id, r.previous_version_id, r.change_occurred_at].join('|')
  return { eventStore: store, dedupKey: key, supabaseAdmin: vi.fn() }
})

// A tiny chainable query builder. Each `from(table)` returns a builder whose
// terminal methods (maybeSingle / upsert / update / is) resolve against an
// in-memory model. The handler only needs the channels winner lookup to return
// "this is the sole public default" and app_versions/compatibility_events.
function makeBuilder(table: string, ctx: { appVersionsById: typeof appVersions, events: any[] }) {
  const state: any = { table, filters: {}, op: 'select' }
  const builder: any = {}
  const chain = (mutate: () => void) => {
    mutate()
    return builder
  }
  Object.assign(builder, {
    select: () => builder,
    update: (patch: any) => chain(() => Object.assign(state, { op: 'update', patch })),
    upsert: (row: any) => chain(() => Object.assign(state, { op: 'upsert', row })),
    eq: (col: string, val: any) => chain(() => { state.filters[col] = val }),
    neq: (col: string, val: any) => chain(() => { state.filters[`neq_${col}`] = val }),
    is: (col: string, val: any) => chain(() => { state.filters[`is_${col}`] = val }),
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => terminate(state, ctx),
    single: async () => terminate(state, ctx),
    then: (resolve: any, reject: any) => terminate(state, ctx).then(resolve, reject),
  })
  return builder
}

async function terminate(state: any, ctx: { appVersionsById: typeof appVersions, events: any[] }) {
  const { table, op, filters } = state

  if (table === 'channels') {
    // getCurrentChannel: select by id -> return the record as a public default.
    if (op === 'select' && filters.id != null && filters.public == null) {
      return { data: { id: filters.id, app_id: 'com.test.app', public: true, ios: true, android: false, electron: false, updated_at: 't', created_at: 't' }, error: null }
    }
    // getCurrentPublicWinner: select id where public + platform -> the record itself wins.
    if (op === 'select' && filters.public === true && filters.neq_id == null) {
      return { data: { id: filters.id ?? 101, version: 700 }, error: null }
    }
    // getPreviousDefaultChannel: excludes record.id -> no other public default (Case B).
    if (op === 'select' && filters.public === true && filters.neq_id != null) {
      return { data: null, error: null }
    }
    // demotion update -> no-op success
    if (op === 'update') {
      return { data: null, error: null }
    }
    return { data: null, error: null }
  }

  if (table === 'app_versions') {
    const row = ctx.appVersionsById[filters.id]
    return { data: row ?? null, error: null }
  }

  if (table === 'compatibility_events') {
    if (op === 'upsert') {
      const row = state.row
      const k = dedupKey(row)
      const existing = ctx.events.find(e => dedupKey(e) === k)
      if (existing) {
        // ON CONFLICT DO UPDATE: overwrite the payload columns of the existing
        // row. The insert payload never carries the resolution columns, so an
        // already-resolved row keeps its resolved_at / resolution_kind /
        // resolution_note across a redelivery.
        Object.assign(existing, row)
        return { data: null, error: null }
      }
      ctx.events.push({
        id: ctx.events.length + 1,
        resolved_at: null,
        resolved_by: null,
        resolution_kind: null,
        resolution_note: null,
        ...row,
      })
      return { data: null, error: null }
    }
    if (op === 'update') {
      const target = ctx.events.find(e => e.id === filters.id && e.resolved_at == null)
      if (target)
        Object.assign(target, state.patch)
      return { data: null, error: null }
    }
    // select unresolved for app
    const unresolved = ctx.events.filter(e => e.app_id === filters.app_id && e.resolved_at == null)
    return { data: unresolved, error: null }
  }

  return { data: null, error: null }
}

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

// Stub the API-secret guard and provide a minimal triggerValidator that mirrors
// the real one (sets webhookBody + oldRecord for UPDATE payloads).
vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => next(),
  simpleError: (code: string, message: string) => new Error(`${code}: ${message}`),
  triggerValidator: () => async (c: any, next: () => Promise<void>) => {
    const body = await c.req.json()
    if (body.type === 'UPDATE' && body.record) {
      c.set('webhookBody', body.record)
      c.set('oldRecord', body.old_record)
    }
    await next()
  },
}))

const { app } = await import('../supabase/functions/_backend/triggers/on_channel_update.ts')

function channelRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    app_id: 'com.test.app',
    owner_org: 'org-1',
    name: 'production',
    version: 700,
    public: true,
    ios: true,
    android: false,
    electron: false,
    disable_auto_update: 'major',
    created_at: 't',
    updated_at: 't',
    created_by: 'user-1',
    ...overrides,
  }
}

function updatePayload(record: Record<string, unknown>, oldRecord: Record<string, unknown>) {
  return {
    type: 'UPDATE',
    table: 'channels',
    schema: 'public',
    record,
    old_record: oldRecord,
  }
}

function post(body: unknown) {
  return app.request(new Request('http://local/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('on_channel_update compatibility events (integration)', () => {
  beforeEach(() => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.clearAllMocks()
    eventStore.length = 0
    supabaseAdmin.mockImplementation(() => ({
      from: (table: string) => makeBuilder(table, { appVersionsById: appVersions, events: eventStore }),
    }))
  })

  it('records one incompatible event on a default-channel version change (Case B)', async () => {
    const response = await post(updatePayload(channelRecord({ version: 700 }), channelRecord({ version: 600 })))

    expect(response.status).toBe(200)
    expect(eventStore).toHaveLength(1)
    expect(eventStore[0]).toMatchObject({
      app_id: 'com.test.app',
      org_id: 'org-1',
      source: 'default_channel_version_changed',
      platform: 'ios',
      channel_id: 101,
      channel_name: 'production',
      current_version_id: 700,
      current_version_name: '7.0.0',
      previous_version_id: 600,
      previous_version_name: '6.0.0',
      offenders: ['@capacitor/core'],
    })
  })

  it('is idempotent: re-POSTing the same payload does not duplicate the row', async () => {
    const payload = updatePayload(channelRecord({ version: 700 }), channelRecord({ version: 600 }))

    await post(payload)
    await post(payload)

    expect(eventStore).toHaveLength(1)
  })

  it('preserves a resolved row across a redelivery (ON CONFLICT DO UPDATE keeps resolution columns)', async () => {
    const payload = updatePayload(channelRecord({ version: 700 }), channelRecord({ version: 600 }))

    await post(payload)
    expect(eventStore).toHaveLength(1)

    // Someone (auto-resolve or manual accept) resolves the row out of band.
    Object.assign(eventStore[0], {
      resolved_at: '2026-06-03T00:00:00.000Z',
      resolved_by: 'user-9',
      resolution_kind: 'accepted',
      resolution_note: 'reviewed',
    })

    // A redelivery of the same webhook re-upserts the payload columns but must
    // NOT clobber the resolution columns (they are absent from the insert).
    await post(payload)

    expect(eventStore).toHaveLength(1)
    expect(eventStore[0]).toMatchObject({
      resolved_at: '2026-06-03T00:00:00.000Z',
      resolved_by: 'user-9',
      resolution_kind: 'accepted',
      resolution_note: 'reviewed',
    })
  })

  it('creates a NEW unresolved row when the same transition re-occurs later', async () => {
    await post(updatePayload(channelRecord({ version: 700 }), channelRecord({ version: 600 })))
    expect(eventStore).toHaveLength(1)

    // The first occurrence gets resolved (auto-resolve or manual accept).
    Object.assign(eventStore[0], {
      resolved_at: '2026-06-03T00:00:00.000Z',
      resolved_by: 'user-9',
      resolution_kind: 'accepted',
      resolution_note: 'reviewed',
    })

    // The SAME bundle pair goes live again later — a new channel update, so a
    // new `updated_at` (the occurrence identity in the dedup key). It must
    // create a fresh unresolved row instead of being absorbed by the resolved
    // first occurrence.
    await post(updatePayload(
      channelRecord({ version: 700, updated_at: 't2' }),
      channelRecord({ version: 600, updated_at: 't' }),
    ))

    expect(eventStore).toHaveLength(2)
    expect(eventStore[0].resolution_kind).toBe('accepted')
    expect(eventStore[1].resolved_at).toBeNull()
    expect(eventStore[1].change_occurred_at).toBe('t2')
  })

  it('records no event when the version change is OTA-compatible', async () => {
    // 6.0.0 -> 6.0.0 (same packages): compatible, no event. Use a distinct
    // current bundle id so it is treated as a real change but still compatible.
    appVersions[650] = { id: 650, name: '6.0.1', native_packages: PKG_V6 }
    const response = await post(updatePayload(channelRecord({ version: 650 }), channelRecord({ version: 600 })))

    expect(response.status).toBe(200)
    expect(eventStore).toHaveLength(0)
  })

  it('fans out one event per default platform (ios + android, not electron)', async () => {
    const platforms = { ios: true, android: true, electron: false }
    const response = await post(updatePayload(
      channelRecord({ version: 700, ...platforms }),
      channelRecord({ version: 600, ...platforms }),
    ))

    expect(response.status).toBe(200)
    expect(eventStore).toHaveLength(2)
    expect(eventStore.map(e => e.platform).sort()).toEqual(['android', 'ios'])
    expect(eventStore.some(e => e.platform === 'electron')).toBe(false)
  })

  it('auto-resolves an unresolved event when the default reverts to a compatible bundle', async () => {
    // The reverted default (id 800) ships v6 packages, compatible with baseline 600.
    appVersions[800] = { id: 800, name: '6.0.1', native_packages: PKG_V6 }

    // Seed one open ios event raised earlier (baseline 600 -> incompatible 700).
    eventStore.push({
      id: 1,
      app_id: 'com.test.app',
      channel_id: 101,
      platform: 'ios',
      current_version_id: 700,
      previous_version_id: 600,
      previous_version_name: '6.0.0',
      resolved_at: null,
      resolved_by: null,
      resolution_kind: null,
      resolution_note: null,
    })

    // oldRecord version equals record version -> no NEW event is created; only the
    // auto-resolve path runs against the now-compatible default (800).
    const response = await post(updatePayload(
      channelRecord({ version: 800 }),
      channelRecord({ version: 800 }),
    ))

    expect(response.status).toBe(200)
    expect(eventStore).toHaveLength(1)
    expect(eventStore[0].resolved_at).not.toBeNull()
    expect(eventStore[0].resolution_kind).toBe('auto_compatible')
    expect(eventStore[0].resolved_by).toBeNull()
  })
})

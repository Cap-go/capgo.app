import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cleanStoredImageMetadataMock,
  createApiKeyMock,
  syncBentoFirstOrgOnEmailChangeMock,
  syncUserPreferenceTagsMock,
} = vi.hoisted(() => ({
  cleanStoredImageMetadataMock: vi.fn(async () => undefined),
  createApiKeyMock: vi.fn(async () => undefined),
  syncBentoFirstOrgOnEmailChangeMock: vi.fn(async () => true as boolean | undefined),
  syncUserPreferenceTagsMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento_first_org.ts', () => ({
  syncBentoFirstOrgOnEmailChange: syncBentoFirstOrgOnEmailChangeMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

vi.mock('../supabase/functions/_backend/utils/image.ts', () => ({
  cleanStoredImageMetadata: cleanStoredImageMetadataMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  createApiKey: createApiKeyMock,
}))

vi.mock('../supabase/functions/_backend/utils/user_preferences.ts', () => ({
  syncUserPreferenceTags: syncUserPreferenceTagsMock,
}))

const { app } = await import('../supabase/functions/_backend/triggers/on_user_update.ts')

const USER_ID = '11111111-1111-4111-8111-111111111111'

function userRecord(email: string, overrides: Record<string, unknown> = {}) {
  return {
    ban_time: null,
    country: null,
    created_at: '2026-08-03T08:30:00.000Z',
    created_via_invite: false,
    discord_username: null,
    email,
    email_preferences: {},
    enable_notifications: false,
    first_name: 'User',
    format_locale: null,
    github_id: null,
    github_username: null,
    id: USER_ID,
    image_url: null,
    last_name: 'Example',
    opt_for_newsletters: false,
    updated_at: '2026-08-03T09:00:00.000Z',
    ...overrides,
  }
}

async function postUpdate(record: ReturnType<typeof userRecord>, oldRecord: ReturnType<typeof userRecord>) {
  return await app.request('http://local/', {
    body: JSON.stringify({
      old_record: oldRecord,
      record,
      schema: 'public',
      table: 'users',
      type: 'UPDATE',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe('user update Bento subscriber identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncBentoFirstOrgOnEmailChangeMock.mockResolvedValue(true)
  })

  it('suppresses both aliases before applying a simultaneous preference change', async () => {
    const lifecycleTrace: string[] = []
    syncBentoFirstOrgOnEmailChangeMock.mockImplementation(async () => {
      lifecycleTrace.push('aliases:suppressed')
    })
    syncUserPreferenceTagsMock.mockImplementation(async () => {
      lifecycleTrace.push('preferences:synced')
    })
    const oldRecord = userRecord(' Old.User@Example.COM ', { enable_notifications: false })
    const record = userRecord(' New.User@Example.COM ', { enable_notifications: true })

    const response = await postUpdate(record, oldRecord)

    expect(response.status).toBe(200)
    expect(lifecycleTrace).toEqual(['aliases:suppressed', 'preferences:synced'])
    expect(syncBentoFirstOrgOnEmailChangeMock).toHaveBeenCalledWith(
      expect.anything(),
      'old.user@example.com',
      'new.user@example.com',
    )
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      record.email,
      record,
      oldRecord,
      oldRecord.email,
    )
  })

  it('keeps the existing preference sync and sends no command when the email is unchanged', async () => {
    const oldRecord = userRecord('same@example.com', { enable_notifications: false })
    const record = userRecord('same@example.com', { enable_notifications: true })

    const response = await postUpdate(record, oldRecord)

    expect(response.status).toBe(200)
    expect(syncBentoFirstOrgOnEmailChangeMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      record.email,
      record,
      oldRecord,
      oldRecord.email,
    )
  })

  it('sends no command when old and new emails differ only by normalization', async () => {
    const oldRecord = userRecord(' Same.User@Example.COM ')
    const record = userRecord('same.user@example.com')

    const response = await postUpdate(record, oldRecord)

    expect(response.status).toBe(200)
    expect(syncBentoFirstOrgOnEmailChangeMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      record.email,
      record,
      oldRecord,
      oldRecord.email,
    )
  })

  it.each([
    ['returns false', () => syncBentoFirstOrgOnEmailChangeMock.mockResolvedValueOnce(false)],
    ['throws', () => syncBentoFirstOrgOnEmailChangeMock.mockRejectedValueOnce(new Error('Bento unavailable'))],
  ])('returns 5xx before preference sync when suppression delivery %s', async (_label, configureFailure) => {
    configureFailure()

    const response = await postUpdate(userRecord('new@example.com'), userRecord('old@example.com'))

    expect(response.status).toBe(500)
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
  })

  it('does not move the subscriber when earlier image cleanup fails', async () => {
    cleanStoredImageMetadataMock.mockRejectedValueOnce(new Error('Storage unavailable'))
    const oldRecord = userRecord('old@example.com', { image_url: 'old/avatar.png' })
    const record = userRecord('new@example.com', { image_url: 'new/avatar.png' })

    const response = await postUpdate(record, oldRecord)

    expect(response.status).toBe(500)
    expect(syncBentoFirstOrgOnEmailChangeMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
  })

  it('continues preference sync when suppression is an unconfigured no-op', async () => {
    syncBentoFirstOrgOnEmailChangeMock.mockResolvedValue(undefined)
    const record = userRecord('new@example.com')
    const oldRecord = userRecord('old@example.com')

    const response = await postUpdate(record, oldRecord)

    expect(response.status).toBe(200)
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledWith(
      expect.anything(),
      record.email,
      record,
      oldRecord,
      oldRecord.email,
    )
  })

  it('contains no legacy Bento email migration command or helper', async () => {
    const [bentoSource, triggerSource] = await Promise.all([
      readFile(new URL('../supabase/functions/_backend/utils/bento.ts', import.meta.url), 'utf8'),
      readFile(new URL('../supabase/functions/_backend/triggers/on_user_update.ts', import.meta.url), 'utf8'),
    ])
    const legacyCommand = ['change', 'email'].join('_')
    const legacyHelper = ['change', 'Email', 'Bento'].join('')

    expect(bentoSource).not.toContain(legacyCommand)
    expect(bentoSource).not.toContain(legacyHelper)
    expect(triggerSource).not.toContain(legacyCommand)
    expect(triggerSource).not.toContain(legacyHelper)
  })
})

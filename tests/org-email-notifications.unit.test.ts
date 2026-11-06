import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../supabase/functions/_backend/utils/postgres_schema.ts'

const {
  claimNotifOrgOnceMock,
  closeClientMock,
  cloudlogMock,
  getDrizzleClientMock,
  getPgClientMock,
  hasNotifOrgClaimMock,
  isBentoConfiguredMock,
  logPgErrorMock,
  sendNotifOrgMock,
  sendNotifOrgOnceMock,
} = vi.hoisted(() => ({
  closeClientMock: vi.fn(),
  claimNotifOrgOnceMock: vi.fn(),
  cloudlogMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
  hasNotifOrgClaimMock: vi.fn(),
  isBentoConfiguredMock: vi.fn(),
  logPgErrorMock: vi.fn(),
  sendNotifOrgMock: vi.fn(),
  sendNotifOrgOnceMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: isBentoConfiguredMock,
  trackBentoEvent: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
}))

vi.mock('../supabase/functions/_backend/utils/notifications.ts', () => ({
  // Tests drive the boolean claim outcome; 'failed' passes through for write errors.
  claimNotifOrgOnceWithResult: async (...args: unknown[]) => {
    const result = await claimNotifOrgOnceMock(...args)
    return result === true ? 'claimed' : result === false ? 'already_claimed' : result
  },
  buildNotifDeliveryUniqId: (uniqId: string) => `${uniqId}:delivered`,
  hasNotifOrgClaim: hasNotifOrgClaimMock,
  sendNotifOrg: sendNotifOrgMock,
  sendNotifOrgOnce: sendNotifOrgOnceMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => {
  const actual = await vi.importActual<typeof import('../supabase/functions/_backend/utils/pg.ts')>('../supabase/functions/_backend/utils/pg.ts')
  return {
    ...actual,
    closeClient: closeClientMock,
    getDrizzleClient: getDrizzleClientMock,
    getPgClient: getPgClientMock,
    logPgError: logPgErrorMock,
  }
})

const {
  orgEmailNotificationTestUtils,
  sendEmailToOrgMembers,
  sendNotifToOrgMembersOnce,
  sendNotifToOrgMembersOnceWithResult,
} = await import('../supabase/functions/_backend/utils/org_email_notifications.ts')

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

function createDrizzleStub(options?: {
  adminUsers?: { id: string, email: string, email_preferences?: Record<string, boolean> }[]
  failTables?: string[]
  kind?: string
  managementEmail?: string
}) {
  const adminUsers = options?.adminUsers ?? []
  const failTables = new Set(options?.failTables ?? [])
  const kind = options?.kind
  const managementEmail = options?.managementEmail ?? 'billing@example.com'

  const getRowsForTable = (table: any): any[] => {
    if (table === schema.orgs && failTables.has('orgs'))
      throw new Error('orgs lookup failed')
    if (table === schema.org_users && failTables.has('org_users'))
      throw new Error('org_users lookup failed')
    if (table === schema.role_bindings && failTables.has('role_bindings'))
      throw new Error('role_bindings lookup failed')
    if (table === schema.group_members && failTables.has('group_members'))
      throw new Error('group_members lookup failed')
    if (table === schema.users && failTables.has('users'))
      throw new Error('users lookup failed')

    if (table === schema.orgs) {
      return [{ management_email: managementEmail, email_preferences: { onboarding: true } }]
    }
    if (table === schema.org_users) {
      return adminUsers.map(user => ({ user_id: user.id }))
    }
    if (
      table === schema.role_bindings
    ) {
      return adminUsers.map(user => ({ principal_id: user.id, expires_at: null }))
    }
    if (
      table === schema.group_members
    ) {
      return []
    }
    if (table === schema.users) {
      return adminUsers.map(user => ({
        id: user.id,
        email: user.email,
        email_preferences: user.email_preferences ?? { onboarding: true },
      }))
    }

    return []
  }

  return {
    kind,
    select() {
      const query = {
        currentTable: undefined as any,
        from(table: any) {
          this.currentTable = table
          return this
        },
        innerJoin() {
          return this
        },
        where() {
          return this
        },
        limit(limitCount: number) {
          const rows = getRowsForTable(this.currentTable)
          return Promise.resolve(rows.slice(0, limitCount))
        },
        then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
          const rows = getRowsForTable(this.currentTable)
          return Promise.resolve(rows).then(resolve, reject)
        },
      }

      return query
    },
  } as any
}

function sendOnboardingOnce(client: unknown) {
  return sendNotifToOrgMembersOnce(
    createContext(),
    'user:need_onboarding',
    'onboarding',
    { org_id: 'org-123' },
    'org-123',
    'org-123',
    client as any,
  )
}

function sendRetentionOnceWithResult(client: unknown) {
  return sendNotifToOrgMembersOnceWithResult(
    createContext(),
    'org:apps_will_be_deleted',
    'onboarding',
    { org_id: 'org-123' },
    'org-123',
    'retention:app_deletion_warning:2026-01-01T00:00:00Z',
    client as any,
    'admins',
    { recordDelivery: true },
  )
}

function sendDowngradeOnceWithResult(client: unknown) {
  return sendNotifToOrgMembersOnceWithResult(
    createContext(),
    'device:downgrade_blocked',
    'device_error',
    { app_id: 'com.test.app' },
    'org-123',
    'com.test.app',
    client as any,
  )
}

describe('org email notification recipient selection', () => {
  it.concurrent('prefers the management email when it is eligible', () => {
    expect(
      orgEmailNotificationTestUtils.getEligibleEmailTargets(
        ['admin1@example.com', 'admin2@example.com'],
        'billing@example.com',
      ),
    ).toEqual({
      allEmails: ['admin1@example.com', 'admin2@example.com', 'billing@example.com'],
      primaryEmail: 'billing@example.com',
      additionalEmails: ['admin1@example.com', 'admin2@example.com'],
    })
  })

  it.concurrent('falls back to the first admin when the management email is not eligible', () => {
    expect(
      orgEmailNotificationTestUtils.getEligibleEmailTargets(
        ['admin1@example.com', 'admin2@example.com'],
        null,
      ),
    ).toEqual({
      allEmails: ['admin1@example.com', 'admin2@example.com'],
      primaryEmail: 'admin1@example.com',
      additionalEmails: ['admin2@example.com'],
    })
  })
})

describe('sendNotifToOrgMembersOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeClientMock.mockResolvedValue(undefined)
    isBentoConfiguredMock.mockReturnValue(true)
    hasNotifOrgClaimMock.mockResolvedValue(false)
    getPgClientMock.mockReturnValue({ id: 'owned-pg-client' } as any)
    getDrizzleClientMock.mockReturnValue(createDrizzleStub({
      adminUsers: [{ id: 'admin-1', email: 'admin@example.com' }],
      kind: 'write-client',
    }))
  })

  it('closes its owned primary reader when recipient lookup returns no organization', async () => {
    getDrizzleClientMock.mockReturnValue(createDrizzleStub({ failTables: ['orgs'] }))
    await expect(sendEmailToOrgMembers(createContext(), 'user:need_onboarding', 'onboarding', {}, 'test-org')).resolves.toBe(0)
    expect(closeClientMock).toHaveBeenCalledWith(expect.anything(), { id: 'owned-pg-client' })
  })

  it('leaves an injected notification reader owned by its caller', async () => {
    await sendEmailToOrgMembers(createContext(), 'user:need_onboarding', 'onboarding', {}, 'test-org', createDrizzleStub({ failTables: ['orgs'] }))
    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(closeClientMock).not.toHaveBeenCalled()
  })

  it('treats an existing org-level claim as already delivered without sending recipients again', async () => {
    hasNotifOrgClaimMock.mockResolvedValue(true)

    const sent = await sendOnboardingOnce({})

    expect(sent).toBe(false)
    expect(hasNotifOrgClaimMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'write-client' }),
      'user:need_onboarding',
      'org-123',
      'org-123',
    )
    expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledWith(expect.anything(), { id: 'owned-pg-client' })
  })
  it('reports an existing org-level claim as terminal and a failed claim lookup as retryable', async () => {
    const send = () => sendDowngradeOnceWithResult({})

    hasNotifOrgClaimMock.mockResolvedValue(true)
    await expect(send()).resolves.toBe('already_claimed')

    hasNotifOrgClaimMock.mockResolvedValue(null)
    await expect(send()).resolves.toBe('failed')
    expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
  })

  it('keeps org lookup failures retryable instead of reporting a missing org', async () => {
    getDrizzleClientMock.mockReturnValue(createDrizzleStub({ failTables: ['orgs'], kind: 'write-client' }))

    await expect(sendDowngradeOnceWithResult({})).resolves.toBe('failed')
    expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
  })

  it('keeps org claim write failures retryable and reports duplicate claims as terminal', async () => {
    hasNotifOrgClaimMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const send = () => sendDowngradeOnceWithResult(createDrizzleStub())

    claimNotifOrgOnceMock.mockResolvedValue('failed')
    await expect(send()).resolves.toBe('failed')

    hasNotifOrgClaimMock
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    claimNotifOrgOnceMock.mockResolvedValue(false)
    await expect(send()).resolves.toBe('already_claimed')
  })

  it('fails closed when the org-level claim lookup errors', async () => {
    hasNotifOrgClaimMock.mockResolvedValue(null)

    const sent = await sendOnboardingOnce({})

    expect(sent).toBe(false)
    expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sendNotifToOrgMembersOnce: org claim lookup failed',
      orgId: 'org-123',
      uniqId: 'org-123',
    }))
  })

  it('backfills the org-level claim once all recipient claims already exist', async () => {
    hasNotifOrgClaimMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    claimNotifOrgOnceMock.mockResolvedValue(true)

    const sent = await sendOnboardingOnce(createDrizzleStub())

    expect(sent).toBe(true)
    expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(claimNotifOrgOnceMock).toHaveBeenCalledWith(
      expect.anything(),
      'user:need_onboarding',
      'org-123',
      'org-123',
      expect.anything(),
    )
    expect(hasNotifOrgClaimMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ kind: 'write-client' }),
      'user:need_onboarding',
      'org-123',
      expect.any(String),
    )
  })

  it('returns false when recipient claims exist but the org-level backfill claim fails', async () => {
    hasNotifOrgClaimMock
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    claimNotifOrgOnceMock.mockResolvedValue(false)

    const sent = await sendOnboardingOnce(createDrizzleStub())

    expect(sent).toBe(false)
    expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(claimNotifOrgOnceMock).toHaveBeenCalledWith(
      expect.anything(),
      'user:need_onboarding',
      'org-123',
      'org-123',
      expect.anything(),
    )
  })

  it('does not write the org-level claim when any unsent recipient is not already claimed', async () => {
    sendNotifOrgOnceMock
      .mockResolvedValueOnce({ sent: true, cleanupFailed: false })
      .mockResolvedValueOnce({ sent: false, cleanupFailed: false })
    hasNotifOrgClaimMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)

    const sent = await sendOnboardingOnce(createDrizzleStub({
      adminUsers: [{ id: 'admin-1', email: 'admin@example.com' }],
    }))

    expect(sent).toBe(false)
    expect(sendNotifOrgOnceMock).toHaveBeenCalledTimes(2)
    expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
  })

  it('does not write the org-level claim when recipient cleanup fails', async () => {
    sendNotifOrgOnceMock.mockResolvedValue({ sent: false, cleanupFailed: true })

    const sent = await sendOnboardingOnce(createDrizzleStub())

    expect(sent).toBe(false)
    expect(hasNotifOrgClaimMock).toHaveBeenCalledTimes(3)
    expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sendNotifToOrgMembersOnce: recipient cleanup failed',
      cleanupFailedRecipients: ['billing@example.com', 'admin@example.com'],
    }))
  })

  it('reads one-time recipients from the primary client before finalizing the org claim', async () => {
    const primaryClient = createDrizzleStub({
      adminUsers: [{ id: 'admin-1', email: 'admin@example.com' }],
      managementEmail: '',
      kind: 'write-client',
    })
    getDrizzleClientMock.mockReturnValue(primaryClient)
    claimNotifOrgOnceMock.mockResolvedValue(true)
    sendNotifOrgOnceMock.mockResolvedValue({ sent: true, cleanupFailed: false })

    const sent = await sendOnboardingOnce(createDrizzleStub())

    expect(sent).toBe(true)
    expect(sendNotifOrgOnceMock).toHaveBeenCalledTimes(1)
    expect(sendNotifOrgOnceMock).toHaveBeenCalledWith(
      expect.anything(),
      'user:need_onboarding',
      { org_id: 'org-123' },
      'org-123',
      expect.any(String),
      'admin@example.com',
      expect.anything(),
      primaryClient,
      { recordDelivery: false },
    )
    expect(claimNotifOrgOnceMock).toHaveBeenCalledWith(
      expect.anything(),
      'user:need_onboarding',
      'org-123',
      'org-123',
      primaryClient,
    )
  })

  it('fails closed when recipient discovery is incomplete on the one-time path', async () => {
    const primaryClient = createDrizzleStub({
      adminUsers: [{ id: 'admin-1', email: 'admin@example.com' }],
      failTables: ['role_bindings'],
      kind: 'write-client',
    })
    getDrizzleClientMock.mockReturnValue(primaryClient)

    const sent = await sendOnboardingOnce(createDrizzleStub())

    expect(sent).toBe(false)
    expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
    expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'sendNotifToOrgMembersOnce: recipient resolution failed',
      orgId: 'org-123',
    }))
  })

  describe('with recordDelivery', () => {
    it('asks each recipient send to record a delivery marker', async () => {
      sendNotifOrgOnceMock.mockResolvedValue({ sent: true, cleanupFailed: false })
      claimNotifOrgOnceMock.mockResolvedValue(true)

      await expect(sendRetentionOnceWithResult(createDrizzleStub())).resolves.toBe('sent')

      expect(sendNotifOrgOnceMock).toHaveBeenCalledTimes(2)
      for (const call of sendNotifOrgOnceMock.mock.calls)
        expect(call[8]).toEqual({ recordDelivery: true })
      expect(claimNotifOrgOnceMock).toHaveBeenCalledWith(
        expect.anything(),
        'org:apps_will_be_deleted',
        'org-123',
        'retention:app_deletion_warning:2026-01-01T00:00:00Z',
        expect.anything(),
      )
    })

    it('does not backfill the org claim from recipient claims that have no delivery marker', async () => {
      // Org claim missing, both recipient claims present (a failed send may
      // have left them behind), no delivery markers.
      hasNotifOrgClaimMock.mockImplementation(async (_c: unknown, _client: unknown, _event: string, _org: string, uniqId: string) => {
        if (uniqId === 'retention:app_deletion_warning:2026-01-01T00:00:00Z')
          return false
        return !uniqId.endsWith(':delivered')
      })

      await expect(sendRetentionOnceWithResult(createDrizzleStub())).resolves.toBe('already_claimed')

      expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
      expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
    })

    it('backfills the org claim when an earlier send recorded its delivery', async () => {
      hasNotifOrgClaimMock.mockImplementation(async (_c: unknown, _client: unknown, _event: string, _org: string, uniqId: string) =>
        uniqId !== 'retention:app_deletion_warning:2026-01-01T00:00:00Z')
      claimNotifOrgOnceMock.mockResolvedValue(true)

      await expect(sendRetentionOnceWithResult(createDrizzleStub())).resolves.toBe('sent')

      expect(sendNotifOrgOnceMock).not.toHaveBeenCalled()
      expect(claimNotifOrgOnceMock).toHaveBeenCalledWith(
        expect.anything(),
        'org:apps_will_be_deleted',
        'org-123',
        'retention:app_deletion_warning:2026-01-01T00:00:00Z',
        expect.anything(),
      )
    })

    it('stays retryable when a delivery marker lookup fails', async () => {
      hasNotifOrgClaimMock.mockImplementation(async (_c: unknown, _client: unknown, _event: string, _org: string, uniqId: string) => {
        if (uniqId === 'retention:app_deletion_warning:2026-01-01T00:00:00Z')
          return false
        return uniqId.endsWith(':delivered') ? null : true
      })

      await expect(sendRetentionOnceWithResult(createDrizzleStub())).resolves.toBe('failed')
      expect(claimNotifOrgOnceMock).not.toHaveBeenCalled()
    })

    it('claims a distinct no-recipient id so it never reads as a delivered warning', async () => {
      getDrizzleClientMock.mockReturnValue(createDrizzleStub({ managementEmail: '', kind: 'write-client' }))
      claimNotifOrgOnceMock.mockResolvedValue(true)

      await expect(sendRetentionOnceWithResult(createDrizzleStub())).resolves.toBe('no_recipients')

      expect(claimNotifOrgOnceMock).toHaveBeenCalledWith(
        expect.anything(),
        'org:apps_will_be_deleted',
        'org-123',
        'retention:app_deletion_warning:2026-01-01T00:00:00Z:no_recipients',
        expect.anything(),
      )
    })
  })
})

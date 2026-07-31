import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  cloudlogMock,
  getDrizzleClientMock,
  getPgClientMock,
  logPgErrorMock,
  trackBentoEventMock,
} = vi.hoisted(() => ({
  closeClientMock: vi.fn(),
  cloudlogMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
  logPgErrorMock: vi.fn(),
  trackBentoEventMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  trackBentoEvent: trackBentoEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
  cloudlogErr: vi.fn(),
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

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

function createWriteClient(options?: { deleteError?: Error }) {
  const returningMock = vi.fn().mockResolvedValue([{}])
  const onConflictDoNothingMock = vi.fn(() => ({ returning: returningMock }))
  const valuesMock = vi.fn(() => ({ onConflictDoNothing: onConflictDoNothingMock }))
  const insertMock = vi.fn(() => ({ values: valuesMock }))
  const whereMock = options?.deleteError
    ? vi.fn().mockRejectedValue(options.deleteError)
    : vi.fn().mockResolvedValue(undefined)
  const deleteMock = vi.fn(() => ({ where: whereMock }))

  return {
    client: {
      insert: insertMock,
      delete: deleteMock,
    } as any,
    deleteMock,
    whereMock,
  }
}
function createReadClient(notification: { last_send_at: Date, total_send: number } | null) {
  const limitMock = vi.fn(async () => notification ? [notification] : [])
  const whereMock = vi.fn(() => ({ limit: limitMock }))
  const fromMock = vi.fn(() => ({ where: whereMock }))
  const selectMock = vi.fn(() => ({ from: fromMock }))

  return {
    client: {
      select: selectMock,
    } as any,
    limitMock,
  }
}

function createSendWriteClient() {
  const insertReturningMock = vi.fn().mockResolvedValue([{}])
  const onConflictDoNothingMock = vi.fn(() => ({ returning: insertReturningMock }))
  const valuesMock = vi.fn(() => ({ onConflictDoNothing: onConflictDoNothingMock }))
  const insertMock = vi.fn(() => ({ values: valuesMock }))

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined)
  const deleteMock = vi.fn(() => ({ where: deleteWhereMock }))

  const updateReturningMock = vi.fn().mockResolvedValue([{}])
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }))
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }))
  const updateMock = vi.fn(() => ({ set: updateSetMock }))

  return {
    client: {
      delete: deleteMock,
      insert: insertMock,
      update: updateMock,
    } as any,
    deleteMock,
    deleteWhereMock,
    insertMock,
    updateMock,
    updateSetMock,
  }
}

describe.sequential('sendNotifOrgOnce', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
  })

  it('deletes the recipient claim when Bento throws', async () => {
    trackBentoEventMock.mockRejectedValue(new Error('bento exploded'))
    const { client, deleteMock, whereMock } = createWriteClient()

    const { sendNotifOrgOnce } = await import('../supabase/functions/_backend/utils/notifications.ts')

    const sent = await sendNotifOrgOnce(
      createContext(),
      'user:need_onboarding',
      { org_id: 'org-123' },
      'org-123',
      'org-123:recipient',
      'billing@example.com',
      {} as any,
      client,
    )

    expect(sent).toEqual({ sent: false, cleanupFailed: false })
    expect(deleteMock).toHaveBeenCalledTimes(1)
    expect(whereMock).toHaveBeenCalledTimes(1)
    expect(logPgErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      'sendNotifOrgOnce',
      expect.any(Error),
    )
  })

  it('surfaces cleanup failure when the recipient claim cannot be deleted', async () => {
    trackBentoEventMock.mockResolvedValue(false)
    const { client } = createWriteClient({ deleteError: new Error('delete exploded') })

    const { sendNotifOrgOnce } = await import('../supabase/functions/_backend/utils/notifications.ts')

    const sent = await sendNotifOrgOnce(
      createContext(),
      'user:need_onboarding',
      { org_id: 'org-123' },
      'org-123',
      'org-123:recipient',
      'billing@example.com',
      {} as any,
      client,
    )

    expect(sent).toEqual({ sent: false, cleanupFailed: true })
    expect(logPgErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      'sendNotifOrgOnce cleanup',
      expect.any(Error),
    )
  })
})

describe.sequential('sendNotifOrg', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
  })

  it('deletes the first-send claim when Bento returns false', async () => {
    trackBentoEventMock.mockResolvedValue(false)
    const readClient = createReadClient(null)
    const writeClient = createSendWriteClient()
    const pgClient = { id: 'pg-client' }
    getPgClientMock.mockReturnValue(pgClient)
    getDrizzleClientMock.mockReturnValue(writeClient.client)
    closeClientMock.mockResolvedValue(undefined)

    const { sendNotifOrg } = await import('../supabase/functions/_backend/utils/notifications.ts')

    const sent = await sendNotifOrg(
      createContext(),
      'org:missing_payment',
      { org_id: 'org-123' },
      'org-123',
      'org-123:billing',
      '0 0 * * *',
      'billing@example.com',
      readClient.client,
    )

    expect(sent).toBe(false)
    expect(writeClient.insertMock).toHaveBeenCalledTimes(1)
    expect(writeClient.deleteMock).toHaveBeenCalledTimes(1)
    expect(writeClient.deleteWhereMock).toHaveBeenCalledTimes(1)
    expect(writeClient.updateMock).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledWith(expect.anything(), pgClient)
  })

  it('restores the previous send claim when Bento returns false after an update claim', async () => {
    trackBentoEventMock.mockResolvedValue(false)
    const previousLastSendAt = new Date('2026-01-01T00:00:00.000Z')
    const readClient = createReadClient({ last_send_at: previousLastSendAt, total_send: 3 })
    const writeClient = createSendWriteClient()
    const pgClient = { id: 'pg-client' }
    getPgClientMock.mockReturnValue(pgClient)
    getDrizzleClientMock.mockReturnValue(writeClient.client)
    closeClientMock.mockResolvedValue(undefined)

    const { sendNotifOrg } = await import('../supabase/functions/_backend/utils/notifications.ts')

    const sent = await sendNotifOrg(
      createContext(),
      'org:missing_payment',
      { org_id: 'org-123' },
      'org-123',
      'org-123:billing',
      '0 0 * * *',
      'billing@example.com',
      readClient.client,
    )

    expect(sent).toBe(false)
    expect(writeClient.updateMock).toHaveBeenCalledTimes(2)
    expect(writeClient.updateSetMock).toHaveBeenNthCalledWith(2, {
      last_send_at: previousLastSendAt,
      total_send: 3,
    })
    expect(writeClient.deleteMock).not.toHaveBeenCalled()
    expect(closeClientMock).toHaveBeenCalledWith(expect.anything(), pgClient)
  })
})

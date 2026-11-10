import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendSchema from '../supabase/functions/_backend/utils/postgres_schema.ts'
import * as pluginSchema from '../supabase/functions/_backend/plugin_runtime/utils/postgres_schema.ts'
import { isUserEmailPreferenceEnabled as isUserEmailPreferenceEnabledBackend, orgEmailNotificationTestUtils as backendOrgEmailTestUtils } from '../supabase/functions/_backend/utils/org_email_notifications.ts'
import { isUserEmailPreferenceEnabled as isUserEmailPreferenceEnabledPlugin, orgEmailNotificationTestUtils as pluginOrgEmailTestUtils } from '../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts'

const { isBentoConfiguredMock, trackBentoEventMock, closeClientMock, getPgClientMock } = vi.hoisted(() => ({
  isBentoConfiguredMock: vi.fn(),
  trackBentoEventMock: vi.fn(),
  closeClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: isBentoConfiguredMock,
  trackBentoEvent: trackBentoEventMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/bento.ts', () => ({
  isBentoConfigured: isBentoConfiguredMock,
  trackBentoEvent: trackBentoEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => {
  const actual = await vi.importActual<typeof import('../supabase/functions/_backend/utils/pg.ts')>('../supabase/functions/_backend/utils/pg.ts')
  return {
    ...actual,
    closeClient: closeClientMock,
    getPgClient: getPgClientMock,
  }
})

const { sendEmailToOrgMembers: sendEmailToOrgMembersBackend } = await import('../supabase/functions/_backend/utils/org_email_notifications.ts')
const { sendEmailToOrgMembers: sendEmailToOrgMembersPlugin } = await import('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts')

const helpers = [
  { name: 'backend', fn: isUserEmailPreferenceEnabledBackend },
  { name: 'plugin_runtime', fn: isUserEmailPreferenceEnabledPlugin },
] as const

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
    req: {
      header: () => undefined,
    },
  } as any
}

function createDrizzleStub(
  schema: typeof backendSchema | typeof pluginSchema,
  adminUsers: { id: string, email: string, email_preferences?: Record<string, boolean> }[],
) {
  return {
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
          const rows = getRowsForTable(schema, adminUsers, this.currentTable)
          return Promise.resolve(rows.slice(0, limitCount))
        },
        then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
          const rows = getRowsForTable(schema, adminUsers, this.currentTable)
          return Promise.resolve(rows).then(resolve, reject)
        },
      }
      return query
    },
  } as any
}

function getRowsForTable(
  schema: typeof backendSchema | typeof pluginSchema,
  adminUsers: { id: string, email: string, email_preferences?: Record<string, boolean> }[],
  table: any,
): any[] {
  if (table === schema.orgs)
    return [{ management_email: '', email_preferences: { security_updates: true } }]
  if (table === schema.org_users)
    return adminUsers.map(user => ({ user_id: user.id }))
  if (table === schema.role_bindings)
    return adminUsers.map(user => ({ principal_id: user.id, expires_at: null }))
  if (table === schema.group_members)
    return []
  if (table === schema.users) {
    return adminUsers.map(user => ({
      id: user.id,
      email: user.email,
      email_preferences: user.email_preferences ?? {},
    }))
  }
  return []
}

describe('security_updates email preference', () => {
  it.each(helpers)('defaults security_updates to disabled in $name', ({ fn }) => {
    expect(fn({}, 'security_updates')).toBe(false)
    expect(fn({ weekly_stats: true }, 'security_updates')).toBe(false)
  })

  it.each(helpers)('enables security_updates only when explicitly true in $name', ({ fn }) => {
    expect(fn({ security_updates: true }, 'security_updates')).toBe(true)
    expect(fn({ security_updates: false }, 'security_updates')).toBe(false)
  })

  it.each(helpers)('keeps default-on semantics for other preferences in $name', ({ fn }) => {
    expect(fn({}, 'weekly_stats')).toBe(true)
    expect(fn({ weekly_stats: false }, 'weekly_stats')).toBe(false)
  })
})

describe('security_updates org recipient selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isBentoConfiguredMock.mockReturnValue(true)
    trackBentoEventMock.mockResolvedValue(undefined)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockReturnValue({ id: 'pg-client' })
  })

  it('backend getEligibleOrgMemberEmails keeps only explicit opt-ins', async () => {
    const drizzle = createDrizzleStub(backendSchema, [
      { id: 'u1', email: 'opted-in@example.com', email_preferences: { security_updates: true } },
      { id: 'u2', email: 'default-off@example.com', email_preferences: {} },
    ])
    const { emails } = await backendOrgEmailTestUtils.getEligibleOrgMemberEmails(
      createContext(),
      'org-123',
      'security_updates',
      drizzle,
    )
    expect(emails).toEqual(['opted-in@example.com'])
  })

  it('plugin_runtime getEligibleOrgMemberEmails keeps only explicit opt-ins', async () => {
    const drizzle = createDrizzleStub(pluginSchema, [
      { id: 'u1', email: 'opted-in@example.com', email_preferences: { security_updates: true } },
      { id: 'u2', email: 'default-off@example.com', email_preferences: {} },
    ])
    const { emails } = await pluginOrgEmailTestUtils.getEligibleOrgMemberEmails(
      createContext(),
      'org-123',
      'security_updates',
      drizzle,
    )
    expect(emails).toEqual(['opted-in@example.com'])
  })

  it('plugin_runtime sendEmailToOrgMembers queues only opted-in admins', async () => {
    const drizzle = createDrizzleStub(pluginSchema, [
      { id: 'u1', email: 'opted-in@example.com', email_preferences: { security_updates: true } },
      { id: 'u2', email: 'default-off@example.com', email_preferences: {} },
    ])
    const sent = await sendEmailToOrgMembersPlugin(
      createContext(),
      'user:security_update',
      'security_updates',
      { org_id: 'org-123' },
      'org-123',
      drizzle,
    )
    expect(sent).toBe(1)
    expect(trackBentoEventMock).toHaveBeenCalledTimes(1)
    expect(trackBentoEventMock.mock.calls[0]?.[1]).toBe('opted-in@example.com')
  })

  it('backend sendEmailToOrgMembers queues only opted-in admins', async () => {
    const drizzle = createDrizzleStub(backendSchema, [
      { id: 'u1', email: 'opted-in@example.com', email_preferences: { security_updates: true } },
      { id: 'u2', email: 'default-off@example.com', email_preferences: {} },
    ])
    const sent = await sendEmailToOrgMembersBackend(
      createContext(),
      'user:security_update',
      'security_updates',
      { org_id: 'org-123' },
      'org-123',
      drizzle,
    )
    expect(sent).toBe(1)
    expect(trackBentoEventMock).toHaveBeenCalledTimes(1)
    expect(trackBentoEventMock.mock.calls[0]?.[1]).toBe('opted-in@example.com')
  })
})

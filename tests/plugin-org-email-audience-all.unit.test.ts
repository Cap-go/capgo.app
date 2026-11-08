import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

const { orgEmailNotificationTestUtils } = await import('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts')

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'request-id' : undefined,
  } as any
}

function createWhereCaptureDrizzle() {
  const state = { lastWhere: undefined as unknown }
  const drizzle = {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where(whereExpr: unknown) {
                  state.lastWhere = whereExpr
                  return Promise.resolve([])
                },
              }
            },
          }
        },
      }
    },
  } as any
  return { drizzle, getLastWhere: () => state.lastWhere }
}

function whereQuery(whereExpr: unknown) {
  if (!whereExpr)
    return { sql: '', params: [] as unknown[] }
  return new PgDialect().sqlToQuery(whereExpr as SQL)
}

function expectScopePredicates(sql: string, params: unknown[], orgId: string, principalType: string) {
  expect(sql).toMatch(/role_bindings/)
  expect(params).toContain(orgId)
  expect(params).toContain(principalType)
  expect(params).toContain('org')
}

describe('plugin org_email_notifications all audience', () => {
  it.each(['user', 'group'] as const)('omits role-name filter when audience role list is empty (%s)', async (principalType) => {
    const { drizzle, getLastWhere } = createWhereCaptureDrizzle()
    const result = await orgEmailNotificationTestUtils.fetchOrgScopeRoleBindings(
      createContext(),
      'org-123',
      drizzle,
      orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.all,
      principalType,
      'test',
    )
    expect(result.failed).toBe(false)
    const capturedWhere = getLastWhere()
    expect(capturedWhere).toBeDefined()
    const { sql, params } = whereQuery(capturedWhere)
    expect(sql).not.toMatch(/roles.*name|"roles"\."name"/i)
    expectScopePredicates(sql, params, 'org-123', principalType)
  })

  it.each(['user', 'group'] as const)('applies role-name filter for admins audience (%s)', async (principalType) => {
    const { drizzle, getLastWhere } = createWhereCaptureDrizzle()
    const result = await orgEmailNotificationTestUtils.fetchOrgScopeRoleBindings(
      createContext(),
      'org-123',
      drizzle,
      orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.admins,
      principalType,
      'test',
    )
    expect(result.failed).toBe(false)
    const capturedWhere = getLastWhere()
    expect(capturedWhere).toBeDefined()
    const { sql, params } = whereQuery(capturedWhere)
    expect(sql).toMatch(/roles.*name|"roles"\."name"/i)
    expectScopePredicates(sql, params, 'org-123', principalType)
    expect(params).toContain('org_admin')
    expect(params).toContain('org_super_admin')
  })
})

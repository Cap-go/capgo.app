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

describe('plugin org_email_notifications all audience', () => {
  it('omits role-name filter when audience role list is empty', async () => {
    const { drizzle, getLastWhere } = createWhereCaptureDrizzle()
    const result = await orgEmailNotificationTestUtils.fetchOrgScopeRoleBindings(
      createContext(),
      'org-123',
      drizzle,
      orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.all,
      'user',
      'test',
    )
    expect(result.failed).toBe(false)
    const capturedWhere = getLastWhere()
    expect(capturedWhere).toBeDefined()
    const { sql } = whereQuery(capturedWhere)
    expect(sql).not.toMatch(/roles.*name|"roles"\."name"/i)
    expect(sql).toMatch(/role_bindings/)
  })

  it('applies role-name filter for admins audience', async () => {
    const { drizzle, getLastWhere } = createWhereCaptureDrizzle()
    const result = await orgEmailNotificationTestUtils.fetchOrgScopeRoleBindings(
      createContext(),
      'org-123',
      drizzle,
      orgEmailNotificationTestUtils.AUDIENCE_ROLE_NAMES.admins,
      'user',
      'test',
    )
    expect(result.failed).toBe(false)
    const capturedWhere = getLastWhere()
    expect(capturedWhere).toBeDefined()
    const { sql, params } = whereQuery(capturedWhere)
    expect(sql).toMatch(/roles.*name|"roles"\."name"/i)
    expect(params).toContain('org_admin')
  })
})

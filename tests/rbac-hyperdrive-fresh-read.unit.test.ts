/**
 * Permission checks must never be answered from Hyperdrive's query cache: a check
 * made before an app exists would otherwise keep denying it for a minute after
 * creation, and a revoked permission would keep passing.
 */
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(async () => undefined),
  getDrizzleClient: vi.fn(() => ({ execute: executeMock })),
  getPgClient: vi.fn(async () => ({})),
}))

const { callerHoldsAllRolePermissions, checkPermission, checkPermissionPg } = await import('../supabase/functions/_backend/utils/rbac.ts')

const USER_ID = '00000000-0000-0000-0000-000000000001'
const apikeyAuth = { authType: 'apikey', userId: USER_ID, apikey: { key: 'capgo-key', rbac_id: 'rbac-1' } }
const jwtAuth = { authType: 'jwt', userId: USER_ID }

function context(auth: unknown) {
  return { get: (key: string) => (key === 'auth' ? auth : undefined) } as any
}

function executedSql(): string {
  return new PgDialect().sqlToQuery(executeMock.mock.calls[0][0] as SQL).sql
}

describe('permission checks bypass the Hyperdrive query cache', () => {
  beforeEach(() => {
    executeMock.mockReset()
    executeMock.mockResolvedValue({ rows: [{ allowed: true, missing_permission: false }] })
  })

  it.each([
    ['checkPermission with an RBAC API key', () => checkPermission(context(apikeyAuth), 'app.read', { appId: 'com.example.app' })],
    ['checkPermission with a JWT', () => checkPermission(context(jwtAuth), 'app.read', { appId: 'com.example.app' })],
    ['checkPermissionPg with an RBAC API key', () => checkPermissionPg(context(apikeyAuth), 'app.read', { appId: 'com.example.app' }, { execute: executeMock }, USER_ID, 'capgo-key')],
    ['checkPermissionPg with a JWT', () => checkPermissionPg(context(jwtAuth), 'app.read', { appId: 'com.example.app' }, { execute: executeMock }, USER_ID)],
    ['callerHoldsAllRolePermissions', () => callerHoldsAllRolePermissions({ execute: executeMock } as any, USER_ID, 'role-1', { orgId: USER_ID })],
  ])('%s', async (_label, run) => {
    await run()
    const query = executedSql()
    expect(query).toMatch(/^\s*WITH capgo_fresh_read AS \(SELECT now\(\)\)\s+SELECT\b/)
    expect(query).toContain('public.rbac_check_permission_direct(')
  })
})

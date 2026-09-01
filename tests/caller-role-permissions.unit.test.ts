import { describe, expect, it, vi } from 'vitest'

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getPgClient: vi.fn(),
  getDrizzleClient: vi.fn(() => ({ execute: executeMock })),
}))

const { callerHoldsAllRolePermissions } = await import('../supabase/functions/_backend/utils/rbac.ts')

describe('callerHoldsAllRolePermissions', () => {
  it('returns false when any target role permission is missing', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ missing_permission: true }] })

    await expect(callerHoldsAllRolePermissions(
      { execute: executeMock } as any,
      '00000000-0000-4000-8000-000000000111',
      '00000000-0000-4000-8000-000000000222',
      {
        orgId: '00000000-0000-4000-8000-000000000333',
        publicAppId: 'com.example.app',
        channelId: 42,
      },
    )).resolves.toBe(false)
  })

  it('returns true when the caller holds every target role permission', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ missing_permission: false }] })

    await expect(callerHoldsAllRolePermissions(
      { execute: executeMock } as any,
      '00000000-0000-4000-8000-000000000111',
      '00000000-0000-4000-8000-000000000222',
      {
        orgId: '00000000-0000-4000-8000-000000000333',
      },
    )).resolves.toBe(true)
  })
})

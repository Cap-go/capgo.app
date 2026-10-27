import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { refreshAppOnboardingTodoBatch } from '../supabase/functions/_backend/utils/app_onboarding_todo_refresh.ts'

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEventBatch: vi.fn(async () => true) }))
vi.mock('../supabase/functions/_backend/utils/app_onboarding_bento.ts', () => ({ emitCommittedAppOnboardingBento: vi.fn(async () => undefined) }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({ backgroundTask: async (_c: unknown, task: Promise<unknown>) => await task }))

const dialect = new PgDialect()
const context = { get: () => undefined } as unknown as Context<MiddlewareKeyVariables>

function database(apps: Array<{ app_id: string, onboarding: unknown }>) {
  const statements: string[] = []
  const params: unknown[][] = []
  const execute = vi.fn(async (statement) => {
    const query = dialect.sqlToQuery(statement)
    statements.push(query.sql)
    params.push(query.params)
    if (query.sql.includes('FROM public.apps'))
      return { rows: apps.map(app => ({ ...app, created_at: '2026-10-01T00:00:00.000Z', owner_org: 'fixture-org' })) }
    if (query.sql.includes('FROM public.build_requests'))
      return { rows: apps.map(app => ({ app_id: app.app_id, platform: 'ios', succeeded: true, failed: false })) }
    return { rows: [] }
  })
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ execute }))
  return { db: { execute, transaction } as never, transaction, statements, params }
}

describe('onboarding todo refresh locking', () => {
  it('does not lock apps whose evidence is already reflected in their checklist', async () => {
    const appIds = ['com.test.completed', 'com.test.done']
    const { db, transaction, statements } = database([
      { app_id: appIds[0], onboarding: { setup: { todo_list_version: 3, outcome: 'completed', steps: {} } } },
      { app_id: appIds[1], onboarding: { setup: { todo_list_version: 3, outcome: 'in_progress', steps: { add_channel: { status: 'done' } } } } },
    ])
    const gatherEvidence = vi.fn(async () => ({ channel: new Set(appIds), device: new Set<string>(), bundle: new Set<string>(), update: new Set<string>(), errors: [] }))

    const result = await refreshAppOnboardingTodoBatch(context, db, { appIds } as never, { gatherEvidence })

    expect(result).toEqual({ updated: 0, steps: 0, cfErrors: 0 })
    expect(transaction).not.toHaveBeenCalled()
    expect(statements.some(sql => sql.includes('FOR UPDATE'))).toBe(false)
  })

  it('locks only the apps that still need a change', async () => {
    const appIds = ['com.test.done', 'com.test.pending']
    const { db, transaction, statements, params } = database([
      { app_id: appIds[0], onboarding: { setup: { todo_list_version: 3, outcome: 'in_progress', steps: { add_channel: { status: 'done' } } } } },
      { app_id: appIds[1], onboarding: { setup: { todo_list_version: 3, outcome: 'in_progress', steps: {} } } },
    ])
    const gatherEvidence = vi.fn(async () => ({ channel: new Set(appIds), device: new Set<string>(), bundle: new Set<string>(), update: new Set<string>(), errors: [] }))

    await refreshAppOnboardingTodoBatch(context, db, { appIds } as never, { gatherEvidence })

    expect(transaction).toHaveBeenCalledOnce()
    const lock = statements.findIndex(sql => sql.includes('FOR UPDATE'))
    expect(lock).toBeGreaterThan(-1)
    expect(params[lock]).toEqual([['com.test.pending']])
  })
})

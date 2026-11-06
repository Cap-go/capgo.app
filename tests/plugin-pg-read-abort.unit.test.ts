import { describe, expect, it, vi } from 'vitest'
import { pluginReadClientSkipsEnd, wrapPluginReadOnlyClientForRequestSignal } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'

describe('plugin read replica pg client', () => {
  it('rejects in flight read queries when request.signal aborts', async () => {
    const db = {
      query: (_text: string) => new Promise((resolve) => {
        setTimeout(() => resolve({ rows: [] }), 100)
      }),
    }
    const controller = new AbortController()
    const wrapped = wrapPluginReadOnlyClientForRequestSignal(db as any, controller.signal, false)
    const pending = wrapped.query('SELECT 1')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('marks wrapped read clients so closeClient skips end on Hyperdrive handles', () => {
    const db = { query: () => Promise.resolve({ rows: [] }) }
    const wrapped = wrapPluginReadOnlyClientForRequestSignal(db as any, new AbortController().signal, true)
    expect(pluginReadClientSkipsEnd(wrapped)).toBe(true)
  })

  it('does not mark local pool wrappers for skip end', () => {
    const db = { query: () => Promise.resolve({ rows: [] }) }
    const wrapped = wrapPluginReadOnlyClientForRequestSignal(db as any, new AbortController().signal, false)
    expect(pluginReadClientSkipsEnd(wrapped)).toBe(false)
  })

  it('does not invoke query when signal is already aborted', async () => {
    const db = {
      query: vi.fn(() => Promise.resolve({ rows: [] })),
    }
    const controller = new AbortController()
    controller.abort()
    const wrapped = wrapPluginReadOnlyClientForRequestSignal(db as any, controller.signal, false)
    await expect(wrapped.query('SELECT 1')).rejects.toMatchObject({ name: 'AbortError' })
    expect(db.query).not.toHaveBeenCalled()
  })
})

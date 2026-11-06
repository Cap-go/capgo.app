import { describe, expect, it } from 'vitest'
import { wrapPluginReadOnlyClientForRequestSignal } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'

describe('plugin read replica pg client', () => {
  it('rejects in flight read queries when request.signal aborts', async () => {
    const db = {
      query: (_text: string) => new Promise((resolve) => {
        setTimeout(() => resolve({ rows: [] }), 100)
      }),
    }
    const controller = new AbortController()
    const wrapped = wrapPluginReadOnlyClientForRequestSignal(db as any, controller.signal)
    const pending = wrapped.query('SELECT 1')
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

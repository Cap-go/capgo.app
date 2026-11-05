import { describe, expect, it, vi } from 'vitest'
import { readAllConsoleRows } from '../src/services/consoleRows'

const CONSOLE_PAGE_ROWS = 1000

describe('readAllConsoleRows', () => {
  it('reads past the PostgREST row cap in ordered pages', async () => {
    const total = CONSOLE_PAGE_ROWS * 2 + 7
    const page = vi.fn(async (from: number, to: number) => ({ data: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i), error: null }))
    const { data, error } = await readAllConsoleRows<number>(page)
    expect(error).toBeNull()
    expect(data).toHaveLength(total)
    expect(page.mock.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('stops at the first error', async () => {
    const page = vi.fn(async () => ({ data: null, error: new Error('boom') }))
    const { data, error } = await readAllConsoleRows(page)
    expect(data).toBeNull()
    expect(error).toBeInstanceOf(Error)
    expect(page).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { retryTransientSqlError, SQL_MAX_ATTEMPTS } from './sql-retry'

async function noWait() {}
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code })

describe('retryTransientSqlError', () => {
  it.each(['40P01', '40001'])('retries %s and returns the later result', async (code) => {
    const run = vi.fn()
      .mockRejectedValueOnce(pgError(code))
      .mockResolvedValueOnce('ok')

    await expect(retryTransientSqlError(run, noWait)).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('rethrows after the last allowed attempt', async () => {
    const run = vi.fn().mockRejectedValue(pgError('40P01'))

    await expect(retryTransientSqlError(run, noWait)).rejects.toThrow('pg 40P01')
    expect(run).toHaveBeenCalledTimes(SQL_MAX_ATTEMPTS)
    expect(SQL_MAX_ATTEMPTS).toBe(3)
  })

  it('does not retry other errors', async () => {
    const run = vi.fn().mockRejectedValue(pgError('23505'))

    await expect(retryTransientSqlError(run, noWait)).rejects.toThrow('pg 23505')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('returns the first success without waiting', async () => {
    const wait = vi.fn(noWait)
    const run = vi.fn().mockResolvedValue(['row'])

    await expect(retryTransientSqlError(run, wait)).resolves.toEqual(['row'])
    expect(run).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})

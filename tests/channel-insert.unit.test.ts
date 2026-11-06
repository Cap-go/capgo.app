import { describe, expect, it } from 'vitest'
import { buildChannelInsertOrExistingSql, ChannelAlreadyExistsError, resolveChannelInsert } from '../supabase/functions/_backend/utils/channel_insert.ts'

const channel = { id: '42', version: 5, rollout_version: null, public: false, paused_at: null }

describe('channel insert or existing', () => {
  it('builds one write statement that returns the inserted or existing channel', () => {
    const sql = buildChannelInsertOrExistingSql(['"app_id"', '"name"'], ['com.test.app', 'pr-1'], 'com.test.app', 'pr-1')
    expect(sql.text).toContain('ON CONFLICT ON CONSTRAINT unique_name_app_id DO NOTHING')
    expect(sql.text).toContain('WHERE app_id = $3 AND name = $4')
    expect(sql.values).toEqual(['com.test.app', 'pr-1', 'com.test.app', 'pr-1'])
  })

  it('returns the inserted channel', () => {
    expect(resolveChannelInsert([{ row: { ...channel, inserted: true } as any }])).toEqual({ ...channel, id: 42 })
  })

  it('throws the existing channel instead of a unique violation', () => {
    let error: unknown
    try {
      resolveChannelInsert([{ row: { ...channel, inserted: false } as any }])
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ChannelAlreadyExistsError)
    expect((error as ChannelAlreadyExistsError).existing).toEqual({ ...channel, id: 42 })
  })

  it('reports an invisible conflicting row as the unique violation', () => {
    expect(() => resolveChannelInsert([])).toThrow(expect.objectContaining({ code: '23505', constraint: 'unique_name_app_id' }))
  })
})

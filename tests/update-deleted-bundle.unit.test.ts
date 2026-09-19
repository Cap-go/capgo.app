import { describe, expect, it } from 'vitest'
import { isVersionDeleted } from '../supabase/functions/_backend/plugin_runtime/utils/utils.ts'

describe('isVersionDeleted', () => {
  it.concurrent('treats deleted and deleted_at as deleted versions', () => {
    expect(isVersionDeleted({ deleted: true, deleted_at: null })).toBe(true)
    expect(isVersionDeleted({ deleted: false, deleted_at: '2026-08-16T00:00:00Z' })).toBe(true)
    expect(isVersionDeleted({ deleted: false, deleted_at: null })).toBe(false)
    expect(isVersionDeleted(null)).toBe(false)
  })
})

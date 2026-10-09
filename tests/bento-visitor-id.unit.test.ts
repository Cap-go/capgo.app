import { describe, expect, it } from 'vitest'
import { isBentoVisitorId, normalizeBentoVisitorId } from '../supabase/functions/_backend/utils/bento_visitor_id.ts'

const VISITOR_UUID_DASHED = '11111111-1111-4111-8111-111111111111'
const VISITOR_UUID_HEX = '11111111111141118111111111111111'

describe('bento visitor id', () => {
  it('accepts dashed and 32-hex visitor ids', () => {
    expect(isBentoVisitorId(VISITOR_UUID_DASHED)).toBe(true)
    expect(isBentoVisitorId(VISITOR_UUID_HEX)).toBe(true)
    expect(isBentoVisitorId('user@example.com')).toBe(false)
  })

  it('normalizes to compact hex for Bento API lookups', () => {
    expect(normalizeBentoVisitorId(VISITOR_UUID_DASHED)).toBe(VISITOR_UUID_HEX)
    expect(normalizeBentoVisitorId(VISITOR_UUID_HEX)).toBe(VISITOR_UUID_HEX)
    expect(normalizeBentoVisitorId('not-an-id')).toBeNull()
  })
})

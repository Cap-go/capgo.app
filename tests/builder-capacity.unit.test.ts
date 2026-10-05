import { describe, expect, it } from 'vitest'
import {
  isoFromBuilderTimestamp,
  msFromBuilderTimestamp,
} from '../supabase/functions/_backend/utils/builder_capacity.ts'

describe('builder capacity timestamps', () => {
  it.concurrent('accepts builder epoch milliseconds and rejects invalid values', () => {
    expect(msFromBuilderTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(msFromBuilderTimestamp(null)).toBeNull()
    expect(msFromBuilderTimestamp(Number.NaN)).toBeNull()
    expect(isoFromBuilderTimestamp(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(isoFromBuilderTimestamp(undefined)).toBeNull()
  })
})

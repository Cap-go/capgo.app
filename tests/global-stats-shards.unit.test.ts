import { describe, expect, it } from 'vitest'

import {
  hasRequiredGlobalStatsShards,
  REQUIRED_GLOBAL_STATS_SHARDS,
} from '../supabase/functions/_backend/utils/global_stats.ts'

describe('hasRequiredGlobalStatsShards', () => {
  it.concurrent('returns true when every required shard is present', () => {
    expect(hasRequiredGlobalStatsShards([...REQUIRED_GLOBAL_STATS_SHARDS])).toBe(true)
    expect(hasRequiredGlobalStatsShards([
      ...REQUIRED_GLOBAL_STATS_SHARDS,
      'notifications',
    ])).toBe(true)
  })

  it.concurrent('returns false for partial rollups', () => {
    expect(hasRequiredGlobalStatsShards(['plugins'])).toBe(false)
    expect(hasRequiredGlobalStatsShards(['core', 'plugins'])).toBe(false)
  })

  it.concurrent('returns false for invalid values', () => {
    expect(hasRequiredGlobalStatsShards(null)).toBe(false)
    expect(hasRequiredGlobalStatsShards({})).toBe(false)
  })
})

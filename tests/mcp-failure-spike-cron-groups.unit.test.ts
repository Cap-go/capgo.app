import { describe, expect, it } from 'vitest'
import {
  advanceMcpFailureSpikeGroupCursor,
  rotateMcpFailureSpikeGroups,
} from '../supabase/functions/_backend/utils/mcp_failure_spike_cron_groups.ts'

describe('mcp failure spike cron group cursor', () => {
  const groups = ['g0', 'g1', 'g2', 'g3', 'g4']

  it('rotates groups from the persisted offset', () => {
    expect(rotateMcpFailureSpikeGroups(groups, 2)).toEqual(['g2', 'g3', 'g4', 'g0', 'g1'])
  })

  it('advances the cursor by processed group count and wraps', () => {
    let cursor = 0
    cursor = advanceMcpFailureSpikeGroupCursor(cursor, 2, groups.length)
    expect(cursor).toBe(2)

    cursor = advanceMcpFailureSpikeGroupCursor(cursor, 2, groups.length)
    expect(cursor).toBe(4)

    cursor = advanceMcpFailureSpikeGroupCursor(cursor, 1, groups.length)
    expect(cursor).toBe(0)
  })

  it('processes late groups on the next tick instead of waiting hours', () => {
    let cursor = 0
    const processedPerTick = 2
    const lastGroupFirstTick: Record<string, number> = {}

    for (let tick = 0; tick < groups.length; tick += 1) {
      const order = rotateMcpFailureSpikeGroups(groups, cursor)
      for (let index = 0; index < processedPerTick && index < order.length; index += 1) {
        const group = order[index]!
        if (lastGroupFirstTick[group] === undefined)
          lastGroupFirstTick[group] = tick
      }
      cursor = advanceMcpFailureSpikeGroupCursor(cursor, processedPerTick, groups.length)
    }

    expect(lastGroupFirstTick.g4).toBeLessThanOrEqual(2)
    expect(Object.keys(lastGroupFirstTick)).toHaveLength(groups.length)
  })
})
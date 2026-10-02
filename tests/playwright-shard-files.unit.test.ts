import { describe, expect, it } from 'vitest'
import { assignSpecsToShards } from '../scripts/playwright-shard-files'

describe('playwright duration-balanced shards', () => {
  it('assigns every spec to exactly one shard', () => {
    const specs = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts', 'e.spec.ts']
    const shards = assignSpecsToShards(specs, { 'a.spec.ts': 30, 'b.spec.ts': 20 }, 3)

    expect(shards).toHaveLength(3)
    expect(shards.flat().sort()).toEqual(specs)
  })

  it('balances long specs across shards instead of splitting by count', () => {
    const durations = { 'a.spec.ts': 30, 'b.spec.ts': 30, 'c.spec.ts': 20, 'd.spec.ts': 20, 'e.spec.ts': 10, 'f.spec.ts': 10 }
    const shards = assignSpecsToShards(Object.keys(durations), durations, 2)
    const totals = shards.map(shard => shard.reduce((sum, spec) => sum + durations[spec as keyof typeof durations], 0))

    expect(Math.abs(totals[0] - totals[1])).toBe(0)
  })

  it('gives unknown specs a default estimate so new files still run', () => {
    const shards = assignSpecsToShards(['known.spec.ts', 'new.spec.ts'], { 'known.spec.ts': 5 }, 2)

    expect(shards).toEqual([['new.spec.ts'], ['known.spec.ts']])
  })
})

import { describe, expect, it } from 'vitest'
import { parseShard, shardRoutes } from '../scripts/visual-diff-shards.ts'

describe('visual diff route shards', () => {
  it('covers every route exactly once, in order, across contiguous shards', () => {
    const routes = Array.from({ length: 89 }, (_, index) => `route-${index}`)
    for (const total of [1, 2, 3, 4, 7]) {
      const shards = Array.from({ length: total }, (_, index) => shardRoutes(routes, { index: index + 1, total }))
      expect(shards.flat()).toEqual(routes)
      const sizes = shards.map(shard => shard.length)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    }
    expect(shardRoutes(routes, undefined)).toBe(routes)
  })

  it('parses index/total and rejects anything else', () => {
    expect(parseShard('2/4')).toEqual({ index: 2, total: 4 })
    for (const raw of ['0/4', '5/4', '1/0', '2', 'a/b', '1/4/2'])
      expect(() => parseShard(raw)).toThrow('--shard must look like')
  })
})

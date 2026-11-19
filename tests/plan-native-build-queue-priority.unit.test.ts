import { describe, expect, it } from 'vitest'
import { readOrgNativeBuildQueuePriority } from '../supabase/functions/_backend/public/build/queue_priority.ts'

function makePgClient(row: {
  plan_name: string | null
  native_build_queue_priority: number | string | null
}) {
  return {
    query: async <T extends Record<string, unknown>>() => ({ rows: [row as unknown as T] }),
  }
}

describe('plan row to org native build queue priority', () => {
  it.concurrent('maps Solo plan name to priority 10 and standard tier', async () => {
    const out = await readOrgNativeBuildQueuePriority(
      makePgClient({ plan_name: 'Solo', native_build_queue_priority: 10 }),
      '00000000-0000-0000-0000-000000000001',
    )
    expect(out.planName).toBe('Solo')
    expect(out.priority).toBe(10)
    expect(out.tier).toBe('standard')
  })

  it.concurrent('maps Maker to elevated tier', async () => {
    const out = await readOrgNativeBuildQueuePriority(
      makePgClient({ plan_name: 'Maker', native_build_queue_priority: 20 }),
      '00000000-0000-0000-0000-000000000002',
    )
    expect(out.priority).toBe(20)
    expect(out.tier).toBe('elevated')
  })

  it.concurrent('maps Team to high tier', async () => {
    const out = await readOrgNativeBuildQueuePriority(
      makePgClient({ plan_name: 'Team', native_build_queue_priority: 40 }),
      '00000000-0000-0000-0000-000000000003',
    )
    expect(out.priority).toBe(40)
    expect(out.tier).toBe('high')
  })

  it.concurrent('maps Enterprise to highest tier', async () => {
    const out = await readOrgNativeBuildQueuePriority(
      makePgClient({ plan_name: 'Enterprise', native_build_queue_priority: 100 }),
      '00000000-0000-0000-0000-000000000004',
    )
    expect(out.priority).toBe(100)
    expect(out.tier).toBe('highest')
  })

  it.concurrent('rejects invalid priority from mocked plan row', async () => {
    await expect(
      readOrgNativeBuildQueuePriority(
        makePgClient({ plan_name: 'Solo', native_build_queue_priority: null }),
        '00000000-0000-0000-0000-000000000005',
      ),
    ).rejects.toThrow(/not configured/)
  })
})

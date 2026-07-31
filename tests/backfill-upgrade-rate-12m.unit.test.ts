import { describe, expect, it } from 'vitest'
import { buildUpgradeRate12mBackfillRows, calculateUpgradeRate12m } from '../scripts/backfill_upgrade_rate_12m.ts'

describe('calculateUpgradeRate12m', () => {
  it('returns 0 when there are no paying orgs', () => {
    expect(calculateUpgradeRate12m(5, 0)).toBe(0)
  })

  it('rounds to one decimal place', () => {
    expect(calculateUpgradeRate12m(1, 3)).toBe(33.3)
  })
})

describe('buildUpgradeRate12mBackfillRows', () => {
  it('uses paying orgs as the denominator', () => {
    const rows = [
      { date_id: '2025-07-21', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 0 },
      { date_id: '2025-07-22', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 2 },
      { date_id: '2026-07-21', paying: 20, upgrade_rate_12m: 0, upgraded_orgs: 1 },
      { date_id: '2026-07-22', paying: 20, upgrade_rate_12m: 0, upgraded_orgs: 4 },
    ]

    const result = buildUpgradeRate12mBackfillRows(rows, rows)
    const byDate = Object.fromEntries(result.map(row => [row.date_id, row]))

    // Window for 2026-07-21 is [2025-07-22, 2026-07-21] => 2 + 1 = 3 / 20 paying
    expect(byDate['2026-07-21']?.upgraded_orgs_12m).toBe(3)
    expect(byDate['2026-07-21']?.paying).toBe(20)
    expect(byDate['2026-07-21']?.next_rate).toBe(15)

    // Window for 2026-07-22 is [2025-07-23, 2026-07-22] => 1+4 = 5 / 20
    expect(byDate['2026-07-22']?.upgraded_orgs_12m).toBe(5)
    expect(byDate['2026-07-22']?.next_rate).toBe(25)
  })

  it('clamps leap-day trailing windows to the prior month-end', () => {
    const rows = [
      { date_id: '2023-02-28', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 1 },
      { date_id: '2023-03-01', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 1 },
      { date_id: '2024-02-28', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 0 },
      { date_id: '2024-02-29', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 0 },
    ]

    const result = buildUpgradeRate12mBackfillRows(
      [{ date_id: '2024-02-29', paying: 10, upgrade_rate_12m: 0, upgraded_orgs: 0 }],
      rows,
    )

    // endExclusive 2024-03-01 => start clamped to 2023-03-01 (not 2023-02-29)
    // so 2023-02-28 is excluded and only 2023-03-01 counts
    expect(result[0]?.upgraded_orgs_12m).toBe(1)
    expect(result[0]?.next_rate).toBe(10)
  })
})

import { describe, expect, it } from 'vitest'
import { getLatestDayVersionAdoption } from '~/services/bundleAdoption'

describe('getLatestDayVersionAdoption', () => {
  it.concurrent('returns the named bundle share on the latest day with counts', () => {
    const adoption = getLatestDayVersionAdoption([
      { label: '1.0.0', metaCountValues: [80, 60, 20], data: [80, 60, 20] },
      { label: '1.1.0', metaCountValues: [20, 40, 80], data: [20, 40, 80] },
    ], '1.1.0')

    expect(adoption).toEqual({
      versionName: '1.1.0',
      count: 80,
      total: 100,
      percent: 80,
    })
  })

  it.concurrent('returns zero for a bundle that has not been reported yet', () => {
    const adoption = getLatestDayVersionAdoption([
      { label: '1.0.0', metaCounts: [100], data: [100] },
    ], '1.2.0')

    expect(adoption).toEqual({
      versionName: '1.2.0',
      count: 0,
      total: 100,
      percent: 0,
    })
  })

  it.concurrent('picks the leading bundle when no version is given', () => {
    const adoption = getLatestDayVersionAdoption([
      { label: '1.0.0', metaCountValues: [10, 30] },
      { label: '1.1.0', metaCountValues: [90, 70] },
    ])

    expect(adoption).toEqual({
      versionName: '1.1.0',
      count: 70,
      total: 100,
      percent: 70,
    })
  })

  it.concurrent('skips trailing empty days', () => {
    const adoption = getLatestDayVersionAdoption([
      { label: '1.0.0', metaCountValues: [40, 0], data: [40, 0] },
      { label: '1.1.0', metaCountValues: [60, 0], data: [60, 0] },
    ], '1.1.0')

    expect(adoption).toEqual({
      versionName: '1.1.0',
      count: 60,
      total: 100,
      percent: 60,
    })
  })

  it.concurrent('ignores percent-only days that have no device counts', () => {
    const adoption = getLatestDayVersionAdoption([
      { label: '1.0.0', metaCountValues: [40, 0], data: [40, 80] },
      { label: '1.1.0', metaCountValues: [60, 0], data: [60, 20] },
    ], '1.1.0')

    expect(adoption).toEqual({
      versionName: '1.1.0',
      count: 60,
      total: 100,
      percent: 60,
    })
  })

  it.concurrent('keeps one-decimal rounding for fractional shares', () => {
    const adoption = getLatestDayVersionAdoption([
      { label: '1.0.0', metaCountValues: [77] },
      { label: '1.1.0', metaCountValues: [56] },
    ], '1.1.0')

    expect(adoption).toEqual({
      versionName: '1.1.0',
      count: 56,
      total: 133,
      percent: 42.1,
    })
  })
})

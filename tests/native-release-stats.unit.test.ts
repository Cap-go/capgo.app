import { describe, expect, it } from 'vitest'
import {
  buildNativeReleaseColorMap,
  buildNativeReleaseRows,
  filterNativeReleaseSeries,
  groupNativeReleaseChartSeries,
  parseNativeReleaseSeries,
} from '../src/services/nativeReleaseStats'

const labels = ['2026-09-28', '2026-09-29', '2026-09-30']

describe('native release stats', () => {
  it('parses platform and version from native_usage series labels', () => {
    const series = parseNativeReleaseSeries(labels, [
      { label: 'iOS 2.4.0', metaCounts: [0, 10, 20] },
      { label: 'Android 2.3.1 (45)', metaCountValues: [5, -1, Number.NaN] },
      { label: 'Electron', metaCounts: [1] },
    ])

    expect(series.map(item => [item.platform, item.version, item.counts])).toEqual([
      ['ios', '2.4.0', [0, 10, 20]],
      ['android', '2.3.1 (45)', [5, 0, 0]],
      ['electron', 'Electron', [1, 0, 0]],
    ])
  })

  it('builds rows with platform-relative share on the latest day with data', () => {
    const series = parseNativeReleaseSeries(labels, [
      { label: 'iOS 2.4.0', metaCounts: [0, 10, 30] },
      { label: 'iOS 2.3.0', metaCounts: [40, 30, 10] },
      { label: 'Android 2.4.0', metaCounts: [0, 0, 50] },
      { label: 'Android 2.2.0', metaCounts: [0, 0, 0] },
    ])

    const rows = buildNativeReleaseRows(labels, series)

    expect(rows.map(row => row.key)).toEqual(['Android 2.4.0', 'iOS 2.4.0', 'iOS 2.3.0'])
    expect(rows[0]).toMatchObject({ latest_devices: 50, latest_share: 100, peak_devices: 50, first_seen: '2026-09-30', last_seen: '2026-09-30' })
    expect(rows[1]).toMatchObject({ latest_devices: 30, latest_share: 75, first_seen: '2026-09-29' })
    expect(rows[2]).toMatchObject({ latest_devices: 10, latest_share: 25, peak_devices: 40, first_seen: '2026-09-28' })
  })

  it('falls back to the last day that has data when today is still empty', () => {
    const series = parseNativeReleaseSeries(labels, [
      { label: 'iOS 1.0.0', metaCounts: [3, 9, 0] },
    ])

    expect(buildNativeReleaseRows(labels, series)[0]).toMatchObject({ latest_devices: 9, latest_share: 100, last_seen: '2026-09-29' })
  })

  it('filters by platform and folds extra versions into one chart series', () => {
    const series = parseNativeReleaseSeries(labels, [
      { label: 'iOS 3', metaCounts: [1, 1, 3] },
      { label: 'iOS 2', metaCounts: [1, 1, 2] },
      { label: 'iOS 1', metaCounts: [1, 1, 1] },
      { label: 'Android 1', metaCounts: [9, 9, 9] },
    ])

    const iosSeries = filterNativeReleaseSeries(series, 'ios')
    expect(iosSeries).toHaveLength(3)

    const rows = buildNativeReleaseRows(labels, iosSeries)
    const grouped = groupNativeReleaseChartSeries(rows, iosSeries, 2)
    expect(grouped.top.map(item => item.key)).toEqual(['iOS 3', 'iOS 2'])
    expect(grouped.other).toEqual([1, 1, 1])
  })
})

describe('native release chart colors', () => {
  it('never repeats a color among the versions shown for a platform, and keeps colors across filters', () => {
    const versions = Array.from({ length: 12 }, (_value, index) => index)
    const series = parseNativeReleaseSeries(labels, [
      ...versions.map(index => ({ label: `iOS 1.${index}.0`, metaCounts: [0, 0, 100 - index] })),
      ...versions.map(index => ({ label: `Android 1.${index}.0`, metaCounts: [0, 0, 200 - index] })),
    ])
    const allRows = buildNativeReleaseRows(labels, series)
    const colors = buildNativeReleaseColorMap(allRows)

    for (const platform of ['all', 'ios', 'android'] as const) {
      const filtered = filterNativeReleaseSeries(series, platform)
      const { top } = groupNativeReleaseChartSeries(buildNativeReleaseRows(labels, filtered), filtered)
      const shown = top.map(item => colors.get(item.key))
      expect(new Set(shown).size).toBe(shown.length)
    }

    expect(colors.get('iOS 1.0.0')).not.toBe(colors.get('Android 1.0.0'))
  })
})

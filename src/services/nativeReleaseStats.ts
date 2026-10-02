import { parseNativeSeriesPlatform } from '~/services/nativeDeviceStats'

export type NativeReleasePlatform = 'android' | 'ios' | 'electron' | 'unknown'
export type NativeReleasePlatformFilter = 'all' | 'ios' | 'android'

export interface NativeReleaseSeriesInput {
  label: string
  metaCounts?: number[]
  metaCountValues?: number[]
}

export interface NativeReleaseSeries {
  key: string
  platform: NativeReleasePlatform
  version: string
  counts: number[]
}

export interface NativeReleaseRow {
  key: string
  platform: NativeReleasePlatform
  version: string
  latest_devices: number
  latest_share: number | null
  peak_devices: number
  first_seen: string | null
  last_seen: string | null
}

function toCount(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

// native_usage series labels are "<Platform> <version_build>", e.g. "iOS 1.4.0".
export function parseNativeReleaseSeries(labels: string[], datasets: NativeReleaseSeriesInput[]): NativeReleaseSeries[] {
  return datasets.map((dataset) => {
    const label = dataset.label.trim()
    const separator = label.indexOf(' ')
    const version = separator === -1 ? label : label.slice(separator + 1).trim()
    const rawCounts = dataset.metaCountValues ?? dataset.metaCounts ?? []
    return {
      key: label,
      platform: parseNativeSeriesPlatform(label),
      version: version || 'unknown',
      counts: labels.map((_label, index) => toCount(rawCounts[index])),
    }
  })
}

export function filterNativeReleaseSeries(series: NativeReleaseSeries[], platform: NativeReleasePlatformFilter) {
  if (platform === 'all')
    return series
  return series.filter(item => item.platform === platform)
}

function latestIndexWithData(series: NativeReleaseSeries[], length: number) {
  for (let index = length - 1; index >= 0; index--) {
    if (series.some(item => (item.counts[index] ?? 0) > 0))
      return index
  }
  return -1
}

// Share is computed within the series' own platform so iOS and Android
// adoption are comparable even when one platform has far more devices.
export function buildNativeReleaseRows(labels: string[], series: NativeReleaseSeries[]): NativeReleaseRow[] {
  const latestIndex = latestIndexWithData(series, labels.length)
  const platformTotals = new Map<NativeReleasePlatform, number>()
  if (latestIndex >= 0) {
    for (const item of series)
      platformTotals.set(item.platform, (platformTotals.get(item.platform) ?? 0) + (item.counts[latestIndex] ?? 0))
  }

  return series
    .map((item) => {
      const firstIndex = item.counts.findIndex(count => count > 0)
      let lastIndex = -1
      for (let index = item.counts.length - 1; index >= 0; index--) {
        if (item.counts[index]! > 0) {
          lastIndex = index
          break
        }
      }
      const latestDevices = latestIndex >= 0 ? item.counts[latestIndex] ?? 0 : 0
      const platformTotal = platformTotals.get(item.platform) ?? 0
      return {
        key: item.key,
        platform: item.platform,
        version: item.version,
        latest_devices: latestDevices,
        latest_share: platformTotal > 0 ? Math.round((latestDevices / platformTotal) * 1000) / 10 : null,
        peak_devices: item.counts.reduce((max, count) => Math.max(max, count), 0),
        first_seen: firstIndex >= 0 ? labels[firstIndex] ?? null : null,
        last_seen: lastIndex >= 0 ? labels[lastIndex] ?? null : null,
      }
    })
    .filter(row => row.peak_devices > 0)
    .sort((a, b) => {
      if (b.latest_devices !== a.latest_devices)
        return b.latest_devices - a.latest_devices
      if (b.peak_devices !== a.peak_devices)
        return b.peak_devices - a.peak_devices
      return a.key.localeCompare(b.key)
    })
}

// Keep the chart readable: the top versions by latest devices get their own
// stack, everything else is folded into a single "other" series.
export function groupNativeReleaseChartSeries(rows: NativeReleaseRow[], series: NativeReleaseSeries[], maxSeries = 6) {
  const byKey = new Map(series.map(item => [item.key, item]))
  const top = rows.slice(0, maxSeries).map(row => byKey.get(row.key)).filter((item): item is NativeReleaseSeries => !!item)
  const topKeys = new Set(top.map(item => item.key))
  const rest = series.filter(item => !topKeys.has(item.key))
  const length = series[0]?.counts.length ?? 0
  const other = rest.length > 0
    ? Array.from({ length }, (_value, index) => rest.reduce((sum, item) => sum + (item.counts[index] ?? 0), 0))
    : null
  return { top, other: other?.some(count => count > 0) ? other : null }
}

export function buildDemoNativeReleaseData(labels: string[]) {
  const versions: Array<{ label: string, base: number, ramp: number }> = [
    { label: 'iOS 2.4.0', base: 40, ramp: 22 },
    { label: 'iOS 2.3.1', base: 310, ramp: -14 },
    { label: 'iOS 2.2.0', base: 70, ramp: -3 },
    { label: 'Android 2.4.0', base: 55, ramp: 26 },
    { label: 'Android 2.3.1', base: 380, ramp: -17 },
    { label: 'Android 2.2.0', base: 90, ramp: -4 },
  ]
  return {
    labels,
    datasets: versions.map(version => ({
      label: version.label,
      metaCounts: labels.map((_label, index) => Math.max(5, version.base + version.ramp * index)),
    })),
  }
}

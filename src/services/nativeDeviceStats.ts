export interface NativeActiveDevicesSummary {
  android: number
  ios: number
  electron: number
  unknown: number
  total: number
}

export interface NativeDailyPlatformActive {
  labels: string[]
  android: number[]
  ios: number[]
  electron: number[]
  unknown: number[]
  total: number[]
}

export interface NativeChartDataset {
  label: string
  metaCountValues?: Array<number | undefined>
}

const EMPTY_SUMMARY: NativeActiveDevicesSummary = {
  android: 0,
  ios: 0,
  electron: 0,
  unknown: 0,
  total: 0,
}

export function parseNativeSeriesPlatform(label: string): 'android' | 'ios' | 'electron' | 'unknown' {
  const normalized = label.trim().toLowerCase()
  if (normalized.startsWith('android'))
    return 'android'
  if (normalized.startsWith('ios'))
    return 'ios'
  if (normalized.startsWith('electron'))
    return 'electron'
  return 'unknown'
}

export function normalizeNativeActiveDevicesSummary(value: Partial<NativeActiveDevicesSummary> | null | undefined): NativeActiveDevicesSummary {
  if (!value)
    return { ...EMPTY_SUMMARY }

  const android = Math.max(0, Number(value.android) || 0)
  const ios = Math.max(0, Number(value.ios) || 0)
  const electron = Math.max(0, Number(value.electron) || 0)
  const unknown = Math.max(0, Number(value.unknown) || 0)
  const total = Math.max(0, Number(value.total) || 0)

  return {
    android,
    ios,
    electron,
    unknown,
    total: total > 0 ? total : android + ios + electron + unknown,
  }
}

export function buildDailyPlatformActiveFromDatasets(labels: string[], datasets: NativeChartDataset[]): NativeDailyPlatformActive {
  const android = Array.from({ length: labels.length }).fill(0) as number[]
  const ios = Array.from({ length: labels.length }).fill(0) as number[]
  const electron = Array.from({ length: labels.length }).fill(0) as number[]
  const unknown = Array.from({ length: labels.length }).fill(0) as number[]

  datasets.forEach((dataset) => {
    const platform = parseNativeSeriesPlatform(dataset.label)
    const counts = dataset.metaCountValues ?? []
    counts.forEach((count, index) => {
      if (index >= labels.length)
        return
      const numeric = typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0
      if (platform === 'android')
        android[index] += numeric
      else if (platform === 'ios')
        ios[index] += numeric
      else if (platform === 'electron')
        electron[index] += numeric
      else
        unknown[index] += numeric
    })
  })

  const total = labels.map((_label, index) => android[index] + ios[index] + electron[index] + unknown[index])

  return {
    labels,
    android,
    ios,
    electron,
    unknown,
    total,
  }
}

export function getLatestNonZeroIndex(values: number[]): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] > 0)
      return index
  }
  return values.length - 1
}

export function getFirstNonZeroIndex(values: number[]): number {
  for (let index = 0; index < values.length; index++) {
    if (values[index] > 0)
      return index
  }
  return 0
}

export function calculatePeriodEvolutionPercent(values: number[]): number | undefined {
  if (!values.length)
    return undefined

  const startIndex = getFirstNonZeroIndex(values)
  const endIndex = getLatestNonZeroIndex(values)
  const startValue = values[startIndex] ?? 0
  const endValue = values[endIndex] ?? 0

  if (startIndex === endIndex)
    return 0
  if (startValue <= 0)
    return endValue > 0 ? 100 : 0

  return ((endValue - startValue) / startValue) * 100
}

export function generateDemoNativeActiveSummary(days: number): NativeActiveDevicesSummary {
  const growth = Math.min(days, 30)
  const android = 420 + growth * 8
  const ios = 360 + growth * 6
  return {
    android,
    ios,
    electron: 12,
    unknown: 3,
    total: android + ios + 15,
  }
}

export function generateDemoDailyPlatformActive(labels: string[]): NativeDailyPlatformActive {
  const android = labels.map((_label, index) => 120 + index * 4 + (index % 3))
  const ios = labels.map((_label, index) => 95 + index * 3 + (index % 2))
  const electron = labels.map(() => 4)
  const unknown = labels.map(() => 1)
  const total = labels.map((_label, index) => android[index] + ios[index] + electron[index] + unknown[index])

  return {
    labels,
    android,
    ios,
    electron,
    unknown,
    total,
  }
}

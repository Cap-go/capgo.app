import {
  bucketPluginVersionBreakdown,
  hasPluginVersionBreakdown,
} from '../../supabase/functions/_backend/utils/plugin_compatibility.ts'

export {
  bucketPluginVersionBreakdown,
  CHANNEL_SELF_STORE_CUTOFF_CAPTION,
  ENCRYPTION_KEY_ID_CUTOFF_CAPTION,
  isLegacyChannelSelfStorePluginVersion,
  isLegacyEncryptionKeyIdPluginVersion,
} from '../../supabase/functions/_backend/utils/plugin_compatibility.ts'

export interface PluginCompatibilityTrendPoint {
  date: string
  version_breakdown: Record<string, number>
  devices_last_month?: number | null
}

export interface PluginCompatibilityChartSeries {
  label: string
  data: Array<{ date: string, value: number }>
  color: string
}

const LEGACY_COLOR = '#f97316'
const CURRENT_COLOR = '#10b981'

export function buildPluginCompatibilityTrendSeries(
  points: PluginCompatibilityTrendPoint[],
  isLegacy: (pluginVersion: string) => boolean,
  labels: { legacy: string, current: string },
): PluginCompatibilityChartSeries[] {
  const buckets = points
    .filter(point => hasPluginVersionBreakdown(point.version_breakdown))
    .map(point => ({
      date: point.date,
      bucket: bucketPluginVersionBreakdown(
        point.version_breakdown,
        isLegacy,
        point.devices_last_month,
      ),
    }))

  if (buckets.length === 0)
    return []

  return [
    {
      label: labels.legacy,
      data: buckets.map(({ date, bucket }) => ({
        date,
        value: bucket.legacyPercent,
      })),
      color: LEGACY_COLOR,
    },
    {
      label: labels.current,
      data: buckets.map(({ date, bucket }) => ({
        date,
        value: bucket.currentPercent,
      })),
      color: CURRENT_COLOR,
    },
  ]
}

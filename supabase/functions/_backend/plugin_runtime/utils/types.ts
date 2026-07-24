import type { Database } from './supabase.types.ts'

export type StatsMetadata = Record<string, string>

export interface Customer {
  id: string
  stripe_customer_id: string
}

export interface AppInfos {
  version_name: string
  version_build: string
  version_os: string
  custom_id?: string
  is_prod?: boolean
  is_emulator?: boolean
  install_source?: string
  plugin_version: string
  platform: string
  app_id: string
  device_id: string
  defaultChannel: string
  key_id?: string
}

export interface AppStats extends AppInfos {
  action: string
  old_version_name?: string
  metadata?: StatsMetadata
}

export interface BaseHeaders {
  [k: string]: string | undefined
}

export interface Order {
  key: string
  sortable?: 'asc' | 'desc'
}

export interface ReadStatsParams {
  app_id: string
  version_name?: string
  start_date?: string
  end_date?: string
  deviceIds?: string[]
  search?: string
  order?: Order[]
  limit?: number
  actions?: string[]
}

export interface ReadStatsInsightsParams {
  app_id: string
  start_date: string
  end_date: string
  actions?: string[]
}

export interface StatsInsightSummary {
  total: number
  device_count: number
  action_count: number
}

export interface StatsInsightAction {
  action: string
  total: number
  device_count: number
  version_count: number
  first_seen: string | null
  last_seen: string | null
  latest_version_name: string
  latest_device_id: string
}

export interface StatsInsightDaily {
  date: string
  action: string
  total: number
}

export interface StatsInsightVersion {
  action: string
  version_name: string
  total: number
  device_count: number
  last_seen: string | null
}

export interface StatsInsightDevice {
  action: string
  device_id: string
  total: number
  version_name: string
  last_seen: string | null
}

export interface StatsInsightsResult {
  summary: StatsInsightSummary
  actions: StatsInsightAction[]
  daily: StatsInsightDaily[]
  versions: StatsInsightVersion[]
  devices: StatsInsightDevice[]
}

// Unified version usage statistics interface (returned by both Cloudflare and Supabase)
export interface VersionUsage {
  date: string
  app_id: string
  version_name: string
  get: number
  fail: number
  install: number
  uninstall: number
}

export interface VersionUsageChannel {
  id?: number | null
  name?: string | null
}

export interface NativeVersionUsage {
  date: string
  platform: string
  version_build: string
  devices: number
}

export interface ReadDevicesParams {
  app_id: string
  version_name?: string | undefined
  deviceIds?: string[]
  installSources?: string[]
  search?: string
  order?: Order[]
  /** Only return devices with updated_at greater than this ISO timestamp */
  updated_at_gt?: string
  limit?: number
  /** Cursor for pagination - use the last updated_at from previous page */
  cursor?: string
}
export type DeviceRes = {
  id?: Database['public']['Tables']['devices']['Row']['id']
} & Omit<Database['public']['Tables']['devices']['Row'], 'id'>

export interface ReadDevicesResponse {
  data: DeviceRes[]
  /** Cursor for next page - pass this as cursor param to get next page */
  nextCursor?: string
  /** Whether there are more results */
  hasMore: boolean
}

export type DeviceWithoutCreatedAt = Omit<Database['public']['Tables']['devices']['Insert'], 'created_at'>
export interface StatsActions {
  action: Database['public']['Enums']['stats_action']
  versionName?: string
  metadata?: StatsMetadata
}

export const DEFAULT_LIMIT = 1000

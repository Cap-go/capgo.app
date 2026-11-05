/**
 * Shapes of the Capgo API payloads the CLI reads and sends. The CLI owns these
 * types: they describe the HTTP contract, not the backend's storage.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type DisableUpdate = 'major' | 'minor' | 'patch' | 'version_number' | 'none'

export type ChannelUpdatePackage = 'all' | 'zip' | 'delta' | 'zip_from_builtin' | 'delta_from_builtin'

export interface ManifestEntry {
  file_name: string | null
  s3_path: string | null
  file_hash: string | null
}

export interface AppRow {
  allow_device_custom_id: boolean
  allow_preview: boolean
  android_store_url: string | null
  app_id: string
  build_timeout_seconds: number
  build_timeout_updated_at: string
  block_provider_infra_requests: boolean
  channel_device_count: number
  created_at: string | null
  created_from_onboarding: boolean
  default_upload_channel: string
  device_data_collection: Json
  existing_app: boolean
  expose_metadata: boolean
  icon_url: string
  id: string | null
  ios_store_url: string | null
  last_version: string | null
  manifest_bundle_count: number
  rollout_channel_count: number
  rollout_paused_version_names: string[]
  name: string | null
  need_onboarding: boolean
  onboarding: Json
  onboarding_completed_at: string | null
  owner_org: string
  retention: number
  stats_refresh_requested_at: string | null
  stats_updated_at: string | null
  transfer_history: Json[] | null
  updated_at: string | null
  user_id: string | null
}

export interface AppVersionRow {
  app_id: string
  checksum: string | null
  cli_version: string | null
  comment: string | null
  created_at: string | null
  created_by_apikey_rbac_id: string | null
  deleted: boolean
  deleted_at: string | null
  external_url: string | null
  id: number
  key_id: string | null
  link: string | null
  manifest: ManifestEntry[] | null
  manifest_count: number
  min_update_version: string | null
  name: string
  native_packages: Json[] | null
  owner_org: string
  r2_path: string | null
  session_key: string | null
  storage_provider: string
  updated_at: string | null
  user_id: string | null
}

export interface AppVersionInsert {
  app_id: string
  checksum?: string | null
  cli_version?: string | null
  comment?: string | null
  created_at?: string | null
  created_by_apikey_rbac_id?: string | null
  deleted?: boolean
  deleted_at?: string | null
  external_url?: string | null
  id?: number
  key_id?: string | null
  link?: string | null
  manifest?: ManifestEntry[] | null
  manifest_count?: number
  min_update_version?: string | null
  name: string
  native_packages?: Json[] | null
  owner_org: string
  r2_path?: string | null
  session_key?: string | null
  storage_provider?: string
  updated_at?: string | null
  user_id?: string | null
}

export interface ChannelRow {
  allow_dev: boolean
  allow_device: boolean
  allow_device_self_set: boolean
  allow_emulator: boolean
  allow_prod: boolean
  android: boolean
  app_id: string
  created_at: string
  created_by: string
  disable_auto_update: DisableUpdate
  disable_auto_update_under_native: boolean
  electron: boolean
  id: number
  ios: boolean
  name: string
  owner_org: string
  paused_at: string | null
  public: boolean
  auto_pause_action: string
  auto_pause_confidence: number
  auto_pause_cooldown_minutes: number
  auto_pause_enabled: boolean
  auto_pause_failure_rate_bps: number | null
  auto_pause_last_checked_at: string | null
  auto_pause_last_triggered_at: string | null
  auto_pause_min_attempts: number | null
  auto_pause_min_failures: number | null
  auto_pause_window_minutes: number
  rollout_cache_ttl_seconds: number
  rollout_enabled: boolean
  rollout_id: string
  rollout_pause_reason: string | null
  rollout_paused_at: string | null
  rollout_percentage_bps: number
  rollout_version: number | null
  rbac_id: string
  update_package: ChannelUpdatePackage
  updated_at: string
  version: number | null
}

export interface ChannelInsert {
  allow_dev?: boolean
  allow_device?: boolean
  allow_device_self_set?: boolean
  allow_emulator?: boolean
  allow_prod?: boolean
  android?: boolean
  app_id: string
  created_at?: string
  created_by: string
  disable_auto_update?: DisableUpdate
  disable_auto_update_under_native?: boolean
  electron?: boolean
  id?: number
  ios?: boolean
  name: string
  owner_org: string
  paused_at?: string | null
  public?: boolean
  auto_pause_action?: string
  auto_pause_confidence?: number
  auto_pause_cooldown_minutes?: number
  auto_pause_enabled?: boolean
  auto_pause_failure_rate_bps?: number | null
  auto_pause_last_checked_at?: string | null
  auto_pause_last_triggered_at?: string | null
  auto_pause_min_attempts?: number | null
  auto_pause_min_failures?: number | null
  auto_pause_window_minutes?: number
  rollout_cache_ttl_seconds?: number
  rollout_enabled?: boolean
  rollout_id?: string
  rollout_pause_reason?: string | null
  rollout_paused_at?: string | null
  rollout_percentage_bps?: number
  rollout_version?: number | null
  rbac_id?: string
  update_package?: ChannelUpdatePackage
  updated_at?: string
  version?: number | null
}

export interface Organization {
  '2fa_has_access': boolean
  app_count: number
  can_use_more: boolean
  created_at: string
  created_by: string
  credit_available: number
  credit_next_expiration: string
  credit_total: number
  enforce_encrypted_bundles: boolean
  enforce_hashed_api_keys: boolean
  enforcing_2fa: boolean
  gid: string
  is_canceled: boolean
  is_invite: boolean
  is_yearly: boolean
  logo: string
  management_email: string
  max_apikey_expiration_days: number
  name: string
  next_stats_update_at: string
  password_has_access: boolean
  password_policy_config: Json
  paying: boolean
  require_apikey_expiration: boolean
  required_encryption_key: string
  role: string
  stats_refresh_requested_at: string
  stats_updated_at: string
  subscription_end: string
  subscription_start: string
  trial_left: number
  website: string
}

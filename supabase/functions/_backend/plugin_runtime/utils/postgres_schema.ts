import { bigint, boolean, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, serial, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

// do_not_change

export const disableUpdatePgEnum = pgEnum('disable_update', ['major', 'minor', 'patch', 'version_number', 'none'])

export const apps = pgTable('apps', {
  created_at: timestamp('created_at').notNull().defaultNow(),
  app_id: varchar('app_id').notNull(),
  icon_url: varchar('icon_url').notNull(),
  owner_org: uuid('owner_org').notNull(),
  name: varchar('name').unique(),
  last_version: varchar('last_version'),
  updated_at: timestamp('updated_at'),
  id: uuid('id').primaryKey().unique(),
  retention: bigint('retention', { mode: 'number' }).notNull().default(2592000),
  build_timeout_seconds: bigint('build_timeout_seconds', { mode: 'number' }).notNull().default(900),
  build_timeout_updated_at: timestamp('build_timeout_updated_at', { withTimezone: true }).notNull().defaultNow(),
  channel_device_count: bigint('channel_device_count', { mode: 'number' }).notNull().default(0),
  manifest_bundle_count: bigint('manifest_bundle_count', { mode: 'number' }).notNull().default(0),
  rollout_channel_count: bigint('rollout_channel_count', { mode: 'number' }).notNull().default(0),
  rollout_paused_version_names: varchar('rollout_paused_version_names').array().notNull(),
  expose_metadata: boolean('expose_metadata').notNull().default(false),
  block_provider_infra_requests: boolean('block_provider_infra_requests').notNull().default(true),
  allow_device_custom_id: boolean('allow_device_custom_id').notNull().default(true),
  need_onboarding: boolean('need_onboarding').notNull().default(false),
  created_from_onboarding: boolean('created_from_onboarding').notNull().default(false),
  onboarding_completed_at: timestamp('onboarding_completed_at', { withTimezone: true }),
  existing_app: boolean('existing_app').notNull().default(false),
  ios_store_url: text('ios_store_url'),
  android_store_url: text('android_store_url'),
})

export const app_versions = pgTable('app_versions', {
  id: bigint('id', { mode: 'number' }).primaryKey().notNull(),
  owner_org: uuid('owner_org').notNull(),
  created_at: timestamp('created_at').notNull(),
  app_id: varchar('app_id').notNull().references(() => apps.name),
  name: varchar('name').notNull(),
  user_id: uuid('user_id'),
  created_by_apikey_rbac_id: uuid('created_by_apikey_rbac_id'),
  updated_at: timestamp('updated_at').defaultNow(),
  deleted: boolean('deleted').default(false),
  deleted_at: timestamp('deleted_at'),
  external_url: varchar('external_url'),
  checksum: varchar('checksum'),
  session_key: varchar('session_key'),
  key_id: varchar('key_id', { length: 20 }),
  storage_provider: text('storage_provider').default('r2').notNull(),
  min_update_version: varchar('min_update_version'),
  r2_path: varchar('r2_path'),
  link: varchar('link'),
  comment: varchar('comment'),
  manifest_count: integer('manifest_count').notNull().default(0),
})

export const manifest = pgTable('manifest', {
  id: serial('id').primaryKey().notNull(),
  app_version_id: bigint('app_version_id', { mode: 'number' }).notNull().references(() => app_versions.id, { onDelete: 'cascade' }),
  file_name: varchar('file_name').notNull(),
  s3_path: varchar('s3_path').notNull(),
  file_hash: varchar('file_hash').notNull(),
  file_size: bigint('file_size', { mode: 'number' }).default(0),
})

export const channels = pgTable('channels', {
  id: bigint('id', { mode: 'number' }).primaryKey().notNull(),
  owner_org: uuid('owner_org').notNull(),
  created_at: timestamp('created_at').notNull(),
  name: varchar('name').notNull(),
  app_id: varchar('app_id').notNull().references(() => apps.name),
  version: bigint('version', { mode: 'number' }).references(() => app_versions.id, { onDelete: 'set null' }),
  created_by: uuid('created_by').notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
  public: boolean('public').notNull().default(false),
  disable_auto_update_under_native: boolean('disable_auto_update_under_native').notNull().default(true),
  disable_auto_update: disableUpdatePgEnum('disable_auto_update').default('major').notNull(),
  ios: boolean('ios').default(true).notNull(),
  android: boolean('android').notNull().default(true),
  electron: boolean('electron').notNull().default(true),
  allow_device_self_set: boolean('allow_device_self_set').default(false).notNull(),
  allow_emulator: boolean('allow_emulator').notNull().default(true),
  allow_device: boolean('allow_device').notNull().default(true),
  allow_dev: boolean('allow_dev').notNull().default(true),
  allow_prod: boolean('allow_prod').notNull().default(true),
  rollout_version: bigint('rollout_version', { mode: 'number' }).references(() => app_versions.id, { onDelete: 'set null' }),
  rollout_percentage_bps: integer('rollout_percentage_bps').notNull().default(0),
  rollout_enabled: boolean('rollout_enabled').notNull().default(false),
  rollout_id: uuid('rollout_id').notNull().defaultRandom(),
  rollout_paused_at: timestamp('rollout_paused_at', { withTimezone: true }),
  rollout_pause_reason: text('rollout_pause_reason'),
  rollout_cache_ttl_seconds: integer('rollout_cache_ttl_seconds').notNull().default(2592000),
  auto_pause_enabled: boolean('auto_pause_enabled').notNull().default(false),
  auto_pause_window_minutes: integer('auto_pause_window_minutes').notNull().default(60),
  auto_pause_failure_rate_bps: integer('auto_pause_failure_rate_bps'),
  auto_pause_confidence: numeric('auto_pause_confidence', { precision: 5, scale: 4 }).notNull().default('0.9500'),
  auto_pause_min_attempts: integer('auto_pause_min_attempts'),
  auto_pause_min_failures: integer('auto_pause_min_failures'),
  auto_pause_action: text('auto_pause_action').notNull().default('pause'),
  auto_pause_cooldown_minutes: integer('auto_pause_cooldown_minutes').notNull().default(60),
  auto_pause_last_triggered_at: timestamp('auto_pause_last_triggered_at', { withTimezone: true }),
  auto_pause_last_checked_at: timestamp('auto_pause_last_checked_at', { withTimezone: true }),
  rbac_id: uuid('rbac_id').notNull(),
})

export const channel_devices = pgTable('channel_devices', {
  id: bigint('id', { mode: 'number' }),
  created_at: timestamp('created_at').notNull().defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
  device_id: text('device_id').notNull(),
  channel_id: bigint('channel_id', { mode: 'number' }).notNull().references(() => channels.id),
  app_id: varchar('app_id').notNull().references(() => apps.name),
  owner_org: uuid('owner_org').notNull(),
})

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().notNull(),
  created_by: uuid('created_by').notNull(),
  logo: text('logo'),
  name: text('name').notNull(),
  management_email: text('management_email').notNull(),
  customer_id: text('customer_id'),
  require_apikey_expiration: boolean('require_apikey_expiration').notNull().default(false),
  max_apikey_expiration_days: integer('max_apikey_expiration_days'),
  onboarding: jsonb('onboarding').notNull().default({ intent: 'unknown' }),
  email_preferences: jsonb('email_preferences'),
  has_usage_credits: boolean('has_usage_credits').notNull().default(false),
})

export const notifications = pgTable('notifications', {
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
  last_send_at: timestamp('last_send_at').notNull().defaultNow(),
  total_send: bigint('total_send', { mode: 'number' }).notNull().default(1),
  owner_org: uuid('owner_org').notNull(),
  event: varchar('event', { length: 255 }).notNull(),
  uniq_id: varchar('uniq_id', { length: 255 }).notNull(),
})

export const users = pgTable('users', {
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  image_url: varchar('image_url'),
  first_name: varchar('first_name'),
  last_name: varchar('last_name'),
  country: varchar('country'),
  email: varchar('email').notNull(),
  id: uuid('id').primaryKey().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  enable_notifications: boolean('enable_notifications').notNull().default(true),
  opt_for_newsletters: boolean('opt_for_newsletters').notNull().default(true),
  ban_time: timestamp('ban_time', { withTimezone: true }),
  email_preferences: jsonb('email_preferences').notNull().default({
    usage_limit: true,
    credit_usage: true,
    onboarding: true,
    builder_onboarding: true,
    weekly_stats: true,
    monthly_stats: true,
    deploy_stats_24h: true,
    bundle_created: true,
    bundle_deployed: true,
    device_error: true,
    channel_self_rejected: true,
    cli_realtime_feed: true,
  }),
})

export const stripe_info = pgTable('stripe_info', {
  id: bigint('id', { mode: 'number' }).primaryKey().notNull(),
  customer_id: text('customer_id'),
  customer_country: varchar('customer_country', { length: 2 }),
  product_id: varchar('product_id'),
  status: text('status'),
  trial_at: text('trial_at'),
  is_good_plan: boolean('is_good_plan'),
  mau_exceeded: boolean('mau_exceeded'),
  past_due_at: timestamp('past_due_at', { withTimezone: true }),
  churn_reason: text('churn_reason'),
  storage_exceeded: boolean('storage_exceeded'),
  bandwidth_exceeded: boolean('bandwidth_exceeded'),
})

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().notNull(),
  name: varchar('name').notNull(),
  stripe_id: varchar('stripe_id').notNull(),
  credit_id: text('credit_id').notNull(),
  native_build_concurrency: integer('native_build_concurrency').notNull().default(2),
})

export const apikeys = pgTable('apikeys', {
  id: bigint('id', { mode: 'number' }).primaryKey().notNull(),
  created_at: timestamp('created_at').defaultNow(),
  user_id: uuid('user_id').notNull(),
  key: varchar('key'),
  key_hash: varchar('key_hash'),
  updated_at: timestamp('updated_at').defaultNow(),
  name: varchar('name').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }),
  rbac_id: uuid('rbac_id').notNull(),
})

export const org_users = pgTable('org_users', {
  id: bigint('id', { mode: 'number' }).primaryKey().notNull(),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
  user_id: uuid('user_id').notNull(),
  org_id: uuid('org_id').notNull(),
  app_id: varchar('app_id'),
  channel_id: bigint('channel_id', { mode: 'number' }),
  rbac_role_name: text('rbac_role_name'),
  is_invite: boolean('is_invite').notNull().default(false),
})

// RBAC tables
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  scope_type: text('scope_type').notNull(),
  description: text('description'),
  priority_rank: bigint('priority_rank', { mode: 'number' }).notNull().default(0),
  is_assignable: boolean('is_assignable').notNull().default(true),
  created_at: timestamp('created_at').notNull().defaultNow(),
  created_by: uuid('created_by'),
})

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  is_system: boolean('is_system').notNull().default(false),
  created_by: uuid('created_by'),
  created_at: timestamp('created_at').notNull().defaultNow(),
})

export const group_members = pgTable(
  'group_members',
  {
    group_id: uuid('group_id').notNull(),
    user_id: uuid('user_id').notNull(),
    added_by: uuid('added_by'),
    added_at: timestamp('added_at').notNull().defaultNow(),
  },
  t => ({
    pk: primaryKey({ columns: [t.group_id, t.user_id] }),
  }),
)

export const role_bindings = pgTable('role_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  principal_type: text('principal_type').notNull(),
  principal_id: uuid('principal_id').notNull(),
  role_id: uuid('role_id').notNull(),
  scope_type: text('scope_type').notNull(),
  org_id: uuid('org_id'),
  app_id: uuid('app_id'),
  bundle_id: bigint('bundle_id', { mode: 'number' }),
  channel_id: uuid('channel_id'),
  granted_by: uuid('granted_by').notNull(),
  granted_at: timestamp('granted_at').notNull().defaultNow(),
  expires_at: timestamp('expires_at'),
  reason: text('reason'),
  is_direct: boolean('is_direct').notNull().default(true),
  parent_binding_id: uuid('parent_binding_id'),
})

// Export all tables as schema object for convenience
export const schema = {
  apps,
  app_versions,
  manifest,
  channels,
  channel_devices,
  orgs,
  users,
  stripe_info,
  apikeys,
  org_users,
  roles,
  groups,
  group_members,
  role_bindings,
}

import { z } from 'zod'

/**
 * Hosted Capgo MCP tools.
 *
 * Every tool is a thin, typed wrapper over an existing public API route. Tools never touch the
 * database directly: they replay the request through the API worker with the caller's API key,
 * so authentication, RBAC, org policies, rate limits and audit logging stay in one place.
 */

export type McpHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface McpApiRequest {
  method: McpHttpMethod
  path: string
  query?: Record<string, unknown>
  body?: Record<string, unknown>
  /** Read a text/event-stream response for a bounded time instead of parsing JSON. */
  stream?: boolean
}

export interface McpApiResponse {
  ok: boolean
  status: number
  data: unknown
}

export interface McpCaller {
  userId: string
  apikeyId: number
  apikeyName: string
  apikeyExpiresAt: string | null
}

export interface McpToolContext {
  call: (request: McpApiRequest) => Promise<McpApiResponse>
  caller: McpCaller
}

export interface McpToolResult {
  content: Array<{ type: 'text', text: string }>
  isError?: boolean
}

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: z.ZodObject<z.ZodRawShape>
  annotations: McpToolAnnotations
  run: (input: Record<string, unknown>, ctx: McpToolContext) => Promise<McpToolResult>
}

const MAX_RESULT_CHARS = 100_000

export function textResult(value: unknown, isError = false): McpToolResult {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  if (text === undefined)
    text = 'null'
  if (text.length > MAX_RESULT_CHARS)
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated, use pagination or narrower filters)`
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

export function apiResult(response: McpApiResponse): McpToolResult {
  if (response.ok)
    return textResult(response.data)
  return textResult({ status: response.status, ...(typeof response.data === 'object' && response.data !== null ? response.data : { error: response.data }) }, true)
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies McpToolAnnotations
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies McpToolAnnotations
// Deletes, cancellations and overwrites of existing settings. OpenAI plugin guidelines count
// overwrites as destructive even when they can be undone, so clients ask before running them.
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } satisfies McpToolAnnotations
const EXTERNAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies McpToolAnnotations

const appId = z.string().min(1).describe('App ID in reverse-domain form, e.g. com.example.app')
const orgId = z.string().uuid().describe('Organization ID (UUID). Use capgo_list_organizations to find it.')
const page = z.number().int().min(0).optional().describe('0-based page number (50 results per page)')
const dateString = z.string().min(1).describe('Date, e.g. 2026-01-31 or an ISO timestamp')
const webhookEvents = z.array(z.enum(['apps', 'app_versions', 'channels', 'org_users', 'orgs'])).min(1)
const disableAutoUpdate = z.enum(['major', 'minor', 'patch', 'version_number', 'none'])
  .describe('Block automatic updates across this semver boundary (version_number = same native version only, none = allow all)')
const notificationTarget = z.object({
  externalId: z.string().optional().describe('Your own user identifier bound to devices'),
  recipientKey: z.string().optional(),
  deviceKey: z.string().optional(),
  tag: z.string().optional(),
  broadcast: z.boolean().optional().describe('Send to every registered device of the app'),
}).describe('Who receives it: set exactly one of externalId, recipientKey, deviceKey, tag or broadcast=true')

type Shape = z.ZodRawShape

interface ApiToolSpec<S extends Shape> {
  name: string
  title: string
  description: string
  input: S
  annotations: McpToolAnnotations
  request: (input: z.infer<z.ZodObject<S>>) => McpApiRequest
}

function apiTool<S extends Shape>(spec: ApiToolSpec<S>): McpTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: z.object(spec.input) as unknown as z.ZodObject<z.ZodRawShape>,
    annotations: { title: spec.title, ...spec.annotations },
    run: async (input, ctx) => apiResult(await ctx.call(spec.request(input as z.infer<z.ZodObject<S>>))),
  }
}

/** Drop undefined keys so optional fields are not sent as explicit nulls. */
function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

// ---------------------------------------------------------------------------
// Account & organizations
// ---------------------------------------------------------------------------
const accountTools: McpTool[] = [
  {
    name: 'capgo_whoami',
    title: 'Who am I',
    description: 'Show which Capgo user and API key this MCP connection is authenticated as. Call this first to confirm access.',
    inputSchema: z.object({}),
    annotations: { title: 'Who am I', ...READ },
    run: async (_input, ctx) => textResult({
      user_id: ctx.caller.userId,
      apikey_id: ctx.caller.apikeyId,
      apikey_name: ctx.caller.apikeyName,
      apikey_expires_at: ctx.caller.apikeyExpiresAt,
    }),
  },
  apiTool({
    name: 'capgo_list_organizations',
    title: 'List organizations',
    description: 'List the Capgo organizations this connection can access.',
    input: { page },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/organization', query: input }),
  }),
  apiTool({
    name: 'capgo_get_organization',
    title: 'Get organization',
    description: 'Get one organization by ID.',
    input: { orgId },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/organization', query: input }),
  }),
  apiTool({
    name: 'capgo_add_organization',
    title: 'Create organization',
    description: 'Create a new organization. The API key needs the org.create global permission.',
    input: {
      name: z.string().min(3),
      email: z.string().email().optional().describe('Management email, defaults to the account email'),
      website: z.string().optional(),
    },
    annotations: WRITE,
    request: input => ({ method: 'POST', path: '/organization', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_update_organization',
    title: 'Update organization',
    description: 'Update organization settings (name, website, management email, API key policies, bundle encryption and 2FA enforcement).',
    input: {
      orgId,
      name: z.string().optional(),
      website: z.string().nullable().optional(),
      management_email: z.string().email().optional(),
      require_apikey_expiration: z.boolean().optional(),
      max_apikey_expiration_days: z.number().int().min(1).max(365).nullable().optional(),
      enforce_hashed_api_keys: z.boolean().optional(),
      enforce_encrypted_bundles: z.boolean().optional(),
      required_encryption_key: z.string().nullable().optional(),
      enforcing_2fa: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'PUT', path: '/organization', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_delete_organization',
    title: 'Delete organization',
    description: 'Permanently delete an organization with all its apps, bundles and data. Irreversible: confirm with the user first.',
    input: { orgId },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: '/organization', body: input }),
  }),
  apiTool({
    name: 'capgo_list_organization_members',
    title: 'List organization members',
    description: 'List the members of an organization with their roles.',
    input: { orgId },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/organization/members', query: input }),
  }),
  apiTool({
    name: 'capgo_invite_organization_member',
    title: 'Invite organization member',
    description: 'Invite a user to an organization by email.',
    input: {
      orgId,
      email: z.string().email(),
      invite_type: z.enum(['org_member', 'org_billing_admin', 'org_admin', 'org_super_admin']).describe('Role granted to the invited user'),
    },
    annotations: WRITE,
    request: input => ({ method: 'POST', path: '/organization/members', body: input }),
  }),
  apiTool({
    name: 'capgo_remove_organization_member',
    title: 'Remove organization member',
    description: 'Remove a member from an organization.',
    input: { orgId, email: z.string().email() },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: '/organization/members', body: input }),
  }),
  apiTool({
    name: 'capgo_list_audit_logs',
    title: 'List audit logs',
    description: 'Read the organization audit log (who changed what, and when).',
    input: {
      orgId,
      tableName: z.string().optional().describe('Filter by table, e.g. apps, channels, app_versions'),
      operation: z.string().optional().describe('Filter by operation: INSERT, UPDATE or DELETE'),
      page,
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/organization/audit', query: input }),
  }),
  apiTool({
    name: 'capgo_list_api_keys',
    title: 'List API keys',
    description: 'List the API keys of the account (secrets are never returned).',
    input: {},
    annotations: READ,
    request: () => ({ method: 'GET', path: '/apikey' }),
  }),
  apiTool({
    name: 'capgo_delete_api_key',
    title: 'Delete API key',
    description: 'Delete (revoke) an API key by its numeric ID. A key cannot delete itself.',
    input: { id: z.number().int().positive() },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: `/apikey/${input.id}` }),
  }),
]

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------
const appTools: McpTool[] = [
  apiTool({
    name: 'capgo_list_apps',
    title: 'List apps',
    description: 'List the apps this connection can access, optionally for one organization.',
    input: { org_id: orgId.optional(), page, limit: z.number().int().min(1).max(100).optional() },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/app', query: input }),
  }),
  apiTool({
    name: 'capgo_get_app',
    title: 'Get app',
    description: 'Get the settings of one app.',
    input: { appId },
    annotations: READ,
    request: input => ({ method: 'GET', path: `/app/${enc(input.appId)}` }),
  }),
  apiTool({
    name: 'capgo_add_app',
    title: 'Create app',
    description: 'Register a new app in an organization.',
    input: {
      appId,
      name: z.string().min(1),
      orgId,
      ios_store_url: z.string().optional(),
      android_store_url: z.string().optional(),
    },
    annotations: WRITE,
    request: input => ({
      method: 'POST',
      path: '/app',
      body: compact({
        app_id: input.appId,
        name: input.name,
        owner_org: input.orgId,
        ios_store_url: input.ios_store_url,
        android_store_url: input.android_store_url,
        onboarding: { source: 'mcp' },
      }),
    }),
  }),
  apiTool({
    name: 'capgo_update_app',
    title: 'Update app',
    description: 'Update app settings such as name, bundle retention, metadata exposure and store URLs.',
    input: {
      appId,
      name: z.string().optional(),
      retention: z.number().int().min(0).max(63113903).optional().describe('Seconds to keep unused bundles before automatic deletion'),
      expose_metadata: z.boolean().optional(),
      allow_device_custom_id: z.boolean().optional(),
      ios_store_url: z.string().nullable().optional(),
      android_store_url: z.string().nullable().optional(),
    },
    annotations: DESTRUCTIVE,
    request: ({ appId: id, ...rest }) => ({ method: 'PUT', path: `/app/${enc(id)}`, body: compact(rest) }),
  }),
  apiTool({
    name: 'capgo_delete_app',
    title: 'Delete app',
    description: 'Permanently delete an app with all its bundles, channels, devices and stats. Irreversible: confirm with the user first.',
    input: { appId },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: `/app/${enc(input.appId)}` }),
  }),
  apiTool({
    name: 'capgo_create_demo_app',
    title: 'Create demo app',
    description: 'Create a demo app pre-filled with sample bundles, channels and devices to explore Capgo.',
    input: { orgId, appId: appId.optional() },
    annotations: WRITE,
    request: input => ({ method: 'POST', path: '/app/demo', body: compact({ owner_org: input.orgId, app_id: input.appId }) }),
  }),
  apiTool({
    name: 'capgo_fetch_store_metadata',
    title: 'Fetch store metadata',
    description: 'Read the app name and icon from an App Store or Google Play listing URL.',
    input: { url: z.string().url() },
    annotations: { ...READ, openWorldHint: true },
    request: input => ({ method: 'POST', path: '/app/store-metadata', body: input }),
  }),
]

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------
const bundleTools: McpTool[] = [
  apiTool({
    name: 'capgo_list_bundles',
    title: 'List bundles',
    description: 'List the uploaded bundles (live update versions) of an app, newest first.',
    input: {
      appId,
      page,
      version: z.string().min(1).optional().describe('Exact bundle version name (app_versions.name), e.g. 1.2.3'),
      id: z.number().int().positive().optional().describe('Numeric bundle id (app_versions.id)'),
    },
    annotations: READ,
    request: input => ({
      method: 'GET',
      path: '/bundle',
      query: compact({ app_id: input.appId, page: input.page, version: input.version, id: input.id }),
    }),
  }),
  apiTool({
    name: 'capgo_create_bundle_from_url',
    title: 'Register external bundle',
    description: 'Register a bundle hosted at an external https URL (zip). To upload local files use the Capgo CLI instead: npx @capgo/cli@latest bundle upload.',
    input: {
      appId,
      version: z.string().min(1).describe('Semver version name, e.g. 1.2.3'),
      external_url: z.string().url().describe('https URL of the bundle zip'),
      checksum: z.string().min(1).describe('Checksum of the zip as produced by the Capgo CLI'),
      session_key: z.string().optional().describe('Encryption session key when the bundle is encrypted'),
      key_id: z.string().optional(),
      signature: z.string().regex(/^[0-9a-f]{512}$/).optional().describe('Hex RSA signature of the bundle version + zip checksum (capgo-bundle-v1), produced by the Capgo CLI with the private key'),
      manifest_signature: z.string().regex(/^[0-9a-f]{512}$/).optional().describe('Hex RSA signature of the bundle version + manifest file hashes (capgo-manifest-v1)'),
    },
    annotations: WRITE,
    request: ({ appId: id, ...rest }) => ({ method: 'POST', path: '/bundle', body: compact({ app_id: id, ...rest }) }),
  }),
  apiTool({
    name: 'capgo_update_bundle_metadata',
    title: 'Update bundle metadata',
    description: 'Set the link and/or comment of a bundle. Needs the numeric bundle id from capgo_list_bundles.',
    input: {
      appId,
      version_id: z.number().int().positive(),
      link: z.string().optional(),
      comment: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
    request: ({ appId: id, ...rest }) => ({ method: 'POST', path: '/bundle/metadata', body: compact({ app_id: id, ...rest }) }),
  }),
  apiTool({
    name: 'capgo_set_bundle_channel',
    title: 'Set bundle to channel',
    description: 'Point a channel to a bundle by numeric ids (from capgo_list_bundles and capgo_list_channels). capgo_update_channel with a version name does the same by name.',
    input: { appId, version_id: z.number().int().positive(), channel_id: z.number().int().positive() },
    annotations: DESTRUCTIVE,
    request: ({ appId: id, ...rest }) => ({ method: 'PUT', path: '/bundle', body: { app_id: id, ...rest } }),
  }),
  apiTool({
    name: 'capgo_delete_bundle',
    title: 'Delete bundle',
    description: 'Delete one bundle version. Bundles linked to a channel cannot be deleted.',
    input: { appId, version: z.string().min(1).describe('Bundle version name') },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: '/bundle', body: { app_id: input.appId, version: input.version } }),
  }),
]

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
const channelSettings = {
  version: z.string().nullable().optional().describe('Bundle version name to serve on this channel; null unlinks it'),
  public: z.boolean().optional().describe('Make this the default channel for devices without an override'),
  disableAutoUpdate: disableAutoUpdate.optional(),
  disableAutoUpdateUnderNative: z.boolean().optional().describe('Block bundles older than the native app version'),
  ios: z.boolean().optional(),
  android: z.boolean().optional(),
  electron: z.boolean().optional(),
  allow_device_self_set: z.boolean().optional().describe('Let devices switch themselves to this channel'),
  allow_emulator: z.boolean().optional(),
  allow_device: z.boolean().optional().describe('Allow physical devices'),
  allow_dev: z.boolean().optional().describe('Allow development builds'),
  allow_prod: z.boolean().optional().describe('Allow production builds'),
}

const channelTools: McpTool[] = [
  apiTool({
    name: 'capgo_list_channels',
    title: 'List channels',
    description: 'List the channels of an app with their current bundle and rollout state.',
    input: { appId, page },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/channel', query: { app_id: input.appId, page: input.page } }),
  }),
  apiTool({
    name: 'capgo_get_channel',
    title: 'Get channel',
    description: 'Get one channel by name.',
    input: { appId, channel: z.string().min(1) },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/channel', query: { app_id: input.appId, channel: input.channel } }),
  }),
  apiTool({
    name: 'capgo_add_channel',
    title: 'Create channel',
    description: 'Create a channel (or update it if it already exists).',
    input: { appId, channel: z.string().min(1).describe('Channel name, e.g. production or beta'), ...channelSettings },
    annotations: DESTRUCTIVE,
    request: ({ appId: id, ...rest }) => ({ method: 'POST', path: '/channel', body: compact({ app_id: id, ...rest }) }),
  }),
  apiTool({
    name: 'capgo_update_channel',
    title: 'Update channel',
    description: 'Change channel settings or deploy a bundle to it by setting version. For progressive rollouts use capgo_update_channel_rollout.',
    input: { appId, channel: z.string().min(1), ...channelSettings },
    annotations: DESTRUCTIVE,
    request: ({ appId: id, ...rest }) => ({ method: 'POST', path: '/channel', body: compact({ app_id: id, ...rest }) }),
  }),
  apiTool({
    name: 'capgo_update_channel_rollout',
    title: 'Manage progressive rollout',
    description: 'Start, adjust, pause, resume, promote or roll back a progressive rollout on a channel, and configure automatic pause on failures.',
    input: {
      appId,
      channel: z.string().min(1),
      rolloutVersion: z.union([z.string(), z.number().int()]).nullable().optional().describe('Bundle (name or id) being rolled out'),
      rolloutPercentage: z.number().min(0).max(100).optional().describe('Share of devices getting the rollout bundle'),
      rolloutEnabled: z.boolean().optional(),
      rolloutPaused: z.boolean().optional(),
      rolloutPauseReason: z.string().nullable().optional(),
      promoteToStable: z.boolean().optional().describe('Make the rollout bundle the channel bundle for everyone'),
      rollback: z.boolean().optional().describe('Cancel the rollout; everyone stays on the channel bundle'),
      advanceRollout: z.boolean().optional().describe('Promote the current rollout to stable and start rolling out rolloutVersion'),
      autoPauseEnabled: z.boolean().optional(),
      autoPauseWindowMinutes: z.number().int().min(1).max(10080).optional(),
      autoPauseFailureRateBps: z.number().int().min(0).max(10000).nullable().optional().describe('Failure rate threshold in basis points (100 = 1%)'),
      autoPauseMinAttempts: z.number().int().min(0).nullable().optional(),
      autoPauseMinFailures: z.number().int().min(0).nullable().optional(),
      autoPauseAction: z.enum(['pause', 'rollback', 'notify']).optional(),
      autoPauseCooldownMinutes: z.number().int().min(0).max(10080).optional(),
    },
    annotations: { ...WRITE, destructiveHint: true },
    request: ({ appId: id, ...rest }) => ({ method: 'POST', path: '/channel', body: compact({ app_id: id, ...rest }) }),
  }),
  apiTool({
    name: 'capgo_delete_channel',
    title: 'Delete channel',
    description: 'Delete a channel. Devices on it fall back to the default channel.',
    input: { appId, channel: z.string().min(1) },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: '/channel', body: { app_id: input.appId, channel: input.channel } }),
  }),
]

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
const deviceTools: McpTool[] = [
  apiTool({
    name: 'capgo_list_devices',
    title: 'List devices',
    description: 'List devices that checked for updates, with their current bundle, platform and versions. Paginate with cursor.',
    input: {
      appId,
      custom_id: z.string().max(36).optional().describe('Exact custom id set by the app'),
      customIdMode: z.boolean().optional().describe('Only devices that have a custom id'),
      cursor: z.string().optional().describe('nextCursor from the previous page'),
      limit: z.number().int().min(1).max(100).optional(),
      updated_at: z.string().optional().describe('Only devices updated after this ISO UTC timestamp'),
      order: z.enum(['asc', 'desc']).optional(),
    },
    annotations: READ,
    request: ({ appId: id, customIdMode, ...rest }) => ({
      method: 'GET',
      path: '/device',
      query: { app_id: id, ...rest, customIdMode: customIdMode ? 'true' : undefined },
    }),
  }),
  apiTool({
    name: 'capgo_get_device',
    title: 'Get device',
    description: 'Get one device, including its channel override if any.',
    input: { appId, device_id: z.string().min(1) },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/device', query: { app_id: input.appId, device_id: input.device_id } }),
  }),
  apiTool({
    name: 'capgo_set_device_channel',
    title: 'Force device channel',
    description: 'Force a device onto a (non default) channel, e.g. to test a bundle on one phone.',
    input: { appId, device_id: z.string().min(1), channel: z.string().min(1) },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'POST', path: '/device', body: { app_id: input.appId, device_id: input.device_id, channel: input.channel } }),
  }),
  apiTool({
    name: 'capgo_unset_device_channel',
    title: 'Remove device channel override',
    description: 'Remove the forced channel of a device so it follows the default channel again.',
    input: { appId, device_id: z.string().min(1) },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: '/device', body: { app_id: input.appId, device_id: input.device_id } }),
  }),
]

// ---------------------------------------------------------------------------
// Statistics & observability
// ---------------------------------------------------------------------------
const statsRange = {
  from: dateString,
  to: dateString,
  noAccumulate: z.boolean().optional().describe('Return daily values instead of cumulative totals'),
}

function statsQuery(input: { from: string, to: string, noAccumulate?: boolean, breakdown?: boolean }) {
  return {
    from: input.from,
    to: input.to,
    noAccumulate: input.noAccumulate === undefined ? undefined : String(input.noAccumulate),
    breakdown: input.breakdown === undefined ? undefined : String(input.breakdown),
  }
}

const statsTools: McpTool[] = [
  apiTool({
    name: 'capgo_get_app_statistics',
    title: 'App statistics',
    description: 'Daily MAU, storage, bandwidth and build time for an app.',
    input: { appId, ...statsRange },
    annotations: READ,
    request: ({ appId: id, ...rest }) => ({ method: 'GET', path: `/statistics/app/${enc(id)}`, query: statsQuery(rest) }),
  }),
  apiTool({
    name: 'capgo_get_organization_statistics',
    title: 'Organization statistics',
    description: 'Daily usage for a whole organization, optionally broken down per app.',
    input: { orgId, ...statsRange, breakdown: z.boolean().optional() },
    annotations: READ,
    request: ({ orgId: id, ...rest }) => ({ method: 'GET', path: `/statistics/org/${enc(id)}`, query: statsQuery(rest) }),
  }),
  apiTool({
    name: 'capgo_get_account_statistics',
    title: 'Account statistics',
    description: 'Daily usage summed across every organization of the account.',
    input: statsRange,
    annotations: READ,
    request: input => ({ method: 'GET', path: '/statistics/user', query: statsQuery(input) }),
  }),
  apiTool({
    name: 'capgo_get_bundle_usage',
    title: 'Bundle adoption',
    description: 'Per-day share of devices on each bundle version (adoption of a release).',
    input: { appId, from: dateString, to: dateString },
    annotations: READ,
    request: ({ appId: id, ...rest }) => ({ method: 'GET', path: `/statistics/app/${enc(id)}/bundle_usage`, query: rest }),
  }),
  apiTool({
    name: 'capgo_get_native_usage',
    title: 'Native version usage',
    description: 'Native app versions and platforms used by devices.',
    input: { appId, from: dateString, to: dateString },
    annotations: READ,
    request: ({ appId: id, ...rest }) => ({ method: 'GET', path: `/statistics/app/${enc(id)}/native_usage`, query: rest }),
  }),
  apiTool({
    name: 'capgo_observe',
    title: 'Observe app health',
    description: 'Query Capgo Observe (update health, launch timing, events, routes). Start with view=summary, then follow the returned findings.',
    input: {
      appId,
      view: z.enum(['summary', 'metrics', 'events', 'device', 'versions', 'routes']).optional(),
      days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(30)]).optional(),
      action: z.string().optional().describe('Filter events by stats action, e.g. update_fail'),
      deviceId: z.string().optional(),
      versionName: z.string().optional(),
      sort: z.enum(['slowest', 'fastest', 'newest', 'oldest']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ,
    request: input => ({ method: 'POST', path: '/private/observe', body: compact(input) }),
  }),
]

// ---------------------------------------------------------------------------
// Native builds
// ---------------------------------------------------------------------------
const buildTools: McpTool[] = [
  apiTool({
    name: 'capgo_get_build_status',
    title: 'Build status',
    description: 'Get the status of a native cloud build. Start builds with the Capgo CLI: npx @capgo/cli@latest build request.',
    input: { appId, job_id: z.string().min(1) },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/build/status', query: { app_id: input.appId, job_id: input.job_id } }),
  }),
  apiTool({
    name: 'capgo_get_build_logs',
    title: 'Build logs',
    description: 'Read the logs of a native cloud build (a snapshot for builds still running).',
    input: { appId, job_id: z.string().min(1) },
    annotations: READ,
    request: input => ({ method: 'GET', path: `/build/logs/${enc(input.job_id)}`, query: { app_id: input.appId }, stream: true }),
  }),
  apiTool({
    name: 'capgo_cancel_build',
    title: 'Cancel build',
    description: 'Cancel a queued or running native cloud build.',
    input: { appId, job_id: z.string().min(1) },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'POST', path: `/build/cancel/${enc(input.job_id)}`, body: { app_id: input.appId } }),
  }),
]

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
const webhookTools: McpTool[] = [
  apiTool({
    name: 'capgo_list_webhooks',
    title: 'List webhooks',
    description: 'List the webhooks of an organization, or get one with its last 24h delivery stats.',
    input: { orgId, webhookId: z.string().uuid().optional(), page },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/webhooks', query: input }),
  }),
  apiTool({
    name: 'capgo_add_webhook',
    title: 'Create webhook',
    description: 'Create a webhook that receives Capgo events. The signing secret is returned once.',
    input: {
      orgId,
      name: z.string().min(1),
      url: z.string().url(),
      events: webhookEvents,
      enabled: z.boolean().optional(),
    },
    annotations: EXTERNAL,
    request: input => ({ method: 'POST', path: '/webhooks', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_update_webhook',
    title: 'Update webhook',
    description: 'Update a webhook name, URL, events or enabled state.',
    input: {
      orgId,
      webhookId: z.string().uuid(),
      name: z.string().min(1).optional(),
      url: z.string().url().optional(),
      events: webhookEvents.optional(),
      enabled: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'PUT', path: '/webhooks', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_delete_webhook',
    title: 'Delete webhook',
    description: 'Delete a webhook.',
    input: { orgId, webhookId: z.string().uuid() },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'DELETE', path: '/webhooks', body: input }),
  }),
  apiTool({
    name: 'capgo_test_webhook',
    title: 'Test webhook',
    description: 'Send a test.ping event to a webhook and report the response.',
    input: { orgId, webhookId: z.string().uuid() },
    annotations: EXTERNAL,
    request: input => ({ method: 'POST', path: '/webhooks/test', body: input }),
  }),
  apiTool({
    name: 'capgo_list_webhook_deliveries',
    title: 'List webhook deliveries',
    description: 'List recent deliveries of a webhook.',
    input: { orgId, webhookId: z.string().uuid(), status: z.enum(['pending', 'success', 'failed']).optional(), page },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/webhooks/deliveries', query: input }),
  }),
  apiTool({
    name: 'capgo_retry_webhook_delivery',
    title: 'Retry webhook delivery',
    description: 'Retry a failed webhook delivery.',
    input: { orgId, deliveryId: z.string().uuid() },
    annotations: EXTERNAL,
    request: input => ({ method: 'POST', path: '/webhooks/deliveries/retry', body: input }),
  }),
]

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
const notificationTools: McpTool[] = [
  apiTool({
    name: 'capgo_get_notification_settings',
    title: 'Push update settings',
    description: 'Read the push-triggered live update settings of an app.',
    input: { appId },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/notifications/settings', query: { app_id: input.appId } }),
  }),
  apiTool({
    name: 'capgo_update_notification_settings',
    title: 'Update push update settings',
    description: 'Enable or configure push-triggered live updates for an app.',
    input: {
      appId,
      pushUpdateEnabled: z.boolean().optional(),
      pushUpdateInstallMode: z.enum(['next', 'set']).optional().describe('next = install on next launch, set = apply immediately'),
      pushUpdateChannel: z.string().max(128).nullable().optional(),
    },
    annotations: DESTRUCTIVE,
    request: input => ({ method: 'PUT', path: '/notifications/settings', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_list_notification_providers',
    title: 'List push providers',
    description: 'List the APNs / FCM provider configuration of an app (secrets are never returned).',
    input: { appId },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/notifications/providers', query: { app_id: input.appId } }),
  }),
  apiTool({
    name: 'capgo_send_notification',
    title: 'Send push notification',
    description: 'Send a push notification to app users. Reaches real users: confirm the audience and content with the user first.',
    input: {
      appId,
      target: notificationTarget,
      name: z.string().max(180).optional().describe('Campaign name'),
      kind: z.enum(['alert', 'background', 'badge', 'update_check']).optional(),
      payload: z.record(z.string(), z.unknown()).optional().describe('Notification payload, e.g. {"title":"Hi","body":"..."}'),
      limit: z.number().int().positive().optional(),
    },
    annotations: EXTERNAL,
    request: input => ({ method: 'POST', path: '/notifications/send', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_trigger_update_check',
    title: 'Trigger update check',
    description: 'Send a silent push asking devices to check for a live update now. Requires push updates to be enabled.',
    input: {
      appId,
      target: notificationTarget.optional(),
      installMode: z.enum(['next', 'set']).optional(),
      channel: z.string().nullable().optional(),
      limit: z.number().int().positive().optional(),
    },
    annotations: EXTERNAL,
    request: input => ({ method: 'POST', path: '/notifications/update-check', body: compact(input) }),
  }),
  apiTool({
    name: 'capgo_list_notification_campaigns',
    title: 'List push campaigns',
    description: 'List the last 100 push campaigns of an app.',
    input: { appId },
    annotations: READ,
    request: input => ({ method: 'GET', path: '/notifications/campaigns', query: { app_id: input.appId } }),
  }),
  apiTool({
    name: 'capgo_get_notification_stats',
    title: 'Push statistics',
    description: 'Push delivery statistics of an app, optionally for one campaign.',
    input: { appId, days: z.number().int().min(1).max(92).optional(), campaign_id: z.string().optional() },
    annotations: READ,
    request: ({ appId: id, ...rest }) => ({ method: 'GET', path: '/notifications/stats', query: { app_id: id, ...rest } }),
  }),
]

export const MCP_TOOLS: readonly McpTool[] = [
  ...accountTools,
  ...appTools,
  ...bundleTools,
  ...channelTools,
  ...deviceTools,
  ...statsTools,
  ...buildTools,
  ...webhookTools,
  ...notificationTools,
]

export const MCP_TOOLS_BY_NAME: ReadonlyMap<string, McpTool> = new Map(MCP_TOOLS.map(tool => [tool.name, tool]))

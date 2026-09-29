import { capgoApiRoot } from './protocol.ts'

type JsonSchema = Record<string, unknown>

interface ToolDef {
  name: string
  description: string
  inputSchema: JsonSchema
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path?: string
}

const str = { type: 'string' }
const num = { type: 'number' }
const bool = { type: 'boolean' }
const obj = { type: 'object', additionalProperties: true }

function schema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function tool(def: ToolDef): ToolDef {
  return def
}

export const MCP_TOOLS: ToolDef[] = [
  tool({
    name: 'capgo_whoami',
    description: 'Show who the remote MCP is signed in as. Does not return the API key.',
    inputSchema: schema({}),
  }),
  tool({
    name: 'capgo_list_apps',
    description: 'List apps the signed-in key can access.',
    inputSchema: schema({ page: num, limit: num, org_id: str }),
    method: 'GET',
    path: '/app',
  }),
  tool({
    name: 'capgo_get_app',
    description: 'Get one app by its app id, for example com.example.app.',
    inputSchema: schema({ app_id: str }, ['app_id']),
    method: 'GET',
    path: '/app/:app_id',
  }),
  tool({
    name: 'capgo_create_app',
    description: 'Register a new app in an organization you administer.',
    inputSchema: schema({
      app_id: str,
      name: str,
      owner_org: str,
      icon: str,
      ios_store_url: str,
      android_store_url: str,
    }, ['app_id', 'name', 'owner_org']),
    method: 'POST',
    path: '/app',
  }),
  tool({
    name: 'capgo_update_app',
    description: 'Update an app name, icon, retention, or store URLs.',
    inputSchema: schema({
      app_id: str,
      name: str,
      icon: str,
      retention: num,
      expose_metadata: bool,
      allow_device_custom_id: bool,
      ios_store_url: str,
      android_store_url: str,
    }, ['app_id']),
    method: 'PUT',
    path: '/app/:app_id',
  }),
  tool({
    name: 'capgo_delete_app',
    description: 'Delete an app and its cloud data. Confirm with the user first.',
    inputSchema: schema({ app_id: str }, ['app_id']),
    method: 'DELETE',
    path: '/app/:app_id',
  }),
  tool({
    name: 'capgo_list_bundles',
    description: 'List bundles uploaded for an app. Pass version to fetch one bundle.',
    inputSchema: schema({ app_id: str, version: str, page: num }, ['app_id']),
    method: 'GET',
    path: '/bundle',
  }),
  tool({
    name: 'capgo_delete_bundle',
    description: 'Delete one bundle version from an app. Confirm with the user first.',
    inputSchema: schema({ app_id: str, version: str }, ['app_id', 'version']),
    method: 'DELETE',
    path: '/bundle',
  }),
  tool({
    name: 'capgo_link_bundle_to_channel',
    description: 'Link a bundle version id to a channel id.',
    inputSchema: schema({ app_id: str, version_id: num, channel_id: num }, ['app_id', 'version_id', 'channel_id']),
    method: 'PUT',
    path: '/bundle',
  }),
  tool({
    name: 'capgo_update_bundle_metadata',
    description: 'Set the comment or link stored on a bundle version.',
    inputSchema: schema({ app_id: str, version_id: num, comment: str, link: str }, ['app_id', 'version_id']),
    method: 'POST',
    path: '/bundle/metadata',
  }),
  tool({
    name: 'capgo_list_channels',
    description: 'List distribution channels for an app.',
    inputSchema: schema({ app_id: str, channel: str }, ['app_id']),
    method: 'GET',
    path: '/channel',
  }),
  tool({
    name: 'capgo_set_channel',
    description: 'Create or update a channel. version is the bundle version name to link.',
    inputSchema: schema({
      app_id: str,
      channel: str,
      version: str,
      public: bool,
      disableAutoUpdate: str,
      disableAutoUpdateUnderNative: bool,
      ios: bool,
      android: bool,
      allow_device_self_set: bool,
      allow_emulator: bool,
      allow_device: bool,
      allow_dev: bool,
      allow_prod: bool,
    }, ['app_id', 'channel']),
    method: 'POST',
    path: '/channel',
  }),
  tool({
    name: 'capgo_delete_channel',
    description: 'Delete a channel. Confirm with the user first.',
    inputSchema: schema({ app_id: str, channel: str, delete_bundle: bool }, ['app_id', 'channel']),
    method: 'DELETE',
    path: '/channel',
  }),
  tool({
    name: 'capgo_list_organizations',
    description: 'List organizations the signed-in key can access.',
    inputSchema: schema({ orgId: str, page: num }),
    method: 'GET',
    path: '/organization',
  }),
  tool({
    name: 'capgo_create_organization',
    description: 'Create an organization. The key needs the org.create permission.',
    inputSchema: schema({ name: str, email: str, estimatedMau: num, website: str }, ['name']),
    method: 'POST',
    path: '/organization',
  }),
  tool({
    name: 'capgo_update_organization',
    description: 'Update an organization name, website, or security settings.',
    inputSchema: schema({
      orgId: str,
      name: str,
      website: str,
      management_email: str,
      require_apikey_expiration: bool,
      max_apikey_expiration_days: num,
      enforce_hashed_api_keys: bool,
      enforce_encrypted_bundles: bool,
      enforcing_2fa: bool,
    }, ['orgId']),
    method: 'PUT',
    path: '/organization',
  }),
  tool({
    name: 'capgo_delete_organization',
    description: 'Delete an organization. Confirm with the user first.',
    inputSchema: schema({ orgId: str }, ['orgId']),
    method: 'DELETE',
    path: '/organization',
  }),
  tool({
    name: 'capgo_list_members',
    description: 'List members of an organization.',
    inputSchema: schema({ orgId: str }, ['orgId']),
    method: 'GET',
    path: '/organization/members',
  }),
  tool({
    name: 'capgo_invite_member',
    description: 'Invite a person to an organization. invite_type is org_member, org_billing_admin, org_admin, or org_super_admin.',
    inputSchema: schema({ orgId: str, email: str, invite_type: str }, ['orgId', 'email', 'invite_type']),
    method: 'POST',
    path: '/organization/members',
  }),
  tool({
    name: 'capgo_remove_member',
    description: 'Remove a member from an organization by email. Confirm with the user first.',
    inputSchema: schema({ orgId: str, email: str }, ['orgId', 'email']),
    method: 'DELETE',
    path: '/organization/members',
  }),
  tool({
    name: 'capgo_list_audit_logs',
    description: 'List organization audit log entries.',
    inputSchema: schema({ orgId: str, tableName: str, operation: str, page: num, limit: num }, ['orgId']),
    method: 'GET',
    path: '/organization/audit',
  }),
  tool({
    name: 'capgo_list_devices',
    description: 'List devices for an app, or pass device_id to fetch one device.',
    inputSchema: schema({
      app_id: str,
      device_id: str,
      custom_id: str,
      cursor: str,
      limit: num,
      order: str,
    }, ['app_id']),
    method: 'GET',
    path: '/device',
  }),
  tool({
    name: 'capgo_set_device',
    description: 'Force a device onto a channel. The channel cannot be public.',
    inputSchema: schema({ app_id: str, device_id: str, channel: str }, ['app_id', 'device_id', 'channel']),
    method: 'POST',
    path: '/device',
  }),
  tool({
    name: 'capgo_delete_device_override',
    description: 'Remove a forced channel override for a device.',
    inputSchema: schema({ app_id: str, device_id: str }, ['app_id', 'device_id']),
    method: 'DELETE',
    path: '/device',
  }),
  tool({
    name: 'capgo_get_app_stats',
    description: 'Get app statistics between two ISO dates.',
    inputSchema: schema({ app_id: str, from: str, to: str, breakdown: bool, noAccumulate: bool }, ['app_id', 'from', 'to']),
    method: 'GET',
    path: '/statistics/app/:app_id',
  }),
  tool({
    name: 'capgo_get_org_stats',
    description: 'Get organization statistics between two ISO dates.',
    inputSchema: schema({ org_id: str, from: str, to: str, breakdown: bool, noAccumulate: bool }, ['org_id', 'from', 'to']),
    method: 'GET',
    path: '/statistics/org/:org_id',
  }),
  tool({
    name: 'capgo_list_webhooks',
    description: 'List organization webhooks, or pass webhookId to fetch one.',
    inputSchema: schema({ orgId: str, webhookId: str, page: num }, ['orgId']),
    method: 'GET',
    path: '/webhooks',
  }),
  tool({
    name: 'capgo_create_webhook',
    description: 'Create an organization webhook. events are apps, app_versions, channels, org_users, or orgs. The response includes the signing secret once.',
    inputSchema: schema({
      orgId: str,
      name: str,
      url: str,
      events: { type: 'array', items: str },
      enabled: bool,
      delivery_version: str,
    }, ['orgId', 'name', 'url', 'events']),
    method: 'POST',
    path: '/webhooks',
  }),
  tool({
    name: 'capgo_update_webhook',
    description: 'Update an organization webhook.',
    inputSchema: schema({
      orgId: str,
      webhookId: str,
      name: str,
      url: str,
      events: { type: 'array', items: str },
      enabled: bool,
      delivery_version: str,
    }, ['orgId', 'webhookId']),
    method: 'PUT',
    path: '/webhooks',
  }),
  tool({
    name: 'capgo_delete_webhook',
    description: 'Delete an organization webhook. Confirm with the user first.',
    inputSchema: schema({ orgId: str, webhookId: str }, ['orgId', 'webhookId']),
    method: 'DELETE',
    path: '/webhooks',
  }),
  tool({
    name: 'capgo_test_webhook',
    description: 'Send a test delivery to an organization webhook.',
    inputSchema: schema({ orgId: str, webhookId: str }, ['orgId', 'webhookId']),
    method: 'POST',
    path: '/webhooks/test',
  }),
  tool({
    name: 'capgo_list_webhook_deliveries',
    description: 'List recent deliveries for a webhook.',
    inputSchema: schema({ orgId: str, webhookId: str, page: num, status: str }, ['orgId', 'webhookId']),
    method: 'GET',
    path: '/webhooks/deliveries',
  }),
  tool({
    name: 'capgo_retry_webhook_delivery',
    description: 'Retry one webhook delivery.',
    inputSchema: schema({ orgId: str, deliveryId: str }, ['orgId', 'deliveryId']),
    method: 'POST',
    path: '/webhooks/deliveries/retry',
  }),
  tool({
    name: 'capgo_request_build',
    description: 'Start a native iOS or Android build and return the upload URL. Saved build credentials are used. Do not pass signing secrets.',
    inputSchema: schema({
      app_id: str,
      platform: str,
      build_mode: str,
      cache_enabled: bool,
      cache_key: str,
    }, ['app_id', 'platform']),
    method: 'POST',
    path: '/build/request',
  }),
  tool({
    name: 'capgo_get_build_status',
    description: 'Get the status of a native build job.',
    inputSchema: schema({ job_id: str, app_id: str, platform: str }, ['job_id', 'app_id', 'platform']),
    method: 'GET',
    path: '/build/status',
  }),
  tool({
    name: 'capgo_cancel_build',
    description: 'Cancel a native build job.',
    inputSchema: schema({ jobId: str, app_id: str }, ['jobId', 'app_id']),
    method: 'POST',
    path: '/build/cancel/:jobId',
  }),
  tool({
    name: 'capgo_get_notification_settings',
    description: 'Get push notification settings for an app.',
    inputSchema: schema({ app_id: str }, ['app_id']),
    method: 'GET',
    path: '/notifications/settings',
  }),
  tool({
    name: 'capgo_update_notification_settings',
    description: 'Update push notification settings for an app.',
    inputSchema: schema({
      appId: str,
      pushUpdateEnabled: bool,
      pushUpdateInstallMode: str,
      pushUpdateChannel: str,
    }, ['appId']),
    method: 'PUT',
    path: '/notifications/settings',
  }),
  tool({
    name: 'capgo_send_notification',
    description: 'Send a push notification. target can include externalId, tag, or broadcast.',
    inputSchema: schema({
      appId: str,
      name: str,
      kind: str,
      payload: obj,
      target: obj,
      limit: num,
    }, ['appId']),
    method: 'POST',
    path: '/notifications/send',
  }),
  tool({
    name: 'capgo_list_notification_campaigns',
    description: 'List push notification campaigns for an app.',
    inputSchema: schema({ app_id: str }, ['app_id']),
    method: 'GET',
    path: '/notifications/campaigns',
  }),
  tool({
    name: 'capgo_create_notification_campaign',
    description: 'Create a push notification campaign record.',
    inputSchema: schema({
      appId: str,
      name: str,
      kind: str,
      status: str,
      audience: obj,
      payload: obj,
      scheduledAt: str,
    }, ['appId', 'name']),
    method: 'POST',
    path: '/notifications/campaigns',
  }),
  tool({
    name: 'capgo_get_notification_stats',
    description: 'Get push notification stats for an app.',
    inputSchema: schema({ app_id: str, days: num, campaign_id: str }, ['app_id']),
    method: 'GET',
    path: '/notifications/stats',
  }),
  tool({
    name: 'capgo_list_notification_providers',
    description: 'List push provider configs for an app. Secrets are not returned.',
    inputSchema: schema({ app_id: str }, ['app_id']),
    method: 'GET',
    path: '/notifications/providers',
  }),
  tool({
    name: 'capgo_set_notification_provider',
    description: 'Save a push provider config for an app. secretMaterial is stored by Capgo and is not returned later.',
    inputSchema: schema({
      appId: str,
      provider: str,
      platform: str,
      status: str,
      config: obj,
      secretRef: str,
      secretMaterial: str,
    }, ['appId']),
    method: 'PUT',
    path: '/notifications/providers',
  }),
]

const TOOLS_BY_NAME = new Map(MCP_TOOLS.map(item => [item.name, item]))

export function listMcpTools() {
  return MCP_TOOLS.map(item => ({
    name: item.name,
    description: item.description,
    inputSchema: item.inputSchema,
  }))
}

export interface McpCaller {
  apiKey: string
  userId: string
  keyId: number
  keyName: string
  expiresAt: string | null
}

function applyPath(path: string, args: Record<string, unknown>) {
  const rest = { ...args }
  const filled = path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = rest[key]
    delete rest[key]
    if (value == null || value === '')
      throw new Error(`Missing ${key}`)
    return encodeURIComponent(String(value))
  })
  return { path: filled, rest }
}

function queryString(args: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) {
    if (value == null)
      continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export async function callMcpTool(requestUrl: string, caller: McpCaller, name: string, args: Record<string, unknown>) {
  if (name === 'capgo_whoami') {
    return {
      isError: false,
      text: JSON.stringify({
        userId: caller.userId,
        keyId: caller.keyId,
        keyName: caller.keyName,
        expiresAt: caller.expiresAt,
      }, null, 2),
    }
  }

  const toolDef = TOOLS_BY_NAME.get(name)
  if (!toolDef?.method || !toolDef.path)
    throw new Error(`Unknown tool ${name}`)

  const { path, rest } = applyPath(toolDef.path, args)
  const root = capgoApiRoot(requestUrl)
  const isRead = toolDef.method === 'GET'
  const url = `${root}${path}${isRead ? queryString(rest) : ''}`
  const response = await fetch(url, {
    method: toolDef.method,
    headers: {
      capgkey: caller.apiKey,
      authorization: caller.apiKey,
      'content-type': 'application/json',
    },
    body: isRead ? undefined : JSON.stringify(rest),
  })
  const text = await response.text()
  const clipped = text.length > 80_000 ? `${text.slice(0, 80_000)}\n…truncated` : text
  return {
    isError: !response.ok,
    text: clipped || response.statusText,
  }
}

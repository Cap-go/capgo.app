import type { McpToolContext } from '../supabase/functions/_backend/mcp/tools.ts'
import type { McpToolName } from '../supabase/functions/_backend/mcp/output_schemas.ts'
import { Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MCP_OUTPUT_SCHEMAS } from '../supabase/functions/_backend/mcp/output_schemas.ts'
import {
  handleJsonRpcMessage,
  listTools,
} from '../supabase/functions/_backend/mcp/protocol.ts'
import {
  getSkill,
  listSkills,
  readSkillResource,
} from '../supabase/functions/_backend/mcp/skills.ts'
import {
  MAX_RESULT_CHARS,
  MCP_TOOLS,
  MCP_TOOLS_BY_NAME,
} from '../supabase/functions/_backend/mcp/tools.ts'
import { MCP_EVENT_CATALOG } from '../supabase/functions/_backend/utils/mcp_events.ts'

vi.mock('../supabase/functions/_backend/utils/docs_search.ts', () => ({
  DOCS_SEARCH_MAX_RESULTS: 20,
  searchCapgoDocs: async () => [docsPage],
}))
vi.mock('../supabase/functions/_backend/public/build/status.ts', () => ({
  getBuildStatus: async () => Response.json(payloads.capgo_get_build_status),
}))
vi.mock(
  '../supabase/functions/_backend/utils/mcp_events.ts',
  async (original) => ({
    ...(await original<
      typeof import('../supabase/functions/_backend/utils/mcp_events.ts')
    >()),
    upsertMcpEventSubscription: async () => payloads.capgo_subscribe_events,
    unsubscribeMcpEvent: async () => true,
  }),
)
vi.mock(
  '../supabase/functions/_backend/mcp/events_rpc.ts',
  async (original) => ({
    ...(await original<
      typeof import('../supabase/functions/_backend/mcp/events_rpc.ts')
    >()),
    loadApikeyRbacId: async () => 'example-rbac',
    handleCapgoListEventSubscriptions: async () => [subscription],
  }),
)

const appId = 'com.example.output'
const orgId = '11111111-1111-4111-8111-111111111111'
const stamp = '2026-11-01T00:00:00Z'
const ack = { status: 'ok' }
const app = { app_id: appId, owner_org: orgId, name: 'Example app' }
const profile = {
  id: 'example-user',
  email: 'example-user@example.com',
  first_name: 'Example',
  email_preferences: {},
}
const organization = { id: orgId, name: 'Example organization' }
const bundle = { id: 1, name: '1.0.0', app_id: appId }
const channel = {
  id: 1,
  name: 'production',
  app_id: appId,
  version: { id: 1, name: '1.0.0' },
}
const device = { device_id: 'example-device', app_id: appId }
const webhook = {
  id: 'example-webhook',
  name: 'Example receiver',
  url: 'https://example.com/webhook',
}
const day = {
  date: stamp,
  mau: 1,
  storage: 12,
  bandwidth: 10,
  build_time_seconds: 30,
}
const versionUsage = {
  labels: ['2026-11-01'],
  datasets: [{ label: '1.0.0', data: [100], metaCounts: [1] }],
  latestVersion: { name: '1.0.0', percentage: '100.0' },
}
const signed = {
  job_id: 'example-job',
  upload_url: 'https://example.com/upload',
  method: 'PUT',
  headers: { 'Content-Type': 'application/zip' },
  expires_at: stamp,
  max_bytes: 10000,
}
const diagnostic = {
  classification: 'normal',
  meaning: 'Expected lifecycle state.',
  next_steps: [],
  docs_url: 'https://capgo.app/docs/builder/troubleshooting/',
}
const subscription = {
  id: 'example-subscription',
  name: 'build.succeeded',
  expires_at: stamp,
}
const settings = {
  appId,
  pushUpdateEnabled: false,
  pushUpdateInstallMode: 'next',
  pushUpdateChannel: null,
}
const send = {
  ...ack,
  campaignId: 'example-campaign',
  queued: true,
  queuedBuckets: 1,
  targeted: null,
}
const docsPage = {
  title: 'Example docs',
  url: 'https://capgo.app/docs/',
  snippet: 'Example instructions',
}
const uri = 'skill://capgo/ship-live-update/SKILL.md'

// Endpoint-shaped fixtures include non-empty lists, nullable values and the API's actual casing.
const payloads = {
  capgo_whoami: {
    user_id: 'example-user',
    apikey_id: 1,
    apikey_name: 'Example key',
    apikey_expires_at: null,
  },
  capgo_get_account: profile,
  capgo_update_account: profile,
  capgo_list_organizations: [organization],
  capgo_get_organization: organization,
  capgo_add_organization: { id: orgId },
  capgo_update_organization: {
    status: 'Organization updated',
    id: orgId,
    data: organization,
  },
  capgo_delete_organization: ack,
  capgo_list_organization_members: [
    {
      uid: 'example-user',
      email: 'example-user@example.com',
      role: 'org_admin',
      image_url: '',
      is_tmp: false,
    },
  ],
  capgo_invite_organization_member: ack,
  capgo_update_organization_member_role: ack,
  capgo_remove_organization_member: ack,
  capgo_list_audit_logs: {
    data: [
      {
        id: 1,
        created_at: stamp,
        table_name: 'apps',
        record_id: appId,
        operation: 'UPDATE',
        user_id: null,
        org_id: orgId,
        old_record: {},
        new_record: {},
        changed_fields: [],
        actor_type: 'apikey',
        actor_user_id: null,
        actor_user_email: null,
        actor_apikey_id: 1,
        actor_apikey_name: 'Example key',
      },
    ],
    total: 1,
    page: 0,
    limit: 20,
  },
  capgo_list_api_keys: [{ id: 1, name: 'Example key', expires_at: null }],
  capgo_delete_api_key: ack,
  capgo_list_apps: [app],
  capgo_get_app: app,
  capgo_add_app: app,
  capgo_update_app: app,
  capgo_delete_app: ack,
  capgo_create_demo_app: {
    ...ack,
    app_id: appId,
    name: 'Example app',
    message: 'Created',
  },
  capgo_fetch_store_metadata: {
    ...ack,
    name: 'Example app',
    icon_url: null,
    icon_data_url: null,
    screenshot_url: null,
    app_id: null,
    app_id_lookup_failed: true,
    android_app_id: null,
    ios_bundle_id: null,
    url: 'https://example.com/store',
  },
  capgo_get_upload_command: {
    command: 'example-command',
    apikeyExpiresAt: null,
    note: 'Local execution only',
  },
  capgo_list_bundles: [bundle],
  capgo_create_bundle_from_url: { status: 'success', bundle },
  capgo_update_bundle_metadata: ack,
  capgo_set_bundle_channel: { status: 'success', message: 'Deployed' },
  capgo_delete_bundle: { ...ack, id: 1, name: '1.0.0' },
  capgo_prepare_bundle_upload: {
    upload_token: 'example-token',
    expires_at: stamp,
    app_id: appId,
    version: '1.0.0',
    version_id: 1,
    encrypted: false,
    checksum_algorithm: 'sha256',
    min_update_version: null,
    delta: 'none',
    bundle_upload: {
      url: signed.upload_url,
      method: 'PUT',
      headers: signed.headers,
      expires_at: stamp,
      max_size_bytes: 10000,
    },
    channels: [
      { name: 'production', compatibility: 'compatible', reasons: [] },
    ],
  },
  capgo_complete_bundle_upload: {
    ...ack,
    app_id: appId,
    version: '1.0.0',
    version_id: 1,
    checksum: 'example-checksum',
    encrypted: false,
    storage_provider: 'r2',
    channels_updated: ['production'],
    channels_skipped_same_checksum: [],
    warnings: [],
    delta: null,
    deleted_linked_bundles: [],
  },
  capgo_abort_bundle_upload: {
    ...ack,
    app_id: appId,
    version: '1.0.0',
    aborted: true,
  },
  capgo_list_channels: [channel],
  capgo_get_channel: channel,
  capgo_add_channel: { ...ack, ...channel },
  capgo_update_channel: ack,
  capgo_update_channel_rollout: ack,
  capgo_delete_channel: ack,
  capgo_list_devices: {
    data: [device],
    nextCursor: 'example-cursor',
    hasMore: true,
  },
  capgo_get_device: device,
  capgo_set_device_channel: ack,
  capgo_unset_device_channel: ack,
  capgo_get_app_statistics: [day],
  capgo_get_organization_statistics: {
    global: [day],
    byApp: [{ ...day, app_id: appId }],
  },
  capgo_get_account_statistics: [day],
  capgo_get_bundle_usage: versionUsage,
  capgo_get_native_usage: versionUsage,
  capgo_observe: {
    app_id: appId,
    view: 'errors',
    summary: { total: 1 },
    actions: [{ action: 'update_fail', total: 1 }],
    samples: [
      {
        device_id: device.device_id,
        action: 'update_fail',
        version_name: '1.0.0',
        created_at: stamp,
        duration_ms: null,
        route: null,
        metadata: null,
        diagnostic,
      },
    ],
  },
  capgo_request_build: {
    job_id: signed.job_id,
    upload: signed,
    next_step: 'Upload then start',
  },
  capgo_get_build_upload_url: signed,
  capgo_start_build: { job_id: signed.job_id, status: 'running' },
  capgo_get_build_credentials: {
    app_id: appId,
    platforms: [
      { platform: 'ios', configured: false },
      {
        platform: 'android',
        configured: true,
        summary: { keys: ['keystore'] },
        created_at: stamp,
        updated_at: stamp,
      },
    ],
  },
  capgo_prepare_build_credentials_upload: {
    app_id: appId,
    platform: 'ios',
    mode: 'replace',
    method: 'PUT',
    upload_url: signed.upload_url,
    content_type: 'application/json',
    max_bytes: 10000,
    expires_at: stamp,
    curl: 'example-upload-command',
  },
  capgo_delete_build_credentials: {
    ...ack,
    app_id: appId,
    platform: 'ios',
    deleted: true,
  },
  capgo_get_build_status: {
    job_id: signed.job_id,
    status: 'running',
    diagnostic,
    persisted: false,
    completed_at: null,
    timeout_exceeded: true,
    timeout_warning: 'Inspect before cancelling',
  },
  capgo_get_build_logs: {
    app_id: appId,
    job_id: signed.job_id,
    logs: '',
    cursor: 1,
    first_available_id: 2,
    truncated: true,
    retention: 'Live backlog only',
    diagnostics: [],
    format: 'text',
    poll_after_seconds: 15,
    docs_url: diagnostic.docs_url,
    agent_instructions: 'Empty does not mean success',
  },
  capgo_cancel_build: {
    job_id: signed.job_id,
    status: 'cancelled',
    message: 'Cancelled',
  },
  capgo_list_webhooks: [webhook],
  capgo_add_webhook: { status: 'Webhook created', webhook },
  capgo_update_webhook: { status: 'Webhook updated', webhook },
  capgo_delete_webhook: { status: 'Webhook deleted', webhookId: webhook.id },
  capgo_test_webhook: {
    success: false,
    status: null,
    duration_ms: 100,
    delivery_id: 'example-delivery',
    message: 'Receiver unavailable',
  },
  capgo_list_webhook_deliveries: {
    deliveries: [{ id: 'example-delivery', status: 'pending' }],
    pagination: { page: 0, per_page: 20, total: 1, has_more: false },
  },
  capgo_retry_webhook_delivery: {
    status: 'Delivery queued for retry',
    deliveryId: 'example-delivery',
  },
  capgo_list_event_types: { events: MCP_EVENT_CATALOG },
  capgo_subscribe_events: {
    id: subscription.id,
    refreshBefore: stamp,
    verificationFailed: true,
    verificationReason: 'challenge_failed',
  },
  capgo_list_event_subscriptions: [subscription],
  capgo_unsubscribe_events: { id: subscription.id, unsubscribed: true },
  capgo_get_notification_settings: settings,
  capgo_update_notification_settings: settings,
  capgo_list_notification_providers: {
    data: [
      { id: 'example-provider', provider: 'fcm', status: 'active', config: {} },
    ],
  },
  capgo_send_notification: send,
  capgo_trigger_update_check: send,
  capgo_list_notification_campaigns: {
    data: [{ id: 'example-campaign', app_id: appId, name: null }],
  },
  capgo_get_notification_stats: { data: [{ event: 'delivered', count: 1 }] },
  capgo_list_skills: { skills: listSkills() },
  capgo_get_skill: { skill: getSkill(uri), contents: [readSkillResource(uri)] },
  capgo_search_docs: { results: [docsPage] },
} satisfies Record<McpToolName, unknown>

function context(payload: unknown): McpToolContext {
  return {
    caller: {
      userId: 'example-user',
      apikeyId: 1,
      apikeyName: 'Example key',
      apikeyExpiresAt: null,
    },
    apikey: 'example-test-key',
    apikeyRow: {
      id: 1,
      name: 'Example key',
      user_id: 'example-user',
      key: 'example-test-key',
      key_hash: null,
      rbac_id: 'example-rbac',
      created_at: null,
      updated_at: null,
      expires_at: null,
    },
    hono: new Context(new Request('https://example.com/mcp')),
    call: async (request) => ({
      ok: true,
      status: 200,
      data: request.path.startsWith('/build/upload_url/') ? signed : payload,
    }),
  }
}

function hasOutputDescription(value: unknown): boolean {
  const schema = z.record(z.string(), z.unknown()).parse(value)
  if (typeof schema.description === 'string' && schema.description.trim())
    return true
  // Zod can keep a nullable field's description on its non-null union branch.
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : []
  const values = branches.filter(
    (branch) => z.record(z.string(), z.unknown()).parse(branch).type !== 'null',
  )
  return values.length > 0 && values.every(hasOutputDescription)
}

function missingOutputDescriptions(value: unknown, path = '#'): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      missingOutputDescriptions(item, `${path}/${index}`),
    )
  const node = z.record(z.string(), z.unknown()).parse(value)
  const properties =
    node.properties && typeof node.properties === 'object'
      ? z.record(z.string(), z.unknown()).parse(node.properties)
      : {}
  const missing = Object.entries(properties).flatMap(([name, property]) =>
    hasOutputDescription(property) ? [] : [`${path}/properties/${name}`],
  )
  return [
    ...missing,
    ...Object.entries(node).flatMap(([name, child]) =>
      missingOutputDescriptions(child, `${path}/${name}`),
    ),
  ]
}

describe('every hosted MCP tool has a usable output contract', () => {
  it('publishes a non-empty object output schema for the entire catalog', () => {
    expect(MCP_TOOLS.map((tool) => tool.name).sort()).toEqual(
      Object.keys(MCP_OUTPUT_SCHEMAS).sort(),
    )
    const missingDescriptions: string[] = []
    for (const entry of listTools()) {
      const tool = z
        .object({
          name: z.string(),
          outputSchema: z
            .object({
              type: z.literal('object'),
              properties: z.record(z.string(), z.unknown()),
            })
            .passthrough(),
        })
        .parse(entry)
      expect(
        Object.keys(tool.outputSchema.properties).length,
        tool.name,
      ).toBeGreaterThan(0)
      missingDescriptions.push(
        ...missingOutputDescriptions(tool.outputSchema).map(
          (path) => `${tool.name}: ${path}`,
        ),
      )
    }
    expect(missingDescriptions).toEqual([])
  })

  it.concurrent.each(Object.entries(payloads))(
    'validates successful structured output for %s',
    async (name, payload) => {
      const tool = MCP_TOOLS_BY_NAME.get(name)!
      const result = await tool.run(
        {
          appId,
          orgId,
          job_id: signed.job_id,
          name: 'build.succeeded',
          uri,
          subscriptionId: subscription.id,
        },
        context(payload),
      )
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      expect(result.structuredContent).toBeDefined()
      expect(
        tool.outputSchema.safeParse(result.structuredContent).success,
        name,
      ).toBe(true)
    },
  )

  it.concurrent.each(['capgo_request_build', 'capgo_get_build_upload_url'])(
    'preserves upload instructions for %s when the builder omits its optional size limit',
    async (name) => {
      const { max_bytes: _maxBytes, ...upload } = signed
      const ctx = context({ job_id: signed.job_id })
      ctx.call = async (request) => ({
        ok: true,
        status: 200,
        data: request.path.startsWith('/build/upload_url/')
          ? upload
          : { job_id: signed.job_id },
      })
      const result = await MCP_TOOLS_BY_NAME.get(name)!.run(
        { appId, job_id: signed.job_id, platform: 'ios' },
        ctx,
      )
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject(
        name === 'capgo_request_build'
          ? {
              job_id: signed.job_id,
              upload,
              next_step: expect.stringContaining('capgo_start_build'),
            }
          : { data: upload },
      )
    },
  )

  it('validates skipped and ready-to-upload bundle preparation branches', async () => {
    const tool = MCP_TOOLS_BY_NAME.get('capgo_prepare_bundle_upload')!
    const existing = {
      ...ack,
      skipped: true,
      reason: 'VERSION_EXISTS',
      app_id: appId,
      version: '1.0.0',
    }
    const skipped = await tool.run({}, context(existing))
    expect(skipped.isError).not.toBe(true)
    expect(skipped.structuredContent).toEqual({ data: existing })
    const prepare = {
      ...payloads.capgo_prepare_bundle_upload,
      channels: [{ name: 'production', compatibility: 'skipped', reasons: [] }],
    }
    const prepared = await tool.run({}, context(prepare))
    expect(prepared.isError).not.toBe(true)
    expect(
      tool.outputSchema.safeParse(prepared.structuredContent).success,
    ).toBe(true)
  })

  it('preserves upstream API errors without requiring the success schema', async () => {
    const ctx = context(null)
    ctx.call = async () => ({
      ok: false,
      status: 403,
      data: { error: 'permission_denied' },
      requestId: 'example-request',
    })
    const result = await MCP_TOOLS_BY_NAME.get('capgo_get_app')!.run({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: 403,
      error: 'permission_denied',
      request_id: 'example-request',
    })
  })

  it('preserves legacy API text while adding a typed data envelope', async () => {
    const tool = MCP_TOOLS_BY_NAME.get('capgo_list_apps')!
    const result = await tool.run({}, context([app]))
    expect(JSON.parse(result.content[0].text)).toEqual([app])
    expect(result.structuredContent).toEqual({ data: [app] })
  })

  it('turns malformed upstream data into an actionable error without exposing response values', async () => {
    const result = await MCP_TOOLS_BY_NAME.get('capgo_get_account')!.run(
      {},
      context({ id: 42, email: 'example-private-value' }),
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: 'invalid_tool_output',
      how_to_fix: { kind: 'unexpected' },
    })
    expect(result.content[0].text).not.toContain('example-private-value')
  })

  it('does not bypass the size limit through structuredContent', async () => {
    const result = await MCP_TOOLS_BY_NAME.get('capgo_get_app')!.run(
      {},
      context({ ...app, name: 'x'.repeat(MAX_RESULT_CHARS + 1) }),
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0].text.length).toBeLessThan(MAX_RESULT_CHARS)
    expect(JSON.parse(result.content[0].text)).toHaveProperty(
      'error',
      'result_too_large',
    )
  })

  it('keeps validation errors separate from successful output schemas', async () => {
    const response = await handleJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'capgo_get_app', arguments: {} },
      },
      context(app),
    )
    const result = z
      .object({
        result: z.object({
          isError: z.literal(true),
          content: z.array(z.object({ text: z.string() })),
        }),
      })
      .parse(response)
    expect(result.result.content[0].text).toContain('appId')
    expect(result.result).not.toHaveProperty('structuredContent')
  })
})

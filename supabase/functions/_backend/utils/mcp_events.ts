import type { Context } from 'hono'
import type { PgClient } from './pg.ts'
import type { Database } from './supabase.types.ts'
import type { AuditLogData, WebhookDeliveryPayload } from './webhook.ts'
import { z } from 'zod'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { BEGIN_WRITE_TRANSACTION_SQL, closeClient, getPgClient } from './pg.ts'
import { queryJson, queryJsonOne } from './pg_rls.ts'
import {
  createDeliveryRecord,
  generateStandardWebhookSignature,
  getWebhookPublicUrlValidationError,
  queueWebhookDelivery,
} from './webhook.ts'
import { checkPermission } from './rbac.ts'

export const MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ORG = 25
export const MCP_EVENT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const MCP_EVENT_MAX_TTL_MS = 24 * 60 * 60 * 1000

export const MCP_EVENT_NAMES = [
  'build.succeeded',
  'build.failed',
  'bundle.uploaded',
  'bundle.deployed',
] as const

export type McpEventName = typeof MCP_EVENT_NAMES[number]

export interface McpEventEnvelope {
  eventId: string
  name: McpEventName
  timestamp: string
  data: Record<string, unknown>
  cursor: null
}

type WebhookRow = Database['public']['Tables']['webhooks']['Row'] & {
  source?: string
  expires_at?: string | null
  mcp_event?: string | null
  mcp_arguments?: Record<string, unknown> | null
  mcp_verified_at?: string | null
}

const mcpArgumentsSchema = z.object({
  org_id: z.string().uuid(),
  app_id: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
}).strict()

function mcpEventOrgFilterInputSchema(extraProperties: Record<string, unknown> = {}) {
  return {
    type: 'object',
    properties: {
      org_id: { type: 'string', format: 'uuid' },
      app_id: { type: 'string', description: 'Optional app filter' },
      ...extraProperties,
    },
    required: ['org_id'],
  }
}

export const MCP_EVENT_CATALOG: Array<{
  name: McpEventName
  description: string
  delivery: ['webhook']
  inputSchema: Record<string, unknown>
  payloadSchema: Record<string, unknown>
}> = [
  {
    name: 'build.succeeded',
    description: 'Fires when a native build finishes successfully.',
    delivery: ['webhook'],
    inputSchema: mcpEventOrgFilterInputSchema(),
    payloadSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string' },
        app_id: { type: 'string' },
        job_id: { type: 'string' },
        platform: { type: 'string' },
        build_mode: { type: 'string' },
        duration_seconds: { type: 'number' },
      },
    },
  },
  {
    name: 'build.failed',
    description: 'Fires when a native build fails or times out (failure_category timeout).',
    delivery: ['webhook'],
    inputSchema: mcpEventOrgFilterInputSchema(),
    payloadSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string' },
        app_id: { type: 'string' },
        job_id: { type: 'string' },
        platform: { type: 'string' },
        build_mode: { type: 'string' },
        duration_seconds: { type: 'number' },
        failure_category: { type: 'string' },
      },
    },
  },
  {
    name: 'bundle.uploaded',
    description: 'Fires when a new bundle version is uploaded.',
    delivery: ['webhook'],
    inputSchema: mcpEventOrgFilterInputSchema(),
    payloadSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string' },
        app_id: { type: 'string' },
        bundle_id: { type: 'string' },
        bundle_name: { type: 'string' },
        checksum: { type: 'string' },
      },
    },
  },
  {
    name: 'bundle.deployed',
    description: 'Fires when a channel bundle version changes.',
    delivery: ['webhook'],
    inputSchema: mcpEventOrgFilterInputSchema({
      channel: { type: 'string', description: 'Optional channel name filter for bundle.deployed' },
    }),
    payloadSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string' },
        app_id: { type: 'string' },
        channel_id: { type: 'string' },
        channel_name: { type: 'string' },
        bundle_id: { type: 'string' },
        previous_bundle_id: { type: 'string' },
      },
    },
  },
]

function isMcpEventName(value: string): value is McpEventName {
  return (MCP_EVENT_NAMES as readonly string[]).includes(value)
}

export function generateWhsecSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const binary = Array.from(bytes, byte => String.fromCodePoint(byte)).join('')
  return `whsec_${btoa(binary)}`
}

function parseWhsecSecret(secret: string): boolean {
  if (!secret.startsWith('whsec_'))
    return false
  try {
    const decoded = atob(secret.slice('whsec_'.length))
    return decoded.length >= 24 && decoded.length <= 64
  }
  catch {
    return false
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let i = 0; i < a.length; i++)
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0)
  return diff === 0
}

export function buildMcpEventEnvelope(name: McpEventName, data: Record<string, unknown>): McpEventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    name,
    timestamp: new Date().toISOString(),
    data,
    cursor: null,
  }
}

export function mcpEnvelopeToDeliveryPayload(envelope: McpEventEnvelope): WebhookDeliveryPayload {
  return envelope as unknown as WebhookDeliveryPayload
}

async function withAdminPg<T>(c: Context, run: (pg: PgClient) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await run(pg)
  }
  finally {
    closeClient(c, pg)
  }
}

export async function apiKeyHasAppScopedBinding(c: Context, rbacId: string): Promise<boolean> {
  try {
    return await withAdminPg(c, async (pg) => {
      const rows = await queryJson<{ has_app_scope: boolean }>(
        pg,
        `
        SELECT EXISTS (
          SELECT 1
          FROM public.role_bindings
          WHERE principal_type = public.rbac_principal_apikey()
            AND principal_id = $1::uuid
            AND scope_type <> public.rbac_scope_org()
            AND (expires_at IS NULL OR expires_at > now())
        ) AS has_app_scope
        `,
        [rbacId],
      )
      return rows[0]?.has_app_scope ?? true
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'mcp_events app scope check failed', error: serializeError(error) })
    return true
  }
}

export async function assertMcpEventsAuth(
  c: Context,
  orgId: string,
  userId: string,
  apikeyRbacId: string,
  appId?: string,
): Promise<void> {
  if (await apiKeyHasAppScopedBinding(c, apikeyRbacId))
    throw Object.assign(new Error('App-scoped API keys cannot subscribe to MCP events'), { code: 'app_scoped_key' })

  if (!(await checkPermission(c, 'org.update_settings', { orgId })))
    throw Object.assign(new Error('org.update_settings required'), { code: 'forbidden' })

  if (appId && !(await checkPermission(c, 'app.read', { orgId, appId })))
    throw Object.assign(new Error('Cannot read filtered app'), { code: 'forbidden' })
}

async function countActiveMcpSubscriptionsOnPg(pg: PgClient, orgId: string): Promise<number> {
  const rows = await queryJson<{ count: number }>(
    pg,
    `
    SELECT count(*)::int AS count
    FROM public.webhooks
    WHERE org_id = $1
      AND source = 'mcp'
      AND enabled = true
      AND (expires_at IS NULL OR expires_at > now())
    `,
    [orgId],
  )
  return rows[0]?.count ?? 0
}

async function withMcpSubscriptionOrgLock<T>(
  c: Context,
  orgId: string,
  run: (pg: PgClient) => Promise<T>,
): Promise<T> {
  return await withAdminPg(c, async (pg) => {
    await pg.query(BEGIN_WRITE_TRANSACTION_SQL)
    try {
      await pg.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`mcp_subs:${orgId}`],
      )
      const result = await run(pg)
      await pg.query('COMMIT')
      return result
    }
    catch (error) {
      await pg.query('ROLLBACK').catch(() => {})
      throw error
    }
  })
}

export async function countActiveMcpSubscriptions(c: Context, orgId: string): Promise<number> {
  return await withAdminPg(c, pg => countActiveMcpSubscriptionsOnPg(pg, orgId))
}

function subscriptionName(eventName: McpEventName, args: z.infer<typeof mcpArgumentsSchema>): string {
  const parts = ['MCP', eventName, args.org_id]
  if (args.app_id)
    parts.push(args.app_id)
  if (args.channel)
    parts.push(args.channel)
  return parts.join(' · ')
}

function computeExpiresAt(ttlMs: number | null | undefined): Date {
  const ttl = ttlMs === null || ttlMs === undefined ? MCP_EVENT_DEFAULT_TTL_MS : Math.min(Math.max(ttlMs, 60_000), MCP_EVENT_MAX_TTL_MS)
  return new Date(Date.now() + ttl)
}

export async function verifyMcpWebhookEndpoint(
  c: Context,
  url: string,
  secret: string,
  subscriptionId: string,
): Promise<{ ok: boolean, reason?: string }> {
  const urlError = await getWebhookPublicUrlValidationError(c, url)
  if (urlError)
    return { ok: false, reason: 'http_4xx' }

  const challenge = crypto.randomUUID()
  const body = JSON.stringify({ type: 'verification', challenge })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const messageId = crypto.randomUUID()
  const signature = await generateStandardWebhookSignature(secret, messageId, timestamp, body)

  const MAX_VERIFICATION_BODY_BYTES = 65_536

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Capgo-MCP-Events/1.0',
          'webhook-id': messageId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
          'X-MCP-Subscription-Id': subscriptionId,
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      })

      if (!response.ok)
        return { ok: false, reason: response.status >= 500 ? 'http_5xx' : 'challenge_failed' }

      const text = await response.text()
      if (text.length > MAX_VERIFICATION_BODY_BYTES)
        return { ok: false, reason: 'challenge_failed' }

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      }
      catch {
        return { ok: false, reason: 'challenge_failed' }
      }

      const echoed = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>).challenge
        : undefined
      if (typeof echoed !== 'string' || !constantTimeEqual(echoed, challenge))
        return { ok: false, reason: 'challenge_failed' }

      return { ok: true }
    }
    finally {
      clearTimeout(timeoutId)
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('abort'))
      return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'connection_refused' }
  }
}

export interface McpSubscribeInput {
  name: string
  arguments: Record<string, unknown>
  delivery: {
    mode: string
    url: string
    secret?: string
  }
  ttlMs?: number | null
}

export interface McpSubscribeResult {
  id: string
  refreshBefore: string
  secret?: string
  verificationFailed?: boolean
  verificationReason?: string
}

export async function upsertMcpEventSubscription(
  c: Context,
  input: McpSubscribeInput,
  auth: { userId: string, apikeyId: number, rbacId: string, echoSecret: boolean },
): Promise<McpSubscribeResult> {
  if (input.delivery.mode !== 'webhook')
    throw Object.assign(new Error('Only webhook delivery is supported'), { code: 'invalid_delivery' })

  if (!isMcpEventName(input.name))
    throw Object.assign(new Error(`Unknown event: ${input.name}`), { code: 'invalid_event' })

  const argsParsed = mcpArgumentsSchema.safeParse(input.arguments)
  if (!argsParsed.success)
    throw Object.assign(new Error('Invalid subscription arguments'), { code: 'invalid_arguments', details: argsParsed.error })

  const args = argsParsed.data
  await assertMcpEventsAuth(c, args.org_id, auth.userId, auth.rbacId, args.app_id)

  const secret = input.delivery.secret ?? (auth.echoSecret ? generateWhsecSecret() : undefined)
  if (!secret || !parseWhsecSecret(secret))
    throw Object.assign(new Error('delivery.secret must be a whsec_ secret'), { code: 'invalid_secret' })

  const urlError = await getWebhookPublicUrlValidationError(c, input.delivery.url)
  if (urlError)
    throw Object.assign(new Error(urlError), { code: 'invalid_url' })

  const expiresAt = computeExpiresAt(input.ttlMs)
  const subscriptionNameValue = subscriptionName(input.name, args)

  const existing = await withAdminPg(c, async (pg) => {
    return queryJson<WebhookRow>(
      pg,
      `
      SELECT *
      FROM public.webhooks
      WHERE source = 'mcp'
        AND created_by = $1::uuid
        AND url = $2
        AND mcp_event = $3
        AND mcp_arguments = $4::jsonb
      LIMIT 1
      `,
      [auth.userId, input.delivery.url, input.name, JSON.stringify(args)],
    )
  })

  let webhookId: string
  if (existing[0]) {
    webhookId = existing[0].id
    await withAdminPg(c, pg => pg.query(
      `
      UPDATE public.webhooks
      SET secret = $2,
          expires_at = $3,
          enabled = true,
          name = $4,
          events = ARRAY[$5]::text[],
          delivery_version = 'standard',
          updated_at = now()
      WHERE id = $1
      `,
      [webhookId, secret, expiresAt.toISOString(), subscriptionNameValue, input.name],
    ))
  }
  else {
    const inserted = await withMcpSubscriptionOrgLock(c, args.org_id, async (pg) => {
      const active = await countActiveMcpSubscriptionsOnPg(pg, args.org_id)
      if (active >= MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ORG) {
        throw Object.assign(
          new Error(`Active MCP subscription limit reached (${MAX_ACTIVE_MCP_SUBSCRIPTIONS_PER_ORG})`),
          { code: 'subscription_cap' },
        )
      }
      return await queryJsonOne<{ id: string }>(
        pg,
        `
        INSERT INTO public.webhooks (
          org_id, name, url, secret, enabled, events, delivery_version, created_by,
          source, expires_at, mcp_event, mcp_arguments, mcp_verified_at
        )
        VALUES ($1, $2, $3, $4, true, ARRAY[$5]::text[], 'standard', $6, 'mcp', $7, $8, $9::jsonb, NULL)
        RETURNING id
        `,
        [
          args.org_id,
          subscriptionNameValue,
          input.delivery.url,
          secret,
          input.name,
          auth.userId,
          expiresAt.toISOString(),
          input.name,
          JSON.stringify(args),
        ],
      )
    })
    if (!inserted?.id)
      throw Object.assign(new Error('Failed to create MCP subscription row'), { code: 'internal' })
    webhookId = inserted.id
  }

  const verification = await verifyMcpWebhookEndpoint(c, input.delivery.url, secret, webhookId)
  await withAdminPg(c, pg => pg.query(
    'UPDATE public.webhooks SET mcp_verified_at = $2 WHERE id = $1',
    [webhookId, verification.ok ? new Date().toISOString() : null],
  ))

  return {
    id: webhookId,
    refreshBefore: expiresAt.toISOString(),
    ...(auth.echoSecret && !input.delivery.secret ? { secret } : {}),
    ...(!verification.ok
      ? { verificationFailed: true, verificationReason: verification.reason ?? 'challenge_failed' }
      : {}),
  }
}

export async function listMcpEventSubscriptions(
  c: Context,
  orgId: string,
  userId: string,
  rbacId: string,
): Promise<unknown[]> {
  await assertMcpEventsAuth(c, orgId, userId, rbacId)
  return withAdminPg(c, pg => queryJson(
    pg,
    `
    SELECT id, org_id, name, url, enabled, events, mcp_event, mcp_arguments, expires_at, mcp_verified_at, created_at, updated_at, created_by
    FROM public.webhooks
    WHERE org_id = $1 AND source = 'mcp'
    ORDER BY created_at DESC
    `,
    [orgId],
  ))
}

export async function unsubscribeMcpEvent(
  c: Context,
  subscriptionId: string,
  orgId: string,
  userId: string,
  rbacId: string,
): Promise<boolean> {
  await assertMcpEventsAuth(c, orgId, userId, rbacId)
  const result = await withAdminPg(c, pg => pg.query(
    'DELETE FROM public.webhooks WHERE id = $1 AND org_id = $2 AND source = \'mcp\' RETURNING id',
    [subscriptionId, orgId],
  ))
  return (result.rowCount ?? 0) > 0
}

function webhookIsDeliverable(webhook: WebhookRow): boolean {
  if (webhook.source !== 'mcp')
    return true
  if (!webhook.mcp_verified_at)
    return false
  if (webhook.expires_at && new Date(webhook.expires_at).getTime() <= Date.now())
    return false
  return webhook.enabled
}

function argumentsMatch(webhook: WebhookRow, data: Record<string, unknown>): boolean {
  const args = webhook.mcp_arguments ?? {}
  const orgId = typeof args.org_id === 'string' ? args.org_id : null
  if (orgId && orgId !== data.org_id)
    return false

  const appFilter = typeof args.app_id === 'string' ? args.app_id : null
  if (appFilter && appFilter !== data.app_id)
    return false

  const channelFilter = typeof args.channel === 'string' ? args.channel : null
  if (channelFilter) {
    const channelName = typeof data.channel_name === 'string' ? data.channel_name : null
    if (channelName !== channelFilter)
      return false
  }

  return true
}

export async function findMcpWebhooksForEvent(c: Context, orgId: string, eventName: McpEventName): Promise<WebhookRow[]> {
  try {
    const rows = await withAdminPg(c, pg => queryJson<WebhookRow>(
      pg,
      `
      SELECT *
      FROM public.webhooks
      WHERE org_id = $1
        AND source = 'mcp'
        AND enabled = true
        AND mcp_event = $2
        AND (expires_at IS NULL OR expires_at > now())
      `,
      [orgId, eventName],
    ))
    return rows.filter(webhookIsDeliverable)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error finding MCP webhooks', error: serializeError(error) })
    return []
  }
}

export async function dispatchMcpEvent(
  c: Context,
  orgId: string,
  eventName: McpEventName,
  data: Record<string, unknown>,
): Promise<void> {
  const webhooks = (await findMcpWebhooksForEvent(c, orgId, eventName))
    .filter(webhook => argumentsMatch(webhook, data))

  if (webhooks.length === 0)
    return

  const envelope = buildMcpEventEnvelope(eventName, data)
  const deliveryPayload = mcpEnvelopeToDeliveryPayload(envelope)

  await Promise.all(webhooks.map(async (webhook) => {
    const delivery = await createDeliveryRecord(
      c,
      webhook.id,
      webhook.org_id,
      null,
      eventName,
      deliveryPayload,
      'standard',
    )
    if (!delivery)
      return

    const urlError = await getWebhookPublicUrlValidationError(c, webhook.url)
    if (urlError)
      return

    await queueWebhookDelivery(c, delivery.id, webhook.id, webhook.url, deliveryPayload)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Queued MCP event delivery',
      eventName,
      webhookId: webhook.id,
    })
  }))
}

export function mapAuditLogToMcpEvent(audit: AuditLogData): McpEventName | null {
  if (audit.table_name === 'app_versions' && audit.operation === 'INSERT') {
    const record = audit.new_record
    if (!record)
      return null
    if (record.builtin === true || record.builtin === 'true')
      return null
    if (!record.name)
      return null
    return 'bundle.uploaded'
  }

  if (audit.table_name === 'channels' && audit.operation === 'UPDATE') {
    const oldVersion = audit.old_record?.version
    const newVersion = audit.new_record?.version
    if (oldVersion === newVersion)
      return null
    if (newVersion === undefined || newVersion === null)
      return null
    return 'bundle.deployed'
  }

  return null
}

function auditRecordString(value: unknown, fallback = ''): string {
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  return fallback
}

function buildBundleUploadedMcpData(audit: AuditLogData): Record<string, unknown> | null {
  const record = audit.new_record
  if (!record)
    return null
  const appId = typeof record.app_id === 'string' ? record.app_id : null
  if (!appId)
    return null
  return {
    org_id: audit.org_id,
    app_id: appId,
    bundle_id: auditRecordString(record.id, audit.record_id),
    bundle_name: typeof record.name === 'string' ? record.name : auditRecordString(record.version),
    checksum: typeof record.checksum === 'string' ? record.checksum : null,
  }
}

function buildBundleDeployedMcpData(audit: AuditLogData): Record<string, unknown> | null {
  const record = audit.new_record
  const old = audit.old_record
  if (!record)
    return null
  const appId = typeof record.app_id === 'string' ? record.app_id : auditRecordString(record.app_id)
  return {
    org_id: audit.org_id,
    app_id: appId,
    channel_id: auditRecordString(record.id, audit.record_id),
    channel_name: typeof record.name === 'string' ? record.name : auditRecordString(record.id),
    bundle_id: record.version !== undefined && record.version !== null ? auditRecordString(record.version) : '',
    previous_bundle_id: old?.version !== undefined && old?.version !== null ? auditRecordString(old.version) : null,
  }
}

export function buildMcpDataFromAudit(audit: AuditLogData, eventName: McpEventName): Record<string, unknown> | null {
  if (eventName === 'bundle.uploaded')
    return buildBundleUploadedMcpData(audit)
  if (eventName === 'bundle.deployed')
    return buildBundleDeployedMcpData(audit)
  return null
}

export async function dispatchMcpEventsFromAudit(c: Context, audit: AuditLogData): Promise<void> {
  const eventName = mapAuditLogToMcpEvent(audit)
  if (!eventName)
    return
  const data = buildMcpDataFromAudit(audit, eventName)
  if (!data)
    return
  await dispatchMcpEvent(c, audit.org_id, eventName, data)
}

export interface BuildMcpEventInput {
  orgId: string
  appId: string
  jobId: string
  platform: string
  buildMode: string
  durationSeconds?: number | null
  failureCategory?: string | null
  transition: 'succeeded' | 'failed'
}

export async function dispatchMcpBuildEvent(c: Context, input: BuildMcpEventInput): Promise<void> {
  const eventName: McpEventName = input.transition === 'succeeded' ? 'build.succeeded' : 'build.failed'
  const data: Record<string, unknown> = {
    org_id: input.orgId,
    app_id: input.appId,
    job_id: input.jobId,
    platform: input.platform,
    build_mode: input.buildMode,
  }
  if (input.durationSeconds !== null && input.durationSeconds !== undefined)
    data.duration_seconds = input.durationSeconds
  if (eventName === 'build.failed')
    data.failure_category = input.failureCategory ?? 'unknown'

  await dispatchMcpEvent(c, input.orgId, eventName, data)
}

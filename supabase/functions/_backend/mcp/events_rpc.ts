import type { Context } from 'hono'
import type { JsonRpcResponse } from './protocol.ts'
import type { McpToolContext } from './tools.ts'
import { JSON_RPC_ERRORS, jsonRpcError, jsonRpcResult } from './protocol.ts'
import type { McpEventName, McpSubscribeInput } from '../utils/mcp_events.ts'
import {
  listMcpEventSubscriptions,
  MCP_EVENT_CATALOG,
  unsubscribeMcpEvent,
  upsertMcpEventSubscription,
} from '../utils/mcp_events.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'

function mcpContext(c: Context, ctx: McpToolContext, apikeyRbacId: string) {
  return {
    userId: ctx.caller.userId,
    apikeyId: ctx.caller.apikeyId,
    rbacId: apikeyRbacId,
  }
}

export async function loadApikeyRbacId(c: Context, apikeyId: number): Promise<string | null> {
  const pg = await getPgClient(c)
  try {
    const result = await pg.query<{ rbac_id: string | null }>(
      'SELECT rbac_id FROM public.apikeys WHERE id = $1 LIMIT 1',
      [apikeyId],
    )
    return result.rows[0]?.rbac_id ?? null
  }
  finally {
    closeClient(c, pg)
  }
}

function mapSubscribeError(error: unknown): { code: number, message: string } {
  const record = (error && typeof error === 'object') ? error as { code?: string, message?: string } : {}
  const code = record.code
  if (code === 'forbidden')
    return { code: -32024, message: record.message ?? 'Forbidden' }
  if (code === 'app_scoped_key')
    return { code: -32024, message: 'App-scoped API keys cannot subscribe to MCP events' }
  if (code === 'subscription_cap')
    return { code: -32002, message: record.message ?? 'Active MCP subscription limit reached' }
  if (code === 'invalid_secret' || code === 'invalid_url' || code === 'invalid_arguments' || code === 'invalid_event')
    return { code: JSON_RPC_ERRORS.invalidParams, message: record.message ?? 'Invalid subscribe parameters' }
  return { code: JSON_RPC_ERRORS.internalError, message: record.message ?? 'Subscribe failed' }
}

export function handleEventsList(requestId: string | number): JsonRpcResponse {
  return jsonRpcResult(requestId, { events: MCP_EVENT_CATALOG })
}

export type McpSubscribeToolInput = {
  name: McpEventName
  orgId: string
  url: string
  secret?: string
  app_id?: string
  channel?: string
  ttlMs?: number
}

export function mcpSubscribeInputFromTool(data: McpSubscribeToolInput): McpSubscribeInput {
  return {
    name: data.name,
    arguments: {
      org_id: data.orgId,
      ...(data.app_id ? { app_id: data.app_id } : {}),
      ...(data.channel ? { channel: data.channel } : {}),
    },
    delivery: { mode: 'webhook', url: data.url, secret: data.secret },
    ttlMs: data.ttlMs,
  }
}

export function mcpSubscribeInputFromRpc(
  params: Record<string, unknown>,
): { ok: true, input: McpSubscribeInput } | { ok: false, message: string } {
  const delivery = params.delivery
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery))
    return { ok: false, message: 'delivery is required' }

  const deliveryRecord = delivery as Record<string, unknown>
  return {
    ok: true,
    input: {
      name: typeof params.name === 'string' ? params.name : '',
      arguments: (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
        ? params.arguments as Record<string, unknown>
        : {},
      delivery: {
        mode: typeof deliveryRecord.mode === 'string' ? deliveryRecord.mode : 'webhook',
        url: typeof deliveryRecord.url === 'string' ? deliveryRecord.url : '',
        secret: typeof deliveryRecord.secret === 'string' ? deliveryRecord.secret : undefined,
      },
      ttlMs: typeof params.ttlMs === 'number' ? params.ttlMs : undefined,
    },
  }
}

function orgIdFromUnsubscribeParams(params: Record<string, unknown>): string {
  if (typeof params.org_id === 'string')
    return params.org_id
  const args = params.arguments
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const orgId = (args as Record<string, unknown>).org_id
    return typeof orgId === 'string' ? orgId : ''
  }
  return ''
}

export async function handleEventsSubscribe(
  c: Context,
  ctx: McpToolContext,
  requestId: string | number,
  params: Record<string, unknown>,
  echoSecret: boolean,
): Promise<JsonRpcResponse> {
  const rbacId = await loadApikeyRbacId(c, ctx.caller.apikeyId)
  if (!rbacId)
    return jsonRpcError(requestId, JSON_RPC_ERRORS.internalError, 'API key missing RBAC identity')

  const parsed = mcpSubscribeInputFromRpc(params)
  if (!parsed.ok)
    return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, parsed.message)

  if (!echoSecret && (typeof parsed.input.delivery.secret !== 'string' || !parsed.input.delivery.secret))
    return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'delivery.secret is required for events/subscribe')

  try {
    const result = await upsertMcpEventSubscription(
      c,
      parsed.input,
      { ...mcpContext(c, ctx, rbacId), echoSecret },
    )

    if (result.verificationFailed) {
      return jsonRpcError(requestId, -32027, 'Callback endpoint verification failed', {
        id: result.id,
        reason: result.verificationReason ?? 'challenge_failed',
      })
    }

    return jsonRpcResult(requestId, {
      id: result.id,
      refreshBefore: result.refreshBefore,
      ...(result.secret ? { secret: result.secret } : {}),
    })
  }
  catch (error) {
    const mapped = mapSubscribeError(error)
    return jsonRpcError(requestId, mapped.code ?? JSON_RPC_ERRORS.internalError, mapped.message ?? 'Subscribe failed')
  }
}

export async function handleEventsUnsubscribe(
  c: Context,
  ctx: McpToolContext,
  requestId: string | number,
  params: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const rbacId = await loadApikeyRbacId(c, ctx.caller.apikeyId)
  if (!rbacId)
    return jsonRpcError(requestId, JSON_RPC_ERRORS.internalError, 'API key missing RBAC identity')

  const subscriptionId = typeof params.id === 'string' ? params.id : ''
  const orgId = orgIdFromUnsubscribeParams(params)

  if (!subscriptionId || !orgId)
    return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'id and org_id are required')

  try {
    const deleted = await unsubscribeMcpEvent(c, subscriptionId, orgId, ctx.caller.userId, rbacId)
    if (!deleted)
      return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'Subscription not found')
    return jsonRpcResult(requestId, { id: subscriptionId, unsubscribed: true })
  }
  catch (error) {
    const mapped = mapSubscribeError(error)
    return jsonRpcError(requestId, mapped.code ?? JSON_RPC_ERRORS.internalError, mapped.message ?? 'Unsubscribe failed')
  }
}

export async function handleCapgoListEventSubscriptions(
  c: Context,
  ctx: McpToolContext,
  orgId: string,
) {
  const rbacId = await loadApikeyRbacId(c, ctx.caller.apikeyId)
  if (!rbacId)
    throw new Error('API key missing RBAC identity')
  return listMcpEventSubscriptions(c, orgId, ctx.caller.userId, rbacId)
}

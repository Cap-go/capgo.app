import type { Context } from 'hono'
import type { JsonRpcResponse } from './protocol.ts'
import type { McpToolContext } from './tools.ts'
import { JSON_RPC_ERRORS, jsonRpcError, jsonRpcResult } from './protocol.ts'
import {
  listMcpEventSubscriptions,
  MCP_EVENT_CATALOG,
  unsubscribeMcpEvent,
  upsertMcpEventSubscription,
} from '../utils/mcp_events.ts'
import { getPgClient } from '../utils/pg.ts'

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
    const { closeClient } = await import('../utils/pg.ts')
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

export async function handleEventsList(requestId: string | number): Promise<JsonRpcResponse> {
  return jsonRpcResult(requestId, { events: MCP_EVENT_CATALOG })
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

  const delivery = params.delivery
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery))
    return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'delivery is required')

  const deliveryRecord = delivery as Record<string, unknown>
  if (!echoSecret && (typeof deliveryRecord.secret !== 'string' || !deliveryRecord.secret))
    return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'delivery.secret is required for events/subscribe')

  try {
    const result = await upsertMcpEventSubscription(
      c,
      {
        name: String(params.name ?? ''),
        arguments: (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
          ? params.arguments as Record<string, unknown>
          : {},
        delivery: {
          mode: String(deliveryRecord.mode ?? 'webhook'),
          url: String(deliveryRecord.url ?? ''),
          secret: typeof deliveryRecord.secret === 'string' ? deliveryRecord.secret : undefined,
        },
        ttlMs: typeof params.ttlMs === 'number' ? params.ttlMs : undefined,
      },
      { ...mcpContext(c, ctx, rbacId), echoSecret },
    )

    if (result.verificationFailed) {
      return jsonRpcError(requestId, -32027, 'Callback endpoint verification failed', { reason: 'challenge_failed' })
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
  const orgId = typeof params.org_id === 'string'
    ? params.org_id
    : (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? String((params.arguments as Record<string, unknown>).org_id ?? '')
      : '')

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

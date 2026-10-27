import type { DurableObjectState } from '@cloudflare/workers-types'
import type { HttpDispatchRequest, HttpDispatchRow } from '../../supabase/functions/_backend/utils/http_dispatch.ts'
import { buildHttpDispatchRequests, dispatchAllowedOrigins } from '../../supabase/functions/_backend/utils/http_dispatch.ts'

const TICK_MS = 1000
const CLAIM_TIMEOUT_MS = 10_000
const CLAIM_URL = 'https://api-self.capgo.internal/triggers/http_dispatch/claim'
export const QUEUE_DISPATCHER_NAME = 'global'

interface Env {
  API_SECRET?: string
  SUPABASE_URL?: string
  // Comma-separated origins the outbox URLs may use (get_db_url() can differ
  // from SUPABASE_URL). The API secret is only ever sent to these origins.
  HTTP_DISPATCH_ALLOWED_ORIGINS?: string
  // Self service binding: claims run as normal Worker requests so the
  // Hyperdrive connection follows the per-request lifecycle instead of living
  // as long as this object.
  API_SELF?: { fetch: (input: string, init?: RequestInit) => Promise<Response> }
}

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...fields }))
}

function logError(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ event, ...fields, error: error instanceof Error ? error.message : String(error) }))
}

// Cloudflare allows six connections awaiting response headers per invocation
// and queues the rest, so starting every claimed call at once would let their
// timeouts expire while they wait. Calls are scheduled through these slots and
// each timeout starts only when its request is sent.
const MAX_OPEN_REQUESTS = 6
// Awaited consumers (on_manifest_create 60s, onboarding 100s) can use at most
// this many slots, so ordinary 8s wakeups always have one free.
const MAX_SLOW_REQUESTS = 4
const SLOW_REQUEST_TIMEOUT_MS = 10_000
// Same cap as process_function_queue's calls_needed: unsent calls for a target
// beyond this add no consumer capacity, the backlog is still in pgmq.
const MAX_PENDING_PER_TARGET = 10

function isSlow(request: HttpDispatchRequest) {
  return request.timeoutMs > SLOW_REQUEST_TIMEOUT_MS
}

/**
 * Replaces pg_net for routed targets: every second, claim the wakeups the
 * database wrote to public.http_dispatch_outbox and send them.
 *
 * Requests are not awaited by the alarm, matching pg_net's fire-and-forget
 * behavior: one slow consumer (onboarding waits up to 100s) must not hold back
 * the next tick. A Durable Object stays alive while its requests are in flight.
 */
// A plain class (like ConsoleEvents) instead of extending DurableObject from
// cloudflare:workers, so Node unit tests can still import the API worker.
export class QueueDispatcher {
  private readonly pending: HttpDispatchRequest[] = []
  private active = 0
  private activeSlow = 0

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    await this.ensureAlarm()
    return Response.json({ status: 'ok', active: this.active, activeSlow: this.activeSlow, pending: this.pending.length })
  }

  async alarm(): Promise<void> {
    // Schedule the next tick first so a failing claim never stops the loop.
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
    try {
      const rows = await this.claim()
      if (rows.length > 0)
        this.dispatch(rows)
    }
    catch (error) {
      // Claimed rows are only lost if the claim response is lost; the next
      // cron tick re-requests the wakeup and pgmq still holds the work.
      logError('queue_dispatcher_claim_failed', error)
    }
  }

  private async ensureAlarm() {
    if (await this.ctx.storage.getAlarm() === null)
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS)
  }

  private async claim(): Promise<HttpDispatchRow[]> {
    if (!this.env.API_SELF || !this.env.API_SECRET)
      throw new Error('API_SELF and API_SECRET are required')
    const response = await this.env.API_SELF.fetch(CLAIM_URL, {
      method: 'POST',
      headers: { apisecret: this.env.API_SECRET },
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    })
    if (!response.ok)
      throw new Error(`claim HTTP ${response.status}`)
    const body = await response.json() as { rows?: HttpDispatchRow[] }
    return body.rows ?? []
  }

  private dispatch(rows: HttpDispatchRow[]) {
    const { requests, rejected } = buildHttpDispatchRequests(
      rows,
      this.env.API_SECRET!,
      dispatchAllowedOrigins([this.env.SUPABASE_URL, ...(this.env.HTTP_DISPATCH_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim())]),
    )
    for (const row of rejected)
      logError('queue_dispatcher_url_rejected', new Error('dispatch URL origin is not allowed'), { target: row.target, url: row.url })
    for (const request of requests) {
      if (this.pending.filter(waiting => waiting.target === request.target).length < MAX_PENDING_PER_TARGET)
        this.pending.push(request)
    }
    this.pump()
  }

  private pump() {
    for (let i = 0; i < this.pending.length && this.active < MAX_OPEN_REQUESTS;) {
      const request = this.pending[i]
      const slow = isSlow(request)
      if (slow && this.activeSlow >= MAX_SLOW_REQUESTS) {
        i++
        continue
      }
      this.pending.splice(i, 1)
      this.active++
      if (slow)
        this.activeSlow++
      void this.send(request).finally(() => {
        this.active--
        if (slow)
          this.activeSlow--
        this.pump()
      })
    }
  }

  private async send(request: HttpDispatchRequest) {
    try {
      const response = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(request.timeoutMs) })
      // Drain the body so the connection is released.
      await response.arrayBuffer()
      if (!response.ok)
        log('queue_dispatcher_call_failed', { target: request.target, status: response.status })
    }
    catch (error) {
      // pg_net also drops timed-out calls; the consumer keeps running server
      // side and unprocessed messages become readable again in pgmq.
      logError('queue_dispatcher_call_error', error, { target: request.target })
    }
  }
}

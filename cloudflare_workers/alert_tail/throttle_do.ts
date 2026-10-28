import type { DurableObjectState } from '@cloudflare/workers-types'
import {
  capPostBodyAlerts,
  type AlertTailRecord,
} from './tail_logic.ts'
import {
  commitThrottleWrites,
  durableObjectStorageThrottleStore,
  parseThrottleSummaryIntervalSec,
  parseThrottleWindowSec,
  planCrossCallThrottle,
  type ThrottleOptions,
  type ThrottleWrite,
} from './throttle_logic.ts'

type ApplyThrottleRequest = {
  records: AlertTailRecord[]
  nowMs: number
  windowSec?: number
  summaryIntervalSec?: number
}

type FinalizeRequest = {
  planId?: string
}

export class AlertThrottle {
  private readonly store
  private readonly pendingPlans = new Map<string, ThrottleWrite[]>()

  constructor(ctx: DurableObjectState) {
    this.store = durableObjectStorageThrottleStore(ctx.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST')
      return new Response('method not allowed', { status: 405 })

    if (url.pathname.endsWith('/ack') || url.pathname.endsWith('/rollback')) {
      let body: FinalizeRequest = {}
      try {
        body = await request.json() as FinalizeRequest
      }
      catch {
        return new Response('invalid json', { status: 400 })
      }
      const planId = body.planId
      if (!planId)
        return new Response('missing planId', { status: 400 })

      const writes = this.pendingPlans.get(planId)
      if (!writes)
        return Response.json({ status: 'unknown_plan' })

      if (url.pathname.endsWith('/ack'))
        await commitThrottleWrites(this.store, writes)

      this.pendingPlans.delete(planId)
      return Response.json({ status: 'ok' })
    }

    let body: ApplyThrottleRequest
    try {
      body = await request.json() as ApplyThrottleRequest
    }
    catch {
      return new Response('invalid json', { status: 400 })
    }

    const options: ThrottleOptions = {
      windowMs: (body.windowSec ?? parseThrottleWindowSec(undefined)) * 1000,
      summaryIntervalMs: (body.summaryIntervalSec ?? parseThrottleSummaryIntervalSec(undefined)) * 1000,
    }

    const { toSend, writes } = await planCrossCallThrottle(
      body.records ?? [],
      this.store,
      body.nowMs ?? Date.now(),
      options,
    )
    const planId = crypto.randomUUID()
    this.pendingPlans.set(planId, writes)
    const alerts = capPostBodyAlerts(toSend)
    return Response.json({ alerts, planId })
  }
}

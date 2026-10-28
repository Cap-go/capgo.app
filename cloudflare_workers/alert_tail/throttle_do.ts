import {
  capPostBodyAlerts,
  type AlertTailRecord,
} from './tail_logic.ts'
import {
  commitThrottleWrites,
  MemoryThrottleStore,
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

export class AlertThrottle {
  private readonly store = new MemoryThrottleStore()
  private pendingWrites: ThrottleWrite[] | null = null

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST')
      return new Response('method not allowed', { status: 405 })

    if (url.pathname.endsWith('/ack')) {
      if (this.pendingWrites) {
        await commitThrottleWrites(this.store, this.pendingWrites)
        this.pendingWrites = null
      }
      return Response.json({ status: 'ok' })
    }

    if (url.pathname.endsWith('/rollback')) {
      this.pendingWrites = null
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
    this.pendingWrites = writes
    const alerts = capPostBodyAlerts(toSend)
    return Response.json({ alerts })
  }
}

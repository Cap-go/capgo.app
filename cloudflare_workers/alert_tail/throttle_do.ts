import {
  capPostBodyAlerts,
  type AlertTailRecord,
} from './tail_logic.ts'
import {
  applyCrossCallThrottle,
  MemoryThrottleStore,
  parseThrottleSummaryIntervalSec,
  parseThrottleWindowSec,
  type ThrottleOptions,
} from './throttle_logic.ts'

type ApplyThrottleRequest = {
  records: AlertTailRecord[]
  nowMs: number
  windowSec?: number
  summaryIntervalSec?: number
}

export class AlertThrottle {
  private readonly store = new MemoryThrottleStore()

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST')
      return new Response('method not allowed', { status: 405 })

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

    const throttled = await applyCrossCallThrottle(
      body.records ?? [],
      this.store,
      body.nowMs ?? Date.now(),
      options,
    )
    const alerts = capPostBodyAlerts(throttled)
    return Response.json({ alerts })
  }
}

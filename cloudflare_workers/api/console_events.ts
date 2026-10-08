import type { DurableObjectState } from '@cloudflare/workers-types'

/** Ephemeral org-scoped CLI events; no customer payloads are persisted. */
export class ConsoleEvents {
  private subscribers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()
  constructor(_state: DurableObjectState) {}

  async fetch(request: Request) {
    const encoder = new TextEncoder()
    if (request.method === 'POST') {
      const body = await request.text()
      const data = encoder.encode(`data: ${body}\n\n`)
      for (const [subscriber, cleanup] of this.subscribers) {
        if ((subscriber.desiredSize ?? 0) < -10) {
          subscriber.close()
          cleanup()
        }
        else {
          subscriber.enqueue(data)
        }
      }
      return Response.json({ status: 'ok' })
    }
    let heartbeat: ReturnType<typeof setInterval>
    let timeout: ReturnType<typeof setTimeout>
    let subscriber: ReadableStreamDefaultController<Uint8Array>
    const cleanup = () => {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      this.subscribers.delete(subscriber)
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = controller
        this.subscribers.set(controller, cleanup)
        controller.enqueue(encoder.encode(': connected\n\n'))
        heartbeat = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 10000)
        // Every reconnect revalidates session revocation and organization access.
        timeout = setTimeout(() => { cleanup(); controller.close() }, 30000)
      },
      cancel: cleanup,
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }
}

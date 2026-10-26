const MAX_EVENT_BYTES = 16 * 1024

/** Ephemeral org-scoped CLI events fanned out as server-sent events; nothing is persisted. */
export class ConsoleEvents {
  private readonly subscribers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()

  async fetch(request: Request) {
    const encoder = new TextEncoder()
    if (request.method === 'POST') {
      // Events are small notifications; refuse anything that could bloat every subscriber queue.
      if (Number(request.headers.get('content-length') ?? 0) > MAX_EVENT_BYTES)
        return Response.json({ error: 'event_too_large' }, { status: 413 })
      const body = await request.text()
      if (body.length > MAX_EVENT_BYTES)
        return Response.json({ error: 'event_too_large' }, { status: 413 })
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
        // One minute bounds how long a revoked session can keep listening while
        // keeping the unbuffered reconnect gap infrequent.
        timeout = setTimeout(() => {
          cleanup()
          controller.close()
        }, 60 * 1000)
      },
      cancel: cleanup,
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } })
  }
}

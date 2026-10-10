/**
 * Test origin for the snippet edge answer probe (see run.ts). Never serves
 * real traffic: it fakes the plugin worker answers the snippet learns from,
 * writes Cache API entries the probe snippet tries to read, and receives
 * Logpush batches (HTTP destination) into R2.
 */
interface Env {
  PROBE_SECRET: string
  PROBE_LOGS: R2Bucket
}

const PROBE_HOST = 'snippet-edge-probe.capgo.app'
const CURRENT_BUNDLE = '1.0.0'

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } })
}

function fill(fields: Record<string, unknown>, appId: string) {
  return encodeURIComponent(JSON.stringify({ v: 1, bps: 10000, ttl: 900, tags: `capgo-edge-probe-${appId}`, ...fields }))
}

function authorized(request: Request, env: Env) {
  return request.headers.get('Authorization') === `Bearer ${env.PROBE_SECRET}`
}

async function gunzipText(body: ReadableStream | null) {
  if (!body)
    return ''
  return await new Response(body.pipeThrough(new DecompressionStream('gzip'))).text()
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const colo = (request as any).cf?.colo ?? 'unknown'
    const origin = { 'X-Probe-Origin': colo }

    // Fake plugin worker: what the real snippet calls on the test host.
    if (request.method === 'POST' && url.pathname === '/updates') {
      const body = await request.json() as Record<string, any>
      if (typeof body.device_id === 'string' && body.device_id.startsWith('ffffffff')) {
        const resetAt = Math.floor(Date.now() / 1000) + 600
        return json({ error: 'on_premise_app', message: 'On-premise app detected' }, {
          status: 429,
          headers: { ...origin, 'Cache-Control': 'private, no-store', 'X-RateLimit-Reset': String(resetAt), 'X-Capgo-Edge-Ip-Limit': String(resetAt) },
        })
      }
      if (body.version_name !== CURRENT_BUNDLE)
        return json({ version: CURRENT_BUNDLE, url: 'https://example.com/bundle.zip' }, { headers: origin })
      return json({ error: 'no_new_version_available', message: 'No new version available', kind: 'up_to_date' }, {
        headers: { ...origin, 'X-Capgo-Edge-Fill': fill({ e: 'updates', n: CURRENT_BUNDLE, k: null, o: 'org-probe', a: true, cs: false }, body.app_id) },
      })
    }
    if (request.method === 'POST' && url.pathname === '/stats') {
      const body = await request.json() as any
      const events = Array.isArray(body) ? body : [body]
      const answer = Array.isArray(body) ? { status: 'ok', results: events.map((_: unknown, index: number) => ({ status: 'ok', index })) } : { status: 'ok' }
      return json(answer, { headers: { ...origin, 'X-Capgo-Edge-Fill': fill({ e: 'stats' }, events[0]?.app_id) } })
    }

    if (url.pathname === '/ping')
      return json({ ok: true, colo }, { headers: origin })

    // Cache API sharing between this worker and the probe snippet (same zone, same URL key).
    if (url.pathname === '/shared-put' || url.pathname === '/shared-get') {
      const key = `https://${PROBE_HOST}/__probe__/shared/${encodeURIComponent(url.searchParams.get('key') ?? '')}`
      if (url.pathname === '/shared-get') {
        const hit = await caches.default.match(key)
        return json({ hit: Boolean(hit), body: hit ? await hit.text() : null, colo }, { headers: origin })
      }
      await caches.default.put(key, new Response(`worker:${colo}`, {
        headers: { 'Cache-Control': 'public, max-age=600', 'Cache-Tag': url.searchParams.get('tag') ?? 'capgo-edge-probe-shared' },
      }))
      return json({ ok: true, colo }, { headers: origin })
    }

    // Logpush HTTP destination: gzip NDJSON batches.
    if (url.pathname === '/logpush' && request.method === 'POST') {
      if (!authorized(request, env))
        return new Response('unauthorized', { status: 401 })
      const text = await gunzipText(request.body)
      await env.PROBE_LOGS.put(`logpush/${Date.now()}-${crypto.randomUUID()}.ndjson`, text)
      return new Response('ok')
    }
    if (url.pathname === '/logpush-dump') {
      if (!authorized(request, env))
        return new Response('unauthorized', { status: 401 })
      const listed = await env.PROBE_LOGS.list({ prefix: 'logpush/' })
      const lines: unknown[] = []
      for (const object of listed.objects) {
        const text = await (await env.PROBE_LOGS.get(object.key))?.text() ?? ''
        for (const line of text.split('\n')) {
          if (!line.trim())
            continue
          try {
            const row = JSON.parse(line)
            const headers = row.ResponseHeaders ?? {}
            const stat = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-capgo-edge-stat')?.[1] as string | undefined
            lines.push({ host: row.ClientRequestHost, uri: row.ClientRequestURI, status: row.EdgeResponseStatus, statLength: stat?.length ?? null, stat: stat && stat.length <= 4096 ? stat : undefined })
          }
          catch {
            lines.push({ raw: line.slice(0, 200) })
          }
        }
      }
      return json({ files: listed.objects.length, lines })
    }

    return new Response('not found', { status: 404 })
  },
}

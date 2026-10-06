// Probe snippet for snippet-edge-probe.capgo.app (see run.ts). Answers
// /__probe__/* only; measures what the snippet edge answers rely on:
// - subrequest limit and whether Cache API calls count against it
// - Cache API entries written by a snippet purged by Cache-Tag
// - Cache API entries shared with a worker of the same zone
// - Logpush keeping a large response header

const ORIGIN = 'https://snippet-edge-probe-origin.capgo.app'

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })
}

function entryKey(hostname, kind, key) {
  return `https://${hostname}/__probe__/${kind}/${encodeURIComponent(key)}`
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const colo = request.cf?.colo ?? 'unknown'
    const q = url.searchParams

    if (url.pathname === '/__probe__/subreq') {
      // kind: match (n cache.match), fetch (n fetch), mixed (n-1 cache.match then 1 fetch)
      const n = Math.min(Number(q.get('n') ?? '6'), 12)
      const kind = q.get('kind') ?? 'match'
      const results = []
      for (let i = 0; i < n; i++) {
        const useFetch = kind === 'fetch' || (kind === 'mixed' && i === n - 1)
        try {
          if (useFetch) {
            const response = await fetch(`${ORIGIN}/ping?i=${i}`)
            results.push({ i: i + 1, op: 'fetch', ok: response.ok, status: response.status })
          }
          else {
            await caches.default.match(entryKey(url.hostname, 'subreq', String(i)))
            results.push({ i: i + 1, op: 'match', ok: true })
          }
        }
        catch (e) {
          results.push({ i: i + 1, op: useFetch ? 'fetch' : 'match', ok: false, error: String(e?.message ?? e) })
        }
      }
      return json({ colo, kind, n, results })
    }

    if (url.pathname === '/__probe__/put') {
      await caches.default.put(entryKey(url.hostname, 'entry', q.get('key')), new Response(`snippet:${colo}:${Date.now()}`, {
        headers: { 'Cache-Control': `public, max-age=${q.get('ttl') ?? '600'}`, 'Cache-Tag': q.get('tag') ?? 'capgo-edge-probe' },
      }))
      return json({ ok: true, colo })
    }
    if (url.pathname === '/__probe__/get') {
      const hit = await caches.default.match(entryKey(url.hostname, 'entry', q.get('key')))
      return json({ hit: Boolean(hit), body: hit ? await hit.text() : null, colo })
    }

    // Same key as the origin worker's /shared-put and /shared-get.
    if (url.pathname === '/__probe__/shared-get') {
      const hit = await caches.default.match(entryKey(url.hostname, 'shared', q.get('key')))
      return json({ hit: Boolean(hit), body: hit ? await hit.text() : null, colo })
    }
    if (url.pathname === '/__probe__/shared-put') {
      await caches.default.put(entryKey(url.hostname, 'shared', q.get('key')), new Response(`snippet:${colo}`, {
        headers: { 'Cache-Control': 'public, max-age=600', 'Cache-Tag': q.get('tag') ?? 'capgo-edge-probe-shared' },
      }))
      return json({ ok: true, colo })
    }

    if (url.pathname === '/__probe__/header') {
      const size = Math.min(Number(q.get('size') ?? '1024'), 64000)
      const value = 'A'.repeat(size)
      return json({ size, colo }, 200, { 'x-capgo-edge-stat': value, 'x-probe-size': String(size) })
    }

    return json({ error: 'unknown probe' }, 404)
  },
}

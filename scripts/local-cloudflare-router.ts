import { LOCAL_URL_HEADER, LOCAL_WORKER_HEADER } from './local-cloudflare-proxy-headers.ts'

interface LocalWorkerBindings {
  API: { fetch: (request: Request) => Promise<Response> }
  PLUGIN: { fetch: (request: Request) => Promise<Response> }
  FILES: { fetch: (request: Request) => Promise<Response> }
}

export default {
  fetch(request: Request, env: LocalWorkerBindings): Promise<Response> | Response {
    const target = request.headers.get(LOCAL_WORKER_HEADER) ?? 'api'
    const originalUrl = request.headers.get(LOCAL_URL_HEADER) ?? request.url
    const forwarded = new Request(originalUrl, request)
    forwarded.headers.delete(LOCAL_WORKER_HEADER)
    forwarded.headers.delete(LOCAL_URL_HEADER)
    switch (target) {
      case 'api': return env.API.fetch(forwarded)
      case 'plugin': return env.PLUGIN.fetch(forwarded)
      case 'files': return env.FILES.fetch(forwarded)
      default: return Response.json({ error: 'unknown_local_worker' }, { status: 400 })
    }
  },
}

import { isEgressHostAllowed } from './egress.ts'

export async function handleTerminalEgress(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (!isEgressHostAllowed(url.hostname))
    return new Response('egress_denied', { status: 403 })
  return fetch(request, { redirect: 'manual' })
}
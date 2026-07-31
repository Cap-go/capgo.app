import { env } from 'node:process'

const cloudflareWorkerPortOffset = Number(env.CLOUDFLARE_WORKER_PORT_OFFSET ?? '0')
if (!Number.isSafeInteger(cloudflareWorkerPortOffset) || cloudflareWorkerPortOffset < 0 || cloudflareWorkerPortOffset > 50000)
  throw new Error('CLOUDFLARE_WORKER_PORT_OFFSET must be a non-negative integer no greater than 50000.')

export function cloudflareWorkerUrl(name: 'CLOUDFLARE_API_URL' | 'CLOUDFLARE_PLUGIN_URL' | 'CLOUDFLARE_FILES_URL', basePort: number): string {
  return env[name] || `http://127.0.0.1:${basePort + cloudflareWorkerPortOffset}`
}
